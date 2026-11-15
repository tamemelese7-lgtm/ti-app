const C='ti-v6',SHELL=['./','index.html','config.js','bg-still.jpg','manifest.json','icon.svg','icon-192.png','icon-512.png','apple-touch-icon.png','intro/poster.jpg'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin||/\.mp4$/.test(u.pathname))return;
 if(e.request.mode==='navigate'||u.pathname.endsWith('.html')){e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r;}).catch(()=>caches.match(e.request).then(r=>r||caches.match('index.html'))));return;}
 e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{if(res.ok&&/\/intro\//.test(u.pathname)){const cp=res.clone();caches.open(C).then(c=>c.put(e.request,cp));}return res;})));});
