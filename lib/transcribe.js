// Voice note transcription (speech to text), done on the server.
//
// Uses any OpenAI-compatible transcription API. Env vars (set on Vercel, never in the repo):
//   GROQ_API_KEY          Groq (free tier, Whisper large v3). Used first when set.
//   OPENAI_API_KEY        OpenAI, used when there is no Groq key.
//   TRANSCRIBE_MODEL      optional model override (default whisper-large-v3 / gpt-4o-mini-transcribe)
//   TRANSCRIBE_LANGUAGE   optional ISO code such as "ar" or "en". Default: detected per note.
//   TRANSCRIBE_API_URL    optional base URL of another OpenAI-compatible API
//
// Without a key, voice notes still work; they just have no transcript.
// The key only ever goes into the Authorization header: it is never logged,
// stored or returned, and error text is scrubbed of it before logging.

import { store } from './store.js';

const TIMEOUT_MS = 40_000; // stays inside the 60 s function limit together with reading the parts
export const MAX_TRANSCRIPT = 20_000;
const PROVIDERS = {
  groq: { url: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
  openai: { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe' },
};

export function sttSettings() {
  const groq = (process.env.GROQ_API_KEY || '').trim();
  const openai = (process.env.OPENAI_API_KEY || '').trim();
  const provider = groq ? 'groq' : openai ? 'openai' : null;
  if (!provider) return { enabled: false };
  const p = PROVIDERS[provider];
  return {
    enabled: true,
    provider,
    key: groq || openai,
    url: (process.env.TRANSCRIBE_API_URL || p.url).trim().replace(/\/$/, ''),
    model: (process.env.TRANSCRIBE_MODEL || p.model).trim(),
    language: (process.env.TRANSCRIBE_LANGUAGE || '').trim().toLowerCase(),
  };
}

// The API picks the decoder from the file name, so give it the right extension.
function fileName(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('ogg') || t.includes('opus')) return 'voice.ogg';
  if (t.includes('mp4') || t.includes('m4a') || t.includes('aac')) return 'voice.m4a';
  if (t.includes('mpeg') || t.includes('mp3')) return 'voice.mp3';
  if (t.includes('wav')) return 'voice.wav';
  if (t.includes('flac')) return 'voice.flac';
  return 'voice.webm';
}

const scrub = (s, key) => {
  let out = String(s || '');
  if (key) out = out.split(key).join('[hidden]');
  return out.replace(/\b(sk|gsk)[-_][A-Za-z0-9_-]{8,}/g, '[hidden]').slice(0, 300);
};

/** Whisper sometimes "hears" words in silence; drop segments it is itself sure are not speech. */
function cleanText(out) {
  if (Array.isArray(out.segments) && out.segments.length) {
    const kept = out.segments.filter((s) => !(Number(s.no_speech_prob) > 0.8 && Number(s.avg_logprob) < -0.5));
    return kept.map((s) => String(s.text || '').trim()).filter(Boolean).join(' ');
  }
  return String(out.text || '');
}

/** Sends audio bytes to the API. Returns the text ('' when no speech). Throws on failure. */
export async function transcribeBuffer(buf, type, s = sttSettings()) {
  if (!s.enabled) throw new Error('No speech-to-text key is set');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: type || 'audio/webm' }), fileName(type));
  form.append('model', s.model);
  form.append('response_format', /^whisper/i.test(s.model) ? 'verbose_json' : 'json');
  form.append('temperature', '0');
  if (s.language) form.append('language', s.language);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(s.url + '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + s.key },
      body: form,
      signal: ctrl.signal,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${s.provider} ${res.status}: ${scrub(out.error?.message || out.message || 'request failed', s.key)}`);
    return cleanText(out).replace(/\s+/g, ' ').trim().slice(0, MAX_TRANSCRIPT);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${s.provider} did not answer within ${TIMEOUT_MS / 1000} s`);
    throw new Error(scrub(err.message || err, s.key));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Transcribes an uploaded voice note and saves the result on its file record:
 *   meta.transcript = text, meta.stt = 'done' | 'empty' (no speech) | 'failed' | 'off' (no key set)
 * Never throws; returns the updated meta.
 */
export async function transcribeFile(meta) {
  if (!meta || meta.kind !== 'audio') return meta;
  const s = sttSettings();
  if (!s.enabled) return { ...meta, stt: 'off' };
  try {
    const parts = [];
    for (let n = 0; n < meta.parts; n++) {
      const b64 = await store.getFilePart(meta.id, n);
      if (!b64) throw new Error('part ' + n + ' is missing');
      parts.push(Buffer.from(b64, 'base64'));
    }
    const text = await transcribeBuffer(Buffer.concat(parts), meta.type, s);
    meta = { ...meta, transcript: text, stt: text ? 'done' : 'empty' };
  } catch (err) {
    console.error(`[stt] could not transcribe voice note ${meta.id}: ${scrub(err.message || err, s.key)}`);
    meta = { ...meta, stt: 'failed' };
    delete meta.transcript;
  }
  try { await store.putFileMeta(meta.id, meta); } catch (err) { console.error('[stt] could not save the transcript of ' + meta.id + ': ' + (err.message || err)); }
  return meta;
}

/** The transcripts of a message's voice notes, joined. */
export function transcriptOf(msg) {
  return (msg.attachments || []).filter((a) => a.kind === 'audio' && a.transcript).map((a) => a.transcript).join(' ');
}
