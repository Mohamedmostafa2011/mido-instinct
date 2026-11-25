// Runs inside GitHub Actions. Swaps the workflow's OIDC token for the app build
// settings held on Vercel (see api/provision.js) and exports them to later steps.
import fs from 'node:fs';

const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: reqToken, GITHUB_ENV, RUNNER_TEMP } = process.env;
const apiBase = (process.env.MIDO_API_BASE || 'https://mido-instinct.vercel.app').replace(/\/$/, '');

if (process.env.MIDO_APP_KEY) { console.log('MIDO_APP_KEY already provided as a secret'); process.exit(0); }
if (!url || !reqToken) { console.error('No OIDC token available. Add "id-token: write" to the workflow permissions.'); process.exit(1); }

const idRes = await fetch(url + '&audience=mido-instinct', { headers: { Authorization: 'bearer ' + reqToken } });
if (!idRes.ok) { console.error('OIDC request failed', idRes.status); process.exit(1); }
const { value: idToken } = await idRes.json();

const res = await fetch(apiBase + '/api/provision', { method: 'POST', headers: { Authorization: 'Bearer ' + idToken } });
const body = await res.json().catch(() => ({}));
if (!res.ok) { console.error('Provisioning failed:', res.status, body.error || ''); process.exit(1); }

const out = [];
console.log('::add-mask::' + body.appKey);
out.push('MIDO_APP_KEY=' + body.appKey);
if (body.androidKeystore) {
  const file = (RUNNER_TEMP || '.') + '/instinct.p12';
  fs.writeFileSync(file, Buffer.from(body.androidKeystore, 'base64'));
  console.log('::add-mask::' + body.androidKeystorePassword);
  out.push('ANDROID_KEYSTORE_FILE=' + file, 'ANDROID_KEYSTORE_PASSWORD=' + body.androidKeystorePassword);
}
fs.appendFileSync(GITHUB_ENV, out.join('\n') + '\n');
console.log('Build settings loaded from ' + apiBase);
