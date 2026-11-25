import { route } from '../lib/http.js';
import { createUpload, putPart, readRaw, PART_SIZE } from '../lib/files.js';

// POST /api/upload            {name, type, size, kind, duration?, wave?, w?, h?} → {id, partSize, parts}
// PUT  /api/upload?id=&n=     body: raw bytes of part n (Content-Type: application/octet-stream)
// Parts must be sent in order; the file is ready once the last part is stored.
export default route({
  POST: ({ role, body }) => createUpload(body || {}, role),
  PUT: async ({ req, q }) => {
    let buf;
    try { buf = await readRaw(req, PART_SIZE + 1024); }
    catch (err) { return [err.status || 400, { error: err.message }]; }
    return putPart(String(q.id || ''), Number(q.n), buf);
  },
});
