import { route, storageKind } from '../lib/http.js';

// GET /api/session — checks the key and tells the client who it is.
export default route({
  GET: ({ role, via }) => ({ ok: true, role, via, storage: storageKind(), now: Date.now() }),
});
