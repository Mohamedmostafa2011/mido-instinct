import { route } from '../lib/http.js';
import { store } from '../lib/store.js';
import { emailNewMessage, emailSettings } from '../lib/email.js';

// GET or POST /api/email-test (passkey required) sends one sample "needs reply"
// email through the same code that handles real messages, and reports the
// sender address. Limited to one test per minute.
async function test() {
  const s = emailSettings();
  if (!s.enabled) return [503, { error: s.key ? 'NOTIFY_EMAIL_TO is not set on Vercel' : 'RESEND_API_KEY is not set on Vercel', from: s.from }];
  const minute = Math.floor(Date.now() / 60_000);
  if (!(await store.claim('email-test:' + minute))) return [429, { error: 'One test per minute. Try again shortly.' }];

  const now = Date.now();
  const chat = { id: 'test', title: 'Test chat' };
  const msg = {
    id: 'test' + now.toString(36),
    from: 'mido',
    at: now,
    text: 'This is a test of the Mido email alert.\nReal alerts arrive the moment Mido sends a message that needs a reply from Instinct.',
  };
  const out = await emailNewMessage(chat, msg);
  if (out.error) return [502, { error: out.error, from: s.from }];
  return { ok: true, from: s.from, to: s.to, id: out.id };
}

export default route({ GET: test, POST: test });
