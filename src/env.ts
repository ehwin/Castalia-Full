/**
 * 记忆体框架环境变量配置 — 可配项集中管理
 *
 * 所有通过环境变量可覆盖的配置在这里定义,
 * 避免散落在各模块里硬编码。
 */

/** 角色/实例 ID:用于数据分区。默认 'default'(通用场景) */
export const CHAR_ID: string = process.env.CHAR_ID || 'default';

/** 当前项目 ID(对齐 Hermes Project 概念):记忆按项目隔离。默认 'default' 保持向后兼容 */
export const PROJECT_ID: string = process.env.CASTALIA_PROJECT || 'default';

/**
 * 规范化项目名:trim 前后空白;空字符串/纯空白回退到默认项目。
 * 防止 '' / ' ' / ' alpha ' 这类脏值产生孤立项目命名空间。
 */
export function normalizeProject(p?: string): string {
  const t = (p ?? '').trim();
  return t.length > 0 ? t : PROJECT_ID;
}

/** MCP server 自描述名称 */
export const SERVER_NAME: string = process.env.MCP_SERVER_NAME || 'castalia';

/** 服务器版本号 */
export const SERVER_VERSION: string = process.env.MCP_SERVER_VERSION || '1.0.0';
