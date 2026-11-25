import { route, clip } from '../lib/http.js';
import { store } from '../lib/store.js';
import { newChat, listChats } from '../lib/chat.js';

// GET    /api/chats              list
// POST   /api/chats  {title}     create
// PATCH  /api/chats  {id, title?, pinned?}
// DELETE /api/chats  {id}
export default route({
  GET: async ({ role }) => ({ chats: (await listChats(role)).chats }),
  POST: async ({ body }) => {
    const chat = newChat(body.title);
    await store.putChat(chat);
    return { chat };
  },
  PATCH: async ({ body }) => {
    const chat = await store.getChat(String(body.id || ''));
    if (!chat) return [404, { error: 'Chat not found' }];
    if (typeof body.title === 'string' && body.title.trim()) { chat.title = clip(body.title, 60); chat.titleAuto = false; }
    if (typeof body.pinned === 'boolean') chat.pinned = body.pinned;
    await store.putChat(chat);
    return { chat };
  },
  DELETE: async ({ body, q }) => {
    const id = String(body.id || q.id || '');
    if (!id) return [400, { error: 'Missing id' }];
    await store.deleteChat(id);
    return { ok: true };
  },
});
