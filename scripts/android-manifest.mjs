// Adds the permissions the Android app needs on top of Capacitor's template.
//   node scripts/android-manifest.mjs mobile/android/app/src/main/AndroidManifest.xml
// RECORD_AUDIO lets voice notes use the microphone (Capacitor's web view asks the
// user the first time). Picking photos and files needs no permission.
import fs from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: android-manifest.mjs <AndroidManifest.xml>'); process.exit(1); }
let xml = fs.readFileSync(file, 'utf8');
const wanted = ['android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS'];
const missing = wanted.filter((p) => !xml.includes('"' + p + '"'));
if (missing.length) {
  const lines = missing.map((p) => `    <uses-permission android:name="${p}" />`).join('\n');
  xml = xml.replace(/\n?\s*<\/manifest>\s*$/, '\n' + lines + '\n</manifest>\n');
  fs.writeFileSync(file, xml);
}
for (const p of wanted) if (!xml.includes('"' + p + '"')) { console.error('Could not add ' + p); process.exit(1); }
console.log('Android permissions: ' + wanted.join(', '));
