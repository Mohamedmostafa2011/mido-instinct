import { route } from '../lib/http.js';
import { store } from '../lib/store.js';
import { validId } from '../lib/files.js';

// GET /api/file?id=ID            the whole file
// GET /api/file?id=ID&n=2        only part 2 (what the apps use, each part stays under Vercel's 4.5 MB limit)
//     &download=1                save instead of showing it in the browser
// Needs the passkey or app key like every other endpoint (X-Mido-Key header or ?key=).
const INLINE = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|audio\/|video\/(mp4|webm|ogg)|application\/pdf$)/;

export default route({
  GET: async ({ res, q }) => {
    const id = String(q.id || '');
    if (!validId(id)) return [400, { error: 'Bad file id' }];
    const meta = await store.getFileMeta(id);
    if (!meta || !meta.done) return [404, { error: 'File not found' }];

    const inline = INLINE.test(meta.type) && !q.download;
    res.statusCode = 200;
    res.setHeader('Content-Type', meta.type);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    // Never let an uploaded file run as a page on this site.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(meta.name));

    if (q.n !== undefined) {
      const n = Number(q.n);
      if (!Number.isInteger(n) || n < 0 || n >= meta.parts) return [400, { error: 'Bad part number' }];
      const b64 = await store.getFilePart(id, n);
      if (b64 == null) return [404, { error: 'Part not found' }];
      const buf = Buffer.from(b64, 'base64');
      res.setHeader('Content-Length', String(buf.length));
      res.end(buf);
      return;
    }

    res.setHeader('Content-Length', String(meta.size));
    let next = store.getFilePart(id, 0);
    for (let n = 0; n < meta.parts; n++) {
      const b64 = await next;
      if (n + 1 < meta.parts) next = store.getFilePart(id, n + 1); // fetch ahead while this part streams out
      if (b64 == null) { res.destroy(new Error('Missing part ' + n)); return; }
      const buf = Buffer.from(b64, 'base64');
      if (!res.write(buf)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  },
});
