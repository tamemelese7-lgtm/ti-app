// Ti — private couple app API (Cloudflare Worker + KV)
// Bindings: KV namespace -> KV
// Variables/Secrets: GEMINI_KEY, ADMIN_PIN, SECRET, TG_TOKEN (optional), TG_CHAT (optional), GEMINI_MODEL (optional)

const TZ_OFFSET = 2 * 3600e3; // South Africa (UTC+2)
const MODELS = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'];
const CATS = ['Money', 'Loyalty', 'Future', 'Family'];
const MAX_IMG = 3_000_000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Title,Range',
  'Access-Control-Expose-Headers': 'Content-Range,Accept-Ranges,Content-Length',
  'Access-Control-Max-Age': '86400'
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json', ...CORS } });
const err = (m, s = 400) => json({ error: m }, s);
const now = () => Date.now();
const dayKey = (t = now()) => new Date(t + TZ_OFFSET).toISOString().slice(0, 10);
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const clean = (s, n = 2000) => String(s ?? '').trim().slice(0, n);

async function kget(env, k, d) { const v = await env.KV.get(k, 'json'); return v ?? d; }
async function kput(env, k, v) { await env.KV.put(k, JSON.stringify(v)); }

/* ---------------- crypto / auth ---------------- */
async function hmac(env, msg) {
  const secret = env.SECRET || ('ti-' + (env.ADMIN_PIN || 'x'));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32);
}
async function makeToken(env, role, id, dev) { return `${role}.${id}.${dev}.${await hmac(env, `${role}.${id}.${dev}`)}`; }

async function auth(req, env) {
  const url = new URL(req.url);
  const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('t') || '';
  const p = tok.split('.');
  if (p.length !== 4) return null;
  const [role, id, dev, sig] = p;
  if (sig !== await hmac(env, `${role}.${id}.${dev}`)) return null;
  if (role === 'a') {
    const a = await kget(env, 'admin', { devices: [] });
    if (!a.devices.some(d => d.id === dev)) return null;
    return { role: 'admin', id: 'admin', dev };
  }
  if (role === 'm') {
    const users = await kget(env, 'users', []);
    const u = users.find(x => x.id === id);
    if (!u || u.deviceId !== dev) return null;
    return { role: 'member', id, dev, user: u };
  }
  return null;
}

/* ---------------- Telegram ---------------- */
async function tgChat(env) { return env.TG_CHAT || await env.KV.get('tgchat'); }
async function tg(env, text, buttons) {
  if (!env.TG_TOKEN) return;
  const chat = await tgChat(env); if (!chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', reply_markup: buttons ? { inline_keyboard: [buttons] } : undefined })
    });
  } catch (e) { }
}
const h = s => String(s ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
async function tgSecret(env) { return (await hmac(env, 'tg-webhook')).replace(/[^A-Za-z0-9]/g, ''); }

/* ---------------- Gemini ---------------- */
async function gem(env, prompt, wantJson = true) {
  if (!env.GEMINI_KEY) throw new Error('GEMINI_KEY missing');
  const models = [env.GEMINI_MODEL, ...MODELS].filter((m, i, a) => m && a.indexOf(m) === i);
  let last = '';
  for (const m of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_KEY}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: wantJson ? { responseMimeType: 'application/json' } : {} })
      });
      if (r.ok) {
        const d = await r.json();
        const t = (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
        if (!wantJson) return t;
        try { return JSON.parse(t.replace(/^```json\s*|```$/g, '')); } catch (e) { last = 'bad json'; continue; }
      }
      last = `${m} ${r.status}`;
      if (r.status === 404 || r.status === 400) break;
      await new Promise(res => setTimeout(res, 700 * (attempt + 1)));
    }
  }
  throw new Error('Gemini failed: ' + last);
}

async function genQuestions(env, n) {
  const qs = await kget(env, 'qs', []);
  const recent = qs.slice(-40).map(q => '- ' + q.en).join('\n');
  const prompt = `You help a man (Ethiopian, speaks Amharic) understand how sincere his Zulu girlfriend's love is — whether she loves him for himself or mainly for money/material benefit, and how loyal and committed she is.
Write ${n} NEW questions he can ask her. Rules:
- INDIRECT: never ask "do you love me for money". Use scenarios about friends, hypotheticals, choices, dreams, values, so her real attitude shows naturally.
- Warm, natural, never accusing. One sentence each.
- Spread across categories: ${CATS.join(', ')}.
- Do not repeat or closely resemble these earlier questions:\n${recent || '(none)'}
Return JSON array of objects: {"cat": one of ${JSON.stringify(CATS)}, "am": question in natural Amharic, "zu": the same question in natural isiZulu addressed to her, "en": English, "why_am": one short Amharic sentence telling him what her answer reveals}.`;
  const arr = await gem(env, prompt);
  return (Array.isArray(arr) ? arr : arr.questions || []).slice(0, n).map(q => ({
    id: uid(), cat: CATS.includes(q.cat) ? q.cat : 'Loyalty', am: clean(q.am, 500), zu: clean(q.zu, 500), en: clean(q.en, 500), why: clean(q.why_am, 300),
    status: 'draft', createdAt: now()
  })).filter(q => q.am && q.zu);
}

async function scoreAnswer(env, q) {
  const prompt = `A man asked his girlfriend this indirect question (category: ${q.cat}) to understand whether her love is sincere (him-centred, loyal, committed) or mainly material/self-interested.
Question (English): ${q.en}
Her answer (isiZulu or other): ${q.ansZu}
Tasks: translate her answer faithfully into Amharic and English, then rate 0-100 how much THIS answer suggests sincere, committed, non-materialistic love (100 = clearly sincere; 50 = neutral/unclear; low = materialistic, self-centred, evasive). One answer is weak evidence — stay near 50 unless the answer is clear.
Return JSON: {"am": "...", "en": "...", "score": number, "why_am": "one short Amharic sentence explaining the score"}`;
  const r = await gem(env, prompt);
  return { ansAm: clean(r.am, 2000), ansEn: clean(r.en, 2000), score: Math.max(0, Math.min(100, Math.round(+r.score || 50))), scoreWhy: clean(r.why_am, 400) };
}

async function translate(env, text, to) {
  const lang = to === 'zu' ? 'isiZulu' : 'Amharic';
  const r = await gem(env, `Translate this chat message between romantic partners into natural, warm ${lang}. Keep emojis. If it is already ${lang}, return it unchanged.\nMessage: ${text}\nReturn JSON: {"t": "translation"}`);
  return clean(r.t, 4000);
}

/* ---------------- domain helpers ---------------- */
async function getCfg(env) { return { dailyCount: 10, qMode: 'manual', meName: 'Tame', ...(await kget(env, 'cfg', {})) }; }
function answeredOn(qs, day) { return qs.filter(q => q.status === 'answered' && dayKey(q.answeredAt) === day); }

async function saveImg(env, dataUrl) {
  if (typeof dataUrl !== 'string' || !/^data:image\/(jpeg|png|webp|gif);base64,/.test(dataUrl)) throw new Error('bad image');
  if (dataUrl.length > MAX_IMG) throw new Error('image too large');
  const key = 'img:' + uid();
  await env.KV.put(key, dataUrl);
  return key.slice(4);
}

function giftStatus(gift, qs) {
  if (!gift || !gift.id) return { state: 'none' };
  const answersSince = qs.filter(q => q.status === 'answered' && q.answeredAt >= gift.createdAt).length;
  const need = Math.max(0, (gift.needAnswers || 0) - answersSince);
  const base = { id: gift.id, msg: gift.msg, unlockAt: gift.unlockAt, needLeft: need, mode: gift.mode, createdAt: gift.createdAt };
  if (gift.openedAt) return { ...base, state: 'opened', img: gift.img, openedAt: gift.openedAt };
  if (now() < gift.unlockAt || need > 0) return { ...base, state: 'locked' };
  return { ...base, state: 'ready', img: gift.img };
}

async function maybeAutoGenerate(env, cfg, qs) {
  if (cfg.qMode !== 'auto') return qs;
  if (qs.some(q => q.status === 'approved')) return qs;
  const lock = await env.KV.get('genlock');
  if (lock && now() - +lock < 60e3) return qs;
  await env.KV.put('genlock', String(now()), { expirationTtl: 120 });
  try {
    const fresh = (await genQuestions(env, 5)).map(q => ({ ...q, status: 'approved', approvedAt: now() }));
    const all = [...(await kget(env, 'qs', [])), ...fresh].slice(-600);
    await kput(env, 'qs', all);
    return all;
  } catch (e) { return qs; }
}

async function memberState(env, me) {
  const [cfg, users, gift, reveal, song, events, prof] = await Promise.all([
    getCfg(env), kget(env, 'users', []), kget(env, 'gift', {}), kget(env, 'reveal', {}), kget(env, 'song', {}), kget(env, 'events', []), kget(env, 'profiles', {})
  ]);
  let qs = await kget(env, 'qs', []);
  const today = answeredOn(qs, dayKey()).length;
  let q = null;
  if (today < cfg.dailyCount) {
    qs = await maybeAutoGenerate(env, cfg, qs);
    q = qs.find(x => x.status === 'approved') || null;
    if (q && !q.seenAt) { q.seenAt = now(); await kput(env, 'qs', qs); }
  }
  return {
    role: 'member', status: 'approved',
    me: { name: me.user.name, photo: prof.her || null },
    partner: { name: cfg.meName, photo: prof.me || null },
    since: me.user.approvedAt || me.user.date,
    today: { answered: today, total: cfg.dailyCount },
    question: q ? { id: q.id, zu: q.zu } : null,
    reveal: { img: reveal.img || null },
    gift: giftStatus(gift, qs),
    song,
    ping: events.filter(e => e.to === 'her').slice(-1)[0] || null,
    listen: await kget(env, 'listen', null), now: now()
  };
}

async function adminState(env) {
  const [cfg, users, gift, reveal, song, prof, analysis, admin] = await Promise.all([
    getCfg(env), kget(env, 'users', []), kget(env, 'gift', {}), kget(env, 'reveal', {}), kget(env, 'song', {}), kget(env, 'profiles', {}), kget(env, 'analysis', {}), kget(env, 'admin', { devices: [] })
  ]);
  const qs = await kget(env, 'qs', []);
  const day = dayKey();
  const answered = qs.filter(q => q.status === 'answered');
  const scored = answered.filter(q => typeof q.score === 'number');
  const avg = a => a.length ? Math.round(a.reduce((s, q) => s + q.score, 0) / a.length) : null;
  const trend = [];
  for (let i = 6; i >= 0; i--) { const d = dayKey(now() - i * 864e5); trend.push({ day: d, v: avg(scored.filter(q => dayKey(q.answeredAt) === d)) }); }
  const week = scored.filter(q => now() - q.answeredAt < 7 * 864e5);
  const her = users.find(u => u.status === 'approved');
  return {
    role: 'admin', cfg,
    me: { name: cfg.meName, photo: prof.me || null },
    partner: her ? { name: her.name, photo: prof.her || null } : null,
    since: her ? (her.approvedAt || her.date) : null,
    today: { answered: answeredOn(qs, day).length, total: cfg.dailyCount, score: avg(scored.filter(q => dayKey(q.answeredAt) === day)) },
    week: { avg: avg(week), cats: CATS.map(c => ({ cat: c, v: avg(week.filter(q => q.cat === c)), n: week.filter(q => q.cat === c).length })) },
    trend,
    drafts: qs.filter(q => q.status === 'draft').slice(-30).reverse(),
    queue: qs.filter(q => q.status === 'approved'),
    answered: answered.slice(-60).reverse(),
    users: users.map(u => ({ id: u.id, name: u.name, model: u.model, os: u.os, date: u.date, status: u.status, lastSeen: u.lastSeen })),
    adminDevices: admin.devices.map(d => ({ model: d.model, date: d.date })),
    gift: gift.id ? giftStatus(gift, qs) : { state: 'none' },
    reveal: { img: reveal.img || null },
    song, analysis, songs: await kget(env, 'songs', []), listen: await kget(env, 'listen', null), now: now(),
    tg: !!(env.TG_TOKEN && await tgChat(env)), tgToken: !!env.TG_TOKEN, gemini: !!env.GEMINI_KEY
  };
}

/* ---------------- router ---------------- */
export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (!env.KV) return err('KV binding missing', 500);
      if (path === '/') return json({ ok: true, app: 'Ti' });
      if (path === '/tg' && req.method === 'POST') return await tgWebhook(req, env);
      if (path === '/api/admin/audio' && req.method === 'POST') return await uploadAudio(req, env);
      if (path.startsWith('/api/audio/')) return await serveAudio(req, env, path);
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

      /* ---- public ---- */
      if (path === '/api/register' && req.method === 'POST') {
        const name = clean(body.name, 40), dev = clean(body.deviceId, 64);
        if (!name || !/^[A-Za-z0-9-]{8,64}$/.test(dev)) return err('name and device required');
        const users = await kget(env, 'users', []);
        let u = users.find(x => x.deviceId === dev);
        if (u && u.status === 'banned') return err('banned', 403);
        if (!u) {
          if (users.filter(x => x.status === 'pending').length >= 10) return err('too many pending', 429);
          u = { id: uid(), name, deviceId: dev, model: clean(body.model, 80), os: clean(body.os, 40), date: now(), status: 'pending' };
          users.push(u); await kput(env, 'users', users);
          ctx.waitUntil(tg(env, `🔔 <b>New registration on Ti</b>\n👤 ${h(u.name)}\n📱 ${h(u.model)} · ${h(u.os)}`, [{ text: '✅ Approve', callback_data: 'ap:' + u.id }, { text: '⛔ Ban', callback_data: 'ban:' + u.id }]));
        }
        return json({ token: await makeToken(env, 'm', u.id, dev), status: u.status });
      }

      if (path === '/api/admin/login' && req.method === 'POST') {
        const dev = clean(body.deviceId, 64);
        if (!env.ADMIN_PIN) return err('ADMIN_PIN not set', 500);
        if (!/^[A-Za-z0-9-]{8,64}$/.test(dev)) return err('device required');
        const pf = await kget(env, 'pinfail', { n: 0, until: 0 });
        if (pf.until > now()) return err('locked', 429);
        if (String(body.pin) !== String(env.ADMIN_PIN)) {
          pf.n++; if (pf.n >= 5) { pf.until = now() + 15 * 60e3; pf.n = 0; }
          await kput(env, 'pinfail', pf);
          ctx.waitUntil(tg(env, `⚠️ Wrong admin PIN on Ti\n📱 ${h(clean(body.model, 80))}`));
          return err('denied', 403);
        }
        await kput(env, 'pinfail', { n: 0, until: 0 });
        const a = await kget(env, 'admin', { devices: [] });
        if (!a.devices.some(d => d.id === dev)) {
          a.devices.push({ id: dev, model: clean(body.model, 80), date: now() });
          a.devices = a.devices.slice(-3); await kput(env, 'admin', a);
          ctx.waitUntil(tg(env, `🛡 Admin unlocked on a new device\n📱 ${h(clean(body.model, 80))}`));
        }
        return json({ token: await makeToken(env, 'a', 'admin', dev) });
      }

      if (path.startsWith('/api/img/')) {
        const me = await auth(req, env); if (!me) return err('unauthorized', 401);
        const key = path.slice(9).replace(/[^a-z0-9]/g, '');
        const d = await env.KV.get('img:' + key);
        if (!d) return err('not found', 404);
        const m = d.match(/^data:([^;]+);base64,(.*)$/);
        const bin = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
        return new Response(bin, { headers: { 'content-type': m[1], 'cache-control': 'private, max-age=31536000, immutable', ...CORS } });
      }

      /* ---- authenticated ---- */
      const me = await auth(req, env);
      if (!me) return err('unauthorized', 401);
      if (me.role === 'member') {
        const st = me.user.status;
        if (st === 'banned') return err('banned', 403);
        if (st !== 'approved') return json({ role: 'member', status: st });
        if (!me.user.lastSeen || now() - me.user.lastSeen > 5 * 60e3) {
          const users = await kget(env, 'users', []); const u = users.find(x => x.id === me.id);
          if (u) { u.lastSeen = now(); await kput(env, 'users', users); }
        }
      }
      const isAdmin = me.role === 'admin';

      if (path === '/api/state') return json(isAdmin ? await adminState(env) : await memberState(env, me));

      if (path === '/api/answer' && req.method === 'POST' && !isAdmin) {
        const text = clean(body.text, 2000); if (!text) return err('empty');
        const qs = await kget(env, 'qs', []); const q = qs.find(x => x.id === body.id && x.status === 'approved');
        if (!q) return err('question not found', 404);
        const cfg = await getCfg(env);
        if (answeredOn(qs, dayKey()).length >= cfg.dailyCount) return err('daily limit reached', 429);
        q.status = 'answered'; q.ansZu = text; q.answeredAt = now();
        await kput(env, 'qs', qs);
        ctx.waitUntil((async () => {
          let s = {}; try { s = await scoreAnswer(env, q); } catch (e) { s = { scoreErr: String(e.message || e) }; }
          const all = await kget(env, 'qs', []); const t = all.find(x => x.id === q.id); if (t) Object.assign(t, s);
          await kput(env, 'qs', all);
          await tg(env, `💬 <b>She answered</b> (${q.cat})\n❓ ${h(q.am)}\n🗣 ${h(s.ansAm || text)}${typeof s.score === 'number' ? `\n📊 ${s.score}%` : ''}`);
        })());
        return json({ ok: true });
      }

      if (path === '/api/chat') {
        let chat = await kget(env, 'chat', []);
        if (req.method === 'POST') {
          const text = clean(body.text, 2000); if (!text) return err('empty');
          const from = isAdmin ? 'me' : 'her';
          let tr = ''; try { tr = await translate(env, text, isAdmin ? 'zu' : 'am'); } catch (e) { }
          const m = { id: uid(), from, text, tr, at: now() };
          chat = (await kget(env, 'chat', [])); chat.push(m); chat = chat.slice(-400);
          await kput(env, 'chat', chat);
          if (!isAdmin) ctx.waitUntil(tg(env, `💌 <b>${h(me.user.name)}</b>: ${h(tr || text)}`));
          return json({ ok: true, msg: m });
        }
        const after = +url.searchParams.get('after') || 0;
        return json({ messages: chat.filter(m => m.at > after) });
      }

      if (path === '/api/ping' && req.method === 'POST') {
        if (!isAdmin) { ctx.waitUntil(tg(env, `💗 ${h(me.user.name)} is thinking of you`)); return json({ ok: true }); }
        const ev = (await kget(env, 'events', [])).slice(-20); ev.push({ to: 'her', type: 'ping', at: now() });
        await kput(env, 'events', ev); return json({ ok: true });
      }

      if (path === '/api/profile-photo' && req.method === 'POST') {
        const who = isAdmin ? (body.who === 'her' ? 'her' : 'me') : 'her';
        const key = await saveImg(env, body.img);
        const prof = await kget(env, 'profiles', {}); prof[who] = key; await kput(env, 'profiles', prof);
        return json({ ok: true, key });
      }

      if (path === '/api/gift/open' && req.method === 'POST' && !isAdmin) {
        const gift = await kget(env, 'gift', {}); const qs = await kget(env, 'qs', []);
        const st = giftStatus(gift, qs);
        if (st.state !== 'ready') return err('locked', 423);
        gift.openedAt = now(); await kput(env, 'gift', gift);
        ctx.waitUntil(tg(env, `🎁 She opened your gift: "${h(gift.msg)}"`));
        return json({ ok: true, img: gift.img, msg: gift.msg });
      }

      if (path === '/api/listen') {
        let L = await kget(env, 'listen', null);
        if (req.method === 'GET') return json({ listen: L, now: now() });
        if (body.action === 'react') {
          if (!L) return err('nothing playing');
          L.reacts = [...(L.reacts || []), { e: clean(body.e, 8) || '❤️', from: isAdmin ? 'me' : 'her', at: now() }].slice(-12);
          await kput(env, 'listen', L); return json({ ok: true, listen: L, now: now() });
        }
        if (!isAdmin) return err('forbidden', 403);
        const pos = Math.max(0, +body.pos || 0), t = now();
        const cur = L && L.playing ? L.pos + (t - L.anchor) / 1000 : (L ? L.pos : 0);
        if (body.action === 'play') {
          const songs = await kget(env, 'songs', []); const sg = songs.find(x => x.id === body.id);
          if (!sg) return err('song not found', 404);
          L = { kind: 'audio', id: sg.id, title: sg.title, dur: sg.dur || 0, playing: true, pos, anchor: t, v: t, reacts: [] };
          ctx.waitUntil(tg(env, `🎧 Now playing for both of you: ${h(sg.title)}`));
        } else if (body.action === 'spotify') {
          L = { kind: 'spotify', url: clean(body.url, 300), title: clean(body.title, 120) || 'Our song', playing: true, pos: 0, anchor: t, v: t, reacts: [] };
        } else if (!L) return err('nothing playing');
        else if (body.action === 'pause') { L.pos = cur; L.playing = false; L.anchor = t; L.v = t; }
        else if (body.action === 'resume') { L.pos = cur; L.playing = true; L.anchor = t; L.v = t; }
        else if (body.action === 'seek') { L.pos = pos; L.anchor = t; L.v = t; }
        else if (body.action === 'stop') { L = null; }
        else return err('bad action');
        await kput(env, 'listen', L); return json({ ok: true, listen: L, now: t });
      }

      /* ---- admin only ---- */
      if (!path.startsWith('/api/admin/')) return err('not found', 404);
      if (!isAdmin) return err('forbidden', 403);
      const sub = path.slice(11);

      if (sub === 'cfg' && req.method === 'POST') {
        const cfg = await getCfg(env);
        if (body.dailyCount != null) cfg.dailyCount = Math.max(1, Math.min(100, Math.round(+body.dailyCount) || 10));
        if (body.qMode) cfg.qMode = body.qMode === 'auto' ? 'auto' : 'manual';
        if (body.meName) cfg.meName = clean(body.meName, 40);
        await kput(env, 'cfg', cfg); return json({ ok: true, cfg });
      }
      if (sub === 'generate' && req.method === 'POST') {
        const n = Math.max(1, Math.min(10, +body.n || 5));
        const fresh = await genQuestions(env, n);
        const qs = [...(await kget(env, 'qs', [])), ...fresh].slice(-600);
        await kput(env, 'qs', qs); return json({ ok: true, added: fresh.length });
      }
      let m;
      if ((m = sub.match(/^q\/([a-z0-9]+)\/(approve|reject|edit|delete)$/)) && req.method === 'POST') {
        const qs = await kget(env, 'qs', []); const q = qs.find(x => x.id === m[1]);
        if (!q) return err('not found', 404);
        if (m[2] === 'approve') { q.status = 'approved'; q.approvedAt = now(); }
        if (m[2] === 'reject') q.status = 'rejected';
        if (m[2] === 'delete') qs.splice(qs.indexOf(q), 1);
        if (m[2] === 'edit') {
          const am = clean(body.am, 500); if (!am) return err('empty');
          const r = await gem(env, `Translate this Amharic question for a girlfriend into natural isiZulu and English. Keep it warm and indirect.\nAmharic: ${am}\nReturn JSON {"zu":"...","en":"..."}`);
          q.am = am; q.zu = clean(r.zu, 500) || q.zu; q.en = clean(r.en, 500) || q.en;
        }
        await kput(env, 'qs', qs); return json({ ok: true, q });
      }
      if (sub === 'reveal' && req.method === 'POST') {
        const key = await saveImg(env, body.img); await kput(env, 'reveal', { img: key, setAt: now() }); return json({ ok: true });
      }
      if (sub === 'gift' && req.method === 'POST') {
        if (body.cancel) { await kput(env, 'gift', {}); return json({ ok: true }); }
        const img = body.img ? await saveImg(env, body.img) : null;
        if (!img) return err('photo required');
        const mode = body.mode === 'now' ? 'now' : 'lock';
        const days = Math.max(0, Math.min(60, +body.days || 0));
        const gift = { id: uid(), img, msg: clean(body.msg, 200) || 'For you 💗', mode, createdAt: now(), unlockAt: mode === 'now' ? now() : now() + days * 864e5, needAnswers: mode === 'now' ? 0 : Math.max(0, Math.min(500, +body.needAnswers || 0)) };
        await kput(env, 'gift', gift); return json({ ok: true, gift: giftStatus(gift, await kget(env, 'qs', [])) });
      }
      if ((m = sub.match(/^user\/([a-z0-9]+)\/(approve|ban|delete)$/)) && req.method === 'POST') {
        const users = await kget(env, 'users', []); const u = users.find(x => x.id === m[1]);
        if (!u) return err('not found', 404);
        const r = await setUserStatus(env, users, u, m[2]); if (r) return err(r, 409);
        return json({ ok: true });
      }
      if (sub === 'song' && req.method === 'POST') {
        const s = { url: clean(body.url, 300), title: clean(body.title, 120), at: now() }; await kput(env, 'song', s); return json({ ok: true });
      }
      if (sub === 'analyze' && req.method === 'POST') {
        const qs = (await kget(env, 'qs', [])).filter(q => q.status === 'answered' && now() - q.answeredAt < 7 * 864e5);
        if (!qs.length) return err('no answers yet');
        const lines = qs.map(q => `[${q.cat}] Q: ${q.en} | A: ${q.ansEn || q.ansZu} | score ${q.score ?? '?'}`).join('\n');
        const text = await gem(env, `These are a girlfriend's answers over the last 7 days to indirect questions her boyfriend asked to understand if her love is sincere or mainly material.\n${lines}\nWrite 4-6 sentences in Amharic for him: overall picture, strongest positive signs, any warning signs, and which topic to explore next. Be balanced and honest; remind him in one sentence that AI estimates from text are not proof and real conversation matters. Plain text, no markdown.`, false);
        const a = { text: clean(text, 3000), at: now(), n: qs.length }; await kput(env, 'analysis', a); return json({ ok: true, analysis: a });
      }
      if (sub === 'tg-setup' && req.method === 'POST') {
        if (!env.TG_TOKEN) return err('TG_TOKEN not set');
        const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/setWebhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: url.origin + '/tg', secret_token: await tgSecret(env), allowed_updates: ['callback_query', 'message'] }) });
        const d = await r.json();
        if (d.ok) { await env.KV.put('tgclaim', '1', { expirationTtl: 900 }); if (await tgChat(env)) await tg(env, '✅ Ti is connected to this chat.'); }
        return json({ ok: d.ok, description: d.description, needStart: !(await tgChat(env)) });
      }
      if ((m = sub.match(/^audio\/([a-z0-9]+)\/(delete|meta)$/)) && req.method === 'POST') {
        const songs = await kget(env, 'songs', []); const sg = songs.find(x => x.id === m[1]);
        if (!sg) return err('not found', 404);
        if (m[2] === 'delete') { songs.splice(songs.indexOf(sg), 1); await env.KV.delete('aud:' + sg.id); }
        else { if (body.dur) sg.dur = Math.round(+body.dur); if (body.title) sg.title = clean(body.title, 120); }
        await kput(env, 'songs', songs); return json({ ok: true });
      }
      if (sub === 'logout-devices' && req.method === 'POST') {
        await kput(env, 'admin', { devices: [] }); return json({ ok: true });
      }
      return err('not found', 404);
    } catch (e) {
      return err(String(e.message || e), 500);
    }
  }
};

const MAX_AUDIO = 20 * 1024 * 1024;
async function uploadAudio(req, env) {
  const me = await auth(req, env); if (!me || me.role !== 'admin') return err('forbidden', 403);
  const type = (req.headers.get('Content-Type') || '').split(';')[0];
  if (!/^audio\//.test(type)) return err('audio file required');
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return err('empty');
  if (buf.byteLength > MAX_AUDIO) return err('file too large (max 20 MB)', 413);
  const id = uid();
  await env.KV.put('aud:' + id, buf);
  const title = clean(decodeURIComponent(req.headers.get('X-Title') || 'Song'), 120).replace(/\.(mp3|m4a|aac|ogg|wav|opus|webm)$/i, '');
  const songs = await kget(env, 'songs', []);
  songs.push({ id, title, type, size: buf.byteLength, at: now() });
  await kput(env, 'songs', songs.slice(-60));
  return json({ ok: true, id });
}
async function serveAudio(req, env, path) {
  const me = await auth(req, env); if (!me) return err('unauthorized', 401);
  const id = path.slice(11).replace(/[^a-z0-9]/g, '');
  const songs = await kget(env, 'songs', []); const sg = songs.find(x => x.id === id);
  const buf = sg && await env.KV.get('aud:' + id, 'arrayBuffer');
  if (!buf) return err('not found', 404);
  const size = buf.byteLength, base = { 'content-type': sg.type || 'audio/mpeg', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=86400', ...CORS };
  const rg = (req.headers.get('Range') || '').match(/bytes=(\d*)-(\d*)/);
  if (rg && (rg[1] || rg[2])) {
    let start = rg[1] ? +rg[1] : size - +rg[2], end = rg[1] && rg[2] ? Math.min(+rg[2], size - 1) : size - 1;
    if (start >= size || start < 0) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}`, ...CORS } });
    return new Response(buf.slice(start, end + 1), { status: 206, headers: { ...base, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } });
  }
  return new Response(buf, { headers: { ...base, 'content-length': String(size) } });
}

async function setUserStatus(env, users, u, action) {
  if (action === 'approve') {
    if (users.some(x => x.id !== u.id && x.status === 'approved')) return 'full';
    u.status = 'approved'; u.approvedAt = u.approvedAt || now();
  } else if (action === 'ban') u.status = 'banned';
  else if (action === 'delete') users.splice(users.indexOf(u), 1);
  await kput(env, 'users', users);
  return null;
}

async function tgWebhook(req, env) {
  if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await tgSecret(env)) return new Response('no', { status: 403 });
  const up = await req.json().catch(() => ({}));
  const chat = await tgChat(env);
  const msg = up.message;
  if (msg && /^\/start/.test(msg.text || '') && !chat && await env.KV.get('tgclaim')) {
    await env.KV.put('tgchat', String(msg.chat.id)); await env.KV.delete('tgclaim');
    await tg(env, '✅ Ti is connected. Registrations, answers and alerts will arrive here.');
    return new Response('ok');
  }
  const cq = up.callback_query;
  if (cq && chat && String(cq.message?.chat?.id) === String(chat)) {
    const [act, id] = String(cq.data || '').split(':');
    const users = await kget(env, 'users', []); const u = users.find(x => x.id === id);
    let note = 'Not found';
    if (u && (act === 'ap' || act === 'ban')) {
      const r = await setUserStatus(env, users, u, act === 'ap' ? 'approve' : 'ban');
      note = r === 'full' ? '⚠️ Full — ban the other member first' : (act === 'ap' ? `✅ ${u.name} approved` : `⛔ ${u.name} banned`);
    }
    await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/answerCallbackQuery`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callback_query_id: cq.id, text: note }) });
    await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/editMessageReplyMarkup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [[{ text: note, callback_data: 'x' }]] } }) });
  }
  return new Response('ok');
}
