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
// Push notifications: the Firebase config of the Android app (google-services.json)
const gs = String(body.googleServices || '').trim();
if (gs) {
  try {
    const json = JSON.parse(gs.startsWith('{') ? gs : Buffer.from(gs, 'base64').toString('utf8'));
    const pkg = 'com.mido.instinct';
    const ok = (json.client || []).some((c) => c.client_info?.android_client_info?.package_name === pkg);
    if (!ok) throw new Error('it has no Android app with the package name ' + pkg);
    const file = (RUNNER_TEMP || '.') + '/google-services.json';
    fs.writeFileSync(file, JSON.stringify(json));
    out.push('GOOGLE_SERVICES_FILE=' + file, 'MIDO_PUSH=1');
    console.log('Push notifications: on (Firebase project ' + (json.project_info?.project_id || '?') + ')');
  } catch (err) {
    console.log('::warning title=Push notifications off::GOOGLE_SERVICES_JSON on Vercel is not usable: ' + err.message);
  }
} else {
  console.log('::notice title=Push notifications off::Add GOOGLE_SERVICES_JSON on Vercel to get notifications while the Android app is closed.');
}
fs.appendFileSync(GITHUB_ENV, out.join('\n') + '\n');
console.log('Build settings loaded from ' + apiBase);
