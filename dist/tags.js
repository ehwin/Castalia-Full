/**
 * tags 列安全读写 — 单一入口
 *
 * 历史库中存在被写坏的 tags(非法 JSON、JSON 标量、列错位、数组里混入非字符串等)。
 * 读路径必须容错:坏行只丢自己的坏标签,不能中断整库检索;
 * 写路径必须收口:落库值永远是干净的 string[] 的 JSON 序列化。
 */
/** 归一为 string[]:嵌套数组拍平一层,只留字符串,trim 后丢弃空串。 */
export function normalizeTags(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const item of value) {
        const parts = Array.isArray(item) ? item : [item];
        for (const part of parts) {
            if (typeof part !== 'string')
                continue; // 数字/布尔/null/对象一律丢弃,不做 String() 强转
            const trimmed = part.trim();
            if (trimmed.length > 0)
                out.push(trimmed);
        }
    }
    return out;
}
/**
 * 安全解析 DB 的 tags 列。
 *
 * 后置条件(硬性): 返回值必为 `string[]` —— 每个元素都是非空、已 trim 的字符串;
 * 非数组 JSON / 非法 JSON / 标量 → [];数组中的数字、布尔、null、对象被丢弃;
 * 嵌套数组只拍平一层。下游可无条件使用 .toLowerCase() / .join() / SQL 绑定。
 */
export function parseTagsSafe(raw) {
    if (Array.isArray(raw))
        return normalizeTags(raw);
    if (typeof raw !== 'string')
        return [];
    try {
        return normalizeTags(JSON.parse(raw));
    }
    catch {
        return [];
    }
}
/** 写入前序列化:保证落库的一定是干净 string[] 的 JSON。 */
export function serializeTags(value) {
    return JSON.stringify(normalizeTags(value));
}
/**
 * 兼容 web 路由的命名:写入前把任意来源(DB 里的 JSON 字符串 / 调用方数组)归一为 string[]。
 * 与 parseTagsSafe 同一实现，后置条件同为 string[]。
 */
export const normalizeTagsForWrite = parseTagsSafe;
