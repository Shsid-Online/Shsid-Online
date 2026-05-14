const STORAGE_KEY = "shsid-social-state-v2";
const LOGIN_MEDIA_CACHE_KEY = "shsid-login-media-cache-v1";
const LOGIN_MEDIA_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const API_BASE = window.SHSID_API_BASE || (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost" ? "http://127.0.0.1:4174/api" : "https://www.shsid.online/api");
const CONTENT_CATEGORIES = ["school", "lifestyle", "gaming", "academic", "shitpost"];

const initialState = {
  currentUserId: null,
  authStep: "email",
  authMode: "login",
  users: [],
  posts: [],
  conversations: [],
  reports: [],
  bans: [],
  qna: [],
  suggestions: [],
  ads: [],
  notifications: [],
  audit: [],
  adminVerifications: [],
  verificationQueue: { pendingTotal: 0, ahead: 0, position: 0 },
  apiToken: null,
  pendingEmail: "",
  pendingCode: "",
  pendingVideoName: "",
  pendingEnglishName: "",
  pendingChineseName: "",
  pendingGrade: 10,
  pendingClassNo: 1,
  pendingProfilePhoto: "",
  pendingVerificationWords: [],
  selectedProfileId: null,
  conversationIdentityMode: {},
  acceptedRequests: {},
  rejectedRequests: {},
  contactRemarks: {},
  feedSearchQuery: "",
  feedEngagementFilter: "all",
  adSwapCount: 0,
  nextAdPopupAt: 6,
  adLastPopupAt: 0
};

let state = loadState();
let view = "feed";
let activeConversationId = "";
let authEmailSubmitIntent = "login";
let authRequestInFlight = false;
let resendCooldownUntil = 0;
let openCommentPostId = null;
let openReplyCommentKey = null;
let postsNextOffset = null;
let deepLinkedPostId = "";
let conversationTab = "inbox";
let adminChatMonitorFilter = "all";
let adminActiveConversationId = "";
let adminTab = "overview";
let profileBackView = "students";
let expandedNotificationId = "";
let isBootstrappingSession = false;
let liveChatTimer = null;
let liveChatPollInFlight = false;
let liveChatSnapshot = "";
let verificationQueueTimer = null;
let verificationQueuePollInFlight = false;
let uploadUi = { active: false, label: "", percent: 0 };
let uploadTargetPercent = 0;
let uploadProgressTimer = null;
let uploadCompleting = false;
let postPublishInFlight = false;

function stopLiveChatLoop() {
  if (liveChatTimer) {
    clearInterval(liveChatTimer);
    liveChatTimer = null;
  }
}

function stopVerificationQueueLoop() {
  if (verificationQueueTimer) {
    clearInterval(verificationQueueTimer);
    verificationQueueTimer = null;
  }
}

function stopUploadProgressTicker() {
  if (!uploadProgressTimer) return;
  clearInterval(uploadProgressTimer);
  uploadProgressTimer = null;
}
let loadMorePostsInFlight = false;
let startChatInFlight = false;
let suggestionSubmitInFlight = false;
let suggestionReplyInFlight = false;
let markReadInFlight = false;
let createAdInFlight = false;
let toggleAdInFlight = false;
let deleteAdInFlight = false;
let verifyUserInFlight = false;
let rejectUserInFlight = false;
let banUserInFlight = false;
let handleReportInFlight = false;
let modalLockedScrollY = 0;
const postMediaIndexByPostId = {};
let feedVideoObserver = null;
const feedVideoVisibility = new Map();
let feedVideoPlaybackTickScheduled = false;
let feedVideoManualControlVideo = null;
let feedVideoManualControlUntil = 0;
let feedVideoViewportListenersBound = false;
let feedVideoCurrentAutoplay = null;
let feedVideoLastSwitchAt = 0;
let feedVideoSeekingVideo = null;
let feedVideoSeekingUntil = 0;
let feedVideoVisibilityListenerBound = false;
const feedVideoUserPaused = new Set();
const feedVideoProgrammaticPause = new Set();
const feedVideoControlsBound = new Set();
const preloadedMediaUrls = new Set();
const loadedMediaUrls = new Set();
const MEDIA_URL_MAX = 200;
const inputFileStore = {};
const inputFileSyncLock = new Set();
let feedAheadPrefetchInFlight = false;
let categoryPrefetchInFlight = false;
let feedCategoryWarmDone = false;
const prefetchedCategoryPosts = Object.fromEntries(CONTENT_CATEGORIES.map((category) => [category, []]));
const CATEGORY_POSTS_MAX = 50;
const API_CACHE_TTL = {
  posts: 20_000,
  students: 60_000,
  conversations: 8_000,
  notifications: 10_000,
  suggestions: 20_000,
  ads: 120_000,
  qna: 20_000,
  admin: 15_000,
  verificationQueue: 5_000
};
const apiResponseCache = new Map();
const API_CACHE_MAX_SIZE = 100;
let saveStateTimer = null;

function clearApiCache() {
  apiResponseCache.clear();
}

function evictApiCache() {
  if (apiResponseCache.size <= API_CACHE_MAX_SIZE) return;
  const entries = [...apiResponseCache.entries()];
  entries.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  const toRemove = entries.slice(0, Math.floor(API_CACHE_MAX_SIZE * 0.3));
  toRemove.forEach(([key]) => apiResponseCache.delete(key));
}

hydrateAuthFromUrl();

const navItems = [
  ["feed", "&#128247;", "Feed"],
  ["post", "+", "Post"],
  ["students", "&#128269;", "Students"],
  ["messages", "&#128172;", "Messages"],
  ["suggestions", "?", "Suggestions"],
  ["profile", "PR", "Profile"],
  ["admin", "&#128100;", "Admin"]
];

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return structuredClone(initialState);
  try {
    const merged = { ...structuredClone(initialState), ...JSON.parse(saved) };
    if (!Number.isInteger(merged.adSwapCount) || merged.adSwapCount < 0) merged.adSwapCount = 0;
    if (!Number.isInteger(merged.nextAdPopupAt) || merged.nextAdPopupAt < 6 || merged.nextAdPopupAt > 7) merged.nextAdPopupAt = 6;
    if (!Number.isFinite(Number(merged.adLastPopupAt))) merged.adLastPopupAt = 0;
    return merged;
  } catch {
    return structuredClone(initialState);
  }
}

function flushStateToStorage() {
  if (saveStateTimer) {
    clearTimeout(saveStateTimer);
    saveStateTimer = null;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function saveState({ immediate = false } = {}) {
  if (immediate) {
    flushStateToStorage();
    return;
  }
  if (saveStateTimer) return;
  saveStateTimer = setTimeout(() => {
    saveStateTimer = null;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, 120);
}

window.addEventListener("beforeunload", () => {
  try {
    flushStateToStorage();
  } catch {
    // Ignore teardown storage errors.
  }
});

function loadLoginMediaCache() {
  try {
    const raw = localStorage.getItem(LOGIN_MEDIA_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const nowMs = Date.now();
    const cleaned = {};
    for (const [key, value] of Object.entries(parsed)) {
      const userId = String(key || "").trim();
      if (!userId) continue;
      const updatedAt = Number(value?.updatedAt || 0);
      if (!Number.isFinite(updatedAt) || nowMs - updatedAt > LOGIN_MEDIA_CACHE_MAX_AGE_MS) continue;
      const itemsRaw = Array.isArray(value?.items) ? value.items : [];
      const items = itemsRaw
        .map((item) => ({
          url: String(item?.url || "").trim(),
          type: String(item?.type || "").trim().toLowerCase()
        }))
        .filter((item) => item.url && item.type && (item.type.startsWith("video/") || item.type.startsWith("image/")))
        .slice(0, 14);
      if (!items.length) continue;
      cleaned[userId] = { updatedAt, items };
    }
    return cleaned;
  } catch {
    return {};
  }
}

function saveLoginMediaCache(cache) {
  try {
    localStorage.setItem(LOGIN_MEDIA_CACHE_KEY, JSON.stringify(cache || {}));
  } catch {
    // Ignore storage quota or serialization failures.
  }
}

function warmCachedLoginMedia(userId) {
  const key = String(userId || "").trim();
  if (!key) return;
  const cache = loadLoginMediaCache();
  const entry = cache[key];
  const items = Array.isArray(entry?.items) ? entry.items : [];
  items.forEach((item) => preloadMediaByType(item?.url, item?.type || ""));
}

function rememberLoginMediaForUser(userId) {
  const key = String(userId || "").trim();
  if (!key) return;
  const seen = new Set();
  const items = [];
  for (const post of state.posts || []) {
    for (const media of post?.media || []) {
      if (!media || typeof media === "string") continue;
      const url = String(media.url || "").trim();
      const type = String(media.type || "").trim();
      if (!url) continue;
      if (!type.startsWith("video/") && !type.startsWith("image/")) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      items.push({ url, type });
      if (items.length >= 14) break;
    }
    if (items.length >= 14) break;
  }
  if (!items.length) return;
  const cache = loadLoginMediaCache();
  const nextSignature = JSON.stringify(items);
  const previousSignature = JSON.stringify(Array.isArray(cache[key]?.items) ? cache[key].items : []);
  if (nextSignature === previousSignature) {
    cache[key] = { ...(cache[key] || {}), updatedAt: Date.now(), items };
    saveLoginMediaCache(cache);
    return;
  }
  cache[key] = { updatedAt: Date.now(), items };
  const keys = Object.keys(cache);
  if (keys.length > 6) {
    keys
      .sort((a, b) => Number(cache[b]?.updatedAt || 0) - Number(cache[a]?.updatedAt || 0))
      .slice(6)
      .forEach((staleKey) => delete cache[staleKey]);
  }
  saveLoginMediaCache(cache);
}

function hydrateAuthFromUrl() {
  try {
    const url = new URL(window.location.href);
    const email = (url.searchParams.get("email") || "").trim().toLowerCase();
    const code = (url.searchParams.get("code") || url.searchParams.get("oobCode") || "").trim();
    const mode = (url.searchParams.get("mode") || "").trim().toLowerCase();

    let changed = false;

    if (email && !state.pendingEmail) {
      state.pendingEmail = email;
      changed = true;
    }

    if (code && !state.pendingCode) {
      state.pendingCode = code;
      changed = true;
    }

    if ((mode === "verify" || mode === "register") && (email || code)) {
      state.authMode = "register";
      state.authStep = "verify";
      changed = true;
    }
    const postId = (url.searchParams.get("post") || "").trim();
    if (postId) {
      deepLinkedPostId = postId;
      view = "single-post";
    }

    if (changed) saveState();

    if (email || code || mode) {
      url.searchParams.delete("email");
      url.searchParams.delete("code");
      url.searchParams.delete("oobCode");
      url.searchParams.delete("mode");
      window.history.replaceState({}, "", url.toString());
    }
  } catch {
    // Ignore URL parsing issues.
  }
}

function nextAuthStepForUser(user) {
  if (user.role === "admin") return "app";
  if (!user.englishName || !user.chineseName || !user.grade || !user.classNo) return "profile";
  if (!user.verificationVideo) return "video";
  if (user.status !== "verified" && user.role !== "admin") return "waiting";
  return "app";
}

function uid(prefix) {
  return `${prefix}${Math.random().toString(36).slice(2, 9)}`;
}

function generateVerificationWords(count = 10) {
  const pool = [
    "river", "amber", "planet", "notebook", "silver", "window", "forest", "violet", "pencil", "dragon",
    "market", "candle", "bridge", "pebble", "ocean", "ladder", "thunder", "orbit", "camera", "sunset",
    "meadow", "rocket", "blanket", "marble", "castle", "butter", "galaxy", "harbor", "scooter", "lantern"
  ];
  const picked = [];
  const used = new Set();
  while (picked.length < count && used.size < pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    if (used.has(idx)) continue;
    used.add(idx);
    picked.push(pool[idx]);
  }
  return picked;
}

function currentUser() {
  return state.users.find((user) => user.id === state.currentUserId);
}

function clearAuthDraftState() {
  state.pendingEmail = "";
  state.pendingCode = "";
  state.pendingVideoName = "";
  state.pendingProfilePhoto = "";
  state.pendingVerificationWords = [];
  state.selectedProfileId = null;
}

function resetClientSessionState() {
  state.apiToken = null;
  state.currentUserId = null;
  clearApiCache();
  clearAuthDraftState();
  state.authMode = "login";
  state.authStep = "email";
  state.deletedChats = {};
  state.acceptedRequests = {};
  state.rejectedRequests = {};
  state.users = [];
  state.posts = [];
  state.conversations = [];
  state.notifications = [];
  state.suggestions = [];
  state.reports = [];
  state.auditLogs = [];
  state.adminVerifications = [];
  state.qna = [];
  state.ads = [];
  state.selectedProfileId = null;
  profileBackView = "students";
  deepLinkedPostId = "";
  openCommentPostId = null;
  openReplyCommentKey = null;
  adminTab = "overview";
  adminChatMonitorFilter = "all";
  adminActiveConversationId = "";
  activeConversationId = "";
  conversationTab = "inbox";
  inputFileStore["message-media-file"] = [];
  inputFileStore["message-doc-file"] = [];
  inputFileStore["post-media"] = [];
  stopLiveChatLoop();
  stopVerificationQueueLoop();
  clearUploadProgress({ immediate: true });
}

function setAuthInFlight(isBusy) {
  authRequestInFlight = isBusy;
  document.querySelectorAll("#auth-email-form button, #auth-verify-form button, #auth-password-form button, #auth-profile-form button, #auth-video-form button").forEach((button) => {
    button.disabled = isBusy;
  });
}

async function apiRequest(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const cacheTtlMs = Number(options.cacheTtlMs || 0);
  const cacheForce = Boolean(options.cacheForce);
  const cacheKey = `${state.currentUserId || "anon"}::${path}`;
  const useCache = method === "GET" && cacheTtlMs > 0;
  const nowMs = Date.now();
  if (useCache && !cacheForce) {
    const cached = apiResponseCache.get(cacheKey);
    if (cached && cached.expiresAt > nowMs) {
      if (cached.data) return cached.data;
      if (cached.promise) return cached.promise;
    }
  }
  const requestOptions = {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(state.apiToken ? { authorization: `Bearer ${state.apiToken}` } : {}),
      ...(options.headers || {})
    }
  };
  delete requestOptions.cacheTtlMs;
  delete requestOptions.cacheForce;
  const fetchPromise = (async () => {
    const response = await fetch(`${API_BASE}${path}`, requestOptions);
    const raw = await response.text();
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { detail: raw || "" };
    }
    if (!response.ok) {
      const message = [body.error, body.detail].filter(Boolean).join(": ");
      const error = new Error(message || "Request failed");
      error.status = response.status;
      throw error;
    }
    return body;
  })();
  if (useCache) {
    apiResponseCache.set(cacheKey, { promise: fetchPromise, data: null, expiresAt: nowMs + cacheTtlMs });
  }
  let result;
  try {
    result = await fetchPromise;
  } catch (error) {
    if (useCache) apiResponseCache.delete(cacheKey);
    throw error;
  }
  if (method !== "GET") {
    apiResponseCache.clear();
  } else if (useCache) {
    apiResponseCache.set(cacheKey, { promise: null, data: result, expiresAt: Date.now() + cacheTtlMs });
  }
  return result;
}

function at(ts) {
  if (ts == null) return Date.now();
  if (typeof ts === "number") return ts;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}

function normalizePost(post) {
  if (!post) return post;
  const copy = { ...post };
  copy.createdAt = at(copy.createdAt);
  copy.likes = Array.isArray(copy.likes) ? copy.likes : [];
  copy.hearts = Array.isArray(copy.hearts) ? copy.hearts : [];
  copy.savedBy = Array.isArray(copy.savedBy) ? copy.savedBy : [];
  copy.media = Array.isArray(copy.media) ? copy.media : [];
  copy.comments = (copy.comments || []).map((comment) => ({
    ...comment,
    createdAt: at(comment.createdAt),
    likes: Array.isArray(comment.likes) ? comment.likes : []
  }));
  delete copy.author;
  delete copy.adminAuthor;
  return copy;
}

function nextAdPopupThreshold() {
  return 6 + Math.floor(Math.random() * 2);
}

function activeAdsBySlot(slot) {
  return (state.ads || []).filter((ad) => ad?.slot === slot && ad?.active);
}

function renderAdCard(slot, fallback = "Ad placeholder", { showPlaceholder = true } = {}) {
  const ad = activeAdsBySlot(slot)[0];
  if (!ad) {
    if (!showPlaceholder) return "";
    return `<article class="panel ad-card ad-placeholder"><strong>${escapeHtml(fallback)}</strong><p class="muted">Ad space</p></article>`;
  }
  const title = String(ad.title || "Sponsored");
  const body = String(ad.body || "");
  const url = safeExternalUrl(ad.url || "");
  const imageUrl = safeExternalUrl(ad.imageUrl || "");
  const media = imageUrl ? `<div class="ad-media-wrap"><img class="ad-media" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}" loading="lazy" /></div>` : "";
  const inner = `${media}<strong>${escapeHtml(title)}</strong><p class="muted">${escapeHtml(body)}</p>`;
  return url
    ? `<a class="panel ad-card" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<article class="panel ad-card">${inner}</article>`;
}

function safeExternalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw, window.location.origin);
    const protocol = String(parsed.protocol || "").toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function normalizeConversation(conversation) {
  if (!conversation) return conversation;
  const copy = { ...conversation };
  copy.messages = (copy.messages || []).map((message) => ({
    ...message,
    text: String(message?.text || ""),
    media: Array.isArray(message?.media) ? message.media : [],
    createdAt: at(message?.createdAt)
  }));
  return copy;
}

function classifyConversations() {
  const meId = currentUser()?.id;
  const all = (state.conversations || []).filter((conv) => {
    const members = Array.isArray(conv?.members) ? conv.members : [];
    return !meId || members.includes(meId);
  });
  if (!state.acceptedRequests || typeof state.acceptedRequests !== "object") state.acceptedRequests = {};
  if (!state.rejectedRequests || typeof state.rejectedRequests !== "object") state.rejectedRequests = {};
  const inbox = [];
  const requestsReceived = [];
  const requestsSent = [];
  for (const conv of all) {
    if (state.deletedChats?.[conv.id]) continue;
    if (state.rejectedRequests?.[conv.id]) continue;
    const firstMessage = (conv.messages || [])[0];
    if (!firstMessage) {
      inbox.push(conv);
      continue;
    }
    const acceptedByLocal = Boolean(state.acceptedRequests?.[conv.id]);
    const acceptedByReply = Boolean(firstMessage && (conv.messages || []).some((message) => message.authorId && message.authorId !== firstMessage.authorId));
    const accepted = acceptedByLocal || acceptedByReply;
    if (accepted) inbox.push(conv);
    else {
      const isSender = firstMessage && firstMessage.authorId === meId;
      if (isSender) requestsSent.push(conv);
      else requestsReceived.push(conv);
    }
  }
  return { inbox, requests: requestsReceived, requestsSent };
}

function getConversationIdentityMode(conversationId) {
  return state.conversationIdentityMode?.[conversationId] === "anonymous" ? "anonymous" : "public";
}

function setConversationIdentityMode(conversationId, mode) {
  if (!conversationId) return;
  if (!state.conversationIdentityMode || typeof state.conversationIdentityMode !== "object") state.conversationIdentityMode = {};
  state.conversationIdentityMode[conversationId] = mode === "anonymous" ? "anonymous" : "public";
  saveState();
}

function getRemarkForUser(userId) {
  return String(state.contactRemarks?.[userId] || "").trim();
}

function shouldHideCounterpartIdentity(conversation) {
  const me = currentUser();
  if (!conversation || !me || me.role === "admin") return false;
  const members = Array.isArray(conversation.members) ? conversation.members : [];
  if (members.length !== 2) return false;
  return (conversation.messages || []).some((message) => message.authorId && message.authorId !== me.id && Boolean(message.anonymous));
}

function setRemarkForUser(userId, remark) {
  if (!userId) return;
  if (!state.contactRemarks || typeof state.contactRemarks !== "object") state.contactRemarks = {};
  const clean = String(remark || "").trim().slice(0, 60);
  if (!clean) delete state.contactRemarks[userId];
  else state.contactRemarks[userId] = clean;
  saveState();
}

function conversationCounterpartName(conversation) {
  const me = currentUser();
  if (!conversation || !me) return "Unknown";
  if (conversation.group) return conversation.title || "Group chat";
  if (shouldHideCounterpartIdentity(conversation)) return "Anonymous student";
  const members = Array.isArray(conversation.members) ? conversation.members : [];
  const otherId = members.find((id) => id !== me.id);
  const baseName = otherId ? userName(otherId) : (conversation.title || "Direct message");
  const remark = otherId ? getRemarkForUser(otherId) : "";
  if (getConversationIdentityMode(conversation.id) === "anonymous") return baseName;
  return remark ? `${remark} (${baseName})` : baseName;
}

function participantIdentityMode(conversation, userId) {
  const mine = (conversation?.messages || []).filter((message) => message.authorId === userId);
  if (!mine.length) return "public";
  const last = mine[mine.length - 1];
  return last.anonymous ? "anon" : "public";
}

function directConversationTitle(conversation) {
  const members = Array.isArray(conversation?.members) ? conversation.members : [];
  if (members.length < 2) return conversation?.title || "Direct message";
  const [a, b] = members.slice(0, 2);
  const nameA = userName(a);
  const nameB = userName(b);
  const modeA = participantIdentityMode(conversation, a);
  const modeB = participantIdentityMode(conversation, b);
  if (modeA === "public" && modeB === "public") return `${nameA} and ${nameB}`;
  return `${nameA}(${modeA})->${nameB}(${modeB})`;
}

function conversationDisplayTitle(conversation, forAdmin = false) {
  if (!conversation) return "Conversation";
  if (conversation.group) return conversation.title || "Group chat";
  if (forAdmin) return directConversationTitle(conversation);
  const base = conversationCounterpartName(conversation);
  const status = getConversationIdentityMode(conversation.id) === "anonymous" ? "anon" : "public";
  return status === "anonymous" || status === "anon" ? `Anonymous message to ${base}` : base;
}

async function ensureDeepLinkedPostLoaded() {
  if (!deepLinkedPostId || !state.apiToken) return;
  if (state.posts.some((post) => post.id === deepLinkedPostId)) return;
  try {
    const result = await apiRequest(`/posts/${encodeURIComponent(deepLinkedPostId)}`);
    if (result?.post) {
      state.posts = [normalizePost(result.post), ...state.posts.filter((post) => post.id !== result.post.id)];
      saveState();
    }
  } catch (error) {
    console.error("ensureDeepLinkedPostLoaded failed", error);
  }
}

async function fetchPostsPage({ offset = 0, limit = 10, category = "" } = {}) {
  const query = new URLSearchParams();
  query.set("limit", String(limit));
  query.set("offset", String(Math.max(0, Number(offset) || 0)));
  if (category) query.set("category", String(category).trim().toLowerCase());
  const result = await apiRequest(`/posts?${query.toString()}`, { cacheTtlMs: API_CACHE_TTL.posts });
  return {
    posts: (result.posts || []).map(normalizePost),
    pagination: result.pagination || {}
  };
}

async function warmCategoryPools() {
  if (!state.apiToken || categoryPrefetchInFlight) return;
  categoryPrefetchInFlight = true;
  try {
    if (!feedCategoryWarmDone) {
      await Promise.all(CONTENT_CATEGORIES.map(async (category) => {
        const { posts } = await fetchPostsPage({ category, limit: 10, offset: 0 });
        prefetchedCategoryPosts[category] = posts.slice(0, 10);
      }));
      feedCategoryWarmDone = true;
    }
  } catch (error) {
    console.error("warmCategoryPools failed", error);
  } finally {
    categoryPrefetchInFlight = false;
  }
}

async function ensurePostsAhead() {
  if (!state.apiToken || feedAheadPrefetchInFlight || postsNextOffset == null) return;
  const currentCount = (state.posts || []).length;
  if (currentCount >= 20) return;
  feedAheadPrefetchInFlight = true;
  try {
    while ((state.posts || []).length < 20 && postsNextOffset != null) {
      const { posts, pagination } = await fetchPostsPage({ offset: postsNextOffset, limit: 10 });
      state.posts = [...state.posts, ...posts];
      postsNextOffset = pagination.nextOffset ?? null;
    }
    saveState();
  } catch (error) {
    console.error("ensurePostsAhead failed", error);
  } finally {
    feedAheadPrefetchInFlight = false;
  }
}

async function refreshPosts(reset = true) {
  if (!state.apiToken) return;
  if (view === "feed" && reset) {
    resetFeedVideoState();
    pauseAllFeedVideos();
  }
  try {
    const offset = reset ? 0 : (postsNextOffset ?? 0);
    const { posts: next, pagination } = await fetchPostsPage({ offset, limit: 10 });
    if (reset) {
      state.posts = next;
    } else {
      const MAX_POSTS = 200;
      const existingIds = new Set(state.posts.map((p) => p.id));
      const newPosts = next.filter((p) => !existingIds.has(p.id));
      const combined = [...state.posts, ...newPosts];
      state.posts = combined.length > MAX_POSTS ? combined.slice(-MAX_POSTS) : combined;
    }
    postsNextOffset = pagination?.nextOffset ?? null;
    if (state.currentUserId) rememberLoginMediaForUser(state.currentUserId);
    warmUserAssetCache();
    saveState();
    void ensurePostsAhead();
    void warmCategoryPools();
  } catch (error) {
    console.error("refreshPosts failed", error);
  }
}

async function refreshConversations() {
  if (!state.apiToken) return false;
  try {
    const before = conversationsSnapshot();
    const result = await apiRequest("/conversations", { cacheTtlMs: API_CACHE_TTL.conversations });
    state.conversations = (result.conversations || []).map(normalizeConversation);
    if (!state.conversations.some((item) => item.id === activeConversationId)) activeConversationId = "";
    const after = conversationsSnapshot();
    if (after === before) return false;
    warmUserAssetCache();
    saveState();
    return true;
  } catch (error) {
    console.error("refreshConversations failed", error);
  }
  return false;
}

async function refreshReports() {
  if (!state.apiToken) return;
  const user = currentUser();
  if (!user || user.role !== "admin") return;
  try {
    const result = await apiRequest("/admin/reports", { cacheTtlMs: API_CACHE_TTL.admin });
    state.reports = (result.reports || []).map((report) => ({
      ...report,
      reporterId: report.reporterId || report.reporter_id,
      type: report.targetType || report.type,
      targetId: report.targetId || report.target_id
    }));
    saveState();
  } catch (error) {
    console.error("refreshReports failed", error);
  }
}

async function refreshAuditLogs() {
  if (!state.apiToken) return;
  const user = currentUser();
  if (!user || user.role !== "admin") return;
  try {
    const result = await apiRequest("/admin/audit-logs", { cacheTtlMs: API_CACHE_TTL.admin });
    state.audit = (result.auditLogs || []).map((entry) => ({
      ...entry,
      userId: entry.actorId || entry.userId,
      metadata: parseJsonObject(entry.metadata),
      createdAt: at(entry.createdAt)
    }));
    saveState();
  } catch (error) {
    console.error("refreshAuditLogs failed", error);
  }
}

async function refreshNotifications() {
  if (!state.apiToken) return;
  try {
    const result = await apiRequest("/notifications", { cacheTtlMs: API_CACHE_TTL.notifications });
    state.notifications = (result.notifications || []).map((item) => ({
      id: item.id,
      userId: item.userId,
      text: item.text,
      read: item.read,
      createdAt: at(item.createdAt)
    }));
    saveState();
  } catch (error) {
    console.error("refreshNotifications failed", error);
  }
}

async function refreshSuggestions() {
  if (!state.apiToken) return;
  try {
    const isAdmin = currentUser()?.role === "admin";
    let result;
    if (isAdmin) {
      try {
        result = await apiRequest("/admin/suggestions", { cacheTtlMs: API_CACHE_TTL.suggestions });
      } catch (error) {
        if (error?.status === 404 || String(error.message || "").toLowerCase().includes("not found")) {
          result = await apiRequest("/suggestions", { cacheTtlMs: API_CACHE_TTL.suggestions });
        } else {
          throw error;
        }
      }
    } else {
      result = await apiRequest("/suggestions", { cacheTtlMs: API_CACHE_TTL.suggestions });
    }
    if (result && Array.isArray(result.suggestions)) {
      state.suggestions = result.suggestions;
    } else {
      state.suggestions = [];
    }
    saveState();
  } catch (error) {
    console.error("refreshSuggestions failed", error);
    state.suggestions = [];
    saveState();
  }
}

async function refreshAds() {
  if (!state.apiToken) return;
  try {
    const result = await apiRequest("/ads", { cacheTtlMs: API_CACHE_TTL.ads });
    state.ads = Array.isArray(result.ads) ? result.ads : [];
    saveState();
  } catch (error) {
    console.error("refreshAds failed", error);
  }
}

async function refreshQnaForProfile(profileId) {
  if (!state.apiToken || !profileId) return;
  try {
    const result = await apiRequest(`/users/${profileId}/qna`, { cacheTtlMs: API_CACHE_TTL.qna });
    const rows = result.questions || [];
    state.qna = [...state.qna.filter((item) => item.profileId !== profileId), ...rows];
    saveState();
  } catch (error) {
    console.error("refreshQnaForProfile failed", error);
  }
}

function mergeApiUser(apiUser) {
  mergeApiUsers([apiUser]);
  state.currentUserId = apiUser.id;
}

function mergeApiUsers(apiUsers = []) {
  for (const apiUser of apiUsers) {
    const existing = state.users.find((user) => user.id === apiUser.id);
    const localUser = {
      id: apiUser.id,
      email: apiUser.email || "",
      password: "",
      role: apiUser.role,
      englishName: apiUser.englishName || "New Student",
      chineseName: apiUser.chineseName || "Pending",
      grade: apiUser.grade || 12,
      classNo: apiUser.classNo || 1,
      status: apiUser.status,
      bio: apiUser.bio || "",
      profilePhoto: apiUser.profilePhoto || "",
      followers: Array.isArray(apiUser.followers) ? apiUser.followers : (existing?.followers || []),
      following: Array.isArray(apiUser.following) ? apiUser.following : (existing?.following || []),
      followerCount: Number.isFinite(Number(apiUser.followerCount)) ? Number(apiUser.followerCount) : Number(existing?.followerCount || 0),
      followingCount: Number.isFinite(Number(apiUser.followingCount)) ? Number(apiUser.followingCount) : Number(existing?.followingCount || 0),
      online: true
    };
    const index = state.users.findIndex((user) => user.id === localUser.id);
    if (index >= 0) state.users[index] = { ...state.users[index], ...localUser };
    else state.users.push(localUser);
  }
}

async function bootstrapSession() {
  isBootstrappingSession = true;
  render();
  if (!state.apiToken) {
    isBootstrappingSession = false;
    render();
    return;
  }
  try {
    const result = await apiRequest("/me");
    mergeApiUser(result.user);
    warmCachedLoginMedia(result.user?.id);
    await refreshStudents();
    await refreshPosts();
    await ensureDeepLinkedPostLoaded();
    await refreshConversations();
    await refreshNotifications();
    await refreshAds();
    await refreshSuggestions();
    await refreshVerificationQueue();
    if (result.user.role === "admin") {
      await refreshAdminVerifications();
      await refreshReports();
      await refreshAuditLogs();
    }
    state.authStep = nextAuthStepForUser(result.user);
    saveState();
  } catch {
    state.apiToken = null;
    state.currentUserId = null;
    clearApiCache();
    clearAuthDraftState();
    state.authMode = "login";
    state.authStep = "email";
    saveState();
  } finally {
    isBootstrappingSession = false;
  }
  render();
}

async function refreshAdminVerifications() {
  if (!state.apiToken) return;
  const user = currentUser();
  if (!user || user.role !== "admin") return;
  try {
    const result = await apiRequest("/admin/verifications", { cacheTtlMs: API_CACHE_TTL.admin });
    state.adminVerifications = Array.isArray(result.students) ? result.students : [];
    saveState();
  } catch (error) {
    console.error("refreshAdminVerifications failed", error);
  }
}

async function refreshStudents() {
  if (!state.apiToken) return;
  try {
    const result = await apiRequest("/students", { cacheTtlMs: API_CACHE_TTL.students });
    const remoteStudents = Array.isArray(result.students) ? result.students : [];
    const remoteStudentIds = new Set(remoteStudents.map((item) => item?.id).filter(Boolean));
    state.users = state.users.filter((user) => user.role === "admin" || remoteStudentIds.has(user.id));
    mergeApiUsers(remoteStudents);
    warmUserAssetCache();
    saveState();
  } catch (error) {
    console.error("refreshStudents failed", error);
  }
}

function userName(id, anonymous = false) {
  if (anonymous) return "Anonymous";
  const user = state.users.find((item) => item.id === id);
  return user ? user.englishName : "Unknown";
}

function initials(user) {
  const name = String(user?.englishName || "").trim();
  if (!name) return "??";
  const parts = name.split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase() || "??";
  const first = parts[0][0] || "";
  const last = parts[parts.length - 1][0] || "";
  return `${first}${last}`.toUpperCase() || "??";
}

function renderAvatar(user, extraClass = "") {
  const cls = ["avatar", extraClass].filter(Boolean).join(" ");
  const photo = String(user?.profilePhoto || "").trim();
  if (photo) {
    return `<div class="${cls}"><img src="${escapeHtml(photo)}" alt="${escapeHtml(user?.englishName || "Profile")}" loading="lazy" /></div>`;
  }
  return `<div class="${cls}">${initials(user)}</div>`;
}

function timeAgo(ts) {
  const t = at(ts);
  const minutes = Math.max(1, Math.round((Date.now() - t) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function notificationTypeLabel(type) {
  const key = String(type || "").trim().toLowerCase();
  if (key === "post_like_private") return "Private Like";
  if (key === "post_heart_public") return "Heart";
  if (key === "post_comment") return "Comment";
  if (key === "message_new") return "Message";
  if (key === "verification") return "Verification";
  if (key === "moderation") return "Moderation";
  if (key === "qna") return "Q&A";
  return "Notification";
}

function notificationSummary(item) {
  const text = String(item?.text || "").trim();
  if (!text) return "You have a new update.";
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function notificationDetails(item) {
  const text = String(item?.text || "").trim();
  if (!text) return "No additional details available.";
  return text;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function formatActionLabel(action) {
  return String(action || "").replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function metadataTargetLabel(metadata = {}) {
  const m = metadata || {};
  if (m.userId) return `User ${userName(m.userId)}`;
  if (m.postId) return `Post ${m.postId}`;
  if (m.commentId) return `Comment ${m.commentId}`;
  if (m.storyId) return `Story ${m.storyId}`;
  if (m.conversationId) return `Conversation ${m.conversationId}`;
  if (m.reportId) return `Report ${m.reportId}`;
  return "System";
}

function metadataDetailsLabel(metadata = {}) {
  const entries = Object.entries(metadata || {}).filter(([key]) => !["userId", "postId", "commentId", "storyId", "conversationId", "reportId"].includes(key));
  if (!entries.length) return "No extra details";
  return entries.slice(0, 4).map(([key, value]) => `${key}: ${value}`).join(" | ");
}

function auditTargetHtml(item = {}) {
  const m = item.metadata || {};
  const postId = String(m.postId || "").trim();
  const commentId = String(m.commentId || "").trim();
  const conversationId = String(m.conversationId || "").trim();
  const reportId = String(m.reportId || "").trim();
  if (postId) {
    return `<button class="btn small" data-action="open-post-day" data-id="${escapeHtml(postId)}">Open Post</button><br><span class="muted">${escapeHtml(postId)}</span>`;
  }
  if (commentId) {
    return `Comment<br><span class="muted">${escapeHtml(commentId)}</span>`;
  }
  if (conversationId) {
    return `Conversation<br><span class="muted">${escapeHtml(conversationId)}</span>`;
  }
  if (reportId) {
    return `Report<br><span class="muted">${escapeHtml(reportId)}</span>`;
  }
  if (m.userId) return `User ${escapeHtml(userName(m.userId))}`;
  return "System";
}

function auditDetailsHtml(item = {}) {
  const m = item.metadata || {};
  const postId = String(m.postId || "").trim();
  const commentId = String(m.commentId || "").trim();
  const conversationId = String(m.conversationId || "").trim();
  if (postId) {
    const post = (state.posts || []).find((p) => p.id === postId);
    const postTitle = String(m.postTitle || post?.title || "").trim();
    const postText = String(m.postText || post?.text || "").trim();
    const lines = [];
    if (postTitle) lines.push(`Title: ${postTitle}`);
    if (postText) lines.push(`Text: ${postText.slice(0, 180)}`);
    lines.push(`Link: /?post=${postId}`);
    return `<span class="muted">${escapeHtml(lines.join(" | "))}</span>`;
  }
  if (commentId) {
    const commentText = String(m.commentText || "").trim();
    const lines = [];
    if (commentText) lines.push(`Comment: ${commentText.slice(0, 180)}`);
    if (postId) lines.push(`Post: ${postId} | Link: /?post=${postId}`);
    if (m.replyTo) lines.push(`Reply to: ${String(m.replyTo)}`);
    return `<span class="muted">${escapeHtml(lines.join(" | ") || metadataDetailsLabel(m))}</span>`;
  }
  if (conversationId) {
    const members = Array.isArray(m.members) ? m.members : [];
    const memberNames = members.map((id) => userName(id, false)).join(", ");
    const creatorName = m.createdBy ? userName(m.createdBy, false) : userName(item.userId, false);
    const title = String(m.title || "").trim();
    const lines = [];
    if (title) lines.push(`Title: ${title}`);
    if (memberNames) lines.push(`Participants: ${memberNames}`);
    if (creatorName) lines.push(`Created by: ${creatorName}`);
    return `<span class="muted">${escapeHtml(lines.join(" | ") || metadataDetailsLabel(m))}</span>`;
  }
  return `<span class="muted">${escapeHtml(metadataDetailsLabel(m))}</span>`;
}

function parseSuggestionStatus(status) {
  const raw = String(status || "").trim();
  if (raw.startsWith("responded::")) return { stage: "responded", response: raw.slice("responded::".length).trim() };
  if (raw === "resolved") return { stage: "responded", response: "" };
  return { stage: raw || "pending", response: "" };
}

function reportTargetHumanLabel(report = {}) {
  const type = String(report.type || "").toLowerCase();
  const targetId = String(report.targetId || "");
  if (type === "post") {
    const post = state.posts.find((item) => item.id === targetId);
    if (post) return `Post by ${userName(post.authorId, post.anonymous)}`;
    return "Post";
  }
  if (type === "conversation" || type === "chat") {
    const convo = state.conversations.find((item) => item.id === targetId);
    if (convo) return convo.group ? `Group chat: ${conversationDisplayTitle(convo, true)}` : `Direct chat: ${conversationDisplayTitle(convo, true)}`;
    return "Conversation";
  }
  if (type === "comment") {
    for (const post of state.posts || []) {
      const comment = (post.comments || []).find((item) => item.id === targetId);
      if (comment) return `Comment by ${userName(comment.authorId, comment.anonymous)}`;
    }
    return "Comment";
  }
  if (type === "user") {
    const target = state.users.find((item) => item.id === targetId);
    if (target) return `User: ${target.englishName || "Unknown"}`;
    return "User";
  }
  return type ? `${type[0].toUpperCase()}${type.slice(1)}` : "Content";
}

function reportTargetPreview(report = {}) {
  const type = String(report.type || "").toLowerCase();
  const targetId = String(report.targetId || "");
  if (type === "post") {
    const post = state.posts.find((item) => item.id === targetId);
    if (!post) return "Preview unavailable. Source may have been deleted or not loaded yet.";
    const body = String(post.text || "").trim();
    if (body) return body.slice(0, 160);
    if (Array.isArray(post.media) && post.media.length) return `Media post (${post.media.length} attachment${post.media.length > 1 ? "s" : ""})`;
    return "Empty text post.";
  }
  if (type === "conversation" || type === "chat") {
    const convo = state.conversations.find((item) => item.id === targetId);
    if (!convo) return "Preview unavailable. Conversation may be unavailable.";
    const latest = (convo.messages || []).slice().sort((a, b) => at(b.createdAt) - at(a.createdAt))[0];
    if (!latest) return "No messages in conversation yet.";
    const body = String(latest.text || "").trim();
    return body ? `Latest: ${body.slice(0, 140)}` : "Latest message contains attachment only.";
  }
  if (type === "comment") {
    for (const post of state.posts || []) {
      const comment = (post.comments || []).find((item) => item.id === targetId);
      if (!comment) continue;
      const body = String(comment.text || "").trim();
      return body ? body.slice(0, 160) : "Comment has no text.";
    }
    return "Preview unavailable. Comment may be unavailable.";
  }
  if (type === "user") {
    const target = state.users.find((item) => item.id === targetId);
    if (!target) return "Preview unavailable. User may be unavailable.";
    return `${target.englishName || "Unknown"} · Grade ${target.grade ?? "-"}, Class ${target.classNo ?? "-"}`;
  }
  return `Target ID: ${targetId || "-"}`;
}

function resolveReportTargetUserId(report = {}) {
  const type = String(report.type || "").toLowerCase();
  const targetId = String(report.targetId || "");
  if (!targetId) return "";
  if (type === "post") {
    const post = state.posts.find((item) => item.id === targetId);
    return String(post?.authorId || "");
  }
  if (type === "comment") {
    for (const post of state.posts || []) {
      const comment = (post.comments || []).find((item) => item.id === targetId);
      if (comment?.authorId) return String(comment.authorId);
    }
    return "";
  }
  if (type === "conversation" || type === "chat") {
    const convo = state.conversations.find((item) => item.id === targetId);
    if (!convo) return "";
    const reporterId = String(report.reporterId || "");
    return String((convo.members || []).find((memberId) => String(memberId) !== reporterId) || "");
  }
  if (type === "user") {
    return targetId;
  }
  return "";
}

function toast(message) {
  const existing = document.querySelector(".toast");
  existing?.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 2200);
}

function renderFatalUi(message) {
  const app = document.querySelector("#app");
  if (!app) return;
  const safeMessage = escapeHtml(String(message || "Unknown client error"));
  app.innerHTML = `
    <section class="panel" style="max-width:760px;margin:24px auto">
      <h2 style="margin-top:0">App Runtime Error</h2>
      <p class="muted">The page hit a client-side error and stopped rendering. You can reload now.</p>
      <pre style="white-space:pre-wrap;word-break:break-word;background:#f8fbff;border:1px solid var(--line);padding:12px;border-radius:10px">${safeMessage}</pre>
      <div class="row" style="margin-top:12px">
        <button class="btn primary" type="button" id="fatal-reload-btn">Reload</button>
      </div>
    </section>
  `;
  app.querySelector("#fatal-reload-btn")?.addEventListener("click", () => window.location.reload());
}

window.addEventListener("error", (event) => {
  const message = event?.error?.stack || event?.message || "Unknown client error";
  console.error("Uncaught error:", message);
  if (!event?.error?.message?.includes("ResizeObserver")) {
    renderFatalUi(message);
  }
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event?.reason;
  const message = reason?.stack || reason?.message || String(reason || "Unhandled promise rejection");
  console.error("Unhandled rejection:", message);
  if (!message.includes("ensurePostsAhead") && !message.includes("warmCategoryPools")) {
    renderFatalUi(message);
  }
});

function showPopup(title, message) {
  document.querySelector("#site-popup")?.remove();
  const node = document.createElement("div");
  node.id = "site-popup";
  node.className = "modal-backdrop";
  node.innerHTML = `
    <div class="modal">
      <div class="between" style="margin-bottom:10px">
        <strong>${escapeHtml(title)}</strong>
        <button class="btn small" type="button" data-close-popup>Close</button>
      </div>
      <p class="muted" style="margin:0">${escapeHtml(message)}</p>
    </div>
  `;
  document.body.appendChild(node);
  node.querySelector("[data-close-popup]")?.addEventListener("click", () => node.remove());
  node.addEventListener("click", (event) => {
    if (event.target === node) node.remove();
  });
}

function askConfirmPopup(title, message, confirmLabel = "Confirm") {
  return new Promise((resolve) => {
    const popup = showFormPopup(title, `
      <div class="grid">
        <p class="muted" style="margin:0">${escapeHtml(message)}</p>
        <div class="row">
          <button class="btn danger" type="button" data-confirm>${escapeHtml(confirmLabel)}</button>
          <button class="btn" type="button" data-cancel>Cancel</button>
        </div>
      </div>
    `);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      popup.remove();
      resolve(value);
    };
    popup.querySelector("[data-cancel]")?.addEventListener("click", () => finish(false));
    popup.querySelector("[data-confirm]")?.addEventListener("click", () => finish(true));
    popup.querySelector("[data-close-popup]")?.addEventListener("click", () => finish(false));
    popup.addEventListener("click", (event) => {
      if (event.target === popup) finish(false);
    });
  });
}

function openMediaViewer(url, type = "") {
  const isVideo = String(type || "").startsWith("video/");
  if (!isVideo) return null;
  const popup = showFormPopup("Media Viewer", `
    <div class="media-viewer">
      <div class="media-viewer-frame">
        <video src="${escapeHtml(url)}" controls autoplay playsinline></video>
      </div>
    </div>
  `, "media-modal");
  return popup;
}

function showSharePopup(url, text = "", postId = "") {
  const conversations = classifyConversations().inbox.slice(0, 50);
  const popup = showFormPopup("Share Post", `
    <div class="grid">
      <div class="field">
        <label>Share link</label>
        <input id="share-link-input" value="${escapeHtml(url)}" readonly />
      </div>
      ${text ? `<p class="muted" style="margin:0">${escapeHtml(text)}</p>` : ""}
      <div class="field">
        <label>Select chats</label>
        <select id="share-conversation-id" multiple size="6" ${conversations.length ? "" : "disabled"}>
          ${conversations.length
            ? conversations.map((conv) => {
              const label = conv.group
                ? (conv.title || "Group chat")
                : conversationCounterpartName(conv);
              return `<option value="${escapeHtml(conv.id)}">${escapeHtml(label)}</option>`;
            }).join("")
            : `<option value="">No conversation available</option>`
          }
        </select>
        <p class="muted" style="margin:4px 0 0">Hold Command/Ctrl to choose multiple chats.</p>
      </div>
      <div class="row">
        <button class="btn primary" type="button" data-copy-share>Copy link</button>
        <a class="btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open</a>
        <button class="btn" type="button" data-share-chat ${conversations.length ? "" : "disabled"}>Send to chat</button>
        ${navigator.share ? `<button class="btn" type="button" data-native-share>System Share</button>` : ""}
      </div>
    </div>
  `);
  popup.querySelector("[data-copy-share]")?.addEventListener("click", async () => {
    const input = popup.querySelector("#share-link-input");
    const value = input?.value || url;
    try {
      await navigator.clipboard.writeText(value);
      toast("Post link copied");
    } catch {
      toast("Copy failed. Please copy manually.");
    }
  });
  popup.querySelector("[data-native-share]")?.addEventListener("click", async () => {
    try {
      await navigator.share({ title: "SHSID Social Post", text, url });
    } catch {
      // user cancelled
    }
  });
  popup.querySelector("[data-share-chat]")?.addEventListener("click", async () => {
    try {
      const selected = [...(popup.querySelector("#share-conversation-id")?.selectedOptions || [])].map((option) => String(option.value || "")).filter(Boolean);
      if (!selected.length) return toast("Select at least one chat");
      const allowed = new Set(conversations.map((conv) => conv.id));
      const invalid = selected.find((conversationId) => !allowed.has(conversationId));
      if (invalid) return toast("You can only share to your own chats");
      const messageText = [`Shared post${postId ? ` (${postId})` : ""}:`, text || "", url].filter(Boolean).join("\n");
      for (const conversationId of selected) {
        await apiRequest(`/conversations/${conversationId}/messages`, {
          method: "POST",
          body: JSON.stringify({ text: messageText, anonymous: false })
        });
      }
      toast(`Shared to ${selected.length} chat${selected.length > 1 ? "s" : ""}`);
      popup.remove();
    } catch (error) {
      toast(error.message || "Could not share to chat");
    }
  });
}

function showFormPopup(title, bodyHtml, modalClass = "") {
  document.querySelector("#site-form-popup")?.remove();
  const node = document.createElement("div");
  node.id = "site-form-popup";
  node.className = "modal-backdrop";
  const safeModalClass = String(modalClass || "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
  const nativeRemove = node.remove.bind(node);
  node.remove = () => {
    document.body.classList.remove("modal-open");
    const top = document.body.style.top;
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.width = "";
    if (top) {
      const y = Math.abs(parseInt(top, 10)) || modalLockedScrollY || 0;
      window.scrollTo(0, y);
    }
    nativeRemove();
  };
  node.innerHTML = `
    <div class="modal ${safeModalClass}">
      <div class="between" style="margin-bottom:10px">
        <strong>${escapeHtml(title)}</strong>
        <button class="btn small" type="button" data-close-popup>Close</button>
      </div>
      ${bodyHtml}
    </div>
  `;
  document.body.appendChild(node);
  document.body.classList.add("modal-open");
  modalLockedScrollY = window.scrollY || window.pageYOffset || 0;
  document.body.style.position = "fixed";
  document.body.style.top = `-${modalLockedScrollY}px`;
  document.body.style.width = "100%";
  node.querySelector("[data-close-popup]")?.addEventListener("click", () => node.remove());
  node.addEventListener("click", (event) => {
    if (event.target === node) node.remove();
  });
  return node;
}

function askTextPopup(title, label, placeholder = "") {
  return new Promise((resolve) => {
    const popup = showFormPopup(title, `
      <form id="site-text-form" class="grid">
        <div class="field"><label>${escapeHtml(label)}</label><textarea id="site-text-input" placeholder="${escapeHtml(placeholder)}" required></textarea></div>
        <div class="row">
          <button class="btn primary" type="submit">Submit</button>
          <button class="btn" type="button" data-cancel>Cancel</button>
        </div>
      </form>
    `);
    popup.querySelector("[data-cancel]")?.addEventListener("click", () => {
      popup.remove();
      resolve(null);
    });
    popup.querySelector("#site-text-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = String(popup.querySelector("#site-text-input")?.value || "").trim();
      popup.remove();
      resolve(value || null);
    });
  });
}

function askQnaPopup() {
  return new Promise((resolve) => {
    const popup = showFormPopup("Ask Question", `
      <form id="site-qna-form" class="grid">
        <div class="field"><label>Question</label><textarea id="site-qna-question" placeholder="Write your question" required></textarea></div>
        <div class="row">
          <label><input id="site-qna-anon" type="checkbox"> Ask anonymously</label>
          <label><input id="site-qna-public" type="checkbox" checked> Show publicly</label>
        </div>
        <div class="row">
          <button class="btn primary" type="submit">Submit</button>
          <button class="btn" type="button" data-cancel>Cancel</button>
        </div>
      </form>
    `);
    popup.querySelector("[data-cancel]")?.addEventListener("click", () => {
      popup.remove();
      resolve(null);
    });
    popup.querySelector("#site-qna-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const question = String(popup.querySelector("#site-qna-question")?.value || "").trim();
      if (!question) return;
      const anonymous = Boolean(popup.querySelector("#site-qna-anon")?.checked);
      const visibility = popup.querySelector("#site-qna-public")?.checked ? "public" : "private";
      popup.remove();
      resolve({ question, anonymous, visibility });
    });
  });
}

function askCommentPopup() {
  return new Promise((resolve) => {
    const popup = showFormPopup("Add Comment", `
      <form id="site-comment-form" class="grid">
        <div class="field"><label>Comment</label><textarea id="site-comment-text" placeholder="Write your comment" required></textarea></div>
        <div class="row">
          <label><input id="site-comment-anon" type="checkbox"> Post anonymously</label>
        </div>
        <div class="row">
          <button class="btn primary" type="submit">Submit</button>
          <button class="btn" type="button" data-cancel>Cancel</button>
        </div>
      </form>
    `);
    popup.querySelector("[data-cancel]")?.addEventListener("click", () => {
      popup.remove();
      resolve(null);
    });
    popup.querySelector("#site-comment-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = String(popup.querySelector("#site-comment-text")?.value || "").trim();
      if (!text) return;
      const anonymous = Boolean(popup.querySelector("#site-comment-anon")?.checked);
      popup.remove();
      resolve({ text, anonymous });
    });
  });
}

function startResendCooldown(seconds = 30) {
  resendCooldownUntil = Date.now() + seconds * 1000;
}

function resendCooldownLeft() {
  return Math.max(0, Math.ceil((resendCooldownUntil - Date.now()) / 1000));
}

async function handleEmailAuthIntent(intent) {
  if (authRequestInFlight) return;
  const email = document.querySelector("#auth-email")?.value?.trim().toLowerCase() || "";
  if (!email) {
    toast("Enter an email");
    return;
  }
  setAuthInFlight(true);
  try {
  if (intent === "register") {
    state.pendingEmail = email;
    state.authMode = "register";
    const result = await apiRequest("/auth/start", { method: "POST", body: JSON.stringify({ email }) });
    if (result.hint === "login") {
      state.authMode = "login";
      state.authStep = "password";
      saveState();
      render();
      toast("This email already has a password. Sign in instead.");
      return;
    }
    state.authStep = "verify";
    saveState();
    render();
    startResendCooldown(30);
    showPopup(
      "Verification Code Sent",
      result.devCode
        ? `Dev mode code: ${result.devCode}`
        : "We sent a verification code to your email. If you do not see it, check Spam/Junk."
    );
    return;
  }
  state.pendingEmail = email;
  state.authMode = "login";
  state.authStep = "password";
  saveState();
  render();
  } finally {
    setAuthInFlight(false);
  }
}

let renderDebounceTimer = null;

function render() {
  if (renderDebounceTimer) return;
  renderDebounceTimer = setTimeout(() => {
    renderDebounceTimer = null;
    doRender();
  }, 16);
}

function doRender() {
  const user = currentUser();
  if (!user || state.authStep !== "app") {
    stopLiveChatLoop();
    renderAuth();
    return;
  }
  stopVerificationQueueLoop();

  const adminVisible = user.role === "admin";
  const visibleNav = navItems.filter((item) => item[0] !== "admin" || adminVisible);
  const profileIconHtml = user.profilePhoto
    ? `<img src="${escapeHtml(user.profilePhoto)}" alt="${escapeHtml(user.englishName || "Profile")}" class="nav-profile-icon" loading="lazy">`
    : `${escapeHtml(initials(user))}`;
  document.querySelector("#app").innerHTML = `
    <div class="app ${view === "admin" ? "app-admin" : ""} ${view === "messages" ? "app-messages" : ""}">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">S</span><span>SHSID Social</span></div>
        <nav class="nav">
          ${visibleNav.map(([id, icon, label]) => `<button class="${view === id ? "active" : ""}" data-view="${id}"><span class="nav-ico ${id === "profile" ? "nav-ico-profile" : ""}">${id === "profile" ? profileIconHtml : icon}</span>${label}</button>`).join("")}
        </nav>
        <button class="session session-card-btn" data-action="open-settings">
          <span class="session-name">${escapeHtml(user.englishName)}</span>
          <span class="session-info">${escapeHtml(user.chineseName)} · G${user.grade} C${user.classNo}</span>
          <span class="session-status">${user.role === "admin" ? "Admin" : user.status}</span>
        </button>
        <button class="btn small ghost" data-action="logout" style="margin-top:10px;color:#fff;border-color:rgba(255,255,255,.25)">Logout</button>
      </aside>
      <main class="main">${renderView()}</main>
      <aside class="rightbar">${renderRightbar()}</aside>
      <nav class="mobile-nav">
        ${visibleNav.slice(0, 5).map(([id, icon, label]) => `<button class="${view === id ? "active" : ""}" data-view="${id}"><strong>${icon}</strong><br>${label}</button>`).join("")}
      </nav>
    </div>
    ${uploadUi.active ? renderUploadOverlay() : ""}
  `;
  bindEvents();
  setupMediaLoadingIndicators();
  setupFeedVideoAutoplay();
  preloadVisiblePostMedia();
  syncLiveChatLoop();
}

function scheduleFeedVideoPlaybackSync() {
  if (view !== "feed") return;
  if (feedVideoPlaybackTickScheduled) return;
  feedVideoPlaybackTickScheduled = true;
  requestAnimationFrame(() => {
    feedVideoPlaybackTickScheduled = false;
    if (view !== "feed") return;
    syncMostVisibleFeedVideo();
  });
}

function isFeedVideoSeekLocked(video, nowMs = Date.now()) {
  return Boolean(video && feedVideoSeekingVideo === video && video.isConnected && nowMs < feedVideoSeekingUntil);
}

function syncMostVisibleFeedVideo() {
  if (view !== "feed" || document.hidden) return;
  const videos = [...document.querySelectorAll(".media-carousel .media-video")];
  if (!videos.length) return;
  const nowMs = Date.now();
  const manualRatio = Number(feedVideoVisibility.get(feedVideoManualControlVideo) || 0);
  const manualActive = feedVideoManualControlVideo
    && feedVideoManualControlVideo.isConnected
    && nowMs < feedVideoManualControlUntil
    && manualRatio >= 0.45;
  let candidate = null;
  let candidateRatio = 0;
  let winner = null;
  let winnerRatio = 0;
  const seekLocked = isFeedVideoSeekLocked(feedVideoSeekingVideo, nowMs);
  if (seekLocked) {
    winner = feedVideoSeekingVideo;
    winnerRatio = Math.max(Number(feedVideoVisibility.get(feedVideoSeekingVideo) || 0), 0.45);
  } else if (manualActive) {
    winner = feedVideoManualControlVideo;
    winnerRatio = manualRatio;
  } else {
    for (const video of videos) {
      if (feedVideoUserPaused.has(video)) continue;
      const ratio = Number(feedVideoVisibility.get(video) || 0);
      if (ratio > candidateRatio) {
        candidateRatio = ratio;
        candidate = video;
      }
    }
    const currentRatio = feedVideoCurrentAutoplay?.isConnected
      ? Number(feedVideoVisibility.get(feedVideoCurrentAutoplay) || 0)
      : 0;
    const canSwitch = nowMs - feedVideoLastSwitchAt > 800;
    const currentStillGood = feedVideoCurrentAutoplay
      && feedVideoCurrentAutoplay.isConnected
      && !feedVideoUserPaused.has(feedVideoCurrentAutoplay)
      && currentRatio >= 0.35;
    if (currentStillGood && (!candidate || candidate === feedVideoCurrentAutoplay || candidateRatio < currentRatio + 0.18 || !canSwitch)) {
      winner = feedVideoCurrentAutoplay;
      winnerRatio = currentRatio;
    } else {
      winner = candidate;
      winnerRatio = candidateRatio;
      if (winner !== feedVideoCurrentAutoplay) {
        feedVideoCurrentAutoplay = winner;
        feedVideoLastSwitchAt = nowMs;
      }
    }
  }
  for (const video of videos) {
    if (seekLocked && video === feedVideoSeekingVideo) continue;
    if (video !== winner || winnerRatio < 0.45) {
      if (!video.paused) {
        feedVideoProgrammaticPause.add(video);
        video.pause();
      }
      continue;
    }
    if (feedVideoUserPaused.has(video)) {
      if (!video.paused) {
        feedVideoProgrammaticPause.add(video);
        video.pause();
      }
      continue;
    }
    if (video.paused) {
      const tryPlay = () => video.play().catch(() => {
        // Ignore autoplay blocks; user can still tap play.
      });
      if (video.readyState >= 2) tryPlay();
      else video.addEventListener("canplay", tryPlay, { once: true });
    }
  }
}

function pauseAllFeedVideos() {
  const videos = [...document.querySelectorAll(".media-carousel .media-video")];
  videos.forEach((video) => {
    if (!video.paused) video.pause();
  });
  feedVideoCurrentAutoplay = null;
}

function pauseAllVideos() {
  document.querySelectorAll("video").forEach((video) => {
    if (!video.paused) {
      video.pause();
    }
  });
  feedVideoCurrentAutoplay = null;
  feedVideoUserPaused.clear();
  feedVideoProgrammaticPause.clear();
}

function resetFeedVideoState() {
  feedVideoCurrentAutoplay = null;
  feedVideoLastSwitchAt = 0;
  feedVideoSeekingVideo = null;
  feedVideoSeekingUntil = 0;
  feedVideoManualControlVideo = null;
  feedVideoManualControlUntil = 0;
  feedVideoUserPaused.clear();
  feedVideoProgrammaticPause.clear();
  feedVideoControlsBound.clear();
  feedVideoVisibility.clear();
  if (feedVideoObserver) {
    feedVideoObserver.disconnect();
    feedVideoObserver = null;
  }
}

function setupFeedVideoAutoplay() {
  if (view !== "feed") {
    resetFeedVideoState();
    pauseAllFeedVideos();
    return;
  }
  const videos = [...document.querySelectorAll(".media-carousel .media-video")];
  if (feedVideoObserver) {
    feedVideoObserver.disconnect();
    feedVideoObserver = null;
  }
  feedVideoVisibility.clear();
  feedVideoCurrentAutoplay = null;
  if (!videos.includes(feedVideoSeekingVideo)) {
    feedVideoSeekingVideo = null;
    feedVideoSeekingUntil = 0;
  }
  if (!videos.length) return;
  feedVideoObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      feedVideoVisibility.set(entry.target, entry.intersectionRatio);
    }
    scheduleFeedVideoPlaybackSync();
  }, { threshold: [0, 0.2, 0.45, 0.65, 0.85, 1] });
  videos.forEach((video) => {
    // Keep feed autoplay compliant with browser policies.
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    feedVideoObserver.observe(video);
    if (feedVideoControlsBound.has(video)) return;
    feedVideoControlsBound.add(video);
    const markManual = (durationMs = 2200) => {
      const lockMs = typeof durationMs === "number" ? durationMs : 2200;
      feedVideoManualControlVideo = video;
      feedVideoManualControlUntil = Date.now() + lockMs;
    };
    const markSeeking = () => {
      feedVideoSeekingVideo = video;
      feedVideoSeekingUntil = Date.now() + 5000;
      markManual(5000);
      scheduleFeedVideoPlaybackSync();
    };
    video.addEventListener("pointerdown", markManual);
    video.addEventListener("mousedown", markManual);
    video.addEventListener("touchstart", markManual, { passive: true });
    video.addEventListener("seeking", markSeeking);
    video.addEventListener("seeked", () => {
      if (feedVideoSeekingVideo === video) feedVideoSeekingUntil = Date.now() + 1200;
      markManual(1200);
      scheduleFeedVideoPlaybackSync();
    });
    video.addEventListener("pause", () => {
      if (feedVideoProgrammaticPause.has(video)) {
        feedVideoProgrammaticPause.delete(video);
        return;
      }
      if (video.seeking || isFeedVideoSeekLocked(video)) {
        markManual(1800);
        return;
      }
      feedVideoUserPaused.add(video);
      if (feedVideoCurrentAutoplay === video) feedVideoCurrentAutoplay = null;
      markManual();
    });
    video.addEventListener("play", () => {
      feedVideoUserPaused.delete(video);
    });
  });
  if (!feedVideoViewportListenersBound) {
    window.addEventListener("scroll", scheduleFeedVideoPlaybackSync, { passive: true });
    window.addEventListener("resize", scheduleFeedVideoPlaybackSync);
    feedVideoViewportListenersBound = true;
  }
  if (!feedVideoVisibilityListenerBound) {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) pauseAllFeedVideos();
      else if (view === "feed") scheduleFeedVideoPlaybackSync();
    });
    feedVideoVisibilityListenerBound = true;
  }
  scheduleFeedVideoPlaybackSync();
}

function renderUploadOverlay() {
  const pct = Math.max(0, Math.min(100, Number(uploadUi.percent || 0)));
  return `
    <div class="upload-overlay">
      <div class="upload-card">
        <div class="upload-ring" style="--pct:${pct}">
          <div class="upload-ring-inner">${Math.round(pct)}%</div>
        </div>
        <strong>${escapeHtml(uploadUi.label || "Uploading...")}</strong>
      </div>
    </div>
  `;
}

function syncUploadOverlayDom() {
  const appRoot = document.querySelector("#app");
  if (!appRoot) return;
  const existing = appRoot.querySelector(".upload-overlay");
  if (!uploadUi.active) {
    if (existing) existing.remove();
    return;
  }
  const pct = Math.max(0, Math.min(100, Number(uploadUi.percent || 0)));
  if (!existing) {
    appRoot.insertAdjacentHTML("beforeend", renderUploadOverlay());
    return;
  }
  const ring = existing.querySelector(".upload-ring");
  if (ring) ring.style.setProperty("--pct", String(pct));
  const inner = existing.querySelector(".upload-ring-inner");
  if (inner) inner.textContent = `${Math.round(pct)}%`;
  const label = existing.querySelector("strong");
  if (label) label.textContent = uploadUi.label || "Uploading...";
}

function startUploadProgressTicker() {
  if (uploadProgressTimer) return;
  uploadProgressTimer = setInterval(() => {
    if (!uploadUi.active) {
      stopUploadProgressTicker();
      return;
    }
    const current = Math.max(0, Math.min(100, Number(uploadUi.percent || 0)));
    const target = Math.max(current, Math.min(100, Number(uploadTargetPercent || 0)));
    if (current >= target) {
      if (uploadCompleting && current >= 100) {
        uploadUi = { active: false, label: "", percent: 0 };
        uploadTargetPercent = 0;
        uploadCompleting = false;
        stopUploadProgressTicker();
        syncUploadOverlayDom();
      }
      return;
    }
    const step = Math.max(1, Math.ceil((target - current) * 0.28));
    const next = Math.min(target, current + step);
    uploadUi = { ...uploadUi, percent: next };
    syncUploadOverlayDom();
  }, 500);
}

function setUploadProgress(label, percent) {
  const normalized = Math.max(0, Math.min(99, Number(percent || 0)));
  const nextLabel = String(label || "Uploading...");
  uploadTargetPercent = Math.max(uploadTargetPercent, normalized);
  uploadCompleting = false;
  if (!uploadUi.active) {
    uploadUi = { active: true, label: nextLabel, percent: 0 };
    syncUploadOverlayDom();
  } else if (uploadUi.label !== nextLabel) {
    uploadUi = { ...uploadUi, label: nextLabel };
    syncUploadOverlayDom();
  }
  startUploadProgressTicker();
}

function clearUploadProgress({ immediate = false } = {}) {
  if (immediate) {
    uploadUi = { active: false, label: "", percent: 0 };
    uploadTargetPercent = 0;
    uploadCompleting = false;
    stopUploadProgressTicker();
    syncUploadOverlayDom();
    return;
  }
  uploadTargetPercent = 100;
  uploadCompleting = true;
  startUploadProgressTicker();
}

function conversationsSnapshot() {
  return JSON.stringify((state.conversations || []).map((conv) => ({
    id: conv.id,
    m: (conv.messages || []).length,
    l: conv.messages?.[conv.messages.length - 1]?.id || "",
    t: conv.messages?.[conv.messages.length - 1]?.createdAt || ""
  })));
}

async function refreshVerificationQueue() {
  if (!state.apiToken) return;
  const user = currentUser();
  if (!user || user.role === "admin" || user.status === "verified") return;
  try {
    const previous = state.verificationQueue || { pendingTotal: 0, ahead: 0, position: 0 };
    const result = await apiRequest("/me/verification-queue", { cacheTtlMs: API_CACHE_TTL.verificationQueue });
    const next = {
      pendingTotal: Number(result.pendingTotal || 0),
      ahead: Number(result.ahead || 0),
      position: Number(result.position || 0)
    };
    if (
      Number(previous.pendingTotal || 0) === next.pendingTotal
      && Number(previous.ahead || 0) === next.ahead
      && Number(previous.position || 0) === next.position
    ) return false;
    state.verificationQueue = next;
    saveState();
    return true;
  } catch (error) {
    console.error("refreshVerificationQueue failed", error);
  }
  return false;
}

function syncVerificationQueueLoop() {
  const user = currentUser();
  const needsLoop = Boolean(user && state.authStep === "waiting" && user.role !== "admin" && user.status !== "verified");
  if (!needsLoop) {
    stopVerificationQueueLoop();
    return;
  }
  if (verificationQueueTimer) return;
  verificationQueueTimer = setInterval(async () => {
    if (verificationQueuePollInFlight) return;
    verificationQueuePollInFlight = true;
    try {
      const changed = await refreshVerificationQueue();
      if (changed) render();
    } finally {
      verificationQueuePollInFlight = false;
    }
  }, 60000);
  void refreshVerificationQueue();
}

function syncLiveChatLoop() {
  const user = currentUser();
  const needsLiveChat = Boolean(user && state.authStep === "app" && (view === "messages" || (view === "admin" && user.role === "admin")));
  if (!needsLiveChat) {
    stopLiveChatLoop();
    return;
  }
  if (liveChatTimer) return;
  liveChatTimer = setInterval(pollLiveChatUpdates, 2500);
  pollLiveChatUpdates();
}

async function pollLiveChatUpdates() {
  if (liveChatPollInFlight || !state.apiToken) return;
  liveChatPollInFlight = true;
  try {
    const changed = await refreshConversations();
    if (changed) {
      liveChatSnapshot = conversationsSnapshot();
      render();
    }
  } catch (error) {
    console.error("pollLiveChatUpdates failed", error);
  } finally {
    liveChatPollInFlight = false;
  }
}

function renderAuth() {
  if (isBootstrappingSession) {
    document.querySelector("#app").innerHTML = `
      <section class="auth-screen">
        <div class="auth-card">
          <div class="brand" style="color:var(--ink);margin-bottom:18px"><span class="brand-mark">S</span><span>SHSID Social</span></div>
          <h2>Logging in...</h2>
          <p class="muted">Restoring your session. Please wait a moment.</p>
        </div>
        <div class="auth-art">
          <h1>Private social networking for verified SHSID students.</h1>
          <p>Feed, messaging, profiles, reports, verification, and admin moderation in one school-only platform.</p>
        </div>
      </section>
    `;
    return;
  }
  const step = state.authStep || "email";
  const mode = state.authMode || "login";
  const title = step === "email" ? "Sign in faster"
    : step === "verify" ? "Verify email"
      : step === "password" ? (mode === "register" ? "Create password" : "Enter password")
        : step === "profile" ? "Student info"
          : step === "video" ? "Video verification"
            : "Waiting for confirmation";
  const subtitle = step === "email"
    ? "Returning users can sign in immediately. New accounts get a verification email to any valid address."
    : step === "verify"
      ? "Enter the 6-digit code we sent to your email. If you don't see it, check Spam/Junk."
      : step === "password" && mode === "register"
        ? "Set your password and confirm it to continue."
        : step === "password"
          ? "No OTP step is needed for returning users."
          : step === "profile"
            ? "Enter your legal names and class information."
            : step === "video"
              ? "Upload your verification video to submit your account."
              : "Your account is submitted. Please wait for admin approval.";
  const resendSeconds = resendCooldownLeft();
  const queue = state.verificationQueue || { pendingTotal: 0, ahead: 0, position: 0 };
  const body = step === "email" ? `
    <form class="grid" id="auth-email-form">
      <div class="field"><label>Email</label><input id="auth-email" type="email" autocomplete="email" placeholder="you@example.com" value="${escapeHtml(state.pendingEmail || "")}" required></div>
      <div class="row">
        <button class="btn primary" type="submit" data-auth-intent="login">Sign in</button>
        <button class="btn" type="submit" data-auth-intent="register">Create account</button>
      </div>
    </form>
  ` : step === "verify" ? `
    <form class="grid" id="auth-verify-form">
      <div class="field"><label>Email</label><input disabled value="${escapeHtml(state.pendingEmail || "")}"></div>
      <div class="field"><label>Verification code</label><input id="auth-code" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code from email" value="${escapeHtml(state.pendingCode || "")}" required></div>
      <p class="muted" style="margin:-4px 0 6px">Tip: Check your Spam/Junk folder if email takes more than 30 seconds.</p>
      <div class="row">
        <button class="btn primary" type="submit">Continue</button>
        <button class="btn" type="button" data-auth="resend-code" ${resendSeconds > 0 ? "disabled" : ""}>${resendSeconds > 0 ? `Resend (${resendSeconds}s)` : "Resend code"}</button>
        <button class="btn" type="button" data-auth="back">Back</button>
      </div>
    </form>
  ` : step === "password" && mode === "register" ? `
    <form class="grid" id="auth-password-form">
      <div class="field"><label>Email</label><input disabled value="${escapeHtml(state.pendingEmail || "")}"></div>
      <div class="field"><label>Password</label><input id="auth-password" type="password" autocomplete="new-password" placeholder="Password" required></div>
      <div class="field"><label>Confirm password</label><input id="auth-password-confirm" type="password" autocomplete="new-password" placeholder="Confirm password" required></div>
      <div class="row">
        <button class="btn primary" type="submit">Create account</button>
        <button class="btn" type="button" data-auth="back">Back</button>
      </div>
    </form>
  ` : step === "profile" ? `
    <form class="grid" id="auth-profile-form">
      <div class="field"><label>First name</label><input id="reg-first" placeholder="First name" required></div>
      <div class="field"><label>Middle name (optional)</label><input id="reg-middle" placeholder="Middle name"></div>
      <div class="field"><label>Last name</label><input id="reg-last" placeholder="Last name" required></div>
      <div class="field"><label>Chinese name (optional)</label><input id="reg-cn" placeholder="中文姓名 (optional)"></div>
      <div class="grid two">
        <div class="field"><label>Year (1-12)</label><input id="reg-grade" type="number" min="1" max="12" value="${Number(state.pendingGrade || 10)}" required></div>
        <div class="field"><label>Class (1-13)</label><input id="reg-class" type="number" min="1" max="13" value="${Number(state.pendingClassNo || 1)}" required></div>
      </div>
      <div class="field">
        <label>Profile picture</label>
        <div id="reg-photo-dropzone" class="dropzone">Drag and drop profile photo here, or click to pick file.</div>
        <input id="reg-photo" type="file" accept="image/*">
        <div id="reg-photo-chips" class="file-chips"></div>
      </div>
      <div class="row">
        <button class="btn primary" type="submit">Continue</button>
      </div>
    </form>
  ` : step === "video" ? `
    <form class="grid" id="auth-video-form">
      <div class="panel" style="margin:0">
        <strong>Video Script</strong>
        <p class="muted" style="margin-top:8px">
          My name is ${escapeHtml(state.pendingEnglishName || "")}. I am in Year ${Number(state.pendingGrade || 0)}, Class ${Number(state.pendingClassNo || 0)}.
          My 10 words are: ${escapeHtml((state.pendingVerificationWords || []).join(", "))}.
        </p>
      </div>
      <div class="field">
        <label>Verification video</label>
        <div id="verify-dropzone" class="dropzone">Drag and drop verification video here, or click to pick file.</div>
        <input id="reg-video" type="file" accept="video/*" required>
        <div id="verify-file-chips" class="file-chips"></div>
      </div>
      <p class="muted">${state.pendingVideoName ? `Selected: ${escapeHtml(state.pendingVideoName)}` : "Please upload your verification video."}</p>
      <div class="row">
        <button class="btn primary" type="submit">Submit verification</button>
      </div>
    </form>
  ` : step === "waiting" ? `
    <div class="grid">
      <p class="muted">We received your information and video. You will be able to post and message after approval.</p>
      <p class="muted">Users ahead: <strong>${Math.max(0, Number(queue.ahead || 0))}</strong> · Pending users: <strong>${Math.max(1, Number(queue.pendingTotal || 1))}</strong></p>
      <div class="row"><button class="btn" type="button" data-auth="logout">Log out</button></div>
    </div>
  ` : `
    <form class="grid" id="auth-password-form">
      <div class="field"><label>Email</label><input disabled value="${escapeHtml(state.pendingEmail || "")}"></div>
      <div class="field"><label>Password</label><input id="auth-password" type="password" autocomplete="current-password" placeholder="Password" required></div>
      <div class="row">
        <button class="btn primary" type="submit">Sign in</button>
        <button class="btn" type="button" data-auth="back">Back</button>
      </div>
    </form>
  `;

  document.querySelector("#app").innerHTML = `
    <section class="auth-screen">
      <div class="auth-card">
        <div class="brand" style="color:var(--ink);margin-bottom:18px"><span class="brand-mark">S</span><span>SHSID Social</span></div>
        <h2>${title}</h2>
        <p class="muted">${subtitle}</p>
        <div class="grid">${body}</div>
        <div class="auth-footer">
          <a href="./guidelines.html" target="_blank" rel="noopener">Community guidelines</a>
          <span aria-hidden="true"> · </span>
          <a href="./privacy.html" target="_blank" rel="noopener">Privacy overview</a>
        </div>
      </div>
      <div class="auth-art">
        <h1>Private social networking for verified SHSID students.</h1>
        <p>Feed, messaging, profiles, reports, verification, and admin moderation in one school-only platform.</p>
      </div>
    </section>
  `;
  bindAuth();
  syncVerificationQueueLoop();
}

function page(title, subtitle, content, actions = "") {
  const topBanner = renderAdCard("top_banner", "Top banner ad", { showPlaceholder: false });
  return `
    <div class="topbar">
      <div><h1>${title}</h1><p>${subtitle}</p></div>
      <div class="row">${actions}</div>
    </div>
    ${topBanner}
    ${content}
  `;
}

function renderView() {
  const user = currentUser();
  if (user.status !== "verified" && user.role !== "admin" && !["profile", "settings", "suggestions"].includes(view)) {
    return page("Verification pending", "Your account is active. Full access unlocks after admin approval.", renderProfile());
  }
  const routes = {
    feed: renderFeed,
    "single-post": renderSinglePost,
    post: renderComposer,
    students: renderStudents,
    messages: renderMessages,
    suggestions: renderSuggestions,
    profile: renderProfile,
    settings: renderSettings,
    admin: renderAdmin
  };
  return (routes[view] || renderFeed)();
}

function renderSinglePost() {
  const post = state.posts.find((item) => item.id === deepLinkedPostId);
  if (!post) {
    return page("Shared Post", "Getting your shared post ready.", `
      <section class="panel">
        <p class="muted">Loading post…</p>
        <div class="row"><button class="btn" data-action="back-feed">Back to feed</button></div>
      </section>
    `);
  }
  return page("Shared Post", "Here is the post shared with you.", `
    <section class="grid">
      <div class="row"><button class="btn" data-action="back-feed">Back to feed</button></div>
      ${renderPost(post)}
    </section>
  `);
}

function renderFeed() {
  const searchQuery = state.feedSearchQuery?.trim().toLowerCase();
  const engagementFilter = String(state.feedEngagementFilter || "all");
  const meId = state.currentUserId;
  const followingSet = new Set(Array.isArray(currentUser()?.following) ? currentUser().following : []);
  const posts = [...state.posts].sort((a, b) => {
    const stickyDelta = Number(b.sticky) - Number(a.sticky);
    if (stickyDelta) return stickyDelta;
    const followedDelta = Number(followingSet.has(b.authorId)) - Number(followingSet.has(a.authorId));
    if (followedDelta) return followedDelta;
    return b.createdAt - a.createdAt;
  });
  const searched = searchQuery ? posts.filter((p) => p.text?.toLowerCase().includes(searchQuery) || p.title?.toLowerCase().includes(searchQuery) || p.category?.toLowerCase().includes(searchQuery)) : posts;
  const filtered = searched.filter((post) => {
    if (engagementFilter === "following") return followingSet.has(post.authorId);
    if (engagementFilter === "hearted") return (post.hearts || []).includes(meId);
    if (engagementFilter === "liked-private") return (post.likes || []).includes(meId);
    if (engagementFilter === "saved") return (post.savedBy || []).includes(meId);
    return true;
  });
  const postsByCategory = new Map();
  for (const category of CONTENT_CATEGORIES) postsByCategory.set(category, []);
  postsByCategory.set("other", []);
  const followingRows = [];
  for (const post of filtered) {
    if (followingSet.has(post.authorId)) followingRows.push(post);
    const category = String(post.category || "").trim().toLowerCase();
    if (postsByCategory.has(category)) postsByCategory.get(category).push(post);
    else postsByCategory.get("other").push(post);
  }
  const followingSection = followingRows.length && engagementFilter !== "following" ? `
    <section class="panel feed-category-block">
      <div class="between feed-category-head">
        <h3>Following</h3>
        <span class="muted">${followingRows.length} post${followingRows.length === 1 ? "" : "s"}</span>
      </div>
      <div class="grid">${followingRows.map((post, idx) => `${idx > 0 && idx % 12 === 0 ? renderAdCard("feed_inline", "Feed sponsor") : ""}${renderPost(post)}`).join("")}</div>
    </section>
  ` : "";
  const orderedCategories = [...CONTENT_CATEGORIES, "other"];
  const categorySections = orderedCategories
    .filter((category) => (postsByCategory.get(category) || []).length > 0)
    .map((category) => {
      const rows = postsByCategory.get(category) || [];
      const label = category === "other" ? "Other" : `${category[0].toUpperCase()}${category.slice(1)}`;
      return `
        <section class="panel feed-category-block">
          <div class="between feed-category-head">
            <h3>${escapeHtml(label)}</h3>
            <span class="muted">${rows.length} post${rows.length === 1 ? "" : "s"}</span>
          </div>
          <div class="grid">${rows.map((post, idx) => `${idx > 0 && idx % 12 === 0 ? renderAdCard("feed_inline", "Feed sponsor") : ""}${renderPost(post)}`).join("")}</div>
        </section>
      `;
    }).join("");
  const postsHtml = filtered.length
    ? `${followingSection}${categorySections}`
    : `<div class="empty-state">${engagementFilter === "following" ? "No posts from people you follow yet." : "No posts yet. Share something positive or helpful to get the feed started."}</div>`;
  return page("Feed", "Catch up with what students are sharing right now.", `
    <div class="grid two" style="margin-bottom:16px">
      <div class="field" style="margin:0">
        <input id="feed-search" type="text" placeholder="Search posts..." style="width:100%;padding:10px;border-radius:8px;border:1px solid #ddd" />
      </div>
      <div class="field" style="margin:0">
        <select id="feed-engagement-filter">
          <option value="all" ${engagementFilter === "all" ? "selected" : ""}>All posts</option>
          <option value="following" ${engagementFilter === "following" ? "selected" : ""}>Following only</option>
          <option value="hearted" ${engagementFilter === "hearted" ? "selected" : ""}>Hearted (public)</option>
          <option value="liked-private" ${engagementFilter === "liked-private" ? "selected" : ""}>Liked (private)</option>
          <option value="saved" ${engagementFilter === "saved" ? "selected" : ""}>Saved posts</option>
        </select>
      </div>
    </div>
    <section class="grid" id="feed-posts">${postsHtml}</section>
    ${postsNextOffset != null ? `<div id="load-more-container" class="row" style="justify-content:center"><button class="btn" data-action="load-more-posts">Load more posts</button></div>` : ""}
  `);
}

function renderPost(post) {
  const author = state.users.find((u) => u.id === post.authorId);
  const authorFollowerCount = Number(author?.followerCount ?? (Array.isArray(author?.followers) ? author.followers.length : 0));
  const likes = post.likes || [];
  const hearts = post.hearts || [];
  const saves = post.savedBy || [];
  const liked = likes.includes(state.currentUserId);
  const hearted = hearts.includes(state.currentUserId);
  const saved = saves.includes(state.currentUserId);
  const isAdmin = currentUser().role === "admin";
  const isOwner = post.authorId === state.currentUserId;
  const media = post.media || [];
  const mediaIndex = Math.max(0, Math.min((postMediaIndexByPostId[post.id] || 0), Math.max(0, media.length - 1)));
  const activeMedia = media.length ? media[mediaIndex] : null;
  const comments = Array.isArray(post.comments) ? post.comments : [];
  const commentsOpen = openCommentPostId === post.id;
  const repliesByParentId = new Map();
  for (const comment of comments) {
    const parentId = comment.replyTo || "";
    if (!parentId) continue;
    if (!repliesByParentId.has(parentId)) repliesByParentId.set(parentId, []);
    repliesByParentId.get(parentId).push(comment);
  }
  const renderComment = (comment, nested = false) => {
    const key = `${post.id}:${comment.id}`;
    const replies = repliesByParentId.get(comment.id) || [];
    const commentLikes = Array.isArray(comment.likes) ? comment.likes : [];
    const commentLiked = commentLikes.includes(state.currentUserId);
    return `
      <div class="comment${nested ? " comment-reply" : ""}">
        <p style="margin:0">
          <strong>${escapeHtml(userName(comment.authorId, comment.anonymous))}:</strong> ${escapeHtml(comment.text)}
          ${(currentUser().role === "admin" || comment.authorId === state.currentUserId) ? `<button class="btn small danger" style="margin-left:8px" data-action="delete-comment" data-id="${post.id}:${comment.id}">Delete</button>` : ""}
          <button class="btn small" style="margin-left:8px" data-action="like-comment" data-id="${post.id}:${comment.id}">${commentLiked ? "♥︎" : "♡"} ${commentLikes.length}</button>
          <button class="btn small" style="margin-left:8px" data-action="reply-comment" data-id="${post.id}:${comment.id}">Reply</button>
        </p>
        ${openReplyCommentKey === key ? `
          <div class="comment-composer" style="margin-top:8px">
            <textarea id="reply-text-${post.id}-${comment.id}" placeholder="Write a reply..."></textarea>
            <div class="row">
              <select id="reply-anon-${post.id}-${comment.id}" class="btn small">
                <option value="false">Public</option>
                <option value="true">Anonymous</option>
              </select>
              <button class="btn small primary" data-action="submit-reply" data-id="${post.id}:${comment.id}">Reply</button>
              <button class="btn small" data-action="close-reply" data-id="${post.id}:${comment.id}">Cancel</button>
            </div>
          </div>
        ` : ""}
        ${replies.length ? `<div class="comment-replies">${replies.map((reply) => renderComment(reply, true)).join("")}</div>` : ""}
      </div>
    `;
  };
  const rootComments = comments.filter((comment) => !comment.replyTo);
  return `
    <article class="card" data-post-id="${post.id}">
      <div class="post-head">
        ${post.anonymous ? `<div class="avatar">AN</div>` : renderAvatar(author, author?.role === "admin" ? "admin" : "")}
        <div style="min-width:0">
          <div class="between">
            <strong>${escapeHtml(userName(post.authorId, post.anonymous))}</strong>
            ${post.sticky ? `<span class="status gold">Sticky</span>` : ""}
          </div>
          <div class="muted">${post.category} · ${timeAgo(post.createdAt)} · ${authorFollowerCount} follower${authorFollowerCount === 1 ? "" : "s"} ${currentUser().role === "admin" && post.anonymous ? `· Admin sees ${escapeHtml(userName(post.authorId))}` : ""}</div>
        </div>
      </div>
      <div class="post-text">${escapeHtml(post.text || "")}</div>
      ${post.title ? `<div class="post-title">${escapeHtml(post.title)}</div>` : ""}
      ${media.length ? `
        <div class="media-carousel">
          ${media.length > 1 && mediaIndex > 0 ? `<button class="media-nav prev" type="button" data-action="media-prev" data-id="${post.id}">&#8249;</button>` : ""}
          <div class="media-stage">
            <div class="media-track" style="transform: translateX(-${mediaIndex * 100}%);">
              ${media.map((item) => `<div class="media-slide">${renderPostMedia(item)}</div>`).join("")}
            </div>
          </div>
          ${media.length > 1 && mediaIndex < media.length - 1 ? `<button class="media-nav next" type="button" data-action="media-next" data-id="${post.id}">&#8250;</button>` : ""}
          ${media.length > 1 ? `<div class="media-dots">${media.map((_, idx) => `<span class="media-dot ${idx === mediaIndex ? "active" : ""}"></span>`).join("")}</div>` : ""}
        </div>
      ` : ""}
      ${commentsOpen ? `
        <div class="comment-thread">
          ${rootComments.length
            ? rootComments.map((comment) => renderComment(comment)).join("")
            : `<p class="muted comment-empty">No comments yet.</p>`
          }
        </div>
        <div class="comment-composer comment-composer-inline">
          <input id="comment-text-${post.id}" type="text" placeholder="Add a comment..." />
          <button class="btn small primary" data-action="submit-comment" data-id="${post.id}">Send</button>
          <button class="btn small" data-action="close-comment" data-id="${post.id}">Close</button>
        </div>
      ` : ""}
      <div class="post-actions">
        <button class="btn small" data-action="heart-post" data-id="${post.id}" title="Heart">${hearted ? "♥︎" : "♡"} ${hearts.length}</button>
        <button class="btn small" data-action="like-post" data-id="${post.id}" title="Private like">${liked ? "👍" : "👍🏻"} ${likes.length}</button>
        <button class="btn small" data-action="save-post" data-id="${post.id}" title="Save">${saved ? "🔖" : "⌑"} ${saves.length}</button>
        <button class="btn small" data-action="comment-post" data-id="${post.id}" title="Comment">💬</button>
        <button class="btn small" data-action="share-post" data-id="${post.id}" title="Share">✈︎</button>
        <button class="btn small" data-action="report-post" data-id="${post.id}" title="Report">⚑</button>
        ${isAdmin ? `<button class="btn small" data-action="toggle-sticky" data-id="${post.id}" title="${post.sticky ? "Unpin" : "Pin"}">${post.sticky ? "📌" : "📍"}</button>` : ""}
        ${isAdmin || isOwner ? `<button class="btn small danger" data-action="delete-post" data-id="${post.id}" title="Delete">🗑</button>` : ""}
      </div>
    </article>
  `;
}

function renderComposer() {
  return page("Create Post", "Share something with your classmates.", `
    <section class="composer">
      <div class="field"><label>Title (not required)</label><input id="post-title" placeholder="Optional title"></div>
      <div class="field"><label>Post text (not required)</label><textarea id="post-text" placeholder="What do you want to share?"></textarea></div>
      <div class="grid two">
        <div class="field"><label>Category</label><select id="post-category"><option>lifestyle</option><option>gaming</option><option>academic</option><option>school</option><option>shitpost</option></select></div>
        <div class="field"><label>Visibility</label><select id="post-anon"><option value="false">Public</option><option value="true">Anonymous</option></select></div>
      </div>
      <div class="field">
        <label>Media uploads</label>
        <div id="post-dropzone" class="dropzone">Drag and drop photos/videos here, or click to pick files.</div>
        <input id="post-media" type="file" multiple accept="image/*,video/*">
        <div id="post-file-chips" class="file-chips"></div>
      </div>
      <button class="btn primary" data-action="create-post">Publish</button>
    </section>
  `);
}

function renderStudents() {
  const meId = currentUser()?.id;
  const students = state.users.filter((u) => u.role !== "admin" && u.status === "verified" && u.id !== meId);
  const myFollowing = Array.isArray(currentUser()?.following) ? currentUser().following : [];
  const followedUsers = students.filter((student) => myFollowing.includes(student.id));
  return page("Students", "Meet verified classmates and start conversations.", `
    <section class="panel" style="margin-bottom:12px">
      <h3 style="margin:0 0 8px">Following (${followedUsers.length})</h3>
      ${followedUsers.length
        ? `<div class="row">${followedUsers.map((followed) => `<button class="btn small" data-action="view-profile" data-id="${followed.id}">${escapeHtml(followed.englishName)}</button>`).join("")}</div>`
        : `<p class="muted" style="margin:0">You are not following anyone yet.</p>`
      }
    </section>
    <section class="grid two">${students.map((user, idx) => `
      ${idx > 0 && idx % 20 === 0 ? renderAdCard("students_inline", "Student section sponsor") : ""}
      <article class="panel" data-action="view-profile" data-id="${user.id}" style="cursor:pointer">
        <div class="between">
          <div class="row">${renderAvatar(user)}<div><strong>${escapeHtml(user.englishName)}</strong><div class="muted">${escapeHtml(user.chineseName)} · Grade ${user.grade}, Class ${user.classNo}</div><div class="muted">${Number(user.followerCount || 0)} follower${Number(user.followerCount || 0) === 1 ? "" : "s"}</div></div></div>
        </div>
        <p>${escapeHtml(user.bio)}</p>
        <div class="row">
          <button class="btn small" data-action="follow" data-id="${user.id}">${myFollowing.includes(user.id) ? "Following" : "Follow"}</button>
          <button class="btn small" data-action="start-chat" data-id="${user.id}">Message</button>
          <button class="btn small" data-action="ask-qna" data-id="${user.id}">Ask</button>
        </div>
      </article>
    `).join("")}</section>
  `);
}

function renderMessages() {
  const { inbox, requests, requestsSent } = classifyConversations();
  const list = conversationTab === "requests" ? requests : (conversationTab === "sent" ? requestsSent : inbox);
  const active = list.find((item) => item.id === activeConversationId) || null;
  const requestView = conversationTab === "requests";
  const sentView = conversationTab === "sent";
  const firstAuthorId = active?.messages?.[0]?.authorId || "";
  const acceptedByLocal = active ? Boolean(state.acceptedRequests?.[active.id]) : false;
  const acceptedByReply = Boolean(firstAuthorId && (active?.messages || []).some((message) => message.authorId && message.authorId !== firstAuthorId));
  const accepted = acceptedByLocal || acceptedByReply;
  const isMeSender = active && firstAuthorId === currentUser().id;
  const isReceiverPending = requestView && active && !accepted && firstAuthorId && firstAuthorId !== currentUser().id;
  const canSendInCurrentThread = Boolean(active?.id) && !isReceiverPending;
  return page("Messages", "Chat with classmates in direct or group conversations.", `
    <section class="chat-layout">
      <div class="panel chat-panel chat-panel-list">
        <div class="chat-section" style="margin-bottom:12px">
          <strong>Conversations</strong>
          <div class="row chat-action-row" style="margin-top:8px"><button class="btn small chat-cta-btn" data-action="open-start-direct">Direct Messaging</button><button class="btn small chat-cta-btn" data-action="open-create-convo">Create Group Chat</button></div>
        </div>
        <div class="chat-section chat-tab-section row" style="margin-bottom:12px">
          <button class="btn chat-tab-btn ${conversationTab === "inbox" ? "primary" : ""}" data-action="chat-tab-inbox">Inbox (${inbox.length})</button>
          <button class="btn chat-tab-btn ${conversationTab === "requests" ? "primary" : ""}" data-action="chat-tab-requests">Requests (${requests.length})</button>
          <button class="btn chat-tab-btn ${conversationTab === "sent" ? "primary" : ""}" data-action="chat-tab-sent">Sent (${requestsSent.length})</button>
        </div>
        <div class="grid chat-list-scroll">${list.length
          ? list.map((conv) => `<button class="btn ${active?.id === conv.id ? "conv-selected" : ""}" data-action="open-conv" data-id="${conv.id}">${escapeHtml(conversationDisplayTitle(conv))}</button>`).join("")
          : `<p class="muted">No conversations in this tab yet.</p>`}</div>
      </div>
      <div class="panel chat-panel chat-panel-thread">
        ${!active ? `
          <div style="display:grid;place-items:center;min-height:300px">
            <p class="muted" style="margin:0">No chat selected yet. Click a conversation to open it.</p>
          </div>
        ` : `
        <div class="between">
          <strong>${escapeHtml(active ? conversationDisplayTitle(active) : "No conversation")}</strong>
          <div class="row chat-toolbar">
            <span class="chip">Active</span>
            ${active ? `<button class="btn small danger-icon" data-action="report-message" data-id="${active.id}" aria-label="Report conversation">⚠</button>` : ""}
            ${active ? `<button class="btn small" data-action="chat-info" data-id="${active.id}" aria-label="Chat details">...</button>` : ""}
          </div>
        </div>
        <div class="grid chat-messages-scroll" style="margin:14px 0">${(active?.messages || []).map((message) => `
          <div class="comment" style="margin:0"><strong>${escapeHtml(userName(message.authorId, message.anonymous))}:</strong> ${escapeHtml(message.text)} ${(message.media || []).map((item) => renderChatMediaItem(item)).join("")} <span class="muted">(${message.anonymous ? "anonymous" : "public"})</span> ${currentUser().role === "admin" && message.anonymous ? `<span class="muted">(real: ${escapeHtml(userName(message.authorId))})</span>` : ""}</div>
        `).join("")}</div>
        ${sentView ? `<p class="muted" style="margin:0 0 12px">Waiting for the other person to accept your request.</p>` : ""}
        ${requestView && active && !accepted && isReceiverPending ? `<div class="row" style="margin-bottom:12px"><button class="btn primary" data-action="accept-request" data-id="${active.id}">Accept</button><button class="btn danger" data-action="reject-request" data-id="${active.id}">Reject</button></div>` : ""}
        ${isReceiverPending && !sentView ? `<p class="muted" style="margin:0 0 10px">Accept this request before sending messages.</p>` : ""}
        <div id="message-attach-strip" class="chat-attach-strip"></div>
        <div class="field chat-message-field"><label>Message</label><textarea id="message-text" class="chat-message-input" placeholder="Type a message" ${sentView ? "disabled" : ""}></textarea></div>
        <div class="row chat-compose-row">
          <label class="btn small icon-btn" title="Attach photo or video">
            <input id="message-media-file" type="file" accept="image/*,video/*" multiple ${sentView ? "disabled" : ""} />
            <span aria-hidden="true">🖼</span>
          </label>
          <label class="btn small icon-btn" title="Attach file">
            <input id="message-doc-file" type="file" accept=".pdf,application/pdf" multiple ${sentView ? "disabled" : ""} />
            <span aria-hidden="true">📄</span>
          </label>
        </div>
        <div class="row">
          <button class="btn primary" data-action="send-message" data-id="${active?.id || ""}" ${canSendInCurrentThread && !sentView ? "" : "disabled"}>Send</button>
        </div>
        `}
      </div>
    </section>
  `);
}

function showConversationDetailsPopup(conversation) {
  if (!conversation) return;
  if (conversation.group) {
    const members = (conversation.members || [])
      .map((memberId) => state.users.find((item) => item.id === memberId))
      .filter(Boolean);
    const memberRows = members.length
      ? members.map((member) => `
          <div class="row" style="justify-content:space-between;border:1px solid var(--line);border-radius:10px;padding:8px 10px">
            <div class="row">
              ${renderAvatar(member)}
              <div>
                <strong>${escapeHtml(member.englishName || "Unknown")}</strong>
                <div class="muted">Grade ${escapeHtml(member.grade ?? "-")}, Class ${escapeHtml(member.classNo ?? "-")}</div>
              </div>
            </div>
            <span class="chip">${member.id === currentUser().id ? "You" : "Member"}</span>
          </div>
        `).join("")
      : `<p class="muted" style="margin:0">No member data available.</p>`;
    const popup = showFormPopup("Group Members", `
      <div class="grid">
        <p class="muted" style="margin:0">${escapeHtml(conversation.title || "Group chat")} · ${members.length} members</p>
        <div class="grid">${memberRows}</div>
        <div class="row">
          <button class="btn small" type="button" data-rename-conversation="${conversation.id}">Rename Chat</button>
          <button class="btn small danger" type="button" data-delete-conversation="${conversation.id}">Delete Chat</button>
        </div>
      </div>
    `);
    popup.querySelector('[data-rename-conversation]')?.addEventListener("click", async () => {
      popup.remove();
      await renameConversation(conversation.id);
    });
    popup.querySelector('[data-delete-conversation]')?.addEventListener("click", async () => {
      popup.remove();
      const ok = await askConfirmPopup("Delete Chat", "Delete this chat for you? Others will still see it.", "Delete");
      if (!ok) return;
      state.deletedChats = state.deletedChats || {};
      state.deletedChats[conversation.id] = true;
      saveState();
      if (activeConversationId === conversation.id) {
        const { inbox, requests, requestsSent } = classifyConversations();
        activeConversationId = inbox[0]?.id || requests[0]?.id || requestsSent[0]?.id || "";
      }
      toast("Chat deleted");
      render();
    });
    return;
  }

  const counterpartId = (conversation.members || []).find((memberId) => memberId !== currentUser().id) || "";
  const user = state.users.find((item) => item.id === counterpartId);
  if (!user) {
    showPopup("Profile", "This profile is currently unavailable.");
    return;
  }
  const popup = showFormPopup("Profile Preview", `
    <div class="grid">
      <div class="row">
        ${renderAvatar(user)}
        <div>
          <strong>${escapeHtml(user.englishName || "Unknown")}</strong>
          <div class="muted">${escapeHtml(user.chineseName || "")}</div>
        </div>
      </div>
      <div class="muted">Grade ${escapeHtml(user.grade ?? "-")}, Class ${escapeHtml(user.classNo ?? "-")}</div>
      <p style="margin:0">${escapeHtml(user.bio || "No bio yet.")}</p>
      <div class="row">
        <button class="btn small" type="button" data-action="view-profile" data-id="${user.id}">Open Full Profile</button>
        <button class="btn small" type="button" data-action="edit-remark" data-id="${user.id}">Set Remark</button>
        <button class="btn small" type="button" data-delete-conversation="${conversation.id}">Delete Chat</button>
      </div>
    </div>
  `);
  popup.querySelector('[data-action="view-profile"]')?.addEventListener("click", async () => {
    popup.remove();
    profileBackView = "messages";
    state.selectedProfileId = user.id;
    view = "profile";
    await refreshQnaForProfile(user.id);
    render();
  });
  popup.querySelector('[data-delete-conversation]')?.addEventListener("click", async () => {
    popup.remove();
    const ok = await askConfirmPopup("Delete Chat", "Delete this chat for you? Others will still see it.", "Delete");
    if (!ok) return;
    state.deletedChats = state.deletedChats || {};
    state.deletedChats[conversation.id] = true;
    saveState();
    if (activeConversationId === conversation.id) {
      const { inbox, requests, requestsSent } = classifyConversations();
      activeConversationId = inbox[0]?.id || requests[0]?.id || requestsSent[0]?.id || "";
    }
    toast("Chat deleted");
    render();
  });
}

async function renameConversation(conversationId) {
  const conv = state.conversations.find((item) => item.id === conversationId);
  if (!conv) return;
  const next = await askTextPopup("Rename Chat", "New title", conv.title || "Conversation");
  if (next == null) return;
  const title = next.trim();
  if (!title) return toast("Title cannot be empty");
  await apiRequest(`/conversations/${conversationId}`, { method: "PATCH", body: JSON.stringify({ title }) });
  await refreshConversations();
  toast("Chat title updated");
}

function renderProfile() {
  const me = currentUser();
  if (!me) return page("Profile", "Loading profile…", `<section class="panel"><p class="muted">Please wait.</p></section>`);
  const selected = state.users.find((u) => u.id === state.selectedProfileId);
  const user = selected || me;
  const questions = state.qna.filter((q) => q.profileId === user.id);
  const userPosts = (state.posts || [])
    .filter((post) => post.authorId === user.id && !post.deletedAt)
    .sort((a, b) => at(b.createdAt) - at(a.createdAt));
  const isOwnProfile = user.id === me.id;
  const followerCount = Number(user.followerCount ?? (Array.isArray(user.followers) ? user.followers.length : 0));
  const followingCount = Number(user.followingCount ?? (Array.isArray(user.following) ? user.following.length : 0));
  const followingUsers = isOwnProfile ? state.users.filter((item) => (user.following || []).includes(item.id)) : [];
  return page("Profile", "Your profile, updates, and question box.", `
    ${!isOwnProfile ? `<div class="row" style="margin-bottom:10px"><button class="btn small" data-action="profile-back">Back</button></div>` : ""}
    <section class="grid two">
      <div class="panel">
        <div class="row">${renderAvatar(user, user.role === "admin" ? "admin" : "")}<div><h2>${escapeHtml(user.englishName)}</h2><p class="muted">${escapeHtml(user.chineseName)} · Grade ${user.grade}, Class ${user.classNo}</p></div></div>
        <div style="margin-top:10px">
          <strong>Bio</strong>
          <p style="margin:6px 0 0">${escapeHtml(user.bio || "No bio added yet.")}</p>
        </div>
        <div class="row" style="margin-top:10px">
          <span class="chip">${followerCount} follower${followerCount === 1 ? "" : "s"}</span>
          <span class="chip">${followingCount} following</span>
        </div>
        <span class="status ${user.status === "verified" ? "green" : "gold"}">${user.status}</span>
        ${!isOwnProfile ? `
          <div class="row" style="margin-top:12px">
            <button class="btn" data-action="start-chat" data-id="${user.id}">Message</button>
          </div>
        ` : ""}
      </div>
      <div class="panel" style="min-height:200px">
        <div class="between" style="margin-bottom:10px">
          <h3 style="margin:0">Question Box</h3>
        </div>
        <div class="question-box-grid">
          ${!isOwnProfile ? `
            <button class="question-box-card question-box-compose" data-action="ask-qna" data-id="${user.id}">
              <strong>Send A Question</strong>
              <span>Tap to write and send a question to ${escapeHtml(user.englishName)}.</span>
            </button>
          ` : ""}
          ${questions.length ? questions.map((q) => `
            <button class="question-box-card" data-action="open-qna" data-id="${q.id}">
              <strong>${escapeHtml(q.question)}</strong>
              <span>${escapeHtml(q.answer || "Waiting for answer")}</span>
            </button>
          `).join("") : `<p class="muted">No questions yet.</p>`}
        </div>
      </div>
    </section>
    ${isOwnProfile ? `
      <section class="panel" style="margin-top:16px">
        <h3 style="margin-top:0">People You Follow</h3>
        ${followingUsers.length
          ? `<div class="row">${followingUsers.map((item) => `<button class="btn small" data-action="view-profile" data-id="${item.id}">${escapeHtml(item.englishName)}</button>`).join("")}</div>`
          : `<p class="muted">You are not following anyone yet.</p>`
        }
      </section>
    ` : ""}
    <section class="panel" style="margin-top:16px">
      <h3 style="margin-top:0">Posts</h3>
      ${userPosts.length
        ? `<div class="grid">${userPosts.map(renderPost).join("")}</div>`
        : `<p class="muted">This user has no posts.</p>`
      }
    </section>
  `);
}

function renderSuggestions() {
  const user = currentUser();
  if (!user) return page("Suggestions", "Loading suggestions...", `<section class="panel"><p class="muted">Please wait.</p></section>`);
  const rows = [...(state.suggestions || [])].sort((a, b) => at(b.created_at || b.createdAt) - at(a.created_at || a.createdAt));
  if (user.role === "admin") {
    return page("Suggestions", "Review student ideas and reply directly.", `
      <section class="panel">
        <h2 style="margin-top:0">Student Suggestions</h2>
        <div class="grid">
          ${rows.length ? rows.map((item) => {
            const parsed = parseSuggestionStatus(item.status);
            return `
              <article class="comment" style="margin:0">
                <div class="between">
                  <strong>${escapeHtml(userName(item.user_id || item.userId))}</strong>
                  <span class="muted">${new Date(at(item.created_at || item.createdAt)).toLocaleString()}</span>
                </div>
                <p style="margin:8px 0 6px">${escapeHtml(item.text || "")}</p>
                <p class="muted" style="margin:0">Status: ${escapeHtml(parsed.stage)}</p>
                ${parsed.response ? `<p class="muted" style="margin:6px 0 0"><strong>Response:</strong> ${escapeHtml(parsed.response)}</p>` : ""}
                <div class="row" style="margin-top:8px">
                  <button class="btn small" data-action="reply-suggestion" data-id="${item.id}">Reply</button>
                </div>
              </article>
            `;
          }).join("") : `<p class="muted">No suggestions submitted yet.</p>`}
        </div>
      </section>
    `);
  }
  return page("Suggestions", "Share ideas and track replies from admins.", `
    <section class="panel" style="margin-bottom:14px">
      <h2 style="margin-top:0">Send a Suggestion</h2>
      <div class="field">
        <label>Your suggestion</label>
        <textarea id="suggestion-text" placeholder="Share a platform idea, bug report, or improvement..."></textarea>
      </div>
      <div class="row">
        <button class="btn primary" data-action="submit-suggestion">Submit Suggestion</button>
      </div>
    </section>
    <section class="panel">
      <h2 style="margin-top:0">Your Suggestion History</h2>
      <div class="grid">
        ${rows.length ? rows.map((item) => {
          const parsed = parseSuggestionStatus(item.status);
          return `
            <article class="comment" style="margin:0">
              <p style="margin:0 0 6px">${escapeHtml(item.text || "")}</p>
              <p class="muted" style="margin:0">Status: ${escapeHtml(parsed.stage)}</p>
              ${parsed.response ? `<p class="muted" style="margin:6px 0 0"><strong>Admin response:</strong> ${escapeHtml(parsed.response)}</p>` : ""}
            </article>
          `;
        }).join("") : `<p class="muted">No suggestions submitted yet.</p>`}
      </div>
    </section>
  `);
}

function renderSettings() {
  const user = currentUser();
  if (!user) return page("Settings", "Loading settings...", `<section class="panel"><p class="muted">Please wait.</p></section>`);
  return page("Settings", "Update your profile and preferences.", `
    <section class="grid two">
      <form class="panel grid" id="settings-profile-form">
        <h3 style="margin:0">Profile Settings</h3>
        <div class="field"><label>English name</label><input id="settings-en" value="${escapeHtml(user.englishName || "")}" required></div>
        <div class="field"><label>Chinese name</label><input id="settings-cn" value="${escapeHtml(user.chineseName || "")}" required></div>
        <div class="grid two">
          <div class="field"><label>Year (1-12)</label><input id="settings-grade" type="number" min="1" max="12" value="${Number(user.grade || 10)}" required></div>
          <div class="field"><label>Class (1-13)</label><input id="settings-class" type="number" min="1" max="13" value="${Number(user.classNo || 1)}" required></div>
        </div>
        <div class="field"><label>Bio</label><textarea id="settings-bio" placeholder="Tell people about yourself">${escapeHtml(user.bio || "")}</textarea></div>
        <div class="field">
          <label>Profile picture</label>
          <div id="settings-photo-dropzone" class="dropzone">Drag and drop new profile photo here, or click to pick file.</div>
          <input id="settings-photo" type="file" accept="image/*">
          <div id="settings-photo-chips" class="file-chips"></div>
        </div>
        <div class="row"><button class="btn primary" type="submit">Save Settings</button></div>
      </form>
      <section class="panel">
        <h3 style="margin-top:0">Rules & Functions</h3>
        <p style="margin:0 0 12px"><strong>Verification:</strong> Only verified SHSID students can post and message.</p>
        <p style="margin:0 0 12px"><strong>Anonymous Posting:</strong> Choose anonymous when posting to hide your identity.</p>
        <p style="margin:0 0 12px"><strong>Direct Messages:</strong> Send public or anonymous messages to other students.</p>
        <p style="margin:0 0 12px"><strong>Reports:</strong> Report inappropriate content. Admins will review within 24 hours.</p>
        <p style="margin:0 0 12px"><strong>Suggestions:</strong> Submit feedback and track admin responses.</p>
        <p style="margin:0"><strong>Q&A Box:</strong> Other students can ask you questions on your profile.</p>
      </section>
      ${user.role === "admin" ? `
      <section class="panel">
        <h3 style="margin-top:0">Ad Manager</h3>
        <div class="grid two">
          <div class="field"><label>Slot</label><select id="ad-slot"><option value="top_banner">Top banner</option><option value="feed_inline">Feed inline</option><option value="students_inline">Students inline</option><option value="popup">Popup</option></select></div>
          <div class="field"><label>Title</label><input id="ad-title" placeholder="Ad title"></div>
          <div class="field"><label>Body</label><input id="ad-body" placeholder="Short ad text"></div>
          <div class="field"><label>URL (optional)</label><input id="ad-url" placeholder="https://..."></div>
          <div class="field"><label>Image URL (optional: PNG/JPG/WebP/GIF)</label><input id="ad-image-url" placeholder="https://.../ad-image.png"></div>
          <div class="field">
            <label>Upload image (optional)</label>
            <div id="ad-image-dropzone" class="dropzone">Drag and drop ad image here, or click to pick file.</div>
            <input id="ad-image-file" type="file" accept="image/*">
            <div id="ad-image-chips" class="file-chips"></div>
          </div>
        </div>
        <div class="row"><button class="btn primary" data-action="create-ad">Create Ad</button></div>
        <div class="grid" style="margin-top:12px">
          ${(state.ads || []).length ? (state.ads || []).map((ad) => `
            <div class="comment" style="margin:0">
              <strong>${escapeHtml(ad.slot || "slot")}</strong> · ${ad.active ? "active" : "inactive"}<br>
              ${escapeHtml(ad.title || "Untitled")}<br>
              <span class="muted">${escapeHtml(ad.body || "")}</span>
              ${ad.imageUrl ? `<div style="margin-top:8px"><img src="${escapeHtml(ad.imageUrl)}" alt="${escapeHtml(ad.title || "Ad image")}" style="max-width:220px;border-radius:8px;border:1px solid var(--line)" loading="lazy" /></div>` : ""}
              <div class="row" style="margin-top:8px">
                <button class="btn small" data-action="toggle-ad" data-id="${ad.id}">${ad.active ? "Disable" : "Enable"}</button>
                <button class="btn small danger" data-action="delete-ad" data-id="${ad.id}">Delete</button>
              </div>
            </div>
          `).join("") : `<p class="muted">No ads yet.</p>`}
        </div>
      </section>
      ` : ""}
    </section>
  `);
}

function renderAdmin() {
  if (currentUser().role !== "admin") return page("Unavailable", "Admin access required.", "");
  const pending = state.adminVerifications || [];
  const pendingReports = (state.reports || []).filter((report) => (report.status || "pending") === "pending");
  const conversations = (state.conversations || []).slice().sort((a, b) => at(b.createdAt) - at(a.createdAt));
  const filteredConversations = conversations.filter((conversation) => {
    if (adminChatMonitorFilter === "direct") return !conversation.group;
    if (adminChatMonitorFilter === "group") return conversation.group;
    return true;
  });
  const activeMonitored = filteredConversations.find((conversation) => conversation.id === adminActiveConversationId) || filteredConversations[0];
  const adminTabs = `
    <div class="row admin-subtabs">
      <button class="btn ${adminTab === "overview" ? "primary" : ""}" data-action="admin-tab" data-id="overview">Overview</button>
      <button class="btn ${adminTab === "chat" ? "primary" : ""}" data-action="admin-tab" data-id="chat">Chat Monitor</button>
    </div>
  `;
  return page("Admin", "Manage safety, verification, and moderation tools.", `
    <section class="admin-grid">
      ${adminTabs}
      ${adminTab === "chat" ? `
      <div class="panel admin-panel">
        <h2>Chat Monitor</h2>
        <div class="row" style="margin-bottom:12px">
          <button class="btn ${adminChatMonitorFilter === "all" ? "primary" : ""}" data-action="admin-chat-filter" data-id="all">All</button>
          <button class="btn ${adminChatMonitorFilter === "direct" ? "primary" : ""}" data-action="admin-chat-filter" data-id="direct">Direct</button>
          <button class="btn ${adminChatMonitorFilter === "group" ? "primary" : ""}" data-action="admin-chat-filter" data-id="group">Convo</button>
        </div>
        <div class="chat-layout admin-chat-layout">
          <div class="panel chat-panel chat-panel-list">
            <div class="grid chat-list-scroll">
            ${filteredConversations.length
              ? filteredConversations.map((conversation) => `<button class="btn ${activeMonitored?.id === conversation.id ? "primary" : ""}" data-action="admin-open-chat" data-id="${conversation.id}">${escapeHtml(conversationDisplayTitle(conversation, true))} · ${conversation.group ? "convo" : "direct"}</button>`).join("")
              : `<p class="muted">No chats for this filter.</p>`
            }
            </div>
          </div>
          <div class="panel chat-panel chat-panel-thread">
            <div class="between" style="margin-bottom:8px">
              <strong>${escapeHtml(activeMonitored ? conversationDisplayTitle(activeMonitored, true) : "No chat selected")}</strong>
              <span class="muted small">${activeMonitored ? `${activeMonitored.group ? "Group" : "Direct"} · ${(activeMonitored.members || []).length} members` : ""}</span>
            </div>
            <div class="grid chat-messages-scroll">
            ${(activeMonitored?.messages || []).map((message) => `
              <div class="comment admin-chat-message" style="margin:0">
                <strong>${escapeHtml(userName(message.authorId, message.anonymous))}:</strong> ${escapeHtml(message.text || "")}
                ${(message.media || []).map((item) => renderChatMediaItem(item)).join("")}
                <span class="muted">(${message.anonymous ? "anonymous" : "public"})</span>
                ${message.anonymous ? `<span class="muted">(real: ${escapeHtml(userName(message.authorId, false))})</span>` : ""}
              </div>
            `).join("") || `<p class="muted">No messages yet.</p>`}
            </div>
          </div>
        </div>
      </div>
      ` : `
      <div class="grid three">
        <div class="panel"><span class="muted">Pending verification</span><h2>${pending.length}</h2></div>
        <div class="panel"><span class="muted">Open reports</span><h2>${pendingReports.length}</h2></div>
        <div class="panel"><span class="muted">Audit events</span><h2>${state.audit.length}</h2></div>
      </div>
      <div class="panel admin-panel">
        <h2>Student Verification Queue</h2>
        <div class="table-wrap">
          <table class="table"><thead><tr><th>Student</th><th>Status</th><th>Video</th><th>Actions</th></tr></thead><tbody>
            ${pending.map((user) => `<tr><td>${escapeHtml(user.englishName)}<br><span class="muted">${escapeHtml(user.chineseName)} · G${user.grade} C${user.classNo}</span></td><td><span class="status gold">${user.status}</span></td><td>${user.verificationVideo ? `<span class="chip">${escapeHtml(user.verificationVideo)}</span>` : `<span class="muted">No video file</span>`}</td><td><div class="admin-actions"><button class="btn small primary" data-action="verify-user" data-id="${user.id}">Approve</button><button class="btn small danger" data-action="reject-user" data-id="${user.id}">Reject</button><button class="btn small danger" data-action="ban-user" data-id="${user.id}">Ban</button></div></td></tr>`).join("") || `<tr><td colspan="4" class="muted">No pending students.</td></tr>`}
          </tbody></table>
        </div>
      </div>
      <div class="panel admin-panel">
        <h2>Report Queue</h2>
        <div class="table-wrap">
          <table class="table"><thead><tr><th>Reporter</th><th>Reported User</th><th>Reason</th><th>Time</th><th>Status</th><th>Actions</th></tr></thead><tbody>
            ${pendingReports.map((report) => {
              const post = report.type === "post" ? state.posts.find((p) => p.id === report.targetId) : null;
              const reportedUser = post ? state.users.find((u) => u.id === post.authorId) : null;
              const preview = post ? (post.text?.slice(0, 60) || "Media post") : "View in system";
              return `<tr>
                <td><strong>${escapeHtml(userName(report.reporterId))}</strong><br><span class="muted">${report.reporterId ? state.users.find((u) => u.id === report.reporterId)?.englishName || "Unknown" : "Unknown"}</span></td>
                <td>${reportedUser ? `<strong>${escapeHtml(reportedUser.englishName || "Unknown")}</strong><br><span class="muted">${escapeHtml(reportedUser.chineseName || "")} · G${reportedUser.grade} C${reportedUser.classNo}</span>` : `<span class="muted">${escapeHtml(reportTargetHumanLabel(report))}</span><br><span class="muted">${escapeHtml(preview)}</span>`}</td>
                <td>${escapeHtml(report.reason || "-")}</td>
                <td><span class="muted">${new Date(report.createdAt).toLocaleDateString()}</span><br><span class="muted">${timeAgo(report.createdAt)}</span></td>
                <td><span class="status ${report.status === "resolved" ? "green" : "gold"}">${escapeHtml(report.status)}</span></td>
                <td><div class="admin-actions"><button class="btn small primary" data-action="handle-report" data-id="${report.id}">Handle</button></div></td>
              </tr>`;
            }).join("") || `<tr><td colspan="6" class="muted">No pending reports.</td></tr>`}
          </tbody></table>
        </div>
      </div>
      <div class="panel admin-panel">
        <h2>Audit Trail</h2>
        <div class="table-wrap">
          <table class="table"><thead><tr><th>Actor</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th><th>Time</th></tr></thead><tbody>
            ${state.audit.map((item) => `<tr><td>${escapeHtml(userName(item.userId))}<br><span class="muted">${escapeHtml(item.userId || "-")}</span></td><td>${escapeHtml(formatActionLabel(item.action))}</td><td>${auditTargetHtml(item)}</td><td>${auditDetailsHtml(item)}</td><td>${escapeHtml(item.ip || "-")}</td><td>${new Date(item.createdAt).toLocaleString()}<br><span class="muted">${timeAgo(item.createdAt)} ago</span></td></tr>`).join("")}
          </tbody></table>
        </div>
      </div>
      `}
    </section>
  `);
}

function renderRightbar() {
  const user = currentUser();
  const unread = state.notifications.filter((item) => item.userId === user.id && !item.read);
  const leaders = [...state.posts]
    .sort((a, b) => (Array.isArray(b.likes) ? b.likes.length : 0) - (Array.isArray(a.likes) ? a.likes.length : 0))
    .slice(0, 3);
  const isAdmin = user?.role === "admin";
  return `
    <div class="grid">
      <section class="panel">
        <div class="between"><strong>Notifications</strong><button class="btn small" data-action="mark-read">Read</button></div>
        ${unread.length ? unread.map((n) => {
          const expanded = expandedNotificationId === n.id;
          return `
            <button class="notification-card ${expanded ? "expanded" : ""}" data-action="toggle-notification" data-id="${n.id}" type="button">
              <div class="notification-head">
                <strong>${escapeHtml(notificationTypeLabel(n.type))}</strong>
                <span class="muted">${escapeHtml(timeAgo(n.createdAt))}</span>
              </div>
              <p class="notification-summary">${escapeHtml(notificationSummary(n))}</p>
              ${expanded ? `<p class="notification-details">${escapeHtml(notificationDetails(n))}</p>` : ""}
              <span class="notification-expand-hint">${expanded ? "Collapse" : "Tap for details"}</span>
            </button>
          `;
        }).join("") : `<p class="muted">No unread notifications.</p>`}
      </section>
      <section class="panel">
        <strong>Post of the Day</strong>
        ${leaders.map((post) => `<button class="comment post-day-item" style="margin:10px 0 0;text-align:left;width:100%" data-action="open-post-day" data-id="${post.id}">${escapeHtml(post.category)} · ${post.likes.length} likes<br>${escapeHtml(post.text.slice(0, 80))}</button>`).join("")}
      </section>
      ${isAdmin ? `<section class="panel">
        <strong>Safety Status</strong>
        <p class="muted">Rate limits, upload scanning, email delivery, and push delivery are production backend tasks documented in the launch plan.</p>
      </section>` : ""}
    </div>
  `;
}

function renderNotificationsPanelOnly() {
  const rightbar = document.querySelector(".rightbar");
  if (!rightbar) return;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = renderRightbar();
  const next = wrapper.firstElementChild;
  if (!next) return;
  rightbar.innerHTML = next.innerHTML;
  const markReadButton = rightbar.querySelector('[data-action="mark-read"]');
  if (markReadButton) {
    markReadButton.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (markReadButton.dataset.busy === "1") return;
      markReadButton.dataset.busy = "1";
      markReadButton.disabled = true;
      try {
        await handleAction("mark-read", "");
      } finally {
        markReadButton.dataset.busy = "0";
        markReadButton.disabled = false;
      }
    };
  }
  rightbar.querySelectorAll('[data-action="open-post-day"]').forEach((button) => {
    button.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const id = button.dataset.id || "";
      if (!id) return;
      await handleAction("open-post-day", id);
    };
  });
  rightbar.querySelectorAll('[data-action="toggle-notification"]').forEach((button) => {
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const id = button.dataset.id || "";
      if (!id) return;
      expandedNotificationId = expandedNotificationId === id ? "" : id;
      renderNotificationsPanelOnly();
    };
  });
}

let renderFrameScheduled = false;
let navRefreshSeq = 0;

function navDataSignature(targetView) {
  if (targetView === "messages") {
    return JSON.stringify((state.conversations || []).map((conv) => [conv.id, (conv.messages || []).length, conv.updatedAt || "", conv.lastMessageAt || ""]));
  }
  if (targetView === "suggestions") {
    return JSON.stringify((state.suggestions || []).map((item) => [item.id, item.status || "", item.updatedAt || "", item.createdAt || item.created_at || ""]));
  }
  if (targetView === "profile") {
    const profileId = state.selectedProfileId || state.currentUserId || "";
    const rows = (state.qna || []).filter((item) => item.profileId === profileId);
    return JSON.stringify(rows.map((item) => [item.id, item.answer || "", item.updatedAt || "", item.createdAt || ""]));
  }
  if (targetView === "feed") {
    return JSON.stringify((state.posts || []).map((post) => [post.id, post.updatedAt || "", post.createdAt || "", (post.comments || []).length, (post.likes || []).length, (post.hearts || []).length, (post.savedBy || []).length]));
  }
  if (targetView === "admin") {
    return JSON.stringify({
      v: (state.adminVerifications || []).map((item) => [item.id, item.status || "", item.updatedAt || ""]),
      r: (state.reports || []).map((item) => [item.id, item.status || "", item.resolvedAt || "", item.updatedAt || ""]),
      a: (state.audit || []).map((item) => [item.id, item.createdAt || "", item.action || ""])
    });
  }
  return "";
}

async function refreshDataForView(targetView, seq) {
  const before = navDataSignature(targetView);
  try {
    if (targetView === "profile") {
      await refreshQnaForProfile(state.selectedProfileId || state.currentUserId);
    }
    if (targetView === "suggestions") await refreshSuggestions();
    if (targetView === "admin") {
      await refreshAdminVerifications();
      await refreshReports();
      await refreshAuditLogs();
    }
    if (targetView === "messages") await refreshConversations();
    if (targetView === "feed") {
      if (!(state.posts || []).length) await refreshPosts();
      else {
        void ensurePostsAhead();
        void warmCategoryPools();
      }
    }
  } catch (error) {
    console.error("refreshDataForView failed", error);
  } finally {
    const after = navDataSignature(targetView);
    if (seq === navRefreshSeq && before !== after) render();
  }
}

function bindEvents() {
  const appRoot = document.querySelector("#app");
  if (appRoot) appRoot.onclick = async (event) => {
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      event.preventDefault();
      event.stopPropagation();
      if (postPublishInFlight || uploadUi.active) {
        toast("Upload in progress. Please wait for completion.");
        return;
      }
      const nextView = viewButton.dataset.view;
      if (!nextView) return;
      const isSwap = nextView !== view;
      if (!isSwap) return;
      const wasFeed = view === "feed";
      const wasMessages = view === "messages";
      const wasAdmin = view === "admin";
      const wasSinglePost = view === "single-post";
      view = nextView;
      if (view === "profile") {
        state.selectedProfileId = null;
      }
      if (wasFeed) pauseAllVideos();
      if (wasMessages) stopLiveChatLoop();
      if (wasAdmin) stopVerificationQueueLoop();
      if (wasSinglePost && view !== "single-post") {
        deepLinkedPostId = "";
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete("post");
          window.history.replaceState({}, "", url.toString());
        } catch {}
      }
      render();
      state.adSwapCount = Number(state.adSwapCount || 0) + 1;
      const nowMs = Date.now();
      const popupCooldownOk = nowMs - Number(state.adLastPopupAt || 0) >= 60_000;
      if (state.adSwapCount >= Number(state.nextAdPopupAt || 6) && popupCooldownOk) {
        const popupAd = activeAdsBySlot("popup")[0];
        if (popupAd && (popupAd.title || popupAd.body || popupAd.url)) {
          showPopup(popupAd.title || "Sponsored", `${popupAd.body || "Ad placeholder"}${popupAd.url ? `\n\n${popupAd.url}` : ""}`);
          state.adLastPopupAt = nowMs;
        }
        state.adSwapCount = 0;
        state.nextAdPopupAt = nextAdPopupThreshold();
      }
      saveState();
      navRefreshSeq += 1;
      void refreshDataForView(view, navRefreshSeq);
      return;
    }

    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;
    event.preventDefault();
    event.stopPropagation();
    if (actionButton.dataset.busy === "1") return;
    actionButton.dataset.busy = "1";
    actionButton.disabled = true;
    try {
      await handleAction(actionButton.dataset.action, actionButton.dataset.id);
    } catch (error) {
      toast(error.message || "Action failed");
    } finally {
      actionButton.dataset.busy = "0";
      actionButton.disabled = false;
    }
  };

  const feedSearch = document.querySelector("#feed-search");
  if (feedSearch) feedSearch.oninput = (event) => {
    const query = String(event.target.value || "").trim();
    state.feedSearchQuery = query;
    saveState();
    resetFeedVideoState();
    pauseAllFeedVideos();
    render();
  };
  const feedFilter = document.querySelector("#feed-engagement-filter");
  if (feedFilter) feedFilter.onchange = (event) => {
    state.feedEngagementFilter = String(event.target.value || "all");
    saveState();
    resetFeedVideoState();
    pauseAllFeedVideos();
    render();
  };

  const messageBox = document.querySelector("#message-text");
  if (messageBox) messageBox.onkeydown = async (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    const sendButton = document.querySelector('[data-action="send-message"]');
    const conversationId = sendButton?.dataset?.id || "";
    if (!conversationId || sendButton?.disabled || sendButton?.dataset?.busy === "1") return;
    sendButton.dataset.busy = "1";
    sendButton.disabled = true;
    try {
      await handleAction("send-message", conversationId);
    } catch (error) {
      toast(error.message || "Action failed");
    } finally {
      sendButton.dataset.busy = "0";
      sendButton.disabled = false;
    }
  };

  document.querySelectorAll('input[id^="comment-text-"]').forEach((input) => {
    input.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      const postId = String(input.id || "").replace(/^comment-text-/, "").trim();
      if (!postId) return;
      try {
        await handleAction("submit-comment", postId);
      } catch (error) {
        toast(error?.message || "Comment failed");
      }
    });
  });

  setupDropzone("post-dropzone", "post-media", true);  bindFileChips("post-media", "post-file-chips");
  setupDropzone("ad-image-dropzone", "ad-image-file", false); bindFileChips("ad-image-file", "ad-image-chips");
  bindMessageAttachmentStrip();
}

function bindAuth() {
  document.querySelector("#auth-email-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const intent = event.submitter?.dataset.authIntent || authEmailSubmitIntent || "login";
    try {
      await handleEmailAuthIntent(intent);
    } catch (error) {
      console.error("auth-email-form submit failed", { intent, error });
      toast(error.message || "Could not continue");
    }
  });
  document.querySelector('[data-auth-intent="register"]')?.addEventListener("click", async (event) => {
    event.preventDefault();
    authEmailSubmitIntent = "register";
    try {
      await handleEmailAuthIntent("register");
    } catch (error) {
      console.error("auth-register click failed", error);
      toast(error.message || "Could not continue");
    }
  });
  document.querySelector('[data-auth-intent="login"]')?.addEventListener("click", async (event) => {
    event.preventDefault();
    authEmailSubmitIntent = "login";
    try {
      await handleEmailAuthIntent("login");
    } catch (error) {
      console.error("auth-login click failed", error);
      toast(error.message || "Could not continue");
    }
  });

  document.querySelectorAll('[data-auth="back"], [data-auth="resend-code"], [data-auth="logout"]').forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.auth;
      try {
        if (action === "resend-code") {
          if (authRequestInFlight) return;
          if (resendCooldownLeft() > 0) return;
          const email = state.pendingEmail;
          if (!email) return toast("Enter an email");
          setAuthInFlight(true);
          const result = await apiRequest("/auth/start", { method: "POST", body: JSON.stringify({ email }) });
          startResendCooldown(30);
          showPopup(
            "Verification Code Resent",
            result.devCode
              ? `Dev mode code: ${result.devCode}`
              : "A new verification code has been sent. Check Spam/Junk if it does not arrive soon."
          );
          setAuthInFlight(false);
          render();
        }
        if (action === "back") {
          if (state.authMode === "register" && state.authStep === "password") state.authStep = "verify";
          else state.authStep = "email";
          saveState();
          render();
        }
        if (action === "logout") {
          const logoutUserId = state.currentUserId;
          if (logoutUserId) rememberLoginMediaForUser(logoutUserId);
          try {
            if (state.apiToken) await apiRequest("/auth/logout", { method: "POST", body: JSON.stringify({}) });
          } catch {
            // ignore
          }
          resetClientSessionState();
          saveState();
          render();
        }
      } catch (error) {
        setAuthInFlight(false);
        toast(error.message);
      }
    });
  });

  document.querySelector("#auth-verify-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (authRequestInFlight) return;
    const code = String(document.querySelector("#auth-code").value || "").replace(/[\s-]+/g, "");
    document.querySelector("#auth-code").value = code;
    if (!code) return toast("Enter the verification code");
    try {
      setAuthInFlight(true);
      await apiRequest("/auth/verify-code", {
        method: "POST",
        body: JSON.stringify({ email: state.pendingEmail, code })
      });
      state.pendingCode = code;
      state.authStep = "password";
      saveState();
      render();
    } catch (error) {
      toast(error.message || "Invalid verification code");
    } finally {
      setAuthInFlight(false);
    }
  });

  document.querySelector("#auth-password-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const email = state.pendingEmail;
      const password = document.querySelector("#auth-password").value;
      if (!password) return toast("Enter a password");
      if (state.authMode === "register") {
        const confirmPassword = document.querySelector("#auth-password-confirm").value;
        if (!confirmPassword) return toast("Confirm your password");
        if (confirmPassword !== password) return toast("Passwords do not match");
      }

      const payload = state.authMode === "register"
        ? {
            email,
            password,
            code: state.pendingCode
          }
        : { email, password };

      if (state.authMode === "register" && !payload.code) return toast("Enter the verification code");

      const endpoint = state.authMode === "register" ? "/auth/register" : "/auth/login";
      const result = await apiRequest(endpoint, { method: "POST", body: JSON.stringify(payload) });
      state.apiToken = result.session.token;
      mergeApiUser(result.user);
      await refreshStudents();
      if (result.user.role === "admin") await refreshAdminVerifications();
      state.authStep = nextAuthStepForUser(result.user);
      view = result.user.status === "verified" ? "feed" : "profile";
      saveState();
      render();
    } catch (error) {
      toast(error.message || "Couldn't create password, please try again");
    }
  });

  document.querySelector("#auth-profile-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const firstName = document.querySelector("#reg-first")?.value.trim() || "";
    const middleName = document.querySelector("#reg-middle")?.value.trim() || "";
    const lastName = document.querySelector("#reg-last")?.value.trim() || "";
    const chineseName = document.querySelector("#reg-cn")?.value.trim() || "";
    const grade = Number(document.querySelector("#reg-grade")?.value);
    const classNo = Number(document.querySelector("#reg-class")?.value);
    const photoFile = document.querySelector("#reg-photo")?.files?.[0];
    if (!firstName || !lastName) return toast("Enter your first and last name");
    if (!Number.isInteger(grade) || grade < 1 || grade > 12) return toast("Year must be 1-12");
    if (!Number.isInteger(classNo) || classNo < 1 || classNo > 13) return toast("Class must be 1-13");
    const englishName = middleName ? `${firstName} ${middleName} ${lastName}` : `${firstName} ${lastName}`;
    state.pendingEnglishName = englishName;
    state.pendingChineseName = chineseName;
    state.pendingGrade = grade;
    state.pendingClassNo = classNo;
    state.pendingProfilePhoto = "";
    if (photoFile && (photoFile.type || "").startsWith("image/")) {
      const [uploadedPhoto] = await uploadFiles([photoFile]);
      state.pendingProfilePhoto = uploadedPhoto?.url || "";
    }
    state.pendingVerificationWords = generateVerificationWords(10);
    state.authStep = "video";
    saveState();
    render();
  });

  document.querySelector("#auth-video-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      setAuthInFlight(true);
      const videoInput = document.querySelector("#reg-video");
      const videoFile = videoInput?.files?.[0];
      if (!videoFile) return toast("Upload a verification video");
      if (!(videoFile.type || "").startsWith("video/")) return toast("Please upload a valid video file.");
      state.pendingVideoName = videoFile.name;
      const uploadedVideoUrl = await uploadVerificationVideoMultipart(videoFile);
      const result = await apiRequest("/auth/complete-profile", {
        method: "POST",
        body: JSON.stringify({
          englishName: state.pendingEnglishName,
          chineseName: state.pendingChineseName,
          grade: Number(state.pendingGrade),
          classNo: Number(state.pendingClassNo),
          profilePhoto: String(state.pendingProfilePhoto || ""),
          verificationVideo: uploadedVideoUrl || videoFile.name
        })
      });
      mergeApiUser(result.user);
      state.authStep = "waiting";
      saveState();
      render();
      toast("Submitted for admin review");
    } catch (error) {
      toast(error.message || "Video upload failed. Please try again.");
    } finally {
      setAuthInFlight(false);
    }
  });

  setupDropzone("verify-dropzone", "reg-video", false);
  bindFileChips("reg-video", "verify-file-chips");
  setupDropzone("reg-photo-dropzone", "reg-photo", false);
  bindFileChips("reg-photo", "reg-photo-chips");
  setupDropzone("settings-photo-dropzone", "settings-photo", false);
  bindFileChips("settings-photo", "settings-photo-chips");

  document.querySelector("#settings-profile-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const englishName = String(document.querySelector("#settings-en")?.value || "").trim();
    const chineseName = String(document.querySelector("#settings-cn")?.value || "").trim();
    const grade = Number(document.querySelector("#settings-grade")?.value);
    const classNo = Number(document.querySelector("#settings-class")?.value);
    const bio = String(document.querySelector("#settings-bio")?.value || "").trim();
    if (!englishName || !chineseName) return toast("Enter both names");
    if (!Number.isInteger(grade) || grade < 1 || grade > 12) return toast("Year must be 1-12");
    if (!Number.isInteger(classNo) || classNo < 1 || classNo > 13) return toast("Class must be 1-13");
    let profilePhoto = String(currentUser()?.profilePhoto || "");
    const photoFile = document.querySelector("#settings-photo")?.files?.[0];
    if (photoFile) {
      if (!(photoFile.type || "").startsWith("image/")) return toast("Profile picture must be an image");
      const [uploadedPhoto] = await uploadFiles([photoFile]);
      profilePhoto = uploadedPhoto?.url || profilePhoto;
    }
    const result = await apiRequest("/me/profile", {
      method: "PATCH",
      body: JSON.stringify({ englishName, chineseName, grade, classNo, bio, profilePhoto })
    });
    mergeApiUser(result.user);
    saveState();
    toast("Settings saved");
    render();
  });

}

async function handleAction(action, id) {
  const user = currentUser();
  if ((postPublishInFlight || uploadUi.active) && !["media-prev", "media-next"].includes(action)) {
    toast("Upload in progress. Please wait for completion.");
    return;
  }
  if (action === "open-media") return;
  if (action === "open-settings") view = "settings";
  if (action === "logout") {
    const logoutUserId = state.currentUserId;
    if (logoutUserId) rememberLoginMediaForUser(logoutUserId);
    try {
      if (state.apiToken) await apiRequest("/auth/logout", { method: "POST", body: JSON.stringify({}) });
    } catch {
      // ignore
    }
    resetClientSessionState();
  }
  if (action === "create-post") {
    if (postPublishInFlight) return;
    postPublishInFlight = true;
    const title = document.querySelector("#post-title")?.value?.trim() || "";
    const postTextInput = document.querySelector("#post-text");
    const postMediaInput = document.querySelector("#post-media");
    if (!postTextInput || !postMediaInput) {
      postPublishInFlight = false;
      return toast("Post form is not ready");
    }
    const text = String(postTextInput.value || "").trim();
    const files = [...(postMediaInput.files || [])].slice(0, 20);
    try {
      if (!text && !files.length) {
        toast("Write something or attach media");
        return;
      }
      const media = files.length ? await uploadFiles(files) : [];
      await apiRequest("/posts", {
        method: "POST",
        body: JSON.stringify({
          title,
          text,
          anonymous: document.querySelector("#post-anon")?.value === "true",
          category: document.querySelector("#post-category")?.value || "school",
          media
        })
      });
      inputFileStore["post-media"] = [];
      const postMediaInput = document.querySelector("#post-media");
      if (postMediaInput) {
        inputFileSyncLock.add("post-media");
        setInputFiles(postMediaInput, []);
        inputFileSyncLock.delete("post-media");
      }
      await refreshPosts();
      view = "feed";
      toast("Post published");
    } finally {
      postPublishInFlight = false;
    }
  }
  if (action === "load-more-posts") {
    if (postsNextOffset == null) return;
    if (loadMorePostsInFlight) return;
    loadMorePostsInFlight = true;
    const container = document.querySelector("#load-more-container");
    if (container) container.innerHTML = `<span class="muted">Loading...</span>`;
    try {
      await refreshPosts(false);
      resetFeedVideoState();
      if (container) {
        container.innerHTML = postsNextOffset != null
          ? `<button class="btn" data-action="load-more-posts">Load more posts</button>`
          : "";
      }
    } finally {
      loadMorePostsInFlight = false;
    }
    render();
    return;
  }
  if (action === "like-post") {
    if (!id) return toast("Invalid post");
    try {
      const result = await apiRequest(`/posts/${id}/like`, { method: "POST", body: JSON.stringify({}) });
      const idx = state.posts.findIndex((item) => item.id === id);
      if (idx >= 0) state.posts[idx] = normalizePost(result.post);
      saveState();
      if (!syncPostActionButtons(id)) rerenderPostCard(id, { preserveVideoPlayback: true });
      return;
    } catch (err) { console.error("like-post failed", err); }
  }
  if (action === "heart-post") {
    if (!id) return toast("Invalid post");
    try {
      const result = await apiRequest(`/posts/${id}/heart`, { method: "POST", body: JSON.stringify({}) });
      const idx = state.posts.findIndex((item) => item.id === id);
      if (idx >= 0) state.posts[idx] = normalizePost(result.post);
      saveState();
      if (!syncPostActionButtons(id)) rerenderPostCard(id, { preserveVideoPlayback: true });
      return;
    } catch (err) { console.error("heart-post failed", err); }
  }
  if (action === "save-post") {
    if (!id) return toast("Invalid post");
    try {
      const result = await apiRequest(`/posts/${id}/save`, { method: "POST", body: JSON.stringify({}) });
      const idx = state.posts.findIndex((item) => item.id === id);
      if (idx >= 0) state.posts[idx] = normalizePost(result.post);
      saveState();
      if (!syncPostActionButtons(id)) rerenderPostCard(id, { preserveVideoPlayback: true });
      return;
    } catch (err) { console.error("save-post failed", err); }
  }
  if (action === "media-prev") {
    if (!id) return toast("Invalid post");
    const post = state.posts.find((item) => item.id === id);
    if (!post) return toast("Post not found");
    const total = post?.media?.length || 0;
    if (!total) return;
    const current = postMediaIndexByPostId[id] || 0;
    postMediaIndexByPostId[id] = Math.max(0, current - 1);
    updatePostMediaCarousel(id);
    return;
  }
  if (action === "media-next") {
    if (!id) return toast("Invalid post");
    const post = state.posts.find((item) => item.id === id);
    if (!post) return toast("Post not found");
    const total = post?.media?.length || 0;
    if (!total) return;
    const current = postMediaIndexByPostId[id] || 0;
    postMediaIndexByPostId[id] = Math.min(total - 1, current + 1);
    updatePostMediaCarousel(id);
    return;
  }
  if (action === "comment-post") {
    if (!id) return toast("Invalid post");
    if (!state.posts.some((item) => item.id === id)) return toast("Post not found");
    openCommentPostId = openCommentPostId === id ? null : id;
    if (openCommentPostId !== id) openReplyCommentKey = null;
    saveState();
    rerenderPostCard(id, { preserveVideoPlayback: true });
    return;
  }
  if (action === "close-comment") {
    const targetPostId = openCommentPostId;
    openCommentPostId = null;
    if (String(openReplyCommentKey || "").startsWith(`${id}:`)) openReplyCommentKey = null;
    if (targetPostId && state.posts.some((item) => item.id === targetPostId)) {
      saveState();
      rerenderPostCard(targetPostId, { preserveVideoPlayback: true });
      return;
    }
  }
  if (action === "reply-comment") {
    const [postId, commentId] = String(id || "").split(":");
    if (!postId || !commentId) return toast("Invalid reply target");
    const post = state.posts.find((item) => item.id === postId);
    if (!post || !(post.comments || []).some((comment) => comment.id === commentId)) return toast("Comment not found");
    openReplyCommentKey = openReplyCommentKey === id ? null : id;
    saveState();
    rerenderPostCard(postId, { preserveVideoPlayback: true });
    return;
  }
  if (action === "close-reply") {
    const priorKey = openReplyCommentKey;
    openReplyCommentKey = null;
    const priorPostId = String(priorKey || "").split(":")[0];
    if (priorPostId && state.posts.some((item) => item.id === priorPostId)) {
      saveState();
      rerenderPostCard(priorPostId, { preserveVideoPlayback: true });
      return;
    }
  }
  if (action === "submit-comment") {
    if (!id) return toast("Invalid post");
    const post = state.posts.find((item) => item.id === id);
    if (!post) return toast("Post not found");
    const text = String(document.querySelector(`#comment-text-${id}`)?.value || "").trim();
    if (!text) return toast("Enter a comment");
    await apiRequest(`/posts/${id}/comments`, { method: "POST", body: JSON.stringify({ text, anonymous: false }) });
    await refreshPosts();
    saveState();
    rerenderPostCard(id, { preserveVideoPlayback: true });
    return;
  }
  if (action === "submit-reply") {
    const [postId, commentId] = String(id || "").split(":");
    if (!postId || !commentId) return toast("Invalid reply target");
    const post = state.posts.find((item) => item.id === postId);
    if (!post) return toast("Post not found");
    if (!(post.comments || []).some((comment) => comment.id === commentId)) return toast("Comment not found");
    const text = String(document.querySelector(`#reply-text-${postId}-${commentId}`)?.value || "").trim();
    const anonymous = document.querySelector(`#reply-anon-${postId}-${commentId}`)?.value === "true";
    if (!text) return toast("Enter a reply");
    await apiRequest(`/posts/${postId}/comments`, { method: "POST", body: JSON.stringify({ text, anonymous, replyTo: commentId }) });
    openReplyCommentKey = null;
    await refreshPosts();
    saveState();
    rerenderPostCard(postId, { preserveVideoPlayback: true });
    return;
  }
  if (action === "like-comment") {
    const [postId, commentId] = String(id || "").split(":");
    if (!postId || !commentId) return toast("Invalid comment target");
    const post = state.posts.find((item) => item.id === postId);
    if (!post) return toast("Post not found");
    if (!(post.comments || []).some((comment) => comment.id === commentId && !comment.deletedAt)) return toast("Comment not found");
    try {
      const result = await apiRequest(`/posts/${postId}/comments/${commentId}/like`, { method: "POST", body: JSON.stringify({}) });
      const idx = state.posts.findIndex((item) => item.id === postId);
      if (idx >= 0 && result?.post) state.posts[idx] = normalizePost(result.post);
      saveState();
      if (!syncCommentLikeButton(postId, commentId)) rerenderPostCard(postId, { preserveVideoPlayback: true });
      return;
    } catch (err) {
      console.error("like-comment failed", err);
      toast("Failed to like comment");
      return;
    }
  }
  if (action === "report-post") {
    if (!id) return toast("Invalid post");
    const reason = await askTextPopup("Report Post", "Reason", "Describe the issue");
    const cleanReason = String(reason || "").trim();
    if (!cleanReason) return;
    await apiRequest("/reports", { method: "POST", body: JSON.stringify({ targetType: "post", targetId: id, reason: cleanReason }) });
    toast("Report submitted");
    if (user.role === "admin") await refreshReports();
  }
  if (action === "share-post") {
    if (!id) return toast("Invalid post");
    const shareUrl = `${window.location.origin}/?post=${encodeURIComponent(id)}`;
    const post = state.posts.find((item) => item.id === id);
    const text = post?.text ? post.text.slice(0, 120) : "Check this post";
    showSharePopup(shareUrl, text, id);
    return;
  }
  if (action === "open-post-day") {
    if (!id) return toast("Invalid post");
    const wasFeed = view === "feed";
    deepLinkedPostId = id;
    view = "single-post";
    await ensureDeepLinkedPostLoaded();
    if (!state.posts.some((post) => post.id === id)) {
      view = "feed";
      deepLinkedPostId = "";
      return toast("Post not found");
    }
    if (wasFeed) pauseAllVideos();
    render();
    return;
  }
  if (action === "back-feed") {
    view = "feed";
    deepLinkedPostId = "";
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("post");
      window.history.replaceState({}, "", url.toString());
    } catch {
      // ignore
    }
  }
  if (action === "toggle-sticky") {
    if (!id) return toast("Invalid post");
    const post = state.posts.find((item) => item.id === id);
    if (!post) return;
    try {
      const result = await apiRequest(`/posts/${id}`, { method: "PATCH", body: JSON.stringify({ sticky: !post.sticky }) });
      const idx = state.posts.findIndex((item) => item.id === id);
      if (idx >= 0 && result?.post) state.posts[idx] = normalizePost(result.post);
      saveState();
      if (view === "feed" || view === "single-post") rerenderPostCard(id, { preserveVideoPlayback: true });
      toast(result?.post?.sticky ? "Pinned" : "Unpinned");
      return;
    } catch (error) {
      console.error("toggle-sticky failed", error);
      toast("Pin update failed");
      return;
    }
  }
  if (action === "delete-post") {
    if (!id) return toast("Invalid post");
    const ok = await askConfirmPopup("Delete Post", "This will delete the post from feed. Continue?", "Delete");
    if (!ok) return;
    await apiRequest(`/posts/${id}`, { method: "DELETE" });
    await refreshPosts();
    toast("Post deleted");
  }
  if (action === "delete-comment") {
    const [postId, commentId] = String(id || "").split(":");
    if (!postId || !commentId) return toast("Invalid comment target");
    const post = state.posts.find((item) => item.id === postId);
    if (!post) return toast("Post not found");
    if (!(post.comments || []).some((comment) => comment.id === commentId)) return toast("Comment not found");
    const ok = await askConfirmPopup("Delete Comment", "This will remove the comment. Continue?", "Delete");
    if (!ok) return;
    await apiRequest(`/posts/${postId}/comments/${commentId}`, { method: "DELETE" });
    await refreshPosts();
    toast("Comment deleted");
  }
  if (action === "follow") {
    if (!id) return toast("Invalid user");
    if (user.role === "admin") return toast("Admin cannot follow students");
    if (user.role !== "admin" && user.status !== "verified") return toast("Verification required before following");
    const target = state.users.find((item) => item.id === id);
    if (!target) return toast("User not found");
    if (target.role === "admin" || target.status !== "verified") return toast("Only verified students can be followed");
    if (target.id === user.id) return toast("You cannot follow yourself");
    const wasFollowing = Array.isArray(user.following) && user.following.includes(id);
    const result = await apiRequest(`/users/${id}/follow`, { method: "POST", body: JSON.stringify({}) });
    mergeApiUsers([result.user]);
    await refreshStudents();
    saveState();
    toast(wasFollowing ? "Unfollowed" : "Followed");
  }
  if (action === "view-profile") {
    if (!id || !state.users.some((item) => item.id === id)) return toast("Profile not found");
    profileBackView = view || "students";
    state.selectedProfileId = id;
    view = "profile";
    await refreshQnaForProfile(id);
  }
  if (action === "profile-back") {
    state.selectedProfileId = null;
    const nextView = ["students", "messages", "admin", "feed"].includes(profileBackView) ? profileBackView : "students";
    view = nextView === "profile" ? "students" : nextView;
    if (view === "admin" && user.role !== "admin") view = "students";
    if (view === "students") await refreshStudents();
    if (view === "messages") await refreshConversations();
    if (view === "admin") {
      await refreshAdminVerifications();
      await refreshReports();
      await refreshAuditLogs();
    }
    if (view === "feed") await refreshPosts();
  }
  if (action === "start-chat") {
    if (!id) return toast("Invalid user");
    if (id === user.id) return toast("You cannot message yourself");
    if (user.role !== "admin" && user.status !== "verified") return toast("Verification required before messaging");
    if (startChatInFlight) return;
    const target = state.users.find((item) => item.id === id);
    if (!target || (target.role !== "admin" && target.status !== "verified")) return toast("Only verified students or admins can be messaged");
    startChatInFlight = true;
    try {
      const mode = await askIdentityModePopup(target.englishName || "student");
      if (!mode) return;
      const result = await apiRequest("/conversations", { method: "POST", body: JSON.stringify({ memberIds: [id], group: false }) });
      setConversationIdentityMode(result.conversation.id, mode);
      conversationTab = "sent";
      await refreshConversations();
      activeConversationId = result.conversation.id;
      view = "messages";
    } finally {
      startChatInFlight = false;
    }
  }
  if (action === "send-message") {
    const conversation = state.conversations.find((item) => item.id === id);
    if (!conversation || !id) return toast("Select a conversation first");
    if (state.deletedChats?.[id]) return toast("Conversation not found");
    const meId = currentUser()?.id;
    if (!meId) return toast("Please log in first");
    if (currentUser()?.role !== "admin" && !(conversation.members || []).includes(meId)) return toast("Conversation not found");
    const firstAuthorId = conversation?.messages?.[0]?.authorId || "";
    const acceptedByLocal = Boolean(state.acceptedRequests?.[id]);
    const acceptedByReply = Boolean(firstAuthorId && (conversation?.messages || []).some((message) => message.authorId && message.authorId !== firstAuthorId));
    const accepted = acceptedByLocal || acceptedByReply;
    if (!accepted && firstAuthorId && firstAuthorId !== user.id) return toast("Accept request before replying");
    const messageInput = document.querySelector("#message-text");
    if (!messageInput) return toast("Message input is not ready");
    const text = String(messageInput.value || "").trim();
    const mediaFiles = [...(document.querySelector("#message-media-file")?.files || [])];
    const docFiles = [...(document.querySelector("#message-doc-file")?.files || [])];
    const uploadFilesList = [...mediaFiles, ...docFiles];
    if ((!text && !uploadFilesList.length) || !id) return toast("Enter a message or attach media");
    const media = uploadFilesList.length ? await uploadFiles(uploadFilesList) : [];
    const anonymous = getConversationIdentityMode(id) === "anonymous";
    await apiRequest(`/conversations/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, media, anonymous })
    });
    messageInput.value = "";
    inputFileStore["message-media-file"] = [];
    inputFileStore["message-doc-file"] = [];
    const mediaInput = document.querySelector("#message-media-file");
    if (mediaInput) setInputFiles(mediaInput, []);
    const docInput = document.querySelector("#message-doc-file");
    if (docInput) setInputFiles(docInput, []);
    drawMessageAttachmentStrip();
    await refreshConversations();
  }
  if (action === "edit-remark") {
    if (!id) return toast("Invalid user");
    if (!state.users.some((item) => item.id === id)) return toast("User not found");
    if (id === currentUser()?.id) return toast("You cannot set a remark for yourself");
    const existing = getRemarkForUser(id);
    const next = await askTextPopup("Set Remark", "Remark name", existing || "Enter remark");
    if (next == null) return;
    setRemarkForUser(id, next);
    render();
    return;
  }
  if (action === "open-conv") {
    if (!id || !state.conversations.some((item) => item.id === id) || state.deletedChats?.[id]) return toast("Conversation not found");
    const convo = state.conversations.find((item) => item.id === id);
    const meId = currentUser()?.id;
    if (!meId) return toast("Please log in first");
    if (currentUser()?.role !== "admin" && !(convo?.members || []).includes(meId)) return toast("Conversation not found");
    activeConversationId = id;
  }
  if (action === "rename-conv") {
    if (!id) return toast("Conversation not found");
    await renameConversation(id);
  }
  if (action === "chat-info") {
    if (!id) return toast("Conversation not found");
    const conv = state.conversations.find((item) => item.id === id);
    if (!conv) return;
    showConversationDetailsPopup(conv);
    return;
  }
  if (action === "chat-tab-inbox") {
    conversationTab = "inbox";
    activeConversationId = "";
  }
  if (action === "chat-tab-requests") {
    conversationTab = "requests";
    activeConversationId = "";
  }
  if (action === "chat-tab-sent") {
    conversationTab = "sent";
    activeConversationId = "";
  }
  if (action === "accept-request") {
    if (!id) return toast("Conversation not found");
    const convo = state.conversations.find((conversation) => conversation.id === id);
    if (!convo) return toast("Conversation not found");
    if (!classifyConversations().requests.some((conversation) => conversation.id === id)) return toast("Conversation is not in requests");
    if (!state.acceptedRequests || typeof state.acceptedRequests !== "object") state.acceptedRequests = {};
    state.acceptedRequests[id] = true;
    if (state.rejectedRequests && typeof state.rejectedRequests === "object") delete state.rejectedRequests[id];
    saveState();
    conversationTab = "inbox";
    activeConversationId = id;
    toast("Request accepted");
  }
  if (action === "reject-request") {
    if (!id) return toast("Conversation not found");
    const convo = state.conversations.find((conversation) => conversation.id === id);
    if (!convo) return toast("Conversation not found");
    if (!classifyConversations().requests.some((conversation) => conversation.id === id)) return toast("Conversation is not in requests");
    if (!state.rejectedRequests || typeof state.rejectedRequests !== "object") state.rejectedRequests = {};
    state.rejectedRequests[id] = true;
    if (state.acceptedRequests && typeof state.acceptedRequests === "object") delete state.acceptedRequests[id];
    saveState();
    activeConversationId = "";
    toast("Request rejected");
  }
  if (action === "open-start-direct") {
    if (user.role === "admin") return toast("Admin cannot start direct student chats here");
    if (user.status !== "verified") return toast("Verification required before messaging");
    const choices = state.users.filter((item) => item.id !== user.id && (item.role === "admin" || item.status === "verified"));
    if (!choices.length) return toast("No messageable users available");
    const popup = showFormPopup("Start Direct Message", `
      <form id="direct-start-form" class="grid">
        <div class="field"><label>Search people</label><input id="direct-search" placeholder="Search by name, grade, class" /></div>
        <div id="direct-list" class="grid" style="max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:8px">
          ${choices.map((item) => `<button class="btn" type="button" data-direct-target="${escapeHtml(item.id)}">${escapeHtml(item.englishName)} <span class="muted">· ${item.role === "admin" ? "Admin" : `G${item.grade} C${item.classNo}`}</span></button>`).join("")}
        </div>
        <div class="row"><button class="btn" type="button" data-cancel>Cancel</button></div>
      </form>
    `);
    popup.querySelector("[data-cancel]")?.addEventListener("click", () => popup.remove());
    popup.querySelector("#direct-search")?.addEventListener("input", (event) => {
      const query = String(event.target.value || "").trim().toLowerCase();
      popup.querySelectorAll("[data-direct-target]").forEach((button) => {
        const text = button.textContent?.toLowerCase() || "";
        button.style.display = !query || text.includes(query) ? "" : "none";
      });
    });
    popup.querySelectorAll("[data-direct-target]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (button.dataset.busy === "1") return;
        button.dataset.busy = "1";
        try {
          const targetId = button.getAttribute("data-direct-target");
          if (!targetId) return toast("Invalid target");
          const target = choices.find((item) => item.id === targetId);
          const mode = await askIdentityModePopup(target?.englishName || "student");
          if (!mode) return;
          const result = await apiRequest("/conversations", { method: "POST", body: JSON.stringify({ memberIds: [targetId], group: false }) });
          setConversationIdentityMode(result.conversation.id, mode);
          conversationTab = "sent";
          await refreshConversations();
          activeConversationId = result.conversation.id;
          popup.remove();
          render();
        } finally {
          button.dataset.busy = "0";
        }
      });
    });
    return;
  }
  if (action === "open-create-convo") {
    if (user.role === "admin") return toast("Admin cannot create student chats here");
    if (user.status !== "verified") return toast("Verification required before messaging");
    const choices = state.users.filter((item) => item.id !== user.id && (item.role === "admin" || item.status === "verified"));
    if (!choices.length) return toast("No messageable users available");
    const popup = showFormPopup("Create Conversation", `
      <form id="create-convo-form" class="grid">
        <div class="field"><label>Title (optional)</label><input id="create-convo-title" placeholder="Conversation title"></div>
        <div class="field">
          <label>Find people</label>
          <input id="create-convo-search" placeholder="Search by name, grade, class" />
        </div>
        <div id="create-convo-list" class="grid" style="max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:8px">
          ${choices.map((item) => `
            <label class="row" style="justify-content:flex-start;gap:10px;padding:6px;border-radius:8px">
              <input type="checkbox" value="${escapeHtml(item.id)}" data-convo-member />
              <span><strong>${escapeHtml(item.englishName)}</strong> <span class="muted">· ${item.role === "admin" ? "Admin" : `G${item.grade} C${item.classNo}`}</span></span>
            </label>
          `).join("") || `<p class="muted">No messageable users available.</p>`}
        </div>
        <div class="row">
          <button class="btn primary" type="submit">Create</button>
          <button class="btn" type="button" data-cancel>Cancel</button>
        </div>
      </form>
    `);
    popup.querySelector("[data-cancel]")?.addEventListener("click", () => popup.remove());
    popup.querySelector("#create-convo-search")?.addEventListener("input", (event) => {
      const query = String(event.target.value || "").trim().toLowerCase();
      popup.querySelectorAll("[data-convo-member]").forEach((input) => {
        const row = input.closest("label");
        const text = row?.textContent?.toLowerCase() || "";
        row.style.display = !query || text.includes(query) ? "" : "none";
      });
    });
    popup.querySelector("#create-convo-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitBtn = popup.querySelector('button[type="submit"]');
      if (submitBtn?.dataset.busy === "1") return;
      const memberIds = [...popup.querySelectorAll("[data-convo-member]:checked")].map((input) => input.value).filter(Boolean);
      if (!memberIds.length) return toast("Select at least one member");
      const allowedIds = new Set(choices.map((item) => item.id));
      const invalidMember = memberIds.find((memberId) => !allowedIds.has(memberId));
      if (invalidMember) return toast("Invalid member selected");
      const title = String(popup.querySelector("#create-convo-title")?.value || "").trim();
      const payload = { memberIds, group: memberIds.length > 1, title: title || undefined };
      const directTarget = !payload.group ? choices.find((item) => item.id === memberIds[0]) : null;
      if (submitBtn) {
        submitBtn.dataset.busy = "1";
        submitBtn.disabled = true;
      }
      try {
        let mode = "public";
        if (!payload.group) {
          const picked = await askIdentityModePopup(directTarget?.englishName || "this student");
          if (!picked) return;
          mode = picked;
        }
        const result = await apiRequest("/conversations", { method: "POST", body: JSON.stringify(payload) });
        if (!payload.group) setConversationIdentityMode(result.conversation.id, mode);
        popup.remove();
        await refreshConversations();
        conversationTab = payload.group ? "inbox" : "sent";
        activeConversationId = result?.conversation?.id || state.conversations[0]?.id;
        toast("Conversation created");
        render();
      } finally {
        if (submitBtn) {
          submitBtn.dataset.busy = "0";
          submitBtn.disabled = false;
        }
      }
    });
    return;
  }
  if (action === "admin-chat-filter") {
    if (user.role !== "admin") return toast("Admin access required");
    adminChatMonitorFilter = id === "direct" || id === "group" ? id : "all";
    adminActiveConversationId = "";
  }
  if (action === "admin-tab") {
    if (user.role !== "admin") return toast("Admin access required");
    adminTab = id === "chat" ? "chat" : "overview";
    if (adminTab === "chat" && !state.conversations.length) await refreshConversations();
  }
  if (action === "admin-open-chat") {
    if (!id || !state.conversations.some((conversation) => conversation.id === id)) return toast("Conversation not found");
    adminActiveConversationId = id;
  }
  if (action === "new-group") {
    if (user.status !== "verified") return toast("Verification required before messaging");
    const memberIds = [...new Set(state.users.filter((item) => item.id !== user.id && item.role !== "admin" && item.status === "verified").map((item) => item.id))];
    if (!memberIds.length) return toast("No verified classmates to add yet");
    await apiRequest("/conversations", { method: "POST", body: JSON.stringify({ memberIds, group: true, title: "New group chat" }) });
    await refreshConversations();
    activeConversationId = "";
    view = "messages";
  }
  if (action === "report-message") {
    if (!id) return toast("Select a conversation first");
    const conversation = state.conversations.find((item) => item.id === id);
    if (!conversation || state.deletedChats?.[id]) return toast("Conversation not found");
    const reason = await askTextPopup("Report Conversation", "Reason", "Describe the issue");
    const cleanReason = String(reason || "").trim();
    if (!cleanReason) return;
    await apiRequest("/reports", { method: "POST", body: JSON.stringify({ targetType: "conversation", targetId: id, reason: cleanReason }) });
    toast("Report submitted");
    if (user.role === "admin") await refreshReports();
  }
  if (action === "verify-user") {
    if (currentUser()?.role !== "admin") return toast("Admin access required");
    if (!id) return toast("Invalid user");
    const target = state.users.find((u) => u.id === id);
    if (!target) return toast("User not found");
    if (target.role !== "student") return toast("Only student accounts can be verified");
    if (target.role === "admin") return toast("Cannot verify admin account");
    if (target.status !== "pending_verification") return toast("User is not pending verification");
    if (verifyUserInFlight) return;
    verifyUserInFlight = true;
    try {
      await apiRequest(`/admin/verifications/${id}`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" })
      });
      await refreshAdminVerifications();
      await refreshStudents();
    } finally {
      verifyUserInFlight = false;
    }
  }
  if (action === "reject-user") {
    if (currentUser()?.role !== "admin") return toast("Admin access required");
    if (!id) return toast("Invalid user");
    const target = state.users.find((u) => u.id === id);
    if (!target) return toast("User not found");
    if (target.role !== "student") return toast("Only student accounts can be rejected");
    if (target.role === "admin") return toast("Cannot reject admin account");
    if (target.status !== "pending_verification") return toast("User is not pending verification");
    const ok = await askConfirmPopup("Reject Verification", "Reject this student's verification submission?", "Reject");
    if (!ok) return;
    if (rejectUserInFlight) return;
    rejectUserInFlight = true;
    try {
      await apiRequest(`/admin/verifications/${id}`, {
        method: "POST",
        body: JSON.stringify({ decision: "reject" })
      });
      await refreshAdminVerifications();
      await refreshStudents();
    } finally {
      rejectUserInFlight = false;
    }
  }
  if (action === "ban-user") {
    if (currentUser()?.role !== "admin") return toast("Admin access required");
    if (!id) return toast("Invalid user");
    const user = state.users.find((u) => u.id === id);
    if (!user) return toast("User not found");
    if (user.role === "admin") return toast("Cannot ban admin account");
    if (user.status === "banned") return toast("User is already banned");
    if (banUserInFlight) return;
    const result = await showFormPopup("Ban / Warn User", `
      <form id="ban-user-form" class="grid">
        <p><strong>${escapeHtml(user?.englishName || "Unknown")}</strong> (${escapeHtml(user?.chineseName || "")})</p>
        <div class="field">
          <label>Action</label>
          <select id="ban-action">
            <option value="warn">Send Warning</option>
            <option value="ban_temp">Temporary Ban</option>
            <option value="ban_perm">Permanent Ban</option>
          </select>
        </div>
        <div class="field" id="ban-days-field" style="display:none">
          <label>Days (1-365)</label>
          <input id="ban-days" type="number" min="1" max="365" value="7" />
        </div>
        <div class="field">
          <label>Reason (visible to user)</label>
          <textarea id="ban-reason" placeholder="Describe the violation..." required></textarea>
        </div>
        <div class="row">
          <button class="btn danger" type="submit">Confirm</button>
          <button class="btn" type="button" data-cancel>Cancel</button>
        </div>
      </form>
    `);
    result.querySelector("#ban-action")?.addEventListener("change", (e) => {
      const daysField = result.querySelector("#ban-days-field");
      if (daysField) daysField.style.display = e.target.value === "ban_temp" ? "" : "none";
    });
    result.querySelector("[data-cancel]")?.addEventListener("click", () => result.remove());
    result.querySelector("#ban-user-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const banAction = result.querySelector("#ban-action")?.value || "warn";
      const reason = result.querySelector("#ban-reason")?.value?.trim();
      if (!reason) return toast("Please enter a reason");
      const days = banAction === "ban_temp" ? parseInt(result.querySelector("#ban-days")?.value || "7", 10) : 0;
      if (banAction === "ban_temp" && (!Number.isInteger(days) || days < 1 || days > 365)) return toast("Days must be between 1 and 365");
      if (banUserInFlight) return;
      banUserInFlight = true;
      try {
        await apiRequest(`/admin/bans/${id}/user`, {
          method: "POST",
          body: JSON.stringify({ action: banAction, reason, days })
        });
        result.remove();
        toast(banAction === "warn" ? "Warning sent" : "User banned");
        await refreshAdminVerifications();
        await refreshStudents();
      } finally {
        banUserInFlight = false;
      }
    });
    return;
  }
  if (action === "handle-report") {
    if (currentUser()?.role !== "admin") return toast("Admin access required");
    if (handleReportInFlight) return;
    const report = state.reports.find((r) => r.id === id);
    if (!report) return;
    if (report.status && report.status !== "pending") return toast("Report already handled");
    const targetPost = report.type === "post" ? state.posts.find((p) => p.id === report.targetId) : null;
    const reportTargetUserId = resolveReportTargetUserId(report);
    const reportTargetUser = state.users.find((item) => item.id === reportTargetUserId);
    const canModerateTarget = Boolean(
      reportTargetUserId
      && reportTargetUserId !== report.reporterId
      && reportTargetUser
      && reportTargetUser.role !== "admin"
    );
    const result = await showFormPopup("Handle Report", `
      <form id="handle-report-form" class="grid">
        <p><strong>Reporter:</strong> ${escapeHtml(userName(report.reporterId))}</p>
        <p><strong>Against:</strong> ${escapeHtml(reportTargetHumanLabel(report))}</p>
        <p><strong>Reason:</strong> ${escapeHtml(report.reason || "-")}</p>
        ${targetPost ? `<p class="muted"><strong>Post:</strong> ${escapeHtml(targetPost.text?.slice(0, 100) || "Media post")}</p>` : ""}
        <hr style="margin:12px 0;border-color:#eee" />
        <div class="field">
          <label>Take Action</label>
          <select id="report-action">
            <option value="dismiss">Dismiss Report</option>
            <option value="warn" ${canModerateTarget ? "" : "disabled"}>Warn User</option>
            <option value="ban_temp" ${canModerateTarget ? "" : "disabled"}>Temporary Ban</option>
            <option value="ban_perm" ${canModerateTarget ? "" : "disabled"}>Permanent Ban</option>
          </select>
        </div>
        ${canModerateTarget ? "" : `<p class="muted">Only dismiss is available because target user cannot be moderated.</p>`}
        <div class="field" id="report-days-field" style="display:none">
          <label>Days (1-365)</label>
          <input id="report-days" type="number" min="1" max="365" value="7" />
        </div>
        <div class="field" id="report-reason-field">
          <label>Reason (visible to user)</label>
          <textarea id="report-reason" placeholder="Describe the violation for the user..."></textarea>
        </div>
        <div class="row">
          <button class="btn primary" type="submit">Submit</button>
          <button class="btn" type="button" data-cancel>Cancel</button>
        </div>
      </form>
    `);
    result.querySelector("#report-action")?.addEventListener("change", (e) => {
      const daysField = result.querySelector("#report-days-field");
      const reasonField = result.querySelector("#report-reason-field");
      if (daysField) daysField.style.display = e.target.value === "ban_temp" ? "" : "none";
      if (reasonField) reasonField.style.display = e.target.value === "dismiss" ? "none" : "";
    });
    result.querySelector("[data-cancel]")?.addEventListener("click", () => result.remove());
    result.querySelector("#handle-report-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const reportAction = result.querySelector("#report-action")?.value || "dismiss";
      if (!["dismiss", "warn", "ban_temp", "ban_perm"].includes(reportAction)) return toast("Invalid report action");
      const reason = result.querySelector("#report-reason")?.value?.trim();
      if (reportAction !== "dismiss" && !reason) return toast("Please enter a reason for non-dismiss actions");
      const days = reportAction === "ban_temp" ? parseInt(result.querySelector("#report-days")?.value || "7", 10) : 0;
      if (reportAction === "ban_temp" && (!Number.isInteger(days) || days < 1 || days > 365)) return toast("Days must be between 1 and 365");
      handleReportInFlight = true;
      try {
        if (reportAction === "dismiss") {
          await apiRequest(`/admin/reports/${id}`, { method: "POST", body: JSON.stringify({ status: "dismissed" }) });
        } else if (reportTargetUserId && reportTargetUserId !== report.reporterId) {
          await apiRequest(`/admin/bans/${reportTargetUserId}/user`, {
            method: "POST",
            body: JSON.stringify({ action: reportAction, reason, days })
          });
          await apiRequest(`/admin/reports/${id}`, { method: "POST", body: JSON.stringify({ status: "actioned" }) });
        } else {
          return toast("Cannot resolve report target user");
        }
        result.remove();
        toast(reportAction === "dismiss" ? "Report dismissed" : "Action taken");
        await refreshReports();
        if (reportTargetUserId) await refreshStudents();
        render();
      } finally {
        handleReportInFlight = false;
      }
    });
    const actionSelect = result.querySelector("#report-action");
    if (actionSelect) actionSelect.dispatchEvent(new Event("change"));
    return;
  }
  if (action === "mark-read") {
    if (!currentUser()) return toast("Please log in first");
    if (markReadInFlight) return;
    markReadInFlight = true;
    try {
      await apiRequest("/notifications/read-all", { method: "POST", body: JSON.stringify({}) });
      await refreshNotifications();
      expandedNotificationId = "";
      saveState();
      renderNotificationsPanelOnly();
    } finally {
      markReadInFlight = false;
    }
    return;
  }
  if (action === "ask-qna") {
    if (!id || id === currentUser()?.id) return toast("You cannot ask yourself a question");
    if (user.role !== "admin" && user.status !== "verified") return toast("Verification required to ask questions");
    const target = state.users.find((item) => item.id === id);
    if (!target) return toast("User not found");
    if (target.role === "admin" || target.status !== "verified") return toast("Only verified students can receive questions");
    const payload = await askQnaPopup();
    if (!payload) return;
    if (!String(payload.question || "").trim()) return toast("Question is required");
    await apiRequest(`/users/${id}/qna`, { method: "POST", body: JSON.stringify(payload) });
    await refreshQnaForProfile(id);
  }
  if (action === "open-qna") {
    if (!id) return toast("Question not found");
    const entry = state.qna.find((item) => item.id === id);
    if (!entry) return;
    const me = currentUser();
    const canAnswer = me?.role === "admin" || me?.id === entry.profileId;
    if (!canAnswer) {
      showPopup("Q&A", `${entry.question}\n\n${entry.answer || "Waiting for answer"}`);
      return;
    }
    const popup = showFormPopup("Q&A", `
      <form id="qna-answer-form" class="grid">
        <p style="margin:0"><strong>Question:</strong> ${escapeHtml(entry.question)}</p>
        <div class="field">
          <label>Your answer</label>
          <textarea id="qna-answer-text" placeholder="Write your answer">${escapeHtml(entry.answer || "")}</textarea>
        </div>
        <div class="row">
          <button class="btn primary" type="submit">Save Answer</button>
          <button class="btn" type="button" data-cancel>Cancel</button>
        </div>
      </form>
    `);
    popup.querySelector("[data-cancel]")?.addEventListener("click", () => popup.remove());
    popup.querySelector("#qna-answer-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const answer = String(popup.querySelector("#qna-answer-text")?.value || "").trim();
      if (!answer) return toast("Answer is required");
      await apiRequest(`/qna/${entry.id}/answer`, { method: "POST", body: JSON.stringify({ answer }) });
      await refreshQnaForProfile(entry.profileId);
      popup.remove();
      toast("Q&A answer saved");
      render();
    });
    return;
  }
  if (action === "submit-suggestion") {
    if (currentUser()?.role === "admin") return toast("Admins cannot submit suggestions");
    if (currentUser()?.status !== "verified") return toast("Verification required before submitting suggestions");
    if (suggestionSubmitInFlight) return;
    const text = String(document.querySelector("#suggestion-text")?.value || "").trim();
    if (!text) return toast("Write a suggestion first");
    suggestionSubmitInFlight = true;
    try {
      await apiRequest("/suggestions", { method: "POST", body: JSON.stringify({ text }) });
      const input = document.querySelector("#suggestion-text");
      if (input) input.value = "";
      await refreshSuggestions();
      toast("Suggestion submitted");
    } finally {
      suggestionSubmitInFlight = false;
    }
  }
  if (action === "reply-suggestion") {
    if (currentUser()?.role !== "admin") return toast("Admin access required");
    if (!id) return toast("Invalid suggestion");
    const target = (state.suggestions || []).find((item) => item.id === id);
    if (!target) return toast("Suggestion not found");
    if (String(target.status || "").startsWith("responded::")) return toast("Suggestion already responded");
    if (suggestionReplyInFlight) return;
    const response = await askTextPopup("Respond to Suggestion", "Response", "Write your response");
    if (response == null) return;
    const clean = String(response).trim().slice(0, 280);
    if (!clean) return toast("Response is required");
    suggestionReplyInFlight = true;
    try {
      await apiRequest(`/admin/suggestions/${id}`, { method: "POST", body: JSON.stringify({ response: clean }) });
      await refreshSuggestions();
      toast("Suggestion response sent");
    } finally {
      suggestionReplyInFlight = false;
    }
  }
  if (action === "create-ad") {
    if (currentUser()?.role !== "admin") return toast("Admin access required");
    if (createAdInFlight) return;
    const slot = String(document.querySelector("#ad-slot")?.value || "").trim();
    const title = String(document.querySelector("#ad-title")?.value || "").trim();
    const body = String(document.querySelector("#ad-body")?.value || "").trim();
    const url = String(document.querySelector("#ad-url")?.value || "").trim();
    const imageUrl = String(document.querySelector("#ad-image-url")?.value || "").trim();
    const adImageInput = document.querySelector("#ad-image-file");
    const adImageFile = (inputFileStore["ad-image-file"] || [...(adImageInput?.files || [])])[0] || null;
    const allowedSlots = new Set(["top_banner", "feed_inline", "students_inline", "popup"]);
    if (!slot || !title) return toast("Slot and title are required");
    if (title.length > 120) return toast("Title is too long");
    if (body.length > 320) return toast("Body is too long");
    if (url.length > 500) return toast("URL is too long");
    if (imageUrl.length > 2000) return toast("Image URL is too long");
    if (!allowedSlots.has(slot)) return toast("Invalid ad slot");
    createAdInFlight = true;
    try {
      let nextImageUrl = imageUrl;
      if (adImageFile) {
        const uploaded = await uploadFiles([adImageFile], { purpose: "media" });
        nextImageUrl = String(uploaded?.[0]?.url || nextImageUrl || "").trim();
      }
      await apiRequest("/admin/ads", { method: "POST", body: JSON.stringify({ slot, title, body, url, imageUrl: nextImageUrl, active: true }) });
      const titleInput = document.querySelector("#ad-title");
      const bodyInput = document.querySelector("#ad-body");
      const urlInput = document.querySelector("#ad-url");
      const imageUrlInput = document.querySelector("#ad-image-url");
      const imageFileInput = document.querySelector("#ad-image-file");
      if (titleInput) titleInput.value = "";
      if (bodyInput) bodyInput.value = "";
      if (urlInput) urlInput.value = "";
      if (imageUrlInput) imageUrlInput.value = "";
      inputFileStore["ad-image-file"] = [];
      if (imageFileInput) {
        inputFileSyncLock.add("ad-image-file");
        setInputFiles(imageFileInput, []);
        inputFileSyncLock.delete("ad-image-file");
        imageFileInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await refreshAds();
      toast("Ad created");
    } finally {
      createAdInFlight = false;
    }
  }
  if (action === "toggle-ad") {
    if (currentUser()?.role !== "admin") return toast("Admin access required");
    if (!id) return toast("Invalid ad");
    if (!(state.ads || []).some((ad) => ad.id === id)) return toast("Ad not found");
    if (toggleAdInFlight) return;
    toggleAdInFlight = true;
    try {
      await apiRequest(`/admin/ads/${id}/toggle`, { method: "POST", body: JSON.stringify({}) });
      await refreshAds();
      toast("Ad updated");
    } finally {
      toggleAdInFlight = false;
    }
  }
  if (action === "delete-ad") {
    if (currentUser()?.role !== "admin") return toast("Admin access required");
    if (!id) return toast("Invalid ad");
    if (!(state.ads || []).some((ad) => ad.id === id)) return toast("Ad not found");
    if (deleteAdInFlight) return;
    deleteAdInFlight = true;
    try {
      await apiRequest(`/admin/ads/${id}`, { method: "DELETE", body: JSON.stringify({}) });
      await refreshAds();
      toast("Ad deleted");
    } finally {
      deleteAdInFlight = false;
    }
  }
  saveState();
  render();
}

function askIdentityModePopup(receiverName) {
  return new Promise((resolve) => {
    const popup = showFormPopup("Choose Identity", `
      <div class="grid">
        <p class="muted" style="margin:0">Choose how messages appear in this chat with ${escapeHtml(receiverName)}.</p>
        <div class="row">
          <button class="btn primary" type="button" data-mode="public">Public (your name)</button>
          <button class="btn" type="button" data-mode="anonymous">Anonymous student</button>
        </div>
      </div>
    `);
    popup.querySelectorAll("[data-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        const mode = button.getAttribute("data-mode") === "anonymous" ? "anonymous" : "public";
        popup.remove();
        resolve(mode);
      });
    });
    popup.querySelector("[data-close-popup]")?.addEventListener("click", () => resolve(null));
  });
}

function renderChatMediaItem(item) {
  const url = String(item?.url || "");
  const type = String(item?.type || "");
  if (!url) return "";
  if (type.startsWith("image/")) return `<div style="margin-top:8px"><img src="${escapeHtml(url)}" alt="Chat image" style="max-width:260px;border-radius:10px;border:1px solid var(--line)" loading="lazy" /></div>`;
  if (type.startsWith("video/")) return `<div style="margin-top:8px"><video src="${escapeHtml(url)}" controls preload="metadata" style="max-width:260px;border-radius:10px;border:1px solid var(--line)"></video></div>`;
  return `<div style="margin-top:8px"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Attachment</a></div>`;
}

function renderPostMedia(item) {
  if (typeof item === "string") return `<div class="media-tile">${escapeHtml(item)}</div>`;
  const url = String(item?.url || "");
  const type = String(item?.type || "");
  if (!url) return `<div class="media-tile">Media</div>`;
  if (type.startsWith("image/")) {
    const loaded = loadedMediaUrls.has(url);
    return `
      <div class="media-tile media-image-tile ${loaded ? "is-loaded" : "is-loading"}">
        <img class="media-content" src="${escapeHtml(url)}" alt="Post media" loading="lazy" />
        <span class="media-loading-indicator" aria-hidden="true">Loading...</span>
      </div>
    `;
  }
  if (type.startsWith("video/")) return `<div class="media-tile media-video-tile"><video class="media-content media-video" src="${escapeHtml(url)}" controls preload="auto" playsinline></video></div>`;
  return `<a class="media-tile" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open file</a>`;
}

function preloadMediaByType(url, type = "") {
  const safeUrl = String(url || "").trim();
  if (!safeUrl || preloadedMediaUrls.has(safeUrl)) return;
  preloadedMediaUrls.add(safeUrl);
  if (String(type || "").startsWith("video/")) {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = safeUrl;
    return;
  }
  const image = new Image();
  image.src = safeUrl;
}

function preloadPostMediaAround(postId) {
  const post = state.posts.find((item) => item.id === postId);
  if (!post) return;
  const media = Array.isArray(post.media) ? post.media : [];
  const current = Math.max(0, Math.min(postMediaIndexByPostId[postId] || 0, Math.max(0, media.length - 1)));
  [current - 1, current + 1].forEach((idx) => {
    const item = media[idx];
    if (!item || typeof item === "string") return;
    preloadMediaByType(item.url, item.type || "");
  });
}

function warmUserAssetCache() {
  (state.users || []).forEach((user) => {
    const photo = String(user?.profilePhoto || "").trim();
    if (photo) preloadMediaByType(photo, "image/*");
  });
  (state.posts || []).forEach((post) => {
    (post.media || []).forEach((item) => {
      if (!item || typeof item === "string") return;
      preloadMediaByType(item.url, item.type || "");
    });
  });
  (state.conversations || []).forEach((conv) => {
    (conv.messages || []).forEach((msg) => {
      (msg.media || []).forEach((item) => preloadMediaByType(item?.url, item?.type || ""));
    });
  });
}

function updatePostMediaCarousel(postId) {
  const post = state.posts.find((item) => item.id === postId);
  const card = document.querySelector(`article.card[data-post-id="${postId}"]`);
  if (!post || !card) return;
  const media = Array.isArray(post.media) ? post.media : [];
  if (!media.length) return;
  const current = Math.max(0, Math.min(postMediaIndexByPostId[postId] || 0, media.length - 1));
  postMediaIndexByPostId[postId] = current;
  const track = card.querySelector(".media-track");
  if (track) track.style.transform = `translateX(-${current * 100}%)`;
  const prevButton = card.querySelector('[data-action="media-prev"]');
  if (prevButton) prevButton.style.visibility = current === 0 ? "hidden" : "visible";
  const nextButton = card.querySelector('[data-action="media-next"]');
  if (nextButton) nextButton.style.visibility = current >= media.length - 1 ? "hidden" : "visible";
  const dots = card.querySelectorAll(".media-dot");
  dots.forEach((dot, idx) => dot.classList.toggle("active", idx === current));
  setupMediaLoadingIndicators(card);
  setupFeedVideoAutoplay();
  preloadPostMediaAround(postId);
}

function syncPostActionButtons(postId) {
  const post = state.posts.find((item) => item.id === postId);
  const card = document.querySelector(`article.card[data-post-id="${postId}"]`);
  if (!post || !card) return false;
  const likes = Array.isArray(post.likes) ? post.likes : [];
  const hearts = Array.isArray(post.hearts) ? post.hearts : [];
  const saves = Array.isArray(post.savedBy) ? post.savedBy : [];
  const liked = likes.includes(state.currentUserId);
  const hearted = hearts.includes(state.currentUserId);
  const saved = saves.includes(state.currentUserId);
  const heartBtn = card.querySelector('[data-action="heart-post"]');
  if (heartBtn) heartBtn.textContent = `${hearted ? "♥︎" : "♡"} ${hearts.length}`;
  const likeBtn = card.querySelector('[data-action="like-post"]');
  if (likeBtn) likeBtn.textContent = `${liked ? "👍" : "👍🏻"} ${likes.length}`;
  const saveBtn = card.querySelector('[data-action="save-post"]');
  if (saveBtn) saveBtn.textContent = `${saved ? "🔖" : "⌑"} ${saves.length}`;
  return true;
}

function syncCommentLikeButton(postId, commentId) {
  const post = state.posts.find((item) => item.id === postId);
  if (!post) return false;
  const comment = (post.comments || []).find((item) => item.id === commentId);
  if (!comment) return false;
  const likes = Array.isArray(comment.likes) ? comment.likes : [];
  const liked = likes.includes(state.currentUserId);
  const btn = document.querySelector(`[data-action="like-comment"][data-id="${postId}:${commentId}"]`);
  if (!btn) return false;
  btn.textContent = `${liked ? "♥︎" : "♡"} ${likes.length}`;
  return true;
}

function rerenderPostCard(postId, { preserveVideoPlayback = true, rebindAutoplay = false } = {}) {
  const post = state.posts.find((item) => item.id === postId);
  const oldCard = document.querySelector(`article.card[data-post-id="${postId}"]`);
  if (!post || !oldCard) return false;
  const oldVideoStates = preserveVideoPlayback
    ? [...oldCard.querySelectorAll("video.media-video")].map((video) => ({
      src: video.currentSrc || video.src || "",
      currentTime: Number(video.currentTime || 0),
      paused: Boolean(video.paused),
      muted: Boolean(video.muted),
      volume: Number(video.volume ?? 1),
      playbackRate: Number(video.playbackRate || 1)
    }))
    : [];
  oldCard.outerHTML = renderPost(post);
  const nextCard = document.querySelector(`article.card[data-post-id="${postId}"]`);
  if (!nextCard) return false;
  setupMediaLoadingIndicators(nextCard);
  if (rebindAutoplay) setupFeedVideoAutoplay();
  preloadPostMediaAround(postId);
  if (!preserveVideoPlayback || !oldVideoStates.length) return true;
  const nextVideos = [...nextCard.querySelectorAll("video.media-video")];
  for (const state of oldVideoStates) {
    if (!state.src) continue;
    const nextVideo = nextVideos.find((video) => (video.currentSrc || video.src || "") === state.src);
    if (!nextVideo) continue;
    try {
      if (Number.isFinite(state.currentTime) && state.currentTime > 0) nextVideo.currentTime = state.currentTime;
      nextVideo.muted = state.muted;
      nextVideo.volume = Number.isFinite(state.volume) ? state.volume : nextVideo.volume;
      nextVideo.playbackRate = Number.isFinite(state.playbackRate) ? state.playbackRate : nextVideo.playbackRate;
      if (!state.paused) nextVideo.play().catch(() => {});
    } catch {
      // Ignore media restore failures.
    }
  }
  return true;
}

function preloadVisiblePostMedia() {
  for (const post of state.posts || []) {
    if (!post?.id) continue;
    preloadPostMediaAround(post.id);
  }
}

function fileFingerprint(file) {
  return `${file.name}::${file.size}::${file.lastModified}::${file.type}`;
}

function mergeUniqueFiles(existingFiles = [], incomingFiles = []) {
  const seen = new Set(existingFiles.map(fileFingerprint));
  const merged = [...existingFiles];
  for (const file of incomingFiles) {
    const key = fileFingerprint(file);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(file);
  }
  return merged;
}

function setInputFiles(input, files = []) {
  const dt = new DataTransfer();
  files.forEach((file) => dt.items.add(file));
  input.files = dt.files;
}

function appendFilesToInput(inputId, files = [], multiple = true) {
  const input = document.querySelector(`#${inputId}`);
  if (!input) return;
  const existing = inputFileStore[inputId] || [];
  const incoming = Array.isArray(files) ? files : [];
  const merged = multiple ? mergeUniqueFiles(existing, incoming) : incoming.slice(0, 1);
  inputFileStore[inputId] = merged;
  inputFileSyncLock.add(inputId);
  setInputFiles(input, merged);
  inputFileSyncLock.delete(inputId);
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function setupMediaLoadingIndicators(root = document) {
  const images = root.querySelectorAll(".media-image-tile img.media-content");
  images.forEach((img) => {
    const url = String(img.currentSrc || img.src || "").trim();
    const tile = img.closest(".media-image-tile");
    if (!tile || !url) return;
    const markLoaded = () => {
      loadedMediaUrls.add(url);
      tile.classList.remove("is-loading");
      tile.classList.add("is-loaded");
    };
    if (img.complete && img.naturalWidth > 0) {
      markLoaded();
      return;
    }
    tile.classList.add("is-loading");
    img.addEventListener("load", markLoaded, { once: true });
    img.addEventListener("error", () => {
      tile.classList.remove("is-loading");
      tile.classList.add("is-loaded");
    }, { once: true });
  });
}

function bindFileChips(inputId, chipsId) {
  const input = document.querySelector(`#${inputId}`);
  const chips = document.querySelector(`#${chipsId}`);
  if (!input || !chips) return;
  const isMultiple = input.hasAttribute("multiple");
  if (inputFileStore[inputId]?.length) {
    inputFileSyncLock.add(inputId);
    setInputFiles(input, inputFileStore[inputId]);
    inputFileSyncLock.delete(inputId);
  } else {
    inputFileStore[inputId] = [...(input.files || [])];
  }
  const draw = () => {
    const files = inputFileStore[inputId] || [...(input.files || [])];
    chips.innerHTML = files.map((file) => `<span class="chip">${escapeHtml(file.name)}</span>`).join("");
  };
  input.addEventListener("change", () => {
    if (inputFileSyncLock.has(inputId)) {
      draw();
      return;
    }
    const incoming = [...(input.files || [])];
    const existing = inputFileStore[inputId] || [];
    const merged = isMultiple ? mergeUniqueFiles(existing, incoming) : incoming.slice(0, 1);
    inputFileStore[inputId] = merged;
    inputFileSyncLock.add(inputId);
    setInputFiles(input, merged);
    inputFileSyncLock.delete(inputId);
    draw();
  });
  draw();
}

function drawMessageAttachmentStrip() {
  const strip = document.querySelector("#message-attach-strip");
  if (!strip) return;
  const mediaFiles = inputFileStore["message-media-file"] || [];
  const docFiles = inputFileStore["message-doc-file"] || [];
  const files = [...mediaFiles, ...docFiles];
  strip.innerHTML = files.length ? files.map((file) => `<span class="chip">${escapeHtml(file.name)}</span>`).join("") : "";
}

function bindMessageAttachmentStrip() {
  const mediaInput = document.querySelector("#message-media-file");
  const docInput = document.querySelector("#message-doc-file");
  const strip = document.querySelector("#message-attach-strip");
  if (!mediaInput || !docInput || !strip) return;
  inputFileStore["message-media-file"] = inputFileStore["message-media-file"] || [...(mediaInput.files || [])];
  inputFileStore["message-doc-file"] = inputFileStore["message-doc-file"] || [...(docInput.files || [])];
  const syncInputStore = (inputId, inputNode) => {
    const incoming = [...(inputNode.files || [])];
    const existing = inputFileStore[inputId] || [];
    const merged = mergeUniqueFiles(existing, incoming);
    inputFileStore[inputId] = merged;
    inputFileSyncLock.add(inputId);
    setInputFiles(inputNode, merged);
    inputFileSyncLock.delete(inputId);
    drawMessageAttachmentStrip();
  };
  mediaInput.addEventListener("change", () => syncInputStore("message-media-file", mediaInput));
  docInput.addEventListener("change", () => syncInputStore("message-doc-file", docInput));
  drawMessageAttachmentStrip();
}

function setupDropzone(zoneId, inputId, multiple) {
  const zone = document.querySelector(`#${zoneId}`);
  const input = document.querySelector(`#${inputId}`);
  if (!zone || !input) return;
  zone.addEventListener("click", () => input.click());
  const prevent = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  ["dragenter", "dragover", "dragleave", "drop"].forEach((type) => zone.addEventListener(type, prevent));
  zone.addEventListener("dragover", () => zone.classList.add("dragover"));
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (event) => {
    zone.classList.remove("dragover");
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;
    appendFilesToInput(inputId, files, multiple);
  });
}

async function uploadFiles(files, options = {}) {
  const purpose = options.purpose || "media";
  const uploaded = [];
  setUploadProgress("Uploading media", 0);
  let completed = false;
  try {
    const totalFiles = Math.max(1, files.length);
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const fileStartPct = (index / totalFiles) * 100;
      const fileSpanPct = 100 / totalFiles;
      const markFileProgress = (fraction) => {
        const pct = fileStartPct + fileSpanPct * Math.max(0, Math.min(0.99, fraction));
        setUploadProgress("Uploading media", pct);
      };
      markFileProgress(0.02);
      // Avoid multipart unless necessary. Direct signed PUT is more reliable for
      // normal-size files and prevents /api/multipart part failures on some runtimes.
      const shouldUseMultipart = file.size > 24 * 1024 * 1024;
      if (shouldUseMultipart) {
        markFileProgress(0.08);
        const mediaUrl = await uploadFileMultipart(file, purpose);
        markFileProgress(0.98);
        uploaded.push({ url: mediaUrl, type: file.type || "application/octet-stream", name: file.name });
        continue;
      }
      markFileProgress(0.12);
      const sign = await apiRequest("/upload-url", {
        method: "POST",
        body: JSON.stringify({ fileName: file.name, contentType: file.type || "application/octet-stream", purpose })
      });
      markFileProgress(0.24);
      await uploadDirectFileWithProgress({
        uploadUrl: sign.uploadUrl,
        file,
        contentType: file.type || "application/octet-stream",
        onProgress: (ratio) => markFileProgress(0.24 + ratio * 0.72)
      });
      markFileProgress(0.98);
      uploaded.push({
        url: sign.mediaUrl,
        type: file.type || "application/octet-stream",
        name: file.name
      });
    }
    setUploadProgress("Uploading media", 99);
    completed = true;
    return uploaded;
  } catch (error) {
    if (String(error?.name || "") === "AbortError" || String(error || "").includes("upload-timeout")) {
      throw new Error("Upload timed out. Please retry with a smaller file or more stable connection.");
    }
    throw error;
  } finally {
    clearUploadProgress({ immediate: !completed });
  }
}

function uploadDirectFileWithProgress({ uploadUrl, file, contentType, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.timeout = 90_000;
    xhr.setRequestHeader("content-type", contentType || "application/octet-stream");

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !event.total) return;
      onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve();
        return;
      }
      let detail = xhr.responseText || xhr.statusText || "Unknown upload error.";
      try {
        const body = JSON.parse(xhr.responseText || "{}");
        detail = body?.error || body?.detail || detail;
      } catch {
        // Keep raw response text when it is not JSON.
      }
      reject(new Error(`Upload failed (${file.name}): ${String(detail).trim()}`));
    };
    xhr.onerror = () => reject(new Error(`Upload failed (${file.name}): Network error while uploading.`));
    xhr.ontimeout = () => reject(new Error("Upload timed out. Please retry with a smaller file or more stable connection."));
    xhr.onabort = () => reject(new Error(`Upload failed (${file.name}): Upload was aborted.`));
    xhr.send(file);
  });
}

async function uploadFileMultipart(file, purpose = "media") {
  const init = await apiRequest("/multipart/init", {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
      purpose
    })
  });
  const chunkSize = Number(init.chunkSize || 8 * 1024 * 1024);
  const parts = await uploadMultipartPartsInParallel({
    file,
    chunkSize,
    endpointPrefix: "/multipart",
    uploadId: init.uploadId,
    key: init.key,
    onProgress: (percent) => setUploadProgress("Uploading media", percent)
  });
  const completed = await apiRequest("/multipart/complete", {
    method: "POST",
    body: JSON.stringify({ key: init.key, uploadId: init.uploadId, parts })
  });
  return completed.mediaUrl;
}

async function uploadVerificationVideoMultipart(file) {
  setUploadProgress("Uploading verification video", 0);
  let uploadDone = false;
  try {
    const init = await apiRequest("/verification-upload/init", {
      method: "POST",
      body: JSON.stringify({
        fileName: file.name,
        contentType: file.type || "application/octet-stream"
      })
    });

    const chunkSize = Number(init.chunkSize || 8 * 1024 * 1024);
    const parts = await uploadMultipartPartsInParallel({
      file,
      chunkSize,
      endpointPrefix: "/verification-upload",
      uploadId: init.uploadId,
      key: init.key,
      onProgress: (percent) => setUploadProgress("Uploading verification video", percent)
    });

    const completedUpload = await apiRequest("/verification-upload/complete", {
      method: "POST",
      body: JSON.stringify({ key: init.key, uploadId: init.uploadId, parts })
    });
    uploadDone = true;
    return completedUpload.mediaUrl;
  } finally {
    clearUploadProgress({ immediate: !uploadDone });
  }
}

async function uploadMultipartPartsInParallel({ file, chunkSize, endpointPrefix, uploadId, key, onProgress = null }) {
  const totalParts = Math.ceil(file.size / chunkSize);
  // Use sequential chunk uploads for browser/runtime compatibility and to avoid
  // stream-reader lock issues reported on some environments.
  const concurrency = 1;
  const nextPart = { value: 1 };
  const results = new Array(totalParts);
  let finished = 0;

  async function worker() {
    while (nextPart.value <= totalParts) {
      const partNumber = nextPart.value;
      nextPart.value += 1;
      const offset = (partNumber - 1) * chunkSize;
      const chunk = file.slice(offset, offset + chunkSize);
      const response = await fetch(`${API_BASE}${endpointPrefix}/${encodeURIComponent(uploadId)}/${partNumber}?key=${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: {
          "content-type": file.type || "application/octet-stream",
          ...(state.apiToken ? { authorization: `Bearer ${state.apiToken}` } : {})
        },
        body: chunk
      });
      const raw = await response.text();
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = { detail: raw };
      }
      if (!response.ok) {
        const detail = [body?.error, body?.detail].filter(Boolean).join(" - ");
        throw new Error(detail || `Chunk upload failed (part ${partNumber})`);
      }
      results[partNumber - 1] = { partNumber, etag: body.etag };
      finished += 1;
      if (onProgress) onProgress((finished / totalParts) * 100);
    }
  }

  const workerCount = Math.min(concurrency, totalParts);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

bootstrapSession();
