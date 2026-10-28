# -*- coding: utf-8 -*-
"""Castalia 记忆体 · 设置窗口(2026-09-16)

由托盘菜单「设置…」以**独立进程**启动(stdlib tkinter,零第三方依赖)。
独立进程的好处:tkinter 在自己主线程里跑,不与托盘的 pystray 事件循环打架,
窗口崩了也拖不垮托盘。

编辑内容写回 scripts/castalia.config.json(只动它管的字段,其余段原样保留),
保存后可选择「保存并重启托盘」让改动立即生效。

「角色模型」页是例外:它编辑**每个库自己的** <banks>/<bank>/config.json
(角色模型/嵌入端点/维度),保存即原子写回(留 .bak-时间戳 备份),不碰上面那份配置。

用法
  python castalia_settings.py            # 打开窗口
  python castalia_settings.py --check    # 只校验配置并打印(无 GUI,便于脚本/CI 用)
"""
import argparse
import json
import os
import subprocess
import sys

import castalia_config as ccfg

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(SCRIPTS, "castalia.config.json")
TRAY_SCRIPT = os.path.join(SCRIPTS, "castalia_tray.py")

VARIANTS = ["full", "anima"]
TRANSPORTS = ["local-dir", "mcp-http"]
BANK_EMBED_MODES = ["api", "ollama", "none"]
DEFAULT_DIM = 1024          # 引擎在 embedding.dim 缺失时使用的向量维度


# ══════════════════════════ 配置读写 ══════════════════════════
def load_config():
    with open(CONFIG, encoding="utf-8") as f:
        return json.load(f)


def save_config(data):
    tmp = CONFIG + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, CONFIG)          # 原子替换,写一半断电不会毁配置


# ══════════════════════════ 库级角色模型(每库 config.json)══════════════════════════
def _banks_dir():
    """<paths.banks>(取自当前 castalia.config.json;读不到就空串)。"""
    try:
        return ccfg.load(CONFIG).BANKS or ""
    except Exception:
        return ""


def referenced_banks(data, banks_dir=None):
    """配置实际引用到的库:instances[].bank ∪ bridges[].bank ∪ <banks>/*/config.json。

    引用顺序优先(先实例、再桥、后额外目录),同一库只出现一次。
    """
    banks, seen = [], set()

    def add(name):
        name = str(name or "").strip()
        if name and name not in seen:
            seen.add(name)
            banks.append(name)

    for key in ("instances", "bridges"):
        for it in data.get(key) or []:
            if isinstance(it, dict):
                add(it.get("bank"))
    base = _banks_dir() if banks_dir is None else banks_dir
    if base and os.path.isdir(base):
        for name in sorted(os.listdir(base)):
            if os.path.isfile(os.path.join(base, name, "config.json")):
                add(name)
    return banks


def bank_variant(data, bank):
    """库对应的变体(取 instances[].variant;库只挂在桥上时沿 instance 反查)。"""
    variants = []
    for it in data.get("instances") or []:
        if isinstance(it, dict) and str(it.get("bank") or "") == bank:
            v = str(it.get("variant") or "").strip()
            if v and v not in variants:
                variants.append(v)
    if not variants:
        inst_by_id = {str(i.get("id")): i for i in (data.get("instances") or []) if isinstance(i, dict)}
        for b in data.get("bridges") or []:
            if isinstance(b, dict) and str(b.get("bank") or "") == bank:
                v = str((inst_by_id.get(b.get("instance")) or {}).get("variant") or "").strip()
                if v and v not in variants:
                    variants.append(v)
    return "/".join(variants)


def _section(cfg, name):
    v = cfg.get(name)
    return v if isinstance(v, dict) else {}


def _embed_model_text(emb):
    """列表里「嵌入模型」显示哪一侧:按模式取 api_model / model,缺省两者之一。"""
    mode = str(emb.get("mode") or "").strip().lower()
    if mode == "api":
        return str(emb.get("api_model") or "")
    if mode == "ollama":
        return str(emb.get("model") or "")
    return str(emb.get("api_model") or emb.get("model") or "")


def _dim_text(emb):
    v = emb.get("dim")
    return f"默认 {DEFAULT_DIM}" if v in (None, "") else str(v)


def bank_model_row(bank, data=None, banks_dir=None):
    """一行展示数据 + 该库配置文件路径(缺文件时 exists=False,值全空)。"""
    base = _banks_dir() if banks_dir is None else banks_dir
    path = ccfg.bank_config_path(bank, base)
    cfg = ccfg.load_bank_config(path)
    emb, refl, tri = _section(cfg, "embedding"), _section(cfg, "reflect"), _section(cfg, "triage")
    return {
        "bank": bank,
        "variant": bank_variant(data or {}, bank),
        "embed_mode": str(emb.get("mode") or ""),
        "embed_model": _embed_model_text(emb),
        "dim": _dim_text(emb),
        "reflect_model": str(refl.get("model") or ""),
        "triage_model": str(tri.get("model") or ""),
        "path": path,
        "exists": os.path.isfile(path),
    }


def _set_or_drop(section, key, value):
    """空串 = 删键(回落到引擎/环境默认),否则写去空白后的值。"""
    value = str(value or "").strip()
    if value:
        section[key] = value
    else:
        section.pop(key, None)


def _put_section(cfg, name, section):
    """有内容、或原本就存在该段 → 写回;否则不凭空造段(缺省 = 引擎默认)。"""
    if section or name in cfg:
        cfg[name] = section
    else:
        cfg.pop(name, None)


def positive_int(value):
    """校验"正整数或留空" → (是否合法, int 或 None)。"""
    if value is None or value == "":
        return True, None
    if isinstance(value, bool):
        return False, None
    if isinstance(value, int):
        return (value > 0), (value if value > 0 else None)
    s = str(value).strip()
    if not s:
        return True, None
    if s.isdigit() and int(s) > 0:
        return True, int(s)
    return False, None


def merge_bank_edits(bank, cfg, values):
    """把弹窗里的值并入库配置 → (新配置, 问题清单);有问题时调用方不要落盘。

    深拷贝后再改,cfg 里其它键(api_key / preservation / projectPolicies / 未知扩展键)
    原样保留。字符串留空 = 删掉该键(回落到引擎/环境默认);dim、maxFacts 留空 = 删键。
    这是「角色模型」页唯一的字段合并逻辑,GUI 与测试共用。
    """
    dim_ok, dim = positive_int(values.get("dim"))
    mf_ok, maxfacts = positive_int(values.get("reflect_maxfacts"))
    problems = []
    if not dim_ok:
        problems.append(f"库 {bank}: 维度必须是正整数,或留空用引擎默认 {DEFAULT_DIM}")
    if not mf_ok:
        problems.append(f"库 {bank}: 反思 maxFacts 必须是正整数(留空 = 用默认)")
    if problems:
        return cfg, problems
    new = json.loads(json.dumps(cfg if isinstance(cfg, dict) else {}))
    e = _section(new, "embedding")
    e["mode"] = str(values.get("mode") or "").strip() or "api"
    for key in ("ollama_url", "model", "api_url", "api_model"):
        _set_or_drop(e, key, values.get(key))
    if dim is None:
        e.pop("dim", None)                     # 留空 = 删键 → 引擎默认维度
    else:
        e["dim"] = dim
    _put_section(new, "embedding", e)
    r = _section(new, "reflect")
    _set_or_drop(r, "model", values.get("reflect_model"))
    _set_or_drop(r, "llm_url", values.get("reflect_url"))
    if maxfacts is None:
        r.pop("maxFacts", None)
    else:
        r["maxFacts"] = maxfacts
    _put_section(new, "reflect", r)
    t = _section(new, "triage")
    _set_or_drop(t, "model", values.get("triage_model"))
    _set_or_drop(t, "llm_url", values.get("triage_url"))
    _put_section(new, "triage", t)
    return new, validate_bank(bank, new)


def validate_bank(bank, cfg):
    """单个库配置的字段校验(只查我们管的:dim / embedding.mode / reflect.maxFacts)。"""
    problems = []
    emb = cfg.get("embedding")
    if emb is not None and not isinstance(emb, dict):
        problems.append(f"库 {bank}: embedding 必须是对象")
    emb = emb if isinstance(emb, dict) else {}
    mode = emb.get("mode")
    if mode not in (None, "") and str(mode).strip().lower() not in BANK_EMBED_MODES:
        problems.append(f"库 {bank}: embedding.mode 必须是 {'/'.join(BANK_EMBED_MODES)}"
                        f"(当前 {mode!r})")
    ok, _ = positive_int(emb.get("dim"))
    if not ok:
        problems.append(f"库 {bank}: embedding.dim 必须是正整数,或留空用引擎默认 {DEFAULT_DIM}"
                        f"(当前 {emb.get('dim')!r})")
    refl = cfg.get("reflect")
    if refl is not None and not isinstance(refl, dict):
        problems.append(f"库 {bank}: reflect 必须是对象")
    refl = refl if isinstance(refl, dict) else {}
    if "maxFacts" in refl:
        ok, _ = positive_int(refl.get("maxFacts"))
        if not ok:
            problems.append(f"库 {bank}: reflect.maxFacts 必须是正整数(当前 {refl.get('maxFacts')!r})")
    if cfg.get("triage") is not None and not isinstance(cfg.get("triage"), dict):
        problems.append(f"库 {bank}: triage 必须是对象")
    return problems


def validate(data):
    """返回问题清单(空 = 通过)"""
    problems = []
    fs = data.get("federationService")
    if fs:
        if not str(fs.get("port", "")).isdigit():
            problems.append("联邦接口端口必须是数字")
        seen = set()
        for m in fs.get("members") or []:
            mid = str(m.get("id") or "").strip()
            if not mid:
                problems.append("联邦成员缺少 id")
            elif mid in seen:
                problems.append(f"联邦成员 id 重复: {mid}")
            seen.add(mid)
            if not str(m.get("target") or "").strip():
                problems.append(f"联邦成员 {mid} 缺少目标(target/目录或端点)")
            if m.get("transport") not in TRANSPORTS:
                problems.append(f"联邦成员 {mid} 的传输方式应为 {'/'.join(TRANSPORTS)}")
    ports = {}
    for key, items in (("联邦接口", [fs] if fs else []),
                       ("控制台", [data["shell"]] if data.get("shell") else []),
                       ("记忆桥", data.get("bridges") or []),
                       ("星图", data.get("viz") or []),
                       ("附带服务", data.get("extraServices") or [])):
        for it in items:
            if not it:
                continue
            p = it.get("port")
            if p in ports:
                problems.append(f"端口冲突: {p}({ports[p]} 与 {key})")
            ports[p] = key
    # 库级模型配置(每库 config.json):缺失文件 = 引擎默认,不算错
    base = _banks_dir()
    for bank in referenced_banks(data, base):
        problems += validate_bank(bank, ccfg.load_bank_config(ccfg.bank_config_path(bank, base)))
    return problems


# ══════════════════════════ GUI ══════════════════════════
def run_gui():
    import tkinter as tk
    from tkinter import ttk, messagebox

    root = tk.Tk()
    root.title("Castalia 记忆体 · 设置")
    root.geometry("980x620")
    root.minsize(820, 520)

    data = load_config()
    state = {"dirty": False}

    hdr = ttk.Frame(root, padding=(12, 10, 12, 4))
    hdr.pack(fill="x")
    ttk.Label(hdr, text="配置文件:", font=("", 9, "bold")).pack(side="left")
    ttk.Label(hdr, text=CONFIG, foreground="#666").pack(side="left", padx=(6, 0))

    nb = ttk.Notebook(root)
    nb.pack(fill="both", expand=True, padx=12, pady=(4, 8))

    def mark_dirty(*_):
        state["dirty"] = True
        status_var.set("● 有未保存的改动")

    def rename_dialog(current, on_ok, title="改名"):
        """通用改名对话框 —— 接入口名字/实例名字都走它"""
        dlg = tk.Toplevel(root)
        dlg.title(title); dlg.transient(root); dlg.grab_set()
        f = ttk.Frame(dlg, padding=12); f.pack(fill="both", expand=True)
        v = tk.StringVar(value=current or "")
        ttk.Label(f, text="名字").grid(row=0, column=0, sticky="w")
        ent = ttk.Entry(f, textvariable=v, width=36)
        ent.grid(row=0, column=1, padx=6)
        ent.focus_set(); ent.select_range(0, "end")

        def apply():
            nm = v.get().strip()
            if nm:
                on_ok(nm)
                mark_dirty()
            dlg.destroy()

        ent.bind("<Return>", lambda _e: apply())
        bar = ttk.Frame(f); bar.grid(row=1, column=0, columnspan=2, pady=(10, 0))
        ttk.Button(bar, text="确定", command=apply).pack(side="left")
        ttk.Button(bar, text="取消", command=dlg.destroy).pack(side="left", padx=6)

    # ── Tab 1:联邦接口 ──
    t1 = ttk.Frame(nb, padding=10)
    nb.add(t1, text="联邦接口")

    fs = data.setdefault("federationService", {
        "id": "federation-bridge", "name": "联邦接口", "port": 3314,
        "dir": "runFed", "members": [],
    })
    v_enable = tk.BooleanVar(value=bool(data.get("federationService")))
    v_name = tk.StringVar(value=fs.get("name", "联邦接口"))
    v_port = tk.StringVar(value=str(fs.get("port", 3314)))
    v_dir = tk.StringVar(value=fs.get("dir", "runFed"))

    row = ttk.Frame(t1); row.pack(fill="x", pady=(0, 6))
    ttk.Checkbutton(row, text="启用联邦接口服务(把跨记忆体检索暴露成独立 MCP 端点)",
                    variable=v_enable, command=mark_dirty).pack(side="left")
    row2 = ttk.Frame(t1); row2.pack(fill="x", pady=(0, 8))
    ttk.Label(row2, text="名称").pack(side="left")
    ttk.Entry(row2, textvariable=v_name, width=18).pack(side="left", padx=(4, 14))
    ttk.Label(row2, text="端口").pack(side="left")
    ttk.Entry(row2, textvariable=v_port, width=8).pack(side="left", padx=(4, 14))
    ttk.Label(row2, text="引擎目录").pack(side="left")
    ttk.Entry(row2, textvariable=v_dir, width=32).pack(side="left", padx=(4, 0))
    for var in (v_name, v_port, v_dir):
        var.trace_add("write", mark_dirty)

    ttk.Label(t1, text="成员(可收纳的记忆体:同机目录或任意 MCP 端点)",
              font=("", 9, "bold")).pack(anchor="w", pady=(6, 2))
    cols = ("id", "label", "variant", "transport", "caps", "target")
    tree = ttk.Treeview(t1, columns=cols, show="headings", height=10)
    for c, text, w in (("id", "id", 110), ("label", "名称", 140), ("variant", "变体", 70),
                       ("transport", "传输", 90), ("caps", "能力", 110), ("target", "目标", 330)):
        tree.heading(c, text=text)
        tree.column(c, width=w, anchor="w")
    tree.pack(fill="both", expand=True)

    def refresh_tree():
        tree.delete(*tree.get_children())
        for i, m in enumerate(fs.get("members") or []):
            tree.insert("", "end", iid=str(i), values=(
                m.get("id", ""), m.get("label", ""), m.get("variant", ""),
                m.get("transport", "local-dir"),
                ",".join(m.get("capabilities") or []), m.get("target", "")))

    def member_dialog(initial=None, index=None):
        dlg = tk.Toplevel(root)
        dlg.title("编辑成员" if initial else "添加成员")
        dlg.transient(root); dlg.grab_set()
        f = ttk.Frame(dlg, padding=12); f.pack(fill="both", expand=True)
        init = initial or {"id": "", "label": "", "variant": "full",
                           "transport": "local-dir", "capabilities": [], "target": ""}
        vars_ = {
            "id": tk.StringVar(value=init.get("id", "")),
            "label": tk.StringVar(value=init.get("label", "")),
            "variant": tk.StringVar(value=init.get("variant") or "full"),
            "transport": tk.StringVar(value=init.get("transport") or "local-dir"),
            "caps": tk.StringVar(value=",".join(init.get("capabilities") or [])),
            "target": tk.StringVar(value=init.get("target", "")),
        }
        rows = [("id", "标识", None), ("label", "名称", None), ("variant", "变体", VARIANTS),
                ("transport", "传输", TRANSPORTS), ("caps", "能力(逗号分隔)", None),
                ("target", "目标(目录 或 http://…/mcp)", None)]
        for i, (key, label, choices) in enumerate(rows):
            ttk.Label(f, text=label).grid(row=i, column=0, sticky="w", pady=4)
            if choices:
                ttk.Combobox(f, textvariable=vars_[key], values=choices, width=34,
                             state="readonly").grid(row=i, column=1, sticky="w", padx=6)
            else:
                ttk.Entry(f, textvariable=vars_[key], width=44).grid(row=i, column=1, sticky="w", padx=6)

        def apply():
            m = {
                "id": vars_["id"].get().strip(),
                "label": vars_["label"].get().strip() or vars_["id"].get().strip(),
                "variant": vars_["variant"].get(),
                "transport": vars_["transport"].get(),
                "capabilities": [c.strip() for c in vars_["caps"].get().split(",") if c.strip()],
                "target": vars_["target"].get().strip(),
            }
            if not m["id"] or not m["target"]:
                messagebox.showwarning("缺字段", "标识与目标都必须填写", parent=dlg)
                return
            members = fs.setdefault("members", [])
            if index is None:
                members.append(m)
            else:
                members[index] = m
            refresh_tree(); mark_dirty(); dlg.destroy()

        bar = ttk.Frame(f); bar.grid(row=len(rows), column=0, columnspan=2, pady=(12, 0))
        ttk.Button(bar, text="确定", command=apply).pack(side="left")
        ttk.Button(bar, text="取消", command=dlg.destroy).pack(side="left", padx=6)

    def add_member():
        member_dialog()

    def edit_member():
        sel = tree.selection()
        if not sel:
            return
        i = int(sel[0])
        member_dialog(fs["members"][i], i)

    def del_member():
        sel = tree.selection()
        if not sel:
            return
        i = int(sel[0])
        if messagebox.askyesno("删除", f"删除成员 {fs['members'][i].get('id')}?"):
            fs["members"].pop(i)
            refresh_tree(); mark_dirty()

    btns = ttk.Frame(t1); btns.pack(fill="x", pady=(6, 0))
    ttk.Button(btns, text="添加", command=add_member).pack(side="left")
    ttk.Button(btns, text="编辑", command=edit_member).pack(side="left", padx=6)
    ttk.Button(btns, text="删除", command=del_member).pack(side="left")
    ttk.Button(btns, text="测试连通", command=lambda: test_members(tree, fs)).pack(side="left", padx=18)
    refresh_tree()

    # ── Tab 2:实例(名字可双击改;变体决定跑哪个引擎)──
    t2 = ttk.Frame(nb, padding=10)
    nb.add(t2, text="实例")
    ttk.Label(t2, text="接入端与它们的变体(决定跑哪个引擎)—— 双击行可改名字",
              font=("", 9, "bold")).pack(anchor="w")
    tcols = ("id", "label", "variant", "icon", "bank")
    ttree = ttk.Treeview(t2, columns=tcols, show="headings", height=8)
    for c, text, w in (("id", "id", 120), ("label", "名称", 190), ("variant", "变体", 90),
                       ("icon", "图标", 230), ("bank", "库", 140)):
        ttree.heading(c, text=text); ttree.column(c, width=w, anchor="w")
    ttree.pack(fill="x", pady=(4, 8))
    inst_list = data.get("instances") or []
    for i, it in enumerate(inst_list):
        ttree.insert("", "end", iid=f"i{i}", values=(it.get("id"), it.get("label"), it.get("variant"),
                                                     it.get("icon"), it.get("bank")))

    def inst_rename(_event=None):
        sel = ttree.selection()
        if not sel:
            return
        i = int(sel[0][1:])
        node = inst_list[i]

        def apply(nm):
            node["label"] = nm
            ttree.set(sel[0], "label", nm)
        rename_dialog(node.get("label", ""), apply, title=f"实例 {node.get('id')} 的名字")

    ttree.bind("<Double-1>", inst_rename)
    ttk.Label(t2, text="变体:lite(中立核)/ anima(情感层)/ max(联合版)。\n"
                       "改变体请编辑 JSON 里的 instances[].variant 与 icon(托盘按它选图标与品牌)。",
              foreground="#666", justify="left").pack(anchor="w")

    # ── Tab 3:服务端口总览(双击行可改接入口的名字)──
    t3 = ttk.Frame(nb, padding=10)
    nb.add(t3, text="服务")
    ttk.Label(t3, text="所有接入口 —— 双击行可改名字(名字会显示在托盘菜单与状态里)",
              font=("", 9, "bold")).pack(anchor="w", pady=(0, 4))
    scols = ("kind", "id", "name", "port")
    stree = ttk.Treeview(t3, columns=scols, show="headings", height=14)
    for c, text, w in (("kind", "类型", 120), ("id", "id", 190), ("name", "名称", 200), ("port", "端口", 90)):
        stree.heading(c, text=text); stree.column(c, width=w, anchor="w")
    stree.pack(fill="both", expand=True)
    for kind, key in (("联邦接口", "federationService"), ("控制台", "shell"), ("记忆桥", "bridges"),
                      ("星图", "viz"),
                      ("嵌入", "embed"), ("AIRI 代理", "airiProxy"), ("附带服务", "extraServices")):
        v = data.get(key)
        items = [v] if isinstance(v, dict) else (v or [])
        for i, it in enumerate(items):
            if not isinstance(it, dict):
                continue
            stree.insert("", "end", iid=f"{key}:{i}",
                         values=(kind, it.get("id"), it.get("name"), it.get("port")))

    def svc_rename(_event=None):
        sel = stree.selection()
        if not sel:
            return
        key, idx = sel[0].split(":")
        container = data.get(key)
        node = container[int(idx)] if isinstance(container, list) else container
        if not isinstance(node, dict):
            return

        def apply(nm):
            node["name"] = nm
            stree.set(sel[0], "name", nm)
            if key == "federationService":
                v_name.set(nm)          # 与 Tab 1 的输入框保持一致
        rename_dialog(node.get("name", ""), apply, title=f"{node.get('id')} 的名字")

    stree.bind("<Double-1>", svc_rename)

    # ── Tab 4:角色模型(每个库一份 config.json;双击行编辑,保存即写回)──
    t4 = ttk.Frame(nb, padding=10)
    nb.add(t4, text="角色模型")
    ttk.Label(t4, text="每个记忆库的角色模型(嵌入 / 反思 / 分拣)—— 双击行可编辑,"
                       "改动只写该库的 config.json", font=("", 9, "bold")).pack(anchor="w")
    banks_dir = _banks_dir()
    bpath_var = tk.StringVar(value="")
    ttk.Label(t4, textvariable=bpath_var, foreground="#666").pack(anchor="w", pady=(2, 4))

    bcols = ("bank", "variant", "embed_mode", "embed_model", "dim", "reflect", "triage")
    btree = ttk.Treeview(t4, columns=bcols, show="headings", height=10)
    for c, text, w in (("bank", "库", 90), ("variant", "变体", 70),
                       ("embed_mode", "嵌入模式", 80), ("embed_model", "嵌入模型", 200),
                       ("dim", "维度", 90), ("reflect", "反思模型", 165),
                       ("triage", "分拣模型", 165)):
        btree.heading(c, text=text); btree.column(c, width=w, anchor="w")
    btree.pack(fill="both", expand=True)

    def update_bpath(_event=None):
        sel = btree.selection()
        if not sel:
            bpath_var.set(f"库目录: {banks_dir or '(未配置 paths.banks)'}")
            return
        path = ccfg.bank_config_path(sel[0], banks_dir)
        missing = "" if os.path.isfile(path) else "  (文件不存在 —— 保存时创建)"
        bpath_var.set(f"文件: {path}{missing}")

    def refresh_bank_tree():
        btree.delete(*btree.get_children())
        for bank in referenced_banks(data, banks_dir):
            r = bank_model_row(bank, data, banks_dir)
            btree.insert("", "end", iid=bank,
                         values=(r["bank"], r["variant"], r["embed_mode"], r["embed_model"],
                                 r["dim"], r["reflect_model"], r["triage_model"]))
        update_bpath()

    def bank_dialog(bank):
        """单库编辑弹窗。只改 embedding/reflect.model+llm_url+maxFacts/triage.model+llm_url,
        其余键(api_key、projectPolicies、preservation、未知扩展键…)原样保留。"""
        path = ccfg.bank_config_path(bank, banks_dir)
        cfg = {}
        if os.path.isfile(path):
            try:
                with open(path, encoding="utf-8") as f:
                    cfg = json.load(f)
                if not isinstance(cfg, dict):
                    raise ValueError("顶层不是 JSON 对象")
            except Exception as ex:
                # 坏文件不覆盖:否则用户手滑一个逗号就会丢掉整份角色配置
                messagebox.showerror("库配置读不出来",
                                     f"{path}\n{ex!r}\n已中止编辑,以免覆盖损坏的文件。",
                                     parent=root)
                return
        emb, refl, tri = _section(cfg, "embedding"), _section(cfg, "reflect"), _section(cfg, "triage")
        dlg = tk.Toplevel(root)
        dlg.title(f"角色模型 · {bank} — {path}")
        dlg.transient(root); dlg.grab_set()
        wrap = ttk.Frame(dlg, padding=12); wrap.pack(fill="both", expand=True)
        ttk.Label(wrap, text=f"库 {bank} 的角色模型", font=("", 10, "bold")).grid(
            row=0, column=0, columnspan=2, sticky="w")
        ttk.Label(wrap, text=f"目标文件: {path}", foreground="#666").grid(
            row=1, column=0, columnspan=2, sticky="w", pady=(0, 8))

        v = {
            "mode": tk.StringVar(value=str(emb.get("mode") or "api")),
            "ollama_url": tk.StringVar(value=str(emb.get("ollama_url") or "")),
            "model": tk.StringVar(value=str(emb.get("model") or "")),
            "api_url": tk.StringVar(value=str(emb.get("api_url") or "")),
            "api_model": tk.StringVar(value=str(emb.get("api_model") or "")),
            "dim": tk.StringVar(value="" if emb.get("dim") in (None, "") else str(emb.get("dim"))),
            "reflect_model": tk.StringVar(value=str(refl.get("model") or "")),
            "reflect_url": tk.StringVar(value=str(refl.get("llm_url") or "")),
            "reflect_maxfacts": tk.StringVar(
                value="" if refl.get("maxFacts") in (None, "") else str(refl.get("maxFacts"))),
            "triage_model": tk.StringVar(value=str(tri.get("model") or "")),
            "triage_url": tk.StringVar(value=str(tri.get("llm_url") or "")),
        }
        rows = [
            ("mode", "嵌入模式", BANK_EMBED_MODES),
            ("ollama_url", "ollama_url(本地/自建嵌入端点)", None),
            ("model", "嵌入模型(ollama 侧 model)", None),
            ("api_url", "api_url(嵌入 API 基址)", None),
            ("api_model", "嵌入模型(api 侧 api_model)", None),
            ("dim", f"维度(留空 = 引擎默认 {DEFAULT_DIM})", None),
            ("reflect_model", "反思模型", None),
            ("reflect_url", "反思 llm_url", None),
            ("reflect_maxfacts", "反思 maxFacts", None),
            ("triage_model", "分拣模型", None),
            ("triage_url", "分拣 llm_url", None),
        ]
        first = None
        for i, (key, label, choices) in enumerate(rows, start=2):
            ttk.Label(wrap, text=label).grid(row=i, column=0, sticky="w", pady=3)
            if choices:
                wdg = ttk.Combobox(wrap, textvariable=v[key], values=choices, width=42,
                                   state="readonly")
            else:
                wdg = ttk.Entry(wrap, textvariable=v[key], width=46)
            wdg.grid(row=i, column=1, sticky="w", padx=6)
            if first is None:
                first = wdg

        def apply(_event=None):
            vals = {k: var.get() for k, var in v.items()}
            new, probs = merge_bank_edits(bank, cfg, vals)
            if probs:
                messagebox.showerror("配置有问题", "\n".join(probs), parent=dlg)
                return
            try:
                ccfg.save_bank_config(path, new)       # 原子写 + .bak-时间戳
            except Exception as ex:
                messagebox.showerror("保存失败", repr(ex), parent=dlg)
                return
            refresh_bank_tree()
            btree.selection_set(bank)
            update_bpath()
            # 库配置已落盘 → 不置 dirty;但要把状态栏接上(有别的未保存改动时保留提示)
            if state["dirty"]:
                status_var.set(f"● 有未保存的改动 · 已保存库 {bank} 的模型配置")
            else:
                status_var.set(f"已保存库 {bank} 的模型配置 → {path}")
            dlg.destroy()

        bar2 = ttk.Frame(wrap)
        bar2.grid(row=len(rows) + 2, column=0, columnspan=2, pady=(12, 0), sticky="e")
        ttk.Button(bar2, text="保存", command=apply).pack(side="left")
        ttk.Button(bar2, text="取消", command=dlg.destroy).pack(side="left", padx=6)
        dlg.bind("<Return>", apply)
        dlg.bind("<Escape>", lambda _e: dlg.destroy())
        if first:
            first.focus_set()

    def edit_bank():
        sel = btree.selection()
        if not sel:
            messagebox.showinfo("选择一行", "先在表里选中一个库。", parent=root)
            return
        bank_dialog(sel[0])

    bbtns = ttk.Frame(t4); bbtns.pack(fill="x", pady=(6, 0))
    ttk.Button(bbtns, text="编辑", command=edit_bank).pack(side="left")
    ttk.Button(bbtns, text="刷新", command=refresh_bank_tree).pack(side="left", padx=6)
    ttk.Label(bbtns, text="改动即时写入该库的 config.json(自动留 .bak-时间戳 备份);"
                          "库目录取自 castalia.config.json 的 paths.banks",
              foreground="#666").pack(side="left", padx=12)
    btree.bind("<Double-1>", lambda _e: edit_bank())
    btree.bind("<<TreeviewSelect>>", update_bpath)
    refresh_bank_tree()

    # ── 底部 ──
    status_var = tk.StringVar(value="就绪")
    bar = ttk.Frame(root, padding=(12, 0, 12, 12)); bar.pack(fill="x")
    ttk.Label(bar, textvariable=status_var, foreground="#666").pack(side="left")

    def do_save(restart=False):
        if not v_enable.get():
            data.pop("federationService", None)
        else:
            fs["name"] = v_name.get().strip() or "联邦接口"
            try:
                fs["port"] = int(v_port.get())
            except ValueError:
                messagebox.showerror("端口错误", "端口必须是数字"); return
            fs["dir"] = v_dir.get().strip() or "runFed"
            data["federationService"] = fs
        probs = validate(data)
        if probs:
            messagebox.showerror("配置有问题", "\n".join(probs)); return
        try:
            save_config(data)
        except Exception as e:
            messagebox.showerror("保存失败", repr(e)); return
        state["dirty"] = False
        status_var.set(f"已保存 {os.path.basename(CONFIG)}")
        if restart:
            restart_tray()

    def restart_tray():
        try:
            import psutil
        except ImportError:
            messagebox.showinfo("提示", "保存成功。请手动重启托盘使改动生效。"); return
        exe = None
        for cand in (os.path.join(os.path.dirname(SCRIPTS), "Castalia", "Castalia.exe"),
                     sys.executable):
            if cand and os.path.exists(cand):
                exe = cand; break
        try:
            for p in psutil.process_iter(["pid", "cmdline"]):
                if "castalia_tray.py" in " ".join(p.info.get("cmdline") or []):
                    p.kill()
            subprocess.Popen([exe, TRAY_SCRIPT], cwd=SCRIPTS,
                             creationflags=getattr(subprocess, "DETACHED_PROCESS", 0) |
                             getattr(subprocess, "CREATE_NO_WINDOW", 0),
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            status_var.set("已保存并重启托盘")
        except Exception as e:
            messagebox.showwarning("重启托盘失败", f"配置已保存,但重启托盘失败:{e!r}\n请手动重启。")

    def do_reload():
        if state["dirty"] and not messagebox.askyesno("放弃改动", "有未保存的改动,确定重新载入?"):
            return
        root.destroy()
        os.execv(sys.executable, [sys.executable] + sys.argv)

    ttk.Button(bar, text="保存", command=lambda: do_save(False)).pack(side="right")
    ttk.Button(bar, text="保存并重启托盘", command=lambda: do_save(True)).pack(side="right", padx=6)
    ttk.Button(bar, text="重新载入", command=do_reload).pack(side="right", padx=6)
    ttk.Button(bar, text="关闭", command=root.destroy).pack(side="right", padx=6)

    root.mainloop()


def test_members(tree, fs):
    """对每个成员做一次 describe/探活(独立进程里用引擎侧的 provider 逻辑太重,
    这里用最直接的判定:local-dir 看目录,later mcp-http 看 TCP 端口)"""
    from tkinter import messagebox
    import socket
    from urllib.parse import urlparse
    lines = []
    for m in fs.get("members") or []:
        tgt = str(m.get("target") or "")
        if (m.get("transport") or "local-dir") == "local-dir":
            ok = os.path.isdir(tgt)
            lines.append(f"{'✓' if ok else '✗'} {m.get('id')}: {'目录存在' if ok else '目录不存在 → ' + tgt}")
        else:
            try:
                u = urlparse(tgt)
                host, port = u.hostname or "127.0.0.1", u.port or (443 if u.scheme == "https" else 80)
                s = socket.create_connection((host, port), timeout=2.0)
                s.close()
                lines.append(f"✓ {m.get('id')}: {host}:{port} 可连接")
            except Exception as e:
                lines.append(f"✗ {m.get('id')}: 连接失败 {e}")
    messagebox.showinfo("成员连通性", "\n".join(lines) if lines else "还没有成员")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只校验配置(无 GUI)")
    args = ap.parse_args()
    if args.check:
        data = load_config()
        probs = validate(data)
        print(f"配置: {CONFIG}")
        print(f"联邦接口: {'启用' if data.get('federationService') else '未启用'}"
              + (f" :{data['federationService'].get('port')}" if data.get('federationService') else ""))
        if data.get("federationService"):
            for m in data["federationService"].get("members") or []:
                print(f"  成员 {m.get('id'):12s} {m.get('transport'):10s} {m.get('target')}")
        banks_dir = _banks_dir()
        print(f"库目录: {banks_dir}")
        print("库模型:")
        banks = referenced_banks(data, banks_dir)
        if not banks:
            print("  (配置里没有引用任何库,也没有 <库目录>/*/config.json)")
        for bank in banks:
            r = bank_model_row(bank, data, banks_dir)
            if not r["exists"]:
                print(f"  {bank}: (无配置文件 — 引擎默认)  {r['path']}")
                continue
            print(f"  {bank}: 变体={r['variant'] or '-'}"
                  f"  嵌入={r['embed_mode'] or '-'}"
                  f"  嵌入模型={r['embed_model'] or '-'}"
                  f"  维度={r['dim']}"
                  f"  反思={r['reflect_model'] or '-'}"
                  f"  分拣={r['triage_model'] or '-'}")
            print(f"      文件 {r['path']}")
        print("校验:", "通过" if not probs else "问题 → " + "; ".join(probs))
        return 0 if not probs else 1
    run_gui()
    return 0


if __name__ == "__main__":
    sys.exit(main())
