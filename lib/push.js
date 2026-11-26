// Push notifications for the Android app, through Firebase Cloud Messaging (FCM).
//
// They reach the phone even when the app is closed or swiped away: Android
// itself shows them. The server signs in with the same Firebase service account
// that stores the chats (FIREBASE_SERVICE_ACCOUNT), so no extra key is needed.
// The app must be built with the project's google-services.json (env
// GOOGLE_SERVICES_JSON on Vercel, handed to the build by api/provision.js).
//
// Each phone registers its FCM token after signing in (POST /api/session
// {pushToken}). Every new message is pushed to the other side's phones.
// Tokens Google reports as gone are dropped automatically.

import { store } from './store.js';
import { fcmAccount } from './firebase.js';
import { other, clip } from './http.js';
import { summarize } from './files.js';

const NAMES = { mido: 'Mido', instinct: 'Instinct' };
const MAX_DEVICES = 10;
const SEND_TIMEOUT_MS = 6000;
const API = () => (process.env.FCM_API_URL || 'https://fcm.googleapis.com').replace(/\/$/, '');

export const pushConfigured = () => !!(fcmAccount && fcmAccount.projectId);
const validToken = (t) => typeof t === 'string' && t.length >= 20 && t.length <= 4096 && /^[\w:.-]+$/.test(t);
const short = (t) => t.slice(0, 8) + '…';

/** Adds (or with enabled:false removes) a phone. Returns [status, body] on bad input. */
export async function registerDevice(role, { token, platform, enabled = true }) {
  if (!validToken(token)) return [400, { error: 'Bad push token' }];
  const list = (await store.getDevices(role)).filter((d) => d.token !== token);
  if (enabled !== false) list.unshift({ token, platform: platform === 'android' ? 'android' : 'other', at: Date.now() });
  await store.putDevices(role, list.slice(0, MAX_DEVICES));
  return { ok: true, push: enabled !== false, devices: Math.min(list.length, MAX_DEVICES) };
}

async function sendOne(token, n) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${API()}/v1/projects/${encodeURIComponent(fcmAccount.projectId)}/messages:send`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (await fcmAccount.token()), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: n.title, body: n.body },
          data: { chatId: n.chatId || '', kind: n.kind || 'message' },
          android: {
            priority: 'HIGH', // delivered right away, even in battery saver
            ttl: '86400s',
            notification: {
              channel_id: 'messages',
              icon: 'ic_stat_mido',
              color: '#2a6544',
              tag: n.chatId || n.kind, // a newer message in the same chat replaces the older notification
              default_sound: true,
              notification_priority: 'PRIORITY_HIGH',
              visibility: 'PRIVATE', // lock screen shows "Instinct" until unlocked
            },
          },
        },
      }),
      signal: ctrl.signal,
    });
    if (res.ok) return { ok: true };
    const out = await res.json().catch(() => ({}));
    const code = (out.error?.details || []).map((d) => d.errorCode).find(Boolean) || out.error?.status || '';
    const gone = res.status === 404 || code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH' || (res.status === 400 && /token/i.test(out.error?.message || ''));
    return { ok: false, gone, error: `FCM ${res.status} ${code}: ${clip(out.error?.message || 'request failed', 160)}` };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'FCM did not answer in time' : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Sends one notification to every phone of `role`. Never throws. */
export async function pushTo(role, n) {
  if (!pushConfigured()) return { skipped: 'FIREBASE_SERVICE_ACCOUNT is not set' };
  let devices;
  try { devices = await store.getDevices(role); } catch (err) { console.error('[push] could not read devices: ' + (err.message || err)); return { error: 'storage' }; }
  if (!devices.length) return { skipped: 'no phones registered' };
  const results = await Promise.all(devices.map((d) => sendOne(d.token, n)));
  const gone = new Set();
  results.forEach((r, k) => {
    if (r.ok) return;
    if (r.gone) gone.add(devices[k].token);
    console.error(`[push] to ${role} phone ${short(devices[k].token)} failed: ${r.error}`);
  });
  if (gone.size) {
    try { await store.putDevices(role, (await store.getDevices(role)).filter((d) => !gone.has(d.token))); } catch { /* next time */ }
  }
  return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

/** The notification for a newly saved message goes to the other side. */
export function pushNewMessage(chat, msg) {
  return pushTo(other(msg.from), {
    title: (NAMES[msg.from] || msg.from) + ' · ' + (chat.title || 'New chat'),
    body: clip(summarize(msg) || 'New message', 240),
    chatId: chat.id,
  });
}
