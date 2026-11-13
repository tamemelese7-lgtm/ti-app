# Ti — a private world for two

```
web/      → the app (Cloudflare Pages serves this folder)
worker/   → the API (Cloudflare Worker + KV). ti-worker.js = one-line copy for the dashboard
assets/   → Android icon + splash
.github/  → builds the Android APK
```

## 1 · Worker (API)
1. Cloudflare → Workers & Pages → Create → Hello World → name `ti-api` → Deploy → Edit code → paste `worker/ti-worker.js` → Deploy.
2. Storage & Databases → KV → Create namespace `TI_KV`.
3. Worker → Settings → Bindings → Add → KV namespace → Variable name `KV` → `TI_KV`.
4. Worker → Settings → Variables and Secrets (type **Secret**):
   - `GEMINI_KEY` — your Gemini API key
   - `ADMIN_PIN` — 6+ digits, your secret admin PIN
   - `SECRET` — any long random text
   - `TG_TOKEN` — (optional) Telegram bot token from @BotFather
5. Open `https://ti-api.<you>.workers.dev` → must show `{"ok":true,"app":"Ti"}`.

## 2 · Web app (Pages)
Workers & Pages → Create → Pages → Connect to Git → `ti-app` → Build command: *(empty)* → Output directory: `web` → Deploy.
If your Worker address is not `https://ti-api.tamemele6.workers.dev`, edit `web/config.js`.

## 3 · Android APK
Repo → Settings → Secrets and variables → Actions → **Variables** → `TI_APP_URL` = your Pages address.
Actions → **Build Ti for Android** → Run workflow → Releases → download `Ti-buildN.apk`.
The first run creates the signing key in `signing/` — keep this repository **private**; every later APK updates the installed app.
The APK opens your Pages site, so web changes reach both phones without a new APK.

## Admin
Long-press the Ti logo 2.5 s (or tap it 5 times) → PIN.
