import { route, send } from '../lib/http.js';
import { listChats, messagesWithIndex } from '../lib/chat.js';

// GET /api/inbox?key=PASSKEY — plain-text digest of every chat waiting on Instinct.
// Easy for an assistant to read in one page load. Add &format=json for JSON.
export default route({
  GET: async ({ res, q }) => {
    const { chats } = await listChats('instinct');
    const waiting = chats.filter((c) => c.needsReply);
    const items = [];
    for (const c of waiting) {
      const msgs = await messagesWithIndex(c.id, Math.max(0, c.count - 12));
      let k = msgs.length;
      while (k > 0 && msgs[k - 1].from === 'mido') k--;
      items.push({ chat: c.id, title: c.title, messages: msgs.slice(k).filter((m) => !m.deleted).map((m) => ({ i: m.i, at: new Date(m.at).toISOString(), text: m.text })) });
    }
    if (q.format === 'json') return { waiting: items };

    const lines = [];
    lines.push(waiting.length ? `${waiting.length} chat${waiting.length > 1 ? 's' : ''} waiting for Instinct` : 'Nothing is waiting for Instinct');
    for (const it of items) {
      lines.push('', `## ${it.title}  (chat id: ${it.chat})`);
      for (const m of it.messages) lines.push(`[${m.at}] Mido: ${m.text}`);
    }
    lines.push('', 'Reply: POST /api/reply with header x-api-key and JSON {"chatId": "<chat id>", "text": "..."}', 'Or open the website, sign in as Instinct and answer in the chat.');
    return send(res, 200, lines.join('\n'));
  },
});
