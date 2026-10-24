/**
 * LocalDirProvider —— 同机目录型联邦成员(v1.14)
 *
 * 把原 federation.ts 的"扫目录 + 只读 sqlite 检索"原样包装成一个 provider。
 * 行为与原实现完全一致:逐库独立 try/catch、只读打开、单库损坏不影响整体。
 *
 * 兼容导出:resolveFedLibraries / fedTextSearch 保持原签名,老调用点无需改动。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FedHit, FedLibrary, FedMemberInfo, FedProvider } from './types.js';

/** 扫描一个目录,列出其中所有标准结构的记忆库 */
export function scanLibraries(dir: string, instance: string): FedLibrary[] {
  const libs: FedLibrary[] = [];
  // Receipts are engine bookkeeping. Shared is a valid user namespace;
  // reflect remains searchable, but is excluded by the reflection caller.
  const excluded = new Set(
    String(process.env.FEDERATION_EXCLUDE_PROJECTS || 'receipts')
      .split(',').map(v => v.trim().toLowerCase()).filter(Boolean),
  );
  try {
    for (const f of fs.readdirSync(dir)) {
      if (excluded.has(f.toLowerCase())) continue;
      // 旧结构 project-<name>.sqlite
      if (f.startsWith('project-') && f.endsWith('.sqlite')) {
        if (excluded.has(f.slice('project-'.length, -'.sqlite'.length).toLowerCase())) continue;
        libs.push({ instance, project: f.slice('project-'.length, -'.sqlite'.length), file: path.join(dir, f) });
        continue;
      }
      // memdir 新结构 <project>/<memType>/memory.sqlite(以及 <project>/ 下的其他 *.sqlite)
      const p = path.join(dir, f);
      try {
        if (fs.statSync(p).isDirectory()) {
          for (const sub of fs.readdirSync(p)) {
            const sp = path.join(p, sub);
            try {
              if (fs.statSync(sp).isDirectory()) {
                const mp = path.join(sp, 'memory.sqlite');
                if (fs.existsSync(mp)) libs.push({ instance, project: f, memType: sub, file: mp });
              } else if (sub.endsWith('.sqlite')) {
                libs.push({ instance, project: f, file: sp });
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    }
  } catch {
    /* 目录不可读：让调用方（describe 的 unreadable / search 的全失败）看到，而不是静默空 */
    console.error(`[federation] 目录不可读: ${dir} (member ${instance})`);
  }
  return libs;
}

/**
 * 文本模式联邦搜索:LIKE 子串匹配 + 命中比例评分。
 * 中文长句整句子串匹配;空格/标点分隔多词时 OR 匹配、命中比例计分。
 * 只读打开库文件,逐库独立 try/catch,单库损坏不影响整体。
 */
export function fedTextSearch(libs: FedLibrary[], query: string, topK: number): FedHit[] {
  const limit = Math.min(50, Math.max(1, Math.floor(Number(topK) || 5)));
  const trimmed = String(query || '').trim();
  const terms = trimmed.split(/[\s,，。！？、；：]+/).filter((t: string) => t.trim().length >= 2);
  // 单字/纯标点：整串当子串查，而不是退化成"各库最新 N 条"
  const effectiveTerms = terms.length ? terms : (trimmed ? [trimmed] : []);
  const escapeLike = (t: string) => t.replace(/[\\%_]/g, m => '\\' + m);
  const hits: FedHit[] = [];
  let failures = 0;
  for (const lib of libs) {
    let db: Database.Database | null = null;
    try {
      db = new Database(lib.file, { readonly: true, fileMustExist: true });
      let rows: any[] = [];
      if (effectiveTerms.length === 0) {
        rows = db.prepare("SELECT id, text, created_at FROM memory WHERE is_active = 1 AND COALESCE(status, '') <> 'superseded' ORDER BY created_at DESC LIMIT ?").all(limit);
      } else {
        const conds = effectiveTerms.map(() => "m.text LIKE ? ESCAPE '\\'").join(' OR ');
        rows = db.prepare(
          `SELECT m.id, m.text, m.created_at FROM memory m WHERE m.is_active = 1 AND COALESCE(m.status, '') <> 'superseded' AND (${conds}) ORDER BY m.created_at DESC LIMIT ?`
        ).all(...effectiveTerms.map(t => `%${escapeLike(t)}%`), limit);
      }
      for (const r of rows) {
        const hitCount = effectiveTerms.filter(t => String(r.text).includes(t)).length;
        hits.push({
          instance: lib.instance,
          project: lib.project,
          memType: lib.memType,
          id: r.id,
          text: String(r.text).length > 200 ? String(r.text).slice(0, 200) + '…' : String(r.text),
          score: effectiveTerms.length > 0 ? Math.round((hitCount / effectiveTerms.length) * 1000) / 1000 : 0.1,
          createdAt: r.created_at ?? null,
        });
      }
    } catch (e: any) {
      failures++;
      console.error(`[federation] 读取失败 ${lib.instance}/${lib.project}${lib.memType ? '/' + lib.memType : ''}: ${e.message}`);
    } finally {
      if (db) db.close();
    }
  }
  // 全部库都打不开 = 成员掉线，明确报错而不是返回“没有命中”
  if (libs.length > 0 && failures === libs.length) {
    throw new Error(`member ${libs[0]?.instance || '?'}: 所有库均不可读（${failures}/${libs.length}）`);
  }
  hits.sort((a, b) => (b.score - a.score) || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  return hits.slice(0, Math.max(10, limit * Math.max(1, libs.length)));
}

/** 统计一个库里的活跃记忆数(用于 describe;失败返回 null) */
function countMemories(file: string): number | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const row: any = db.prepare('SELECT COUNT(*) AS n FROM memory WHERE is_active = 1').get();
    return Number(row?.n ?? 0);
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

export interface LocalDirOptions {
  /** 成员标识(出现在结果的 instance 字段) */
  id: string;
  /** 目录 */
  dir: string;
  label?: string;
  variant?: string;
  capabilities?: string[];
}

/** 同机目录型成员。id 为 'local' 时代表本实例自己的库。 */
export class LocalDirProvider implements FedProvider {
  readonly transport = 'local-dir';
  readonly id: string;
  readonly label?: string;
  readonly variant?: string;
  readonly capabilities: string[];
  readonly dir: string;

  constructor(opts: LocalDirOptions) {
    this.id = opts.id;
    this.dir = opts.dir;
    this.label = opts.label;
    this.variant = opts.variant;
    this.capabilities = opts.capabilities ?? [];
  }

  get target(): string { return this.dir; }

  async available(): Promise<boolean> {
    try { return fs.statSync(this.dir).isDirectory(); } catch { return false; }
  }

  libraries(): FedLibrary[] {
    return scanLibraries(this.dir, this.id);
  }

  async describe(): Promise<FedMemberInfo> {
    const base: FedMemberInfo = {
      id: this.id, label: this.label, variant: this.variant,
      capabilities: this.capabilities, transport: this.transport, target: this.dir, ok: false,
    };
    try {
      if (!fs.statSync(this.dir).isDirectory()) return { ...base, error: '目录不存在或不可读' };
      const libs = this.libraries();
      let memories = 0;
      let failed = 0;
      for (const lib of libs) {
        const n = countMemories(lib.file);
        if (n === null) failed++; else memories += n;
      }
      return { ...base, ok: true, counts: { libraries: libs.length, memories, unreadable: failed } };
    } catch (e: any) {
      return { ...base, error: e?.message ?? String(e) };
    }
  }

  async search(query: string, topK: number): Promise<FedHit[]> {
    return fedTextSearch(this.libraries(), query, topK)
      .map(h => ({ ...h, member: this.id }));
  }
}
