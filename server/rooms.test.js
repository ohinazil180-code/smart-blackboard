'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before health check: ${child.output}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become healthy: ${child.output}`);
}

async function request(baseUrl, route, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test('authenticated classroom roles, board writes, mic grants, and stream tickets are enforced', { timeout: 30_000 }, async t => {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { privateKey, publicKey } = await generateKeyPair('EdDSA');
  const keyId = 'smart-blackboard-test-key';
  const publicJwk = { ...await exportJWK(publicKey), alg: 'EdDSA', kid: keyId, use: 'sig' };
  const jwksPort = await reservePort();
  const jwksServer = createServer((req, res) => {
    if (req.url !== '/auth/.well-known/jwks.json') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise((resolve, reject) => {
    jwksServer.once('error', reject);
    jwksServer.listen(jwksPort, '127.0.0.1', resolve);
  });

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'smart-blackboard-test-'));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PORT: String(port),
      DATA_FILE: path.join(dataDir, 'rooms.json'),
      NEON_AUTH_BASE_URL: `http://127.0.0.1:${jwksPort}/auth`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.output = '';
  child.stdout.on('data', chunk => { child.output += chunk; });
  child.stderr.on('data', chunk => { child.output += chunk; });

  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    if (jwksServer.listening) await new Promise(resolve => jwksServer.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  const tokenFor = userId => new SignJWT({ role: 'authenticated', email: `${userId}@example.test` })
    .setProtectedHeader({ alg: 'EdDSA', kid: keyId })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  const teacherId = randomUUID();
  const firstStudentUserId = randomUUID();
  const secondStudentUserId = randomUUID();
  const [teacherToken, firstStudentToken, secondStudentToken] = await Promise.all([
    tokenFor(teacherId), tokenFor(firstStudentUserId), tokenFor(secondStudentUserId)
  ]);

  await waitForHealth(baseUrl, child);
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  assert.equal(health.headers.get('strict-transport-security'), 'max-age=63072000');
  assert.equal(health.headers.get('permissions-policy'), 'camera=(self), microphone=(self), geolocation=()');

  assert.equal((await request(baseUrl, '/api/rooms', { name: 'Unauthenticated class' })).status, 401);
  const created = await request(baseUrl, '/api/rooms', { name: 'Test class', memberName: 'Teacher' }, teacherToken);
  assert.equal(created.status, 201);
  const { code } = created.body.room;
  const teacherMemberId = created.body.memberId;

  const firstJoin = await request(baseUrl, '/api/rooms/join', { code, name: 'Student One', role: 'teacher' }, firstStudentToken);
  const secondJoin = await request(baseUrl, '/api/rooms/join', { code, name: 'Student Two', role: 'student' }, secondStudentToken);
  assert.equal(firstJoin.status, 200);
  assert.equal(secondJoin.status, 200);
  assert.equal(firstJoin.body.room.you.role, 'student', 'client role input cannot elevate a participant');
  const firstStudentId = firstJoin.body.memberId;
  const secondStudentId = secondJoin.body.memberId;

  const boardWrite = await request(baseUrl, `/api/rooms/${code}/board`, {
    memberId: firstStudentId,
    page: { items: [] }
  }, firstStudentToken);
  assert.equal(boardWrite.status, 403, 'students cannot mutate the teacher board');

  assert.equal((await request(baseUrl, `/api/rooms/${code}/act`, { memberId: firstStudentId, type: 'hand.raise' }, firstStudentToken)).status, 200);
  assert.equal((await request(baseUrl, `/api/rooms/${code}/act`, { memberId: firstStudentId, type: 'hand.approve', target: secondStudentId }, firstStudentToken)).status, 403);

  const firstApproval = await request(baseUrl, `/api/rooms/${code}/act`, { memberId: teacherMemberId, type: 'hand.approve', target: firstStudentId }, teacherToken);
  assert.equal(firstApproval.status, 200);
  assert.equal(firstApproval.body.room.mic.grant.state, 'approved_waiting');

  assert.equal((await request(baseUrl, `/api/rooms/${code}/act`, { memberId: secondStudentId, type: 'hand.raise' }, secondStudentToken)).status, 200);
  assert.equal((await request(baseUrl, `/api/rooms/${code}/act`, { memberId: teacherMemberId, type: 'hand.approve', target: secondStudentId }, teacherToken)).status, 409);
  assert.equal((await request(baseUrl, `/api/rooms/${code}/act`, { memberId: firstStudentId, type: 'mic.revoke' }, firstStudentToken)).status, 403);

  const revoke = await request(baseUrl, `/api/rooms/${code}/act`, { memberId: teacherMemberId, type: 'mic.revoke', target: firstStudentId }, teacherToken);
  assert.equal(revoke.status, 200);
  assert.equal(revoke.body.room.mic.grant, null);
  assert.equal(revoke.body.room.members.find(member => member.id === firstStudentId).micStatus, 'revoked');

  const secondApproval = await request(baseUrl, `/api/rooms/${code}/act`, { memberId: teacherMemberId, type: 'hand.approve', target: secondStudentId }, teacherToken);
  assert.equal(secondApproval.status, 200);
  const ticketResponse = await request(baseUrl, `/api/rooms/${code}/stream-ticket`, { memberId: secondStudentId }, secondStudentToken);
  assert.equal(ticketResponse.status, 200);

  const stream = await fetch(`${baseUrl}/api/rooms/${code}/stream?t=${encodeURIComponent(ticketResponse.body.ticket)}`);
  assert.equal(stream.status, 200);
  const replayedTicket = await fetch(`${baseUrl}/api/rooms/${code}/stream?t=${encodeURIComponent(ticketResponse.body.ticket)}`);
  assert.equal(replayedTicket.status, 403, 'stream tickets are one-time use');

  const whileConnected = await request(baseUrl, '/api/rooms/join', { code, name: 'Student Two', role: 'student', memberId: secondStudentId }, secondStudentToken);
  assert.equal(whileConnected.body.room.mic.grant.state, 'approved_waiting', 'opening the event stream must not revoke a grant');

  await stream.body.cancel();
  const deadline = Date.now() + 3_000;
  let disconnected;
  while (Date.now() < deadline) {
    disconnected = await request(baseUrl, '/api/rooms/join', { code, name: 'Student Two', role: 'student', memberId: secondStudentId }, secondStudentToken);
    if (!disconnected.body.room.mic.grant) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(disconnected.body.room.mic.grant, null, 'disconnecting the approved speaker revokes the grant');
});
