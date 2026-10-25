export const INTERVAL_MINUTES = 60;
export const INTERVAL_MS = INTERVAL_MINUTES * 60 * 1000;
const BOARD = { school: "/campus/", academic: "/study/", lifestyle: "/teacher/", gaming: "/club/", shitpost: "/random/" };
export const emptyQueue = () => ({ revision: 0, active: false, nextAt: 0, lockUntil: 0, intervalMinutes: INTERVAL_MINUTES, entries: [] });
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const TERMINAL_STATUSES = new Set(["published", "posted", "complete", "completed", "done", "removed", "archived"]);
const RETRY_DELAYS = [60000, 5 * 60000, 15 * 60000, 30 * 60000, INTERVAL_MS];
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);
function clearRetry(entry) {
  delete entry.retryAt;
  delete entry.retryCount;
  delete entry.failure;
}
export const isCompletedEntry = entry => TERMINAL_STATUSES.has(String(entry?.status || "").trim().toLowerCase())
  || Boolean(entry?.publishedAt && entry?.mediaId);

export async function changeQueue(repo, fn) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const job = await repo.read();
    const revision = job.revision;
    if (Number(job.intervalMinutes) !== INTERVAL_MINUTES) {
      job.intervalMinutes = INTERVAL_MINUTES;
      if (job.active && (job.entries || []).some((entry) => !isCompletedEntry(entry))) {
        job.nextAt = Math.max(Number(job.nextAt) || 0, Date.now() + INTERVAL_MS);
      }
    }
    job.entries = (job.entries || []).filter((entry) => !isCompletedEntry(entry));
    await fn(job);
    job.entries = (job.entries || []).filter((entry) => !isCompletedEntry(entry));
    job.revision = revision + 1;
    if (await repo.write(job, revision)) return job;
  }
  fail("Queue changed in another session. Please reload.", 409);
}

export async function cleanedQueue(repo) {
  const job = await repo.read();
  if (!(job.entries || []).some(isCompletedEntry)) return job;
  return changeQueue(repo, () => {});
}

export function queueView(job, credentials) {
  return { active: job.active, nextAt: job.nextAt, connected: Boolean(credentials?.token && credentials?.userId),
    retryAt: job.retryAt || 0, pendingImmediate: Boolean(job.immediateId),
    intervalMinutes: INTERVAL_MINUTES, entries: job.entries.filter((entry) => !isCompletedEntry(entry)).map(({ containerId, ...entry }) => entry) };
}

export async function queueAction(repo, action, body, credentials, post, imageUrl, time = Date.now()) {
  return changeQueue(repo, (job) => {
    if (action === "add") {
      if (!post || post.deletedAt || post.deleted_at) fail("Post is no longer available", 404);
      const commentId = String(body.commentId || "").trim();
      if (job.entries.some(e => e.postId === post.id && String(e.commentId || "") === commentId && e.status !== "removed")) {
        fail(commentId ? "This reply is already in the Instagram queue" : "This post is already in the Instagram queue", 409);
      }
      if (job.entries.length >= 500) fail("Queue history is full (500 posts)");
      const number = post.postNumber ?? post.post_number;
      if (!Number.isInteger(Number(number))) fail("Post needs a permanent board number");
      job.entries.push({ id: crypto.randomUUID(), postId: post.id, ...(commentId ? { commentId } : {}), imageUrl,
        caption: `${BOARD[post.category] || "/board/"} No.${number}`,
        title: String(post.title || ""), status: "queued", createdAt: time, error: "" });
    } else if (action === "replace") {
      if (!post || post.deletedAt || post.deleted_at) fail("Post is no longer available", 404);
      const entry = job.entries.find(e => e.id === body.id && e.postId === post.id);
      if (!entry) fail("Queue item not found", 404);
      if (String(entry.commentId || "") !== String(body.commentId || "")) fail("Queue reply selection changed", 409);
      if (!["queued", "failed"].includes(entry.status) || job.lockUntil > time) fail("This queue image cannot be refreshed while publishing", 409);
      entry.imageUrl = imageUrl;
      entry.status = "queued";
      entry.error = "";
      clearRetry(entry);
      delete entry.containerId;
      delete entry.processingAt;
    } else if (action === "retry") {
      if (!credentials?.token || !credentials?.userId) fail("Connect Instagram before retrying");
      if (job.retryAt > time) fail("Instagram is cooling down. Wait until the displayed retry time.", 429);
      const entry = job.entries.find(e => e.id === body.id);
      if (!entry || entry.status !== "failed" || job.lockUntil > time || job.immediateId) fail("Only a stopped, unpublished item can be retried", 409);
      // 'review' items may already be live and must never be blindly replayed.
      entry.status = entry.containerId ? "processing" : "queued";
      entry.error = "";
      clearRetry(entry);
    } else if (action === "post-now") {
      if (!credentials?.token || !credentials?.userId) fail("Connect Instagram before publishing");
      if (job.retryAt > time) fail("Instagram is cooling down. Wait until the displayed retry time.", 429);
      if (job.lockUntil > time || job.immediateId || job.entries.some(e => ["review", "publishing"].includes(e.status))) fail("Another publication is pending or needs review", 409);
      const entry = job.entries.find(e => e.id === body.id);
      if (!entry || !["queued", "processing"].includes(entry.status)) fail("Select a queued item to publish", 409);
      if (entry.retryAt > time) fail("Instagram is cooling down. Wait until the displayed retry time.", 429);
      job.immediateId = entry.id;
    } else if (action === "start") {
      if (!credentials?.token || !credentials?.userId) fail("Connect Instagram before starting the queue");
      if (job.entries.some(e => ["failed", "review", "publishing"].includes(e.status))) fail("Resolve the stopped item before restarting");
      if (!job.entries.some(e => ["queued", "processing"].includes(e.status))) fail("Add a post first");
      if (!job.active) job.nextAt = Math.max(job.nextAt || 0, time + INTERVAL_MS);
      job.active = true;
    } else if (action === "pause") {
      job.active = false;
      delete job.immediateId;
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
      if (job.immediateId === entry.id) delete job.immediateId;
    } else fail("Unknown queue action", 404);
  });
}

async function graph(path, token, body) {
  let response, data;
  try {
    response = await fetch(`https://graph.facebook.com/v26.0/${path}`, {
      method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}` },
      body: body ? new URLSearchParams(body) : undefined, signal: AbortSignal.timeout(25000)
    });
    data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid Graph response');
  } catch {
    // A timed-out publish is ambiguous; runQueue deliberately never retries it.
    throw Object.assign(new Error("Instagram connection failed or returned an unreadable response."), {
      status: 502, transient: true, httpStatus: response?.status || 0
    });
  }
  if (!response.ok || data.error) {
    // Do not persist upstream error messages: they can contain credentials or request URLs.
    const code = Number(data.error?.code) || 0;
    const subcode = Number(data.error?.error_subcode) || 0;
    const rateLimited = response.status === 429 || RATE_LIMIT_CODES.has(code) || (code === 9 && subcode === 2207042);
    const reconnect = [102, 190].includes(code) || response.status === 401;
    const retryHeader = response.headers.get('Retry-After');
    const seconds = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : 0;
    const retryAfterMs = seconds ? seconds * 1000 : Math.max(0, Date.parse(retryHeader || '') - Date.now()) || 0;
    throw Object.assign(new Error(rateLimited ? "Instagram temporarily limited publishing requests." : reconnect
      ? "Instagram authorization expired or was revoked. Reconnect Instagram."
      : `Instagram rejected the request (code ${code || response.status}${subcode ? `, subcode ${subcode}` : ''}). Check the connection, permissions, and screenshot.`), {
      status: 502, httpStatus: response.status, code, subcode, rateLimited,
      transient: !reconnect && (rateLimited || response.status >= 500 || data.error?.is_transient === true),
      // Only a structured, explicit throttling rejection is safe to retry after
      // media_publish. A bare 429 or network failure could hide a publication.
      rejectedForRateLimit: rateLimited && Boolean(data.error) && !data.id,
      retryAfterMs: Math.min(retryAfterMs, 24 * INTERVAL_MS)
    });
  }
  return data;
}

export async function runQueue(repo, credentials, getPost, time = Date.now()) {
  const eligible = job => job.lockUntil <= time && !(job.retryAt > time) && (job.immediateId || (job.active && job.nextAt <= time)) &&
    !(job.entries.find(e => job.immediateId ? e.id === job.immediateId : ["queued", "processing"].includes(e.status))?.retryAt > time);
  // Idle/cooling-down cron ticks must not rewrite the queue every minute.
  if (!eligible(await repo.read())) return;
  let claimed = false;
  let job = await changeQueue(repo, job => {
    claimed = false;
    if (!eligible(job)) return;
    if (job.entries.some(e => e.status === "publishing")) {
      job.active = false;
      delete job.immediateId;
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
  const entry = job.immediateId ? job.entries.find(e => e.id === job.immediateId && ["queued", "processing"].includes(e.status)) : job.entries.find(e => ["queued", "processing"].includes(e.status));
  const update = async fn => changeQueue(repo, current => {
    const item = current.entries.find(e => e.id === entry?.id);
    fn(current, item);
  });
  let publishing = false;
  let phase = "source";
  const complete = async () => update((j, e) => {
    j.entries = j.entries.filter(row => row.id !== e.id);
    if (j.immediateId === e.id) delete j.immediateId;
    j.nextAt = Date.now() + INTERVAL_MS;
    if (!j.entries.some(row => ["queued", "processing"].includes(row.status))) j.active = false;
  });
  try {
    if (!entry) { await update(j => { j.active = false; delete j.immediateId; }); return; }
    if (!credentials?.token || !credentials?.userId) fail("Instagram is not connected");
    if (!await getPost(entry.postId, entry.commentId || "")) fail(entry.commentId
      ? "Original board post or selected reply was deleted. Remove this item."
      : "Original board post was deleted. Remove this item.");
    let containerId = entry.containerId;
    if (!containerId) {
      phase = "create";
      const container = await graph(`${credentials.userId}/media`, credentials.token, { image_url: entry.imageUrl, caption: entry.caption });
      if (!container.id) fail("Instagram did not return an image container");
      containerId = container.id;
      await update((j, e) => { e.containerId = containerId; e.status = "processing"; e.processingAt = time; });
    }
    phase = "status";
    const status = await graph(`${containerId}?fields=status_code`, credentials.token);
    // Recheck the same container after an explicit throttle instead of creating
    // another post. If Meta says it is published, remove it without republishing.
    if (status.status_code === "PUBLISHED") { await complete(); return; }
    if (status.status_code === "IN_PROGRESS") {
      if (time - (entry.processingAt || time) > 15 * 60000) fail("Instagram image processing timed out. Remove and requeue this item.");
      return;
    }
    if (status.status_code !== "FINISHED") fail(`Image is not ready (${status.status_code || "unknown"}). Check Instagram before requeuing.`);
    let canPublish = false;
    await update((j, e) => {
      canPublish = (j.active || j.immediateId === e?.id) && e?.status === "processing";
      if (canPublish) e.status = "publishing";
    });
    if (!canPublish) return;
    publishing = true;
    phase = "publish";
    const result = await graph(`${credentials.userId}/media_publish`, credentials.token, { creation_id: containerId });
    if (!result.id) fail("Instagram did not confirm publication");
    await complete();
  } catch (error) {
    await update((j, e) => {
      const retries = Number(e?.retryCount) || 0;
      const safeRetry = error.transient && (!publishing || error.rejectedForRateLimit);
      if (e) e.failure = { phase, httpStatus: Number(error.httpStatus) || 0, code: Number(error.code) || 0, subcode: Number(error.subcode) || 0 };
      if (e && safeRetry && retries < RETRY_DELAYS.length) {
        e.status = e.containerId ? "processing" : "queued";
        e.retryCount = retries + 1;
        e.retryAt = time + Math.max(RETRY_DELAYS[retries], Number(error.retryAfterMs) || 0);
        if (error.rateLimited) j.retryAt = e.retryAt;
        e.error = `${error.message} Automatic retry ${e.retryCount}/${RETRY_DELAYS.length} scheduled.`;
        if (j.active) j.nextAt = Math.max(j.nextAt || 0, e.retryAt);
        return;
      }
      j.active = false;
      delete j.immediateId;
      if (e) {
        const uncertain = publishing && !error.rejectedForRateLimit;
        e.status = uncertain ? "review" : "failed";
        delete e.retryAt;
        e.error = uncertain ? "Publication could not be confirmed. Check Instagram; this item will not be retried automatically." :
          `${error.status ? error.message : "Instagram connection failed. The queue is paused."}${safeRetry ? " Automatic retries exhausted. Retry the item after checking the cause." : ""}`;
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
