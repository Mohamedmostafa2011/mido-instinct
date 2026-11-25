import { route } from '../lib/http.js';
import { store } from '../lib/store.js';
import { postMessage, editMessage, messagesWithIndex } from '../lib/chat.js';

// GET    /api/messages?chat=ID&start=0
// POST   /api/messages {chat?, text, replyTo?, attachments?: [fileId]}   (no chat → starts a new one; see lib/files.js)
// PATCH  /api/messages {chat, i, text}           edit your own message
// DELETE /api/messages {chat, i}                 delete your own message
export default route({
  GET: async ({ q }) => {
    const chat = await store.getChat(String(q.chat || ''));
    if (!chat) return [404, { error: 'Chat not found' }];
    return { chat, messages: await messagesWithIndex(chat.id, Number(q.start) || 0) };
  },
  POST: ({ role, body }) => postMessage({ role, chatId: body.chat || null, text: body.text, replyTo: body.replyTo, attachments: body.attachments }),
  PATCH: ({ role, body }) => editMessage({ role, chatId: String(body.chat || ''), index: Number(body.i), text: body.text }),
  DELETE: ({ role, body }) => editMessage({ role, chatId: String(body.chat || ''), index: Number(body.i), remove: true }),
});
