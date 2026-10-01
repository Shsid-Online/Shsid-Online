export const INTERVAL_MS = 10 * 60 * 1000;
const BOARD = { school: "/campus/", academic: "/study/", lifestyle: "/teacher/", gaming: "/club/", shitpost: "/random/" };
export const emptyQueue = () => ({ revision: 0, active: false, nextAt: 0, lockUntil: 0, entries: [] });
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export async function changeQueue(repo, fn) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const job = await repo.read();
    const revision = job.revision;
    await fn(job);
    job.revision = revision + 1;
    if (await repo.write(job, revision)) return job;
  }
  fail("Queue changed in another session. Please reload.", 409);
}

export function queueView(job, credentials) {
  return { active: job.active, nextAt: job.nextAt, connected: Boolean(credentials?.token && credentials?.userId),
    intervalMinutes: 10, entries: job.entries.map(({ containerId, ...entry }) => entry) };
}

export async function queueAction(repo, action, body, credentials, post, imageUrl, time = Date.now()) {
  return changeQueue(repo, (job) => {
    if (action === "add") {
      if (!post || post.deletedAt || post.deleted_at) fail("Post is no longer available", 404);
      if (job.entries.some(e => e.postId === post.id && e.status !== "removed")) fail("This post is already in the Instagram queue", 409);
      if (job.entries.length >= 500) fail("Queue history is full (500 posts)");
      const number = post.postNumber ?? post.post_number;
      if (!Number.isInteger(Number(number))) fail("Post needs a permanent board number");
      job.entries.push({ id: crypto.randomUUID(), postId: post.id, imageUrl,
        caption: `${BOARD[post.category] || "/board/"} No.${number}`,
        title: String(post.title || ""), status: "queued", createdAt: time, error: "" });
    } else if (action === "start") {
      if (!credentials?.token || !credentials?.userId) fail("Connect Instagram before starting the queue");
      if (job.entries.some(e => ["failed", "review", "publishing"].includes(e.status))) fail("Resolve the stopped item before restarting");
      if (!job.entries.some(e => ["queued", "processing"].includes(e.status))) fail("Add a post first");
      if (!job.active) job.nextAt = Math.max(job.nextAt || 0, time + INTERVAL_MS);
      job.active = true;
    } else if (action === "pause") {
      job.active = false;
    } else if (action === "resolve") {
      const entry = job.entries.find(e => e.id === body.id);
      if (!entry || entry.status !== "review" || job.lockUntil > time) fail("Only a stopped item awaiting review can be archived", 409);
      entry.status = "removed";
      entry.error = "Archived by admin after checking Instagram";
    } else if (action === "remove") {
      const entry = job.entries.find(e => e.id === body.id);
      if (!entry) fail("Queue item not found", 404);
      if (["publishing", "published", "review"].includes(entry.status) || job.lockUntil > time) fail("This item cannot be removed while publishing or awaiting review", 409);
      entry.status = "removed";
    } else fail("Unknown queue action", 404);
  });
}

async function graph(path, token, body) {
  const response = await fetch(`https://graph.facebook.com/v26.0/${path}`, {
    method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}` },
    body: body ? new URLSearchParams(body) : undefined, signal: AbortSignal.timeout(25000)
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    // Do not persist upstream error messages: they can contain credentials or request URLs.
    fail(`Instagram rejected the request (code ${Number(data.error?.code) || response.status}). Reconnect or check Meta account status.`, 502);
  }
  return data;
}

export async function runQueue(repo, credentials, getPost, time = Date.now()) {
  let claimed = false;
  let job = await changeQueue(repo, job => {
    claimed = false;
    if (!job.active || job.nextAt > time || job.lockUntil > time) return;
    if (job.entries.some(e => e.status === "publishing")) {
      job.active = false;
      for (const e of job.entries.filter(e => e.status === "publishing")) {
        e.status = "review";
        e.error = "Publishing was interrupted. Check Instagram before taking further action; no automatic retry was made.";
      }
      return;
    }
    job.lockUntil = time + 120000;
    claimed = true;
  });
  if (!claimed) return;
  const entry = job.entries.find(e => ["queued", "processing"].includes(e.status));
  const update = async fn => changeQueue(repo, current => {
    const item = current.entries.find(e => e.id === entry?.id);
    fn(current, item);
  });
  let publishing = false;
  try {
    if (!entry) { await update(j => { j.active = false; }); return; }
    if (!credentials?.token || !credentials?.userId) fail("Instagram is not connected");
    if (!await getPost(entry.postId)) fail("Original board post was deleted. Remove this item.");
    let containerId = entry.containerId;
    if (!containerId) {
      const container = await graph(`${credentials.userId}/media`, credentials.token, { image_url: entry.imageUrl, caption: entry.caption });
      if (!container.id) fail("Instagram did not return an image container");
      containerId = container.id;
      await update((j, e) => { e.containerId = containerId; e.status = "processing"; e.processingAt = time; });
    }
    const status = await graph(`${containerId}?fields=status_code`, credentials.token);
    if (status.status_code === "IN_PROGRESS") {
      if (time - (entry.processingAt || time) > 15 * 60000) fail("Instagram image processing timed out. Remove and requeue this item.");
      return;
    }
    if (status.status_code !== "FINISHED") fail(`Image is not ready (${status.status_code || "unknown"}). Check Instagram before requeuing.`);
    let canPublish = false;
    await update((j, e) => {
      canPublish = j.active && e?.status === "processing";
      if (canPublish) e.status = "publishing";
    });
    if (!canPublish) return;
    publishing = true;
    const result = await graph(`${credentials.userId}/media_publish`, credentials.token, { creation_id: containerId });
    if (!result.id) fail("Instagram did not confirm publication");
    await update((j, e) => {
      e.status = "published"; e.mediaId = result.id; e.publishedAt = Date.now(); e.error = "";
      j.nextAt = Date.now() + INTERVAL_MS;
      if (!j.entries.some(row => ["queued", "processing"].includes(row.status))) j.active = false;
    });
  } catch (error) {
    await update((j, e) => {
      j.active = false;
      if (e) {
        e.status = publishing ? "review" : "failed";
        e.error = publishing ? "Publication could not be confirmed. Check Instagram; this item will not be retried automatically." :
          (error.status ? error.message : "Instagram connection failed. The queue is paused.");
      }
    });
  } finally {
    await update(j => { j.lockUntil = 0; });
  }
}

export function d1Queue(db) {
  const ready = db.prepare("CREATE TABLE IF NOT EXISTS instagram_queue (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL)").run()
    .then(() => db.prepare("INSERT OR IGNORE INTO instagram_queue VALUES (1, 0, ?)").bind(JSON.stringify(emptyQueue())).run());
  return {
    async read() { await ready; const row = await db.prepare("SELECT payload FROM instagram_queue WHERE id=1").first(); return JSON.parse(row.payload); },
    async write(job, revision) { await ready; const result = await db.prepare("UPDATE instagram_queue SET revision=?, payload=? WHERE id=1 AND revision=?").bind(job.revision, JSON.stringify(job), revision).run(); return result.meta.changes === 1; }
  };
}

export function localQueue(store) {
  return {
    async read() { return structuredClone(store.data.instagramQueue || emptyQueue()); },
    async write(job, revision) {
      if ((store.data.instagramQueue?.revision || 0) !== revision) return false;
      store.data.instagramQueue = structuredClone(job); store.save(); return true;
    }
  };
}
