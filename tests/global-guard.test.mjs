import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardAbuseGuard } from '../worker/global-guard.mjs';
import { protectRequest, rejectDuplicate } from '../worker/abuse-protection.mjs';
import worker from '../worker/index.js';

function state() {
  const data = new Map(); let tail = Promise.resolve();
  const tx = { get: async key => data.get(key), put: async values => Object.entries(values).forEach(([k,v]) => data.set(k,v)) };
  return { storage: { transaction(fn) { const pending = tail.then(() => fn(tx)); tail = pending.catch(() => {}); return pending; } }, data };
}
const request = kind => new Request(`https://guard/${kind}`);
test('global duplicates persist across time, clients, counters and object restarts', async () => {
  const s = state();
  const allow = { limit: async () => ({ success: true }) };
  const env = { DUPLICATE_RATE_LIMIT: allow, GLOBAL_GUARD: {
    idFromName: name => name, get: () => ({ fetch: req => new BoardAbuseGuard(s).fetch(req) })
  } };
  const originalNow = Date.now;
  let time = originalNow(); Date.now = () => time;
  const req = ip => new Request('https://www.shsid.online/api/posts', { headers: { 'CF-Connecting-IP': ip } });
  try {
    const results = await Promise.all(Array.from({length: 8}, (_, i) => rejectDuplicate(env, '/posts', { text: 'Repeated campaign', title: `spam #${i}` }, req(`192.0.2.${i}`))));
    assert.equal(results.filter(r => r === null).length, 1);
    time += 3600000;
    assert.equal((await rejectDuplicate(env, '/posts', { text: 'Repeated\u200b campaign', title: 'different' }, req('192.0.2.55'))).status, 429);
    assert.equal((await rejectDuplicate(env, '/posts', { text: ' REPEATED   CAMPAIGN!!!', title: 'different' }, req('192.0.2.56'))).status, 429);
    time += 86400001;
    assert.equal(await rejectDuplicate(env, '/posts', { text: 'Repeated campaign' }, req('192.0.2.1')), null);
  } finally { Date.now = originalNow; }
});
test('sustained distinct submissions share a persistent client budget across endpoints', async () => {
  const s = state(); const originalNow = Date.now; let time = originalNow(); Date.now = () => time;
  const client = 'a'.repeat(64);
  const submit = n => new BoardAbuseGuard(s).fetch(new Request('https://guard/submission', { method:'POST', body:JSON.stringify({ client, fingerprint:n.toString(16).padStart(64,'0') }) }));
  try {
    for(let i=0;i<5;i++) { assert.equal((await submit(i)).status,204); time+=30000; }
    assert.equal((await submit(5)).status,429);
    time+=360000;
    assert.equal((await submit(6)).status,204);
    assert.equal((await new BoardAbuseGuard(s).fetch(request('read'))).status,204);
  } finally { Date.now=originalNow; }
});
test('concurrent distributed submissions share one budget, persisted across restarts', async () => {
  const s = state(); const guard = new BoardAbuseGuard(s);
  const results = await Promise.all(Array.from({ length: 30 }, () => guard.fetch(request('content'))));
  assert.equal(results.filter(r => r.status === 204).length, 20);
  assert.equal((await new BoardAbuseGuard(s).fetch(request('content'))).status, 429);
  assert.equal((await guard.fetch(request('read'))).status, 204);
  assert.equal(s.data.size, 7);
});
test('rolling budget is not replenished by the daily quota reset', async () => {
  const s = state(); const guard = new BoardAbuseGuard(s);
  s.data.set('rolling-all-v1', { tokens: 0, at: Date.now() });
  s.data.set('day', { bucket: -1, count: 12000 });
  assert.equal((await guard.fetch(request('read'))).status, 429);
  s.data.set('rolling-all-v1', { tokens: 0, at: Date.now() - 3600000 });
  assert.equal((await guard.fetch(request('read'))).status, 204);
});
test('deep pagination is charged proportionally and malformed costs are rejected', async () => {
  const s = state(); const guard = new BoardAbuseGuard(s);
  assert.equal((await guard.fetch(request('read?cost=101'))).status, 204);
  assert.equal((await guard.fetch(request('read?cost=101'))).status, 429);
  assert.equal((await guard.fetch(request('read?cost=NaN'))).status, 400);
});
test('auth and upload limits leave read capacity available', async () => {
  for (const kind of ['auth', 'upload']) {
    const guard = new BoardAbuseGuard(state());
    const count = kind === 'auth' ? 20 : 10;
    for (let i = 0; i < count; i++) assert.equal((await guard.fetch(request(kind))).status, 204);
    assert.equal((await guard.fetch(request(kind))).status, 429);
    assert.equal((await guard.fetch(request('read'))).status, 204);
  }
});
test('expired buckets reset while daily exhaustion survives minute boundaries', async () => {
  const s = state(); const guard = new BoardAbuseGuard(s);
  s.data.set('minute', { bucket: -1, count: 999 });
  assert.equal((await guard.fetch(request('read'))).status, 204);
  s.data.set('day', { bucket: Math.floor(Date.now()/86400000), count: 12000 });
  assert.equal((await guard.fetch(request('read'))).status, 429);
});
test('all clients use the same object, missing or failed guard blocks before database access', async () => {
  const allow = { limit: async () => ({ success: true }) };
  const env = { API_RATE_LIMIT: allow, WRITE_RATE_LIMIT: allow, POST_RATE_LIMIT: allow };
  const req = new Request('https://www.shsid.online/api/posts');
  assert.equal((await protectRequest(req, env, '/posts')).status, 503);
  env.GLOBAL_GUARD = { idFromName(name) { assert.equal(name, 'board-budget-v1'); return name; }, get() { return { fetch: async () => { throw new Error('offline'); } }; } };
  assert.equal((await protectRequest(req, env, '/posts')).status, 503);
});
test('published moderator credential is blocked before login database lookups', async () => {
  const allow = { limit: async () => ({ success: true }) };
  const env = { API_RATE_LIMIT: allow, WRITE_RATE_LIMIT: allow,
    GLOBAL_GUARD: { idFromName: x => x, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) } };
  Object.defineProperty(env, 'DB', { get() { throw new Error('database touched'); } });
  for (const path of ['login', 'register', 'start']) {
    const response = await worker.fetch(new Request(`https://www.shsid.online/api/auth/${path}`, { method: 'POST', body: JSON.stringify({ email: 'ADMIN-2@shsid.online', password: 'not-a-real-password' }) }), env);
    assert.equal(response.status, 403);
  }
});
