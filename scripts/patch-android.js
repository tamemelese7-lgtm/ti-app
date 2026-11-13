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
if (!m.includes('android.permission.VIBRATE')) {
  m = m.replace('<uses-permission android:name="android.permission.INTERNET" />', '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.VIBRATE" />');
  if (!m.includes('VIBRATE')) m = m.replace('</manifest>', '    <uses-permission android:name="android.permission.VIBRATE" />\n</manifest>');
  fs.writeFileSync(man, m);
}
console.log('Android project patched');
