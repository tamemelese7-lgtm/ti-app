// Adds release signing, version code and the vibration permission to the generated Android project.
const fs = require('fs');
const gradle = 'android/app/build.gradle';
let g = fs.readFileSync(gradle, 'utf8');
if (!g.includes('TI_KEYSTORE')) {
  g = g.replace(/android\s*\{/, `android {
    signingConfigs {
        release {
            if (System.getenv("TI_KEYSTORE")) {
                storeFile file(System.getenv("TI_KEYSTORE"))
                storePassword System.getenv("TI_KEYSTORE_PASSWORD")
                keyAlias System.getenv("TI_KEY_ALIAS")
                keyPassword System.getenv("TI_KEYSTORE_PASSWORD")
            }
        }
    }`);
  g = g.replace(/buildTypes\s*\{\s*release\s*\{/, m => m + `
            if (System.getenv("TI_KEYSTORE")) { signingConfig signingConfigs.release }`);
  g = g.replace(/versionCode\s+\d+/, 'versionCode Integer.parseInt(System.getenv("TI_VERSION_CODE") ?: "1")');
  if (!g.includes('signingConfigs.release') || !g.includes('TI_VERSION_CODE')) { console.error('build.gradle patch failed'); process.exit(1); }
  fs.writeFileSync(gradle, g);
}
const man = 'android/app/src/main/AndroidManifest.xml';
let m = fs.readFileSync(man, 'utf8');
// Vibration, and the microphone for voice messages.
for (const perm of ['VIBRATE', 'RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS']) {
  if (!m.includes('android.permission.' + perm)) m = m.replace('</manifest>', `    <uses-permission android:name="android.permission.${perm}" />\n</manifest>`);
}
// Keep the chat box above the keyboard.
if (!m.includes('windowSoftInputMode')) m = m.replace(/<activity(\s)/, '<activity android:windowSoftInputMode="adjustResize"$1');
fs.writeFileSync(man, m);
if (!/RECORD_AUDIO/.test(m) || !/windowSoftInputMode/.test(m)) { console.error('manifest patch failed'); process.exit(1); }
console.log('Android project patched');
