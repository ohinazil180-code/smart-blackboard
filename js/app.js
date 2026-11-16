'use strict';
/* ===== মূল অবস্থা, পাতা, ভিউ, টুল, হিস্ট্রি, অটো-সেভ ===== */
const COLORS = ['#ffffff', '#111111', '#39ff14', '#facc15', '#fb923c', '#f87171', '#f472b6', '#22d3ee', '#60a5fa', '#a78bfa'];
const SIZE_RANGE = { pen: [1, 30], hl: [6, 60], er: [8, 120], shape: [1, 24], text: [14, 160] };
const TOOL_LABEL = { pen: 'কলমের মোটা', hl: 'হাইলাইটারের মোটা', er: 'ইরেজারের আকার', shape: 'রেখার মোটা', text: 'ফন্টের সাইজ', select: 'মোটা / সাইজ' };

const S = {
  P: null, page: null, tool: 'pen', prevTool: 'pen', color: '#39ff14',
  sizes: { pen: 4, hl: 20, er: 34, shape: 4, text: 44 },
  shape: 'line', dash: false, fill: false, erMode: 'pixel',
  sel: -1, live: null, hidden: -1, view: { s: 1, tx: 0, ty: 0, fit: 1 },
  penKind: null, optsOpen: true, present: false, pmode: 'nav', laser: null, ocrRect: null, erRing: null,
  bgTok: 0, ocrLang: 'ben+eng'
};
const els = {};
let ctxInk = null;

/* ---------- অটো-সেভ ---------- */
let saveTimer = 0, saving = false, saveAgain = false;
function setSave(st) {
  const d = els.save;
  if (!d) return;
  d.dataset.s = st;
  d.title = { ok: 'সংরক্ষিত ✓', saving: 'সংরক্ষণ হচ্ছে…', dirty: 'পরিবর্তন সংরক্ষণের অপেক্ষায়', err: 'সংরক্ষণে সমস্যা!' }[st] || '';
  els.saveTxt.textContent = { ok: 'সংরক্ষিত', saving: 'সংরক্ষণ…', dirty: '●', err: 'ত্রুটি' }[st] || '';
}
function scheduleSave() {
  setSave('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!S.P) return;
  if (saving) { saveAgain = true; return; }
  saving = true;
  setSave('saving');
  let P = S.P;
  try {
    do {
      saveAgain = false;
      P = S.P;
      const ops = [{ s: 'projects', t: 'put', v: { id: P.id, name: P.name, updated: Date.now(), created: P.created || Date.now(), order: P.pages.map(p => p.id), cur: P.cur } }];
      const flagged = [];
      for (const p of P.pages) {
        if (p.dirty) { ops.push({ s: 'pages', t: 'put', v: { id: p.id, pid: P.id, type: p.type, w: p.w, h: p.h, grid: p.grid, bgc: p.bgc, items: p.items } }); p.dirty = false; flagged.push([p, 'dirty']); }
        if (p.blobDirty && p.blob) { ops.push({ s: 'blobs', t: 'put', k: p.id, v: p.blob }); p.blobDirty = false; flagged.push([p, 'blobDirty']); }
      }
      const del = [...P.deleted];
      for (const id of del) { ops.push({ s: 'pages', t: 'delete', k: id }); ops.push({ s: 'blobs', t: 'delete', k: id }); }
      try { await dbBatch(ops); for (const id of del) P.deleted.delete(id); }
      catch (e) { for (const [p, f] of flagged) p[f] = true; throw e; }
    } while (saveAgain);
    setSave('ok');
  } catch (e) {
    console.error('save error', e);
    setSave('err');
    toast('⚠ সংরক্ষণ ব্যর্থ — স্টোরেজ ভরে যেতে পারে। ব্যাকআপ নিন।', 5000);
  } finally { saving = false; }
}

/* ---------- হিস্ট্রি (আনডু/রিডু) — আইটেম অপরিবর্তনীয়, তাই শুধু অ্যারে স্ন্যাপশট ---------- */
function hist(p) {
  if (!p.hist) { p.hist = [p.items.slice()]; p.hi = 0; }
  return p.hist;
}
function touch(p) {
  p.dirty = true; p.thumbDirty = true;
  scheduleSave(); updateUndo();
}
function commit() {
  const p = S.page;
  hist(p);
  p.hist.length = p.hi + 1;
  p.hist.push(p.items.slice());
  if (p.hist.length > 120) p.hist.shift();
  p.hi = p.hist.length - 1;
  touch(p);
}
function undo() {
  const p = S.page; hist(p);
  if (p.hi <= 0) return;
  p.hi--; p.items = p.hist[p.hi].slice();
  S.sel = -1; S.live = null; S.hidden = -1;
  redrawInk(); drawOv(); touch(p); updateSelBar();
}
function redo() {
  const p = S.page; hist(p);
  if (p.hi >= p.hist.length - 1) return;
  p.hi++; p.items = p.hist[p.hi].slice();
  S.sel = -1; S.live = null; S.hidden = -1;
  redrawInk(); drawOv(); touch(p); updateSelBar();
}
function updateUndo() {
  const p = S.page; if (!p) return;
  hist(p);
  $('#tUndo').disabled = p.hi <= 0;
  $('#tRedo').disabled = p.hi >= p.hist.length - 1;
  const pu = $('#pUndo'); if (pu) pu.disabled = p.hi <= 0;
}

/* ---------- ক্যানভাস ও ভিউ ---------- */
function sizeCanvases() {
  const p = S.page;
  for (const c of [els.cvBg, els.cvInk, els.cvOv]) { c.width = Math.round(p.w * RES); c.height = Math.round(p.h * RES); }
  els.stage.style.width = p.w + 'px'; els.stage.style.height = p.h + 'px';
}
async function redrawBg() {
  const p = S.page, tok = ++S.bgTok;
  const bmp = await getBitmap(p).catch(() => null);
  if (tok !== S.bgTok || p !== S.page) return;
  const c = els.cvBg.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, els.cvBg.width, els.cvBg.height);
  c.setTransform(RES, 0, 0, RES, 0, 0);
  drawBg(c, p, bmp);
}
function redrawInk() {
  const p = S.page, cv = els.cvInk;
  ctxInk.setTransform(1, 0, 0, 1, 0, 0); ctxInk.clearRect(0, 0, cv.width, cv.height);
  ctxInk.setTransform(RES, 0, 0, RES, 0, 0);
  drawItems(ctxInk, p.items, { exclude: S.hidden });
}
let ovRaf = 0;
function drawOv() {
  if (ovRaf) return;
  ovRaf = requestAnimationFrame(() => { ovRaf = 0; paintOv(); });
}
function paintOv() {
  const cv = els.cvOv, c = cv.getContext('2d'), p = S.page, k = 1 / S.view.s;
  c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height);
  c.setTransform(RES, 0, 0, RES, 0, 0);
  if (S.live && S.live.t !== 'er') drawItem(c, S.live);
  if (S.tool === 'select' && !S.present && S.sel >= 0) {
    const it = (S.sel === S.hidden && S.live) ? S.live : p.items[S.sel];
    if (it) {
      const b = itemBox(it), pad = 6 * k;
      c.save(); c.strokeStyle = '#a78bfa'; c.lineWidth = 2.2 * k; c.setLineDash([8 * k, 6 * k]);
      c.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2); c.restore();
    }
  }
  if (S.erRing) {
    c.save(); c.lineWidth = 1.6 * k; c.strokeStyle = 'rgba(255,255,255,.9)'; c.fillStyle = 'rgba(255,255,255,.12)';
    c.beginPath(); c.arc(S.erRing.x, S.erRing.y, S.erRing.r, 0, 7); c.fill(); c.stroke();
    c.strokeStyle = 'rgba(0,0,0,.55)'; c.lineWidth = .8 * k; c.beginPath(); c.arc(S.erRing.x, S.erRing.y, S.erRing.r + 1.6 * k, 0, 7); c.stroke(); c.restore();
  }
  if (S.ocrRect) {
    const r = S.ocrRect, x = Math.min(r.x1, r.x2), y = Math.min(r.y1, r.y2), w = Math.abs(r.x2 - r.x1), hh = Math.abs(r.y2 - r.y1);
    c.save(); c.fillStyle = 'rgba(34,211,238,.14)'; c.fillRect(x, y, w, hh);
    c.strokeStyle = '#22d3ee'; c.lineWidth = 2.4 * k; c.setLineDash([10 * k, 7 * k]); c.strokeRect(x, y, w, hh); c.restore();
  }
  if (S.laser) {
    const { x, y } = S.laser, r = 20 * Math.max(k, 0.6);
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(.25, 'rgba(255,40,40,.95)'); g.addColorStop(1, 'rgba(255,0,0,0)');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
  }
}

function applyView() {
  const v = S.view;
  els.stage.style.transform = `translate(${v.tx}px,${v.ty}px) scale(${v.s})`;
  els.btnFit.hidden = Math.abs(v.s - v.fit) < 0.004 || S.present;
}
function clampView() {
  const v = S.view, p = S.page, r = els.wrap.getBoundingClientRect(), m = 80;
  v.tx = clamp(v.tx, m - p.w * v.s, r.width - m);
  v.ty = clamp(v.ty, m - p.h * v.s, r.height - m);
}
function fitView() {
  const r = els.wrap.getBoundingClientRect(), p = S.page, pad = S.present ? 0 : 8;
  const s = Math.min((r.width - pad * 2) / p.w, (r.height - pad * 2) / p.h);
  S.view = { s, fit: s, tx: (r.width - p.w * s) / 2, ty: (r.height - p.h * s) / 2 };
  applyView();
}
function zoomAt(cx, cy, ns) {
  const v = S.view; ns = clamp(ns, v.fit * 0.6, v.fit * 10);
  const px = (cx - v.tx) / v.s, py = (cy - v.ty) / v.s;
  v.s = ns; v.tx = cx - px * ns; v.ty = cy - py * ns;
  clampView(); applyView(); drawOv();
}
function logicalPt(e) {
  const r = els.cvOv.getBoundingClientRect(), p = S.page;
  return { x: +((e.clientX - r.left) / r.width * p.w).toFixed(1), y: +((e.clientY - r.top) / r.height * p.h).toFixed(1) };
}

/* ---------- পাতা দেখানো ---------- */
function autoColorFix() {
  const p = S.page;
  if (p.type === 'white' && S.color === '#ffffff') setColor('#111111', true);
  else if ((p.type === 'black' || p.type === 'pdf') && S.color === '#111111' && p.type === 'black') setColor('#ffffff', true);
}
async function showPage(i) {
  const P = S.P;
  i = clamp(i, 0, P.pages.length - 1);
  P.cur = i; S.page = P.pages[i];
  S.sel = -1; S.live = null; S.hidden = -1; S.erRing = null;
  hist(S.page);
  sizeCanvases(); fitView();
  redrawInk(); drawOv();
  await redrawBg();
  updatePager(); updateUndo(); updateSelBar(); autoColorFix();
  scheduleSave();
  if (!els.thumbPanel.hidden) refreshThumbSel();
}
function updatePager() {
  const n = S.P.pages.length, c = S.P.cur + 1;
  els.pageNo.textContent = `${c} / ${n}`;
  $('#pbNo').textContent = `${c} / ${n}`;
  els.btnPrev.disabled = c <= 1; els.btnNext.disabled = c >= n;
  $('#pbPrev').disabled = c <= 1; $('#pbNext').disabled = c >= n;
  els.projTitle.textContent = S.P.name;
}
const goPage = d => { const n = S.P.cur + d; if (n >= 0 && n < S.P.pages.length) showPage(n); };

/* ---------- রঙ/সাইজ/টুল সেটিংস ---------- */
function sizeKey() {
  const t = S.tool;
  if (t === 'select') { const it = S.page.items[S.sel]; return it && !it.locked ? (it.t === 'text' ? 'text' : it.t === 'hl' ? 'hl' : it.t === 'pen' ? 'pen' : 'shape') : null; }
  return { pen: 'pen', hl: 'hl', er: 'er', shape: 'shape', text: 'text' }[t] || null;
}
function replaceSel(patch, doCommit) {
  const p = S.page, it = p.items[S.sel];
  if (!it) return;
  p.items[S.sel] = { ...it, ...patch };
  redrawInk(); drawOv();
  if (doCommit) commit(); else { p.dirty = true; scheduleSave(); }
}
function setColor(c, silent) {
  S.color = c;
  $$('#swatches .sw').forEach(b => b.classList.toggle('on', b.dataset.c === c));
  $('#customColor').value = /^#[0-9a-f]{6}$/i.test(c) ? c : '#ffffff';
  if (!silent && S.tool === 'select' && S.sel >= 0) { const it = S.page.items[S.sel]; if (it && !it.locked && it.t !== 'er') replaceSel({ color: c, ...(typeof it.fill === 'string' ? { fill: c } : {}) }, true); }
}
function updateSizeUI() {
  const k = sizeKey();
  if (!k) return;
  const [a, b] = SIZE_RANGE[k];
  const r = els.size; r.min = a; r.max = b;
  let v = S.sizes[k];
  if (S.tool === 'select' && S.sel >= 0) v = S.page.items[S.sel].size;
  r.value = v; els.sizeVal.textContent = Math.round(v);
  els.sizeLbl.textContent = TOOL_LABEL[S.tool === 'select' ? 'select' : k] || 'মোটা';
}
function onSizeInput(final) {
  const k = sizeKey(); if (!k) return;
  const v = +els.size.value;
  els.sizeVal.textContent = v;
  if (S.tool === 'select' && S.sel >= 0) {
    const it = S.page.items[S.sel];
    if (!it.locked && it.t !== 'er' && (it.t !== 'rect' || it.size > 0 || v > 0)) replaceSel({ size: v }, final);
  } else S.sizes[k] = v;
  if (S.tool === 'er') { /* ইরেজার আকার */ }
}
function setTool(t) {
  if (S.tool === t && t !== 'select' && S.tool !== 'ocr') { S.optsOpen = !S.optsOpen; }
  else { if (t !== 'ocr') S.optsOpen = true; if (t === 'ocr') S.prevTool = S.tool === 'ocr' ? S.prevTool : S.tool; S.tool = t; }
  if (t !== 'select') { S.sel = -1; S.hidden = -1; }
  S.erRing = null; S.live = null; S.ocrRect = null;
  $$('#tools .tb[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === S.tool));
  updateOpts(); updateSelBar(); drawOv();
  els.wrap.dataset.tool = S.tool;
}
function updateOpts() {
  const t = S.tool, o = els.opts;
  const showShape = t === 'shape', showEr = t === 'er';
  const selectedItem = t === 'select' && S.sel >= 0 ? S.page.items[S.sel] : null;
  const showColor = ['pen', 'hl', 'shape', 'text'].includes(t) || (selectedItem && !selectedItem.locked);
  const showSize = showColor || showEr;
  const hint = t === 'select' ? (S.sel >= 0 ? '' : 'আঁকা বা লেখায় ট্যাপ করে বেছে নিন, তারপর টেনে সরান। ফাঁকা জায়গায় টেনে পাতা সরান।')
    : t === 'text' ? 'পাতায় যেখানে লিখতে চান সেখানে ট্যাপ করুন। আগের লেখায় ট্যাপ করলে সম্পাদনা হবে।'
    : t === 'ocr' ? 'যে অংশের লেখা চিনতে চান সেই অংশ আঙুল দিয়ে টেনে ঘিরে ফেলুন।' : '';
  $('#rowShape').hidden = !showShape; $('#rowEr').hidden = !showEr;
  $('#rowColor').hidden = !showColor; $('#rowSize').hidden = !showSize;
  const hh = $('#rowHint'); hh.hidden = !hint; hh.textContent = hint;
  o.hidden = !S.optsOpen || (!showShape && !showEr && !showColor && !showSize && !hint);
  $$('#rowShape [data-shape]').forEach(b => b.classList.toggle('on', b.dataset.shape === S.shape));
  $('#optDash').classList.toggle('on', S.dash); $('#optFill').classList.toggle('on', S.fill);
  $$('#rowEr [data-er]').forEach(b => b.classList.toggle('on', b.dataset.er === S.erMode));
  if (showSize) updateSizeUI();
  setColor(S.color, true);
  requestAnimationFrame(() => { if (S.page && !S.present) { const wasFit = Math.abs(S.view.s - S.view.fit) < 0.004; resizeStage(wasFit); } });
}
function resizeStage(refit) {
  if (!S.page) return;
  const r = els.wrap.getBoundingClientRect(), p = S.page, pad = S.present ? 0 : 8;
  const nf = Math.min((r.width - pad * 2) / p.w, (r.height - pad * 2) / p.h);
  if (refit) fitView(); else { S.view.fit = nf; applyView(); }
}

/* ---------- নির্বাচন বার ---------- */
function updateSelBar() {
  const show = S.tool === 'select' && S.sel >= 0 && !S.present && S.page.items[S.sel];
  els.selBar.hidden = !show;
  if (show) {
    const it = S.page.items[S.sel], locked = !!it.locked;
    $('#selEdit').hidden = locked || it.t !== 'text';
    $('#selLock').classList.toggle('locked', locked);
    $('#selLock').setAttribute('aria-label', locked ? 'আনলক করুন' : 'লক করুন');
    $('#selLock').title = locked ? 'আনলক করুন' : 'লক করুন';
    $('#selLock use').setAttribute('href', locked ? '#i-unlock' : '#i-lock');
    $('#selDup').disabled = locked; $('#selDel').disabled = locked;
  }
  if (S.tool === 'select') updateOpts();
}
function toggleSelLock() {
  const p = S.page, it = p && p.items[S.sel];
  if (!it) return;
  p.items = p.items.slice(); p.items[S.sel] = { ...it, locked: !it.locked };
  commit(); redrawInk(); drawOv(); updateSelBar();
  toast(p.items[S.sel].locked ? 'অবজেক্ট সুরক্ষিত করা হয়েছে' : 'অবজেক্ট আনলক করা হয়েছে');
}
function deleteSel() {
  const p = S.page; if (S.sel < 0) return;
  if (p.items[S.sel]?.locked) return toast('অবজেক্টটি সুরক্ষিত — আগে আনলক করুন');
  p.items = p.items.filter((_, i) => i !== S.sel);
  S.sel = -1; S.hidden = -1; commit(); redrawInk(); drawOv(); updateSelBar();
}
function dupSel() {
  const p = S.page, it = p.items[S.sel]; if (!it) return;
  if (it.locked) return toast('অবজেক্টটি সুরক্ষিত — আগে আনলক করুন');
  p.items = [...p.items, moveItem(it, 32, 32)];
  S.sel = p.items.length - 1; commit(); redrawInk(); drawOv(); updateSelBar();
}

/* ---------- পয়েন্টার: আঁকা, মোছা, সরানো, পিঞ্চ-জুম ---------- */
const ptrs = new Map();
let gesture = null, pinch = null, drag = null, navStart = null, textTap = null, lastP = null;

function effTool() {
  if (S.present) {
    if (S.pmode === 'nav') return 'nav';
    if (S.pmode === 'laser') return 'laser';
    return ['pen', 'hl', 'er', 'shape'].includes(S.tool) ? S.tool : 'pen';
  }
  return S.tool;
}
function eraseSegPixel(a, b) {
  const c = ctxInk;
  c.save(); c.setTransform(RES, 0, 0, RES, 0, 0);
  c.globalCompositeOperation = 'destination-out'; c.lineCap = 'round'; c.lineJoin = 'round';
  c.lineWidth = S.sizes.er; c.strokeStyle = '#000'; c.fillStyle = '#000';
  if (a[0] === b[0] && a[1] === b[1]) { c.beginPath(); c.arc(a[0], a[1], S.sizes.er / 2, 0, 7); c.fill(); }
  else { c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
  c.restore();
}
function eraseObjectsAt(x, y) {
  const p = S.page, r = S.sizes.er / 2 * 0.8;
  const keep = p.items.filter(it => it.locked || !itemHit(it, x, y, r));
  if (keep.length !== p.items.length) { p.items = keep; return true; }
  return false;
}
function snapLine(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, a = Math.abs(Math.atan2(dy, dx)) * 180 / Math.PI;
  if (a < 3 || a > 177) return [x2, y1];
  if (Math.abs(a - 90) < 3) return [x1, y2];
  return [x2, y2];
}

function toolDown(e) {
  const t = effTool(), p = logicalPt(e), pg = S.page;
  lastP = [p.x, p.y];
  if (t === 'nav') { navStart = { x: e.clientX, y: e.clientY, t: Date.now() }; return; }
  if (t === 'laser') { S.laser = p; drawOv(); return; }
  if (t === 'pen' || t === 'hl') {
    S.live = { t, color: S.color, size: S.sizes[t], pts: [[p.x, p.y]], kind: t === 'pen' ? S.penKind : null }; drawOv();
  } else if (t === 'er') {
    S.erRing = { x: p.x, y: p.y, r: S.sizes.er / 2 };
    if (S.erMode === 'pixel') { S.live = { t: 'er', size: S.sizes.er, pts: [[p.x, p.y]] }; eraseSegPixel([p.x, p.y], [p.x, p.y]); }
    else { S.erased = eraseObjectsAt(p.x, p.y); if (S.erased) redrawInk(); }
    drawOv();
  } else if (t === 'shape') {
    S.live = { t: S.shape, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: S.color, size: S.sizes.shape, dash: S.dash, fill: S.fill }; drawOv();
  } else if (t === 'text') {
    textTap = { x: p.x, y: p.y, cx: e.clientX, cy: e.clientY, moved: false };
  } else if (t === 'ocr') {
    S.ocrRect = { x1: p.x, y1: p.y, x2: p.x, y2: p.y }; drawOv();
  } else if (t === 'select') {
    const r = 16 / S.view.s;
    let hit = -1;
    for (let i = pg.items.length - 1; i >= 0; i--) if (itemHit(pg.items[i], p.x, p.y, r)) { hit = i; break; }
    if (hit >= 0) {
      const item = pg.items[hit], wasSel = S.sel === hit;
      S.sel = hit;
      if (item.locked) {
        S.hidden = -1; S.live = null; drag = null;
        redrawInk(); drawOv(); updateSelBar();
      } else {
        S.hidden = hit;
        drag = { kind: 'move', orig: item, sx: p.x, sy: p.y, moved: false, wasSel };
        S.live = drag.orig; redrawInk(); drawOv(); updateSelBar();
      }
    } else {
      const had = S.sel >= 0; S.sel = -1; S.hidden = -1;
      drag = { kind: 'pan', cx: e.clientX, cy: e.clientY, tx: S.view.tx, ty: S.view.ty, moved: false, had };
      updateSelBar(); drawOv();
    }
  }
}
function toolMove(e) {
  const t = effTool();
  if (t === 'nav') return;
  const evs = (t === 'pen' || t === 'hl' || t === 'er') && e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  const list = evs.length ? evs : [e];
  for (const ev of list) toolMoveOne(ev, t);
}
function toolMoveOne(e, t) {
  const p = logicalPt(e);
  if (t === 'laser') { S.laser = p; drawOv(); return; }
  if (t === 'pen' || t === 'hl') {
    const l = S.live; if (!l) return;
    const lp = l.pts[l.pts.length - 1];
    if (Math.hypot(p.x - lp[0], p.y - lp[1]) < 1.3) return;
    l.pts.push([p.x, p.y]); drawOv();
  } else if (t === 'er') {
    S.erRing = { x: p.x, y: p.y, r: S.sizes.er / 2 };
    if (S.erMode === 'pixel') {
      if (!S.live) return;
      const lp = S.live.pts[S.live.pts.length - 1];
      S.live.pts.push([p.x, p.y]); eraseSegPixel(lp, [p.x, p.y]);
    } else {
      const a = lastP || [p.x, p.y], d = Math.hypot(p.x - a[0], p.y - a[1]), step = Math.max(4, S.sizes.er / 3), n = Math.ceil(d / step);
      let ch = false;
      for (let i = 1; i <= n; i++) ch = eraseObjectsAt(a[0] + (p.x - a[0]) * i / n, a[1] + (p.y - a[1]) * i / n) || ch;
      if (ch) { S.erased = true; redrawInk(); }
      lastP = [p.x, p.y];
    }
    drawOv();
  } else if (t === 'shape') {
    const l = S.live; if (!l) return;
    let x2 = p.x, y2 = p.y;
    if (l.t === 'line' || l.t === 'arrow') [x2, y2] = snapLine(l.x1, l.y1, x2, y2);
    l.x2 = x2; l.y2 = y2; drawOv();
  } else if (t === 'text') {
    if (textTap && Math.hypot(e.clientX - textTap.cx, e.clientY - textTap.cy) > 10) textTap.moved = true;
  } else if (t === 'ocr') {
    if (S.ocrRect) { S.ocrRect.x2 = p.x; S.ocrRect.y2 = p.y; drawOv(); }
  } else if (t === 'select' && drag) {
    if (drag.kind === 'move') {
      const dx = p.x - drag.sx, dy = p.y - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) * S.view.s < 4) return;
      drag.moved = true; S.live = moveItem(drag.orig, dx, dy); drawOv();
    } else {
      const dx = e.clientX - drag.cx, dy = e.clientY - drag.cy;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true; S.view.tx = drag.tx + dx; S.view.ty = drag.ty + dy; clampView(); applyView();
    }
  }
}
function toolUp(e) {
  const t = effTool(), pg = S.page;
  if (t === 'nav') {
    if (!navStart) return;
    const dx = e.clientX - navStart.x, dy = e.clientY - navStart.y;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 80) goPage(dx < 0 ? 1 : -1);
    else if (Math.hypot(dx, dy) < 14) {
      const r = els.wrap.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width;
      if (fx < 0.3) goPage(-1); else if (fx > 0.7) goPage(1); else togglePresentBar();
    }
    navStart = null; return;
  }
  if (t === 'laser') { S.laser = null; drawOv(); return; }
  if (t === 'pen' || t === 'hl') {
    const l = S.live; S.live = null;
    if (l) { pg.items = [...pg.items, l]; commit(); redrawInk(); }
    drawOv();
  } else if (t === 'er') {
    S.erRing = (e.pointerType === 'mouse') ? S.erRing : null;
    if (S.erMode === 'pixel') {
      const l = S.live; S.live = null;
      if (l) { pg.items = [...pg.items, l]; commit(); redrawInk(); }
    } else if (S.erased) { S.erased = false; commit(); }
    drawOv();
  } else if (t === 'shape') {
    const l = S.live; S.live = null;
    if (l && (Math.abs(l.x2 - l.x1) > 4 || Math.abs(l.y2 - l.y1) > 4)) { pg.items = [...pg.items, l]; commit(); redrawInk(); }
    drawOv();
  } else if (t === 'text') {
    const tp = textTap; textTap = null;
    if (tp && !tp.moved) {
      let idx = -1;
      for (let i = pg.items.length - 1; i >= 0; i--) if (pg.items[i].t === 'text' && itemHit(pg.items[i], tp.x, tp.y, 6)) { idx = i; break; }
      editText(idx, tp.x, tp.y);
    }
  } else if (t === 'ocr') {
    const r = S.ocrRect; S.ocrRect = null; drawOv();
    if (r && Math.abs(r.x2 - r.x1) > 20 && Math.abs(r.y2 - r.y1) > 14) { const pt = S.prevTool; setTool(pt === 'ocr' ? 'pen' : pt); runOCR(r); }
    else toast('অংশটি আরও বড় করে বেছে নিন');
  } else if (t === 'select' && drag) {
    const d = drag; drag = null;
    if (d.kind === 'move') {
      if (d.moved && S.live) { pg.items = pg.items.slice(); pg.items[S.sel] = S.live; S.live = null; S.hidden = -1; commit(); }
      else {
        S.live = null; S.hidden = -1;
        if (d.wasSel && pg.items[S.sel] && pg.items[S.sel].t === 'text') { redrawInk(); drawOv(); editText(S.sel, 0, 0); return; }
      }
      redrawInk(); drawOv(); updateSelBar();
    }
  }
}
function toolCancel() {
  S.live = null; S.hidden = -1; S.ocrRect = null; textTap = null; navStart = null; S.laser = null;
  if (drag) { drag = null; }
  if (S.erased) { S.erased = false; S.page.items = S.page.hist[S.page.hi].slice(); }
  redrawInk(); drawOv(); updateSelBar();
}

function pinchStart() {
  const [a, b] = [...ptrs.values()];
  pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: { ...S.view } };
}
function pinchMove() {
  const [a, b] = [...ptrs.values()];
  const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, r = els.wrap.getBoundingClientRect();
  const m = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
  const v0 = pinch.v0, m0x = pinch.m0.x - r.left, m0y = pinch.m0.y - r.top;
  const s = clamp(v0.s * d / pinch.d0, v0.fit * 0.6, v0.fit * 10);
  const px = (m0x - v0.tx) / v0.s, py = (m0y - v0.ty) / v0.s;
  S.view.s = s; S.view.tx = m.x - px * s; S.view.ty = m.y - py * s;
  clampView(); applyView();
}

function bindPointer() {
  const w = els.wrap;
  w.addEventListener('pointerdown', e => {
    if (e.target.closest('.floating')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { w.setPointerCapture(e.pointerId); } catch (_) { }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) { gesture = 'tool'; toolDown(e); }
    else if (ptrs.size === 2) { if (gesture === 'tool') toolCancel(); gesture = 'pinch'; pinchStart(); }
    else gesture = 'dead';
  });
  w.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) {
      if (e.pointerType === 'mouse' && effTool() === 'er' && !S.present) { const p = logicalPt(e); S.erRing = { x: p.x, y: p.y, r: S.sizes.er / 2 }; drawOv(); }
      return;
    }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture === 'pinch' && ptrs.size >= 2) pinchMove();
    else if (gesture === 'tool') toolMove(e);
  });
  const up = e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (gesture === 'tool' && ptrs.size === 0) { if (e.type === 'pointercancel') toolCancel(); else toolUp(e); gesture = null; }
    else if (gesture === 'pinch') { gesture = ptrs.size === 0 ? null : 'dead'; pinch = null; }
    else if (gesture === 'dead' && ptrs.size === 0) gesture = null;
  };
  w.addEventListener('pointerup', up);
  w.addEventListener('pointercancel', up);
  w.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !ptrs.size && S.erRing) { S.erRing = null; drawOv(); } });
  w.addEventListener('wheel', e => {
    e.preventDefault();
    const r = w.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, S.view.s * Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  w.addEventListener('contextmenu', e => e.preventDefault());
}
