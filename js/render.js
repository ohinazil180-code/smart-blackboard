'use strict';
/* ===== পাতার মডেল, আঁকার ইঞ্জিন, টেমপ্লেট ===== */
const RES = 2;                       // ক্যানভাসের রেজোলিউশন গুণক
const FONT = '"Noto Sans Bengali","Noto Sans","Hind Siliguri",system-ui,sans-serif';

function mkPage(o = {}) {
  return {
    id: o.id || uid(), type: o.type || 'black', w: o.w || 1280, h: o.h || 720,
    grid: o.grid || 'none', bgc: o.bgc || null, items: o.items || [], blob: o.blob || null,
    hist: null, hi: 0, dirty: o.dirty !== false, blobDirty: o.blobDirty !== undefined ? o.blobDirty : !!o.blob,
    thumb: null, thumbDirty: true
  };
}

/* ---------- বিটম্যাপ ক্যাশ (PDF/ছবির পাতা) ---------- */
const bmpCache = new Map();
async function getBitmap(p) {
  if (!p.blob) return null;
  let b = bmpCache.get(p.id);
  if (b) { bmpCache.delete(p.id); bmpCache.set(p.id, b); return b; }
  b = await createImageBitmap(p.blob);
  bmpCache.set(p.id, b);
  while (bmpCache.size > 6) bmpCache.delete(bmpCache.keys().next().value);
  return b;
}

/* ---------- টেক্সট মাপ ---------- */
const mctx = document.createElement('canvas').getContext('2d');
function fontOf(it) {
  return `${it.it ? 'italic ' : ''}${it.bold ? '700' : '400'} ${it.size}px ${it.ff || FONT}`;
}
function textBox(it) {
  mctx.font = fontOf(it);
  const ls = String(it.text).split('\n');
  let w = 0;
  for (const l of ls) w = Math.max(w, mctx.measureText(l).width);
  const lh = it.size * 1.4;
  const x = it.align === 'center' ? it.x - w / 2 : it.x;
  return { x, y: it.y, w, h: lh * ls.length, lh };
}
const measure = (txt, size, bold, ff) => { mctx.font = fontOf({ size, bold, ff }); return mctx.measureText(txt).width; };

/* ---------- ব্যাকগ্রাউন্ড ---------- */
let noiseCv = null;
function noisePattern(ctx) {
  if (!noiseCv) {
    noiseCv = document.createElement('canvas');
    noiseCv.width = noiseCv.height = 128;
    const c = noiseCv.getContext('2d');
    const im = c.createImageData(128, 128);
    for (let i = 0; i < 128 * 128; i++) {
      const v = (Math.random() * 255) | 0;
      im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v;
      im.data[i * 4 + 3] = 9;
    }
    c.putImageData(im, 0, 0);
  }
  return ctx.createPattern(noiseCv, 'repeat');
}

function isDarkBg(p) { return p.type === 'black'; }

function drawBg(ctx, p, bmp) {
  const W = p.w, H = p.h;
  if (p.type === 'black') {
    if (p.bgc) { ctx.fillStyle = p.bgc; }
    else {
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.12, W / 2, H / 2, W * 0.78);
      g.addColorStop(0, '#1b1e25'); g.addColorStop(1, '#090a0d');
      ctx.fillStyle = g;
    }
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = noisePattern(ctx); ctx.fillRect(0, 0, W, H);
  } else if (p.type === 'white') {
    ctx.fillStyle = p.bgc || '#ffffff'; ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    if (bmp) ctx.drawImage(bmp, 0, 0, W, H);
  }
  if (p.grid && p.grid !== 'none') {
    const dark = isDarkBg(p);
    ctx.save();
    ctx.strokeStyle = dark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.13)';
    ctx.fillStyle = dark ? 'rgba(255,255,255,.28)' : 'rgba(0,0,0,.32)';
    ctx.lineWidth = 1.2;
    const s = 40;
    if (p.grid === 'grid') {
      ctx.beginPath();
      for (let x = s; x < W; x += s) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
      for (let y = s; y < H; y += s) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
      ctx.stroke();
    } else if (p.grid === 'lines') {
      ctx.beginPath();
      for (let y = 60; y < H; y += 52) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
      ctx.stroke();
    } else if (p.grid === 'dots') {
      for (let x = s; x < W; x += s) for (let y = s; y < H; y += s) { ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.fill(); }
    }
    ctx.restore();
  }
}

/* ---------- আইটেম আঁকা ---------- */
const SHAPES = new Set(['line', 'arrow', 'rect', 'ell', 'tri', 'rtri']);

function drawItem(ctx, it, ov) {
  const col = ov || it.color;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (it.t === 'pen' || it.t === 'hl' || it.t === 'er') {
    const pts = it.pts;
    ctx.lineWidth = it.size;
    ctx.strokeStyle = col; ctx.fillStyle = col;
    if (it.t === 'er') { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = ctx.fillStyle = '#000'; }
    if (it.t === 'hl') { ctx.globalAlpha = 0.38; ctx.lineCap = 'butt'; }
    if (pts.length === 1) {
      ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], it.size / 2, 0, 7); ctx.fill();
    } else {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      const l = pts[pts.length - 1]; ctx.lineTo(l[0], l[1]); ctx.stroke();
    }
  } else if (SHAPES.has(it.t)) {
    const { x1, y1, x2, y2 } = it;
    ctx.strokeStyle = col; ctx.lineWidth = it.size;
    if (it.dash) ctx.setLineDash([it.size * 2.6, it.size * 2.2]);
    ctx.beginPath();
    if (it.t === 'line' || it.t === 'arrow') {
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      if (it.t === 'arrow') {
        const a = Math.atan2(y2 - y1, x2 - x1), L = Math.max(16, it.size * 4.5);
        ctx.moveTo(x2, y2); ctx.lineTo(x2 - L * Math.cos(a - 0.45), y2 - L * Math.sin(a - 0.45));
        ctx.moveTo(x2, y2); ctx.lineTo(x2 - L * Math.cos(a + 0.45), y2 - L * Math.sin(a + 0.45));
      }
    } else if (it.t === 'rect') ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    else if (it.t === 'ell') ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, 7);
    else if (it.t === 'tri') { ctx.moveTo((x1 + x2) / 2, y1); ctx.lineTo(x2, y2); ctx.lineTo(x1, y2); ctx.closePath(); }
    else if (it.t === 'rtri') { ctx.moveTo(x1, y1); ctx.lineTo(x1, y2); ctx.lineTo(x2, y2); ctx.closePath(); }
    if (it.fill && it.t !== 'line' && it.t !== 'arrow') {
      ctx.save();
      if (typeof it.fill === 'string') ctx.fillStyle = ov || it.fill; else { ctx.fillStyle = col; ctx.globalAlpha = 0.28; }
      ctx.fill(); ctx.restore();
    }
    if (it.size > 0) ctx.stroke();
  } else if (it.t === 'text') {
    ctx.font = fontOf(it); ctx.textBaseline = 'top';
    ctx.textAlign = it.align === 'center' ? 'center' : 'left';
    ctx.fillStyle = col;
    if (it.glow && !ov) { ctx.shadowColor = col; ctx.shadowBlur = it.size * 0.45; }
    const lh = it.size * 1.4;
    String(it.text).split('\n').forEach((l, i) => ctx.fillText(l, it.x, it.y + i * lh + it.size * 0.12));
  }
  ctx.restore();
}

/* ctx এ আইটেমের তালিকা আঁকে (ctx-এর transform আগেই সেট থাকবে) */
function drawItems(ctx, items, o = {}) {
  items.forEach((it, i) => {
    if (i === o.exclude) return;
    if (o.mono && it.t === 'hl') return;
    drawItem(ctx, it, o.mono && it.t !== 'er' ? o.mono : null);
  });
}

/* পুরো পাতা একটি নতুন ক্যানভাসে রেন্ডার (থাম্বনেইল / এক্সপোর্ট / OCR) */
async function renderPageCanvas(p, o = {}) {
  const sc = o.scale || 1;
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(p.w * sc)); cv.height = Math.max(1, Math.round(p.h * sc));
  const ctx = cv.getContext('2d');
  const bmp = o.mono && p.type !== 'pdf' && p.type !== 'img' ? null : await getBitmap(p);
  ctx.save(); ctx.setTransform(sc, 0, 0, sc, 0, 0);
  if (o.mono && p.type !== 'pdf' && p.type !== 'img') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, p.w, p.h); }
  else drawBg(ctx, p, bmp);
  ctx.restore();
  const ink = document.createElement('canvas'); ink.width = cv.width; ink.height = cv.height;
  const ic = ink.getContext('2d'); ic.setTransform(sc, 0, 0, sc, 0, 0);
  drawItems(ic, p.items, { mono: o.mono && p.type !== 'pdf' && p.type !== 'img' ? '#000' : null });
  ctx.drawImage(ink, 0, 0);
  return cv;
}

/* ---------- জ্যামিতি: হিট টেস্ট, বাউন্ডিং বক্স, মুভ ---------- */
function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function polyDist(px, py, pts, closed) {
  let d = Infinity;
  for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    d = Math.min(d, distSeg(px, py, a[0], a[1], b[0], b[1]));
  }
  return d;
}
function shapePoly(it) {
  const { x1, y1, x2, y2 } = it;
  if (it.t === 'rect') return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
  if (it.t === 'tri') return [[(x1 + x2) / 2, y1], [x2, y2], [x1, y2]];
  if (it.t === 'rtri') return [[x1, y1], [x1, y2], [x2, y2]];
  return [[x1, y1], [x2, y2]];
}
function itemBox(it) {
  if (it.t === 'pen' || it.t === 'hl' || it.t === 'er') {
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    for (const [x, y] of it.pts) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
    const r = it.size / 2; return { x: a - r, y: b - r, w: c - a + it.size, h: d - b + it.size };
  }
  if (it.t === 'text') { const b = textBox(it); return { x: b.x, y: b.y, w: b.w, h: b.h }; }
  const r = it.size / 2;
  return { x: Math.min(it.x1, it.x2) - r, y: Math.min(it.y1, it.y2) - r, w: Math.abs(it.x2 - it.x1) + it.size, h: Math.abs(it.y2 - it.y1) + it.size };
}
function itemHit(it, x, y, r) {
  if (it.t === 'er') return false;
  if (it.t === 'pen' || it.t === 'hl') {
    if (it.pts.length === 1) return Math.hypot(x - it.pts[0][0], y - it.pts[0][1]) <= r + it.size / 2;
    return polyDist(x, y, it.pts, false) <= r + it.size / 2;
  }
  if (it.t === 'text') {
    const b = textBox(it);
    return x >= b.x - r && x <= b.x + b.w + r && y >= b.y - r && y <= b.y + b.h + r;
  }
  const rr = r + it.size / 2;
  if (it.t === 'line' || it.t === 'arrow') return distSeg(x, y, it.x1, it.y1, it.x2, it.y2) <= rr;
  if (it.t === 'ell') {
    const cx = (it.x1 + it.x2) / 2, cy = (it.y1 + it.y2) / 2, rx = Math.abs(it.x2 - it.x1) / 2 || 1, ry = Math.abs(it.y2 - it.y1) / 2 || 1;
    const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
    return it.fill ? d <= 1 + rr / Math.min(rx, ry) : Math.abs(d - 1) * Math.min(rx, ry) <= rr;
  }
  const pts = shapePoly(it);
  if (it.fill) { const b = itemBox(it); if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return true; }
  return polyDist(x, y, pts, true) <= rr;
}
function moveItem(it, dx, dy) {
  if (it.pts) return { ...it, pts: it.pts.map(([x, y]) => [x + dx, y + dy]) };
  if (it.t === 'text') return { ...it, x: it.x + dx, y: it.y + dy };
  return { ...it, x1: it.x1 + dx, y1: it.y1 + dy, x2: it.x2 + dx, y2: it.y2 + dy };
}

/* ---------- টেমপ্লেট ---------- */
const NEON = '#39ff14', YEL = '#facc15', ORG = '#fbbf24';
const T = (x, y, text, size, color, o = {}) => ({ t: 'text', x, y, text, size, color, ...o });

/* এক লাইনের মধ্যে হাইলাইট-বক্সসহ লেখা: segs = [['লেখা'], ['হাইলাইট', true], ...] */
function richLine(items, x, y, size, segs, color = '#ffffff') {
  let cx = x;
  const gap = 10;
  for (const [txt, hl] of segs) {
    const w = measure(txt, size, false);
    if (hl) {
      items.push({ t: 'rect', x1: cx - 8, y1: y - 2, x2: cx + w + 8, y2: y + size * 1.3, color: YEL, size: 0, fill: YEL });
      items.push(T(cx, y, txt, size, '#111111'));
      cx += w + 16;
    } else { items.push(T(cx, y, txt, size, color)); cx += w; }
    cx += txt.endsWith(' ') ? 0 : 0 + (hl ? gap * 0 : 0);
  }
  return items;
}

function tplTitle() {
  const it = [];
  it.push({ t: 'ell', x1: 700, y1: 100, x2: 1210, y2: 620, color: YEL, size: 9, fill: 'rgba(250,204,21,.07)' });
  it.push({ t: 'ell', x1: 724, y1: 124, x2: 1186, y2: 596, color: '#fb923c', size: 3 });
  it.push(T(955, 150, '🎓', 78, '#ffffff', { align: 'center' }));
  it.push(T(955, 275, 'জুনিয়র বৃত্তি', 64, '#ffffff', { align: 'center', bold: true }));
  it.push(T(955, 360, 'পরীক্ষা প্রস্তুতি', 64, NEON, { align: 'center', bold: true, glow: true }));
  it.push(T(215, 250, '📖', 200, '#ffffff', { align: 'center' }));
  it.push(T(110, 110, '∠', 70, '#22d3ee', { align: 'center' }));
  it.push(T(235, 70, '△', 66, '#fb923c', { align: 'center' }));
  it.push(T(360, 130, 'π', 70, '#f472b6', { align: 'center' }));
  it.push(T(80, 250, '√', 62, YEL, { align: 'center' }));
  it.push(T(380, 270, '⊥', 62, '#a78bfa', { align: 'center' }));
  it.push(T(465, 400, '🧮', 96, '#ffffff', { align: 'center' }));
  it.push(T(70, 545, "Mahadi'22 CE, BUET", 60, NEON, { ff: 'cursive', it: true, glow: true }));
  return mkPage({ type: 'black', items: it });
}
function tplTopic() {
  const it = [
    T(640, 215, 'Type-01', 96, NEON, { align: 'center', bold: true, glow: true }),
    T(640, 345, 'চতুর্ভুজ সংক্রান্ত সম্পাদ্য', 78, NEON, { align: 'center', bold: true, glow: true })
  ];
  return mkPage({ type: 'black', bgc: '#1c1f24', items: it });
}
function tplContent() {
  const it = [];
  it.push(T(640, 30, 'Type-01: চতুর্ভুজ সংক্রান্ত সম্পাদ্য', 54, ORG, { align: 'center', bold: true }));
  it.push({ t: 'rect', x1: 50, y1: 112, x2: 1230, y2: 680, color: '#ffffff', size: 4 });
  const S = 38, X = 92;
  richLine(it, X, 138, S, [['চতুর্ভুজ অঙ্কনের জন্য '], ['৫টি স্বাধীন উপাত্ত', true], [' প্রয়োজন।']]);
  richLine(it, X, 205, S, [['নিচের যেকোনো একটি সমন্বয় জানা থাকলে অঙ্কন সম্ভব:']]);
  richLine(it, X, 295, S, [['১)  '], ['চারটি বাহু', true], [' ও '], ['একটি কর্ণ', true]]);
  richLine(it, X, 375, S, [['২)  '], ['তিনটি বাহু', true], [' ও '], ['দুইটি কর্ণ', true]]);
  richLine(it, X, 455, S, [['৩)  '], ['তিনটি বাহু', true], [' ও তাদের '], ['অন্তর্ভুক্ত দুইটি কোণ', true]]);
  richLine(it, X, 535, S, [['৪)  '], ['চারটি বাহু', true], [' ও '], ['একটি কোণ', true]]);
  richLine(it, X, 615, S, [['৫)  '], ['দুইটি সন্নিহিত বাহু', true], [' ও '], ['তিনটি কোণ', true]]);
  return mkPage({ type: 'black', bgc: '#1c1f24', items: it });
}
