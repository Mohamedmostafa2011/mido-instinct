import { store } from './store.js';
import { other, newId, clip } from './http.js';
import { emailNewMessage } from './email.js';

export const ONLINE_MS = 40_000;
export const TYPING_MS = 8_000;
export const MAX_TEXT = 20_000;

export function newChat(title) {
  const now = Date.now();
  const t = clip(title, 60);
  return {
    id: newId('c'),
    title: t || 'New chat',
    titleAuto: !t,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    count: 0,
    rev: 0,
    last: null,
    lastAt: { mido: 0, instinct: 0 },
    streak: { from: null, n: 0 },
  };
}

/** Adds the per-viewer fields the UI needs. */
export function decorate(chat, role, reads) {
  const o = other(role);
  const myRead = reads[role + ':' + chat.id] || 0;
  const theirRead = reads[o + ':' + chat.id] || 0;
  const last = chat.last;
  const unread = !!(last && last.from === o && last.at > myRead);
  return {
    ...chat,
    unread,
    unreadCount: unread ? chat.streak?.n || 1 : 0,
    needsReply: !!(last && last.from === 'mido' && !last.deleted),
    seenAt: theirRead,
  };
}

export function presenceFor(role, presence) {
  const p = presence[other(role)];
  const now = Date.now();
  if (!p) return { online: false, at: 0, chat: null, typing: false };
  return {
    online: now - p.at < ONLINE_MS,
    at: p.at,
    chat: p.chat || null,
    typing: !!p.typing && now - p.at < TYPING_MS,
    via: p.via || null,
  };
}

export function sortChats(list) {
  return list.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
}

export async function listChats(role) {
  const snap = await store.snapshot();
  const chats = sortChats(Object.values(snap.chats).map((c) => decorate(c, role, snap.reads)));
  return { snap, chats };
}

export async function messagesWithIndex(chatId, start = 0) {
  const list = await store.messages(chatId, start);
  return list.map((m, k) => ({ ...m, i: start + k }));
}

export async function postMessage({ role, chatId, text, replyTo }) {
  text = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [400, { error: 'Message is empty' }];
  if (text.length > MAX_TEXT) return [400, { error: 'Message is longer than ' + MAX_TEXT + ' characters' }];

  let chat = chatId ? await store.getChat(chatId) : null;
  if (chatId && !chat) return [404, { error: 'Chat not found' }];
  if (!chat) chat = newChat('');

  const now = Date.now();
  const msg = { id: newId('m'), from: role, text, at: now };
  if (replyTo && typeof replyTo === 'object' && replyTo.id) {
    msg.replyTo = { id: String(replyTo.id), from: replyTo.from === 'mido' ? 'mido' : 'instinct', text: clip(replyTo.text, 140) };
  }

  const len = await store.append(chat.id, msg);
  msg.i = len - 1;

  chat.count = len;
  chat.updatedAt = now;
  chat.last = { from: role, text: clip(text, 160), at: now };
  chat.lastAt = { ...(chat.lastAt || {}), [role]: now };
  chat.streak = chat.streak?.from === role ? { from: role, n: chat.streak.n + 1 } : { from: role, n: 1 };
  if (chat.titleAuto) {
    const firstLine = (text.split('\n').find((l) => l.trim()) || text).replace(/[*_`#>]/g, '').trim();
    const sentence = firstLine.match(/^(.{12,}?[.!?؟])(\s|$)/);
    chat.title = clip(sentence ? sentence[1].replace(/[.]$/, '') : firstLine, 48);
    chat.titleAuto = false;
  }
  await store.putChat(chat);
  await store.markRead(role, chat.id, now);

  // Alerts go out right here, as soon as the message is saved. On Vercel they
  // finish after the response via waitUntil; elsewhere the request waits for them.
  // Neither can fail the request: errors are logged inside.
  if (role === 'mido') {
    const alerts = Promise.all([
      emailNewMessage(chat, msg),
      notify(chat, msg).catch((err) => console.error('[webhook] ' + (err.message || err))),
    ]);
    const pending = background(alerts);
    if (pending) await pending;
  }
  return { chat, message: msg };
}

export async function editMessage({ role, chatId, index, text, remove }) {
  const chat = await store.getChat(chatId);
  if (!chat) return [404, { error: 'Chat not found' }];
  const [msg] = await store.messages(chatId, index).then((l) => l.slice(0, 1));
  if (!msg) return [404, { error: 'Message not found' }];
  if (msg.from !== role) return [403, { error: 'You can only change your own messages' }];

  const now = Date.now();
  if (remove) {
    msg.deleted = true;
    msg.text = '';
    delete msg.replyTo;
  } else {
    text = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!text) return [400, { error: 'Message is empty' }];
    msg.text = text;
    msg.editedAt = now;
  }
  await store.setMessage(chatId, index, msg);

  chat.rev = (chat.rev || 0) + 1;
  if (index === chat.count - 1) {
    chat.last = { from: msg.from, text: remove ? 'Message deleted' : clip(msg.text, 160), at: chat.last?.at || now, deleted: !!remove };
  }
  await store.putChat(chat);
  return { ok: true, message: { ...msg, i: index } };
}

/** Keeps a promise alive after the response on Vercel. Returns it when it must be awaited instead. */
function background(promise) {
  const ctx = globalThis[Symbol.for('@vercel/request-context')]?.get?.();
  if (ctx && typeof ctx.waitUntil === 'function') { ctx.waitUntil(promise); return null; }
  return promise;
}

/** Optional: POST new messages from Mido to a webhook (Zapier, Make, n8n…) so Instinct gets pinged. */
async function notify(chat, msg) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'message', chat: { id: chat.id, title: chat.title }, message: { id: msg.id, from: msg.from, text: msg.text, at: msg.at } }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}
