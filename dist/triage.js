/**
 * Triage Driver — LLM1(入站分拣)通道基础设施
 *
 * v1.11 三通道架构的第一部分:
 *   ① LLM1(triage)  = 入站分拣 + 临时反思(轻量,新配置 TRIAGE_LLM_*)
 *   ② 向量模型       = 记忆库改动后嵌入(已有 embedding.* 配置,不动)
 *   ③ LLM2(reflect) = 每日反思(v1.9 启动反思,已有 REFLECT_* 配置,不动)
 *
 * 通道配置:
 *   TRIAGE_LLM_URL      默认回退 REFLECT_LLM_URL,再回退 https://api.deepseek.com/v1
 *   TRIAGE_LLM_API_KEY  默认回退 REFLECT_LLM_API_KEY;两者都无 → 未配置
 *   TRIAGE_LLM_MODEL    默认回退 REFLECT_LLM_MODEL,再回退 deepseek-chat
 *
 * 回退逻辑:isTriageConfigured() = 有 TRIAGE key 或 REFLECT key。
 */
import { callLlm, makeLlmChannel } from './reflectDriver.js';
import { isMemType } from './memType.js';
/** triage 通道:未配置时回退 REFLECT_* 值(由 makeLlmChannel 统一处理) */
export function triageChannel() {
    return makeLlmChannel('triage');
}
/** triage 是否可用:有 triage key 或 reflect key 都算(回退通道可用) */
export function isTriageConfigured() {
    return !!triageChannel().apiKey;
}
/**
 * triage 极简分类 prompt(中文,Claude 原厂封闭类型语义)
 * 输出严格 JSON:{"memType":"user"} — user/feedback/project/reference/general 之一
 */
export const TRIAGE_SYSTEM_PROMPT = `你是记忆类型分拣引擎。你只做一件事:把一段输入文本分拣到最合适的一种记忆类型。

【记忆类型定义】
- user — 用户画像:用户偏好/技术栈/风格/人物关系洞察(关于"用户是什么样的人")
- feedback — 行为纠正:用户对 agent 行为的纠正或肯定(正面和负面都算)
- project — 项目上下文:当前项目的约定/截止时间/环境信息(非代码可推导的信息)
- reference — 外部指针:URL/链接/文档/ID 等外部引用,只存指针不存内容
- general — 以上都不匹配时的兜底

【输出】只返回严格 JSON 对象,不要任何其他文字,不要代码围栏:
{"memType":"user"}`;
/** 从 LLM 原始输出中提取合法 memType(解析失败/不在白名单 → null → general) */
function parseMemType(raw) {
    let s = (raw || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence)
        s = fence[1].trim();
    const objMatch = s.match(/\{[\s\S]*\}/);
    if (objMatch) {
        try {
            const obj = JSON.parse(objMatch[0]);
            const mt = obj?.memType;
            if (typeof mt === 'string' && isMemType(mt.trim().toLowerCase())) {
                return mt.trim().toLowerCase();
            }
            return null; // 有 memType 但不在白名单 → 非法,归 general
        }
        catch {
            // JSON 解析失败 → 落到裸词尝试
        }
    }
    // 裸词兜底:模型只返回了一个词(如 user)
    const idMatch = s.match(/[A-Za-z]+/);
    if (idMatch) {
        const t = idMatch[0].toLowerCase();
        if (isMemType(t))
            return t;
    }
    return null;
}
/**
 * 入站分拣:输入文本 → memType 白名单之一。
 * 失败/无 key → { memType: 'general', skipped: true }(不阻塞入站)。
 */
export async function classifyMemTypeLLM(text, project) {
    const channel = triageChannel();
    if (!channel.apiKey) {
        return { memType: 'general', skipped: true, raw: '' };
    }
    const userPrompt = `【输入文本】\n${(text || '').slice(0, 4000)}\n\n请返回记忆类型 JSON。`;
    const llm = await callLlm(TRIAGE_SYSTEM_PROMPT, userPrompt, channel);
    if (!llm) {
        return { memType: 'general', skipped: true, raw: '' };
    }
    const raw = llm.content || llm.reasoning || '';
    const parsed = parseMemType(raw);
    return {
        memType: parsed ?? 'general',
        skipped: false,
        raw,
    };
}
