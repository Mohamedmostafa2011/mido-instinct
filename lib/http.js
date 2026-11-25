import crypto from 'node:crypto';
import { store } from './store.js';

export const ROLES = ['mido', 'instinct'];
export const other = (role) => (role === 'mido' ? 'instinct' : 'mido');

const DEV_PASSKEY = 'mido-dev';

function config() {
  const passkey = process.env.PASSKEY || process.env.MIDO_PASSKEY || (process.env.VERCEL ? '' : DEV_PASSKEY);
  const appKey = process.env.APP_KEY || process.env.MIDO_APP_KEY || '';
  return { passkey, appKey };
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function cors(res) {
  // Auth travels in headers, never cookies, so a wildcard origin is safe and lets
  // the Windows and Android apps call the API from their bundled pages.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Mido-Key, X-Mido-As');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  if (typeof body === 'string') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(body);
  } else {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }
}

export async function readBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
    if (Buffer.isBuffer(req.body)) { try { return JSON.parse(req.body.toString('utf8')); } catch { return {}; } }
    return req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

export function query(req) {
  return Object.fromEntries(new URL(req.url, 'http://x').searchParams);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves who is calling. Returns { role, via } or null. */
export async function authenticate(req) {
  const { passkey, appKey } = config();
  const q = query(req);
  const key = req.headers['x-mido-key'] || q.key || '';
  const as = String(req.headers['x-mido-as'] || q.as || 'instinct').toLowerCase();

  if (appKey && safeEqual(key, appKey)) return { role: 'mido', via: 'app' };
  if (passkey && safeEqual(key, passkey)) return { role: ROLES.includes(as) ? as : 'instinct', via: 'web' };

  await sleep(600); // slow down guessing
  return null;
}

/**
 * Wraps a route: CORS, preflight, auth, JSON errors.
 * handler(ctx) gets { req, res, role, via, body, q } and returns a body or [status, body].
 */
export function route(methods) {
  return async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    const fn = methods[req.method];
    if (!fn) return send(res, 405, { error: 'Method not allowed' });

    const { passkey } = config();
    if (!passkey) {
      return send(res, 503, { error: 'PASSKEY is not set on the server. Add it in Vercel → Settings → Environment Variables.' });
    }

    const who = await authenticate(req);
    if (!who) return send(res, 401, { error: 'Wrong passkey' });

    try {
      const body = ['POST', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      const out = await fn({ req, res, ...who, body, q: query(req) });
      if (res.writableEnded) return;
      if (Array.isArray(out)) return send(res, out[0], out[1]);
      return send(res, 200, out ?? { ok: true });
    } catch (err) {
      console.error(err);
      return send(res, 500, { error: String(err.message || err) });
    }
  };
}

export const storageKind = () => store.kind;

export function newId(prefix = '') {
  return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

export function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}
