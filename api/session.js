import { route, storageKind } from '../lib/http.js';
import { sttSettings } from '../lib/transcribe.js';
import { registerDevice, pushTo, pushConfigured } from '../lib/push.js';
import { background } from '../lib/chat.js';

// GET  /api/session — checks the key and tells the client who it is.
// POST /api/session {pushToken, platform, enabled?}  registers this phone for push notifications
//                   (enabled: false removes it, e.g. when notifications are turned off)
// POST /api/session {pushTest: true}  sends a test notification to your phones in 8 seconds,
//                   time enough to close the app and see it arrive.
export default route({
  GET: ({ role, via }) => ({ ok: true, role, via, storage: storageKind(), stt: sttSettings().enabled, push: pushConfigured(), now: Date.now() }),
  POST: async ({ role, body }) => {
    if (body.pushTest === true) {
      if (!pushConfigured()) return [409, { error: 'Push is not set up on the server' }];
      const job = new Promise((r) => setTimeout(r, 8000)).then(() => pushTo(role, { title: 'Instinct', body: 'Notifications work, even with the app closed.', kind: 'test' }));
      const pending = background(job);
      if (pending) pending.catch(() => {}); // local dev: don't hold the request for 8 s
      return { ok: true, in: 8 };
    }
    if (body.pushToken !== undefined) return registerDevice(role, { token: body.pushToken, platform: body.platform, enabled: body.enabled });
    return [400, { error: 'Nothing to do' }];
  },
});
