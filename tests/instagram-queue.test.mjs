import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanedQueue, emptyQueue, isCompletedEntry, localQueue, queueAction, queueView, runQueue, INTERVAL_MINUTES, INTERVAL_MS } from "../server/instagram-queue.mjs";
import { mediaKey, exchangeConnection } from "../server/instagram-auth.mjs";

const credentials = { token: "test-token", userId: "test-ig" };
const post = { id: "post1", postNumber: 1234, title: "A selected post", category: "school" };
function fixture() {
  const store = { data: { instagramQueue: emptyQueue() }, save() {} };
  return { store, repo: localQueue(store) };
}
async function add(repo, p = post) {
  return queueAction(repo, "add", {}, credentials, p, "https://www.shsid.online/api/media/uploads%2Ftest.jpg", 0);
}
const response = data => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

test('post now publishes only the selected item from a paused queue and prevents concurrent duplicates', async () => {
  const { repo } = fixture();
  await add(repo);
  const job = await add(repo, { ...post, id: 'post2' });
  const selected = job.entries[1].id;
  await queueAction(repo, 'post-now', { id: selected }, credentials, null, null, 1);
  await assert.rejects(queueAction(repo, 'post-now', { id: selected }, credentials, null, null, 1), /pending/);
  const originalFetch = globalThis.fetch;
  let publications = 0;
  globalThis.fetch = async url => {
    if (String(url).includes('media_publish')) { publications++; return response({ id: 'published' }); }
    if (String(url).includes('status_code')) return response({ status_code: 'FINISHED' });
    return response({ id: 'container' });
  };
  try {
    await Promise.all([runQueue(repo, credentials, id => id === 'post2', 2), runQueue(repo, credentials, id => id === 'post2', 2)]);
    const result = await repo.read();
    assert.equal(publications, 1);
    assert.equal(result.active, false);
    assert.equal(result.immediateId, undefined);
    assert.deepEqual(result.entries.map(e => e.postId), ['post1']);
  } finally { globalThis.fetch = originalFetch; }
});

test('post now refuses unconnected and uncertain publications', async () => {
  const { repo, store } = fixture();
  const job = await add(repo);
  const id = job.entries[0].id;
  await assert.rejects(queueAction(repo, 'post-now', { id }, null, null, null, 1), /Connect/);
  store.data.instagramQueue.entries[0].status = 'review';
  await assert.rejects(queueAction(repo, 'post-now', { id }, credentials, null, null, 1), /review/);
});

test("queue is paused, deduplicates posts and builds board-number caption", async () => {
  const { repo } = fixture();
  const job = await add(repo);
  assert.equal(job.active, false);
  assert.equal(INTERVAL_MINUTES, 60);
  assert.equal(queueView(job, credentials).intervalMinutes, 60);
  assert.equal(job.entries[0].caption, "/campus/ No.1234");
  await assert.rejects(add(repo), /already/);
  await assert.rejects(queueAction(repo, "start", {}, null, null, null, 0), /Connect/);
  assert.equal(JSON.stringify(queueView(job, credentials)).includes("test-token"), false);
});

test("completed legacy entries are removed from storage and never shown", async () => {
  const { repo, store } = fixture();
  store.data.instagramQueue.entries = [
    { id: "published", postId: "old1", status: "published" },
    { id: "removed", postId: "old2", status: "removed" },
    { id: "posted", postId: "old3", status: "posted" },
    { id: "completed", postId: "old4", status: "completed" },
    { id: "legacy-media", postId: "old5", status: "review", publishedAt: 123, mediaId: "ig-1" }
  ];
  assert.equal(store.data.instagramQueue.entries.every(isCompletedEntry), true);
  assert.equal(queueView(store.data.instagramQueue, credentials).entries.length, 0);
  await cleanedQueue(repo);
  assert.equal((await repo.read()).entries.length, 0);
  await queueAction(repo, "add", {}, credentials, post, "https://www.shsid.online/api/media/uploads%2Ftest.jpg", 0);
  assert.deepEqual((await repo.read()).entries.map((entry) => entry.postId), [post.id]);
});

test("a deleted selected reply cannot publish from a stale screenshot", async t => {
  const { repo } = fixture();
  await queueAction(repo, "add", { commentId: "reply1" }, credentials, post, "https://www.shsid.online/api/media/uploads%2Freply1.jpg", 0);
  await queueAction(repo, "start", {}, credentials, null, null, 0);
  t.mock.method(globalThis, "fetch", async () => { assert.fail("Must not call Meta for a deleted reply"); });
  await runQueue(repo, credentials, (postId, commentId) => postId === post.id && !commentId, INTERVAL_MS);
  const job = await repo.read();
  assert.equal(job.active, false);
  assert.equal(job.entries[0].status, "failed");
  assert.match(job.entries[0].error, /selected reply was deleted/);
});

test("individual replies from one post queue independently and deduplicate by reply", async () => {
  const { repo } = fixture();
  await queueAction(repo, "add", { commentId: "reply1" }, credentials, post, "https://www.shsid.online/api/media/uploads%2Freply1.jpg", 0);
  const job = await queueAction(repo, "add", { commentId: "reply2" }, credentials, post, "https://www.shsid.online/api/media/uploads%2Freply2.jpg", 1);
  assert.deepEqual(job.entries.map((entry) => entry.commentId), ["reply1", "reply2"]);
  await assert.rejects(
    queueAction(repo, "add", { commentId: "reply1" }, credentials, post, "https://www.shsid.online/api/media/uploads%2Freply1-again.jpg", 2),
    /reply is already/
  );
  await queueAction(repo, "add", {}, credentials, post, "https://www.shsid.online/api/media/uploads%2Fwhole-post.jpg", 3);
  assert.equal((await repo.read()).entries.length, 3);
});

test("queued screenshot can be replaced without changing its position", async () => {
  const { repo } = fixture();
  const original = await add(repo);
  const entryId = original.entries[0].id;
  const replacement = "https://www.shsid.online/api/media/uploads%2Freplacement.jpg";
  const job = await queueAction(repo, "replace", { id: entryId }, credentials, post, replacement, 10);
  assert.equal(job.entries.length, 1);
  assert.equal(job.entries[0].id, entryId);
  assert.equal(job.entries[0].imageUrl, replacement);
  assert.equal(job.entries[0].status, "queued");
});

test("refresh preserves the queued reply selection", async () => {
  const { repo } = fixture();
  const original = await queueAction(repo, "add", { commentId: "reply1" }, credentials, post, "https://www.shsid.online/api/media/uploads%2Freply1.jpg", 0);
  const entryId = original.entries[0].id;
  await assert.rejects(queueAction(repo, "replace", { id: entryId }, credentials, post, "https://www.shsid.online/api/media/uploads%2Freplacement.jpg", 10), /selection changed/);
  const job = await queueAction(repo, "replace", { id: entryId, commentId: "reply1" }, credentials, post, "https://www.shsid.online/api/media/uploads%2Freplacement.jpg", 10);
  assert.equal(job.entries[0].commentId, "reply1");
});

test("one-hour delay, concurrent ticks publish only once, FIFO", async t => {
  const { repo } = fixture();
  await add(repo); await add(repo, { ...post, id: "post2", postNumber: 1235 });
  await queueAction(repo, "start", {}, credentials, null, null, 0);
  let publishes = 0;
  t.mock.method(Date, "now", () => INTERVAL_MS);
  t.mock.method(globalThis, "fetch", async url => {
    if (url.endsWith("/media_publish")) { publishes++; return response({ id: "published-1" }); }
    if (url.endsWith("/media")) return response({ id: "container-1" });
    return response({ status_code: "FINISHED" });
  });
  await runQueue(repo, credentials, () => post, INTERVAL_MS - 1);
  assert.equal(publishes, 0);
  await Promise.all([runQueue(repo, credentials, () => post, INTERVAL_MS), runQueue(repo, credentials, () => post, INTERVAL_MS)]);
  const job = await repo.read();
  assert.equal(publishes, 1);
  assert.equal(job.entries.length, 1);
  assert.equal(job.entries[0].status, "queued");
  assert.equal(job.entries[0].postId, "post2");
  assert.equal(job.nextAt, 2 * INTERVAL_MS);
});

test("processing container survives ticks and is not recreated", async t => {
  const { repo } = fixture(); await add(repo);
  await queueAction(repo, "start", {}, credentials, null, null, 0);
  let creates = 0, checks = 0;
  t.mock.method(globalThis, "fetch", async url => {
    if (url.endsWith("/media")) { creates++; return response({ id: "container" }); }
    if (url.endsWith("/media_publish")) return response({ id: "published" });
    return response({ status_code: checks++ ? "FINISHED" : "IN_PROGRESS" });
  });
  await runQueue(repo, credentials, () => post, INTERVAL_MS);
  assert.equal((await repo.read()).entries[0].status, "processing");
  await runQueue(repo, credentials, () => post, INTERVAL_MS + 60000);
  assert.equal(creates, 1);
  assert.equal((await repo.read()).entries.length, 0);
});

test("ambiguous publication pauses and cannot retry without admin resolution", async t => {
  const { repo } = fixture(); await add(repo);
  await queueAction(repo, "start", {}, credentials, null, null, 0);
  t.mock.method(globalThis, "fetch", async url => {
    if (url.endsWith("/media_publish")) throw new Error("network timeout secret=test-token");
    return response(url.endsWith("/media") ? { id: "container" } : { status_code: "FINISHED" });
  });
  await runQueue(repo, credentials, () => post, INTERVAL_MS);
  const job = await repo.read();
  assert.equal(job.active, false); assert.equal(job.entries[0].status, "review");
  assert.equal(job.entries[0].error.includes("test-token"), false);
  await assert.rejects(queueAction(repo, "start", {}, credentials), /Resolve/);
  await queueAction(repo, "resolve", { id: job.entries[0].id }, credentials);
  assert.equal((await repo.read()).entries.length, 0);
});

test("deleted posts and expired credentials never publish", async t => {
  t.mock.method(globalThis, "fetch", async () => { assert.fail("Must not call Meta"); });
  for (const [token, getPost] of [[credentials, () => null], [null, () => post]]) {
    const { repo } = fixture(); await add(repo);
    await queueAction(repo, "start", {}, credentials, null, null, 0);
    await runQueue(repo, token, getPost, INTERVAL_MS);
    assert.equal((await repo.read()).active, false);
    assert.equal((await repo.read()).entries[0].status, "failed");
  }
});

test("pause during processing prevents media_publish", async t => {
  const { repo } = fixture(); await add(repo);
  await queueAction(repo, "start", {}, credentials, null, null, 0);
  t.mock.method(globalThis, "fetch", async url => {
    if (url.endsWith("/media")) return response({ id: "container" });
    assert.ok(!url.endsWith("/media_publish"));
    await queueAction(repo, "pause", {}, credentials);
    return response({ status_code: "FINISHED" });
  });
  await runQueue(repo, credentials, () => post, INTERVAL_MS);
  assert.equal((await repo.read()).entries[0].status, "processing");
});

test("expired publish lease requires review instead of duplicating", async () => {
  const { repo, store } = fixture(); await add(repo);
  store.data.instagramQueue.active = true;
  store.data.instagramQueue.entries[0].status = "publishing";
  await runQueue(repo, credentials, () => post, INTERVAL_MS);
  assert.equal((await repo.read()).entries[0].status, "review");
  assert.equal((await repo.read()).active, false);
});

test("screenshots must be same-origin uploaded JPEGs", () => {
  const origin = "https://www.shsid.online";
  assert.equal(mediaKey(`${origin}/api/media/uploads%2Ftest.jpg`, origin), "uploads/test.jpg");
  for (const url of ["https://evil.example/api/media/uploads%2Fx.jpg", `${origin}/api/media/verification%2Fx.jpg`, `${origin}/api/media/uploads%2F..%2Fx.jpg`, `${origin}/api/media/uploads%2Fx.svg`]) assert.throws(() => mediaKey(url, origin));
});

test("OAuth refuses read-only credentials before storing connection", async t => {
  t.mock.method(globalThis, "fetch", async url => response(String(url).includes("me/permissions") ? { data: [{ permission: "instagram_basic", status: "granted" }] } : { access_token: "test-token" }));
  await assert.rejects(exchangeConnection({ FACEBOOK_APP_ID: "id", FACEBOOK_APP_SECRET: "secret", FACEBOOK_REDIRECT_URI: "https://example.com/callback" }, "code"), /Missing instagram_content_publish/);
});
