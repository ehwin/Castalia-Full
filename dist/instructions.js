/**
 * 三层指令记忆(instruction memory)
 *
 * 类比 Claude Code 的 CLAUDE.md 层级:
 *   L1 global   — 所有用户/所有项目通用规则(首次启动写入全局规范种子)
 *   L2 user     — 当前用户所有项目共享(用户自填,无种子)
 *   L3 project  — 单项目专属规则(scope=project + project 名)
 *
 * 加载机制(关键):查找从近到远 L3→L2→L1;文本拼接喂给 LLM 时从远到近 L1→L2→L3。
 * L3 落在 Prompt 最末尾,利用 LLM 近因效应实现「后加载约束更高」,可覆盖 L1/L2 冲突规则。
 */
import { DatabaseManager, generateId } from './db.js';
/** L1 全局种子:用户提供的全局规范全文 */
export const INSTRUCTION_SEED_GLOBAL = `以下是全局规范
1. 核心工作原则:代码可读性与类型安全,优先保证逻辑清晰与类型严谨;做最小化变更,仅修改与目标任务直接相关的代码,严禁无意义代码重排或不必要格式重构;环境安全优先,执行涉及文件删除、破坏性 Git 操作或网络请求的工具指令前务必谨慎确认。
2. 编码规范:TypeScript/JavaScript 严格禁止 any,优先定义 interface/type,ES6+ 语法优先 async/await,字符串统一单引号,2 空格缩进;Python 遵从 PEP 8,函数与类型标注完善(Type Hints),Python 3.10+,4 空格缩进;错误处理显式捕获异常,禁止空 catch 块,提供有意义且便于调试的错误日志。
3. 工具使用与交互约束:修改代码后主动运行相关 Lint 或单测验证,禁止抛出未经验证的代码;测试失败先读终端日志定位原因,不盲目重复同一种修补方案;耗时长的脚本或服务启动命令必须设置合理超时或后台挂起;查看日志或搜索代码限制输出行数(head/grep/--max-count),避免大文本污染。
4. 提交与文档规范:Git Commit 格式 <type>(<scope>): <short summary>,type 含 feat/fix/refactor/docs/test/chore,提交信息简洁,英文首字母小写,结尾不加句号;新增核心功能或修改架构接口时同步更新 README/API 文档。`;
/**
 * 首次启动:表内无任何指令时写入 L1 全局种子。
 * 返回是否真的写入了种子 + 当前表内条数。
 */
export function ensureSeedInstructions() {
    const db = DatabaseManager.getInstance();
    const row = db.prepare('SELECT COUNT(*) as c FROM instructions').get();
    const count = row.c;
    if (count > 0)
        return { seeded: false, count };
    db.prepare('INSERT INTO instructions (id, scope, project, content) VALUES (?, ?, ?, ?)')
        .run(generateId(), 'global', null, INSTRUCTION_SEED_GLOBAL);
    return { seeded: true, count: 1 };
}
/**
 * upsert:同 scope+project 覆盖更新(global/user 的 project 传 null)。
 * 返回该行 id 与是否新建(created=false 表示覆盖更新)。
 */
export function saveInstruction(scope, project, content) {
    const db = DatabaseManager.getInstance();
    const existing = db.prepare('SELECT id FROM instructions WHERE scope = ? AND project IS ?').get(scope, project);
    if (existing) {
        db.prepare('UPDATE instructions SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(content, existing.id);
        return { id: existing.id, created: false };
    }
    const id = generateId();
    db.prepare('INSERT INTO instructions (id, scope, project, content) VALUES (?, ?, ?, ?)').run(id, scope, project, content);
    return { id, created: true };
}
/**
 * 按 L1→L2→L3 顺序返回拼接数组(每层最多一条)。
 * L3 仅在传入 project 时查询。
 */
export function getInstruction(project) {
    const db = DatabaseManager.getInstance();
    const result = [];
    const l1 = db.prepare('SELECT scope, project, content FROM instructions WHERE scope = ?').get('global');
    const l2 = db.prepare('SELECT scope, project, content FROM instructions WHERE scope = ?').get('user');
    if (l1)
        result.push({ scope: l1.scope, project: l1.project, content: l1.content });
    if (l2)
        result.push({ scope: l2.scope, project: l2.project, content: l2.content });
    const proj = (project ?? '').trim();
    if (proj.length > 0) {
        const l3 = db.prepare('SELECT scope, project, content FROM instructions WHERE scope = ? AND project = ?').get('project', proj);
        if (l3)
            result.push({ scope: l3.scope, project: l3.project, content: l3.content });
    }
    return result;
}
/** admin:全部列出(global/user/project 按层排序,带 updated_at) */
export function listInstructions() {
    const db = DatabaseManager.getInstance();
    const rows = db.prepare(`
    SELECT id, scope, project, content, updated_at FROM instructions
    ORDER BY CASE scope WHEN 'global' THEN 1 WHEN 'user' THEN 2 ELSE 3 END, project
  `).all();
    return rows.map(r => ({
        id: r.id,
        scope: r.scope,
        project: r.project,
        content: r.content,
        updatedAt: r.updated_at,
    }));
}
/** admin:删一层(global/user 的 project 传 null);返回是否删到 */
export function deleteInstruction(scope, project) {
    const db = DatabaseManager.getInstance();
    const r = db.prepare('DELETE FROM instructions WHERE scope = ? AND project IS ?').run(scope, project ?? null);
    return { deleted: r.changes > 0 };
}
