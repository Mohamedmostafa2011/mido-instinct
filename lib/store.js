// Storage for chats, messages, read marks and presence.
//
// Production, either of:
//  - Firebase Realtime Database (see lib/firebase.js for its env vars), or
//  - Upstash Redis over its REST API (the store Vercel's marketplace
// provisions). Env vars from either naming scheme are accepted:
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   KV_REST_API_URL        / KV_REST_API_TOKEN
//
// Local development: a JSON file in .data/ (or memory when the disk is read-only).

import fs from 'node:fs';
import path from 'node:path';
import { firebaseStore, firebaseConfigured } from './firebase.js';

const P = 'mi:'; // key prefix
const K = {
  ver: P + 'ver',
  chats: P + 'chats',
  reads: P + 'reads', // field `${role}:${chatId}` -> ms timestamp
  pres: P + 'pres', // field role -> JSON {at, chat, typing}
  msgs: (id) => P + 'm:' + id,
};

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';

/* ------------------------------------------------------------------ redis */

async function pipeline(commands) {
  const res = await fetch(REDIS_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error('Redis responded ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const out = await res.json();
  return out.map((r) => {
    if (r.error) throw new Error('Redis: ' + r.error);
    return r.result;
  });
}

const hashToObj = (arr) => {
  const o = {};
  if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  else if (arr && typeof arr === 'object') Object.assign(o, arr);
  return o;
};
const parseAll = (obj) => {
  const o = {};
  for (const [k, v] of Object.entries(obj)) {
    try { o[k] = JSON.parse(v); } catch { /* skip corrupt */ }
  }
  return o;
};

const F = { meta: (id) => P + 'f:' + id, parts: (id) => P + 'fp:' + id };

const redisStore = {
  kind: 'redis',
  async putFileMeta(id, meta) { await pipeline([['SET', F.meta(id), JSON.stringify(meta)]]); },
  async getFileMeta(id) { const [v] = await pipeline([['GET', F.meta(id)]]); try { return v ? JSON.parse(v) : null; } catch { return null; } },
  async putFilePart(id, n, b64) { await pipeline([['HSET', F.parts(id), String(n), b64]]); },
  async getFilePart(id, n) { const [v] = await pipeline([['HGET', F.parts(id), String(n)]]); return v || null; },
  async countFileParts(id) { const [v] = await pipeline([['HLEN', F.parts(id)]]); return Number(v) || 0; },
  async deleteFile(id) { await pipeline([['DEL', F.meta(id), F.parts(id)]]); },
  async peek() {
    const [ver, pres] = await pipeline([['GET', K.ver], ['HGETALL', K.pres]]);
    return { ver: Number(ver || 0), presence: parseAll(hashToObj(pres)) };
  },
  async snapshot() {
    const [ver, pres, chats, reads] = await pipeline([
      ['GET', K.ver], ['HGETALL', K.pres], ['HGETALL', K.chats], ['HGETALL', K.reads],
    ]);
    const r = hashToObj(reads);
    for (const k in r) r[k] = Number(r[k]);
    return { ver: Number(ver || 0), presence: parseAll(hashToObj(pres)), chats: parseAll(hashToObj(chats)), reads: r };
  },
  async getChat(id) {
    const [c] = await pipeline([['HGET', K.chats, id]]);
    return c ? JSON.parse(c) : null;
  },
  async putChat(chat) {
    await pipeline([['HSET', K.chats, chat.id, JSON.stringify(chat)], ['INCR', K.ver]]);
  },
  async deleteChat(id) {
    await pipeline([
      ['HDEL', K.chats, id], ['DEL', K.msgs(id)],
      ['HDEL', K.reads, 'mido:' + id, 'instinct:' + id], ['INCR', K.ver],
    ]);
  },
  async messages(id, start = 0) {
    const [list] = await pipeline([['LRANGE', K.msgs(id), String(start), '-1']]);
    return (list || []).map((s) => JSON.parse(s));
  },
  async append(id, msg) {
    const [len] = await pipeline([['RPUSH', K.msgs(id), JSON.stringify(msg)]]);
    return Number(len);
  },
  async setMessage(id, index, msg) {
    await pipeline([['LSET', K.msgs(id), String(index), JSON.stringify(msg)]]);
  },
  async markRead(role, id, at) {
    await pipeline([['HSET', K.reads, role + ':' + id, String(at)], ['INCR', K.ver]]);
  },
  async setPresence(role, data) {
    await pipeline([['HSET', K.pres, role, JSON.stringify(data)]]);
  },
  async bump() {
    await pipeline([['INCR', K.ver]]);
  },
  async getDevices(role) { const [v] = await pipeline([['HGET', P + 'push', role]]); try { return v ? JSON.parse(v) : []; } catch { return []; } },
  async putDevices(role, list) { await pipeline([['HSET', P + 'push', role, JSON.stringify(list)]]); },
  // Returns true only for the first caller with this key (kept 30 days).
  async claim(key) {
    const [r] = await pipeline([['SET', P + 'claim:' + key, '1', 'NX', 'EX', '2592000']]);
    return r === 'OK';
  },
};

/* ------------------------------------------------------------- file/memory */

const DATA_FILE = path.join(process.cwd(), '.data', 'db.json');
const onVercel = !!process.env.VERCEL;
let mem = null;

function load() {
  if (mem) return mem;
  mem = { ver: 0, chats: {}, msgs: {}, reads: {}, pres: {} };
  if (!onVercel) {
    try { mem = { ...mem, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch { /* fresh */ }
  }
  return mem;
}
function save() {
  if (onVercel) return;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(mem));
  } catch { /* read-only disk: stay in memory */ }
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// On Vercel the memory store would forget everything when the function sleeps,
// so chats would seem saved and then disappear. Refuse to store anything there.
function persistentOnly() {
  if (onVercel) throw new Error('No persistent storage is configured. Set FIREBASE_DATABASE_URL and FIREBASE_SERVICE_ACCOUNT (or Upstash Redis) on Vercel.');
}

// Files sit next to db.json as one folder per file, so the JSON stays small.
const FILES_DIR = path.join(process.cwd(), '.data', 'files');
const memFiles = new Map(); // id -> { meta, parts: Map } when the disk can't be used
const fileDir = (id) => path.join(FILES_DIR, id.replace(/[^a-z0-9]/gi, ''));
function diskFiles() {
  if (onVercel) return false;
  try { fs.mkdirSync(FILES_DIR, { recursive: true }); return true; } catch { return false; }
}

const localStore = {
  kind: onVercel ? 'memory' : 'file',
  async putFileMeta(id, meta) {
    persistentOnly();
    if (diskFiles()) { fs.mkdirSync(fileDir(id), { recursive: true }); fs.writeFileSync(path.join(fileDir(id), 'meta.json'), JSON.stringify(meta)); return; }
    const f = memFiles.get(id) || { parts: new Map() }; f.meta = clone(meta); memFiles.set(id, f);
  },
  async getFileMeta(id) {
    if (diskFiles()) { try { return JSON.parse(fs.readFileSync(path.join(fileDir(id), 'meta.json'), 'utf8')); } catch { return null; } }
    const f = memFiles.get(id); return f && f.meta ? clone(f.meta) : null;
  },
  async putFilePart(id, n, b64) {
    persistentOnly();
    if (diskFiles()) { fs.mkdirSync(fileDir(id), { recursive: true }); fs.writeFileSync(path.join(fileDir(id), n + '.b64'), b64); return; }
    const f = memFiles.get(id) || { parts: new Map() }; f.parts.set(n, b64); memFiles.set(id, f);
  },
  async getFilePart(id, n) {
    if (diskFiles()) { try { return fs.readFileSync(path.join(fileDir(id), n + '.b64'), 'utf8'); } catch { return null; } }
    return memFiles.get(id)?.parts.get(n) ?? null;
  },
  async countFileParts(id) {
    if (diskFiles()) { try { return fs.readdirSync(fileDir(id)).filter((x) => x.endsWith('.b64')).length; } catch { return 0; } }
    return memFiles.get(id)?.parts.size || 0;
  },
  async deleteFile(id) {
    if (diskFiles()) { fs.rmSync(fileDir(id), { recursive: true, force: true }); return; }
    memFiles.delete(id);
  },
  async peek() { const db = load(); return { ver: db.ver, presence: clone(db.pres) }; },
  async snapshot() {
    const db = load();
    return { ver: db.ver, presence: clone(db.pres), chats: clone(db.chats), reads: clone(db.reads) };
  },
  async getChat(id) { const c = load().chats[id]; return c ? clone(c) : null; },
  async putChat(chat) { persistentOnly(); const db = load(); db.chats[chat.id] = clone(chat); db.ver++; save(); },
  async deleteChat(id) {
    const db = load();
    delete db.chats[id]; delete db.msgs[id];
    delete db.reads['mido:' + id]; delete db.reads['instinct:' + id];
    db.ver++; save();
  },
  async messages(id, start = 0) { return clone((load().msgs[id] || []).slice(start)); },
  async append(id, msg) { persistentOnly(); const db = load(); (db.msgs[id] ||= []).push(clone(msg)); save(); return db.msgs[id].length; },
  async setMessage(id, index, msg) { persistentOnly(); const db = load(); if (db.msgs[id]) db.msgs[id][index] = clone(msg); save(); },
  async markRead(role, id, at) { const db = load(); db.reads[role + ':' + id] = at; db.ver++; save(); },
  async setPresence(role, data) { const db = load(); db.pres[role] = data; save(); },
  async bump() { const db = load(); db.ver++; save(); },
  async getDevices(role) { return clone((load().push || {})[role] || []); },
  async putDevices(role, list) { const db = load(); (db.push ||= {})[role] = clone(list); save(); },
  async claim(key) {
    const db = load();
    db.claims ||= {};
    if (db.claims[key]) return false;
    db.claims[key] = Date.now(); save(); return true;
  },
};

export const store = firebaseConfigured ? firebaseStore : REDIS_URL && REDIS_TOKEN ? redisStore : localStore;
