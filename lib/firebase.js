// Firebase Realtime Database backend, used over its REST API (no SDK needed).
// Conditional writes (if-match) must not use print=silent, shallow or query params: Firebase rejects that mix.
//
// Env vars:
//   FIREBASE_SERVICE_ACCOUNT  the service account key file from Firebase
//                             (Project settings → Service accounts → Generate new private key),
//                             pasted as raw JSON or base64
//   FIREBASE_DATABASE_URL     e.g. https://my-project-default-rtdb.firebaseio.com
//                             (optional: derived from the project id for US databases)
//   FIREBASE_DATABASE_SECRET  optional legacy alternative to the service account
//
// Everything lives under /mi. Records are stored as JSON strings so the data
// round-trips exactly (the database would otherwise drop empty values and turn
// arrays into objects). The server signs in as an admin, so the database rules
// can stay fully locked: browsers never talk to Firebase directly.
//
//   /mi/ver               change counter, bumped atomically with server increments
//   /mi/chats/{id}        chat JSON
//   /mi/reads/{role:id}   read mark (ms)
//   /mi/pres/{role}       presence JSON
//   /mi/msgs/{id}/{00000042}  message JSON, keys are zero-padded positions
//   /mi/files/{id}/meta   attachment info JSON
//   /mi/files/{id}/p/{00000003}  part 3 of the file, base64 (see lib/files.js)
//   /mi/push/{role}       phones that get push notifications (see lib/push.js)

import crypto from 'node:crypto';

function readAccount() {
  let raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) return null;
  if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
  try {
    const a = JSON.parse(raw);
    if (a.private_key) a.private_key = a.private_key.replace(/\\n/g, '\n');
    return a.client_email && a.private_key ? a : null;
  } catch {
    return null;
  }
}

const account = readAccount();
const secret = (process.env.FIREBASE_DATABASE_SECRET || '').trim();
const dbUrl = (process.env.FIREBASE_DATABASE_URL || (account && account.project_id ? `https://${account.project_id}-default-rtdb.firebaseio.com` : ''))
  .trim().replace(/\/$/, '');

export const firebaseConfigured = !!(dbUrl && (account || secret));

/* ----------------------------------------------------------------- auth */

let token = { value: '', exp: 0 };
const b64url = (b) => Buffer.from(b).toString('base64url');

async function accessToken() {
  if (token.value && Date.now() < token.exp - 120_000) return token.value;
  const now = Math.floor(Date.now() / 1000);
  const aud = account.token_uri || 'https://oauth2.googleapis.com/token';
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.messaging',
    aud, iat: now, exp: now + 3600,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(account.private_key).toString('base64url');
  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.access_token) throw new Error('Firebase sign-in failed: ' + (out.error_description || out.error || res.status));
  token = { value: out.access_token, exp: Date.now() + (out.expires_in || 3600) * 1000 };
  return token.value;
}

/** For push notifications (Firebase Cloud Messaging) with the same service account. */
export const fcmAccount = account ? { projectId: account.project_id, token: accessToken } : null;

/* ----------------------------------------------------------------- REST */

async function call(method, p, { body, query = {}, headers = {} } = {}) {
  const url = new URL(dbUrl + '/mi' + (p ? '/' + p : '') + '.json');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const h = { ...headers };
  if (account) h.Authorization = 'Bearer ' + (await accessToken());
  else url.searchParams.set('auth', secret);
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 412) return { conflict: true };
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).error || msg; } catch { /* keep text */ }
    throw new Error('Firebase responded ' + res.status + ': ' + msg);
  }
  return { data: text ? JSON.parse(text) : null, etag: res.headers.get('etag') };
}

const get = async (p, query) => (await call('GET', p, { query })).data;
const patch = (updates) => call('PATCH', '', { body: updates, query: { print: 'silent' } });
const INC = { '.sv': { increment: 1 } };

const parse = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : null; } catch { return null; } };
const parseAll = (obj) => {
  const o = {};
  for (const [k, v] of Object.entries(obj || {})) { const x = parse(v); if (x) o[k] = x; }
  return o;
};
const pad = (n) => String(n).padStart(8, '0');

export const firebaseStore = {
  kind: 'firebase',
  async peek() {
    const [ver, pres] = await Promise.all([get('ver'), get('pres')]);
    return { ver: Number(ver || 0), presence: parseAll(pres) };
  },
  async snapshot() {
    const [ver, pres, chats, reads] = await Promise.all([get('ver'), get('pres'), get('chats'), get('reads')]);
    const r = {};
    for (const [k, v] of Object.entries(reads || {})) r[k] = Number(v);
    return { ver: Number(ver || 0), presence: parseAll(pres), chats: parseAll(chats), reads: r };
  },
  async getChat(id) {
    return parse(await get('chats/' + id));
  },
  async putChat(chat) {
    await patch({ ['chats/' + chat.id]: JSON.stringify(chat), ver: INC });
  },
  async deleteChat(id) {
    await patch({ ['chats/' + id]: null, ['msgs/' + id]: null, ['reads/mido:' + id]: null, ['reads/instinct:' + id]: null, ver: INC });
  },
  async messages(id, start = 0) {
    const data = await get('msgs/' + id, { orderBy: '"$key"', startAt: '"' + pad(start) + '"' });
    if (!data) return [];
    // Arrays come back when keys look like consecutive numbers; handle both shapes.
    const entries = Array.isArray(data)
      ? data.map((v, i) => [pad(i), v]).filter(([, v]) => v != null)
      : Object.entries(data);
    return entries.sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => parse(v)).filter(Boolean);
  },
  // Gap-free append: claim the next empty slot with a conditional write, retrying on races.
  async append(id, msg) {
    const keys = await get('msgs/' + id, { shallow: 'true' });
    let n = keys ? Object.keys(keys).length : 0;
    const value = JSON.stringify(msg);
    for (let tries = 0; tries < 20; tries++) {
      const slot = 'msgs/' + id + '/' + pad(n);
      const cur = await call('GET', slot, { headers: { 'X-Firebase-ETag': 'true' } });
      if (cur.data != null) { n++; continue; }
      const put = await call('PUT', slot, { body: value, headers: { 'if-match': cur.etag } });
      if (!put.conflict) return n + 1;
      n++;
    }
    throw new Error('Could not save the message, please try again');
  },
  async setMessage(id, index, msg) {
    await patch({ ['msgs/' + id + '/' + pad(index)]: JSON.stringify(msg) });
  },
  async markRead(role, id, at) {
    await patch({ ['reads/' + role + ':' + id]: at, ver: INC });
  },
  async setPresence(role, data) {
    await patch({ ['pres/' + role]: JSON.stringify(data) });
  },
  async bump() {
    await patch({ ver: INC });
  },
  async putFileMeta(id, meta) {
    await call('PUT', 'files/' + id + '/meta', { body: JSON.stringify(meta), query: { print: 'silent' } });
  },
  async getFileMeta(id) {
    return parse(await get('files/' + id + '/meta'));
  },
  async putFilePart(id, n, b64) {
    await call('PUT', 'files/' + id + '/p/' + pad(n), { body: b64, query: { print: 'silent' } });
  },
  async getFilePart(id, n) {
    const v = await get('files/' + id + '/p/' + pad(n));
    return typeof v === 'string' ? v : null;
  },
  async countFileParts(id) {
    const keys = await get('files/' + id + '/p', { shallow: 'true' });
    return keys ? Object.keys(keys).length : 0;
  },
  async deleteFile(id) {
    await call('DELETE', 'files/' + id, { query: { print: 'silent' } });
  },
  async getDevices(role) {
    return parse(await get('push/' + role)) || [];
  },
  async putDevices(role, list) {
    await call('PUT', 'push/' + role, { body: JSON.stringify(list), query: { print: 'silent' } });
  },
  // Returns true only for the first caller with this key: a write that only
  // succeeds while the slot is still empty.
  async claim(key) {
    const slot = 'claims/' + key.replace(/[.#$\[\]\/:]/g, '_');
    const cur = await call('GET', slot, { headers: { 'X-Firebase-ETag': 'true' } });
    if (cur.data != null) return false;
    const put = await call('PUT', slot, { body: Date.now(), headers: { 'if-match': cur.etag } });
    return !put.conflict;
  },
};
