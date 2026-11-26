// Copies the website into an app folder and writes its config.js.
//   node scripts/build-app-web.mjs <outDir> <platform>
// Env: MIDO_API_BASE  (default https://mido-instinct.vercel.app)
//      MIDO_APP_KEY   (must match APP_KEY on Vercel; lets the app skip the passkey)
//      MIDO_PUSH=1    (Android only: built with google-services.json, so push notifications can register)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [outArg, platform = 'windows'] = process.argv.slice(2);
if (!outArg) { console.error('usage: build-app-web.mjs <outDir> <platform>'); process.exit(1); }
const out = path.resolve(process.cwd(), outArg);

const apiBase = (process.env.MIDO_API_BASE || 'https://mido-instinct.vercel.app').replace(/\/$/, '');
const appKey = process.env.MIDO_APP_KEY || '';
if (!appKey) console.warn('! MIDO_APP_KEY is empty: the app will ask for the passkey like the website does.');
const push = platform === 'android' && process.env.MIDO_PUSH === '1';
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, 'assets'), path.join(out, 'assets'), { recursive: true });
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
html = html.replace(/\s*<link rel="manifest"[^>]*>/, '');
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(
  path.join(out, 'config.js'),
  'window.MIDO_CONFIG = ' + JSON.stringify({ apiBase, appKey, platform, version, push }, null, 2) + ';\n'
);
console.log(`App web files → ${out}  (platform ${platform}, api ${apiBase}, key ${appKey ? 'set' : 'missing'}${push ? ', push on' : ''})`);
