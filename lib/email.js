// Email alert for every new message that leaves a chat waiting on Instinct
// ("Needs reply"), sent through Resend (https://resend.com).
//
// Env vars (set on Vercel, never in the repo):
//   RESEND_API_KEY     Resend API key. Without it, no email is sent.
//   NOTIFY_EMAIL_TO    recipient, comma-separate several
//   NOTIFY_EMAIL_FROM  optional sender, default "Mido <onboarding@resend.dev>".
//                      Resend's shared onboarding address can only deliver to the
//                      email the Resend account was created with. Verify your own
//                      domain in Resend to send from it and to anyone.
//   SITE_URL           optional, base of the chat link (default https://miduinvesting.vercel.app)
//   NOTIFY_TIMEZONE    optional, time zone for the timestamp (default Africa/Cairo)
//
// Each message is claimed in storage before sending and the message id doubles
// as Resend's idempotency key, so a message never produces a second email.

import { store } from './store.js';

const NAMES = { mido: 'Mido', instinct: 'Instinct' };
const SEND_TIMEOUT_MS = 8000;

export const DEFAULT_FROM = 'Mido <onboarding@resend.dev>';
export const SUBJECT = '[Mido] New message needs reply';

export function emailSettings() {
  const key = (process.env.RESEND_API_KEY || '').trim();
  const to = (process.env.NOTIFY_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    enabled: !!(key && to.length),
    key,
    to,
    from: (process.env.NOTIFY_EMAIL_FROM || '').trim() || DEFAULT_FROM,
    site: (process.env.SITE_URL || 'https://miduinvesting.vercel.app').trim().replace(/\/$/, ''),
    tz: (process.env.NOTIFY_TIMEZONE || 'Africa/Cairo').trim(),
    api: (process.env.RESEND_API_URL || 'https://api.resend.com').replace(/\/$/, ''),
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function formatTime(at, tz) {
  const d = new Date(at);
  try {
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(d);
    const zone = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || tz;
    return `${local} (${zone})`;
  } catch {
    return d.toUTCString();
  }
}

/** Builds the email. Contains no passkey or other secret: the link only names the chat. */
export function buildEmail(chat, msg, s = emailSettings()) {
  const link = `${s.site}/?chat=${encodeURIComponent(chat.id)}`;
  const sender = NAMES[msg.from] || msg.from;
  const when = formatTime(msg.at, s.tz);
  const title = chat.title || 'New chat';

  const text = [
    `Chat: ${title}`,
    `From: ${sender}`,
    `Time: ${when}`,
    '',
    msg.text,
    '',
    `Open the chat: ${link}`,
  ].join('\n');

  const row = (k, v) => `<tr><td style="padding:2px 16px 2px 0;color:#86827c;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:2px 0;color:#1c1b19">${v}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f1efec;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1b19">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:24px 24px 20px;border:1px solid #e4e1dc">
<p style="margin:0 0 4px;font-size:13px;color:#86827c">New message needs reply</p>
<h1 style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:22px;line-height:1.3">${esc(title)}</h1>
<table style="border-collapse:collapse;font-size:14px;margin:0 0 16px">${row('From', esc(sender))}${row('Time', esc(when))}</table>
<div style="background:#efede9;border-radius:14px;padding:12px 14px;font-size:15px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word" dir="auto">${esc(msg.text)}</div>
<p style="margin:20px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#1c1b19;color:#ffffff;text-decoration:none;border-radius:999px;padding:10px 18px;font-size:14px">Open the chat</a></p>
<p style="margin:12px 0 0;font-size:12px;color:#86827c;word-break:break-all">${esc(link)}</p>
</div></body></html>`;

  return { from: s.from, to: s.to, subject: SUBJECT, text, html };
}

async function sendViaResend(email, idempotencyKey, s) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(s.api + '/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + s.key, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(email),
      signal: ctrl.signal,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Resend ${res.status}: ${out.message || out.name || 'request failed'}`);
    return out.id || null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends the "needs reply" email for a newly saved message. Never throws: a
 * failure is logged and the chat keeps working.
 * Returns { sent, id } | { skipped: reason } | { error }.
 */
export async function emailNewMessage(chat, msg) {
  const s = emailSettings();
  // A message from Mido is what leaves a chat waiting on Instinct.
  if (msg.from !== 'mido') return { skipped: 'not waiting on Instinct' };
  if (!s.enabled) return { skipped: s.key ? 'NOTIFY_EMAIL_TO is not set' : 'RESEND_API_KEY is not set' };
  try {
    if (!(await store.claim('email:' + msg.id))) return { skipped: 'already notified' };
  } catch (err) {
    console.error('[email] could not record the notification, sending anyway:', err.message || err);
  }
  try {
    const email = buildEmail(chat, msg, s);
    const id = await sendViaResend(email, 'mido-msg-' + msg.id, s);
    return { sent: true, id, from: s.from };
  } catch (err) {
    const error = err.name === 'AbortError' ? 'Resend did not answer in time' : String(err.message || err);
    console.error(`[email] sending failed for message ${msg.id} in chat ${chat.id}: ${error}`);
    return { error, from: s.from };
  }
}
