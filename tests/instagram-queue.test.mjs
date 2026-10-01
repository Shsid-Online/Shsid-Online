import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyQueue, localQueue, queueAction, queueView, runQueue, INTERVAL_MS } from "../server/instagram-queue.mjs";
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

test("queue is paused, deduplicates posts and builds board-number caption", async () => {
  const { repo } = fixture();
  const job = await add(repo);
  assert.equal(job.active, false);
  assert.equal(job.entries[0].caption, "/campus/ No.1234");
  await assert.rejects(add(repo), /already/);
  await assert.rejects(queueAction(repo, "start", {}, null, null, null, 0), /Connect/);
  assert.equal(JSON.stringify(queueView(job, credentials)).includes("test-token"), false);
});

test("ten-minute delay, concurrent ticks publish only once, FIFO", async t => {
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
  assert.equal(job.entries[0].status, "published");
  assert.equal(job.entries[1].status, "queued");
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
  assert.equal((await repo.read()).entries[0].status, "published");
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
  assert.equal((await repo.read()).entries[0].status, "removed");
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
