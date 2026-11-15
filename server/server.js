'use strict';
/* =====================================================================
   স্মার্ট ব্ল্যাকবোর্ড — রুম সার্ভার (কোনো লগইন নেই)
   - শুধু Node.js বিল্ট-ইন মডিউল, কোনো npm নির্ভরতা নেই
   - স্ট্যাটিক ফ্রন্টএন্ড এবং /api রুট একসাথে সার্ভ করে
   - রিয়েল-টাইম আপডেট: Server-Sent Events (SSE)
   - ডেটা: JSON ফাইলে নিয়মিত সংরক্ষণ (DATA_FILE)
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'rooms.json');
const ROOM_TTL_MS = 7 * 24 * 3600 * 1000;   // ৭ দিন নিষ্ক্রিয় থাকলে রুম মুছে যাবে
const MAX_BODY = 16 * 1024;
const MAX_BOARD = 6 * 1024 * 1024;      // বোর্ড পেজ স্ন্যাপশটের সীমা (PDF ব্যাকগ্রাউন্ডসহ)
const MAX_ROOMS = 20000;
const MAX_MEMBERS = 500;
const MAX_GROUPS = 50;
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // অস্পষ্ট অক্ষর (0,O,1,I) বাদ

const rooms = new Map();      // code -> room
const streams = new Map();    // code -> Set<{res, memberId}>
const rateBuckets = new Map(); // ip:bucket -> {n, reset}
const joinFails = new Map();   // ip -> {n, reset}

/* ---------- ডেটা ---------- */
function loadData() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const r of j.rooms || []) if (r && r.code) rooms.set(r.code, r);
    console.log(`[data] ${rooms.size} টি রুম লোড হয়েছে`);
  } catch (_) { /* প্রথমবার চালু — ফাইল নেই */ }
}
let dirty = false;
function markDirty() { dirty = true; }
function persist() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ rooms: [...rooms.values()] }));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { console.error('[persist]', e.message); dirty = true; }
}
setInterval(persist, 3000).unref();
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) if (now - r.updatedAt > ROOM_TTL_MS) { rooms.delete(code); streams.delete(code); markDirty(); }
}, 3600 * 1000).unref();

/* ---------- সহায়ক ---------- */
const rid = () => crypto.randomBytes(16).toString('hex');
function newCode() {
  let c;
  do {
    const b = crypto.randomBytes(8);
    c = Array.from(b, x => CODE_ALPHA[x % CODE_ALPHA.length]).join('');
  } while (rooms.has(c));
  return c;
}
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const validRole = r => r === 'teacher' || r === 'student';
const now = () => Date.now();
function touch(room) { room.updatedAt = now(); markDirty(); }

function clientIp(req) {
  // Reverse proxy (Netlify/Cloudflare/nginx) থেকে আসা IP
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}
function rateOk(ip, bucket, limit, windowMs) {
  const k = ip + ':' + bucket;
  const t = now();
  let b = rateBuckets.get(k);
  if (!b || t > b.reset) { b = { n: 0, reset: t + windowMs }; rateBuckets.set(k, b); }
  b.n++;
  return b.n <= limit;
}
function joinBlocked(ip) {
  const f = joinFails.get(ip);
  return !!(f && now() < f.reset && f.n >= 10);
}
function joinFailed(ip) {
  const t = now(); let f = joinFails.get(ip);
  if (!f || t > f.reset) { f = { n: 0, reset: t + 10 * 60 * 1000 }; joinFails.set(ip, f); }
  f.n++;
}
// পুরোনো রেট-লিমিট এন্ট্রি পরিষ্কার
setInterval(() => {
  const t = now();
  for (const [k, b] of rateBuckets) if (t > b.reset) rateBuckets.delete(k);
  for (const [k, f] of joinFails) if (t > f.reset) joinFails.delete(k);
}, 60000).unref();

/* ---------- রুমের দৃশ্য (ভিউয়ার অনুযায়ী) ---------- */
function viewFor(room, memberId) {
  const me = room.members.find(m => m.id === memberId);
  const isOwner = !!me && me.id === room.ownerId;
  return {
    code: room.code,
    name: room.name,
    status: room.status,
    groups: room.groups.map(g => ({ id: g.id, name: g.name })),
    members: room.members.map(m => ({
      name: m.name, role: m.role, groupId: m.groupId, joinedAt: m.joinedAt,
      ...(isOwner ? { id: m.id } : {}),           // শুধু মালিক সদস্য-আইডি দেখে
      ...(m.id === memberId ? { me: true } : {})
    })),
    you: me ? { id: me.id, role: me.role, groupId: me.groupId, isOwner } : null
  };
}
function broadcast(room) {
  const set = streams.get(room.code);
  if (!set) return;
  for (const s of set) {
    try { s.res.write(`event: state\ndata: ${JSON.stringify(viewFor(room, s.memberId))}\n\n`); }
    catch (_) { set.delete(s); }
  }
}

function broadcastBoard(room) {
  const set = streams.get(room.code);
  if (!set || !room.board) return;
  const data = `event: board\ndata: ${JSON.stringify(room.board)}\n\n`;
  for (const s of set) { try { s.res.write(data); } catch (_) { set.delete(s); } }
}

/* ---------- রিকোয়েস্ট বডি ---------- */
function readJSON(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('অনুরোধ খুব বড়'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (_) { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function send(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(obj));
}
const fail = (res, status, msg) => send(res, status, { error: msg });

/* ---------- API ---------- */
async function apiCreate(req, res, ip) {
  if (!rateOk(ip, 'create', 20, 3600e3)) return fail(res, 429, 'অনেক বেশি রুম তৈরি। কিছুক্ষণ পর চেষ্টা করুন।');
  if (rooms.size >= MAX_ROOMS) return fail(res, 503, 'সার্ভার এখন পূর্ণ।');
  const b = await readJSON(req);
  const name = clean(b.name, 80), memberName = clean(b.memberName, 60) || 'শিক্ষক';
  if (!name) return fail(res, 400, 'রুমের নাম দিন।');
  const ownerId = rid();
  const room = {
    code: newCode(), name, status: 'live', ownerId, createdAt: now(), updatedAt: now(),
    groups: [{ id: rid(), name: 'গ্রুপ ১' }, { id: rid(), name: 'গ্রুপ ২' }],
    members: [{ id: ownerId, name: memberName, role: 'teacher', groupId: null, joinedAt: now() }]
  };
  rooms.set(room.code, room); touch(room);
  send(res, 201, { memberId: ownerId, room: viewFor(room, ownerId) });
}

async function apiJoin(req, res, ip) {
  if (joinBlocked(ip)) return fail(res, 429, 'বারবার ভুল কোড দেওয়া হয়েছে। ১০ মিনিট পর চেষ্টা করুন।');
  if (!rateOk(ip, 'join', 60, 60e3)) return fail(res, 429, 'খুব দ্রুত অনুরোধ হচ্ছে।');
  const b = await readJSON(req);
  const code = clean(b.code, 16).toUpperCase().replace(/\s/g, '');
  const room = rooms.get(code);
  if (!room) { joinFailed(ip); return fail(res, 404, 'এই কোডের রুম পাওয়া যায়নি।'); }
  if (room.status === 'ended') return fail(res, 410, 'এই রুমটি শেষ হয়ে গেছে।');
  const role = validRole(b.role) ? b.role : 'student';
  const name = clean(b.name, 60) || 'অজ্ঞাত';

  // পুনরায় যোগ দেওয়া (একই ডিভাইস)
  let member = b.memberId ? room.members.find(m => m.id === b.memberId) : null;
  if (member) {
    member.name = name; if (member.id !== room.ownerId) member.role = role;
  } else {
    if (room.members.length >= MAX_MEMBERS) return fail(res, 403, 'এই রুম পূর্ণ।');
    member = { id: rid(), name, role, groupId: null, joinedAt: now() };
    room.members.push(member);
  }
  if (b.groupId && room.groups.some(g => g.id === b.groupId)) member.groupId = b.groupId;
  touch(room); broadcast(room);
  send(res, 200, { memberId: member.id, room: viewFor(room, member.id) });
}

function apiStream(req, res, code, memberId) {
  const room = rooms.get(code);
  if (!room || !room.members.some(m => m.id === memberId)) return fail(res, 403, 'সদস্য নন।');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  const entry = { res, memberId };
  if (!streams.has(code)) streams.set(code, new Set());
  streams.get(code).add(entry);
  res.write(`event: state\ndata: ${JSON.stringify(viewFor(room, memberId))}\n\n`);
  if (room.board) res.write(`event: board\ndata: ${JSON.stringify(room.board)}\n\n`);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { } }, 25000);
  req.on('close', () => { clearInterval(hb); streams.get(code)?.delete(entry); });
}

async function apiBoard(req, res, code, ip) {
  if (!rateOk(ip, 'board', 600, 60e3)) return fail(res, 429, 'খুব দ্রুত বোর্ড আপডেট হচ্ছে।');
  const room = rooms.get(code);
  if (!room) return fail(res, 404, 'রুম নেই।');
  const b = await readJSON(req, MAX_BOARD);
  const me = room.members.find(m => m.id === b.memberId);
  if (!me || me.id !== room.ownerId) return fail(res, 403, 'শুধু শিক্ষক বোর্ড শেয়ার করতে পারবেন।');
  const p = b.page;
  if (!p || typeof p !== 'object' || !Array.isArray(p.items) || p.items.length > 5000) return fail(res, 400, 'ভুল বোর্ড ডেটা।');
  const seq = ((room.board && room.board.seq) || 0) + 1;
  const prev = room.board && room.board.page;
  const bgId = clean(p.bgId, 120) || null;
  const bgNew = typeof p.bg === 'string' && p.bg.startsWith('data:image/') && p.bg.length < 5 * 1024 * 1024 ? p.bg : null;
  // ব্যাকগ্রাউন্ড একই থাকলে আগেরটা রাখা হয় (প্রতি স্ট্রোকে বড় ডেটা না যাক)
  const bg = bgNew || (prev && bgId && prev.bgId === bgId ? prev.bg : null);
  room.board = {
    seq, at: now(),
    page: {
      type: clean(p.type, 20) || 'black', w: Math.min(+p.w || 1280, 4000), h: Math.min(+p.h || 720, 4000),
      grid: clean(p.grid, 10) || 'none', bgc: typeof p.bgc === 'string' && p.bgc.length < 24 ? p.bgc : null,
      pageNo: parseInt(p.pageNo, 10) || 1, items: p.items, bgId, bg
    }
  };
  touch(room);
  broadcastBoard(room);
  send(res, 200, { ok: true, seq });
}

async function apiAct(req, res, code, ip) {
  if (!rateOk(ip, 'act', 240, 60e3)) return fail(res, 429, 'খুব দ্রুত অনুরোধ হচ্ছে।');
  const room = rooms.get(code);
  if (!room) return fail(res, 404, 'রুম নেই।');
  const b = await readJSON(req);
  const me = room.members.find(m => m.id === b.memberId);
  if (!me) return fail(res, 403, 'সদস্য নন।');
  const isOwner = me.id === room.ownerId;
  const needOwner = () => isOwner || fail(res, 403, 'শুধু রুমের শিক্ষক এটি করতে পারবেন।');
  const t = b.type;

  switch (t) {
    case 'self.name': { me.name = clean(b.name, 60) || me.name; break; }
    case 'self.role': {
      if (isOwner) return fail(res, 400, 'রুমের মালিকের রোল বদলানো যায় না।');
      if (!validRole(b.role)) return fail(res, 400, 'ভুল রোল।');
      me.role = b.role; if (b.role === 'student') { /* শিক্ষার্থী হলেও গ্রুপ থাকবে */ }
      break;
    }
    case 'self.group': {
      if (b.groupId && !room.groups.some(g => g.id === b.groupId)) return fail(res, 400, 'গ্রুপ নেই।');
      me.groupId = b.groupId || null; break;
    }
    case 'room.status': {
      if (!isOwner) return needOwner();
      if (!['live', 'ended'].includes(b.status)) return fail(res, 400, 'ভুল অবস্থা।');
      room.status = b.status; break;
    }
    case 'room.rename': {
      if (!isOwner) return needOwner();
      room.name = clean(b.name, 80) || room.name; break;
    }
    case 'group.add': {
      if (!isOwner) return needOwner();
      if (room.groups.length >= MAX_GROUPS) return fail(res, 400, 'গ্রুপের সীমা পূর্ণ।');
      const name = clean(b.name, 60); if (!name) return fail(res, 400, 'গ্রুপের নাম দিন।');
      room.groups.push({ id: rid(), name }); break;
    }
    case 'group.rename': {
      if (!isOwner) return needOwner();
      const g = room.groups.find(x => x.id === b.groupId); if (!g) return fail(res, 404, 'গ্রুপ নেই।');
      g.name = clean(b.name, 60) || g.name; break;
    }
    case 'group.delete': {
      if (!isOwner) return needOwner();
      room.groups = room.groups.filter(g => g.id !== b.groupId);
      room.members.forEach(m => { if (m.groupId === b.groupId) m.groupId = null; });
      break;
    }
    case 'member.move': {
      if (!isOwner) return needOwner();
      const t2 = room.members.find(m => m.id === b.target);
      if (!t2) return fail(res, 404, 'সদস্য নেই।');
      if (b.groupId && !room.groups.some(g => g.id === b.groupId)) return fail(res, 400, 'গ্রুপ নেই।');
      t2.groupId = b.groupId || null; break;
    }
    case 'member.remove': {
      if (!isOwner) return needOwner();
      if (b.target === room.ownerId) return fail(res, 400, 'মালিককে সরানো যায় না।');
      room.members = room.members.filter(m => m.id !== b.target); break;
    }
    default: return fail(res, 400, 'অজানা কাজ।');
  }
  touch(room); broadcast(room);
  send(res, 200, { ok: true, room: viewFor(room, me.id) });
}

/* ---------- স্ট্যাটিক ফাইল ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon'
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  // ডিরেক্টরি ট্র্যাভার্সাল ও সার্ভার সোর্স/ডেটা ফাইল ব্লক
  if (!file.startsWith(ROOT + path.sep) || file.startsWith(path.join(ROOT, 'server') + path.sep) || file.includes(`${path.sep}.`)) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Cache-Control': ['.html', '.js', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=604800'
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------- রাউটার ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const ip = clientIp(req);
    const p = url.pathname;

    if (p === '/api/health') return send(res, 200, { ok: true, rooms: rooms.size });

    if (p.startsWith('/api/')) {
      if (!rateOk(ip, 'all', 300, 60e3)) return fail(res, 429, 'খুব বেশি অনুরোধ।');
      if (req.method === 'POST' && p === '/api/rooms') return await apiCreate(req, res, ip);
      if (req.method === 'POST' && p === '/api/rooms/join') return await apiJoin(req, res, ip);
      let m = p.match(/^\/api\/rooms\/([A-Z0-9]{4,16})\/stream$/);
      if (req.method === 'GET' && m) return apiStream(req, res, m[1], url.searchParams.get('m') || '');
      m = p.match(/^\/api\/rooms\/([A-Z0-9]{4,16})\/board$/);
      if (req.method === 'POST' && m) return await apiBoard(req, res, m[1], ip);
      m = p.match(/^\/api\/rooms\/([A-Z0-9]{4,16})\/act$/);
      if (req.method === 'POST' && m) return await apiAct(req, res, m[1], ip);
      return fail(res, 404, 'রুট নেই।');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, p);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) fail(res, status, status === 500 ? 'সার্ভার ত্রুটি।' : e.message);
  }
});

server.keepAliveTimeout = 65000;
loadData();
server.listen(PORT, () => console.log(`স্মার্ট ব্ল্যাকবোর্ড চালু: http://localhost:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { persist(); process.exit(0); });
    
