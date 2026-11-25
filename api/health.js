import { route } from '../lib/http.js';
import { store } from '../lib/store.js';
import { postMessage, messagesWithIndex } from '../lib/chat.js';

// GET /api/health?key=PASSKEY: end-to-end storage check. Creates a temporary
// chat, saves two messages through the normal code path, reads them back and
// deletes the chat again. Messages are posted as Instinct, so no email goes out.
export default route({
  GET: async () => {
    const steps = [];
    const t0 = Date.now();
    let chatId = null;
    try {
      const first = await postMessage({ role: 'instinct', chatId: null, text: 'Health check 1' });
      if (Array.isArray(first)) throw new Error('post failed: ' + first[1].error);
      chatId = first.chat.id;
      steps.push('created chat and saved message 1');
      const second = await postMessage({ role: 'instinct', chatId, text: 'Health check 2' });
      if (Array.isArray(second)) throw new Error('post failed: ' + second[1].error);
      steps.push('saved message 2');
      const msgs = await messagesWithIndex(chatId, 0);
      if (msgs.length !== 2 || msgs[1].text !== 'Health check 2') throw new Error('read back ' + msgs.length + ' messages');
      steps.push('read both messages back');
      await store.deleteChat(chatId);
      chatId = null;
      steps.push('deleted the test chat');
      return { ok: true, storage: store.kind, ms: Date.now() - t0, steps };
    } catch (err) {
      if (chatId) await store.deleteChat(chatId).catch(() => {});
      return { ok: false, storage: store.kind, error: String(err.message || err), steps };
    }
  },
});
