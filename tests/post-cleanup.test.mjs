import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runPostCleanup, CLEANUP_MARKER, CLEANUP_PHRASE } from '../worker/post-cleanup.mjs';

test('real SQL removes only matching live posts and preserves comments and prior deletion timestamps', async () => {
  const db = new DatabaseSync(':memory:'); const markers = new Map();
  try {
    db.exec('CREATE TABLE posts (id TEXT, title TEXT, text TEXT, deleted_at TEXT); CREATE TABLE comments (text TEXT);');
    const insert = db.prepare('INSERT INTO posts VALUES (?,?,?,?)');
    insert.run('title', '马蜂万岁!', 'body', null);
    insert.run('body', 'title', 'hello 马蜂万岁 hello', null);
    insert.run('safe', '马蜂', '万岁', null);
    insert.run('nulls', null, null, null);
    insert.run('deleted', '马蜂万岁', '', 'old-timestamp');
    db.prepare('INSERT INTO comments VALUES (?)').run('马蜂万岁');
    const env = { SESSIONS: { get: async k => markers.get(k), put: async (k,v) => markers.set(k,v) },
      DB: { prepare(sql) { return { bind(...args) { return { run: async () => ({success:true,meta:{changes:db.prepare(sql).run(...args).changes}}) }; } }; } } };
    assert.equal((await runPostCleanup(env)).matchedPosts, 2);
    assert.deepEqual(db.prepare('SELECT id FROM posts WHERE deleted_at IS NULL ORDER BY id').all().map(r => r.id), ['nulls','safe']);
    assert.equal(db.prepare("SELECT deleted_at FROM posts WHERE id='deleted'").get().deleted_at, 'old-timestamp');
    assert.equal(db.prepare('SELECT count(*) AS n FROM comments').get().n, 1);
    assert.deepEqual(await runPostCleanup(env), {skipped:true});
  } finally { db.close(); }
});

function setup() {
  const values = new Map(); let writes = 0;
  const env = { SESSIONS: { get: async k => values.get(k), put: async (k,v) => values.set(k,v) },
    DB: { prepare(sql) {
      assert.match(sql, /UPDATE posts SET deleted_at/);
      assert.match(sql, /WHERE deleted_at IS NULL/);
      assert.match(sql, /instr\(coalesce\(title/);
      assert.match(sql, /instr\(coalesce\(text/);
      assert.doesNotMatch(sql, /DELETE FROM|comments/);
      return { bind(timestamp, title, text) {
        assert.ok(Number.isFinite(Date.parse(timestamp)));
        assert.equal(title, CLEANUP_PHRASE); assert.equal(text, CLEANUP_PHRASE);
        return { run: async () => { writes++; return { success: true, meta: { changes: 3 } }; } };
      } };
    } } };
  return { env, values, writes: () => writes };
}
test('cleanup soft-deletes exact title/body matches and records completion only once', async () => {
  const s = setup();
  assert.equal((await runPostCleanup(s.env)).matchedPosts, 3);
  assert.equal(JSON.parse(s.values.get(CLEANUP_MARKER)).matchedPosts, 3);
  assert.deepEqual(await runPostCleanup(s.env), { skipped: true });
  assert.equal(s.writes(), 1);
});
test('quota failure leaves cleanup pending for the next scheduled retry', async () => {
  const s = setup(); const original = s.env.DB.prepare;
  s.env.DB.prepare = () => { throw new Error('daily row read limit'); };
  await assert.rejects(runPostCleanup(s.env));
  assert.equal(s.values.has(CLEANUP_MARKER), false);
  s.env.DB.prepare = original;
  assert.equal((await runPostCleanup(s.env)).matchedPosts, 3);
});
test('completion-marker failure is retried rather than silently abandoned', async () => {
  const s = setup(); const original = s.env.SESSIONS.put;
  s.env.SESSIONS.put = async () => { throw new Error('KV unavailable'); };
  await assert.rejects(runPostCleanup(s.env));
  assert.equal(s.values.has(CLEANUP_MARKER), false);
  s.env.SESSIONS.put = original;
  await runPostCleanup(s.env);
  assert.equal(s.values.has(CLEANUP_MARKER), true);
});
