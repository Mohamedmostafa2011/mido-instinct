// Adds what the Android app needs on top of Capacitor's template.
//   node scripts/android-manifest.mjs mobile/android/app/src/main/AndroidManifest.xml
// - RECORD_AUDIO lets voice notes use the microphone (the web view asks the user the
//   first time). Picking photos and files needs no permission.
// - POST_NOTIFICATIONS (Android 13+) and the defaults for push notifications: the
//   white stick-figure status bar icon, the accent color and the "Messages" channel.
// - Copies mobile/res (notification icon, colors) into the app's resources.
// Safe to run twice.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = process.argv[2];
if (!file) { console.error('usage: android-manifest.mjs <AndroidManifest.xml>'); process.exit(1); }
let xml = fs.readFileSync(file, 'utf8');

const wanted = ['android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS', 'android.permission.POST_NOTIFICATIONS'];
const missing = wanted.filter((p) => !xml.includes('"' + p + '"'));
if (missing.length) {
  const lines = missing.map((p) => `    <uses-permission android:name="${p}" />`).join('\n');
  xml = xml.replace(/\n?\s*<\/manifest>\s*$/, '\n' + lines + '\n</manifest>\n');
}

const meta = {
  'com.google.firebase.messaging.default_notification_icon': 'android:resource="@drawable/ic_stat_mido"',
  'com.google.firebase.messaging.default_notification_color': 'android:resource="@color/mido_accent"',
  'com.google.firebase.messaging.default_notification_channel_id': 'android:value="messages"',
};
const add = Object.entries(meta).filter(([name]) => !xml.includes('"' + name + '"'))
  .map(([name, v]) => `        <meta-data android:name="${name}" ${v} />`).join('\n');
if (add) xml = xml.replace(/\n(\s*)<\/application>/, '\n' + add + '\n$1</application>');
fs.writeFileSync(file, xml);

for (const p of wanted) if (!xml.includes('"' + p + '"')) { console.error('Could not add ' + p); process.exit(1); }
for (const name of Object.keys(meta)) if (!xml.includes('"' + name + '"')) { console.error('Could not add ' + name); process.exit(1); }

const res = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile', 'res');
fs.cpSync(res, path.join(path.dirname(file), 'res'), { recursive: true });
console.log('Android permissions: ' + wanted.join(', ') + '; notification icon and channel set');
