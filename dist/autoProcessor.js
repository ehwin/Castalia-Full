/**
 * AutoProcessor — 对话轮次自动处理
 *
 * 职责：把一轮对话保存为 conversation_log 记忆，并触发消化周期。
 * 消息管道不阻塞（同步部分仅 SQLite 写入，毫秒级）。
 */
import { saveConversationTurn } from './store.js';
import { maybeDigest } from './digest.js';
import { PROJECT_ID } from './env.js';
export async function autoProcess(args) {
    const cid = args.characterId || 'default';
    const proj = args.project || PROJECT_ID;
    const results = {
        success: true,
        conversationSaved: false,
        details: [],
    };
    try {
        await saveConversationTurn(args.userMessage, args.assistantMessage, cid, args.moodValue, args.moodReason, proj);
        results.conversationSaved = true;
        results.details.push('conversation saved');
    }
    catch (e) {
        results.details.push('save error: ' + e.message);
    }
    // 事件驱动 digest(不阻塞)
    try {
        maybeDigest(cid, proj)?.catch(() => { });
        results.details.push('digest triggered');
    }
    catch {
        /* noop */
    }
    return results;
}
