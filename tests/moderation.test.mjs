import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../worker/index.js';
import { ensureModerationSchema, provisionModerator, withModeratorRole } from '../worker/moderation.mjs';
import moderation from '../server/moderation.cjs';
import { hashPassword, verifyPassword } from '../worker/passwords.mjs';

async function setup() {
  const queries = [];
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../d1/schema.sql', import.meta.url), 'utf8'));
  const db = { prepare(query) {
    queries.push(query);
    let values = [];
    const statement = {
      bind(...args) { values = args; return statement; },
      async first() { return sql.prepare(query).get(...values) || null; },
      async all() { return { results: sql.prepare(query).all(...values) }; },
      async run() { const r = sql.prepare(query).run(...values); return { meta: { changes: r.changes } }; }
    }; return statement;
  }, async batch(statements) {
    sql.exec('BEGIN');
    try { const results = []; for (const s of statements) results.push(await s.run()); sql.exec('COMMIT'); return results; }
    catch (e) { sql.exec('ROLLBACK'); throw e; }
  }};
  const kv = new Map();
  const allow = { limit: async () => ({ success: true }) };
  const env = { DB: db, UPLOAD_SIGNING_SECRET: 'test-signing-secret',
    API_RATE_LIMIT: allow, WRITE_RATE_LIMIT: allow, POST_RATE_LIMIT: allow, DUPLICATE_RATE_LIMIT: allow,
    GLOBAL_GUARD: { idFromName: x => x, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
    SESSIONS: { get: async key => kv.get(key) || null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) }
  };
  await ensureModerationSchema(db);
  for (const [id, role] of [['admin', 'admin'], ['mod', 'student'], ['student', 'student']]) {
    sql.prepare("INSERT INTO users (id,email,role,status,english_name,anonymous_account_number,created_at,updated_at) VALUES (?,?,?,'verified',?,?,?,?)")
      .run(id, `${id}@system.local`, role, id, id === 'admin' ? 1234 : id === 'mod' ? 2345 : 3456, '2020-01-01', '2020-01-01');
    kv.set(`session:${createHash('sha256').update(id).digest('hex')}`, id);
  }
  sql.prepare('INSERT INTO board_moderators VALUES (?,?)').run('mod', '2020-01-01');
  sql.prepare("INSERT INTO posts (id,author_id,title,text,post_number,anonymous,created_at) VALUES ('post','admin','hidden subject','hidden body',1234,1,'2020-01-01')").run();
  sql.prepare("INSERT INTO comments (id,post_id,author_id,text,anonymous,created_at) VALUES ('comment','post','student','hidden reply',1,'2020-01-01')").run();
  const request = async (path, role = '', method = 'GET', body = {}) => worker.fetch(new Request(`https://www.shsid.online/api${path}`, {
    method, headers: role ? { Authorization: `Bearer ${role}`, 'Content-Type': 'application/json' } : {},
    ...(method !== 'GET' && method !== 'HEAD' ? { body: JSON.stringify(body) } : {})
  }), env);
  return { sql, env, kv, request, queries };
}

test('moderator can hide but cannot restore or delete; admin retains and restores the entire post', async () => {
  const { request, sql } = await setup();
  assert.equal((await request('/posts/post/hide', 'student', 'POST')).status, 403);
  assert.equal((await request('/posts/post/hide', 'mod', 'POST')).status, 200);
  for (const role of ['', 'student', 'mod']) {
    assert.equal((await request('/posts/post', role)).status, 404);
    assert.equal((await request('/posts/post/comments', role, 'POST', { text: 'test' })).status, role === 'mod' ? 403 : 404);
  }
  assert.equal(sql.prepare("SELECT deleted_at FROM posts WHERE id='post'").get().deleted_at, null);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 1);
  assert.equal((await request('/posts/post/restore', 'mod', 'POST')).status, 403);
  assert.equal((await request('/posts/post', 'mod', 'DELETE')).status, 403);
  const adminPost = await (await request('/posts/post', 'admin')).json();
  assert.equal(adminPost.post.hidden, true);
  assert.equal(adminPost.post.text, 'hidden body');
  assert.equal(adminPost.post.comments[0].text, 'hidden reply');
  assert.equal((await request('/posts/post/restore', 'admin', 'POST')).status, 200);
  assert.equal((await request('/posts/post', 'student')).status, 200);
});

test('moderator signs in by username and a banned moderator loses access', async () => {
  const { request, sql } = await setup();
  sql.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword('test-password-only'), 'mod');
  const response = await request('/auth/login', '', 'POST', {identifier:'mod',password:'test-password-only'});
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.user.role, 'moderator');
  assert.ok(result.session.token);
  sql.prepare("UPDATE users SET status='banned' WHERE id='mod'").run();
  assert.equal((await request('/posts/post/hide','mod','POST')).status,403);
});

test('compact login skips unused social graph queries but retains role and session', async () => {
  const {request,sql,queries}=await setup();
  sql.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword('test-password-only'),'mod');
  queries.length=0;
  const response=await request('/auth/login','','POST',{identifier:'mod',password:'test-password-only',compact:true});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.user.role,'moderator');
  assert.ok(result.session.token);
  assert.ok(!queries.some(query=>/from follows/i.test(query)));
  assert.equal(result.user.followers,undefined);
});

test('combined startup gives each viewer fresh permissions without caching private account data', async () => {
  const {request,queries}=await setup();
  for (const [token,role] of [['admin','admin'],['mod','moderator'],['student','student'],['',null]]) {
    queries.length=0;
    const response=await request('/posts?includeViewer=1',token);
    assert.equal(response.status,200);
    const result=await response.json();
    assert.equal(result.viewer?.role??null,role);
    if(token) assert.equal(result.viewer.id,token);
    assert.equal(result.viewer?.password_hash,undefined);
    assert.equal(result.viewer?.followers,undefined);
    assert.ok(!queries.some(query=>/from follows/i.test(query)));
  }
});

test('feed cache never mixes admin visibility into readers and quote previews are redacted', async () => {
  const { request, sql } = await setup();
  sql.prepare("INSERT INTO posts (id,author_id,title,text,post_number,anonymous,quote_ref,created_at) VALUES ('quote','student','public subject','public body',1235,1,?,'2020-01-02')")
    .run(JSON.stringify({ postId: 'post', label: 'hidden subject', excerpt: 'hidden body' }));
  let publicFeed = await (await request('/posts')).json();
  assert.equal(publicFeed.posts.length, 2);
  await request('/posts/post/hide', 'mod', 'POST');
  const adminFeed = await (await request('/posts', 'admin')).json();
  assert.equal(adminFeed.posts.length, 2);
  assert.equal(adminFeed.posts.find(p => p.id === 'post').hidden, true);
  publicFeed = await (await request('/posts')).json();
  assert.deepEqual(publicFeed.posts.map(p => p.id), ['quote']);
  assert.equal(publicFeed.posts[0].quoteRef, null);
  assert.ok(!JSON.stringify(publicFeed).includes('hidden body'));
});

test('visibility is rechecked outside cached feed rows and preserves pagination advancement', async () => {
  const { request, sql } = await setup();
  const before = await (await request('/posts?limit=1')).json();
  sql.prepare('INSERT INTO hidden_board_posts VALUES (?,?,?)').run('post', '2020-01-02', 'mod');
  const after = await (await request(`/posts?limit=1&before=${encodeURIComponent(before.pagination.snapshot)}`)).json();
  assert.deepEqual(after.posts, []);
});

test('moderator permissions are an allowlist and anonymous authors remain anonymous', async () => {
  const { request } = await setup();
  const profile = await (await request('/me', 'mod')).json();
  assert.equal(profile.user.role, 'moderator');
  const feed = await (await request('/posts', 'mod')).json();
  const post = feed.posts[0];
  assert.equal(post.authorId, undefined); assert.equal(post.author, null); assert.equal(post.adminAuthor, undefined);
  assert.equal(post.canDelete, false); assert.equal(post.comments[0].canDelete, false);
  for (const [method, path] of [
    ['GET', '/admin/instagram'], ['POST', '/admin/instagram/start'], ['GET', '/admin/reports'],
    ['GET', '/admin/users'], ['GET', '/students'], ['GET', '/conversations'], ['POST', '/posts'],
    ['PATCH', '/posts/post'], ['DELETE', '/posts/post/comments/comment'], ['POST', '/upload-url'],
    ['POST', '/auth/register'], ['PATCH', '/me']
  ]) assert.equal((await request(path, 'mod', method)).status, 403, `${method} ${path}`);
});

test('a student cannot claim moderator status through payloads or username', async () => {
  const { request, env, sql } = await setup();
  sql.prepare("UPDATE users SET english_name='moderator' WHERE id='student'").run();
  const user = sql.prepare("SELECT * FROM users WHERE id='student'").get();
  assert.equal((await withModeratorRole(env, user)).role, 'student');
  assert.equal((await request('/posts/post/hide', 'student', 'POST', { role: 'moderator', isAdmin: true })).status, 403);
});

test('local visibility and moderator allowlist match Worker semantics', () => {
  const p = { hiddenAt: '2020-01-01' };
  assert.equal(moderation.canReadPost(p, null), false);
  assert.equal(moderation.canReadPost(p, { role: 'moderator' }), false);
  assert.equal(moderation.canReadPost(p, { role: 'admin' }), true);
  assert.equal(moderation.canReadPost({ ...p, deletedAt: '2020-01-02' }, { role: 'admin' }), false);
  assert.equal(moderation.moderatorRouteAllowed('POST', '/posts/a/hide'), true);
  assert.equal(moderation.moderatorRouteAllowed('POST', '/posts/a/restore'), false);
});

test('one-time provisioning creates only a restricted account with a salted password hash', async () => {
  const { env, sql, kv } = await setup();
  const passwordHash = await hashPassword('test-only-password');
  env.MODERATOR_SETUP = JSON.stringify({ id: 'usr_test-mod', username: 'gh2323', passwordHash });
  await provisionModerator(env);
  const user = sql.prepare("SELECT * FROM users WHERE id='usr_test-mod'").get();
  assert.equal(user.role, 'student');
  assert.equal((await withModeratorRole(env, user)).role, 'moderator');
  assert.equal(await verifyPassword('test-only-password', user.password_hash), true);
  assert.ok(kv.has('maintenance:moderator:usr_test-mod'));
  // Simulate a lost completion marker; recover without resetting credentials.
  kv.delete('maintenance:moderator:usr_test-mod');
  await provisionModerator(env);
  assert.ok(kv.has('maintenance:moderator:usr_test-mod'));
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM users WHERE english_name='gh2323'").get().n, 1);
});

test('provisioning never promotes or overwrites an existing username', async () => {
  const { env, sql } = await setup();
  env.MODERATOR_SETUP = JSON.stringify({ id: 'usr_new-mod', username: 'admin', passwordHash: await hashPassword('test-only-password') });
  await assert.rejects(provisionModerator(env), /already in use/);
  assert.equal(sql.prepare("SELECT role FROM users WHERE id='admin'").get().role, 'admin');
  assert.equal(sql.prepare("SELECT id FROM users WHERE id='usr_new-mod'").get(), undefined);
});
