import { route, send } from '../lib/http.js';
import { listChats, messagesWithIndex } from '../lib/chat.js';
import { attachmentLabel, fmtSize } from '../lib/files.js';

// GET /api/inbox?key=PASSKEY — plain-text digest of every chat waiting on Instinct.
// Easy for an assistant to read in one page load. Add &format=json for JSON.
export default route({
  GET: async ({ req, res, q }) => {
    const base = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host || 'miduinvesting.vercel.app');
    const file = (a) => ({ kind: a.kind, name: a.name, type: a.type, size: a.size, ...(a.duration ? { duration: a.duration } : {}), ...(a.kind === 'audio' ? { transcript: a.transcript || null } : {}), url: base + '/api/file?id=' + a.id });
    const { chats } = await listChats('instinct');
    const waiting = chats.filter((c) => c.needsReply);
    const items = [];
    for (const c of waiting) {
      const msgs = await messagesWithIndex(c.id, Math.max(0, c.count - 12));
      let k = msgs.length;
      while (k > 0 && msgs[k - 1].from === 'mido') k--;
      items.push({ chat: c.id, title: c.title, messages: msgs.slice(k).filter((m) => !m.deleted).map((m) => ({ i: m.i, at: new Date(m.at).toISOString(), text: m.text, attachments: (m.attachments || []).map(file) })) });
    }
    if (q.format === 'json') return { waiting: items };

    const lines = [];
    lines.push(waiting.length ? `${waiting.length} chat${waiting.length > 1 ? 's' : ''} waiting for Instinct` : 'Nothing is waiting for Instinct');
    for (const it of items) {
      lines.push('', `## ${it.title}  (chat id: ${it.chat})`);
      for (const m of it.messages) {
        lines.push(`[${m.at}] Mido: ${m.text || '(no text)'}`);
        for (const a of m.attachments) {
          lines.push(`    Attached ${attachmentLabel(a).toLowerCase()}${a.kind === 'file' ? '' : ' ' + a.name}, ${a.type}, ${fmtSize(a.size)}: ${a.url}`);
          if (a.kind === 'audio') lines.push(a.transcript ? `    Transcript of the voice note: ${a.transcript}` : '    (no transcript: play the voice note from the link)');
        }
      }
    }
    if (items.some((it) => it.messages.some((m) => m.attachments.length))) {
      lines.push('', 'Attachment links need the passkey too: add &key=<passkey> or send the X-Mido-Key header.');
    }
    lines.push('', 'Reply: POST /api/reply with header x-api-key and JSON {"chatId": "<chat id>", "text": "..."}', 'Or open the website, sign in as Instinct and answer in the chat.');
    return send(res, 200, lines.join('\n'));
  },
});
