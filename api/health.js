import { route } from '../lib/http.js';
import { store } from '../lib/store.js';
import { postMessage, messagesWithIndex } from '../lib/chat.js';
import { createUpload, putPart, resolveAttachments, deleteFiles } from '../lib/files.js';
import { sttSettings, transcribeBuffer } from '../lib/transcribe.js';

// One second of silent 16 kHz mono WAV, to check the speech-to-text key without real audio.
function silentWav() {
  const n = 16000, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

// GET /api/health?key=PASSKEY: end-to-end storage check. Creates a temporary
// chat, saves two messages through the normal code path, reads them back and
// deletes the chat again, then does the same with a small file. Messages are posted as Instinct, so no email goes out.
// Also says whether voice notes get transcribed; add &stt=1 to test the speech-to-text key with a second of silence.
export default route({
  GET: async ({ q }) => {
    const steps = [];
    const t0 = Date.now();
    let chatId = null;
    try {
      const first = await postMessage({ role: 'instinct', chatId: null, text: 'Health check 1' });
      if (Array.isArray(first)) throw new Error('post failed: ' + first[1].error);
      chatId = first.chat.id;
      steps.push('created chat and saved message 1');
      const second = await postMessage({ role: 'instinct', chatId, text: 'Health check 2' });
      if (Array.isArray(second)) throw new Error('post failed: ' + second[1].error);
      steps.push('saved message 2');
      const msgs = await messagesWithIndex(chatId, 0);
      if (msgs.length !== 2 || msgs[1].text !== 'Health check 2') throw new Error('read back ' + msgs.length + ' messages');
      steps.push('read both messages back');
      const bytes = Buffer.from('Mido health check file ' + t0);
      const up = await createUpload({ name: 'health.txt', type: 'text/plain', size: bytes.length, kind: 'file' }, 'instinct');
      if (Array.isArray(up)) throw new Error('upload: ' + up[1].error);
      const put = await putPart(up.id, 0, bytes);
      if (Array.isArray(put) || !put.done) throw new Error('upload part failed');
      const att = await resolveAttachments([up.id]);
      if (att.error) throw new Error('attach: ' + att.error[1].error);
      const back = Buffer.from((await store.getFilePart(up.id, 0)) || '', 'base64');
      await deleteFiles([up.id]);
      if (!back.equals(bytes)) throw new Error('file read back differently');
      steps.push('stored, read back and deleted a file');
      await store.deleteChat(chatId);
      chatId = null;
      steps.push('deleted the test chat');
      const s = sttSettings();
      let transcription = s.enabled ? `on (${s.provider}, ${s.model})` : 'off: set GROQ_API_KEY or OPENAI_API_KEY on Vercel';
      if (s.enabled && q.stt === '1') {
        try { await transcribeBuffer(silentWav(), 'audio/wav', s); transcription += ', key works'; }
        catch (err) { return { ok: false, storage: store.kind, transcription, error: 'speech-to-text test failed: ' + err.message, steps }; }
      }
      return { ok: true, storage: store.kind, transcription, ms: Date.now() - t0, steps };
    } catch (err) {
      if (chatId) await store.deleteChat(chatId).catch(() => {});
      return { ok: false, storage: store.kind, error: String(err.message || err), steps };
    }
  },
});
