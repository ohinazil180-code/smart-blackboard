/* স্মার্ট ব্ল্যাকবোর্ড — অফলাইন সার্ভিস ওয়ার্কার
   - অ্যাপ কোড (HTML/CSS/JS): network-first → আপডেট সবসময় পৌঁছায়, অফলাইনে ক্যাশ
   - ফন্ট/OCR/PDF লাইব্রেরি/আইকন: cache-first (বড় ফাইল, বদলায় না)
   নতুন রিলিজে VER বাড়ান → পুরোনো ক্যাশ মুছে যাবে। */
const VER = 'sb-v7';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'css/tailwind.generated.css', 'js/util.js', 'js/db.js', 'js/render.js', 'js/app.js', 'js/ui.js', 'js/rooms.js', 'js/features.js',
  'fonts/NotoSansBengali-Regular.ttf', 'fonts/NotoSansBengali-Bold.ttf',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs', 'vendor/pdf-lib.min.js'
];
const OCR = [
  'vendor/ocr/tesseract.min.js', 'vendor/ocr/worker.min.js',
  'vendor/ocr/core/tesseract-core-lstm.wasm.js', 'vendor/ocr/core/tesseract-core-simd-lstm.wasm.js',
  'vendor/ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js',
  'vendor/ocr/lang/ben.traineddata', 'vendor/ocr/lang/eng.traineddata'
];
const CODE_RE = /\.(html|css|js|mjs|webmanifest)$|\/$/;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VER);
    await c.addAll(SHELL);                              // মূল ফাইল — না এলে ইনস্টল ব্যর্থ
    await Promise.allSettled(OCR.map(u => c.add(u)));   // OCR — ব্যর্থ হলে পরে ক্যাশ হবে
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VER) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;   // রুম API/স্ট্রিম কখনো ক্যাশ নয়
  const isCode = CODE_RE.test(url.pathname);

  e.respondWith((async () => {
    const c = await caches.open(VER);
    if (isCode) {
      try {
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch (_) {
        const hit = await c.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === 'navigate') { const idx = await c.match('index.html'); if (idx) return idx; }
        return new Response('অফলাইন — ফাইল ক্যাশে নেই', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    }
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    } catch (_) {
      return new Response('অফলাইন — ফাইল ক্যাশে নেই', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
