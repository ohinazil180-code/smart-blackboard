'use strict';
/* =====================================================================
   স্মার্ট ব্ল্যাকবোর্ড — রুম সার্ভার
   - স্ট্যাটিক ফ্রন্টএন্ড এবং /api রুট একসাথে সার্ভ করে
   - রিয়েল-টাইম আপডেট: Server-Sent Events (SSE)
   - রুম ডেটা Neon-এ সংরক্ষিত; টেস্টে JSON ফাইল ব্যবহার হয়
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { and, eq, gt, lte, or, sql } = require('drizzle-orm');
require('dotenv').config({ path: path.join(__dirname, '.env.development.local'), quiet: true });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.development.local'), quiet: true });

const PORT = parseInt(process.env.PORT, 10) || 8080;
const useDatabase = Boolean(process.env.DATABASE_URL && process.env.NODE_ENV !== 'test');
const database = useDatabase ? require('./database') : null;
const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'rooms.json');
const ROOM_TTL_MS = 7 * 24 * 3600 * 1000;   // ৭ দিন নিষ্ক্রিয় থাকলে রুমের মেয়াদ শেষ হয়
const MAX_BODY = 16 * 1024;
const MAX_BOARD = 6 * 1024 * 1024;      // বোর্ড পেজ স্ন্যাপশটের সীমা (PDF ব্যাকগ্রাউন্ডসহ)
const MAX_ROOMS = 20000;
const MAX_MEMBERS = 500;
const MAX_GROUPS = 50;
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // অস্পষ্ট অক্ষর (0,O,1,I) বাদ

const rooms = new Map();      // code -> room
const streams = new Map();    // code -> Set<{res, memberId}>
const streamTickets = new Map();
const rateBuckets = new Map(); // ip:bucket -> {n, reset}
const joinFails = new Map();   // ip -> {n, reset}
const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=63072000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
});

/* ---------- ডেটা ---------- */
function ensureMicState(room) {
  if (!room.mic) room.mic = { queue: [], grant: null };
  if (!Array.isArray(room.mic.queue)) room.mic.queue = [];
  if (!room.mic.grant || typeof room.mic.grant !== 'object') room.mic.grant = null;
  for (const member of room.members || []) member.micStatus ||= 'idle';
  return room.mic;
}
function revokeMic(room, memberId, status = 'revoked') {
  const mic = ensureMicState(room);
  mic.queue = mic.queue.filter(id => id !== memberId);
  if (mic.grant?.memberId === memberId) mic.grant = null;
  const member = room.members.find(item => item.id === memberId);
  if (member) member.micStatus = status;
}
function databaseValues(room) {
  const owner = room.members.find(member => member.id === room.ownerId);
  const memberIds = [...new Set(room.members.map(member => member.userId).filter(Boolean))];
  return {
    code: room.code,
    ownerId: owner?.userId || null,
    memberIds,
    state: room,
    createdAt: new Date(room.createdAt || room.updatedAt || now()),
    updatedAt: new Date(room.updatedAt || now()),
    expiresAt: new Date((room.updatedAt || now()) + ROOM_TTL_MS)
  };
}
function roomFromRow(row) {
  if (!row) return null;
  const room = row.state;
  room.updatedAt = row.updatedAt.getTime();
  ensureMicState(room);
  return room;
}
function roomScope(code, userId) {
  const table = database.classroomRooms;
  return and(
    eq(table.code, code),
    or(eq(table.ownerId, userId), sql`${table.memberIds} @> ARRAY[${userId}::uuid]`),
    gt(table.expiresAt, new Date())
  );
}
async function loadRoomForUser(code, userId) {
  if (!database) return rooms.get(code) || null;
  const [row] = await database.db.select().from(database.classroomRooms).where(roomScope(code, userId)).limit(1);
  const room = roomFromRow(row);
  if (room) rooms.set(code, room);
  return room;
}
async function loadRoomByInvite(code) {
  if (!database) return rooms.get(code) || null;
  const table = database.classroomRooms;
  const [row] = await database.db.select().from(table).where(and(eq(table.code, code), gt(table.expiresAt, new Date()))).limit(1);
  const room = roomFromRow(row);
  if (room) rooms.set(code, room);
  return room;
}
async function insertRoom(room) {
  if (!database) return true;
  const result = await database.db.insert(database.classroomRooms).values(databaseValues(room)).onConflictDoNothing({ target: database.classroomRooms.code }).returning({ code: database.classroomRooms.code });
  return result.length > 0;
}
async function persistRoom(room, userId, viaInvite = false) {
  if (!database) return;
  const table = database.classroomRooms;
  const scope = viaInvite ? eq(table.code, room.code) : roomScope(room.code, userId);
  const result = await database.db.update(table).set(databaseValues(room)).where(scope).returning({ code: table.code });
  if (!result.length) throw Object.assign(new Error('রুমটি আর পাওয়া যাচ্ছে না।'), { status: 404 });
}
async function loadData() {
  if (database) {
    const table = database.classroomRooms;
    const existing = await database.db.select({ code: table.code }).from(table).limit(1);
    if (!existing.length && fs.existsSync(DATA_FILE)) {
      const legacy = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      const values = (legacy.rooms || []).filter(room => room && room.code && room.members && Array.isArray(room.members)).map(room => {
        ensureMicState(room);
        return databaseValues(room);
      });
      if (values.length) await database.db.insert(table).values(values).onConflictDoNothing({ target: table.code });
      console.log(`[data] ${values.length} টি পুরোনো রুম Neon-এ কপি হয়েছে`);
    }
    return;
  }
  try {
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const r of j.rooms || []) if (r && r.code) { ensureMicState(r); rooms.set(r.code, r); }
    console.log(`[data] ${rooms.size} টি রুম লোড হয়েছে`);
  } catch (_) { /* প্রথমবার চালু — ফাইল নেই */ }
}
let dirty = false;
function markDirty() { if (!database) dirty = true; }
function persist() {
  if (database || !dirty) return;
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
  const currentTime = Date.now();
  for (const [code, room] of rooms) if (currentTime - room.updatedAt > ROOM_TTL_MS) { rooms.delete(code); streams.delete(code); markDirty(); }
  if (database) {
    database.db.delete(database.classroomRooms).where(lte(database.classroomRooms.expiresAt, new Date()))
      .catch(error => console.error('[retention]', error.message));
  }
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

const roomSessionSecret = () => process.env.ROOM_SESSION_SECRET || process.env.BETTER_AUTH_SECRET || '';

async function issueRoomToken(roomCode, userId, memberId, role) {
  const secret = roomSessionSecret();
  if (secret.length < 32) throw Object.assign(new Error('রুম সেশন সুরক্ষার কনফিগারেশন নেই।'), { status: 503 });
  const { SignJWT } = await import('jose');
  return new SignJWT({ type: 'classroom', roomCode, memberId, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(new TextEncoder().encode(secret));
}

async function authenticate(req) {
  const token = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(req.headers.authorization || '')?.[1];
  const secret = roomSessionSecret();
  if (!token || secret.length < 32) return null;
  try {
    const { jwtVerify } = await import('jose');
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'] });
    if (payload.type !== 'classroom' || typeof payload.sub !== 'string' || !/^[A-Z0-9]{4,16}$/.test(payload.roomCode) || typeof payload.memberId !== 'string' || !['teacher', 'student'].includes(payload.role)) return null;
    return { id: payload.sub, roomCode: payload.roomCode, memberId: payload.memberId, role: payload.role };
  } catch (error) {
    if (/^(JWT|JWS|JWKS|JOSE)/.test(error?.name || '')) return null;
    console.error('[room-session] verification unavailable:', error?.name || 'Error');
    throw Object.assign(new Error('রুম সেশন যাচাই করা যাচ্ছে না।'), { status: 503 });
  }
}
function resolveRoomMember(room, userId, claimedMemberId) {
  let member = room.members.find(item => item.userId === userId);
  if (!member && claimedMemberId) {
    member = room.members.find(item => item.id === claimedMemberId && !item.userId);
    if (member) { member.userId = userId; touch(room); }
  }
  return member;
}

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
  const mic = ensureMicState(room);
  const publicMember = m => ({
    name: m.name, role: m.role, groupId: m.groupId, joinedAt: m.joinedAt,
    micStatus: m.micStatus || 'idle',
    ...(isOwner ? { id: m.id } : {}),
    ...(m.id === memberId ? { me: true } : {})
  });
  const grantMember = mic.grant && room.members.find(m => m.id === mic.grant.memberId);
  return {
    code: room.code,
    name: room.name,
    status: room.status,
    groups: room.groups.map(g => ({ id: g.id, name: g.name })),
    members: room.members.map(publicMember),
    mic: {
      queue: mic.queue.map(id => room.members.find(m => m.id === id)).filter(Boolean).map(publicMember),
      grant: grantMember ? { name: grantMember.name, state: mic.grant.state, ...(isOwner || grantMember.id === memberId ? { memberId: grantMember.id } : {}) } : null,
      mediaAvailable: false
    },
    you: me ? { id: me.id, role: me.role, groupId: me.groupId, isOwner, micStatus: me.micStatus || 'idle' } : null
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
async function apiCreate(req, res, ip, user) {
  if (!rateOk(ip, 'create', 20, 3600e3)) return fail(res, 429, 'অনেক বেশি রুম তৈরি। কিছুক্ষণ পর চেষ্টা করুন।');
  if (!database && rooms.size >= MAX_ROOMS) return fail(res, 503, 'সার্ভার এখন পূর্ণ।');
  const b = await readJSON(req);
  const name = clean(b.name, 80), memberName = clean(b.memberName, 60) || 'শিক্ষক';
  if (!name) return fail(res, 400, 'রুমের নাম দিন।');
  const teacher = user || { id: crypto.randomUUID() };
  const ownerId = rid();
  const room = {
    code: newCode(), name, status: 'live', ownerId, createdAt: now(), updatedAt: now(),
    groups: [{ id: rid(), name: 'গ্রুপ ১' }, { id: rid(), name: 'গ্রুপ ২' }],
    members: [{ id: ownerId, userId: teacher.id, name: memberName, role: 'teacher', groupId: null, joinedAt: now(), micStatus: 'idle' }],
    mic: { queue: [], grant: null }
  };
  touch(room);
  let inserted = false;
  let sessionToken = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    room.code = newCode();
    sessionToken = await issueRoomToken(room.code, teacher.id, ownerId, 'teacher');
    if (await insertRoom(room)) { inserted = true; break; }
  }
  if (!inserted) return fail(res, 503, 'এখন রুম তৈরি করা যাচ্ছে না।');
  rooms.set(room.code, room);
  send(res, 201, { memberId: ownerId, sessionToken, room: viewFor(room, ownerId) });
}

async function apiJoin(req, res, ip, user) {
  if (joinBlocked(ip)) return fail(res, 429, 'বারবার ভুল কোড দেওয়া হয়েছে। ১০ মিনিট পর চেষ্টা করুন।');
  if (!rateOk(ip, 'join', 60, 60e3)) return fail(res, 429, 'খুব দ্রুত অনুরোধ হচ্ছে।');
  const b = await readJSON(req);
  const code = clean(b.code, 16).toUpperCase().replace(/\s/g, '');
  if (user?.roomCode && user.roomCode !== code) return fail(res, 403, 'এই সেশন অন্য একটি রুমের।');
  const room = await loadRoomByInvite(code);
  if (!room) { joinFailed(ip); return fail(res, 404, 'এই কোডের রুম পাওয়া যায়নি।'); }
  if (room.status === 'ended') return fail(res, 410, 'এই রুমটি শেষ হয়ে গেছে।');
  const identity = user || { id: crypto.randomUUID() };
  const name = clean(b.name, 60) || 'অজ্ঞাত';
  let member = resolveRoomMember(room, identity.id, user ? b.memberId : null);
  if (member) {
    member.name = name;
    if (member.id !== room.ownerId) member.role = 'student';
  } else {
    if (room.members.length >= MAX_MEMBERS) return fail(res, 403, 'এই রুম পূর্ণ।');
    member = { id: rid(), userId: identity.id, name, role: 'student', groupId: null, joinedAt: now(), micStatus: 'idle' };
    room.members.push(member);
  }
  if (b.groupId && room.groups.some(g => g.id === b.groupId)) member.groupId = b.groupId;
  touch(room);
  await persistRoom(room, identity.id, true);
  broadcast(room);
  const role = member.id === room.ownerId ? 'teacher' : 'student';
  const sessionToken = await issueRoomToken(room.code, identity.id, member.id, role);
  send(res, 200, { memberId: member.id, sessionToken, room: viewFor(room, member.id) });
}

async function apiStreamTicket(req, res, code, user) {
  const room = await loadRoomForUser(code, user.id);
  if (!room) return fail(res, 404, 'রুম নেই।');
  const b = await readJSON(req);
  const member = resolveRoomMember(room, user.id, b.memberId);
  if (!member) return fail(res, 403, 'সদস্য নন।');
  const currentTime = now();
  for (const [key, value] of streamTickets) if (value.expiresAt <= currentTime) streamTickets.delete(key);
  const ticket = crypto.randomBytes(32).toString('base64url');
  streamTickets.set(ticket, { code, memberId: member.id, userId: user.id, expiresAt: currentTime + 30_000 });
  send(res, 200, { ticket, expiresAt: currentTime + 30_000 });
}

async function apiStream(req, res, code, ticket) {
  const details = streamTickets.get(ticket);
  streamTickets.delete(ticket);
  if (!details || details.code !== code || details.expiresAt <= now()) return fail(res, 403, 'স্ট্রিম টিকিট মেয়াদোত্তীর্ণ।');
  const { memberId, userId } = details;
  const room = await loadRoomForUser(code, userId);
  if (!room || !room.members.some(m => m.id === memberId && m.userId === userId)) return fail(res, 403, 'সদস্য নন।');
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
  res.on('close', () => {
    clearInterval(hb);
    streams.get(code)?.delete(entry);
    if (room.mic?.grant?.memberId === memberId) {
      revokeMic(room, memberId);
      touch(room);
      persistRoom(room, userId).then(() => broadcast(room)).catch(error => console.error('[persist]', error.message));
    }
  });
}

async function apiBoard(req, res, code, ip, user) {
  if (!rateOk(ip, 'board', 600, 60e3)) return fail(res, 429, 'খুব দ্রুত বোর্ড আপডেট হচ্ছে।');
  const room = await loadRoomForUser(code, user.id);
  if (!room) return fail(res, 404, 'রুম নেই।');
  const b = await readJSON(req, MAX_BOARD);
  const me = resolveRoomMember(room, user.id, b.memberId);
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
  await persistRoom(room, user.id);
  broadcastBoard(room);
  send(res, 200, { ok: true, seq });
}

async function apiAct(req, res, code, ip, user) {
  if (!rateOk(ip, 'act', 240, 60e3)) return fail(res, 429, 'খুব দ্রুত অনুরোধ হচ্ছে।');
  const room = await loadRoomForUser(code, user.id);
  if (!room) return fail(res, 404, 'রুম নেই।');
  const b = await readJSON(req);
  const me = resolveRoomMember(room, user.id, b.memberId);
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
      room.status = b.status;
      if (b.status === 'ended') {
        const mic = ensureMicState(room);
        mic.queue = [];
        if (mic.grant) revokeMic(room, mic.grant.memberId);
      }
      break;
    }
    case 'hand.raise': {
      if (isOwner || me.role !== 'student') return fail(res, 403, 'শুধু শিক্ষার্থীরা হাত তুলতে পারবেন।');
      if (room.status !== 'live') return fail(res, 409, 'ক্লাসটি এখন চালু নেই।');
      const mic = ensureMicState(room);
      if (mic.grant?.memberId === me.id) return fail(res, 409, 'আপনার মাইক অনুরোধ ইতিমধ্যে অনুমোদিত।');
      if (!mic.queue.includes(me.id)) mic.queue.push(me.id);
      me.micStatus = 'hand_raised';
      break;
    }
    case 'hand.lower': {
      if (isOwner || me.role !== 'student') return fail(res, 403, 'শুধু শিক্ষার্থীরা নিজের হাত নামাতে পারবেন।');
      const mic = ensureMicState(room);
      if (mic.grant?.memberId === me.id) return fail(res, 409, 'অনুমোদিত মাইক বন্ধ করতে শিক্ষককে বলুন।');
      mic.queue = mic.queue.filter(id => id !== me.id);
      me.micStatus = 'idle';
      break;
    }
    case 'hand.approve': {
      if (!isOwner) return needOwner();
      const mic = ensureMicState(room);
      const target = room.members.find(m => m.id === b.target);
      if (!target || target.id === room.ownerId || !mic.queue.includes(target.id)) return fail(res, 404, 'অপেক্ষমাণ অনুরোধ পাওয়া যায়নি।');
      if (mic.grant && mic.grant.memberId !== target.id) return fail(res, 409, 'এক সময়ে একজন শিক্ষার্থীর মাইক অনুমোদন করা যায়।');
      mic.queue = mic.queue.filter(id => id !== target.id);
      mic.grant = { memberId: target.id, state: 'approved_waiting', grantedAt: now() };
      target.micStatus = 'approved_waiting';
      break;
    }
    case 'hand.dismiss': {
      if (!isOwner) return needOwner();
      const mic = ensureMicState(room);
      const target = room.members.find(m => m.id === b.target);
      if (!target || !mic.queue.includes(target.id)) return fail(res, 404, 'অপেক্ষমাণ অনুরোধ পাওয়া যায়নি।');
      mic.queue = mic.queue.filter(id => id !== target.id);
      target.micStatus = 'idle';
      break;
    }
    case 'mic.revoke': {
      if (!isOwner) return needOwner();
      const mic = ensureMicState(room);
      if (!mic.grant || (b.target && mic.grant.memberId !== b.target)) return fail(res, 404, 'কোনো সক্রিয় মাইক অনুমতি নেই।');
      revokeMic(room, mic.grant.memberId);
      break;
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
      revokeMic(room, b.target);
      room.members = room.members.filter(m => m.id !== b.target); break;
    }
    default: return fail(res, 400, 'অজানা কাজ।');
  }
  touch(room);
  await persistRoom(room, user.id);
  broadcast(room);
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
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  try {
    const url = new URL(req.url, 'http://x');
    const ip = clientIp(req);
    const p = url.pathname;

    if (p === '/api/health') return send(res, 200, { ok: true, storage: useDatabase ? 'neon' : 'file' });

    if (p.startsWith('/api/')) {
      if (!rateOk(ip, 'all', 300, 60e3)) return fail(res, 429, 'খুব বেশি অনুরোধ।');
      let m = p.match(/^\/api\/rooms\/([A-Z0-9]{4,16})\/stream$/);
      if (req.method === 'GET' && m) return await apiStream(req, res, m[1], url.searchParams.get('t') || '');

      const user = await authenticate(req);
      if (req.headers.authorization && !user) return fail(res, 401, 'রুম সেশনটি মেয়াদোত্তীর্ণ বা অবৈধ।');
      if (req.method === 'POST' && p === '/api/rooms') return await apiCreate(req, res, ip, user);
      if (req.method === 'POST' && p === '/api/rooms/join') return await apiJoin(req, res, ip, user);
      if (!user) return fail(res, 401, 'রুমে যোগ দিতে কোড লিখুন।');
      m = p.match(/^\/api\/rooms\/([A-Z0-9]{4,16})\/(stream-ticket|board|act)$/);
      if (m && user.roomCode && user.roomCode !== m[1]) return fail(res, 403, 'এই সেশন অন্য একটি রুমের।');
      if (req.method === 'POST' && m?.[2] === 'stream-ticket') return await apiStreamTicket(req, res, m[1], user);
      if (req.method === 'POST' && m?.[2] === 'board') return await apiBoard(req, res, m[1], ip, user);
      if (req.method === 'POST' && m?.[2] === 'act') return await apiAct(req, res, m[1], ip, user);
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
loadData().then(() => {
  server.listen(PORT, () => console.log(`স্মার্ট ব্ল্যাকবোর্ড চালু: http://localhost:${PORT}`));
}).catch(error => {
  console.error('[startup] Room storage could not be initialized:', error.message);
  process.exitCode = 1;
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  persist();
  if (database) database.pool.end().finally(() => process.exit(0));
  else process.exit(0);
});
    
