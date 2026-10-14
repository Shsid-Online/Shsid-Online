import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { hashPassword, verifyPassword, migrateOneLegacyPassword } from '../worker/passwords.mjs';
import privacy from '../server/board-privacy.cjs';
import worker from '../worker/index.js';
const require = createRequire(import.meta.url);
const local = require('../server/store.js');
const allow = { limit: async () => ({ success: true }) };
const baseEnv = () => ({ GLOBAL_GUARD: { idFromName: x => x, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) }, API_RATE_LIMIT: allow, WRITE_RATE_LIMIT: allow, POST_RATE_LIMIT: allow, DUPLICATE_RATE_LIMIT: allow });

test('anonymous responses remove account linkage and preserve only own reaction identity', () => {
  const raw = { anonymous: true, authorId: 'secret-admin', ownerTokenDigest: 'secret', adminAnonymousAccountNumber: 1234, likes: ['secret-admin', 'me'], hearts: ['other'], savedBy: ['other'] };
  const safe = privacy.privateBoardItem(raw, { id: 'me', role: 'student' });
  assert.equal(safe.authorId, undefined); assert.equal(safe.ownerTokenDigest, undefined);
  assert.equal(safe.adminAnonymousAccountNumber, undefined);
  assert.deepEqual(safe.likes, ['anonymous', 'me']);
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.equal(raw.authorId, 'secret-admin');
  assert.equal(privacy.privateBoardItem(raw, { role: 'admin' }).authorId, 'secret-admin');
});
test('board attachments cannot embed third-party tracking URLs or verification videos', () => {
  const media = [
    { url: 'https://evil.test/pixel', name: 'private-name.jpg' },
    { url: 'https://www.shsid.online/api/media/verification%2Fsecret.mp4' },
    { url: 'https://www.shsid.online/api/media/uploads%2Fphoto.jpg', name: 'private-name.jpg' }
  ];
  const safe = privacy.privateBoardItem({ media });
  assert.equal(safe.media.length, 1); assert.equal(safe.media[0].name, 'Attachment');
  assert.equal(privacy.safeMediaUrl('javascript:alert(1)'), false);
});
test('Worker passwords are salted, non-reversible records and verify correctly', async () => {
  const password = 'test:unicode-秘密-password';
  const a = await hashPassword(password); const b = await hashPassword(password);
  assert.notEqual(a, b); assert.equal(a.includes(password), false);
  assert.equal(await verifyPassword(password, a), true);
  assert.equal(await verifyPassword('wrong', a), false);
  assert.equal(await verifyPassword(password, 'a'.repeat(32) + ':' + password), true);
  assert.equal(await verifyPassword(password, password), false);
  assert.equal(await verifyPassword('anything', 'pbkdf2-sha256$999999999$x$y'), false);
});
test('local passwords use scrypt and support legacy colon passwords for upgrade', () => {
  const value = local.hashPassword('test:password');
  assert.equal(value.includes('test:password'), false);
  assert.equal(local.verifyPassword('test:password', value), true);
  assert.equal(local.verifyPassword('wrong', value), false);
  assert.equal(local.verifyPassword('test:password', 'b'.repeat(32) + ':test:password'), true);
});
test('background migration writes a conditional hash update without exposing passwords', async () => {
  let args;
  const legacy = 'c'.repeat(32) + ':test-password';
  const db = { prepare(sql) { return { first: async () => ({ id: 'user1', password_hash: legacy }), bind(...a) { args = a; assert.match(sql, /and password_hash=\?/); return { run: async () => ({}) }; } }; } };
  assert.equal(await migrateOneLegacyPassword(db), true);
  assert.equal(await verifyPassword('test-password', args[0]), true);
  assert.equal(args[1], 'user1'); assert.equal(args[2], legacy);
});
test('verification videos reject unauthenticated requests before reading storage', async () => {
  const e = baseEnv(); e.R2_BUCKET = { head() { throw new Error('private object touched'); } };
  const response = await worker.fetch(new Request('https://www.shsid.online/api/media/verification%2Fprivate.mp4'), e);
  assert.equal(response.status, 403);
});
test('legacy OAuth entry and stateless callbacks are rejected', async () => {
  assert.equal((await worker.fetch(new Request('https://www.shsid.online/auth/facebook/start'), baseEnv())).status, 403);
  assert.equal((await worker.fetch(new Request('https://www.shsid.online/auth/facebook/callback?code=fake'), baseEnv())).status, 400);
});
test('existing SVG uploads download sandboxed and cannot execute as same-origin documents', async () => {
  const e = baseEnv(); e.R2_BUCKET = {
    head: async () => ({ size: 6, httpEtag: 'etag', writeHttpMetadata(h) { h.set('content-type', 'image/svg+xml'); } }),
    get: async () => ({ body: '<svg/>' })
  };
  const result = await worker.fetch(new Request('https://www.shsid.online/api/media/uploads%2Ftest.svg'), e);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('content-disposition'), 'attachment');
  assert.match(result.headers.get('content-security-policy'), /sandbox/);
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
});
test('registration cannot bypass OTP attempt limits by skipping verify-code', async () => {
  const e = baseEnv();
  let record = { codeHash: 'not-the-supplied-code', attempts: 0, expiresAt: Date.now() + 60000 };
  e.DB = { prepare: () => ({ bind: () => ({ first: async () => ({ id: 'new-user', password_hash: null }) }) }) };
  e.SESSIONS = { get: async () => JSON.stringify(record), put: async (key, value) => { record = JSON.parse(value); } };
  const req = () => new Request('https://www.shsid.online/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'test@example.invalid', password: 'test-password', username: 'tester', code: '111111', firebaseVerified: true }) });
  for (let i = 0; i < 5; i++) assert.equal((await worker.fetch(req(), e)).status, 400);
  assert.equal((await worker.fetch(req(), e)).status, 429);
});
test('real public feed serialization never emits hidden account IDs or owner digests', async () => {
  const e = baseEnv();
  const post = { id: 'post1', author_id: 'private-admin-id', owner_token_digest: 'private-owner', anonymous: 1,
    admin_anonymous_account_number: 1234, text: 'hello', media: '[]', likes: '["private-admin-id"]', hearts: '[]', saved_by: '[]' };
  const comment = { ...post, id: 'comment1', post_id: 'post1', admin_anonymous_account_number: 2345 };
  e.DB = {
    batch: async () => [],
    prepare(sql) {
      const statement = {
        bind() { return statement; }, run: async () => ({}),
        first: async () => ({ id: 'guest-id' }),
        all: async () => ({ results: sql.startsWith('select * from posts') ? [post] : sql.startsWith('select * from comments') ? [comment] : [] })
      };
      return statement;
    }
  };
  const response = await worker.fetch(new Request('https://www.shsid.online/api/posts'), e);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.posts[0].anonymousLabel, 'Anonymous 1234');
  assert.equal(body.posts[0].comments[0].anonymousLabel, 'Anonymous 2345');
  assert.equal(body.posts[0].likes.length, 1);
  assert.equal(JSON.stringify(body).includes('private-'), false);
});
