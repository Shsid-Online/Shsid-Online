const STORAGE_KEY = "shsid-board-state-v1";
const LEGACY_STATE_KEY = "shsid-social-state-v2";
const API_BASE = window.SHSID_API_BASE || (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost"
  ? "http://127.0.0.1:4174/api"
  : "https://www.shsid.online/api");

const BOARDS = [
  { category: "school", slug: "/campus/", name: "/campus/", blurb: "" },
  { category: "academic", slug: "/study/", name: "/study/", blurb: "" },
  { category: "lifestyle", slug: "/teacher/", name: "/teacher/", blurb: "" },
  { category: "gaming", slug: "/club/", name: "/club/", blurb: "" },
  { category: "shitpost", slug: "/random/", name: "/random/", blurb: "" }
];

const initialState = {
  token: "",
  currentUser: null,
  posts: [],
  autopostJob: null,
  autopostDirty: false,
  adminAnonymousNumbers: [],
  board: "all",
  sort: "recent",
  search: "",
  authorFilter: "",
  composerBoard: "school",
  composerTitle: "",
  composerBody: "",
  composerAnonymousNumber: "",
  composerQuote: null,
  composerQuoteSearch: "",
  composerOpen: true,
  boardOwnerToken: "",
  replyDrafts: {},
  replyAnonymousNumbers: {},
  replyTargets: {},
  authOpen: false,
  authMode: "login",
  authStep: "email",
  pendingEmail: "",
  pendingCode: "",
  pendingUsername: "",
  notifications: [],
  notificationsOpen: false,
  toast: ""
};

const boardByCategory = new Map(BOARDS.map((board) => [board.category, board]));
let state = loadState();
let authBusy = false;
let queuedLikePostId = "";
let authReason = "";
let toastTimer = null;
let autopostCountdownTimer = null;
let openReplyPostId = "";
let threadSubmitting = false;
let composerPhotoFiles = [];
let notificationOutsideClickBound = false;
let autopostEntryIndex = 0;
let autopostBusy = false;
let autopostError = "";
let instagramQueue = null;
let instagramPreview = null;
let instagramBusy = false;
const replySubmittingPostIds = new Set();
const replyPhotoFilesByPostId = new Map();
const autopostPhotoFilesByEntryId = new Map();
const openReplies = new Set();

function loadState() {
  const base = structuredClone(initialState);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    Object.assign(base, saved);
  } catch {
    // ignore invalid state
  }
  if (!base.token) {
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_STATE_KEY) || "{}");
      if (legacy?.apiToken) base.token = String(legacy.apiToken || "");
    } catch {
      // ignore invalid legacy state
    }
  }
  if (!String(base.boardOwnerToken || "").trim()) {
    base.boardOwnerToken = crypto.randomUUID();
  }
  // Keep unsent board drafts session-only so old text does not reappear after refresh.
  base.composerTitle = "";
  base.composerBody = "";
  base.composerAnonymousNumber = "";
  base.composerQuote = null;
  base.composerQuoteSearch = "";
  base.replyDrafts = {};
  base.replyAnonymousNumbers = {};
  base.replyTargets = {};
  return base;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    token: state.token,
    currentUser: state.currentUser,
    board: state.board,
    sort: state.sort,
    search: state.search,
    authorFilter: state.authorFilter,
    composerBoard: state.composerBoard,
    boardOwnerToken: state.boardOwnerToken,
    authOpen: state.authOpen,
    authMode: state.authMode,
    authStep: state.authStep,
    pendingEmail: state.pendingEmail,
    pendingCode: state.pendingCode,
    pendingUsername: state.pendingUsername
  }));
}

function clearAutopostCountdownTimer() {
  if (!autopostCountdownTimer) return;
  clearInterval(autopostCountdownTimer);
  autopostCountdownTimer = null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function boardMeta(category) {
  return boardByCategory.get(String(category || "").trim().toLowerCase()) || {
    category: String(category || "school").trim().toLowerCase() || "school",
    slug: "/board/",
    name: "/board/",
    blurb: ""
  };
}

function currentUser() {
  return state.currentUser || null;
}

function userTagLabel(item) {
  return String(item?.authorLabel || item?.anonymousLabel || "Anonymous").trim() || "Anonymous";
}

function userTagKey(item) {
  return userTagLabel(item).toLowerCase();
}

function normalizeUsernameInput(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function reservedUsernameMessage(value) {
  const key = normalizeUsernameInput(value).toLowerCase();
  if (!key) return "Please choose a username";
  if (/^anonymous(?:\s*\d{4})?$/.test(key)) return "Please choose a username that is different from anonymous tags";
  if (key.includes("admin") || key.includes("moderator") || /(^|\s)mod(\s|$)/.test(key)) return "Please choose a username that is different from admin";
  if (new Set(["system", "guest", "board guest", "shsid", "shsid online"]).has(key)) return "Please choose a different username";
  return "";
}

function postMatchesUserTag(post, tagKey) {
  if (!tagKey) return true;
  if (userTagKey(post) === tagKey) return true;
  return (post.comments || []).some((comment) => userTagKey(comment) === tagKey);
}

function currentDirectoryBoard() {
  return state.board !== "all" && boardByCategory.has(state.board) ? state.board : "";
}

function defaultComposerBoard() {
  return state.composerBoard || currentDirectoryBoard() || "school";
}

function syncComposerBoardToCurrentDirectory() {
  const currentBoard = currentDirectoryBoard();
  if (currentBoard) state.composerBoard = currentBoard;
  else state.composerBoard ||= "school";
}

function userCanLike(post) {
  const me = currentUser();
  if (!me) return false;
  return Array.isArray(post.likes) ? post.likes.includes(me.id) : false;
}

function timeAgo(value) {
  const ts = new Date(value || Date.now()).getTime();
  if (!Number.isFinite(ts)) return "just now";
  const diffMinutes = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

function commentTimestamp(value) {
  const date = new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) return "just now";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const year = String(date.getFullYear()).slice(-2);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${month}/${day}/${year} ${hours}:${minutes}`;
}

function normalizeNotification(notification) {
  return {
    id: String(notification.id || crypto.randomUUID()),
    type: String(notification.type || "notice"),
    text: String(notification.text || notification.body || "").trim(),
    read: Boolean(notification.read),
    createdAt: notification.createdAt || new Date().toISOString()
  };
}

function groupedNotifications() {
  const notifications = Array.isArray(state.notifications) ? state.notifications : [];
  const bumpNotifications = notifications.filter((item) => ["post_bump", "post_like_private"].includes(item.type));
  const otherNotifications = notifications.filter((item) => !["post_bump", "post_like_private"].includes(item.type));
  const grouped = [];
  if (bumpNotifications.length) {
    const unreadCount = bumpNotifications.filter((item) => !item.read).length;
    const latest = bumpNotifications.reduce((current, item) => (
      new Date(item.createdAt).getTime() > new Date(current.createdAt).getTime() ? item : current
    ), bumpNotifications[0]);
    grouped.push({
      id: "bump-summary",
      type: "post_bump_summary",
      text: bumpNotifications.length === 1
        ? latest.text || "1 bump on your post."
        : `${bumpNotifications.length} bumps. Latest: ${latest.text || "someone bumped your post."}`,
      read: unreadCount === 0,
      createdAt: latest.createdAt,
      count: unreadCount || bumpNotifications.length
    });
  }
  return [...grouped, ...otherNotifications]
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

function notificationBadgeCount() {
  return groupedNotifications().filter((item) => !item.read).length;
}

async function fetchNotifications({ rerender = false } = {}) {
  if (!state.token || !state.currentUser) {
    state.notifications = [];
    return;
  }
  try {
    const result = await apiRequest("/notifications", { optionalAuth: true });
    state.notifications = Array.isArray(result.notifications) ? result.notifications.map(normalizeNotification) : [];
    if (rerender) render();
  } catch {
    state.notifications = [];
  }
}

function uniqueAutopostEntryId(value, seen) {
  let id = String(value || "");
  while (!id || seen.has(id)) id = `apq_local_${crypto.randomUUID()}`;
  seen.add(id);
  return id;
}

function markAutopostDirty() {
  state.autopostDirty = true;
  document.querySelectorAll("[data-autopost-save-status]").forEach((node) => {
    node.textContent = "Unsaved changes";
  });
}

function applyAutopostJob(job) {
  const selectedId = state.autopostJob?.entries[autopostEntryIndex]?.id;
  const normalized = normalizeAutopostJob(job);
  if (!normalized || !Array.isArray(job.entries)) throw new Error("The server did not return a queue. Your drafts have been kept.");
  state.autopostJob = normalized;
  const index = normalized.entries.findIndex((entry) => entry.id === selectedId);
  autopostEntryIndex = index >= 0 ? index : Math.min(autopostEntryIndex, Math.max(0, normalized.entries.length - 1));
}

function normalizeAutopostJob(job) {
  if (!job || typeof job !== "object") return null;
  const seenEntryIds = new Set();
  const normalizeEntry = (entry, index) => ({
    id: uniqueAutopostEntryId(entry?.id || `apq_${index + 1}`, seenEntryIds),
    category: String(entry?.category || job?.category || "school").trim().toLowerCase() || "school",
    title: String(entry?.title || ""),
    text: String(entry?.text || ""),
    media: Array.isArray(entry?.media) ? entry.media : [],
    requestedAnonymousNumber: entry?.requestedAnonymousNumber == null || String(entry.requestedAnonymousNumber).trim() === "" ? null : Number(entry.requestedAnonymousNumber),
    postedAt: entry?.postedAt ? String(entry.postedAt) : "",
    postId: entry?.postId ? String(entry.postId) : "",
    postNumber: Number.isInteger(Number(entry?.postNumber)) ? Number(entry.postNumber) : null,
    anonymousNumber: Number.isInteger(Number(entry?.anonymousNumber)) ? Number(entry.anonymousNumber) : null
  });
  const entries = Array.isArray(job.entries) ? job.entries.map(normalizeEntry).filter((entry) => !entry.postedAt) : [];
  return {
    id: String(job.id || ""),
    category: String(job.category || "school").trim().toLowerCase() || "school",
    active: Boolean(job.active),
    nextIndex: 0,
    nextPostAt: String(job.nextPostAt || "").trim(),
    countdownMs: Number.isFinite(Number(job.countdownMs)) ? Number(job.countdownMs) : null,
    minDelayMinutes: Math.max(1, Number(job.minDelayMinutes || 60)),
    maxDelayMinutes: Math.max(1, Number(job.maxDelayMinutes || 360)),
    finishedAt: String(job.finishedAt || "").trim(),
    lastPostId: String(job.lastPostId || "").trim(),
    pendingCount: entries.length,
    postedCount: 0,
    entries,
    defaultEntries: Array.isArray(job.defaultEntries) ? job.defaultEntries.map(normalizeEntry) : []
  };
}

async function fetchAutopostJob() {
  if (currentUser()?.role === "admin") {
    try { instagramQueue = (await apiRequest("/admin/instagram", { timeoutMs: 30000 })).queue; }
    catch { instagramQueue = null; }
  } else instagramQueue = null;
  if (currentUser()?.role !== "admin") {
    state.autopostJob = null;
    state.autopostDirty = false;
    clearAutopostCountdownTimer();
    return;
  }
  if (state.autopostDirty) {
    toast("Save your queue changes before reloading.");
    return;
  }
  const previousJob = state.autopostJob;
  try {
    const result = await apiRequest("/admin/autopost", { timeoutMs: 30000 });
    // A late refresh must not replace a draft or a newer save.
    if (state.autopostDirty || state.autopostJob !== previousJob) return;
    applyAutopostJob(result.job);
    autopostError = "";
  } catch (error) {
    autopostError = error.message || "Could not load admin queue";
    toast(autopostError);
  }
}

async function markNotificationsRead() {
  if (!state.token || !state.currentUser) return;
  try {
    await apiRequest("/notifications/read-all", { method: "POST", body: {} });
    state.notifications = state.notifications.map((item) => ({ ...item, read: true }));
    render();
  } catch (error) {
    toast(error.message || "Could not mark notifications read");
  }
}

function toast(message) {
  clearTimeout(toastTimer);
  state.toast = String(message || "").trim();
  render();
  if (!state.toast) return;
  toastTimer = setTimeout(() => {
    state.toast = "";
    document.querySelector(".toast")?.remove();
  }, 2600);
}

function hasUnsavedReplyDrafts() {
  if (Object.values(state.replyDrafts || {}).some((value) => String(value || "").trim())) return true;
  if (Object.values(state.replyAnonymousNumbers || {}).some((value) => String(value || "").trim())) return true;
  if ([...replyPhotoFilesByPostId.values()].some((files) => files.length)) return true;
  return [...document.querySelectorAll("[id^='reply-photo-']")].some((input) => input.files?.length);
}

function hasUnsavedComposerDraft() {
  if (String(state.composerTitle || "").trim()) return true;
  if (String(state.composerBody || "").trim()) return true;
  if (String(state.composerAnonymousNumber || "").trim()) return true;
  if (state.composerQuote) return true;
  if (String(state.composerQuoteSearch || "").trim()) return true;
  if (composerPhotoFiles.length) return true;
  const photoInput = document.querySelector("#composer-photo");
  return Boolean(photoInput?.files?.length);
}

function hasUnsavedBoardChanges() {
  return state.autopostDirty || autopostBusy || hasUnsavedComposerDraft() || hasUnsavedReplyDrafts();
}

async function apiRequest(path, { method = "GET", body, auth = true, optionalAuth = false, timeoutMs } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (state.boardOwnerToken) headers["X-Board-Owner-Token"] = state.boardOwnerToken;
  if ((auth || optionalAuth) && state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include",
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

function needsProfile(user) {
  return !String(user?.englishName || "").trim();
}

async function fetchCurrentUser() {
  if (!state.token) {
    state.currentUser = null;
    return;
  }
  try {
    const result = await apiRequest("/me", { optionalAuth: true });
    state.currentUser = result.user || null;
  } catch (error) {
    state.token = "";
    state.currentUser = null;
    if (String(error.message || "").toLowerCase().includes("banned")) {
      toast("This account can no longer sign in.");
    }
  }
}

function normalizePost(post) {
  const postNumber = Number(post.postNumber);
  const anonymous = Boolean(post.anonymous);
  const viewerId = currentUser()?.id || "";
  const authorId = String(post.authorId || "");
  const realAuthorLabel = post.adminAuthor?.englishName || post.author?.englishName || "";
  const authorLabel = String(
    post.anonymousLabel
      || (anonymous ? "Anonymous" : realAuthorLabel)
      || "Anonymous"
  ).trim();
  return {
    id: post.id,
    authorId,
    title: String(post.title || "").trim() === "Untitled thread" ? "" : String(post.title || "").trim(),
    postNumber: Number.isInteger(postNumber) && postNumber > 0 ? postNumber : null,
    adminAnonymousAccountNumber: Number.isInteger(Number(post.adminAnonymousAccountNumber)) ? Number(post.adminAnonymousAccountNumber) : null,
    anonymous,
    anonymousLabel: String(post.anonymousLabel || "").trim(),
    authorLabel,
    canDelete: Boolean(post.canDelete || (viewerId && authorId === viewerId)),
    quoteRef: post.quoteRef && typeof post.quoteRef === "object" ? {
      type: String(post.quoteRef.type || "post"),
      postId: String(post.quoteRef.postId || ""),
      label: String(post.quoteRef.label || "").trim(),
      excerpt: String(post.quoteRef.excerpt || "").trim()
    } : null,
    category: String(post.category || "school").trim().toLowerCase(),
    text: String(post.text || "").trim(),
    likes: Array.isArray(post.likes) ? post.likes : [],
    media: Array.isArray(post.media) ? post.media : [],
    comments: Array.isArray(post.comments) ? post.comments.map((comment) => ({
      id: comment.id,
      authorId: String(comment.authorId || ""),
      text: String(comment.text || "").trim(),
      anonymousLabel: String(comment.anonymousLabel || "Anonymous").trim(),
      adminAnonymousAccountNumber: Number.isInteger(Number(comment.adminAnonymousAccountNumber)) ? Number(comment.adminAnonymousAccountNumber) : null,
      canDelete: Boolean(comment.canDelete || (viewerId && String(comment.authorId || "") === viewerId)),
      media: Array.isArray(comment.media) ? comment.media : [],
      likes: Array.isArray(comment.likes) ? comment.likes : [],
      replyTo: comment.replyTo ? String(comment.replyTo) : null,
      createdAt: comment.createdAt
    })) : [],
    createdAt: post.createdAt,
    sticky: Boolean(post.sticky)
  };
}

async function fetchPosts() {
  const result = await apiRequest("/posts?limit=100", { auth: false, optionalAuth: true });
  const posts = Array.isArray(result.posts) ? result.posts.map(normalizePost) : [];
  state.adminAnonymousNumbers = Array.isArray(result.adminAnonymousNumbers)
    ? result.adminAnonymousNumbers.map(Number).filter((number) => Number.isInteger(number) && number >= 1000 && number <= 9999)
    : [];
  state.posts = posts.sort((a, b) => {
    if (a.sticky !== b.sticky) return Number(b.sticky) - Number(a.sticky);
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

function mergePost(updatedPost) {
  const normalized = normalizePost(updatedPost);
  const existing = state.posts.find((post) => post.id === normalized.id);
  if (existing) {
    state.posts = state.posts.map((post) => (
      post.id === normalized.id
        ? { ...post, ...normalized, comments: normalized.comments.length ? normalized.comments : post.comments }
        : post
    ));
  } else {
    state.posts = [normalized, ...state.posts];
  }
}

function removePost(postId) {
  state.posts = state.posts.filter((post) => post.id !== postId);
}

function removeComment(postId, commentId) {
  state.posts = state.posts.map((post) => (
    post.id === postId
      ? { ...post, comments: (post.comments || []).filter((comment) => comment.id !== commentId) }
      : post
  ));
}

async function uploadSinglePhoto(file) {
  const fileName = String(file?.name || "photo").trim();
  const contentType = String(file?.type || "").trim().toLowerCase();
  if (!contentType.startsWith("image/")) throw new Error("Please choose an image file");
  const signed = await apiRequest("/upload-url", {
    method: "POST",
    body: { fileName, contentType, purpose: "media" },
    auth: false,
    timeoutMs: 30000
  });
  const response = await fetch(signed.uploadUrl, {
    method: signed.method || "PUT",
    headers: signed.headers || { "content-type": contentType },
    body: file,
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error("Photo upload failed");
  return { url: signed.mediaUrl, type: contentType, name: fileName };
}

async function uploadPhotos(fileList, limit) {
  const files = [...(fileList || [])].slice(0, limit);
  if ([...(fileList || [])].length > limit) throw new Error(`Please choose at most ${limit} photos`);
  return Promise.all(files.map(uploadSinglePhoto));
}

function selectedPhotoSummary(files, emptyText = "") {
  const selected = [...(files || [])];
  if (!selected.length) return emptyText;
  const names = selected.map((file) => String(file.name || "photo").trim()).filter(Boolean);
  const preview = names.slice(0, 3).join(", ");
  const extra = names.length > 3 ? ` +${names.length - 3} more` : "";
  return `${selected.length} photo${selected.length === 1 ? "" : "s"} selected${preview ? `: ${preview}${extra}` : ""}`;
}

function autopostEntryPhotoSummary(entry) {
  const selected = autopostPhotoFilesByEntryId.get(entry.id) || [];
  if (selected.length) return selectedPhotoSummary(selected, "No photos selected");
  if (Array.isArray(entry.media) && entry.media.length) {
    return `${entry.media.length} saved photo${entry.media.length === 1 ? "" : "s"}`;
  }
  return "No photos selected";
}

function autopostEntryHasQueuedPhotos(entryId) {
  return (autopostPhotoFilesByEntryId.get(String(entryId || "")) || []).length > 0;
}

async function prepareAutopostEntriesForSave(entries) {
  const prepared = [];
  for (const entry of (entries || [])) {
    const queuedFiles = autopostPhotoFilesByEntryId.get(entry.id) || [];
    let media = Array.isArray(entry.media) ? [...entry.media] : [];
    if (queuedFiles.length) {
      if (media.length + queuedFiles.length > 9) {
        throw new Error("Queued posts can include at most 9 photos");
      }
      media = [...media, ...(await uploadPhotos(queuedFiles, 9 - media.length))];
      // Reuse completed uploads if saving fails; keep their previews in the draft.
      entry.media = media;
      autopostPhotoFilesByEntryId.delete(entry.id);
    }
    prepared.push({
      ...entry,
      media
    });
  }
  return prepared;
}

async function saveAutopostJobDraft() {
  if (!state.autopostJob) throw new Error("Queue is not loaded");
  const entries = await prepareAutopostEntriesForSave(state.autopostJob.entries);
  const result = await apiRequest("/admin/autopost", {
    method: "POST",
    timeoutMs: 30000,
    body: {
      category: state.autopostJob.category,
      minDelayMinutes: state.autopostJob.minDelayMinutes,
      maxDelayMinutes: state.autopostJob.maxDelayMinutes,
      entries
    }
  });
  applyAutopostJob(result.job);
  autopostError = "";
  autopostPhotoFilesByEntryId.clear();
  state.autopostDirty = false;
  return result;
}

function composerPhotos() {
  const inputFiles = document.querySelector("#composer-photo")?.files || [];
  return inputFiles.length ? [...inputFiles] : composerPhotoFiles;
}

function replyPhotos(postId) {
  const inputFiles = document.querySelector(`#reply-photo-${CSS.escape(postId)}`)?.files || [];
  return inputFiles.length ? [...inputFiles] : (replyPhotoFilesByPostId.get(postId) || []);
}

function adminAnonymousNumberOptions() {
  const numbers = new Set();
  const addNumber = (value) => {
    const number = Number(value);
    if (Number.isInteger(number) && number >= 1000 && number <= 9999) numbers.add(number);
  };
  for (const number of state.adminAnonymousNumbers || []) addNumber(number);
  for (const post of state.posts || []) {
    addNumber(post.adminAnonymousAccountNumber);
    for (const comment of post.comments || []) {
      addNumber(comment.adminAnonymousAccountNumber);
    }
  }
  return [...numbers].sort((left, right) => left - right);
}

function quoteLabelForPost(post) {
  const board = boardMeta(post.category);
  const postNumber = Number.isInteger(post.postNumber) ? post.postNumber : "";
  return `${board.slug}${post.authorLabel || post.anonymousLabel || "Anonymous"}${postNumber ? `/No.${postNumber}` : ""}`;
}

function quoteExcerpt(text) {
  return String(text || "").trim().replace(/\s+/g, " ").slice(0, 180);
}

function quoteRefForPost(post) {
  if (!post) return null;
  return {
    type: "post",
    postId: post.id,
    label: quoteLabelForPost(post),
    excerpt: quoteExcerpt(post.text || post.title)
  };
}

function autopostCountdownLabel(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return "Not scheduled";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

function renderAutopostBoardField(entry) {
  if (entry.postedAt) {
    return `<div class="autopost-form-value">${escapeHtml(boardMeta(entry.category).slug)}</div>`;
  }
  return `
    <select id="autopost-board-${escapeHtml(entry.id)}" data-autopost-category="${escapeHtml(entry.id)}">
      ${BOARDS.map((item) => `<option value="${escapeHtml(item.category)}"${entry.category === item.category ? " selected" : ""}>${escapeHtml(item.slug)}</option>`).join("")}
    </select>
  `;
}

function renderAutopostEntry(entry, index, job) {
  const entryBoard = boardMeta(entry.category);
  const statusText = entry.postedAt
    ? "Posted"
    : "Pending";
  const identityText = entry.anonymousNumber
    ? ` / Anonymous ${escapeHtml(entry.anonymousNumber)}`
    : entry.requestedAnonymousNumber
      ? ` / will use Anonymous ${escapeHtml(entry.requestedAnonymousNumber)}`
      : "";
  return `
    <article class="post-box autopost-entry-box">
      <div class="post-box-head">
        <div>
          <h2>Queued Post #${index + 1}</h2>
          <p class="post-box-copy">
            ${entry.postedAt
              ? `Posted ${escapeHtml(commentTimestamp(entry.postedAt))}${entry.postNumber ? ` as No.${escapeHtml(entry.postNumber)}` : ""}${entry.anonymousNumber ? ` by Anonymous ${escapeHtml(entry.anonymousNumber)}` : ""}.`
              : `Board ${escapeHtml(entryBoard.slug)}. This draft is waiting for the countdown.`}
          </p>
        </div>
        ${entry.postedAt ? `<span class="autopost-status-chip is-posted">Posted</span>` : `<span class="autopost-status-chip is-pending">Pending</span>`}
      </div>
      ${entry.postedAt ? "" : `
        <div class="autopost-entry-toolbar">
          <button class="plain-board-action" type="button" data-action="autopost-move-entry-up" data-id="${escapeHtml(entry.id)}"${index === 0 || job.entries[index - 1]?.postedAt ? " disabled" : ""}>Move up</button>
          <button class="plain-board-action" type="button" data-action="autopost-move-entry-down" data-id="${escapeHtml(entry.id)}"${index === job.entries.length - 1 ? " disabled" : ""}>Move down</button>
          <button class="plain-board-action" type="button" data-action="autopost-duplicate-entry" data-id="${escapeHtml(entry.id)}">Duplicate</button>
        </div>
      `}
      <div class="thread-form autopost-entry-form">
        <div class="form-row">
          <label for="autopost-board-${escapeHtml(entry.id)}">Board</label>
          ${renderAutopostBoardField(entry)}
        </div>
        <div class="form-row">
          <label>Status</label>
          <div class="autopost-form-value">
            ${statusText}
            ${entry.postNumber ? ` / No.${escapeHtml(entry.postNumber)}` : ""}
            ${identityText}
          </div>
        </div>
        <div class="form-row">
          <label for="autopost-title-${escapeHtml(entry.id)}">Subject (optional)</label>
          <input id="autopost-title-${escapeHtml(entry.id)}" data-autopost-title="${escapeHtml(entry.id)}" type="text" maxlength="90" value="${escapeHtml(entry.title || "")}" ${entry.postedAt ? "readonly" : ""} placeholder="Add a subject if you want">
        </div>
        <div class="form-row form-row-textarea">
          <label for="autopost-entry-${escapeHtml(entry.id)}">Comment (optional)</label>
          <textarea id="autopost-entry-${escapeHtml(entry.id)}" data-autopost-text="${escapeHtml(entry.id)}" rows="${entry.text.length > 240 ? 6 : 5}" ${entry.postedAt ? "readonly" : ""} placeholder="Write your thread if you want">${escapeHtml(entry.text)}</textarea>
        </div>
        <div class="form-row">
          <label for="autopost-photo-${escapeHtml(entry.id)}">Photos</label>
          <input id="autopost-photo-${escapeHtml(entry.id)}" data-autopost-photo="${escapeHtml(entry.id)}" type="file" accept="image/*" multiple ${entry.postedAt ? "disabled" : ""}>
        </div>
        <div class="form-row form-row-note">
          <span></span>
          <span class="selected-photo-note" id="autopost-photo-note-${escapeHtml(entry.id)}">${escapeHtml(autopostEntryPhotoSummary(entry))}</span>
        </div>
        ${Array.isArray(entry.media) && entry.media.length ? `
          <div class="autopost-entry-media">
            ${entry.media.map((item) => `
              <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name || entry.title || "Queued photo")}" loading="lazy">
            `).join("")}
          </div>
        ` : ""}
        <div class="form-row">
          <label for="autopost-anonymous-number-${escapeHtml(entry.id)}">Anonymous No. (admin)</label>
          <input id="autopost-anonymous-number-${escapeHtml(entry.id)}" data-autopost-anonymous-number="${escapeHtml(entry.id)}" type="number" min="1000" max="9999" list="admin-anonymous-options" value="${escapeHtml(entry.requestedAnonymousNumber || "")}" ${entry.postedAt ? "readonly" : ""} placeholder="Leave blank for random">
        </div>
      </div>
      ${entry.postedAt ? "" : `
        <div class="form-actions">
          <button class="board-button primary" type="button" data-action="autopost-save">Save queued post</button>
          ${(Array.isArray(entry.media) && entry.media.length) || autopostEntryHasQueuedPhotos(entry.id) ? `<button class="plain-board-action" type="button" data-action="autopost-clear-entry-media" data-id="${escapeHtml(entry.id)}">Clear photos</button>` : ""}
          <button class="plain-board-action" type="button" data-action="autopost-remove-entry" data-id="${escapeHtml(entry.id)}">Remove</button>
        </div>
      `}
    </article>
  `;
}

function renderInstagramQueue() {
  const queue = instagramQueue;
  const entries = (queue?.entries || []).filter(e => e.status !== "removed");
  return `<section class="post-box instagram-queue">
    <h2>Instagram queue</h2>
    <p>Select "Queue for Instagram" on a board post, review its screenshot, then add it here. Posts publish in order, ten minutes apart, even when this page is closed.</p>
    <p>${queue ? queue.connected ? "Instagram connected" : "Instagram connection required before starting" : "Queue not loaded"} · ${queue?.active ? `Running. Next eligible post: ${escapeHtml(new Date(queue.nextAt).toLocaleString())}` : "Paused"}</p>
    <div class="instagram-actions">
      <button class="board-button" data-action="instagram-connect">${queue?.connected ? "Reconnect Instagram" : "Connect Instagram"}</button>
      <button class="board-button" data-action="instagram-refresh">Refresh status</button>
      <button class="board-button primary" data-action="instagram-${queue?.active ? "pause" : "start"}" ${!queue || (!queue.active && !queue.connected) ? "disabled" : ""}>${queue?.active ? "Pause queue" : "Start queue"}</button>
    </div>
    ${instagramPreview ? `<div id="instagram-preview" class="instagram-preview">
      <h3>Review screenshot</h3><img src="${instagramPreview.url}" alt="Screenshot that will be posted to Instagram">
      <p>Caption: ${escapeHtml(instagramPreview.caption)}</p>
      <button class="board-button primary" data-action="instagram-add">Add this screenshot to queue</button>
      <button class="board-button" data-action="instagram-dismiss">Cancel preview</button>
    </div>` : ""}
    <div class="instagram-entries">${entries.length ? entries.map(e => `<article class="instagram-entry">
      <a href="${escapeHtml(e.imageUrl)}" target="_blank" rel="noopener"><img src="${escapeHtml(e.imageUrl)}" alt="${escapeHtml(e.caption)}" loading="lazy"></a>
      <div><strong>${escapeHtml(e.caption)}</strong><p>${escapeHtml(e.title)}</p><p>${escapeHtml(e.status)}${e.publishedAt ? ` · ${escapeHtml(new Date(e.publishedAt).toLocaleString())}` : ""}</p>
      ${e.error ? `<p role="alert">${escapeHtml(e.error)}</p>` : ""}
      ${["queued", "processing", "failed"].includes(e.status) ? `<button class="board-button small" data-action="instagram-remove" data-id="${escapeHtml(e.id)}">Remove</button>` : ""}
      ${e.status === "review" ? `<button class="board-button small" data-action="instagram-resolve" data-id="${escapeHtml(e.id)}">I checked Instagram: archive item</button>` : ""}
      </div></article>`).join("") : "<p>No posts selected.</p>"}</div>
  </section>`;
}

async function captureInstagramPost(post) {
  const { default: html2canvas } = await import("../vendor/html2canvas.js");
  const frame = document.createElement("div");
  frame.className = "instagram-capture";
  frame.innerHTML = renderThreadCard(post, 0);
  frame.querySelectorAll(".inline-admin-link, .thread-foot, .reply-list, .reply-form, .reply-toggle").forEach(el => el.remove());
  // Capture only the public original post, never admin controls or open reply drafts.
  const objectUrls = [];
  document.body.append(frame);
  try {
    await document.fonts.ready;
    await Promise.all([...frame.querySelectorAll("img")].map(async img => {
      const response = await fetch(img.src, { mode: "cors", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("A post image could not be loaded. Screenshot was not queued.");
      const url = URL.createObjectURL(await response.blob()); objectUrls.push(url);
      img.loading = "eager"; img.src = url;
      await img.decode();
    }));
    if (frame.scrollHeight > 6000) throw new Error("This post is too tall for a readable single-image screenshot.");
    const capture = await html2canvas(frame, { scale: 2, backgroundColor: "#eef2e0", logging: false, windowWidth: 900 });
    const canvas = document.createElement("canvas");
    canvas.width = 1080; canvas.height = 1350;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#eef2e0"; ctx.fillRect(0, 0, 1080, 1350);
    const scale = Math.min(1000 / capture.width, 1190 / capture.height);
    if (720 * scale * 2 < 480) throw new Error("This post is too long to fit legibly. A multi-image layout is needed.");
    const width = capture.width * scale, height = capture.height * scale;
    ctx.drawImage(capture, (1080 - width) / 2, (1270 - height) / 2, width, height);
    ctx.fillStyle = "#4f5b3b"; ctx.font = "24px Arial"; ctx.textAlign = "center";
    ctx.fillText("shsid.online", 540, 1310);
    return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Screenshot creation failed")), "image/jpeg", 0.94));
  } finally { frame.remove(); objectUrls.forEach(url => URL.revokeObjectURL(url)); }
}

function renderAutopostAdminPanel() {
  const job = state.autopostJob;
  if (!currentUser() || currentUser().role !== "admin") return "";
  const board = boardMeta(job?.category || "school");
  if (!job) {
    return `
      <section class="post-box">
        <div class="post-box-head">
          <div>
            <h2>Admin Queue</h2>
            <p class="post-box-copy">${escapeHtml(autopostError || "Loading staged posts…")}</p>
            <button type="button" class="board-button" data-action="autopost-reload">Retry loading queue</button>
          </div>
        </div>
      </section>
    `;
  }
  const entryCount = job.entries.length;
  autopostEntryIndex = Math.max(0, Math.min(autopostEntryIndex, Math.max(0, entryCount - 1)));
  const selectedEntry = job.entries[autopostEntryIndex];
  const pendingCount = job.entries.filter((entry) => !entry.postedAt).length;
  const postedCount = entryCount - pendingCount;
  return `
    <section class="post-box admin-queue-box" aria-busy="${autopostBusy}">
      <fieldset class="autopost-editor-controls"${autopostBusy ? " disabled" : ""}>
      <div class="post-box-head">
        <div>
          <h2>Fake Posting Dashboard</h2>
          <p class="post-box-copy">Build each queued post like a real thread draft, save it, then start the countdown when you want posting to begin.</p>
        </div>
        <div class="account-actions">
          <button class="board-button small muted" type="button" data-action="autopost-reset">Reset progress</button>
          <button class="board-button small muted" type="button" data-action="autopost-reload">Reload</button>
        </div>
      </div>
      <div class="thread-controls">
        <label class="control">
          <span>Board</span>
          <select id="autopost-category">
            ${BOARDS.map((board) => `<option value="${escapeHtml(board.category)}"${job.category === board.category ? " selected" : ""}>${escapeHtml(board.slug)}</option>`).join("")}
          </select>
        </label>
        <label class="control">
          <span>Min delay (minutes)</span>
          <input id="autopost-min-delay" type="number" min="1" max="10080" value="${escapeHtml(job.minDelayMinutes)}">
        </label>
        <label class="control">
          <span>Max delay (minutes)</span>
          <input id="autopost-max-delay" type="number" min="1" max="10080" value="${escapeHtml(job.maxDelayMinutes)}">
        </label>
      </div>
      <div class="active-filter">
        ${job.active
          ? `Queue is active. Next post in <strong class="autopost-countdown" data-next-post-at="${escapeHtml(job.nextPostAt || "")}">${escapeHtml(autopostCountdownLabel(job.countdownMs))}</strong>`
          : job.finishedAt && !pendingCount
            ? `Queue finished on <strong>${escapeHtml(commentTimestamp(job.finishedAt))}</strong>.`
            : "Queue is paused."}
      </div>
      <div class="active-filter">
        <span><strong>${pendingCount}</strong> pending</span>
        <span><strong>${postedCount}</strong> posted</span>
        <span>Thread No. values are random. Leave Anonymous No. blank for random or type one you want to use.</span>
        <span>Default board: <strong>${escapeHtml(board.slug)}</strong></span>
      </div>
      <div class="form-actions autopost-save-actions">
        <button class="board-button primary" type="button" data-action="autopost-save">${autopostBusy ? "Working…" : "Save queue"}</button>
        <button class="board-button ${job.active ? "muted" : "primary"}" type="button" data-action="${job.active ? "autopost-pause" : "autopost-start"}">${job.active ? "Pause countdown" : "Start countdown"}</button>
        <button class="board-button small" type="button" data-action="autopost-add-entry">Add draft</button>
        <button class="board-button small" type="button" data-action="autopost-load-defaults">Load starter posts</button>
        <span class="form-note" data-autopost-save-status aria-live="polite">${autopostBusy ? "Working…" : state.autopostDirty ? "Unsaved changes" : "Saved"}</span>
      </div>
      ${autopostError ? `<p class="form-note" role="alert">${escapeHtml(autopostError)}</p>` : ""}
      <div class="autopost-entry-navigator" aria-label="Queued post navigation">
        <button class="plain-board-action" type="button" data-action="autopost-navigate" data-index="${autopostEntryIndex - 1}"${autopostEntryIndex === 0 ? " disabled" : ""}>Previous</button>
        <strong>${entryCount ? `Post ${autopostEntryIndex + 1} of ${entryCount}` : "No staged posts"}</strong>
        <button class="plain-board-action" type="button" data-action="autopost-navigate" data-index="${autopostEntryIndex + 1}"${autopostEntryIndex >= entryCount - 1 ? " disabled" : ""}>Next</button>
      </div>
      <div class="thread-list">
        ${selectedEntry ? renderAutopostEntry(selectedEntry, autopostEntryIndex, job) : `<div class="empty-state">Add a draft to begin building the queue.</div>`}
      </div>
      </fieldset>
    </section>
  `;
}

function bindAutopostCountdown() {
  clearAutopostCountdownTimer();
  const countdown = document.querySelector(".autopost-countdown");
  const nextPostAt = countdown?.dataset.nextPostAt || "";
  if (!countdown || !nextPostAt) return;
  const target = Date.parse(nextPostAt);
  if (!Number.isFinite(target)) return;
  const update = () => {
    const remaining = Math.max(0, target - Date.now());
    countdown.textContent = autopostCountdownLabel(remaining);
  };
  update();
  autopostCountdownTimer = setInterval(update, 1000);
}

function startPostQuote(quoteRef) {
  if (!quoteRef) return;
  state.composerQuote = quoteRef;
  state.composerQuoteSearch = "";
  state.composerOpen = true;
  saveState();
  render();
  document.querySelector("#composer-body")?.focus();
}

function renderQuoteCard(quoteRef, { composer = false } = {}) {
  if (!quoteRef) return "";
  return `
    <div class="quote-card${composer ? " composer-quote" : ""}">
      <div class="quote-card-body">
        <div class="quote-label">${escapeHtml(composer ? `Quoting ${quoteRef.label || "post"}` : quoteRef.label || "Quoted post")}</div>
        ${quoteRef.excerpt ? `<div class="quote-excerpt">&gt; ${escapeHtml(quoteRef.excerpt)}</div>` : ""}
      </div>
      ${composer ? `<button class="plain-board-action quote-remove" type="button" data-action="clear-quote">Remove quote</button>` : ""}
    </div>
  `;
}

function quoteSearchResults() {
  const query = String(state.composerQuoteSearch || "").trim().toLowerCase();
  if (!query) return [];
  return state.posts
    .filter((post) => post.id !== state.composerQuote?.postId)
    .filter((post) => {
      const haystack = [
        post.title,
        post.text,
        post.authorLabel,
        post.anonymousLabel,
        post.postNumber ? `no.${post.postNumber}` : "",
        boardMeta(post.category).slug,
        boardMeta(post.category).name
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    })
    .slice(0, 6);
}

function queueLike(postId) {
  queuedLikePostId = String(postId || "").trim();
}

function clearQueuedLike() {
  queuedLikePostId = "";
}

async function likePost(postId) {
  if (!state.token) {
    queueLike(postId);
    openAuth("login", "vote");
    return;
  }
  const result = await apiRequest(`/posts/${postId}/like`, { method: "POST" });
  if (result.post) mergePost(result.post);
  await fetchNotifications();
  saveState();
  render();
}

function resetAuthDraft({ keepEmail = false } = {}) {
  state.authStep = "email";
  state.authMode = "login";
  state.pendingCode = "";
  if (!keepEmail) state.pendingEmail = "";
  state.pendingUsername = "";
}

function openAuth(mode = "login", reason = "") {
  state.authOpen = true;
  state.authMode = mode === "register" ? "register" : "login";
  state.authStep = "email";
  authReason = reason;
  render();
}

function closeAuth() {
  state.authOpen = false;
  authReason = "";
  resetAuthDraft({ keepEmail: true });
  authBusy = false;
  saveState();
  render();
}

async function finishAuthFlow() {
  state.authOpen = false;
  authReason = "";
  resetAuthDraft({ keepEmail: false });
  await fetchNotifications();
  await fetchAutopostJob();
  saveState();
  render();
  if (queuedLikePostId) {
    const postId = queuedLikePostId;
    clearQueuedLike();
    await likePost(postId);
  }
}

async function handleEmailIntent(intent) {
  if (authBusy) return;
  const email = String(document.querySelector("#auth-email")?.value || "").trim().toLowerCase();
  if (!email) return toast("Please enter your email");
  authBusy = true;
  state.pendingEmail = email;
  state.authMode = intent === "register" ? "register" : "login";
  render();
  try {
    if (intent === "register") {
      const result = await apiRequest("/auth/start", { method: "POST", body: { email }, auth: false });
      if (result.hint === "login") {
        state.authMode = "login";
        state.authStep = "password";
        toast("This email already has an account. Sign in instead.");
      } else {
        state.authStep = "verify";
        toast(result.devCode ? `Verification code: ${result.devCode}` : "Check your email for the verification code.");
      }
    } else {
      state.authStep = "password";
    }
  } catch (error) {
    toast(error.message || "Could not continue");
  } finally {
    authBusy = false;
    saveState();
    render();
  }
}

async function submitVerifyCode(event) {
  event.preventDefault();
  if (authBusy) return;
  const code = String(document.querySelector("#auth-code")?.value || "").replace(/[\s-]+/g, "");
  if (!code) return toast("Please enter the code from your email");
  authBusy = true;
  render();
  try {
    await apiRequest("/auth/verify-code", {
      method: "POST",
      body: { email: state.pendingEmail, code },
      auth: false
    });
    state.pendingCode = code;
    state.authStep = "password";
  } catch (error) {
    toast(error.message || "That code did not work");
  } finally {
    authBusy = false;
    saveState();
    render();
  }
}

async function submitPassword(event) {
  event.preventDefault();
  if (authBusy) return;
  const password = String(document.querySelector("#auth-password")?.value || "");
  if (!password) return toast("Please enter a password");
  authBusy = true;
  render();
  try {
    if (state.authMode === "register") {
      const username = normalizeUsernameInput(document.querySelector("#auth-username")?.value || "");
      const confirm = String(document.querySelector("#auth-password-confirm")?.value || "");
      const usernameError = reservedUsernameMessage(username);
      if (usernameError) throw new Error(usernameError);
      if (!confirm) throw new Error("Please confirm your password");
      if (confirm !== password) throw new Error("Passwords do not match");
      state.pendingUsername = username;
      const result = await apiRequest("/auth/register", {
        method: "POST",
        body: {
          email: state.pendingEmail,
          code: state.pendingCode,
          password,
          username
        },
        auth: false
      });
      state.token = result.session?.token || "";
      state.currentUser = result.user || null;
      if (needsProfile(result.user)) {
        state.authStep = "profile";
      } else {
        await finishAuthFlow();
      }
    } else {
      const result = await apiRequest("/auth/login", {
        method: "POST",
        body: {
          email: state.pendingEmail,
          password
        },
        auth: false
      });
      state.token = result.session?.token || "";
      state.currentUser = result.user || null;
      if (needsProfile(result.user)) {
        state.authStep = "profile";
      } else {
        await finishAuthFlow();
      }
    }
  } catch (error) {
    toast(error.message || "Could not sign you in");
  } finally {
    authBusy = false;
    saveState();
    render();
  }
}

async function submitProfile(event) {
  event.preventDefault();
  if (authBusy) return;
  const username = normalizeUsernameInput(document.querySelector("#reg-username")?.value || "");
  const usernameError = reservedUsernameMessage(username);
  if (usernameError) return toast(usernameError);
  authBusy = true;
  render();
  try {
    state.pendingUsername = username;
    const result = await apiRequest("/auth/complete-profile", {
      method: "POST",
      body: {
        username
      }
    });
    state.currentUser = result.user || null;
    await finishAuthFlow();
    toast("Account ready. You can upvote now.");
  } catch (error) {
    toast(error.message || "Could not save your username");
  } finally {
    authBusy = false;
    saveState();
    render();
  }
}

async function logout() {
  try {
    if (state.token) await apiRequest("/auth/logout", { method: "POST", body: {} });
  } catch {
    // ignore logout failures
  }
  state.token = "";
  state.currentUser = null;
  state.autopostJob = null;
  state.autopostDirty = false;
  state.notifications = [];
  state.notificationsOpen = false;
  clearAutopostCountdownTimer();
  clearQueuedLike();
  saveState();
  render();
}

async function submitThread(event) {
  event.preventDefault();
  if (threadSubmitting) return;
  const title = String(document.querySelector("#composer-title")?.value || "").trim();
  const body = String(document.querySelector("#composer-body")?.value || "").trim();
  const category = String(document.querySelector("#composer-board")?.value || defaultComposerBoard()).trim().toLowerCase();
  const photoFiles = composerPhotos();
  const anonymousAccountNumber = currentUser()?.role === "admin"
    ? String(document.querySelector("#composer-anonymous-number")?.value || "").trim()
    : "";
  const quoteRef = state.composerQuote || null;
  if (!title && !body && !photoFiles.length && !quoteRef) return toast("Please add a subject, comment, photo, or quote");
  threadSubmitting = true;
  try {
    const media = await uploadPhotos(photoFiles, 9);
    const result = await apiRequest("/posts", {
      method: "POST",
      body: { title, text: body, category, media, ...(quoteRef ? { quoteRef } : {}), ...(anonymousAccountNumber ? { anonymousAccountNumber } : {}) },
      auth: false,
      optionalAuth: true
    });
    if (result.post) mergePost(result.post);
    state.composerBoard = category;
    state.composerTitle = "";
    state.composerBody = "";
    state.composerAnonymousNumber = "";
    state.composerQuote = null;
    state.composerQuoteSearch = "";
    state.composerOpen = false;
    composerPhotoFiles = [];
    const photoInput = document.querySelector("#composer-photo");
    if (photoInput) photoInput.value = "";
    saveState();
    render();
    toast("Thread posted");
  } catch (error) {
    toast(error.message || "Could not post thread");
  } finally {
    threadSubmitting = false;
  }
}

async function submitReply(postId) {
  if (replySubmittingPostIds.has(postId)) return;
  const replyKey = `reply-${postId}`;
  const text = String(document.querySelector(`#${replyKey}`)?.value || "").trim();
  const photoInput = document.querySelector(`#reply-photo-${CSS.escape(postId)}`);
  const photoFiles = replyPhotos(postId);
  const replyTo = String(state.replyTargets?.[postId] || "").trim();
  const anonymousAccountNumber = currentUser()?.role === "admin"
    ? String(document.querySelector(`#reply-anonymous-number-${CSS.escape(postId)}`)?.value || "").trim()
    : "";
  if (!text && !photoFiles.length) return toast("Please write a reply or add a photo");
  replySubmittingPostIds.add(postId);
  try {
    const media = await uploadPhotos(photoFiles, 5);
    const result = await apiRequest(`/posts/${postId}/comments`, {
      method: "POST",
      body: { text, media, ...(replyTo ? { replyTo } : {}), ...(anonymousAccountNumber ? { anonymousAccountNumber } : {}) },
      auth: false,
      optionalAuth: true
    });
    const target = state.posts.find((post) => post.id === postId);
    if (target && result.comment) {
      const nextComment = {
        id: result.comment.id,
        text: String(result.comment.text || "").trim(),
        anonymousLabel: String(result.comment.anonymousLabel || "Anonymous").trim(),
        adminAnonymousAccountNumber: Number.isInteger(Number(result.comment.adminAnonymousAccountNumber)) ? Number(result.comment.adminAnonymousAccountNumber) : null,
        authorId: String(result.comment.authorId || ""),
        canDelete: Boolean(result.comment.canDelete || result.comment.authorId === currentUser()?.id),
        media: Array.isArray(result.comment.media) ? result.comment.media : [],
        likes: Array.isArray(result.comment.likes) ? result.comment.likes : [],
        replyTo: result.comment.replyTo ? String(result.comment.replyTo) : null,
        createdAt: result.comment.createdAt
      };
      if (!(target.comments || []).some((comment) => comment.id === nextComment.id)) {
        target.comments = [...(target.comments || []), nextComment];
      }
    }
    state.replyDrafts[postId] = "";
    state.replyAnonymousNumbers[postId] = "";
    state.replyTargets[postId] = "";
    replyPhotoFilesByPostId.delete(postId);
    openReplies.add(postId);
    if (openReplyPostId === postId) openReplyPostId = "";
    if (photoInput) photoInput.value = "";
    saveState();
    await fetchNotifications();
    render();
    toast("Reply posted");
  } catch (error) {
    toast(error.message || "Could not post reply");
  } finally {
    replySubmittingPostIds.delete(postId);
  }
}

async function deletePost(postId) {
  const user = currentUser();
  const post = state.posts.find((item) => item.id === postId);
  if (!post?.canDelete && (!user || (user.role !== "admin" && post?.authorId !== user.id))) return toast("You can only delete your own post");
  if (!window.confirm("Delete this thread?")) return;
  try {
    await apiRequest(`/posts/${postId}`, { method: "DELETE" });
    removePost(postId);
    saveState();
    render();
    toast("Thread deleted");
  } catch (error) {
    toast(error.message || "Could not delete thread");
  }
}

async function deleteComment(postId, commentId) {
  const user = currentUser();
  const post = state.posts.find((item) => item.id === postId);
  const comment = (post?.comments || []).find((item) => item.id === commentId);
  if (!comment?.canDelete && (!user || (user.role !== "admin" && comment?.authorId !== user.id))) return toast("You can only delete your own reply");
  if (!window.confirm("Delete this reply?")) return;
  try {
    await apiRequest(`/posts/${postId}/comments/${commentId}`, { method: "DELETE" });
    removeComment(postId, commentId);
    saveState();
    render();
    toast("Reply deleted");
  } catch (error) {
    toast(error.message || "Could not delete reply");
  }
}

function filteredPosts() {
  const query = String(state.search || "").trim().toLowerCase();
  const authorFilter = String(state.authorFilter || "").trim().toLowerCase();
  const posts = state.posts.filter((post) => {
    const matchesBoard = state.board === "all" || post.category === state.board;
    if (!matchesBoard) return false;
    if (authorFilter && !postMatchesUserTag(post, authorFilter)) return false;
    if (!query) return true;
    const haystack = [
      post.title,
      post.text,
      post.authorLabel,
      post.anonymousLabel,
      post.adminAnonymousAccountNumber ? `anonymous ${post.adminAnonymousAccountNumber}` : "",
      post.adminAnonymousAccountNumber ? String(post.adminAnonymousAccountNumber) : "",
      boardMeta(post.category).name,
      boardMeta(post.category).slug,
      ...(post.comments || []).flatMap((comment) => [
        comment.text,
        comment.anonymousLabel,
        comment.adminAnonymousAccountNumber ? `anonymous ${comment.adminAnonymousAccountNumber}` : "",
        comment.adminAnonymousAccountNumber ? String(comment.adminAnonymousAccountNumber) : ""
      ])
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
  return posts.sort((left, right) => {
    if (left.sticky !== right.sticky) return Number(right.sticky) - Number(left.sticky);
    if (state.sort === "trending") {
      const replyDiff = replyCountForPost(right) - replyCountForPost(left);
      if (replyDiff) return replyDiff;
      const bumpDiff = bumpCountForPost(right) - bumpCountForPost(left);
      if (bumpDiff) return bumpDiff;
    }
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });
}

function replyCountForPost(post) {
  return Array.isArray(post.comments) ? post.comments.length : 0;
}

function bumpCountForPost(post) {
  return Array.isArray(post.likes) ? post.likes.length : 0;
}

function userProfileStats(posts, tagKey) {
  const profilePosts = posts.filter((post) => postMatchesUserTag(post, tagKey));
  const threadCount = profilePosts.filter((post) => userTagKey(post) === tagKey).length;
  const replyCount = profilePosts.reduce((count, post) => (
    count + (post.comments || []).filter((comment) => userTagKey(comment) === tagKey).length
  ), 0);
  const boards = new Set(profilePosts.map((post) => boardMeta(post.category).slug));
  return { profilePosts, threadCount, replyCount, boards: [...boards] };
}

function renderUserProfileHeader() {
  const tag = String(state.authorFilter || "").trim();
  if (!tag) return "";
  const tagKey = tag.toLowerCase();
  const stats = userProfileStats(state.posts, tagKey);
  return `
    <section class="profile-card">
      <div>
        <div class="profile-kicker">User profile</div>
        <h2>${escapeHtml(tag)}</h2>
        <p>Showing this tag's threads plus threads where they replied.</p>
      </div>
      <div class="profile-stats">
        <div><strong>${stats.threadCount}</strong><span>posts</span></div>
        <div><strong>${stats.replyCount}</strong><span>replies</span></div>
        <div><strong>${stats.boards.length}</strong><span>boards</span></div>
      </div>
      ${stats.boards.length ? `<div class="profile-boards">${stats.boards.map((board) => `<span>${escapeHtml(board)}</span>`).join("")}</div>` : ""}
      <button class="board-button small muted" type="button" data-action="clear-author-filter">Back to all users</button>
    </section>
  `;
}

function renderThreadCard(post, index, options = {}) {
  const board = boardMeta(post.category);
  const liked = userCanLike(post);
  const adminMode = currentUser()?.role === "admin";
  const canDeletePost = adminMode || Boolean(post.canDelete);
  const replyOpen = openReplyPostId === post.id;
  const replyCount = (post.comments || []).length;
  const profileTagKey = String(options.profileTagKey || "").trim().toLowerCase();
  const profileMode = Boolean(profileTagKey);
  const repliesOpen = openReplies.has(post.id) || (profileMode && replyCount > 0);
  const replySubmitting = replySubmittingPostIds.has(post.id);
  const replyPhotoSummary = selectedPhotoSummary(replyPhotoFilesByPostId.get(post.id) || [], "No photos selected");
  const replyAnonymousNumber = state.replyAnonymousNumbers?.[post.id] || "";
  const replyTargetId = String(state.replyTargets?.[post.id] || "");
  const commentsById = new Map((post.comments || []).map((comment) => [comment.id, comment]));
  const replyTarget = replyTargetId ? commentsById.get(replyTargetId) : null;
  const displayNumber = Number.isInteger(post.postNumber) ? post.postNumber : 5000 + index;
  return `
    <article class="thread-card">
      <div class="thread-head">
        <div class="thread-topline">
          <button class="thread-board" type="button" data-action="enter-board" data-board="${escapeHtml(board.category)}">${escapeHtml(board.slug)}</button>
          <button class="thread-author" type="button" data-action="filter-author" data-author="${escapeHtml(userTagLabel(post))}">${escapeHtml(userTagLabel(post))}</button>
          <span class="thread-separator">/</span>
          <span class="thread-id">No.${displayNumber}</span>
          ${canDeletePost ? `<button class="inline-admin-link" data-action="delete-post" data-id="${escapeHtml(post.id)}">Delete</button>` : ""}
          ${adminMode ? `<button class="inline-admin-link" data-action="instagram-preview" data-id="${escapeHtml(post.id)}">Queue for Instagram</button>` : ""}
        </div>
        ${post.title ? `<div class="thread-title">${escapeHtml(post.title)}</div>` : ""}
      </div>
      ${post.quoteRef ? `
        ${renderQuoteCard(post.quoteRef)}
      ` : ""}
      ${post.text ? `<p class="thread-body">${escapeHtml(post.text)}</p>` : ""}
      ${(post.media || []).length ? `
        <div class="thread-media">
          ${(post.media || []).map((item) => `
            <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name || post.title || "Thread image")}" loading="lazy">
          `).join("")}
        </div>
      ` : ""}
      <div class="thread-foot">
        <span>${escapeHtml(board.name)}</span>
        <span>${replyCount} repl${replyCount === 1 ? "y" : "ies"}</span>
        <span>posted ${escapeHtml(timeAgo(post.createdAt))}</span>
        ${replyCount && !profileMode ? `<button class="plain-board-action" type="button" data-action="${repliesOpen ? "hide-replies" : "show-replies"}" data-id="${escapeHtml(post.id)}">${repliesOpen ? "Hide replies" : "Show replies"}</button>` : ""}
        <button class="vote-button ${liked ? "liked" : ""}" data-action="like-post" data-id="${escapeHtml(post.id)}">
          ${liked ? "▲" : "△"} ${Array.isArray(post.likes) ? post.likes.length : 0}
        </button>
      </div>
      ${replyCount && repliesOpen ? `
        <div class="reply-list">
          ${(post.comments || []).map((comment, commentIndex) => `
            <div class="reply ${profileTagKey && userTagKey(comment) === profileTagKey ? "profile-match" : ""}">
              <div class="reply-head">
                <div class="reply-identity">
                  <button class="reply-author" type="button" data-action="filter-author" data-author="${escapeHtml(userTagLabel(comment))}">${escapeHtml(userTagLabel(comment))}</button>
                  <time datetime="${escapeHtml(comment.createdAt || "")}" title="${escapeHtml(timeAgo(comment.createdAt))}">${escapeHtml(commentTimestamp(comment.createdAt))}</time>
                </div>
                <div class="reply-head-actions">
                  ${(adminMode || comment.canDelete) ? `<button class="inline-admin-link" data-action="delete-comment" data-id="${escapeHtml(post.id)}" data-comment-id="${escapeHtml(comment.id)}">Delete</button>` : ""}
                </div>
              </div>
              ${comment.replyTo && commentsById.has(comment.replyTo) ? `
                <div class="reply-target">
                  replying to ${escapeHtml(commentsById.get(comment.replyTo).anonymousLabel || "Anonymous")}
                  <time datetime="${escapeHtml(commentsById.get(comment.replyTo).createdAt || "")}" title="${escapeHtml(timeAgo(commentsById.get(comment.replyTo).createdAt))}">${escapeHtml(commentTimestamp(commentsById.get(comment.replyTo).createdAt))}</time>
                </div>
              ` : ""}
              ${comment.text ? `<p class="reply-body">${escapeHtml(comment.text)}</p>` : ""}
              ${(comment.media || []).length ? `
                <div class="reply-media">
                  ${(comment.media || []).map((item) => `
                    <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name || "Reply image")}" loading="lazy">
                  `).join("")}
                </div>
              ` : ""}
              <div class="reply-inline-actions">
                <button class="plain-board-action" type="button" data-action="open-comment-reply" data-id="${escapeHtml(post.id)}" data-comment-id="${escapeHtml(comment.id)}">Reply</button>
              </div>
            </div>
          `).join("")}
        </div>
      ` : ""}
      ${replyOpen ? `
        <form class="reply-form" data-reply-form="${escapeHtml(post.id)}">
          ${replyTarget ? `
            <div class="replying-to-note">
              Replying to ${escapeHtml(replyTarget.anonymousLabel || "Anonymous")}
              <button class="inline-admin-link" type="button" data-action="clear-reply-target" data-id="${escapeHtml(post.id)}">Reply to thread instead</button>
            </div>
          ` : ""}
          <label>
            ${replyTarget ? "Reply to reply" : "Reply"}
            <textarea id="reply-${escapeHtml(post.id)}" class="reply-input" rows="3" maxlength="280" placeholder="Post a public reply">${escapeHtml(state.replyDrafts[post.id] || "")}</textarea>
          </label>
          <label class="reply-photo-row">
            Photos
            <input id="reply-photo-${escapeHtml(post.id)}" type="file" accept="image/*" multiple>
          </label>
          ${adminMode ? `
            <label class="reply-photo-row">
              Anonymous No.
              <input id="reply-anonymous-number-${escapeHtml(post.id)}" type="number" min="1000" max="9999" list="admin-anonymous-options" value="${escapeHtml(replyAnonymousNumber)}" placeholder="Reuse admin alias">
            </label>
          ` : ""}
          <div class="selected-photo-note" id="reply-photo-note-${escapeHtml(post.id)}">${escapeHtml(replyPhotoSummary)}</div>
          <div class="form-note">At most 5 photos per reply.</div>
          <div class="reply-actions">
            <button class="board-button" type="submit"${replySubmitting ? " disabled" : ""}>${replySubmitting ? "Posting..." : "Reply"}</button>
            <button class="board-button muted" type="button" data-action="close-reply" data-id="${escapeHtml(post.id)}">Close</button>
          </div>
        </form>
      ` : `
        <button class="board-button reply-toggle" type="button" data-action="open-reply" data-id="${escapeHtml(post.id)}">Reply</button>
      `}
    </article>
  `;
}

function renderAuthModal() {
  if (!state.authOpen) return "";
  const mode = state.authMode === "register" ? "register" : "login";
  const step = state.authStep;
  const title = step === "email"
    ? "Sign in or create an account"
    : step === "verify"
      ? "Check your email"
      : step === "password"
        ? (mode === "register" ? "Create your password" : "Welcome back")
        : "Choose a username";
  const subtitle = step === "email"
    ? (authReason === "vote"
      ? "You only need an account if you want to upvote. Reading and posting stay open."
      : "Reading and posting stay open. Accounts are only for upvoting.")
    : step === "verify"
      ? "Enter the 6-digit code we sent to your email."
      : step === "password"
        ? (mode === "register"
          ? "Finish setting up your account with a password and username."
          : "Sign in to unlock upvotes.")
        : "Pick a username that no one else is using.";

  const body = step === "email" ? `
    <form id="auth-email-form" class="auth-form">
      <label class="auth-field">
        <span>Email</span>
        <input id="auth-email" type="email" value="${escapeHtml(state.pendingEmail || "")}" placeholder="you@example.com" required>
      </label>
      <div class="auth-actions">
        <button class="board-button primary" type="submit" data-auth-intent="login"${authBusy ? " disabled" : ""}>Sign in</button>
        <button class="board-button" type="submit" data-auth-intent="register"${authBusy ? " disabled" : ""}>Create account</button>
      </div>
    </form>
  ` : step === "verify" ? `
    <form id="auth-verify-form" class="auth-form">
      <label class="auth-field">
        <span>Email</span>
        <input type="text" value="${escapeHtml(state.pendingEmail || "")}" disabled>
      </label>
      <label class="auth-field">
        <span>Verification code</span>
        <input id="auth-code" inputmode="numeric" value="${escapeHtml(state.pendingCode || "")}" placeholder="6-digit code" required>
      </label>
      <div class="auth-actions">
        <button class="board-button primary" type="submit"${authBusy ? " disabled" : ""}>Continue</button>
        <button class="board-button" type="button" data-action="auth-back"${authBusy ? " disabled" : ""}>Back</button>
      </div>
    </form>
  ` : step === "password" ? `
    <form id="auth-password-form" class="auth-form">
      <label class="auth-field">
        <span>Email</span>
        <input type="text" value="${escapeHtml(state.pendingEmail || "")}" disabled>
      </label>
      <label class="auth-field">
        <span>Password</span>
        <input id="auth-password" type="password" placeholder="Password" required>
      </label>
      ${mode === "register" ? `
        <label class="auth-field">
          <span>Username</span>
          <input id="auth-username" type="text" value="${escapeHtml(state.pendingUsername || "")}" placeholder="Choose a username" required>
        </label>
        <label class="auth-field">
          <span>Confirm password</span>
          <input id="auth-password-confirm" type="password" placeholder="Confirm password" required>
        </label>
      ` : ""}
      <div class="auth-actions">
        <button class="board-button primary" type="submit"${authBusy ? " disabled" : ""}>${mode === "register" ? "Create account" : "Sign in"}</button>
        <button class="board-button" type="button" data-action="auth-back"${authBusy ? " disabled" : ""}>Back</button>
      </div>
    </form>
  ` : `
    <form id="auth-profile-form" class="auth-form">
      <label class="auth-field">
        <span>Username</span>
        <input id="reg-username" value="${escapeHtml(state.pendingUsername || "")}" placeholder="Choose a username" required>
      </label>
      <div class="auth-actions">
        <button class="board-button primary" type="submit"${authBusy ? " disabled" : ""}>Save username</button>
      </div>
    </form>
  `;

  return `
    <div class="modal-backdrop" id="auth-modal">
      <div class="modal-card">
        <div class="modal-head">
          <div>
            <h2>${escapeHtml(title)}</h2>
            <p>${escapeHtml(subtitle)}</p>
          </div>
          <button class="board-button close-button" type="button" data-action="close-auth"${authBusy ? " disabled" : ""}>Close</button>
        </div>
        ${body}
      </div>
    </div>
  `;
}

function renderNotificationBell() {
  const signedInUser = currentUser();
  if (!signedInUser) return "";
  const notifications = groupedNotifications();
  const unreadCount = notificationBadgeCount();
  return `
    <div class="notification-wrap">
      <button class="notification-bell" type="button" data-action="toggle-notifications" aria-label="Notifications">
        <span aria-hidden="true">&#128276;</span>
        ${unreadCount ? `<span class="notification-badge">${unreadCount > 99 ? "99+" : unreadCount}</span>` : ""}
      </button>
      ${state.notificationsOpen ? `
        <div class="notification-panel">
          <div class="notification-panel-head">
            <strong>Notifications</strong>
            ${notifications.some((item) => !item.read) ? `<button class="inline-admin-link" type="button" data-action="mark-notifications-read">Mark read</button>` : ""}
          </div>
          ${notifications.length ? `
            <div class="notification-list">
              ${notifications.map((item) => `
                <div class="notification-item ${item.read ? "read" : "unread"}">
                  <div>${escapeHtml(item.text || "New notification")}</div>
                  <time datetime="${escapeHtml(item.createdAt || "")}">${escapeHtml(timeAgo(item.createdAt))}</time>
                </div>
              `).join("")}
            </div>
          ` : `<div class="notification-empty">No notifications yet.</div>`}
        </div>
      ` : ""}
    </div>
  `;
}

function render() {
  const app = document.querySelector("#app");
  const posts = filteredPosts();
  const activeBoard = state.board === "all" ? null : boardMeta(state.board);
  const signedInUser = currentUser();
  const adminComposer = signedInUser?.role === "admin";
  const quoteResults = quoteSearchResults();
  const composerOpen = Boolean(state.composerOpen || hasUnsavedComposerDraft());
  const composerPhotoSummary = selectedPhotoSummary(composerPhotoFiles, "No photos selected");
  const adminAnonymousOptions = adminAnonymousNumberOptions();
  const profileTagKey = String(state.authorFilter || "").trim().toLowerCase();
  app.innerHTML = `
    <div class="page">
      <header class="site-header">
        <div class="account-strip">
          <div class="account-copy">
            ${signedInUser
              ? `Signed in as <strong>${escapeHtml(signedInUser.englishName || signedInUser.email || "Student")}</strong>`
              : "Post and comment without signing in."}
          </div>
          <div class="account-actions">
            ${signedInUser
              ? `${renderNotificationBell()}<button class="board-button small" data-action="logout">Log out</button>`
              : `<button class="board-button small primary" data-action="open-auth">Sign in / Create account</button>`}
          </div>
        </div>
        <h1>SHSID Board</h1>
      </header>

      <nav class="board-nav" id="boards">
        <button class="board-link ${state.board === "all" ? "active" : ""}" data-board="all">/all/</button>
        ${BOARDS.map((board) => `
          <button class="board-link ${state.board === board.category ? "active" : ""}" data-board="${escapeHtml(board.category)}">${escapeHtml(board.slug)}</button>
        `).join("")}
      </nav>

      <section class="post-box">
        <div class="post-box-head">
          <div>
            <h2>Thread</h2>
            <p class="post-box-copy">${composerOpen ? "Up to 9 photos per thread." : "Start a new thread when you are ready."}</p>
          </div>
          ${composerOpen ? `<button class="board-button small muted" type="button" data-action="close-composer">Close</button>` : `<button class="board-button primary" type="button" data-action="open-composer">Post</button>`}
        </div>
        ${composerOpen ? `
        ${state.composerQuote ? renderQuoteCard(state.composerQuote, { composer: true }) : ""}
        <form id="thread-form" class="thread-form">
          <div class="form-row">
            <label for="composer-board">Board</label>
            <select id="composer-board">
              ${BOARDS.map((board) => `<option value="${escapeHtml(board.category)}"${defaultComposerBoard() === board.category ? " selected" : ""}>${escapeHtml(board.slug)}</option>`).join("")}
            </select>
          </div>
          <div class="form-row quote-search-row">
            <label for="composer-quote-search">Quote a post (optional)</label>
            <input id="composer-quote-search" type="search" value="${escapeHtml(state.composerQuoteSearch || "")}" placeholder="Search subject, text, board, or No.">
            ${String(state.composerQuoteSearch || "").trim() ? `
              <div class="quote-results">
                ${quoteResults.length ? quoteResults.map((post) => `
                  <button class="quote-result" type="button" data-action="select-quote" data-id="${escapeHtml(post.id)}">
                    <span class="quote-result-label">${escapeHtml(quoteLabelForPost(post))}</span>
                    <span class="quote-result-text">${escapeHtml(quoteExcerpt(post.text || post.title) || "No text")}</span>
                  </button>
                `).join("") : `<div class="quote-empty">No matching posts found.</div>`}
              </div>
            ` : ""}
          </div>
          <div class="form-row">
            <label for="composer-title">Subject (optional)</label>
            <input id="composer-title" type="text" maxlength="90" value="${escapeHtml(state.composerTitle || "")}" placeholder="Add a subject if you want">
          </div>
          <div class="form-row form-row-textarea">
            <label for="composer-body">Comment (optional)</label>
            <textarea id="composer-body" rows="5" maxlength="5000" placeholder="Write your thread if you want">${escapeHtml(state.composerBody || "")}</textarea>
          </div>
          <div class="form-row">
            <label for="composer-photo">Photos</label>
            <input id="composer-photo" type="file" accept="image/*" multiple>
          </div>
          <div class="form-row form-row-note">
            <span></span>
            <span class="selected-photo-note" id="composer-photo-note">${escapeHtml(composerPhotoSummary)}</span>
          </div>
          ${adminComposer ? `
            <div class="form-row">
              <label for="composer-anonymous-number">Anonymous No. (admin)</label>
              <input id="composer-anonymous-number" type="number" min="1000" max="9999" list="admin-anonymous-options" value="${escapeHtml(state.composerAnonymousNumber || "")}" placeholder="Reuse or enter admin alias">
            </div>
          ` : ""}
          <div class="form-actions">
            <button class="board-button primary" type="submit"${threadSubmitting ? " disabled" : ""}>${threadSubmitting ? "Posting..." : "Post thread"}</button>
            <span class="form-note">At most 9 photos per thread.</span>
          </div>
        </form>
        ` : ""}
      </section>

      ${adminComposer ? renderAutopostAdminPanel() : ""}
      ${adminComposer ? renderInstagramQueue() : ""}

      <section class="thread-controls">
        <label class="control">
          <span>Search</span>
          <input id="search-input" type="search" value="${escapeHtml(state.search || "")}" placeholder="search threads, replies, or users">
        </label>
        <label class="control">
          <span>Board</span>
          <select id="board-filter">
            <option value="all"${state.board === "all" ? " selected" : ""}>/all/</option>
            ${BOARDS.map((board) => `<option value="${escapeHtml(board.category)}"${state.board === board.category ? " selected" : ""}>${escapeHtml(board.slug)}</option>`).join("")}
          </select>
        </label>
        <label class="control">
          <span>Sort</span>
          <select id="sort-filter">
            <option value="recent"${state.sort === "recent" ? " selected" : ""}>Most recent</option>
            <option value="trending"${state.sort === "trending" ? " selected" : ""}>Trending</option>
          </select>
        </label>
      </section>
      ${state.authorFilter ? `
        <div class="active-filter">
          Showing posts by <strong>${escapeHtml(state.authorFilter)}</strong>
          <button class="plain-board-action" type="button" data-action="clear-author-filter">Show everyone</button>
        </div>
      ` : ""}
      ${state.authorFilter ? renderUserProfileHeader() : ""}

      <main class="thread-list">
        ${posts.length
          ? posts.map((post, index) => renderThreadCard(post, index, { profileTagKey })).join("")
          : `<div class="empty-state">No threads matched that search.</div>`}
      </main>
      ${adminComposer ? `
        <datalist id="admin-anonymous-options">
          ${adminAnonymousOptions.map((number) => `<option value="${number}">Anonymous ${number}</option>`).join("")}
        </datalist>
      ` : ""}
    </div>
    ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ""}
    ${renderAuthModal()}
  `;
  bindAutopostCountdown();
  bindEvents();
}

function handleNotificationOutsideClick(event) {
  if (!state.notificationsOpen) return;
  if (event.target?.closest?.(".notification-wrap")) return;
  state.notificationsOpen = false;
  render();
}

function bindEvents() {
  if (!notificationOutsideClickBound) {
    notificationOutsideClickBound = true;
    document.addEventListener("click", handleNotificationOutsideClick);
  }
  document.querySelectorAll("[data-board]").forEach((button) => {
    button.addEventListener("click", () => {
      state.board = button.dataset.board || "all";
      saveState();
      render();
    });
  });

  document.querySelector("#board-filter")?.addEventListener("change", (event) => {
    state.board = String(event.target.value || "all");
    saveState();
    render();
  });

  document.querySelector("#search-input")?.addEventListener("input", (event) => {
    const cursorStart = event.target.selectionStart;
    const cursorEnd = event.target.selectionEnd;
    state.search = String(event.target.value || "");
    saveState();
    render();
    const searchInput = document.querySelector("#search-input");
    searchInput?.focus();
    if (searchInput && cursorStart !== null && cursorEnd !== null) {
      searchInput.setSelectionRange(cursorStart, cursorEnd);
    }
  });

  document.querySelector("#sort-filter")?.addEventListener("change", (event) => {
    state.sort = String(event.target.value || "recent") === "trending" ? "trending" : "recent";
    saveState();
    render();
  });

  document.querySelector("#composer-board")?.addEventListener("change", (event) => {
    state.composerBoard = String(event.target.value || "school");
    saveState();
  });
  document.querySelector("#composer-title")?.addEventListener("input", (event) => {
    state.composerTitle = String(event.target.value || "");
    saveState();
  });
  document.querySelector("#composer-body")?.addEventListener("input", (event) => {
    state.composerBody = String(event.target.value || "");
    saveState();
  });
  document.querySelector("#composer-anonymous-number")?.addEventListener("input", (event) => {
    state.composerAnonymousNumber = String(event.target.value || "");
    saveState();
  });
  document.querySelector("#composer-photo")?.addEventListener("change", (event) => {
    composerPhotoFiles = [...(event.target.files || [])];
    const note = document.querySelector("#composer-photo-note");
    if (note) note.textContent = selectedPhotoSummary(composerPhotoFiles, "No photos selected");
  });
  document.querySelector("#autopost-category")?.addEventListener("change", (event) => {
    if (!state.autopostJob) return;
    state.autopostJob.category = String(event.target.value || "school");
    markAutopostDirty();
    render();
  });
  document.querySelector("#autopost-min-delay")?.addEventListener("input", (event) => {
    if (!state.autopostJob) return;
    state.autopostJob.minDelayMinutes = Math.max(1, Number(event.target.value || 60));
    markAutopostDirty();
  });
  document.querySelector("#autopost-max-delay")?.addEventListener("input", (event) => {
    if (!state.autopostJob) return;
    state.autopostJob.maxDelayMinutes = Math.max(1, Number(event.target.value || 360));
    markAutopostDirty();
  });
  document.querySelectorAll("[data-autopost-category]").forEach((input) => {
    input.addEventListener("change", (event) => {
      if (!state.autopostJob) return;
      const entryId = String(event.target.dataset.autopostCategory || "");
      const entry = (state.autopostJob.entries || []).find((item) => item.id === entryId);
      if (!entry || entry.postedAt) return;
      entry.category = String(event.target.value || state.autopostJob.category || "school").trim().toLowerCase() || "school";
      markAutopostDirty();
      render();
    });
  });
  document.querySelectorAll("[data-autopost-title]").forEach((input) => {
    input.addEventListener("input", (event) => {
      if (!state.autopostJob) return;
      const entryId = String(event.target.dataset.autopostTitle || "");
      const entry = (state.autopostJob.entries || []).find((item) => item.id === entryId);
      if (!entry || entry.postedAt) return;
      entry.title = String(event.target.value || "");
      markAutopostDirty();
    });
  });
  document.querySelectorAll("[data-autopost-text]").forEach((input) => {
    input.addEventListener("input", (event) => {
      if (!state.autopostJob) return;
      const entryId = String(event.target.dataset.autopostText || "");
      const entry = (state.autopostJob.entries || []).find((item) => item.id === entryId);
      if (!entry || entry.postedAt) return;
      entry.text = String(event.target.value || "");
      markAutopostDirty();
    });
  });
  document.querySelectorAll("[data-autopost-anonymous-number]").forEach((input) => {
    input.addEventListener("input", (event) => {
      if (!state.autopostJob) return;
      const entryId = String(event.target.dataset.autopostAnonymousNumber || "");
      const entry = (state.autopostJob.entries || []).find((item) => item.id === entryId);
      if (!entry || entry.postedAt) return;
      const raw = String(event.target.value || "").trim();
      entry.requestedAnonymousNumber = raw || null;
      markAutopostDirty();
    });
  });
  document.querySelectorAll("[data-autopost-photo]").forEach((input) => {
    input.addEventListener("change", (event) => {
      const entryId = String(event.target.dataset.autopostPhoto || "");
      autopostPhotoFilesByEntryId.set(entryId, [...(event.target.files || [])]);
      const entry = (state.autopostJob?.entries || []).find((item) => item.id === entryId);
      const note = document.getElementById(`autopost-photo-note-${entryId}`);
      if (note && entry) note.textContent = autopostEntryPhotoSummary(entry);
      markAutopostDirty();
    });
  });
  document.querySelector("#composer-quote-search")?.addEventListener("input", (event) => {
    const cursorStart = event.target.selectionStart;
    const cursorEnd = event.target.selectionEnd;
    state.composerQuoteSearch = String(event.target.value || "");
    saveState();
    render();
    const searchInput = document.querySelector("#composer-quote-search");
    searchInput?.focus();
    if (searchInput && cursorStart !== null && cursorEnd !== null) {
      searchInput.setSelectionRange(cursorStart, cursorEnd);
    }
  });
  document.querySelector("#thread-form")?.addEventListener("submit", submitThread);
  document.querySelectorAll("[data-reply-form]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await submitReply(form.getAttribute("data-reply-form") || "");
    });
  });
  document.querySelectorAll(".reply-input").forEach((input) => {
    input.addEventListener("input", (event) => {
      const id = String(event.target.id || "").replace(/^reply-/, "");
      state.replyDrafts[id] = String(event.target.value || "");
      saveState();
    });
  });
  document.querySelectorAll("[id^='reply-anonymous-number-']").forEach((input) => {
    input.addEventListener("input", (event) => {
      const id = String(event.target.id || "").replace(/^reply-anonymous-number-/, "");
      state.replyAnonymousNumbers[id] = String(event.target.value || "");
      saveState();
    });
  });
  document.querySelectorAll("[id^='reply-photo-']").forEach((input) => {
    input.addEventListener("change", (event) => {
      const id = String(event.target.id || "").replace(/^reply-photo-/, "");
      replyPhotoFilesByPostId.set(id, [...(event.target.files || [])]);
      const note = document.getElementById(`reply-photo-note-${id}`);
      if (note) note.textContent = selectedPhotoSummary(replyPhotoFilesByPostId.get(id) || [], "No photos selected");
    });
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;
      const id = button.dataset.id || "";
      const commentId = button.dataset.commentId || "";
      if (action.startsWith("autopost-") && autopostBusy) return;
      if (action.startsWith("instagram-")) {
        if (instagramBusy || currentUser()?.role !== "admin") return;
        instagramBusy = true;
        button.disabled = true;
        try {
          if (action === "instagram-preview") {
            const post = state.posts.find(p => p.id === id);
            if (!post) throw new Error("Post is no longer loaded");
            const blob = await captureInstagramPost(post);
            if (instagramPreview) URL.revokeObjectURL(instagramPreview.url);
            instagramPreview = { postId: id, blob, url: URL.createObjectURL(blob), caption: `${boardMeta(post.category).slug} No.${post.postNumber}` };
          } else if (action === "instagram-dismiss") {
            if (instagramPreview) URL.revokeObjectURL(instagramPreview.url);
            instagramPreview = null;
          } else if (action === "instagram-add") {
            if (!instagramPreview) throw new Error("Preview a post first");
            const image = await uploadSinglePhoto(new File([instagramPreview.blob], `instagram-${crypto.randomUUID()}.jpg`, { type: "image/jpeg" }));
            instagramQueue = (await apiRequest("/admin/instagram/add", { method: "POST", body: { postId: instagramPreview.postId, imageUrl: image.url } })).queue;
            URL.revokeObjectURL(instagramPreview.url); instagramPreview = null;
            toast("Added to Instagram queue");
          } else if (action === "instagram-connect") {
            const result = await apiRequest("/admin/instagram/connect", { method: "POST" });
            window.location.assign(result.url);
            return;
          } else if (action === "instagram-refresh") {
            instagramQueue = (await apiRequest("/admin/instagram", { timeoutMs: 30000 })).queue;
          } else {
            const command = action.slice("instagram-".length);
            if (command === "start" && !window.confirm("Publish the selected screenshots to Instagram, one every 10 minutes? The first post will publish in 10 minutes.")) return;
            if (command === "resolve" && !window.confirm("Have you checked Instagram? This will archive the uncertain item without retrying it. If it was not published, you can queue the post again.")) return;
            instagramQueue = (await apiRequest(`/admin/instagram/${command}`, { method: "POST", body: { id } })).queue;
          }
          render();
          if (action === "instagram-preview") document.querySelector("#instagram-preview")?.scrollIntoView({ behavior: "smooth", block: "center" });
        } catch (error) { toast(error.message || "Instagram queue action failed"); }
        finally { instagramBusy = false; button.disabled = false; }
        return;
      }
      if (action === "open-auth") {
        openAuth("login");
        return;
      }
      if (action === "close-auth") {
        closeAuth();
        return;
      }
      if (action === "auth-back") {
        if (state.authStep === "password" && state.authMode === "register") state.authStep = "verify";
        else state.authStep = "email";
        saveState();
        render();
        return;
      }
      if (action === "logout") {
        await logout();
        return;
      }
      if (action === "enter-board") {
        const board = button.dataset.board || "all";
        state.board = boardByCategory.has(board) ? board : "all";
        state.authorFilter = "";
        saveState();
        render();
        document.querySelector("#boards")?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (action === "filter-author") {
        state.authorFilter = String(button.dataset.author || "").trim();
        state.board = "all";
        state.search = "";
        saveState();
        render();
        document.querySelector(".thread-controls")?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (action === "clear-author-filter") {
        state.authorFilter = "";
        saveState();
        render();
        return;
      }
      if (action === "toggle-notifications") {
        state.notificationsOpen = !state.notificationsOpen;
        if (state.notificationsOpen) await fetchNotifications();
        render();
        return;
      }
      if (action === "mark-notifications-read") {
        await markNotificationsRead();
        return;
      }
      if (action === "like-post") {
        await likePost(id);
        return;
      }
      if (action === "open-composer") {
        syncComposerBoardToCurrentDirectory();
        state.composerOpen = true;
        saveState();
        render();
        document.querySelector("#composer-title")?.focus();
        return;
      }
      if (action === "close-composer") {
        state.composerOpen = false;
        saveState();
        render();
        return;
      }
      if (action === "select-quote") {
        startPostQuote(quoteRefForPost(state.posts.find((post) => post.id === id)));
        return;
      }
      if (action === "clear-quote") {
        state.composerQuote = null;
        state.composerQuoteSearch = "";
        saveState();
        render();
        return;
      }
      if (action === "open-reply") {
        openReplyPostId = id;
        state.replyTargets[id] = "";
        saveState();
        render();
        document.querySelector(`#reply-${CSS.escape(id)}`)?.focus();
        return;
      }
      if (action === "open-comment-reply") {
        openReplyPostId = id;
        openReplies.add(id);
        state.replyTargets[id] = commentId;
        saveState();
        render();
        document.querySelector(`#reply-${CSS.escape(id)}`)?.focus();
        return;
      }
      if (action === "clear-reply-target") {
        state.replyTargets[id] = "";
        saveState();
        render();
        document.querySelector(`#reply-${CSS.escape(id)}`)?.focus();
        return;
      }
      if (action === "close-reply") {
        openReplyPostId = "";
        render();
        return;
      }
      if (action === "show-replies") {
        openReplies.add(id);
        render();
        return;
      }
      if (action === "hide-replies") {
        openReplies.delete(id);
        render();
        return;
      }
      if (action === "delete-post") {
        await deletePost(id);
        return;
      }
      if (action === "delete-comment") {
        await deleteComment(id, commentId);
        return;
      }
      if (action === "autopost-add-entry") {
        if (!state.autopostJob) return;
        const newEntryId = `apq_local_${crypto.randomUUID()}`;
        state.autopostJob.entries.push({
          id: newEntryId,
          category: state.autopostJob.category || "school",
          title: "",
          text: "",
          media: [],
          requestedAnonymousNumber: null,
          postedAt: "",
          postId: "",
          postNumber: null,
          anonymousNumber: null
        });
        autopostEntryIndex = state.autopostJob.entries.length - 1;
        markAutopostDirty();
        render();
        return;
      }
      if (action === "autopost-navigate") {
        const index = Number(button.dataset.index);
        const entries = state.autopostJob?.entries || [];
        if (!Number.isInteger(index) || index < 0 || index >= entries.length) return;
        autopostEntryIndex = index;
        render();
        return;
      }
      if (action === "autopost-load-defaults") {
        if (!state.autopostJob) return;
        const postedEntries = (state.autopostJob.entries || []).filter((entry) => entry.postedAt);
        const pendingEntries = (state.autopostJob.defaultEntries || []).map((entry, index) => ({
          id: `apq_local_${crypto.randomUUID()}`,
          category: entry.category || state.autopostJob.category || "school",
          title: entry.title || "",
          text: entry.text || "",
          media: Array.isArray(entry.media) ? [...entry.media] : [],
          requestedAnonymousNumber: entry.requestedAnonymousNumber == null || String(entry.requestedAnonymousNumber).trim() === "" ? null : Number(entry.requestedAnonymousNumber),
          postedAt: "",
          postId: "",
          postNumber: null,
          anonymousNumber: null
        }));
        state.autopostJob.entries = [...postedEntries, ...pendingEntries];
        autopostPhotoFilesByEntryId.clear();
        autopostEntryIndex = 0;
        markAutopostDirty();
        render();
        return;
      }
      if (action === "autopost-move-entry-up" || action === "autopost-move-entry-down") {
        if (!state.autopostJob) return;
        const entries = [...(state.autopostJob.entries || [])];
        const currentIndex = entries.findIndex((entry) => entry.id === id);
        if (currentIndex < 0) return;
        const targetIndex = action === "autopost-move-entry-up" ? currentIndex - 1 : currentIndex + 1;
        if (targetIndex < 0 || targetIndex >= entries.length || entries[currentIndex].postedAt || entries[targetIndex].postedAt) return;
        [entries[currentIndex], entries[targetIndex]] = [entries[targetIndex], entries[currentIndex]];
        state.autopostJob.entries = entries;
        autopostEntryIndex = targetIndex;
        markAutopostDirty();
        render();
        return;
      }
      if (action === "autopost-duplicate-entry") {
        if (!state.autopostJob) return;
        const entries = [...(state.autopostJob.entries || [])];
        const currentIndex = entries.findIndex((entry) => entry.id === id);
        if (currentIndex < 0) return;
        const source = entries[currentIndex];
        const cloneId = `apq_local_${crypto.randomUUID()}`;
        entries.splice(currentIndex + 1, 0, {
          ...source,
          id: cloneId,
          media: Array.isArray(source.media) ? [...source.media] : [],
          postedAt: "",
          postId: "",
          postNumber: null,
          anonymousNumber: null
        });
        const photos = autopostPhotoFilesByEntryId.get(source.id);
        if (photos?.length) autopostPhotoFilesByEntryId.set(cloneId, [...photos]);
        state.autopostJob.entries = entries;
        autopostEntryIndex = currentIndex + 1;
        markAutopostDirty();
        render();
        return;
      }
      if (action === "autopost-clear-entry-media") {
        if (!state.autopostJob) return;
        const entry = (state.autopostJob.entries || []).find((item) => item.id === id);
        if (!entry || entry.postedAt) return;
        entry.media = [];
        autopostPhotoFilesByEntryId.delete(id);
        const input = document.querySelector(`#autopost-photo-${CSS.escape(id)}`);
        if (input) input.value = "";
        markAutopostDirty();
        render();
        return;
      }
      if (action === "autopost-remove-entry") {
        if (!state.autopostJob || state.autopostJob.entries.find((entry) => entry.id === id)?.postedAt) return;
        state.autopostJob.entries = (state.autopostJob.entries || []).filter((entry) => entry.id !== id);
        autopostPhotoFilesByEntryId.delete(id);
        autopostEntryIndex = Math.min(autopostEntryIndex, Math.max(0, state.autopostJob.entries.length - 1));
        markAutopostDirty();
        render();
        return;
      }
      if (["autopost-reload", "autopost-save", "autopost-start", "autopost-pause", "autopost-reset"].includes(action)) {
        if (action !== "autopost-reload" && !state.autopostJob) return;
        autopostBusy = true;
        autopostError = "";
        render();
        try {
          if (action === "autopost-reload") {
            await fetchAutopostJob();
          } else if (action === "autopost-save") {
            await saveAutopostJobDraft();
            toast("Queue saved");
          } else {
            if (action === "autopost-start" && state.autopostJob.entries.some((entry) =>
              !entry.postedAt && !String(entry.title || "").trim() && !String(entry.text || "").trim()
              && !entry.media.length && !autopostEntryHasQueuedPhotos(entry.id))) {
              throw new Error("Complete or remove empty drafts before starting the countdown.");
            }
            // Save before changing execution state so a response cannot erase local edits.
            if (state.autopostDirty) await saveAutopostJobDraft();
            const path = `/admin/autopost/${action.replace("autopost-", "")}`;
            const result = await apiRequest(path, { method: "POST", body: {}, timeoutMs: 30000 });
            applyAutopostJob(result.job);
            state.autopostDirty = false;
            toast(action === "autopost-start" ? "Countdown started" : action === "autopost-pause" ? "Queue paused" : "Queue reset");
          }
        } catch (error) {
          autopostError = error.name === "TimeoutError"
            ? "The request timed out. Your drafts are still here; retry saving."
            : error.message || "Could not update queue";
          toast(autopostError);
        } finally {
          autopostBusy = false;
          render();
        }
        return;
      }
    });
  });

  document.querySelector("#auth-email-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const intent = event.submitter?.dataset.authIntent || "login";
    await handleEmailIntent(intent);
  });

  document.querySelector("#auth-verify-form")?.addEventListener("submit", submitVerifyCode);
  document.querySelector("#auth-password-form")?.addEventListener("submit", submitPassword);
  document.querySelector("#auth-profile-form")?.addEventListener("submit", submitProfile);
  document.querySelector("#auth-modal")?.addEventListener("click", (event) => {
    if (event.target?.id === "auth-modal" && !authBusy) closeAuth();
  });
}

async function initialize() {
  window.addEventListener("beforeunload", (event) => {
    if (!hasUnsavedBoardChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  await fetchCurrentUser();
  await fetchPosts();
  await fetchNotifications();
  await fetchAutopostJob();
  saveState();
  render();
}

initialize().catch((error) => {
  console.error("Board bootstrap failed", error);
  document.querySelector("#app").innerHTML = `
    <div class="page">
      <div class="empty-state">The board could not load right now. ${escapeHtml(error.message || "Please try again.")}</div>
    </div>
  `;
});
