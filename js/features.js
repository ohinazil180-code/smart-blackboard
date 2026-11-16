'use strict';
/* =====================================================================
   নতুন ফিচার: লেজার (রিপিট ট্রেইল, রঙ), নতুন শেপ, কলমের ধরন,
   লোডিং স্ক্রিন। মূল render/app ফাইল বদলায় না — উপরের স্তরে যোগ হয়।
   ===================================================================== */

/* ---------- ১. নতুন শেপ: তারা, পঞ্চভুজ, ষড়ভুজ, হীরা ---------- */
const FX_SHAPES = new Set(['star', 'pent', 'hex', 'dia']);
for (const t of FX_SHAPES) SHAPES.add(t);

function fxPoly(it) {
  const x = Math.min(it.x1, it.x2), y = Math.min(it.y1, it.y2);
  const w = Math.abs(it.x2 - it.x1), hh = Math.abs(it.y2 - it.y1);
  const cx = x + w / 2, cy = y + hh / 2, rx = w / 2, ry = hh / 2;
  const pts = [];
  if (it.t === 'star') {
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5, f = i % 2 ? 0.45 : 1;
      pts.push([cx + rx * f * Math.cos(a), cy + ry * f * Math.sin(a)]);
    }
  } else if (it.t === 'pent' || it.t === 'hex') {
    const n = it.t === 'pent' ? 5 : 6;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
    }
  } else if (it.t === 'dia') {
    pts.push([cx, y], [x + w, cy], [cx, y + hh], [x, cy]);
  }
  return pts;
}
const _shapePoly = shapePoly;
shapePoly = function (it) { return FX_SHAPES.has(it.t) ? fxPoly(it) : _shapePoly(it); };

const _drawItem = drawItem;
drawItem = function (ctx, it, ov) {
  if (!FX_SHAPES.has(it.t)) {
    if (it.t === 'pen' && it.kind) return drawPenKind(ctx, it, ov);
    return _drawItem(ctx, it, ov);
  }
  const col = ov || it.color, pts = fxPoly(it);
  if (!pts.length) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  if (it.fill) {
    ctx.save();
    if (typeof it.fill === 'string') ctx.fillStyle = ov || it.fill; else { ctx.fillStyle = col; ctx.globalAlpha = 0.28; }
    ctx.fill(); ctx.restore();
  }
  if (it.size > 0) {
    ctx.strokeStyle = col; ctx.lineWidth = it.size;
    if (it.dash) ctx.setLineDash([it.size * 2.6, it.size * 2.2]);
    ctx.stroke();
  }
  ctx.restore();
};

/* ---------- ২. কলমের ধরন: মার্কার, ঝিলিক (গ্লো), ড্যাশ ---------- */
const PEN_KINDS = [
  { k: null, label: 'সাধারণ' },
  { k: 'marker', label: 'মার্কার' },
  { k: 'glow', label: 'গ্লো' },
  { k: 'dash', label: 'ড্যাশ' }
];
function drawPenKind(ctx, it, ov) {
  const col = ov || it.color;
  const pts = it.pts; if (!pts || !pts.length) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = col; ctx.fillStyle = col;
  ctx.lineWidth = it.size;
  if (it.kind === 'marker') { ctx.globalAlpha = 0.85; ctx.lineWidth = it.size * 1.5; ctx.lineCap = 'square'; }
  if (it.kind === 'glow') { ctx.shadowColor = col; ctx.shadowBlur = it.size * 3; }
  if (it.kind === 'dash') ctx.setLineDash([it.size * 2.2, it.size * 1.8]);
  ctx.beginPath();
  if (pts.length === 1) { ctx.arc(pts[0][0], pts[0][1], ctx.lineWidth / 2, 0, 7); ctx.fill(); }
  else {
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const l = pts[pts.length - 1]; ctx.lineTo(l[0], l[1]); ctx.stroke();
  }
  ctx.restore();
}

/* কলম-ধরনের বাটন (ডক-এ, শুধু কলম টুল সক্রিয় থাকলে) */
function buildPenKindRow() {
  const dock = $('#opts'); if (!dock || $('#rowPenKind')) return;
  const row = h('div', { class: 'orow', id: 'rowPenKind' },
    ...PEN_KINDS.map(p => h('button', {
      class: 'chip', 'data-pk': p.k || 'normal',
      onclick: () => { S.penKind = p.k; markPenKind(); }
    }, p.label)));
  dock.insertBefore(row, $('#rowColor'));
}
function markPenKind() {
  $$('#rowPenKind [data-pk]').forEach(b => b.classList.toggle('on', (b.dataset.pk === 'normal' ? null : b.dataset.pk) === S.penKind));
}

/* ---------- ৩. লেজার: রঙ, ট্রেইল, ছেড়ে দিলে স্বয়ংক্রিয় রিপিট ---------- */
const LASER = {
  color: '#ff2828',
  colors: ['#ff2828', '#39ff14', '#22d3ee', '#facc15', '#f472b6', '#ffffff'],
  trail: [],        // {x,y}
  releasedAt: 0,    // ছাড়ার সময় (ms), 0 = এখনো ধরা
  repeats: 4,       // কয়বার পুনরাবৃত্তি
  gap: 450,         // দুই পুনরাবৃত্তির ব্যবধান (ms)
  life: 900         // প্রতিটি পুনরাবৃত্তির আয়ু (ms)
};
const laserEnd = () => LASER.releasedAt + (LASER.repeats - 1) * LASER.gap + LASER.life;

function laserTrack() {
  const now = performance.now();
  if (S.laser && S.pmode === 'laser') {
    if (LASER.releasedAt) { LASER.trail = []; LASER.releasedAt = 0; }   // নতুন টান শুরু
    const last = LASER.trail[LASER.trail.length - 1];
    if (!last || last.x !== S.laser.x || last.y !== S.laser.y) {
      LASER.trail.push({ x: S.laser.x, y: S.laser.y, t: now });
      if (LASER.trail.length > 800) LASER.trail.shift();
    }
  } else if (LASER.trail.length && !LASER.releasedAt) {
    LASER.releasedAt = now;      // ছেড়ে দেওয়া হলো
  }
}

function laserPaint(c) {
  const now = performance.now();
  const tr = LASER.trail;
  if (!tr.length) return false;
  c.save();
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.strokeStyle = LASER.color; c.shadowColor = LASER.color;
  const strokeTrail = alpha => {
    if (tr.length < 2) return;
    c.globalAlpha = alpha; c.lineWidth = 5; c.shadowBlur = 16;
    c.beginPath(); c.moveTo(tr[0].x, tr[0].y);
    for (let i = 1; i < tr.length; i++) c.lineTo(tr[i].x, tr[i].y);
    c.stroke();
  };
  if (!LASER.releasedAt) {
    // ধরা অবস্থায়: উজ্জ্বল ট্রেইল + মাথা
    strokeTrail(1);
  } else {
    // ছাড়ার পর: কয়েকবার ফেড-আউট পুনরাবৃত্তি
    const e = now - LASER.releasedAt;
    for (let r = 0; r < LASER.repeats; r++) {
      const start = r * LASER.gap, age = e - start;
      if (age < 0 || age > LASER.life) continue;
      strokeTrail(Math.max(0, 1 - age / LASER.life) * 0.95);
    }
    if (e > laserEnd()) { LASER.trail = []; LASER.releasedAt = 0; c.restore(); return false; }
  }
  const head = tr[tr.length - 1];
  c.shadowBlur = 22; c.globalAlpha = LASER.releasedAt ? Math.max(0, 1 - (now - LASER.releasedAt) / laserEnd()) : 1;
  c.fillStyle = LASER.color; c.beginPath(); c.arc(head.x, head.y, 7, 0, 7); c.fill();
  c.restore();
  return true;
}

const _paintOv = paintOv;
let laserActive = false;
paintOv = function () {
  _paintOv();
  laserTrack();
  const c = els.cvOv.getContext('2d');
  c.setTransform(RES, 0, 0, RES, 0, 0);
  const running = S.pmode === 'laser' && (S.laser || LASER.trail.length);
  const drew = laserPaint(c);
  // ট্রেইল চলতে থাকলে পরের ফ্রেমের জন্য আবার আঁকার অনুরোধ
  if (drew || running) drawOv();
  laserActive = drew;
};

/* লেজার রঙের বাটন (প্রেজেন্টেশন বার) */
function buildLaserColors() {
  const bar = $('#presentBar'); if (!bar || $('#laserColors')) return;
  const row = h('span', { id: 'laserColors', hidden: true },
    ...LASER.colors.map(col => h('button', {
      class: 'dotc', style: `background:${col}`, 'aria-label': 'লেজার রঙ ' + col,
      onclick: () => { LASER.color = col; markLaserColor(); }
    })));
  bar.insertBefore(row, $('#pExit').previousElementSibling);
}
function markLaserColor() {
  $$('#laserColors .dotc').forEach((b, i) => b.classList.toggle('on', LASER.colors[i] === LASER.color));
}
const _updatePresentUI = updatePresentUI;
updatePresentUI = function () {
  _updatePresentUI();
  const lc = $('#laserColors'); if (lc) lc.hidden = S.pmode !== 'laser';
  const pd = $('#rowPenKind'); if (pd) pd.hidden = S.tool !== 'pen';
};

/* ---------- ৪. UI বাটন যোগ করা ---------- */
function buildShapeButtons() {
  const row = $('#rowShape'); if (!row || $('[data-shape="star"]')) return;
  const sp = row.querySelector('.sp');
  const add = (shape, label, aria) => {
    const b = h('button', { class: 'chip sq', 'data-shape': shape, 'aria-label': aria, style: 'font-size:18px;line-height:1' }, label);
    b.onclick = () => { S.shape = shape; updateOpts(); };
    row.insertBefore(b, sp);
  };
  add('star', '★', 'তারা');
  add('pent', '⬟', 'পঞ্চভুজ');
  add('hex', '⬢', 'ষড়ভুজ');
  add('dia', '◆', 'হীরা');
}

function fxInit() {
  buildShapeButtons();
  buildPenKindRow();
  markPenKind();
  buildLaserColors();
  markLaserColor();
  // লোডিং স্ক্রিন বন্ধ হওয়ার পরে একবার পেইন্ট
  drawOv();
}
window.addEventListener('DOMContentLoaded', () => setTimeout(() => { try { fxInit(); } catch (e) { console.error('features', e); } }, 0));

/* =====================================================================
   দ্বিতীয় ধাপ: আরও শেপ, কলমের "ক্যালিগ্রাফি", বাড়তি রঙ, লেখার
   বিকল্প, বোর্ডে ছবি বসানো (ঘোরানো/উল্টানো), PDF ব্যাকগ্রাউন্ড
   ===================================================================== */

/* ---------- আরও শেপ: প্লাস, ক্রস, হৃদয়, দ্বিমুখী তীর ---------- */
for (const t of ['plus', 'cross', 'heart', 'darr']) { SHAPES.add(t); FX_SHAPES.add(t); }
const _fxPoly = fxPoly;
fxPoly = function (it) {
  const x = Math.min(it.x1, it.x2), y = Math.min(it.y1, it.y2);
  const w = Math.abs(it.x2 - it.x1), hh = Math.abs(it.y2 - it.y1);
  if (it.t === 'plus' || it.t === 'cross') {
    // ১২-বিন্দু ক্রস-আকৃতি, মাঝের বাহু সমান
    const cx = x + w / 2, cy = y + hh / 2, a = Math.min(w, hh) * 0.18, rx = w / 2, ry = hh / 2;
    const base = [[-a, -ry], [a, -ry], [a, -a], [rx, -a], [rx, a], [a, a], [a, ry], [-a, ry], [-a, a], [-rx, a], [-rx, -a], [-a, -a]];
    const ang = it.t === 'cross' ? Math.PI / 4 : 0;
    return base.map(([px, py]) => [cx + px * Math.cos(ang) - py * Math.sin(ang), cy + px * Math.sin(ang) + py * Math.cos(ang)]);
  }
  if (it.t === 'heart' || it.t === 'darr') return [[x, y], [x + w, y], [x + w, y + hh], [x, y + hh]];
  return _fxPoly(it);
};

const _drawItem2 = drawItem;
drawItem = function (ctx, it, ov) {
  if (it.t === 'pic') return drawPic(ctx, it);
  if (it.t === 'heart' || it.t === 'darr') {
    const col = ov || it.color;
    const x = Math.min(it.x1, it.x2), y = Math.min(it.y1, it.y2);
    const w = Math.abs(it.x2 - it.x1), hh = Math.abs(it.y2 - it.y1);
    ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = it.size;
    if (it.dash) ctx.setLineDash([it.size * 2.6, it.size * 2.2]);
    ctx.beginPath();
    if (it.t === 'heart') {
      const cx = x + w / 2;
      ctx.moveTo(cx, y + hh * 0.3);
      ctx.bezierCurveTo(cx, y, x, y, x, y + hh * 0.38);
      ctx.bezierCurveTo(x, y + hh * 0.7, cx, y + hh * 0.82, cx, y + hh);
      ctx.bezierCurveTo(cx, y + hh * 0.82, x + w, y + hh * 0.7, x + w, y + hh * 0.38);
      ctx.bezierCurveTo(x + w, y, cx, y, cx, y + hh * 0.3);
      if (it.fill) { ctx.save(); ctx.globalAlpha = typeof it.fill === 'string' ? 1 : 0.28; ctx.fillStyle = typeof it.fill === 'string' ? (ov || it.fill) : col; ctx.fill(); ctx.restore(); }
      ctx.stroke();
    } else {
      // দ্বিমুখী তীর: দুই প্রান্তেই মাথা
      const x1 = it.x1, y1 = it.y1, x2 = it.x2, y2 = it.y2;
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      const a = Math.atan2(y2 - y1, x2 - x1), L = Math.max(16, it.size * 4.5);
      for (const [px, py, dir] of [[x2, y2, a], [x1, y1, a + Math.PI]]) {
        ctx.moveTo(px, py); ctx.lineTo(px - L * Math.cos(dir - 0.45), py - L * Math.sin(dir - 0.45));
        ctx.moveTo(px, py); ctx.lineTo(px - L * Math.cos(dir + 0.45), py - L * Math.sin(dir + 0.45));
      }
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
  return _drawItem2(ctx, it, ov);
};

/* ---------- কলমের ক্যালিগ্রাফি ধরন ---------- */
PEN_KINDS.splice(3, 0, { k: 'calli', label: 'ক্যালি' });
const _drawPenKind = drawPenKind;
drawPenKind = function (ctx, it, ov) {
  if (it.kind !== 'calli') return _drawPenKind(ctx, it, ov);
  const pts = it.pts; if (!pts || pts.length < 2) return _drawPenKind(ctx, { ...it, kind: null }, ov);
  // কোণযুক্ত নিবের মতো: একই পথ তিনটি সমান্তরাল স্ট্রোকে আঁকা
  const col = ov || it.color, a = -Math.PI / 4, nx = Math.cos(a) * it.size * 0.45, ny = Math.sin(a) * it.size * 0.45;
  ctx.save(); ctx.lineCap = 'butt'; ctx.lineJoin = 'round'; ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, it.size * 0.35);
  for (const k of [-1, 0, 1]) {
    ctx.beginPath(); ctx.moveTo(pts[0][0] + nx * k, pts[0][1] + ny * k);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] + nx * k, pts[i][1] + ny * k);
    ctx.stroke();
  }
  ctx.restore();
};

/* ---------- বাড়তি রঙ ---------- */
const FX_EXTRA_COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#8ce99a', '#38d9a9', '#4dabf7', '#748ffc', '#da77f2', '#f783ac', '#adb5bd', '#495057', '#ffffff'];
function buildExtraColors() {
  const box = $('#swatches'); if (!box || box.querySelector('[data-fx]')) return;
  for (const c of FX_EXTRA_COLORS) {
    box.append(h('button', { class: 'sw', 'data-c': c, 'data-fx': '1', style: `background:${c}`, 'aria-label': 'রঙ ' + c, onclick: () => setColor(c) }));
  }
}

/* ---------- লেখা ও শেপের বিকল্প (নির্বাচিত আইটেমে) ---------- */
function fxMutate(fn) {
  const p = S.page;
  if (S.sel < 0 || !p.items[S.sel]) return toast('আগে একটি লেখা, ছবি বা আকৃতি নির্বাচন করুন');
  if (p.items[S.sel].locked) return toast('অবজেক্টটি সুরক্ষিত — আগে আনলক করুন');
  const n = { ...p.items[S.sel] };
  fn(n);
  p.items[S.sel] = n;
  commit(); redrawInk(); drawOv(); updateSelBar();
}
function moveLayer(direction) {
  const page = S.page, index = S.sel;
  if (!page || index < 0 || !page.items[index]) return;
  const next = direction === 'front' ? page.items.length - 1 : 0;
  if (index === next) return toast(direction === 'front' ? 'অবজেক্টটি সামনেই আছে' : 'অবজেক্টটি পেছনেই আছে');
  const [item] = page.items.splice(index, 1);
  page.items.splice(next, 0, item);
  S.sel = next;
  commit(); redrawInk(); drawOv(); updateSelBar();
}
function buildEditRow() {
  const dock = $('#opts'); if (!dock || $('#rowEdit')) return;
  const b = (label, aria, fn) => h('button', { class: 'chip', 'aria-label': aria, title: aria, onclick: () => fxMutate(fn) }, label);
  const action = (label, aria, fn) => h('button', { class: 'chip', 'aria-label': aria, title: aria, onclick: fn }, label);
  const row = h('div', { class: 'orow', id: 'rowEdit', hidden: true },
    b('B', 'বোল্ড', it => { if (it.t === 'text') it.bold = !it.bold; }),
    b('I', 'ইটালিক', it => { if (it.t === 'text') it.it = !it.it; }),
    b('⇤', 'বামে', it => { if (it.t === 'text') it.align = 'left'; }),
    b('⇥', 'মাঝে', it => { if (it.t === 'text') it.align = 'center'; }),
    b('A+', 'বড়', it => { if (it.t === 'text') it.size = Math.min(160, (it.size || 44) + 4); }),
    b('A−', 'ছোট', it => { if (it.t === 'text') it.size = Math.max(10, (it.size || 44) - 4); }),
    b('↶', '১৫° বাঁ দিকে ঘোরান', it => { if (SHAPES.has(it.t) || it.t === 'text') it.rot = (it.rot || 0) - Math.PI / 12; }),
    b('↷', '১৫° ডান দিকে ঘোরান', it => { if (SHAPES.has(it.t) || it.t === 'text') it.rot = (it.rot || 0) + Math.PI / 12; }),
    b('ভরাট', 'শেপ ভরাট চালু বা বন্ধ', it => { if (SHAPES.has(it.t) && !['line', 'arrow'].includes(it.t)) it.fill = !it.fill; }),
    action('↟', 'সবার সামনে আনুন', () => moveLayer('front')),
    action('↡', 'পেছনে পাঠান', () => moveLayer('back')),
    b('↻', 'ছবি ঘোরান', it => { if (it.t === 'pic') it.rot = ((it.rot || 0) + Math.PI / 2) % (Math.PI * 2); }),
    b('↔', 'ছবি উল্টান', it => { if (it.t === 'pic') it.flip = !it.flip; })
  );
  dock.insertBefore(row, $('#rowColor'));
}
const _updateOpts = updateOpts;
updateOpts = function () {
  _updateOpts();
  const sel = S.sel >= 0 ? S.page && S.page.items[S.sel] : null;
  const r = $('#rowEdit'); if (r) r.hidden = !(sel && !sel.locked && (sel.t === 'text' || sel.t === 'pic' || SHAPES.has(sel.t)));
  if (r) {
    const canFill = !!(sel && SHAPES.has(sel.t) && !['line', 'arrow'].includes(sel.t));
    r.querySelector('[aria-label="শেপ ভরাট চালু বা বন্ধ"]')?.toggleAttribute('hidden', !canFill);
    r.querySelector('[aria-label="ছবি ঘোরান"]')?.toggleAttribute('hidden', sel?.t !== 'pic');
    r.querySelector('[aria-label="ছবি উল্টান"]')?.toggleAttribute('hidden', sel?.t !== 'pic');
    r.querySelectorAll('[aria-label="১৫° বাঁ দিকে ঘোরান"], [aria-label="১৫° ডান দিকে ঘোরান"]').forEach(button => button.hidden = !(sel && (SHAPES.has(sel.t) || sel.t === 'text')));
    r.querySelectorAll('[aria-label="সবার সামনে আনুন"], [aria-label="পেছনে পাঠান"]').forEach(button => button.hidden = !sel);
    r.querySelectorAll('[aria-label="বোল্ড"], [aria-label="ইটালিক"], [aria-label="বামে"], [aria-label="মাঝে"], [aria-label="বড়"], [aria-label="ছোট"]').forEach(button => button.hidden = sel?.t !== 'text');
  }
  const pk = $('#rowPenKind'); if (pk) pk.hidden = S.tool !== 'pen';
};

/* ছবি/হৃদয়/দ্বিমুখী তীরের জন্য বাউন্ডিং-বক্স দিয়ে নির্বাচন */
const _itemHit = itemHit;
itemHit = function (it, x, y, r) {
  if (it.t === 'pic' || it.t === 'heart' || it.t === 'darr') {
    const b = itemBox(it);
    return x >= b.x - r && x <= b.x + b.w + r && y >= b.y - r && y <= b.y + b.h + r;
  }
  return _itemHit(it, x, y, r);
};

/* ---------- বোর্ডে ছবি বসানো ---------- */
const picCache = new Map();   // src -> HTMLImageElement
function getPicImg(src) {
  let im = picCache.get(src);
  if (!im) {
    im = new Image();
    im.onload = () => { if (S.page) redrawInk(); };
    im.src = src;
    picCache.set(src, im);
  }
  return im;
}
function drawPic(ctx, it) {
  const x = Math.min(it.x1, it.x2), y = Math.min(it.y1, it.y2);
  const w = Math.abs(it.x2 - it.x1), hh = Math.abs(it.y2 - it.y1);
  const cx = x + w / 2, cy = y + hh / 2;
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(it.rot || 0); ctx.scale(it.flip ? -1 : 1, 1);
  const im = getPicImg(it.src);
  if (im.complete && im.naturalWidth) ctx.drawImage(im, -w / 2, -hh / 2, w, hh);
  else { ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 2; ctx.setLineDash([8, 6]); ctx.strokeRect(-w / 2, -hh / 2, w, hh); }
  ctx.restore();
}
/* বড় ছবি স্টোরেজের জন্য ছোট করে JPEG বানানো */
async function shrinkImage(file, max = 1200) {
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
    const w = Math.round(im.naturalWidth * k), hh = Math.round(im.naturalHeight * k);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = hh;
    const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, w, hh); c.drawImage(im, 0, 0, w, hh);
    const src = cv.toDataURL('image/jpeg', 0.86);
    return { src, w, h: hh };
  } finally { URL.revokeObjectURL(url); }
}
async function placePicFile(file) {
  if (!S.page) return;
  try {
    const { src, w, h: hh } = await shrinkImage(file);
    const maxW = Math.min(480, S.page.w * 0.5), k = Math.min(1, maxW / w);
    const W = w * k, H = hh * k, cx = S.page.w / 2, cy = S.page.h / 2;
    const item = { t: 'pic', x1: cx - W / 2, y1: cy - H / 2, x2: cx + W / 2, y2: cy + H / 2, size: 0, color: '#fff', src, rot: 0, flip: false };
    S.page.items.push(item);
    S.sel = S.page.items.length - 1;
    commit(); redrawInk(); drawOv(); updateSelBar(); updateOpts();
    toast('ছবি বসানো হয়েছে — টেনে সরান, কোণ ধরে বড়-ছোট করুন');
  } catch (e) { toast('ছবি খোলা যায়নি: ' + (e.message || e), 4000); }
}
const FX_ACTS = {
  picItem: () => $('#filePic').click()
};
const FX_MENU = { id: 'picItem', icon: 'image', text: 'ছবি বসান (বোর্ডে, ঘোরানো যাবে)' };

function fxInit2() {
  buildExtraColors();
  buildEditRow();
  // শেপ বাটন: বাড়তি
  const row = $('#rowShape');
  if (row && !row.querySelector('[data-shape="heart"]')) {
    const sp = row.querySelector('.sp');
    const add = (shape, label, aria) => {
      const b = h('button', { class: 'chip sq', 'data-shape': shape, 'aria-label': aria, style: 'font-size:17px;line-height:1' }, label);
      b.onclick = () => { S.shape = shape; updateOpts(); };
      row.insertBefore(b, sp);
    };
    add('plus', '✚', 'প্লাস'); add('cross', '✖', 'ক্রস'); add('heart', '♥', 'হৃদয়'); add('darr', '⇔', 'দ্বিমুখী তীর');
  }
  // মেনু ও ফাইল ইনপুট
  if (!$('#mi-picItem') && $('#mi-ocr')) {
    const btn = h('button', { class: 'mi', id: 'mi-picItem', onclick: () => menuAct('picItem') }, icon('image'), FX_MENU.text);
    $('#mi-ocr').before(btn);
  }
  if (!$('#filePic')) {
    const inp = h('input', { type: 'file', id: 'filePic', accept: 'image/*', hidden: true });
    inp.onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) placePicFile(f); };
    document.body.append(inp);
  }
  $('#mi-picItem')?.classList.add('ed');
  const _menuAct2 = menuAct;
  menuAct = async function (id) {
    if (FX_ACTS[id]) { closeUI(); await sleep(60); return FX_ACTS[id](); }
    return _menuAct2(id);
  };
}
const drawItemBeforeRotation = drawItem;
drawItem = function (ctx, item, overlay) {
  if (!(SHAPES.has(item.t) || item.t === 'text') || !item.rot) return drawItemBeforeRotation(ctx, item, overlay);
  const box = itemBox(item), cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(item.rot);
  ctx.translate(-cx, -cy);
  drawItemBeforeRotation(ctx, item, overlay);
  ctx.restore();
};

const itemHitBeforeRotation = itemHit;
itemHit = function (item, x, y, radius) {
  if (!(SHAPES.has(item.t) || item.t === 'text') || !item.rot) return itemHitBeforeRotation(item, x, y, radius);
  const box = itemBox(item), cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const dx = x - cx, dy = y - cy, angle = -item.rot;
  const localX = cx + dx * Math.cos(angle) - dy * Math.sin(angle);
  const localY = cy + dx * Math.sin(angle) + dy * Math.cos(angle);
  return itemHitBeforeRotation(item, localX, localY, radius);
};

window.addEventListener('DOMContentLoaded', () => setTimeout(() => { try { fxInit2(); } catch (e) { console.error('features2', e); } }, 20));
