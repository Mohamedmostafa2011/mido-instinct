// POST /api/provision — hands the build settings to this repo's GitHub Actions workflow.
//
// The workflow sends a GitHub OIDC token (no stored secret needed). We check its
// signature against GitHub's public keys and that it was minted for this repository's
// apps workflow on a push or manual run, then return the app key (and the Android
// signing keystore and Firebase app config for push notifications, if set). Anything else gets 403.
import crypto from 'node:crypto';
import { cors, send } from '../lib/http.js';

const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'mido-instinct';
const REPO = (process.env.GITHUB_REPOSITORY || 'Mohamedmostafa2011/mido-instinct').toLowerCase();
const WORKFLOW = '.github/workflows/apps.yml';

let jwksCache = { at: 0, keys: [] };
async function jwks() {
  if (Date.now() - jwksCache.at < 10 * 60_000 && jwksCache.keys.length) return jwksCache.keys;
  const res = await fetch(ISSUER + '/.well-known/jwks');
  if (!res.ok) throw new Error('Could not load GitHub keys');
  jwksCache = { at: Date.now(), keys: (await res.json()).keys || [] };
  return jwksCache.keys;
}

const b64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function verify(token) {
  const [h, p, sig] = String(token).split('.');
  if (!h || !p || !sig) throw new Error('Malformed token');
  const header = JSON.parse(b64url(h).toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('Unexpected algorithm');
  const jwk = (await jwks()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown signing key');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), key, b64url(sig));
  if (!ok) throw new Error('Bad signature');
  const c = JSON.parse(b64url(p).toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (c.iss !== ISSUER) throw new Error('Wrong issuer');
  if (c.aud !== AUDIENCE && !(Array.isArray(c.aud) && c.aud.includes(AUDIENCE))) throw new Error('Wrong audience');
  if (!c.exp || c.exp < now - 30 || (c.nbf && c.nbf > now + 30)) throw new Error('Expired token');
  if (String(c.repository || '').toLowerCase() !== REPO) throw new Error('Wrong repository');
  if (!['push', 'workflow_dispatch'].includes(c.event_name)) throw new Error('Wrong event');
  if (!String(c.workflow_ref || '').toLowerCase().startsWith(REPO + '/' + WORKFLOW + '@')) throw new Error('Wrong workflow');
  return c;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  try {
    const claims = await verify(token);
    const appKey = process.env.APP_KEY || process.env.MIDO_APP_KEY || '';
    if (!appKey) return send(res, 503, { error: 'APP_KEY is not set on Vercel' });
    console.log('provisioned build', claims.run_id, claims.ref);
    return send(res, 200, {
      appKey,
      androidKeystore: process.env.ANDROID_KEYSTORE_B64 || '',
      androidKeystorePassword: process.env.ANDROID_KEYSTORE_PASSWORD || '',
      // google-services.json of the Android app registered in Firebase (raw JSON or base64)
      googleServices: process.env.GOOGLE_SERVICES_JSON || '',
    });
  } catch (err) {
    await new Promise((r) => setTimeout(r, 400));
    return send(res, 403, { error: 'Not allowed: ' + err.message });
  }
}
