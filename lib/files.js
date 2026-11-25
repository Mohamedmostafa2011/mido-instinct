// Attachments: voice notes, photos and other files.
//
// Files are kept in the same database as the chats, behind the same passkey /
// app key, so nothing is ever reachable by a public link. Each file is split
// into parts of PART_SIZE bytes (Vercel caps a request or response body at
// 4.5 MB), uploaded one by one, then attached to a message by id.
//
//   POST /api/upload           {name, type, size, kind, duration?, wave?, w?, h?} → {id, partSize, parts}
//   PUT  /api/upload?id=&n=    raw bytes of part n                               → {ok, done}
//   POST /api/messages         {chat, text, attachments: [id, …]}
//   GET  /api/file?id=[&n=]    the whole file, or one part

import crypto from 'node:crypto';
import { store } from './store.js';

export const PART_SIZE = 2 * 1024 * 1024;
export const MAX_FILE = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
const KINDS = ['image', 'audio', 'file'];

const cleanName = (s) => String(s || '').replace(/[\\/\u0000-\u001f<>:"|?*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
const cleanType = (s) => (/^[\w.+-]{1,60}\/[\w.+-]{1,80}$/.test(String(s || '')) ? String(s).toLowerCase() : 'application/octet-stream');
const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : undefined; };

export const newFileId = () => 'f' + Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
export const validId = (id) => typeof id === 'string' && /^f[a-z0-9]{10,40}$/.test(id);

/** Starts an upload. Returns [status, body] on bad input. */
export async function createUpload(body, role) {
  const size = Math.floor(Number(body.size));
  if (!Number.isFinite(size) || size <= 0) return [400, { error: 'The file is empty' }];
  if (size > MAX_FILE) return [413, { error: 'Files can be up to ' + MAX_FILE / 1024 / 1024 + ' MB' }];
  const type = cleanType(body.type);
  let kind = KINDS.includes(body.kind) ? body.kind : 'file';
  if (kind === 'image' && (!type.startsWith('image/') || type.includes('svg'))) kind = 'file';
  if (kind === 'audio' && !type.startsWith('audio/') && !type.startsWith('video/webm')) kind = 'file';
  const ext = (type.split('/')[1] || 'bin').replace(/^x-/, '').split(/[;+]/)[0];
  const meta = {
    id: newFileId(),
    kind,
    name: cleanName(body.name) || (kind === 'audio' ? 'Voice note.' + ext : kind === 'image' ? 'Photo.' + ext : 'File'),
    type,
    size,
    parts: Math.ceil(size / PART_SIZE),
    by: role,
    at: Date.now(),
    done: false,
  };
  if (kind === 'audio') {
    meta.duration = num(body.duration, 3600);
    if (typeof body.wave === 'string' && /^[0-9]{1,80}$/.test(body.wave)) meta.wave = body.wave;
  }
  if (kind === 'image') { meta.w = num(body.w, 20000); meta.h = num(body.h, 20000); }
  await store.putFileMeta(meta.id, meta);
  return { id: meta.id, partSize: PART_SIZE, parts: meta.parts };
}

/** Stores part n. Returns [status, body] on bad input. */
export async function putPart(id, n, buf) {
  if (!validId(id)) return [400, { error: 'Bad file id' }];
  const meta = await store.getFileMeta(id);
  if (!meta) return [404, { error: 'Upload not found' }];
  if (!Number.isInteger(n) || n < 0 || n >= meta.parts) return [400, { error: 'Bad part number' }];
  const expected = n === meta.parts - 1 ? meta.size - n * PART_SIZE : PART_SIZE;
  if (buf.length !== expected) return [400, { error: `Part ${n} should be ${expected} bytes, got ${buf.length}` }];
  await store.putFilePart(id, n, buf.toString('base64'));
  if (n === meta.parts - 1) {
    const have = await store.countFileParts(id);
    if (have >= meta.parts && !meta.done) { meta.done = true; await store.putFileMeta(id, meta); }
    return { ok: true, done: have >= meta.parts };
  }
  return { ok: true, done: false };
}

/** What a message stores about each attachment (no internal fields). */
export function publicMeta(m) {
  const a = { id: m.id, kind: m.kind, name: m.name, type: m.type, size: m.size, parts: m.parts };
  if (m.duration) a.duration = Math.round(m.duration * 10) / 10;
  if (m.wave) a.wave = m.wave;
  if (m.w && m.h) { a.w = m.w; a.h = m.h; }
  return a;
}

/** Turns [id, …] from a client into attachment records: { list } or { error: [status, body] }. */
export async function resolveAttachments(list) {
  if (list === undefined || list === null) return { list: [] };
  if (!Array.isArray(list)) return { error: [400, { error: 'attachments must be a list' }] };
  if (list.length > MAX_ATTACHMENTS) return { error: [400, { error: 'Up to ' + MAX_ATTACHMENTS + ' attachments per message' }] };
  const ids = [...new Set(list.map((x) => (x && typeof x === 'object' ? x.id : x)))];
  const out = [];
  for (const id of ids) {
    if (!validId(id)) return { error: [400, { error: 'Bad attachment id' }] };
    const meta = await store.getFileMeta(id);
    if (!meta) return { error: [400, { error: 'Attachment not found' }] };
    if (!meta.done) return { error: [400, { error: 'Attachment “' + meta.name + '” has not finished uploading' }] };
    out.push(publicMeta(meta));
  }
  return { list: out };
}

export function fmtDuration(s) {
  s = Math.max(0, Math.round(Number(s) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
export function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}

/** One attachment in words, e.g. "Voice note (0:12)". */
export function attachmentLabel(a) {
  if (a.kind === 'audio') return 'Voice note' + (a.duration ? ' (' + fmtDuration(a.duration) + ')' : '');
  if (a.kind === 'image') return 'Photo';
  return a.name || 'File';
}

/** Short summary for chat previews and notifications. */
export function summarize(msg) {
  const atts = msg.attachments || [];
  if (!atts.length) return msg.text;
  const images = atts.filter((a) => a.kind === 'image').length;
  let what;
  if (atts.length === 1) what = attachmentLabel(atts[0]);
  else if (images === atts.length) what = images + ' photos';
  else what = atts.length + ' attachments';
  return msg.text ? what + ' · ' + msg.text : what;
}

export async function deleteFiles(ids) {
  for (const id of ids) {
    if (!validId(id)) continue;
    try { await store.deleteFile(id); } catch (err) { console.error('[files] could not delete ' + id + ': ' + (err.message || err)); }
  }
}

/** Reads a raw request body, refusing anything larger than `limit`. */
export async function readRaw(req, limit) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'binary');
  if (req.body instanceof Uint8Array) return Buffer.from(req.body);
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > limit) throw Object.assign(new Error('Part is too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
