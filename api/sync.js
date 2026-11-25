import { route, storageKind } from '../lib/http.js';
import { store } from '../lib/store.js';
import { decorate, presenceFor, sortChats, messagesWithIndex } from '../lib/chat.js';

// POST /api/sync — the single polling endpoint.
// body: { ver, chat, count, rev, typing, heartbeat, read }
// Cheap when nothing changed: one Redis round trip with two commands.
export default route({
  POST: async ({ role, via, body }) => {
    const now = Date.now();
    const chatId = typeof body.chat === 'string' ? body.chat : null;

    if (body.heartbeat || body.typing !== undefined) {
      await store.setPresence(role, { at: now, chat: chatId, typing: !!body.typing, via });
    }
    if (body.read && typeof body.read === 'string') {
      await store.markRead(role, body.read, now);
    }

    const peek = await store.peek();
    const base = { ok: true, role, storage: storageKind(), now, presence: presenceFor(role, peek.presence) };
    if (Number(body.ver) === peek.ver && body.ver !== undefined) return { ...base, ver: peek.ver, changed: false };

    const snap = await store.snapshot();
    const chats = sortChats(Object.values(snap.chats).map((c) => decorate(c, role, snap.reads)));
    const out = { ...base, ver: snap.ver, changed: true, chats };

    if (chatId) {
      const meta = snap.chats[chatId];
      if (!meta) {
        out.open = { id: chatId, missing: true };
      } else {
        const count = Number(body.count) || 0;
        const reset = Number(body.rev) !== (meta.rev || 0) || count > meta.count;
        const start = reset ? 0 : count;
        const messages = start < meta.count ? await messagesWithIndex(chatId, start) : [];
        out.open = { id: chatId, rev: meta.rev || 0, count: meta.count, reset, messages };
      }
    }
    return out;
  },
});
