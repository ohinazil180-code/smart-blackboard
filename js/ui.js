'use strict';
/* ===== ইউআই: মেনু, থাম্বনেইল, প্রেজেন্টেশন, ইমপোর্ট/এক্সপোর্ট, OCR, ব্যাকআপ ===== */
const lum = hex => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
const scriptCache = new Map();
function loadScript(src) {
  if (!scriptCache.has(src)) scriptCache.set(src, new Promise((res, rej) => {
    const s = h('script', { src, onload: res, onerror: () => rej(new Error(src + ' লোড হয়নি')) });
    document.head.append(s);
  }));
  return scriptCache.get(src);
}

/* ---------- ব্যাক-বাটন সহ ওভারলে স্ট্যাক ---------- */
const uiStack = [];
const closers = {};
function openUI(name) {
  if (uiStack.length) { while (uiStack.length) closers[uiStack.pop()](); history.replaceState({ ui: name }, ''); }
  else history.pushState({ ui: name }, '');
  uiStack.push(name);
}
function closeUI() { if (uiStack.length) history.back(); }
window.addEventListener('popstate', () => { if (uiStack.length) closers[uiStack.pop()](); });

/* ---------- নির্মাণ ---------- */
function cacheEls() {
  Object.assign(els, {
    wrap: $('#stageWrap'), stage: $('#stage'), cvBg: $('#cvBg'), cvInk: $('#cvInk'), cvOv: $('#cvOv'), btnFit: $('#btnFit'),
    pageNo: $('#pageNo'), btnPrev: $('#btnPrev'), btnNext: $('#btnNext'), projTitle: $('#projTitle'), thumbPanel: $('#thumbPanel'),
    opts: $('#opts'), size: $('#size'), sizeVal: $('#sizeVal'), sizeLbl: $('#sizeLbl'), selBar: $('#selBar'),
    save: $('#saveDot'), saveTxt: $('#saveTxt'), menu: $('#menu'), backdrop: $('#backdrop'), presentBar: $('#presentBar')
  });
  ctxInk = els.cvInk.getContext('2d');
}

function buildSwatches(box, onPick, cur) {
  COLORS.forEach(c => box.append(h('button', { class: 'sw' + (c === cur ? ' on' : ''), style: `background:${c}`, 'data-c': c, 'aria-label': c, onclick: () => onPick(c) })));
}

const MENU = [
  { sec: 'নোট' },
  { id: 'projects', icon: 'folder', text: 'আমার নোটসমূহ' },
  { id: 'newproj', icon: 'plus', text: 'নতুন নোট শুরু করুন' },
  { id: 'rename', icon: 'edit', text: 'নোটের নাম বদলান' },
  { sec: 'পাতা' },
  { id: 'addpage', icon: 'plus', text: 'নতুন পাতা / টেমপ্লেট' },
  { id: 'pdfimp', icon: 'pdf', text: 'PDF খুলে মার্কিং করুন' },
  { id: 'imgimp', icon: 'image', text: 'ছবি থেকে পাতা তৈরি' },
  { id: 'swapboard', icon: 'moon', text: 'বোর্ড বদলান (কালো ⇄ সাদা)' },
  { id: 'grid', icon: 'grid', text: 'ব্যাকগ্রাউন্ড: গ্রিড / ডট / লাইন' },
  { id: 'clear', icon: 'trash', text: 'এই পাতা পরিষ্কার করুন' },
  { sec: 'টুলস' },
  { id: 'present', icon: 'play', text: 'প্রেজেন্টেশন মোড' },
  { id: 'ocr', icon: 'ocr', text: 'OCR — লেখা চিনে টেক্সট বানান' },
  { id: 'export', icon: 'download', text: 'এক্সপোর্ট (PDF / ছবি)' },
  { id: 'backup', icon: 'save', text: 'ব্যাকআপ ফাইল সংরক্ষণ' },
  { id: 'restore', icon: 'upload', text: 'ব্যাকআপ থেকে ফেরত আনুন' },
  { sec: 'অ্যাপ' },
  { id: 'install', icon: 'download', text: 'ফোনে অ্যাপ হিসেবে ইনস্টল করুন', hidden: true },
  { id: 'about', icon: 'info', text: 'ব্যবহার-নির্দেশনা ও অফলাইন অবস্থা' }
];
function buildMenu() {
  const box = $('#menuList');
  for (const m of MENU) {
    if (m.sec) box.append(h('div', { class: 'msec' }, m.sec));
    else box.append(h('button', { class: 'mi', id: 'mi-' + m.id, hidden: !!m.hidden, onclick: () => menuAct(m.id) }, icon(m.icon), m.text));
  }
}
const openMenu = () => { els.menu.hidden = false; els.backdrop.hidden = false; openUI('menu'); };
closers.menu = () => { els.menu.hidden = true; els.backdrop.hidden = true; };

async function menuAct(id) {
  const keepOpen = [];
  if (!keepOpen.includes(id)) closeUI();
  await sleep(60);
  switch (id) {
    case 'projects': return projectsDialog();
    case 'newproj': return newProject();
    case 'rename': { const n = await askText('নোটের নাম', S.P.name); if (n) { S.P.name = n; updatePager(); scheduleSave(); } return; }
    case 'addpage': return addPageDialog();
    case 'pdfimp': return $('#filePdf').click();
    case 'imgimp': return $('#fileImg').click();
    case 'swapboard': return swapBoard();
    case 'grid': {
      const p = S.page, order = ['none', 'grid', 'dots', 'lines'], names = { none: 'সাদামাটা', grid: 'গ্রিড', dots: 'ডট', lines: 'লাইন' };
      p.grid = order[(order.indexOf(p.grid) + 1) % order.length]; touch(p); redrawBg(); toast('ব্যাকগ্রাউন্ড: ' + names[p.grid]); return;
    }
    case 'clear': if (await confirmBox('এই পাতার সব আঁকা ও লেখা মুছে যাবে (আনডু করা যাবে)। চালিয়ে যাবেন?', 'পরিষ্কার করুন')) { S.page.items = []; S.sel = -1; commit(); redrawInk(); drawOv(); updateSelBar(); } return;
    case 'present': return enterPresent();
    case 'ocr': return ocrDialog();
    case 'export': return exportDialog();
    case 'backup': return backupSave();
    case 'restore': return $('#fileBackup').click();
    case 'install': if (deferredInstall) { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('#mi-install').hidden = true; } return;
    case 'about': return aboutDialog();
  }
}

/* ---------- বোর্ড বদল ---------- */
function swapBoard() {
  const p = S.page;
  if (p.type !== 'black' && p.type !== 'white') { toast('PDF/ছবির পাতায় বোর্ড বদল হয় না'); return; }
  const toWhite = p.type === 'black';
  p.type = toWhite ? 'white' : 'black'; p.bgc = null;
  const a = toWhite ? '#ffffff' : '#111111', b = toWhite ? '#111111' : '#ffffff';
  p.items = p.items.map(it => (it.color === a ? { ...it, color: b } : it));
  commit(); redrawBg(); redrawInk(); autoColorFix(); toast(toWhite ? 'সাদা বোর্ড' : 'কালো বোর্ড');
}

/* ---------- পাতা যোগ/ডুপ্লিকেট/মুভ/ডিলিট ---------- */
async function insertPageAfter(pages) {
  const P = S.P, at = P.cur + 1;
  P.pages.splice(at, 0, ...pages);
  pages.forEach(hist);
  await showPage(at);
}
function addPageDialog() {
  const opts = [
    ['black', 'কালো বোর্ড', 'board-b'], ['white', 'সাদা বোর্ড', 'board-w'],
    ['tTitle', 'টাইটেল স্লাইড', 'tpl'], ['tTopic', 'টপিক স্লাইড', 'tpl'], ['tContent', 'কনটেন্ট স্লাইড', 'tpl'],
    ['pdf', 'PDF থেকে', 'pdf'], ['img', 'ছবি থেকে', 'image']
  ];
  const grid = h('div', { class: 'addgrid' });
  const g = S.page.grid;
  for (const [k, label, ic] of opts) {
    grid.append(h('button', {
      class: 'addbtn ' + k, onclick: async () => {
        modal.close(null);
        if (k === 'pdf') return $('#filePdf').click();
        if (k === 'img') return $('#fileImg').click();
        const p = k === 'black' ? mkPage({ type: 'black', grid: g }) : k === 'white' ? mkPage({ type: 'white', grid: g })
          : k === 'tTitle' ? tplTitle() : k === 'tTopic' ? tplTopic() : tplContent();
        await insertPageAfter([p]); toast('নতুন পাতা যোগ হয়েছে');
      }
    }, icon(ic === 'tpl' ? 'text' : ic.startsWith('board') ? 'board' : ic), label));
  }
  modal({ title: 'নতুন পাতা যোগ করুন', body: [grid, h('p', { class: 'muted' }, 'টেমপ্লেটের লেখা পরে যেকোনো সময় বদলানো যাবে (লেখা টুল বা সিলেক্ট টুল দিয়ে)।')], buttons: [{ text: 'বন্ধ', val: null }] });
}
async function dupPage() {
  const P = S.P, src = S.page;
  const np = mkPage({ ...src, id: uid(), items: structuredClone(src.items), blob: src.blob, blobDirty: !!src.blob });
  await insertPageAfter([np]); toast('পাতা কপি হয়েছে');
}
async function delPage() {
  const P = S.P;
  if (P.pages.length <= 1) { toast('কমপক্ষে একটি পাতা থাকতে হবে'); return; }
  if (!(await confirmBox(`পাতা ${P.cur + 1} মুছে ফেলবেন? এটি আর ফেরানো যাবে না।`, 'মুছুন'))) return;
  const [rm] = P.pages.splice(P.cur, 1);
  P.deleted.add(rm.id); bmpCache.delete(rm.id);
  await showPage(Math.min(P.cur, P.pages.length - 1));
  if (!els.thumbPanel.hidden) renderThumbs();
}
async function movePage(d) {
  const P = S.P, i = P.cur, j = i + d;
  if (j < 0 || j >= P.pages.length) return;
  [P.pages[i], P.pages[j]] = [P.pages[j], P.pages[i]];
  P.cur = j; scheduleSave(); updatePager(); renderThumbs();
}

/* ---------- থাম্বনেইল প্যানেল ---------- */
const openThumbs = () => { els.thumbPanel.hidden = false; els.backdrop.hidden = false; openUI('thumbs'); renderThumbs(); };
closers.thumbs = () => { els.thumbPanel.hidden = true; els.backdrop.hidden = true; };
let thumbTok = 0;
async function renderThumbs() {
  const grid = $('#thumbGrid'), P = S.P, tok = ++thumbTok;
  grid.replaceChildren();
  const cells = P.pages.map((p, i) => {
    const w = 240, hh = Math.round(w * p.h / p.w);
    const cv = h('canvas', { width: w, height: hh });
    const cell = h('button', { class: 'thumb' + (i === P.cur ? ' cur' : ''), style: `aspect-ratio:${p.w}/${p.h}`, 'aria-label': 'পাতা ' + (i + 1), onclick: () => { showPage(i); } }, cv, h('span', { class: 'tn' }, String(i + 1)));
    grid.append(cell);
    return [p, cv];
  });
  for (const [p, cv] of cells) {
    if (tok !== thumbTok) return;
    try {
      if (!p.thumb || p.thumbDirty) { p.thumb = await renderPageCanvas(p, { scale: 240 / p.w }); p.thumbDirty = false; }
      cv.getContext('2d').drawImage(p.thumb, 0, 0, cv.width, cv.height);
    } catch (e) { console.warn(e); }
    await sleep(0);
  }
  $('.thumb.cur', grid)?.scrollIntoView({ block: 'nearest' });
}
function refreshThumbSel() {
  $$('#thumbGrid .thumb').forEach((c, i) => c.classList.toggle('cur', i === S.P.cur));
  const cur = $$('#thumbGrid .thumb')[S.P.cur];
  if (cur) { const p = S.page; renderPageCanvas(p, { scale: 240 / p.w }).then(c => { p.thumb = c; p.thumbDirty = false; const cv = $('canvas', cur); cv.getContext('2d').drawImage(c, 0, 0, cv.width, cv.height); }); }
}

/* ---------- প্রেজেন্টেশন ---------- */
let wakeLock = null, pbTimer = 0;
async function enterPresent() {
  if (S.present) return;
  openUI('present');
  S.present = true; S.pmode = 'nav'; S.sel = -1; S.hidden = -1; S.live = null;
  document.body.classList.add('present');
  updatePresentUI(); updateSelBar();
  try { await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); } catch (_) { }
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (_) { }
  await sleep(120); fitView(); showPresentBar(3500);
  toast('প্রেজেন্টেশন চালু — পাশে ট্যাপ বা সোয়াইপ করে পাতা বদলান', 3200);
}
closers.present = () => {
  S.present = false; S.laser = null; S.live = null;
  document.body.classList.remove('present'); els.presentBar.classList.remove('show');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
  try { wakeLock?.release(); } catch (_) { } wakeLock = null;
  setTimeout(() => { fitView(); updateOpts(); }, 150);
};
function showPresentBar(ms) { els.presentBar.classList.add('show'); clearTimeout(pbTimer); if (ms) pbTimer = setTimeout(() => els.presentBar.classList.remove('show'), ms); }
function togglePresentBar() { els.presentBar.classList.contains('show') ? els.presentBar.classList.remove('show') : showPresentBar(5000); }
function updatePresentUI() {
  $$('#presentBar [data-pm]').forEach(b => b.classList.toggle('on', b.dataset.pm === S.pmode));
  $('#pDraw').hidden = S.pmode !== 'draw';
  $$('#pDraw [data-pt]').forEach(b => b.classList.toggle('on', b.dataset.pt === S.tool));
  els.wrap.dataset.pm = S.pmode;
}

/* ---------- ইমপোর্ট: PDF / ছবি ---------- */
async function importPDF(file) {
  let cancel = false;
  busy('PDF খোলা হচ্ছে…', 0, () => { cancel = true; });
  try {
    const pdfjs = await import(absURL('vendor/pdf.min.mjs'));
    pdfjs.GlobalWorkerOptions.workerSrc = absURL('vendor/pdf.worker.min.mjs');
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data }).promise;
    const n = pdf.numPages, pages = [];
    for (let i = 1; i <= n && !cancel; i++) {
      busy(`PDF-এর পাতা প্রস্তুত হচ্ছে… ${i} / ${n}`, (i - 1) / n, () => { cancel = true; });
      const pg = await pdf.getPage(i);
      const v1 = pg.getViewport({ scale: 1 }), k = 1280 / Math.max(v1.width, v1.height);
      const W = Math.round(v1.width * k), H = Math.round(v1.height * k);
      const rs = Math.min((W * 1.7) / v1.width, 2600 / Math.max(v1.width, v1.height));
      const vp = pg.getViewport({ scale: rs });
      const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
      await pg.render({ canvasContext: cx, viewport: vp, canvas: cv }).promise;
      const blob = await canvasToBlob(cv, 'image/jpeg', 0.86);
      cv.width = cv.height = 0; pg.cleanup();
      pages.push(mkPage({ type: 'pdf', w: W, h: H, blob }));
    }
    try { pdf.destroy(); } catch (_) { }
    if (pages.length) { await insertPageAfter(pages); toast(`PDF থেকে ${pages.length}টি পাতা যোগ হয়েছে — এখন কলম দিয়ে মার্কিং করুন`, 3500); }
  } catch (e) { console.error(e); toast('PDF খোলা যায়নি: ' + (e.message || e), 5000); }
  busyOff();
}
async function importImages(files) {
  busy('ছবি যোগ হচ্ছে…', 0);
  try {
    const pages = [];
    let i = 0;
    for (const f of files) {
      busy(`ছবি যোগ হচ্ছে… ${++i} / ${files.length}`, (i - 1) / files.length);
      const bmp = await createImageBitmap(f);
      const k = 1280 / Math.max(bmp.width, bmp.height), W = Math.round(bmp.width * k), H = Math.round(bmp.height * k);
      const q = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * q); cv.height = Math.round(bmp.height * q);
      const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(bmp, 0, 0, cv.width, cv.height);
      const blob = await canvasToBlob(cv, 'image/jpeg', 0.9); cv.width = cv.height = 0; bmp.close?.();
      pages.push(mkPage({ type: 'img', w: W, h: H, blob }));
    }
    if (pages.length) { await insertPageAfter(pages); toast(`${pages.length}টি ছবির পাতা যোগ হয়েছে`); }
  } catch (e) { console.error(e); toast('ছবি যোগ করা যায়নি: ' + (e.message || e), 5000); }
  busyOff();
}

/* ---------- এক্সপোর্ট ---------- */
function opt(v, t, sel) { return h('option', { value: v, selected: !!sel }, t); }
async function exportDialog() {
  const P = S.P, n = P.pages.length;
  const fmt = h('select', { class: 'inp' }, opt('pdf', 'PDF ফাইল'), opt('png', 'ছবি (PNG) — শুধু বর্তমান পাতা'));
  const rng = h('select', { class: 'inp' }, opt('all', `সব পাতা (${n}টি)`), opt('cur', `শুধু বর্তমান পাতা (${P.cur + 1})`));
  const q = h('select', { class: 'inp' }, opt('1.5', 'স্ট্যান্ডার্ড (ছোট ফাইল)', true), opt('2', 'হাই কোয়ালিটি (বড় ফাইল)'));
  fmt.onchange = () => { if (fmt.value === 'png') { rng.value = 'cur'; rng.disabled = true; } else rng.disabled = false; };
  const r = await modal({
    title: 'এক্সপোর্ট',
    body: [h('label', { class: 'lbl' }, 'ফরম্যাট', fmt), h('label', { class: 'lbl' }, 'কোন পাতা', rng), h('label', { class: 'lbl' }, 'মান', q)],
    buttons: [{ text: 'বাতিল', val: null }, { text: 'তৈরি করুন', cls: 'pri', act: c => c({ f: fmt.value, r: rng.value, q: +q.value }) }]
  });
  if (!r) return;
  const pages = r.r === 'cur' ? [S.page] : P.pages.slice();
  const base = safeName(P.name);
  try {
    let blob, name;
    if (r.f === 'png') {
      busy('ছবি তৈরি হচ্ছে…');
      const cv = await renderPageCanvas(S.page, { scale: r.q });
      blob = await canvasToBlob(cv, 'image/png'); name = `${base}-পাতা${P.cur + 1}.png`;
    } else {
      await loadScript('vendor/pdf-lib.min.js');
      blob = await buildPDF(pages, r.q); name = `${base}.pdf`;
    }
    busyOff();
    const file = new File([blob], name, { type: blob.type });
    const buttons = [{ text: 'বন্ধ', val: null }];
    if (navigator.canShare && navigator.canShare({ files: [file] })) buttons.push({ text: 'শেয়ার', icon: 'share', act: async () => { try { await navigator.share({ files: [file], title: base }); } catch (_) { } } });
    buttons.push({ text: 'ডাউনলোড', icon: 'download', cls: 'pri', act: c => { downloadBlob(blob, name); c(true); toast('ডাউনলোড শুরু হয়েছে'); } });
    modal({ title: 'তৈরি হয়েছে ✓', body: [h('p', {}, `${name} — ${(blob.size / 1048576).toFixed(1)} MB`)], buttons });
  } catch (e) { busyOff(); console.error(e); toast('এক্সপোর্ট ব্যর্থ: ' + (e.message || e), 5000); }
}
async function buildPDF(pages, scale) {
  const { PDFDocument } = PDFLib;
  const doc = await PDFDocument.create();
  doc.setTitle(S.P.name); doc.setCreator('Digital Smart Blackboard & PDF Teaching Studio');
  for (let i = 0; i < pages.length; i++) {
    busy(`PDF তৈরি হচ্ছে… ${i + 1} / ${pages.length}`, i / pages.length);
    await sleep(10);
    const p = pages[i];
    const cv = await renderPageCanvas(p, { scale });
    const blob = await canvasToBlob(cv, 'image/jpeg', 0.92); cv.width = cv.height = 0;
    const img = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const W = p.w * 0.75, H = p.h * 0.75;
    doc.addPage([W, H]).drawImage(img, { x: 0, y: 0, width: W, height: H });
  }
  busy('ফাইল চূড়ান্ত হচ্ছে…', 1);
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

/* ---------- OCR ---------- */
const ocr = { w: null, lang: null };
async function ocrDialog() {
  const lang = h('select', { class: 'inp' }, opt('ben+eng', 'বাংলা + English', S.ocrLang === 'ben+eng'), opt('ben', 'শুধু বাংলা', S.ocrLang === 'ben'), opt('eng', 'শুধু English', S.ocrLang === 'eng'));
  const r = await modal({
    title: 'OCR — লেখা চিনুন',
    body: [h('p', {}, 'পাতার ছাপা/স্পষ্ট লেখা থেকে এডিটযোগ্য টেক্সট বের করে। হাতের লেখায় নির্ভুলতা কম হতে পারে — বড় ও পরিষ্কার করে লিখুন।'), h('label', { class: 'lbl' }, 'ভাষা', lang),
      h('p', { class: 'muted' }, 'অফলাইনেই কাজ করে (ইঞ্জিন ও ভাষা-ডেটা অ্যাপের সাথেই আছে)। প্রথমবার লোড হতে কয়েক সেকেন্ড লাগতে পারে।')],
    buttons: [{ text: 'বাতিল', val: null }, { text: 'অংশ বেছে নিন', act: c => c('region') }, { text: 'পুরো পাতা', cls: 'pri', act: c => c('page') }]
  });
  if (!r) return;
  S.ocrLang = lang.value;
  if (r === 'region') { setTool('ocr'); toast('যে অংশের লেখা চিনতে চান সেটি টেনে ঘিরে ফেলুন', 3500); }
  else runOCR(null);
}
async function getOcrWorker(lang) {
  if (ocr.w && ocr.lang === lang) return ocr.w;
  if (ocr.w) { try { await ocr.w.terminate(); } catch (_) { } ocr.w = null; }
  await loadScript('vendor/ocr/tesseract.min.js');
  const label = { 'loading tesseract core': 'OCR ইঞ্জিন লোড হচ্ছে…', 'initializing tesseract': 'ইঞ্জিন চালু হচ্ছে…', 'loading language traineddata': 'ভাষা-ডেটা লোড হচ্ছে…', 'initializing api': 'প্রস্তুত হচ্ছে…', 'recognizing text': 'লেখা চেনা হচ্ছে…' };
  ocr.w = await Tesseract.createWorker(lang.split('+'), 1, {
    workerPath: absURL('vendor/ocr/worker.min.js'), corePath: absURL('vendor/ocr/core'), langPath: absURL('vendor/ocr/lang'),
    gzip: false, workerBlobURL: false, cacheMethod: 'none',
    logger: m => { if (m && m.status && !$('#busy').hidden) busy(label[m.status] || 'কাজ চলছে…', typeof m.progress === 'number' ? m.progress : null); }
  });
  ocr.lang = lang;
  return ocr.w;
}
async function runOCR(rect) {
  busy('OCR শুরু হচ্ছে…', 0);
  try {
    const p = S.page, sc = 2;
    let cv = await renderPageCanvas(p, { scale: sc, mono: true });
    const pad = 24;
    let sx = 0, sy = 0, sw = cv.width, sh = cv.height;
    if (rect) {
      sx = Math.max(0, Math.min(rect.x1, rect.x2) * sc); sy = Math.max(0, Math.min(rect.y1, rect.y2) * sc);
      sw = Math.min(cv.width - sx, Math.abs(rect.x2 - rect.x1) * sc); sh = Math.min(cv.height - sy, Math.abs(rect.y2 - rect.y1) * sc);
    }
    const out = document.createElement('canvas'); out.width = sw + pad * 2; out.height = sh + pad * 2;
    const oc = out.getContext('2d'); oc.fillStyle = '#fff'; oc.fillRect(0, 0, out.width, out.height); oc.drawImage(cv, sx, sy, sw, sh, pad, pad, sw, sh);
    cv.width = cv.height = 0;
    const blob = await canvasToBlob(out, 'image/png');
    const worker = await getOcrWorker(S.ocrLang);
    busy('লেখা চেনা হচ্ছে…', 0);
    const { data } = await worker.recognize(blob);
    busyOff();
    showOcrResult((data.text || '').trim(), rect);
  } catch (e) { busyOff(); console.error(e); toast('OCR ব্যর্থ: ' + (e.message || e), 5000); }
}
function showOcrResult(text, rect) {
  const ta = h('textarea', { class: 'inp ta', rows: 9 }); ta.value = text;
  modal({
    title: text ? 'চেনা লেখা (সম্পাদনা করা যাবে)' : 'কোনো লেখা পাওয়া যায়নি',
    body: [text ? null : h('p', { class: 'muted' }, 'পরিষ্কার ও বড় লেখা বা উচ্চ কনট্রাস্টের PDF/ছবিতে চেষ্টা করুন।'), ta],
    buttons: [
      { text: 'বন্ধ', val: null },
      { text: 'কপি', icon: 'copy', act: async () => { try { await navigator.clipboard.writeText(ta.value); } catch (_) { ta.select(); document.execCommand('copy'); } toast('কপি হয়েছে'); } },
      { text: 'বোর্ডে বসান', cls: 'pri', icon: 'text', act: c => {
        const t = ta.value.trim(); c(true); if (!t) return;
        const p = S.page, x = rect ? Math.min(rect.x1, rect.x2) : 60, y = rect ? Math.min(rect.y1, rect.y2) : 60;
        p.items = [...p.items, { t: 'text', x, y, text: t, size: 34, color: S.color }]; commit(); redrawInk(); toast('লেখা বোর্ডে যোগ হয়েছে');
      } }
    ]
  });
}

/* ---------- টেক্সট বক্স ---------- */
async function editText(idx, x, y) {
  const p = S.page, ex = idx >= 0 ? p.items[idx] : null;
  if (ex?.locked) return toast('লেখাটি সুরক্ষিত — আগে আনলক করুন');
  const st = { size: ex ? ex.size : S.sizes.text, color: ex ? ex.color : S.color, bold: !!(ex && ex.bold), glow: !!(ex && ex.glow), align: (ex && ex.align) || 'left' };
  const ta = h('textarea', { class: 'inp ta', rows: 4, placeholder: 'এখানে লিখুন… (বাংলা / English)' });
  ta.value = ex ? ex.text : '';
  const paint = () => {
    ta.style.color = st.color; ta.style.background = lum(st.color) > 0.55 ? '#1b1d23' : '#e9eaee';
    ta.style.fontWeight = st.bold ? 700 : 400; ta.style.textAlign = st.align; ta.style.textShadow = st.glow ? `0 0 8px ${st.color}` : 'none';
    $$('.swrow .sw', box).forEach(b => b.classList.toggle('on', b.dataset.c === st.color));
    bBold.classList.toggle('on', st.bold); bGlow.classList.toggle('on', st.glow); bCen.classList.toggle('on', st.align === 'center');
  };
  const sw = h('div', { class: 'swrow' });
  buildSwatches(sw, c => { st.color = c; paint(); }, st.color);
  const rg = h('input', { type: 'range', min: 14, max: 160, value: st.size, class: 'rng' });
  const rv = h('b', {}, String(st.size));
  rg.oninput = () => { st.size = +rg.value; rv.textContent = rg.value; };
  const bBold = h('button', { class: 'chip', onclick: () => { st.bold = !st.bold; paint(); } }, 'গাঢ় (B)');
  const bGlow = h('button', { class: 'chip', onclick: () => { st.glow = !st.glow; paint(); } }, 'নিয়ন গ্লো');
  const bCen = h('button', { class: 'chip', onclick: () => { st.align = st.align === 'center' ? 'left' : 'center'; paint(); } }, 'মাঝে');
  const box = h('div', { class: 'tbox' }, ta, sw, h('div', { class: 'row' }, h('span', {}, 'সাইজ'), rg, rv), h('div', { class: 'row chips' }, bBold, bGlow, bCen));
  paint();
  const buttons = [{ text: 'বাতিল', val: null }];
  if (ex) buttons.unshift({ text: 'মুছুন', cls: 'danger', val: 'del' });
  buttons.push({ text: ex ? 'সংরক্ষণ' : 'যোগ করুন', cls: 'pri', act: c => c('ok') });
  const pr = modal({ title: ex ? 'লেখা সম্পাদনা' : 'নতুন লেখা', body: box, buttons, dismiss: false });
  setTimeout(() => ta.focus(), 120);
  const r = await pr;
  if (r === 'del') { p.items = p.items.filter((_, i) => i !== idx); S.sel = -1; commit(); redrawInk(); drawOv(); updateSelBar(); return; }
  if (r !== 'ok') return;
  const text = ta.value.replace(/\s+$/, '');
  if (!text.trim()) return;
  S.sizes.text = st.size; setColor(st.color, true); if (S.tool === 'text') updateSizeUI();
  const item = { ...(ex || {}), t: 'text', text, size: st.size, color: st.color, bold: st.bold, glow: st.glow, align: st.align };
  if (ex) { p.items = p.items.slice(); p.items[idx] = item; }
  else { item.x = clamp(x, 8, p.w - 80); item.y = clamp(y - st.size * 0.5, 8, p.h - st.size); p.items = [...p.items, item]; }
  commit(); redrawInk(); drawOv(); updateSelBar();
}

/* ---------- নোট/প্রজেক্ট ---------- */
async function openProject(P) {
  if (S.P && S.P !== P) await saveNow();
  S.P = P;
  try { localStorage.setItem('sb.last', P.id); } catch (_) { }
  await showPage(P.cur);
}
async function newProject() {
  const name = await askText('নতুন নোটের নাম', 'নতুন ক্লাস নোট');
  if (!name) return;
  const P = { id: uid(), name, pages: [mkPage({ type: 'black' })], cur: 0, deleted: new Set(), created: Date.now() };
  P.pages[0].dirty = true;
  if (S.P) await saveNow();
  S.P = null; await openProject(P); await saveNow(); toast('নতুন নোট তৈরি হয়েছে');
}
async function projectsDialog() {
  await saveNow();
  const list = (await dbAll('projects')).sort((a, b) => b.updated - a.updated);
  const box = h('div', { class: 'plist' });
  const fmt = t => new Date(t).toLocaleString('bn-BD', { dateStyle: 'medium', timeStyle: 'short' });
  for (const m of list) {
    const cur = m.id === S.P.id;
    box.append(h('div', { class: 'prow' + (cur ? ' cur' : '') },
      h('button', { class: 'pmain', onclick: async () => { modal.close(null); if (cur) return; const P = await loadProject(m.id); if (P) await openProject(P); } },
        h('b', {}, m.name + (cur ? ' (চলমান)' : '')), h('span', {}, `${m.order.length}টি পাতা · ${fmt(m.updated)}`)),
      h('button', { class: 'ib sm', 'aria-label': 'নাম বদলান', onclick: async () => { modal.close(null); const n = await askText('নোটের নাম', m.name); if (!n) return; if (cur) { S.P.name = n; updatePager(); scheduleSave(); } else { m.name = n; await dbBatch([{ s: 'projects', t: 'put', v: m }]); } toast('নাম বদলানো হয়েছে'); } }, icon('edit')),
      h('button', { class: 'ib sm danger', 'aria-label': 'মুছুন', onclick: async () => {
        modal.close(null);
        if (!(await confirmBox(`"${m.name}" নোটটি স্থায়ীভাবে মুছে যাবে। নিশ্চিত?`, 'মুছুন'))) return;
        await deleteProject(m.id);
        if (cur) { const rest = list.filter(x => x.id !== m.id); S.P = null; let P = rest.length ? await loadProject(rest[0].id) : null; if (!P) P = await firstProject(true); await openProject(P); }
        toast('নোট মুছে ফেলা হয়েছে');
      } }, icon('trash'))));
  }
  modal({ title: 'আমার নোটসমূহ', body: box, buttons: [{ text: 'বন্ধ', val: null }, { text: 'নতুন নোট', cls: 'pri', icon: 'plus', act: c => { c(null); newProject(); } }] });
}
async function firstProject(blank) {
  const P = { id: uid(), name: 'ক্লাস নোট', pages: blank ? [mkPage({ type: 'black' })] : [tplTitle(), tplTopic(), tplContent()], cur: 0, deleted: new Set(), created: Date.now() };
  S.P = P; await saveNow();
  return P;
}

/* ---------- ব্যাকআপ ---------- */
async function backupSave() {
  busy('ব্যাকআপ তৈরি হচ্ছে…');
  try {
    const P = S.P, pages = [];
    for (const p of P.pages) pages.push({ type: p.type, w: p.w, h: p.h, grid: p.grid, bgc: p.bgc, items: p.items, img: p.blob ? await blobToDataURL(p.blob) : null });
    const json = JSON.stringify({ app: 'smartboard', v: 1, name: P.name, pages });
    downloadBlob(new Blob([json], { type: 'application/json' }), safeName(P.name) + '.sbnote.json');
    busyOff(); toast('ব্যাকআপ ফাইল ডাউনলোড হচ্ছে');
  } catch (e) { busyOff(); toast('ব্যাকআপ ব্যর্থ: ' + e.message, 5000); }
}
async function backupRestore(file) {
  busy('ব্যাকআপ পড়া হচ্ছে…');
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== 'smartboard' || !Array.isArray(d.pages)) throw new Error('এটি এই অ্যাপের ব্যাকআপ ফাইল নয়');
    const pages = [];
    for (const r of d.pages) pages.push(mkPage({ type: r.type, w: r.w, h: r.h, grid: r.grid, bgc: r.bgc, items: r.items || [], blob: r.img ? await dataURLToBlob(r.img) : null, blobDirty: !!r.img }));
    if (!pages.length) throw new Error('ফাইলে কোনো পাতা নেই');
    await saveNow();
    const P = { id: uid(), name: (d.name || 'ব্যাকআপ') + ' (ফেরত)', pages, cur: 0, deleted: new Set(), created: Date.now() };
    S.P = null; await openProject(P); await saveNow();
    busyOff(); toast('ব্যাকআপ থেকে নোট ফেরত এসেছে');
  } catch (e) { busyOff(); toast('ফেরত আনা যায়নি: ' + e.message, 5000); }
}

/* ---------- সহায়তা ---------- */
async function aboutDialog() {
  let st = 'অনুপলব্ধ';
  try { const e = await navigator.storage.estimate(); st = `${(e.usage / 1048576).toFixed(1)} MB ব্যবহৃত (সীমা ≈ ${(e.quota / 1048576 / 1024).toFixed(1)} GB)`; } catch (_) { }
  const sw = 'serviceWorker' in navigator ? (navigator.serviceWorker.controller ? 'চালু ✓ — ইন্টারনেট ছাড়াই খুলবে' : 'প্রথমবার লোড; পরের বার থেকে অফলাইনে চলবে') : 'এই ব্রাউজারে সমর্থিত নয়';
  const li = t => h('li', {}, t);
  modal({
    title: 'ব্যবহার-নির্দেশনা',
    body: [h('ul', { class: 'help' },
      li('✍ আঁকতে এক আঙুল; জুম/সরাতে দুই আঙুল (পিঞ্চ)।'),
      li('T লেখা টুলে ট্যাপ করে বাংলা/English লিখুন; সিলেক্ট টুলে লেখা বা আঁকা টেনে সরান।'),
      li('📄 মেনু → "PDF খুলে মার্কিং করুন" — প্রতিটি PDF পাতা বোর্ডের মতো মার্ক করা যায়।'),
      li('▦ থাম্বনেইলে পাতা সাজান, কপি বা মুছুন।'),
      li('▶ প্রেজেন্টেশনে পাশে ট্যাপ/সোয়াইপ করে পাতা বদলান; লেজার ও কলমও আছে।'),
      li('সব পরিবর্তন নিজে থেকেই ফোনে সংরক্ষিত হয়। নিরাপত্তার জন্য মাঝে মাঝে "ব্যাকআপ" নিন।')),
    h('p', { class: 'muted' }, 'অফলাইন সাপোর্ট: ' + sw), h('p', { class: 'muted' }, 'স্টোরেজ: ' + st)],
    buttons: [{ text: 'বন্ধ', val: true, cls: 'pri' }]
  });
}

/* ---------- সিস্টেম-সচেতন থিম ---------- */
const themePreference = () => { try { return localStorage.getItem('sb.theme') || 'system'; } catch (_) { return 'system'; } };
function applyTheme(preference, animate = false) {
  const root = document.documentElement;
  root.dataset.theme = preference;
  root.style.colorScheme = preference === 'system' ? '' : preference;
  const button = $('#themeToggle');
  if (button) {
    const labels = { system: 'সিস্টেম থিম (এখন বদলাতে চাপুন)', light: 'লাইট থিম (এখন বদলাতে চাপুন)', dark: 'ডার্ক থিম (এখন বদলাতে চাপুন)' };
    button.setAttribute('aria-label', labels[preference]);
    button.title = labels[preference];
    button.dataset.mode = preference;
  }
  if (animate) {
    root.classList.add('theme-transition');
    window.setTimeout(() => root.classList.remove('theme-transition'), 500);
  }
}
function initTheme() {
  applyTheme(themePreference());
  $('#themeToggle').onclick = cycleTheme;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (themePreference() === 'system') applyTheme('system', true);
  });
}
function cycleTheme() {
  const current = themePreference();
  const next = current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system';
  try { localStorage.setItem('sb.theme', next); } catch (_) { }
  applyTheme(next, true);
}

/* ---------- ইভেন্ট বাইন্ডিং ---------- */
let deferredInstall = null;
function bindUI() {
  initTheme();
  $('#btnMenu').onclick = openMenu;
  $('#projTitle').onclick = projectsDialog;
  els.btnPrev.onclick = () => goPage(-1); els.btnNext.onclick = () => goPage(1);
  els.pageNo.onclick = openThumbs; $('#btnThumbs').onclick = openThumbs;
  $('#btnPresent').onclick = enterPresent;
  els.backdrop.onclick = closeUI; $('#menuClose').onclick = closeUI; $('#thumbClose').onclick = closeUI;
  els.btnFit.onclick = () => { fitView(); drawOv(); };
  $('#tUndo').onclick = undo; $('#tRedo').onclick = redo;
  $$('#tools .tb[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
  $$('#rowShape [data-shape]').forEach(b => b.onclick = () => { S.shape = b.dataset.shape; updateOpts(); });
  $('#optDash').onclick = () => { S.dash = !S.dash; updateOpts(); };
  $('#optFill').onclick = () => { S.fill = !S.fill; updateOpts(); };
  $$('#rowEr [data-er]').forEach(b => b.onclick = () => { S.erMode = b.dataset.er; updateOpts(); });
  buildSwatches($('#swatches'), c => setColor(c), S.color);
  $('#customColor').oninput = e => setColor(e.target.value);
  els.size.oninput = () => onSizeInput(false); els.size.onchange = () => onSizeInput(true);
  $('#selEdit').onclick = () => editText(S.sel, 0, 0);
  $('#selLock').onclick = toggleSelLock;
  $('#selDup').onclick = dupSel; $('#selDel').onclick = deleteSel;
  $('#selDone').onclick = () => { S.sel = -1; updateSelBar(); drawOv(); };
  $('#busyCancel').onclick = () => busyCancel && busyCancel();
  /* থাম্বনেইল প্যানেলের বাটন */
  $('#thAdd').onclick = addPageDialog; $('#thDup').onclick = dupPage; $('#thDel').onclick = delPage;
  $('#thLeft').onclick = () => movePage(-1); $('#thRight').onclick = () => movePage(1);
  /* প্রেজেন্টেশন বার */
  $('#pbPrev').onclick = () => { goPage(-1); showPresentBar(4000); }; $('#pbNext').onclick = () => { goPage(1); showPresentBar(4000); };
  $('#pExit').onclick = closeUI;
  $$('#presentBar [data-pm]').forEach(b => b.onclick = () => { S.pmode = b.dataset.pm; if (S.pmode === 'draw' && !['pen', 'hl', 'er', 'shape'].includes(S.tool)) S.tool = 'pen'; updatePresentUI(); showPresentBar(5000); });
  $$('#pDraw [data-pt]').forEach(b => b.onclick = () => { S.tool = b.dataset.pt; updatePresentUI(); });
  $$('#pDraw [data-pc]').forEach(b => b.onclick = () => { setColor(b.dataset.pc, true); });
  $('#pUndo').onclick = undo;
  /* ফাইল ইনপুট */
  $('#filePdf').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importPDF(f); };
  $('#fileImg').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) importImages(f); };
  $('#fileBackup').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) backupRestore(f); };
  /* কীবোর্ড */
  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || !$('#modal').hidden) return;
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (ctrl && k.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (k === 'ArrowRight' || k === 'PageDown' || (S.present && k === ' ')) { goPage(1); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { goPage(-1); }
    else if (k === 'Escape') { if (uiStack.length) closeUI(); else if (S.tool === 'ocr') setTool(S.prevTool); }
    else if ((k === 'Delete' || k === 'Backspace') && S.sel >= 0) { deleteSel(); }
    else if (!ctrl && !S.present) { const m = { v: 'select', p: 'pen', h: 'hl', e: 'er', s: 'shape', t: 'text' }[k.toLowerCase()]; if (m) setTool(m); }
  });
  /* অন্যান্য */
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('fullscreenchange', () => { if (S.present) { if (!document.fullscreenElement) closeUI(); else setTimeout(fitView, 150); } });
  new ResizeObserver(() => { if (!S.page) return; const wasFit = Math.abs(S.view.s - S.view.fit) < 0.004; resizeStage(wasFit || S.present); }).observe(els.wrap);
  window.addEventListener('online', () => toast('ইন্টারনেট ফিরেছে'));
  window.addEventListener('offline', () => toast('অফলাইন মোড — সব ফিচার চলবে', 3000));
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; $('#mi-install').hidden = false; });
  window.addEventListener('appinstalled', () => { deferredInstall = null; $('#mi-install').hidden = true; toast('অ্যাপ ইনস্টল হয়েছে'); });
}

async function init() {
  cacheEls(); buildMenu(); bindUI(); bindPointer();
  setSave('ok'); setTool('pen');
  try { await Promise.all([document.fonts.load('400 40px "Noto Sans Bengali"', 'অআক'), document.fonts.load('700 40px "Noto Sans Bengali"', 'অআক')]); } catch (_) { }
  try { navigator.storage?.persist?.(); } catch (_) { }
  let id = null; try { id = localStorage.getItem('sb.last'); } catch (_) { }
  let P = null;
  try { if (id) P = await loadProject(id); } catch (e) { console.warn(e); }
  if (!P) { try { const all = await dbAll('projects'); if (all.length) P = await loadProject(all.sort((a, b) => b.updated - a.updated)[0].id); } catch (_) { } }
  if (!P) P = await firstProject();
  await openProject(P);
  $('#splash').classList.add('gone'); setTimeout(() => $('#splash').remove(), 500);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      if (!navigator.serviceWorker.controller) reg.addEventListener('updatefound', () => {
        const w = reg.installing; w && w.addEventListener('statechange', () => { if (w.state === 'activated') toast('অফলাইনে ব্যবহারের জন্য প্রস্তুত ✓', 3500); });
      });
    } catch (e) { console.warn('SW', e); }
  }
}
window.addEventListener('DOMContentLoaded', () => init().catch(e => { console.error(e); document.body.append(h('pre', { class: 'fatal' }, 'অ্যাপ চালু করা যায়নি: ' + (e.stack || e))); }));
