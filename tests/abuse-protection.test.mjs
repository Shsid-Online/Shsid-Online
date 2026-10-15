import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectRequest, rejectDuplicate } from '../worker/abuse-protection.mjs';
import worker from '../worker/index.js';
import { cachedRead, clearReadCache } from '../worker/read-cache.mjs';
import { ensureReadIndexes } from '../worker/database-indexes.mjs';

function limiter(max) {
  const counts = new Map();
  return { async limit({ key }) { const count = (counts.get(key) || 0) + 1; counts.set(key, count); return { success: count <= max }; } };
}
function env() { return { GLOBAL_GUARD: { idFromName: x => x, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) }, API_RATE_LIMIT: limiter(240), WRITE_RATE_LIMIT: limiter(40), POST_RATE_LIMIT: limiter(6), DUPLICATE_RATE_LIMIT: limiter(1) }; }
function request(method = 'POST', owner = 'device', ip = '192.0.2.1') {
  return new Request('https://www.shsid.online/api/posts', { method, headers: { 'CF-Connecting-IP': ip, 'X-Board-Owner-Token': owner } });
}
test('rotating owner tokens cannot bypass the IP posting budget', async () => {
  const e = env();
  for (let i = 0; i < 6; i++) assert.equal(await protectRequest(request('POST', String(i)), e, '/posts'), null);
  assert.equal((await protectRequest(request('POST', 'new'), e, '/posts')).status, 429);
  assert.equal(await protectRequest(request('GET'), e, '/posts'), null);
});
test('owner budget also follows clients across IP changes', async () => {
  const e = env();
  for (let i = 0; i < 6; i++) assert.equal(await protectRequest(request('POST', 'same', `192.0.2.${i}`), e, '/posts'), null);
  assert.equal((await protectRequest(request('POST', 'same', '192.0.2.99'), e, '/posts')).status, 429);
});
test('duplicates normalize text and do not mix reply targets', async () => {
  const e = env();
  assert.equal(await rejectDuplicate(e, '/posts/a/comments', { text: 'Hello' }), null);
  assert.equal((await rejectDuplicate(e, '/posts/a/comments', { text: ' hello ' })).status, 429);
  assert.equal(await rejectDuplicate(e, '/posts/b/comments', { text: 'hello' }), null);
});
test('blocked requests never touch D1, sessions, or parse their body', async () => {
  const e = env(); e.API_RATE_LIMIT = limiter(0);
  Object.defineProperty(e, 'DB', { get() { throw new Error('D1 accessed'); } });
  const result = await worker.fetch(request(), e);
  assert.equal(result.status, 429);
  assert.equal(result.headers.get('Retry-After'), '60');
});
test('blocked reply phrases including invisible characters fail before database access', async () => {
  for(const text of ['马校长万岁','马\u200b校长万岁','gay']) {
    const e=env();
    Object.defineProperty(e,'DB',{get(){throw new Error('D1 accessed');}});
    const result=await worker.fetch(new Request('https://www.shsid.online/api/posts/test/comments',{
      method:'POST',body:JSON.stringify({text})
    }),e);
    assert.equal(result.status,400);
    assert.match((await result.json()).error,/spam pattern/);
  }
});
test('missing limit binding fails closed; health remains available', async () => {
  assert.equal((await worker.fetch(request(), {})).status, 503);
  assert.equal((await worker.fetch(new Request('https://www.shsid.online/health'), {})).status, 200);
});
test('oversized JSON without Content-Length is rejected before D1', async () => {
  const req = new Request('https://www.shsid.online/api/posts', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(300000) }) });
  assert.equal((await worker.fetch(req, env())).status, 413);
});
test('concurrent reads coalesce and caller mutations cannot leak between viewers', async () => {
  const db = {}; let calls = 0;
  const read = async () => { calls++; return { rows: [{ id: 'a' }] }; };
  const [a, b] = await Promise.all([cachedRead(db, 'feed', read), cachedRead(db, 'feed', read)]);
  assert.equal(calls, 1); a.rows[0].admin = true;
  assert.equal(b.rows[0].admin, undefined);
  clearReadCache(db); await cachedRead(db, 'feed', read); assert.equal(calls, 2);
});
test('failed reads are not cached', async () => {
  const db = {};
  await assert.rejects(cachedRead(db, 'feed', async () => { throw new Error('offline'); }));
  assert.equal(await cachedRead(db, 'feed', async () => 'recovered'), 'recovered');
});
test('index installation coalesces and only runs once after success', async () => {
  let batches = 0;
  const db = { prepare: sql => sql, batch: async statements => { batches++; assert.equal(statements.length, 4); } };
  await Promise.all([ensureReadIndexes(db), ensureReadIndexes(db)]);
  await ensureReadIndexes(db); assert.equal(batches, 1);
});
test('index failures back off instead of hammering exhausted D1', async () => {
  let batches = 0;
  const db = { prepare: sql => sql, batch: async () => { batches++; throw new Error('quota'); } };
  await assert.rejects(ensureReadIndexes(db));
  await assert.rejects(ensureReadIndexes(db));
  assert.equal(batches, 1);
});
