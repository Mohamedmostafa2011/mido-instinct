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

const redisStore = {
  kind: 'redis',
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

const localStore = {
  kind: onVercel ? 'memory' : 'file',
  async peek() { const db = load(); return { ver: db.ver, presence: clone(db.pres) }; },
  async snapshot() {
    const db = load();
    return { ver: db.ver, presence: clone(db.pres), chats: clone(db.chats), reads: clone(db.reads) };
  },
  async getChat(id) { const c = load().chats[id]; return c ? clone(c) : null; },
  async putChat(chat) { const db = load(); db.chats[chat.id] = clone(chat); db.ver++; save(); },
  async deleteChat(id) {
    const db = load();
    delete db.chats[id]; delete db.msgs[id];
    delete db.reads['mido:' + id]; delete db.reads['instinct:' + id];
    db.ver++; save();
  },
  async messages(id, start = 0) { return clone((load().msgs[id] || []).slice(start)); },
  async append(id, msg) { const db = load(); (db.msgs[id] ||= []).push(clone(msg)); save(); return db.msgs[id].length; },
  async setMessage(id, index, msg) { const db = load(); if (db.msgs[id]) db.msgs[id][index] = clone(msg); save(); },
  async markRead(role, id, at) { const db = load(); db.reads[role + ':' + id] = at; db.ver++; save(); },
  async setPresence(role, data) { const db = load(); db.pres[role] = data; save(); },
  async bump() { const db = load(); db.ver++; save(); },
};

export const store = firebaseConfigured ? firebaseStore : REDIS_URL && REDIS_TOKEN ? redisStore : localStore;
