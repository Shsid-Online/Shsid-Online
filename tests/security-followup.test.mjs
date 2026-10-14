import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { feedSnapshot } from '../worker/feed-snapshot.mjs';
function setup(status = 'verified') {
  const user = { id: 'viewer', email: 'viewer@example.invalid', role: 'student', status };
  const allow = { limit: async () => ({ success: true }) };
  const calls = [];
  const env = { API_RATE_LIMIT: allow, WRITE_RATE_LIMIT: allow, POST_RATE_LIMIT: allow, DUPLICATE_RATE_LIMIT: allow,
    GLOBAL_GUARD: { idFromName: x => x, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
    UPLOAD_SIGNING_SECRET: 'test-only-key', SESSIONS: { get: async () => user.id },
    DB: { batch: async () => [], prepare(sql) { calls.push(sql); return { run: async () => ({}), bind(...args) { calls.push(args); return this; },
      first: async () => sql.includes('from conversations') ? { id: 'chat', members: '["viewer","sender"]' } : user,
      all: async () => ({ results: sql.includes('from messages') ? [{ id: 'message', author_id: 'sender', text: 'hello', anonymous: 1 }] : [] }) }; } } };
  const call = (path, method = 'GET', body) => worker.fetch(new Request(`https://www.shsid.online/api/${path}`, { method, headers: { Authorization: 'Bearer fake', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  return { env, user, call, calls };
}
test('anonymous messages hide other senders but preserve self/admin visibility', async () => {
  const s = setup();
  assert.equal((await (await s.call('conversations/chat/messages')).json()).messages[0].authorId, null);
  s.user.role = 'admin';
  assert.equal((await (await s.call('conversations/chat/messages')).json()).messages[0].authorId, 'sender');
  s.user.role = 'student'; s.user.id = 'sender';
  assert.equal((await (await s.call('conversations/chat/messages')).json()).messages[0].authorId, 'sender');
});
test('banned sessions are denied across reads, guest-capable writes and upload issuance', async () => {
  const s = setup('banned');
  for (const [path, method, body] of [['conversations/chat/messages', 'GET'], ['posts', 'POST', { text: 'test' }], ['upload-url', 'POST', { fileName: 'x.mp4', contentType: 'video/mp4', purpose: 'verification' }]]) {
    assert.equal((await s.call(path, method, body)).status, 403);
  }
});
test('unverified accounts cannot read directory; verified queries are bounded and omit password columns', async () => {
  const s = setup('pending_verification');
  assert.equal((await s.call('students')).status, 403);
  s.user.status = 'verified';
  assert.equal((await s.call('students?limit=10000')).status, 200);
  const sql = s.calls.find(q => typeof q === 'string' && q.includes("role='student'") && q.trim().startsWith('select'));
  assert.match(sql, /status='verified'/); assert.match(sql, /limit \? offset \?/);
  assert.doesNotMatch(sql, /select \*|password_hash/);
  assert.ok(s.calls.some(v => Array.isArray(v) && v[0] === 101 && v[1] === 0));
});
test('old message notifications are redacted on read', async () => {
  const s = setup();
  const original = s.env.DB.prepare;
  s.env.DB.prepare = sql => {
    const statement = original(sql);
    if (sql.includes('from notifications')) statement.all = async () => ({results:[{id:'old',type:'message_new',body:'Private Name sent you a new message.'}]});
    return statement;
  };
  const response = await s.call('notifications');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.notifications[0].text, 'You received a new message.');
  assert.equal(JSON.stringify(body).includes('Private Name'), false);
});
test('feed snapshots reject forged timestamps and expire without breaking valid pagination', async () => {
  const now = 1800000000000;
  const a = await feedSnapshot(null, 'key', now);
  assert.deepEqual(await feedSnapshot(a.token, 'key', now + 1000), a);
  assert.equal(await feedSnapshot(a.before, 'key', now), null);
  assert.equal(await feedSnapshot(a.token, 'different-key', now), null);
  assert.equal(await feedSnapshot(a.token, 'key', now + 86400001), null);
  assert.equal((await feedSnapshot(null, 'key', now + 1000)).token, a.token);
});
test('signed upload replay is rejected with an atomic conditional storage write', async () => {
  const s = setup(); let exists = false; let writes = 0;
  s.env.R2_BUCKET = { put: async (key, body, options) => { assert.equal(options.onlyIf.get('If-None-Match'), '*'); if (exists) return null; exists = true; writes++; return { key }; } };
  const signed = await (await s.call('upload-url', 'POST', { fileName: 'x.png', contentType: 'image/png' })).json();
  const put = () => worker.fetch(new Request(signed.uploadUrl, { method: 'PUT', body: 'abc', headers: { 'Content-Type': 'image/png', 'Content-Length': '3' } }), s.env);
  assert.equal((await put()).status, 200); assert.equal((await put()).status, 409); assert.equal(writes, 1);
});
