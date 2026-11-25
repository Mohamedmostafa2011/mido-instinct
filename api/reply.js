import crypto from 'node:crypto';
import { send, readBody } from '../lib/http.js';
import { postMessage } from '../lib/chat.js';

// POST /api/reply   header  x-api-key: <REPLY_API_KEY>
//                   body    {"chatId": "...", "text": "..."}
//
// Lets Instinct answer without a browser: the text is saved as a message from
// Instinct in that chat, which clears its "Needs reply" status (the status is
// derived from who sent the last message). Returns {"ok": true}.
//
// The key lives only in the REPLY_API_KEY environment variable on Vercel. It is
// never logged; requests without a correct key get 401.

function keyMatches(given, expected) {
  if (!given || !expected) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { ok: false, error: 'Use POST' });
  }

  const expected = process.env.REPLY_API_KEY || '';
  const given = req.headers['x-api-key'];
  if (!keyMatches(given, expected)) {
    if (!expected) console.error('[reply] rejected a request: REPLY_API_KEY is not set on the server');
    await sleep(600); // slow down guessing
    return send(res, 401, { ok: false, error: 'Missing or wrong x-api-key' });
  }

  try {
    const body = await readBody(req);
    const chatId = typeof body?.chatId === 'string' ? body.chatId.trim() : '';
    const text = typeof body?.text === 'string' ? body.text : '';
    if (!chatId) return send(res, 400, { ok: false, error: 'chatId is required' });
    if (!text.trim()) return send(res, 400, { ok: false, error: 'text is required' });

    const out = await postMessage({ role: 'instinct', chatId, text });
    if (Array.isArray(out)) return send(res, out[0], { ok: false, error: out[1].error });
    return send(res, 200, { ok: true });
  } catch (err) {
    console.error('[reply] could not save the reply: ' + (err?.message || err));
    return send(res, 500, { ok: false, error: 'Could not save the reply' });
  }
}
