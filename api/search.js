import { route, clip } from '../lib/http.js';
import { store } from '../lib/store.js';
import { messagesWithIndex } from '../lib/chat.js';

// GET /api/search?q=words — searches every message in every chat.
export default route({
  GET: async ({ q }) => {
    const term = String(q.q || '').trim().toLowerCase();
    if (term.length < 2) return { results: [] };
    const { chats } = await store.snapshot();
    const results = [];
    for (const chat of Object.values(chats)) {
      const titleHit = chat.title.toLowerCase().includes(term);
      const msgs = await messagesWithIndex(chat.id);
      const hits = msgs.filter((m) => !m.deleted && m.text.toLowerCase().includes(term));
      if (titleHit && !hits.length) results.push({ chat: chat.id, title: chat.title, i: null, from: null, at: chat.updatedAt, snippet: chat.last?.text || '' });
      for (const m of hits.slice(-5)) {
        const pos = m.text.toLowerCase().indexOf(term);
        const from = Math.max(0, pos - 40);
        results.push({ chat: chat.id, title: chat.title, i: m.i, from: m.from, at: m.at, snippet: (from ? '…' : '') + clip(m.text.slice(from), 120) });
      }
    }
    results.sort((a, b) => b.at - a.at);
    return { results: results.slice(0, 50) };
  },
});
