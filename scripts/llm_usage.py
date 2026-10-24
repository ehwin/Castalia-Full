"""汇总桥梁日志里的 [llm] 用量行，按天/模型/通道出账单。

用法:
    py scripts/llm_usage.py                # 默认读 D:/AI/castalia/run/Castalia/scripts/bridge-*.log
    py scripts/llm_usage.py --days 7       # 只看最近 7 天
    py scripts/llm_usage.py --log-dir <dir>

日志行格式(2026-10-23 起):
    [llm] ts=2026-10-23T11:41:02.114Z channel=reflect model=deepseek-v4-flash prompt=26657 completion=11814 reasoning=9372 cached=26496 finish=stop ms=53230
"""
import argparse
import collections
import glob
import os
import re
import sys

DEFAULT_LOG_DIR = r"D:\AI\castalia\run\Castalia\scripts"
LINE = re.compile(
    r"\[llm\] (?:ts=(?P<ts>\S+) )?channel=(?P<channel>\S+) model=(?P<model>\S+) "
    r"prompt=(?P<prompt>\d+|\?) completion=(?P<completion>\d+|\?) reasoning=(?P<reasoning>\d+) "
    r"cached=(?P<cached>\d+) finish=(?P<finish>\S+) ms=(?P<ms>\d+)"
)


def num(value):
    return int(value) if value.isdigit() else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log-dir", default=DEFAULT_LOG_DIR)
    ap.add_argument("--days", type=int, default=0, help="只统计最近 N 天；0 = 全部")
    ap.add_argument("--by", choices=["day", "model", "channel"], default="day")
    args = ap.parse_args()

    rows = []
    for path in glob.glob(os.path.join(args.log_dir, "bridge-*.log")):
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                m = LINE.search(line)
                if m:
                    row = m.groupdict()
                    row["ts"] = row.get("ts") or "(no-ts)"
                    rows.append(row)
    if not rows:
        print("没有找到 [llm] 用量行。旧日志(2026-10-23 之前)没有记录 usage，无法回溯。")
        return 1

    rows.sort(key=lambda r: r["ts"])
    if args.days:
        dated = [r["ts"] for r in rows if r["ts"] != "(no-ts)"]
        if dated:
            from datetime import date, timedelta
            y, m, d = (int(x) for x in dated[-1][:10].split("-"))
            start = (date(y, m, d) - timedelta(days=args.days - 1)).isoformat()
            rows = [r for r in rows if r["ts"] == "(no-ts)" or r["ts"][:10] >= start]

    key = {"day": lambda r: r["ts"][:10] if r["ts"] != "(no-ts)" else "(no-ts)",
           "model": lambda r: r["model"],
           "channel": lambda r: r["channel"]}[args.by]
    agg = collections.defaultdict(lambda: {"calls": 0, "prompt": 0, "completion": 0, "reasoning": 0, "cached": 0, "truncated": 0})
    for r in rows:
        a = agg[key(r)]
        a["calls"] += 1
        a["prompt"] += num(r["prompt"])
        a["completion"] += num(r["completion"])
        a["reasoning"] += num(r["reasoning"])
        a["cached"] += num(r["cached"])
        if r["finish"] == "length":
            a["truncated"] += 1

    print(f"{'key':<20}{'calls':>6}{'prompt':>12}{'completion':>12}{'reasoning':>11}{'cached':>11}{'trunc':>7}")
    totals = collections.Counter()
    for k in sorted(agg):
        a = agg[k]
        print(f"{k:<20}{a['calls']:>6}{a['prompt']:>12,}{a['completion']:>12,}{a['reasoning']:>11,}{a['cached']:>11,}{a['truncated']:>7}")
        for f in ("calls", "prompt", "completion", "reasoning", "cached", "truncated"):
            totals[f] += a[f]
    print(f"{'TOTAL':<20}{totals['calls']:>6}{totals['prompt']:>12,}{totals['completion']:>12,}{totals['reasoning']:>11,}{totals['cached']:>11,}{totals['truncated']:>7}")
    print("\n提示: reasoning 已包含在 completion 里；计费通常按 prompt + completion 计价，")
    print("      推理模型的 reasoning token 按输出价计，所以 completion 才是花钱的大头。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
