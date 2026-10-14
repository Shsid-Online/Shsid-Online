import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardAbuseGuard } from '../worker/global-guard.mjs';
import { protectRequest } from '../worker/abuse-protection.mjs';
import worker from '../worker/index.js';

function state() {
  const data = new Map(); let tail = Promise.resolve();
  const tx = { get: async key => data.get(key), put: async values => Object.entries(values).forEach(([k,v]) => data.set(k,v)) };
  return { storage: { transaction(fn) { const pending = tail.then(() => fn(tx)); tail = pending.catch(() => {}); return pending; } }, data };
}
const request = kind => new Request(`https://guard/${kind}`);
test('concurrent distributed submissions share one budget, persisted across restarts', async () => {
  const s = state(); const guard = new BoardAbuseGuard(s);
  const results = await Promise.all(Array.from({ length: 30 }, () => guard.fetch(request('content'))));
  assert.equal(results.filter(r => r.status === 204).length, 20);
  assert.equal((await new BoardAbuseGuard(s).fetch(request('content'))).status, 429);
  assert.equal((await guard.fetch(request('read'))).status, 204);
  assert.equal(s.data.size, 4);
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
