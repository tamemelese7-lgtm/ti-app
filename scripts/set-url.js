// If the GitHub variable TI_APP_URL is set (your Cloudflare Pages address), the app opens that site,
// so every web update reaches the phone without a new APK. Otherwise the files in /web are bundled.
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('capacitor.config.json', 'utf8'));
const url = (process.env.TI_APP_URL || '').trim().replace(/\/+$/, '');
if (url) {
  if (!/^https:\/\//.test(url)) { console.error('TI_APP_URL must start with https://'); process.exit(1); }
  cfg.server = { url, cleartext: false, androidScheme: 'https' };
  console.log('App will load', url);
} else {
  delete cfg.server;
  console.log('TI_APP_URL not set: bundling /web inside the APK');
}
fs.writeFileSync('capacitor.config.json', JSON.stringify(cfg, null, 2));
