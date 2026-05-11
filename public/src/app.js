const STORAGE_KEY = "shsid-social-state-v2";
const API_BASE = window.SHSID_API_BASE || (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost" ? "http://127.0.0.1:4174/api" : "https://www.shsid.online/api");
const CONTENT_CATEGORIES = ["school", "lifestyle", "gaming", "academic", "shitpost"];

const initialState = {
  currentUserId: null,
  authStep: "email",
  authMode: "login",
  users: [],
  posts: [],
  stories: [],
  reels: [],
  conversations: [],
  reports: [],
  bans: [],
  qna: [],
  suggestions: [],
  notifications: [],
  audit: [],
  adminVerifications: [],
  apiToken: null,
  pendingEmail: "",
  pendingCode: "",
  pendingVideoName: "",
  pendingEnglishName: "",
  pendingChineseName: "",
  pendingGrade: 10,
  pendingClassNo: 1,
  pendingVerificationWords: [],
  selectedProfileId: null,
  conversationIdentityMode: {},
  acceptedRequests: {},
  rejectedRequests: {},
  contactRemarks: {}
};

let state = loadState();
let view = "feed";
let activeConversationId = state.conversations[0]?.id;
let authEmailSubmitIntent = "login";
let authRequestInFlight = false;
let resendCooldownUntil = 0;
let openCommentPostId = null;
let postsNextOffset = null;
let reelsNextOffset = null;
let deepLinkedPostId = "";
let conversationTab = "inbox";
let adminChatMonitorFilter = "all";
let adminActiveConversationId = "";
let liveChatTimer = null;
let liveChatPollInFlight = false;
let liveChatSnapshot = "";
let uploadUi = { active: false, label: "", percent: 0 };
const postMediaIndexByPostId = {};
const preloadedMediaUrls = new Set();
const loadedMediaUrls = new Set();
let feedAheadPrefetchInFlight = false;
let reelsAheadPrefetchInFlight = false;
let categoryPrefetchInFlight = false;
let feedCategoryWarmDone = false;
let reelsCategoryWarmDone = false;
const prefetchedCategoryPosts = Object.fromEntries(CONTENT_CATEGORIES.map((category) => [category, []]));
const prefetchedCategoryReels = Object.fromEntries(CONTENT_CATEGORIES.map((category) => [category, []]));

hydrateAuthFromUrl();

const navItems = [
  ["feed", "FD", "Feed"],
  ["post", "PT", "Post"],
  ["reels", "RL", "Reels"],
  ["students", "ST", "Students"],
  ["messages", "MS", "Messages"],
  ["stories", "SR", "Stories"],
  ["profile", "PR", "Profile"],
  ["admin", "AD", "Admin"]
];

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return structuredClone(initialState);
  try {
    return { ...structuredClone(initialState), ...JSON.parse(saved) };
  } catch {
    return structuredClone(initialState);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  state.pendingVerificationWords = [];
  state.selectedProfileId = null;
}

function setAuthInFlight(isBusy) {
  authRequestInFlight = isBusy;
  document.querySelectorAll("#auth-email-form button, #auth-verify-form button, #auth-password-form button, #auth-profile-form button, #auth-video-form button").forEach((button) => {
    button.disabled = isBusy;
  });
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(state.apiToken ? { authorization: `Bearer ${state.apiToken}` } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  if (!response.ok) {
    const message = [body.error, body.detail].filter(Boolean).join(": ");
    throw new Error(message || "Request failed");
  }
  return body;
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
  copy.media = Array.isArray(copy.media) ? copy.media : [];
  copy.comments = (copy.comments || []).map((comment) => ({ ...comment, createdAt: at(comment.createdAt) }));
  delete copy.author;
  delete copy.adminAuthor;
  return copy;
}

function normalizeConversation(conversation) {
  if (!conversation) return conversation;
  const copy = { ...conversation };
  copy.messages = (copy.messages || []).map((message) => ({ ...message, createdAt: at(message.createdAt) }));
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
  const requests = [];
  for (const conv of all) {
    if (state.rejectedRequests?.[conv.id]) continue;
    if (state.acceptedRequests?.[conv.id]) inbox.push(conv);
    else requests.push(conv);
  }
  return { inbox, requests };
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
  return status === "anonymous" || status === "anon" ? `${base}(anon)` : base;
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
  const result = await apiRequest(`/posts?${query.toString()}`);
  return {
    posts: (result.posts || []).map(normalizePost),
    pagination: result.pagination || {}
  };
}

async function fetchReelsPage({ offset = 0, limit = 10, category = "" } = {}) {
  const query = new URLSearchParams();
  query.set("limit", String(limit));
  query.set("offset", String(Math.max(0, Number(offset) || 0)));
  if (category) query.set("category", String(category).trim().toLowerCase());
  const result = await apiRequest(`/reels?${query.toString()}`);
  return {
    reels: (result.reels || []).map((reel) => ({
      ...reel,
      createdAt: at(reel.createdAt),
      likes: Array.isArray(reel.likes) ? reel.likes : []
    })),
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
    if (!reelsCategoryWarmDone) {
      await Promise.all(CONTENT_CATEGORIES.map(async (category) => {
        const { reels } = await fetchReelsPage({ category, limit: 10, offset: 0 });
        prefetchedCategoryReels[category] = reels.slice(0, 10);
      }));
      reelsCategoryWarmDone = true;
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

async function ensureReelsAhead() {
  if (!state.apiToken || reelsAheadPrefetchInFlight || reelsNextOffset == null) return;
  const currentCount = (state.reels || []).length;
  if (currentCount >= 20) return;
  reelsAheadPrefetchInFlight = true;
  try {
    while ((state.reels || []).length < 20 && reelsNextOffset != null) {
      const { reels, pagination } = await fetchReelsPage({ offset: reelsNextOffset, limit: 10 });
      state.reels = [...state.reels, ...reels];
      reelsNextOffset = pagination.nextOffset ?? null;
    }
    saveState();
  } catch (error) {
    console.error("ensureReelsAhead failed", error);
  } finally {
    reelsAheadPrefetchInFlight = false;
  }
}

async function refreshPosts(reset = true) {
  if (!state.apiToken) return;
  try {
    const offset = reset ? 0 : (postsNextOffset ?? 0);
    const { posts: next, pagination } = await fetchPostsPage({ offset, limit: 10 });
    state.posts = reset ? next : [...state.posts, ...next];
    postsNextOffset = pagination?.nextOffset ?? null;
    saveState();
    void ensurePostsAhead();
    void warmCategoryPools();
  } catch (error) {
    console.error("refreshPosts failed", error);
  }
}

async function refreshConversations() {
  if (!state.apiToken) return;
  try {
    const result = await apiRequest("/conversations");
    state.conversations = (result.conversations || []).map(normalizeConversation);
    if (!state.conversations.some((item) => item.id === activeConversationId)) {
      activeConversationId = state.conversations[0]?.id;
    }
    saveState();
  } catch (error) {
    console.error("refreshConversations failed", error);
  }
}

async function refreshStories() {
  if (!state.apiToken) return;
  try {
    const result = await apiRequest("/stories");
    state.stories = (result.stories || []).map((story) => ({ ...story, createdAt: at(story.createdAt) }));
    saveState();
  } catch (error) {
    console.error("refreshStories failed", error);
  }
}

async function refreshReels(reset = true) {
  if (!state.apiToken) return;
  try {
    const offset = reset ? 0 : (reelsNextOffset ?? 0);
    const { reels: next, pagination } = await fetchReelsPage({ offset, limit: 10 });
    state.reels = reset ? next : [...state.reels, ...next];
    reelsNextOffset = pagination?.nextOffset ?? null;
    saveState();
    void ensureReelsAhead();
    void warmCategoryPools();
  } catch (error) {
    console.error("refreshReels failed", error);
  }
}

async function refreshReports() {
  if (!state.apiToken) return;
  const user = currentUser();
  if (!user || user.role !== "admin") return;
  try {
    const result = await apiRequest("/admin/reports");
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
    const result = await apiRequest("/admin/audit-logs");
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
    const result = await apiRequest("/notifications");
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
    const result = await apiRequest("/suggestions");
    state.suggestions = result.suggestions || [];
    saveState();
  } catch (error) {
    console.error("refreshSuggestions failed", error);
  }
}

async function refreshQnaForProfile(profileId) {
  if (!state.apiToken || !profileId) return;
  try {
    const result = await apiRequest(`/users/${profileId}/qna`);
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
      followers: apiUser.followers !== undefined ? apiUser.followers : (existing?.followers || []),
      following: apiUser.following !== undefined ? apiUser.following : (existing?.following || []),
      online: true
    };
    const index = state.users.findIndex((user) => user.id === localUser.id);
    if (index >= 0) state.users[index] = { ...state.users[index], ...localUser };
    else state.users.push(localUser);
  }
}

async function bootstrapSession() {
  if (!state.apiToken) {
    render();
    return;
  }
  try {
    const result = await apiRequest("/me");
    mergeApiUser(result.user);
    await refreshStudents();
    await refreshPosts();
    await ensureDeepLinkedPostLoaded();
    await refreshConversations();
    await refreshStories();
    await refreshReels();
    await refreshNotifications();
    await refreshSuggestions();
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
    clearAuthDraftState();
    state.authMode = "login";
    state.authStep = "email";
    saveState();
  }
  render();
}

async function refreshAdminVerifications() {
  if (!state.apiToken) return;
  const user = currentUser();
  if (!user || user.role !== "admin") return;
  try {
    const result = await apiRequest("/admin/verifications");
    state.adminVerifications = Array.isArray(result.students) ? result.students : [];
    saveState();
  } catch (error) {
    console.error("refreshAdminVerifications failed", error);
  }
}

async function refreshStudents() {
  if (!state.apiToken) return;
  try {
    const result = await apiRequest("/students");
    mergeApiUsers(result.students || []);
    saveState();
  } catch (error) {
    console.error("refreshStudents failed", error);
  }
}

function userName(id, anonymous = false) {
  if (anonymous) return "Anonymous student";
  const user = state.users.find((item) => item.id === id);
  return user ? user.englishName : "Unknown";
}

function initials(user) {
  return user.englishName.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
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
  if (m.reelId) return `Reel ${m.reelId}`;
  if (m.conversationId) return `Conversation ${m.conversationId}`;
  if (m.reportId) return `Report ${m.reportId}`;
  return "System";
}

function metadataDetailsLabel(metadata = {}) {
  const entries = Object.entries(metadata || {}).filter(([key]) => !["userId", "postId", "commentId", "storyId", "reelId", "conversationId", "reportId"].includes(key));
  if (!entries.length) return "No extra details";
  return entries.slice(0, 4).map(([key, value]) => `${key}: ${value}`).join(" | ");
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
    popup.querySelector("[data-cancel]")?.addEventListener("click", () => {
      popup.remove();
      resolve(false);
    });
    popup.querySelector("[data-confirm]")?.addEventListener("click", () => {
      popup.remove();
      resolve(true);
    });
  });
}

function openMediaViewer(url, type = "") {
  const isVideo = String(type || "").startsWith("video/");
  const popup = showFormPopup("Media Viewer", `
    <div class="media-viewer">
      <div class="media-viewer-frame">
        ${isVideo
          ? `<video src="${escapeHtml(url)}" controls autoplay playsinline></video>`
          : `<img src="${escapeHtml(url)}" alt="Media preview" />`
        }
      </div>
    </div>
  `, "media-modal");
  return popup;
}

function showSharePopup(url, text = "", postId = "") {
  const conversations = (state.conversations || []).slice(0, 50);
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
            ? conversations.map((conv) => `<option value="${escapeHtml(conv.id)}">${escapeHtml(conv.title || "Conversation")}</option>`).join("")
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
    await navigator.clipboard.writeText(value);
    toast("Post link copied");
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

function render() {
  const user = currentUser();
  if (!user || state.authStep !== "app") {
    stopLiveChatLoop();
    renderAuth();
    return;
  }

  const adminVisible = user.role === "admin";
  const visibleNav = navItems.filter((item) => item[0] !== "admin" || adminVisible);
  document.querySelector("#app").innerHTML = `
    <div class="app ${view === "admin" ? "app-admin" : ""}">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">S</span><span>SHSID Social</span></div>
        <nav class="nav">
          ${visibleNav.map(([id, icon, label]) => `<button class="${view === id ? "active" : ""}" data-view="${id}"><span class="nav-ico">${icon}</span>${label}</button>`).join("")}
        </nav>
        <div class="session">
          <strong>${escapeHtml(user.englishName)}</strong>
          <span>Grade ${user.grade}, Class ${user.classNo}</span>
          <span>${user.role === "admin" ? "Admin" : user.status}</span>
          <button class="btn small ghost" data-action="logout" style="margin-top:10px;color:#fff;border-color:rgba(255,255,255,.25)">Logout</button>
        </div>
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
  preloadVisiblePostMedia();
  syncLiveChatLoop();
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

function setUploadProgress(label, percent) {
  uploadUi = { active: true, label: String(label || "Uploading..."), percent: Number(percent || 0) };
  render();
}

function clearUploadProgress() {
  uploadUi = { active: false, label: "", percent: 0 };
  render();
}

function conversationsSnapshot() {
  return JSON.stringify((state.conversations || []).map((conv) => ({
    id: conv.id,
    m: (conv.messages || []).length,
    l: conv.messages?.[conv.messages.length - 1]?.id || "",
    t: conv.messages?.[conv.messages.length - 1]?.createdAt || ""
  })));
}

function stopLiveChatLoop() {
  if (liveChatTimer) {
    clearInterval(liveChatTimer);
    liveChatTimer = null;
  }
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
    await refreshConversations();
    liveChatSnapshot = conversationsSnapshot();
    const next = conversationsSnapshot();
    if (next !== liveChatSnapshot) {
      liveChatSnapshot = next;
      render();
    }
  } catch (error) {
    console.error("pollLiveChatUpdates failed", error);
  } finally {
    liveChatPollInFlight = false;
  }
}

function renderAuth() {
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
      <div class="field"><label>English name</label><input id="reg-en" value="${escapeHtml(state.pendingEnglishName || "")}" placeholder="First Last" required></div>
      <div class="field"><label>Chinese name</label><input id="reg-cn" value="${escapeHtml(state.pendingChineseName || "")}" placeholder="中文姓名" required></div>
      <div class="grid two">
        <div class="field"><label>Year (1-12)</label><input id="reg-grade" type="number" min="1" max="12" value="${Number(state.pendingGrade || 10)}" required></div>
        <div class="field"><label>Class (1-13)</label><input id="reg-class" type="number" min="1" max="13" value="${Number(state.pendingClassNo || 1)}" required></div>
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
        <p>Feed, reels, stories, messaging, profiles, reports, verification, and admin moderation in one school-only platform.</p>
      </div>
    </section>
  `;
  bindAuth();
}

function page(title, subtitle, content, actions = "") {
  return `
    <div class="topbar">
      <div><h1>${title}</h1><p>${subtitle}</p></div>
      <div class="row">${actions}</div>
    </div>
    ${content}
  `;
}

function renderView() {
  const user = currentUser();
  if (user.status !== "verified" && user.role !== "admin" && view !== "profile") {
    return page("Verification pending", "Your account exists, but posting and messaging unlock after admin approval.", renderProfile());
  }
  const routes = {
    feed: renderFeed,
    "single-post": renderSinglePost,
    post: renderComposer,
    reels: renderReels,
    students: renderStudents,
    messages: renderMessages,
    stories: renderStories,
    profile: renderProfile,
    admin: renderAdmin
  };
  return (routes[view] || renderFeed)();
}

function renderSinglePost() {
  const post = state.posts.find((item) => item.id === deepLinkedPostId);
  if (!post) {
    return page("Shared Post", "Opening shared post...", `
      <section class="panel">
        <p class="muted">Loading post…</p>
        <div class="row"><button class="btn" data-action="back-feed">Back to feed</button></div>
      </section>
    `);
  }
  return page("Shared Post", "This is the single post shared with you.", `
    <section class="grid">
      <div class="row"><button class="btn" data-action="back-feed">Back to feed</button></div>
      ${renderPost(post)}
    </section>
  `);
}

function renderFeed() {
  const posts = [...state.posts].sort((a, b) => Number(b.sticky) - Number(a.sticky) || b.createdAt - a.createdAt);
  const storyStrip = state.stories.length
    ? state.stories.map(renderStoryMini).join("")
    : `<span class="empty-hint">No active stories — open <strong>Stories</strong> to post one.</span>`;
  const postsHtml = posts.length
    ? posts.map(renderPost).join("")
    : `<div class="empty-state">No posts yet. Share something positive or helpful to get the feed started.</div>`;
  return page("Feed", "Posts from followed students, categories, sticky announcements, comments, likes, and reports.", `
    <section class="panel" style="margin-bottom:16px">
      <div class="story-strip">${storyStrip}</div>
    </section>
    <section class="grid">${postsHtml}</section>
    ${postsNextOffset != null ? `<div class="row" style="justify-content:center"><button class="btn" data-action="load-more-posts">Load more posts</button></div>` : ""}
  `, `<button class="btn primary" data-view="post">New post</button>`);
}

function renderStoryMini(story) {
  const label = story.caption || (story.mediaUrl ? "Photo/Video story" : (story.text || "Story"));
  return `<button class="story" data-action="view-story" data-id="${story.id}">${escapeHtml(userName(story.authorId))}<span style="font-size:12px">${escapeHtml(label)} · ${timeAgo(story.createdAt)}</span></button>`;
}

function renderPost(post) {
  const author = state.users.find((u) => u.id === post.authorId);
  const likes = post.likes || [];
  const liked = likes.includes(state.currentUserId);
  const media = post.media || [];
  const mediaIndex = Math.max(0, Math.min((postMediaIndexByPostId[post.id] || 0), Math.max(0, media.length - 1)));
  const activeMedia = media.length ? media[mediaIndex] : null;
  return `
    <article class="card" data-post-id="${post.id}">
      <div class="post-head">
        <div class="avatar ${author?.role === "admin" ? "admin" : ""}">${post.anonymous ? "AN" : initials(author)}</div>
        <div style="min-width:0">
          <div class="between">
            <strong>${escapeHtml(userName(post.authorId, post.anonymous))}</strong>
            ${post.sticky ? `<span class="status gold">Sticky</span>` : ""}
          </div>
          <div class="muted">${post.category} · ${timeAgo(post.createdAt)} ${currentUser().role === "admin" && post.anonymous ? `· Admin sees ${escapeHtml(userName(post.authorId))}` : ""}</div>
        </div>
      </div>
      <div class="post-text">${escapeHtml(post.text || "")}</div>
      ${media.length ? `
        <div class="media-carousel">
          ${media.length > 1 ? `<button class="media-nav prev" type="button" data-action="media-prev" data-id="${post.id}" ${mediaIndex === 0 ? "disabled" : ""}>&#8249;</button>` : ""}
          <div class="media-stage">${renderPostMedia(activeMedia)}</div>
          ${media.length > 1 ? `<button class="media-nav next" type="button" data-action="media-next" data-id="${post.id}" ${mediaIndex >= media.length - 1 ? "disabled" : ""}>&#8250;</button>` : ""}
          ${media.length > 1 ? `<div class="media-dots">${media.map((_, idx) => `<span class="media-dot ${idx === mediaIndex ? "active" : ""}"></span>`).join("")}</div>` : ""}
        </div>
      ` : ""}
      ${(post.comments || []).map((comment) => `
        <p class="comment">
          <strong>${escapeHtml(userName(comment.authorId, comment.anonymous))}:</strong> ${escapeHtml(comment.text)}
          ${currentUser().role === "admin" ? `<button class="btn small danger" style="margin-left:8px" data-action="delete-comment" data-id="${post.id}:${comment.id}">Delete</button>` : ""}
        </p>
      `).join("")}
      ${openCommentPostId === post.id ? `
        <div class="comment-composer">
          <textarea id="comment-text-${post.id}" placeholder="Write a comment..."></textarea>
          <div class="row">
            <select id="comment-anon-${post.id}" class="btn small">
              <option value="false">Public</option>
              <option value="true">Anonymous</option>
            </select>
            <button class="btn small primary" data-action="submit-comment" data-id="${post.id}">Send</button>
            <button class="btn small" data-action="close-comment" data-id="${post.id}">Cancel</button>
          </div>
        </div>
      ` : ""}
      <div class="post-actions">
        <button class="btn small" data-action="like-post" data-id="${post.id}">${liked ? "Liked" : "Like"} · ${likes.length}</button>
        <button class="btn small" data-action="comment-post" data-id="${post.id}">Comment</button>
        <button class="btn small" data-action="share-post" data-id="${post.id}">Share</button>
        <button class="btn small" data-action="report-post" data-id="${post.id}">Report</button>
        ${currentUser().role === "admin" ? `<button class="btn small" data-action="toggle-sticky" data-id="${post.id}">${post.sticky ? "Unpin" : "Pin"}</button><button class="btn small danger" data-action="delete-post" data-id="${post.id}">Delete</button>` : ""}
      </div>
    </article>
  `;
}

function renderComposer() {
  return page("Create Post", "Post publicly or anonymously with text, photos, and videos.", `
    <section class="composer">
      <div class="field"><label>Post text</label><textarea id="post-text" placeholder="What do you want to share?"></textarea></div>
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

function renderReels() {
  const uid = state.currentUserId;
  const tiles = state.reels.map((reel) => {
    const likes = reel.likes || [];
    const liked = likes.includes(uid);
    const commentCount = Number(reel.commentCount || 0);
    const videoUrl = reel.videoUrl || reel.video_url || "";
    const openable = videoUrl && videoUrl !== "pending-upload" && /^https?:\/\//i.test(videoUrl);
    return `
      <article class="reel-screen">
        <div class="reel-media-shell">
          ${openable
            ? `<video class="reel-media" src="${escapeHtml(videoUrl)}" controls preload="metadata" playsinline></video>`
            : `<div class="reel-media reel-media-empty">Video pending upload</div>`
          }
          <div class="reel-overlay">
            <div class="reel-meta-block">
              <span class="chip">${escapeHtml(reel.category)}</span>
              <h2>${escapeHtml(reel.title)}</h2>
              <p class="reel-meta">${escapeHtml(userName(reel.authorId))} · ${likes.length} likes · ${timeAgo(reel.createdAt)}</p>
            </div>
            <div class="reel-actions">
              <button class="btn small ${liked ? "primary" : ""}" data-action="like-reel" data-id="${reel.id}">${liked ? "Liked" : "Like"}</button>
              <button class="btn small" data-action="comment-reel" data-id="${reel.id}">Comment · ${commentCount}</button>
            </div>
          </div>
        </div>
      </article>
    `;
  }).join("");
  const grid = tiles || `<div class="empty-state">No reels yet. Add one below or ask classmates to share.</div>`;
  return page("Reels", "Vertical snap feed for short videos.", `
    <section class="composer" style="margin-bottom:16px">
      <div class="grid two">
        <div class="field"><label>Title</label><input id="reel-title" placeholder="What is this reel about?" /></div>
        <div class="field"><label>Category</label><select id="reel-category"><option>school</option><option>lifestyle</option><option>gaming</option><option>academic</option></select></div>
      </div>
      <div class="field"><label>Upload reel video (optional)</label><input id="reel-video-file" type="file" accept="video/*" /></div>
      <button class="btn primary" data-action="create-reel">Publish reel</button>
    </section>
    <section class="reel-feed">${grid}</section>
    ${reelsNextOffset != null ? `<div class="row" style="justify-content:center"><button class="btn" data-action="load-more-reels">Load more reels</button></div>` : ""}
  `);
}

function renderStudents() {
  return page("Students", "Browse verified classmates, follow profiles, message students, and ask Q&A box questions.", `
    <section class="grid two">${state.users.filter((u) => u.role !== "admin" && u.status === "verified").map((user) => `
      <article class="panel" data-action="view-profile" data-id="${user.id}" style="cursor:pointer">
        <div class="between">
          <div class="row"><div class="avatar">${initials(user)}</div><div><strong>${escapeHtml(user.englishName)}</strong><div class="muted">Grade ${user.grade}, Class ${user.classNo} · ${escapeHtml(user.chineseName)}</div></div></div>
        </div>
        <p>${escapeHtml(user.bio)}</p>
        <div class="row">
          <button class="btn small" data-action="follow" data-id="${user.id}">${currentUser().following.includes(user.id) ? "Following" : "Follow"}</button>
          <button class="btn small" data-action="start-chat" data-id="${user.id}">Message</button>
          <button class="btn small" data-action="ask-qna" data-id="${user.id}">Ask</button>
        </div>
      </article>
    `).join("")}</section>
  `);
}

function renderMessages() {
  const { inbox, requests } = classifyConversations();
  const list = conversationTab === "requests" ? requests : inbox;
  const active = list.find((item) => item.id === activeConversationId) || list[0] || inbox[0] || requests[0];
  const receiverName = active ? conversationCounterpartName(active) : "No receiver";
  const identityMode = active ? getConversationIdentityMode(active.id) : "public";
  const requestView = conversationTab === "requests";
  const accepted = active ? Boolean(state.acceptedRequests?.[active.id]) : false;
  const firstAuthorId = active?.messages?.[0]?.authorId || "";
  const isReceiverPending = requestView && active && !accepted && firstAuthorId && firstAuthorId !== currentUser().id;
  const canSendInCurrentThread = !isReceiverPending;
  const counterpartId = active && !active.group ? (active.members || []).find((memberId) => memberId !== currentUser().id) : "";
  const counterpartRemark = counterpartId ? getRemarkForUser(counterpartId) : "";
  return page("Messages", "Real-time style direct and group messaging, anonymous sending, reporting, and admin monitoring.", `
    <section class="grid two chat-layout">
      <div class="panel chat-panel chat-panel-list">
        <div class="between" style="margin-bottom:12px"><strong>Conversations</strong><div class="row"><button class="btn small" data-action="open-start-direct">Direct</button><button class="btn small" data-action="open-create-convo">Create convo</button></div></div>
        <div class="row" style="margin-bottom:12px">
          <button class="btn ${conversationTab === "inbox" ? "primary" : ""}" data-action="chat-tab-inbox">Inbox (${inbox.length})</button>
          <button class="btn ${conversationTab === "requests" ? "primary" : ""}" data-action="chat-tab-requests">Requests (${requests.length})</button>
        </div>
        <div class="grid chat-list-scroll">${list.length
          ? list.map((conv) => `<button class="btn ${active?.id === conv.id ? "primary" : ""}" data-action="open-conv" data-id="${conv.id}">${escapeHtml(conversationDisplayTitle(conv))}</button>`).join("")
          : `<p class="muted">No conversations in this tab yet.</p>`}</div>
      </div>
      <div class="panel chat-panel chat-panel-thread">
        <div class="between"><strong>${escapeHtml(active ? conversationDisplayTitle(active) : "No conversation")}</strong><span class="chip">Active</span></div>
        <p class="muted" style="margin:8px 0 0">Receiver: ${escapeHtml(receiverName)}</p>
        ${active ? `<div class="row" style="margin:6px 0 0"><button class="btn small" data-action="rename-conv" data-id="${active.id}">Rename Chat</button></div>` : ""}
        ${counterpartId ? `<p class="muted" style="margin:6px 0 0">Remark: ${escapeHtml(counterpartRemark || "None")} <button class="btn small" data-action="edit-remark" data-id="${counterpartId}">Edit</button></p>` : ""}
        <div class="grid chat-messages-scroll" style="margin:14px 0">${(active?.messages || []).map((message) => `
          <div class="comment" style="margin:0"><strong>${escapeHtml(userName(message.authorId, message.anonymous))}:</strong> ${escapeHtml(message.text)} ${(message.media || []).map((item) => renderChatMediaItem(item)).join("")} <span class="muted">(${message.anonymous ? "anonymous" : "public"})</span> ${message.authorId === currentUser().id ? `<span class="muted">· receiver sees: ${message.anonymous ? "Anonymous student" : escapeHtml(userName(currentUser().id))}</span>` : ""} ${currentUser().role === "admin" && message.anonymous ? `<span class="muted">(real: ${escapeHtml(userName(message.authorId))})</span>` : ""}</div>
        `).join("")}</div>
        ${requestView && active && !accepted ? `<div class="row" style="margin-bottom:12px"><button class="btn primary" data-action="accept-request" data-id="${active.id}">Accept request</button><button class="btn danger" data-action="reject-request" data-id="${active.id}">Reject request</button></div>` : ""}
        ${isReceiverPending ? `<p class="muted" style="margin:0 0 10px">Accept this request before sending messages.</p>` : ""}
        <div class="field"><label>Message</label><textarea id="message-text" placeholder="Type a message"></textarea></div>
        <div class="field"><label>Photo / Video</label><input id="message-media-file" type="file" accept="image/*,video/*" multiple /></div>
        <p class="muted" style="margin:0">Receiver will see you as: <span id="message-identity-preview">${identityMode === "anonymous" ? "Anonymous student" : escapeHtml(userName(currentUser().id))}</span></p>
        <div class="row">
          <button class="btn primary" data-action="send-message" data-id="${active?.id || ""}" ${canSendInCurrentThread ? "" : "disabled"}>Send</button>
          <button class="btn" data-action="report-message" data-id="${active?.id || ""}">Report</button>
        </div>
      </div>
    </section>
  `);
}

function renderStories() {
  return page("Stories", "24-hour stories with viewers and archives planned for production retention.", `
    <section class="composer" style="margin-bottom:16px">
      <div class="field"><label>Caption (optional)</label><input id="story-caption" placeholder="Add a caption (or leave empty)" /></div>
      <div class="field">
        <label>Photo or video (optional)</label>
        <div id="story-dropzone" class="dropzone">Drag and drop a photo/video here, or click to pick file.</div>
        <input id="story-media-file" type="file" accept="image/*,video/*" />
        <div id="story-file-chips" class="file-chips"></div>
      </div>
      <button class="btn primary" data-action="create-story">Post story</button>
    </section>
    <section class="grid three">${state.stories.map((story) => `
      <article class="story" style="min-height:220px;cursor:pointer" data-action="view-story" data-id="${story.id}">
        <strong>${escapeHtml(story.caption || "Story")}</strong>
        ${story.mediaUrl ? `${String(story.mediaType || "").startsWith("video/")
          ? `<video src="${escapeHtml(story.mediaUrl)}" controls preload="metadata" style="margin-top:8px;width:100%;max-height:180px;border-radius:10px;border:1px solid var(--line)"></video>`
          : `<img src="${escapeHtml(story.mediaUrl)}" alt="Story media" loading="lazy" style="margin-top:8px;width:100%;max-height:180px;object-fit:cover;border-radius:10px;border:1px solid var(--line)" />`
        }` : ""}
        <span>${escapeHtml(userName(story.authorId))} · ${story.views.length} views</span>
        ${story.authorId === state.currentUserId || currentUser().role === "admin" ? `<button class="btn small danger" data-action="delete-story" data-id="${story.id}" style="margin-top:10px">Delete</button>` : ""}
      </article>
    `).join("")}</section>
  `);
}

function renderProfile() {
  const me = currentUser();
  if (!me) return page("Profile", "Loading profile…", `<section class="panel"><p class="muted">Please wait.</p></section>`);
  const selected = state.users.find((u) => u.id === state.selectedProfileId);
  const user = selected || me;
  const questions = state.qna.filter((q) => q.profileId === user.id);
  return page("Profile", "Your public profile, verification status, Q&A box, notification settings, and privacy controls.", `
    <section class="grid two">
      <div class="panel">
        <div class="row"><div class="avatar ${user.role === "admin" ? "admin" : ""}">${initials(user)}</div><div><h2>${escapeHtml(user.englishName)}</h2><p class="muted">${escapeHtml(user.chineseName)} · Grade ${user.grade}, Class ${user.classNo}</p></div></div>
        <p>${escapeHtml(user.bio)}</p>
        <span class="status ${user.status === "verified" ? "green" : "gold"}">${user.status}</span>
      </div>
      <div class="panel">
        <h3>Q&A Box</h3>
        ${questions.length ? questions.map((q) => `<button class="comment qna-item" data-action="open-qna" data-id="${q.id}" style="text-align:left"><strong>${escapeHtml(q.question)}</strong><br>${escapeHtml(q.answer || "Waiting for answer")}</button>`).join("") : `<p class="muted">No questions yet.</p>`}
        <h3>Suggestion Box</h3>
        ${state.suggestions.map((s) => `<p class="comment">${escapeHtml(s.text)} · ${escapeHtml(s.status)}</p>`).join("")}
      </div>
    </section>
  `);
}

function renderAdmin() {
  if (currentUser().role !== "admin") return page("Unavailable", "Admin access required.", "");
  const pending = state.adminVerifications || [];
  const conversations = (state.conversations || []).slice().sort((a, b) => at(b.createdAt) - at(a.createdAt));
  const filteredConversations = conversations.filter((conversation) => {
    if (adminChatMonitorFilter === "direct") return !conversation.group;
    if (adminChatMonitorFilter === "group") return conversation.group;
    return true;
  });
  const activeMonitored = filteredConversations.find((conversation) => conversation.id === adminActiveConversationId) || filteredConversations[0];
  return page("Admin", "Verification, reports, bans, audit trails, anonymous author visibility, and compliance exports.", `
    <section class="admin-grid">
      <div class="panel admin-panel">
        <h2>Chat Monitor</h2>
        <div class="row" style="margin-bottom:12px">
          <button class="btn ${adminChatMonitorFilter === "all" ? "primary" : ""}" data-action="admin-chat-filter" data-id="all">All</button>
          <button class="btn ${adminChatMonitorFilter === "direct" ? "primary" : ""}" data-action="admin-chat-filter" data-id="direct">Direct</button>
          <button class="btn ${adminChatMonitorFilter === "group" ? "primary" : ""}" data-action="admin-chat-filter" data-id="group">Convo</button>
        </div>
        <div class="grid two">
          <div class="grid" style="max-height:360px;overflow:auto;align-content:start">
            ${filteredConversations.length
              ? filteredConversations.map((conversation) => `<button class="btn ${activeMonitored?.id === conversation.id ? "primary" : ""}" data-action="admin-open-chat" data-id="${conversation.id}">${escapeHtml(conversationDisplayTitle(conversation, true))} · ${conversation.group ? "convo" : "direct"}</button>`).join("")
              : `<p class="muted">No chats for this filter.</p>`
            }
          </div>
          <div class="grid" style="max-height:360px;overflow:auto;align-content:start">
            <strong>${escapeHtml(activeMonitored ? conversationDisplayTitle(activeMonitored, true) : "No chat selected")}</strong>
            ${(activeMonitored?.messages || []).map((message) => `<div class="comment"><strong>${escapeHtml(userName(message.authorId, false))}</strong> <span class="muted">(${message.anonymous ? "anon" : "public"})</span><br>${escapeHtml(message.text || "")}</div>`).join("") || `<p class="muted">No messages yet.</p>`}
          </div>
        </div>
      </div>
      <div class="grid three">
        <div class="panel"><span class="muted">Pending verification</span><h2>${pending.length}</h2></div>
        <div class="panel"><span class="muted">Open reports</span><h2>${state.reports.filter((r) => r.status === "pending").length}</h2></div>
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
          <table class="table"><thead><tr><th>Reporter</th><th>Target</th><th>Reason</th><th>Status</th><th>Actions</th></tr></thead><tbody>
            ${state.reports.map((report) => `<tr><td>${escapeHtml(userName(report.reporterId))}<br><span class="muted">${escapeHtml(report.reporterId || "-")}</span></td><td>${escapeHtml(report.type)}<br><span class="muted">${escapeHtml(report.targetId || "-")}</span></td><td>${escapeHtml(report.reason)}</td><td>${escapeHtml(report.status)}</td><td><div class="admin-actions"><button class="btn small" data-action="resolve-report" data-id="${report.id}">Resolve</button></div></td></tr>`).join("")}
          </tbody></table>
        </div>
      </div>
      <div class="panel admin-panel">
        <h2>Audit Trail</h2>
        <div class="table-wrap">
          <table class="table"><thead><tr><th>Actor</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th><th>Time</th></tr></thead><tbody>
            ${state.audit.map((item) => `<tr><td>${escapeHtml(userName(item.userId))}<br><span class="muted">${escapeHtml(item.userId || "-")}</span></td><td>${escapeHtml(formatActionLabel(item.action))}</td><td>${escapeHtml(metadataTargetLabel(item.metadata || {}))}</td><td><span class="muted">${escapeHtml(metadataDetailsLabel(item.metadata || {}))}</span></td><td>${escapeHtml(item.ip || "-")}</td><td>${new Date(item.createdAt).toLocaleString()}<br><span class="muted">${timeAgo(item.createdAt)} ago</span></td></tr>`).join("")}
          </tbody></table>
        </div>
      </div>
    </section>
  `);
}

function renderRightbar() {
  const user = currentUser();
  const unread = state.notifications.filter((item) => item.userId === user.id && !item.read);
  const leaders = [...state.posts].sort((a, b) => b.likes.length - a.likes.length).slice(0, 3);
  return `
    <div class="grid">
      <section class="panel">
        <div class="between"><strong>Notifications</strong><button class="btn small" data-action="mark-read">Read</button></div>
        ${unread.length ? unread.map((n) => `<p class="comment" style="margin:10px 0 0">${escapeHtml(n.text)}</p>`).join("") : `<p class="muted">No unread notifications.</p>`}
      </section>
      <section class="panel">
        <strong>Post of the Day</strong>
        ${leaders.map((post) => `<p class="comment" style="margin:10px 0 0">${escapeHtml(post.category)} · ${post.likes.length} likes<br>${escapeHtml(post.text.slice(0, 80))}</p>`).join("")}
      </section>
      <section class="panel">
        <strong>Safety Status</strong>
        <p class="muted">Rate limits, upload scanning, email delivery, and push delivery are production backend tasks documented in the launch plan.</p>
      </section>
    </div>
  `;
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", async () => {
      view = button.dataset.view;
      if (view === "profile") {
        state.selectedProfileId = null;
        await refreshSuggestions();
        await refreshQnaForProfile(state.currentUserId);
      }
      if (view === "admin") {
        await refreshAdminVerifications();
        await refreshReports();
        await refreshAuditLogs();
      }
      if (view === "messages") await refreshConversations();
      if (view === "feed") await refreshPosts();
      render();
    });
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (button.dataset.busy === "1") return;
      button.dataset.busy = "1";
      button.disabled = true;
      try {
        await handleAction(button.dataset.action, button.dataset.id);
      } catch (error) {
        toast(error.message || "Action failed");
      } finally {
        button.dataset.busy = "0";
        button.disabled = false;
      }
    });
  });

  setupDropzone("post-dropzone", "post-media", true);
  setupDropzone("story-dropzone", "story-media-file", false);
  bindFileChips("post-media", "post-file-chips");
  bindFileChips("story-media-file", "story-file-chips");

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
          try {
            if (state.apiToken) await apiRequest("/auth/logout", { method: "POST", body: JSON.stringify({}) });
          } catch {
            // ignore
          }
          state.apiToken = null;
          state.currentUserId = null;
          clearAuthDraftState();
          state.adminVerifications = [];
          state.authMode = "login";
          state.authStep = "email";
          stopLiveChatLoop();
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

  document.querySelector("#auth-profile-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const englishName = document.querySelector("#reg-en").value.trim();
    const chineseName = document.querySelector("#reg-cn").value.trim();
    const grade = Number(document.querySelector("#reg-grade").value);
    const classNo = Number(document.querySelector("#reg-class").value);
    if (!englishName || !chineseName) return toast("Enter both names");
    if (!Number.isInteger(grade) || grade < 1 || grade > 12) return toast("Year must be 1-12");
    if (!Number.isInteger(classNo) || classNo < 1 || classNo > 13) return toast("Class must be 1-13");
    state.pendingEnglishName = englishName;
    state.pendingChineseName = chineseName;
    state.pendingGrade = grade;
    state.pendingClassNo = classNo;
    state.pendingVerificationWords = generateVerificationWords(10);
    state.authStep = "video";
    saveState();
    render();
  });

  document.querySelector("#auth-video-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      setAuthInFlight(true);
      const videoFile = document.querySelector("#reg-video").files[0];
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

}

async function handleAction(action, id) {
  const user = currentUser();
  if (action === "logout") {
    try {
      if (state.apiToken) await apiRequest("/auth/logout", { method: "POST", body: JSON.stringify({}) });
    } catch {
      // ignore
    }
    state.apiToken = null;
    state.currentUserId = null;
    clearAuthDraftState();
    state.authMode = "login";
    state.authStep = "email";
    stopLiveChatLoop();
  }
  if (action === "create-post") {
    const text = document.querySelector("#post-text").value.trim();
    const files = [...document.querySelector("#post-media").files].slice(0, 20);
    if (!text && !files.length) return toast("Write something or attach media");
    const media = files.length ? await uploadFiles(files) : [];
    await apiRequest("/posts", {
      method: "POST",
      body: JSON.stringify({
        text,
        anonymous: document.querySelector("#post-anon").value === "true",
        category: document.querySelector("#post-category").value,
        media
      })
    });
    await refreshPosts();
    view = "feed";
    toast("Post published");
  }
  if (action === "load-more-posts") {
    if (postsNextOffset == null) return;
    await refreshPosts(false);
  }
  if (action === "like-post") {
    const result = await apiRequest(`/posts/${id}/like`, { method: "POST", body: JSON.stringify({}) });
    const idx = state.posts.findIndex((item) => item.id === id);
    if (idx >= 0) state.posts[idx] = normalizePost(result.post);
  }
  if (action === "media-prev") {
    const post = state.posts.find((item) => item.id === id);
    const total = post?.media?.length || 0;
    if (!total) return;
    const current = postMediaIndexByPostId[id] || 0;
    postMediaIndexByPostId[id] = Math.max(0, current - 1);
    updatePostMediaCarousel(id);
    return;
  }
  if (action === "media-next") {
    const post = state.posts.find((item) => item.id === id);
    const total = post?.media?.length || 0;
    if (!total) return;
    const current = postMediaIndexByPostId[id] || 0;
    postMediaIndexByPostId[id] = Math.min(total - 1, current + 1);
    updatePostMediaCarousel(id);
    return;
  }
  if (action === "comment-post") {
    openCommentPostId = openCommentPostId === id ? null : id;
  }
  if (action === "close-comment") {
    openCommentPostId = null;
  }
  if (action === "submit-comment") {
    const text = String(document.querySelector(`#comment-text-${id}`)?.value || "").trim();
    const anonymous = document.querySelector(`#comment-anon-${id}`)?.value === "true";
    if (!text) return toast("Enter a comment");
    await apiRequest(`/posts/${id}/comments`, { method: "POST", body: JSON.stringify({ text, anonymous }) });
    openCommentPostId = null;
    await refreshPosts();
  }
  if (action === "report-post") {
    const reason = await askTextPopup("Report Post", "Reason", "Describe the issue");
    if (!reason) return;
    await apiRequest("/reports", { method: "POST", body: JSON.stringify({ targetType: "post", targetId: id, reason }) });
    if (user.role === "admin") await refreshReports();
  }
  if (action === "share-post") {
    const shareUrl = `${window.location.origin}/?post=${encodeURIComponent(id)}`;
    const post = state.posts.find((item) => item.id === id);
    const text = post?.text ? post.text.slice(0, 120) : "Check this post";
    showSharePopup(shareUrl, text, id);
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
    const post = state.posts.find((item) => item.id === id);
    if (!post) return;
    await apiRequest(`/posts/${id}`, { method: "PATCH", body: JSON.stringify({ sticky: !post.sticky }) });
    await refreshPosts();
  }
  if (action === "delete-post") {
    const ok = await askConfirmPopup("Delete Post", "This will delete the post from feed. Continue?", "Delete");
    if (!ok) return;
    await apiRequest(`/posts/${id}`, { method: "DELETE" });
    await refreshPosts();
    toast("Post deleted");
  }
  if (action === "delete-comment") {
    const [postId, commentId] = String(id || "").split(":");
    if (!postId || !commentId) return;
    const ok = await askConfirmPopup("Delete Comment", "This will remove the comment. Continue?", "Delete");
    if (!ok) return;
    await apiRequest(`/posts/${postId}/comments/${commentId}`, { method: "DELETE" });
    await refreshPosts();
    toast("Comment deleted");
  }
  if (action === "follow") {
    const result = await apiRequest(`/users/${id}/follow`, { method: "POST", body: JSON.stringify({}) });
    mergeApiUsers([result.user]);
  }
  if (action === "view-profile") {
    state.selectedProfileId = id;
    view = "profile";
    await refreshQnaForProfile(id);
  }
  if (action === "start-chat") {
    const target = state.users.find((item) => item.id === id);
    if (!target || target.role === "admin" || target.status !== "verified") return toast("Only verified students can be messaged");
    const mode = await askIdentityModePopup(target.englishName || "student");
    if (!mode) return;
    const result = await apiRequest("/conversations", { method: "POST", body: JSON.stringify({ memberIds: [id], group: false }) });
    setConversationIdentityMode(result.conversation.id, mode);
    conversationTab = "requests";
    await refreshConversations();
    activeConversationId = result.conversation.id;
    view = "messages";
  }
  if (action === "send-message") {
    const conversation = state.conversations.find((item) => item.id === id);
    const accepted = Boolean(state.acceptedRequests?.[id]);
    const firstAuthorId = conversation?.messages?.[0]?.authorId || "";
    if (!accepted && firstAuthorId && firstAuthorId !== user.id) return toast("Accept request before replying");
    const text = document.querySelector("#message-text").value.trim();
    const mediaFiles = [...(document.querySelector("#message-media-file")?.files || [])];
    if ((!text && !mediaFiles.length) || !id) return toast("Enter a message or attach media");
    const media = mediaFiles.length ? await uploadFiles(mediaFiles) : [];
    const anonymous = getConversationIdentityMode(id) === "anonymous";
    await apiRequest(`/conversations/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, media, anonymous })
    });
    document.querySelector("#message-text").value = "";
    if (document.querySelector("#message-media-file")) document.querySelector("#message-media-file").value = "";
    await refreshConversations();
  }
  if (action === "edit-remark") {
    const existing = getRemarkForUser(id);
    const next = await askTextPopup("Set Remark", "Remark name", existing || "Enter remark");
    if (next == null) return;
    setRemarkForUser(id, next);
    render();
    return;
  }
  if (action === "open-conv") activeConversationId = id;
  if (action === "rename-conv") {
    const conv = state.conversations.find((item) => item.id === id);
    if (!conv) return;
    const next = await askTextPopup("Rename Chat", "New title", conv.title || "Conversation");
    if (next == null) return;
    const title = next.trim();
    if (!title) return toast("Title cannot be empty");
    await apiRequest(`/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title }) });
    await refreshConversations();
    toast("Chat title updated");
  }
  if (action === "chat-tab-inbox") {
    conversationTab = "inbox";
    const next = classifyConversations().inbox[0];
    activeConversationId = next?.id || activeConversationId;
  }
  if (action === "chat-tab-requests") {
    conversationTab = "requests";
    const next = classifyConversations().requests[0];
    activeConversationId = next?.id || activeConversationId;
  }
  if (action === "accept-request") {
    if (!id) return;
    if (!state.acceptedRequests || typeof state.acceptedRequests !== "object") state.acceptedRequests = {};
    state.acceptedRequests[id] = true;
    saveState();
    conversationTab = "inbox";
    activeConversationId = id;
    toast("Request accepted");
  }
  if (action === "reject-request") {
    if (!id) return;
    if (!state.rejectedRequests || typeof state.rejectedRequests !== "object") state.rejectedRequests = {};
    state.rejectedRequests[id] = true;
    saveState();
    const next = classifyConversations().requests[0] || classifyConversations().inbox[0];
    activeConversationId = next?.id || "";
    toast("Request rejected");
  }
  if (action === "open-start-direct") {
    const choices = state.users.filter((item) => item.id !== user.id && item.role !== "admin" && item.status === "verified");
    if (!choices.length) return toast("No verified students available");
    const popup = showFormPopup("Start Direct Message", `
      <form id="direct-start-form" class="grid">
        <div class="field"><label>Search verified students</label><input id="direct-search" placeholder="Search by name, grade, class" /></div>
        <div id="direct-list" class="grid" style="max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:8px">
          ${choices.map((item) => `<button class="btn" type="button" data-direct-target="${escapeHtml(item.id)}">${escapeHtml(item.englishName)} <span class="muted">· G${item.grade} C${item.classNo}</span></button>`).join("")}
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
        const targetId = button.getAttribute("data-direct-target");
        const target = choices.find((item) => item.id === targetId);
        const mode = await askIdentityModePopup(target?.englishName || "student");
        if (!mode) return;
        const result = await apiRequest("/conversations", { method: "POST", body: JSON.stringify({ memberIds: [targetId], group: false }) });
        setConversationIdentityMode(result.conversation.id, mode);
        conversationTab = "requests";
        await refreshConversations();
        activeConversationId = result.conversation.id;
        popup.remove();
        render();
      });
    });
    return;
  }
  if (action === "open-create-convo") {
    const choices = state.users.filter((item) => item.id !== user.id && item.role !== "admin" && item.status === "verified");
    const popup = showFormPopup("Create Conversation", `
      <form id="create-convo-form" class="grid">
        <div class="field"><label>Title (optional)</label><input id="create-convo-title" placeholder="Conversation title"></div>
        <div class="field">
          <label>Find verified students</label>
          <input id="create-convo-search" placeholder="Search by name, grade, class" />
        </div>
        <div id="create-convo-list" class="grid" style="max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:8px">
          ${choices.map((item) => `
            <label class="row" style="justify-content:flex-start;gap:10px;padding:6px;border-radius:8px">
              <input type="checkbox" value="${escapeHtml(item.id)}" data-convo-member />
              <span><strong>${escapeHtml(item.englishName)}</strong> <span class="muted">· G${item.grade} C${item.classNo}</span></span>
            </label>
          `).join("") || `<p class="muted">No verified students available.</p>`}
        </div>
        <div class="row">
          <button class="btn primary" type="submit">Create</button>
          <button class="btn" type="button" data-cancel>Create later</button>
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
      const memberIds = [...popup.querySelectorAll("[data-convo-member]:checked")].map((input) => input.value).filter(Boolean);
      if (!memberIds.length) return toast("Select at least one member");
      const title = String(popup.querySelector("#create-convo-title").value || "").trim();
      const payload = { memberIds, group: memberIds.length > 1, title: title || undefined };
      await apiRequest("/conversations", { method: "POST", body: JSON.stringify(payload) });
      popup.remove();
      await refreshConversations();
      conversationTab = "requests";
      activeConversationId = state.conversations[0]?.id;
      toast("Conversation created");
      render();
    });
    return;
  }
  if (action === "admin-chat-filter") {
    adminChatMonitorFilter = id || "all";
    adminActiveConversationId = "";
  }
  if (action === "admin-open-chat") {
    adminActiveConversationId = id || "";
  }
  if (action === "new-group") {
    const memberIds = [...new Set(state.users.filter((item) => item.id !== user.id && item.role !== "admin").map((item) => item.id))];
    const peers = memberIds.length ? memberIds : state.users.filter((item) => item.id !== user.id).map((item) => item.id);
    if (!peers.length) return toast("No classmates to add yet");
    await apiRequest("/conversations", { method: "POST", body: JSON.stringify({ memberIds: peers, group: true, title: "New group chat" }) });
    await refreshConversations();
    activeConversationId = state.conversations[0]?.id;
    view = "messages";
  }
  if (action === "report-message") {
    const reason = await askTextPopup("Report Conversation", "Reason", "Describe the issue");
    if (!reason) return;
    await apiRequest("/reports", { method: "POST", body: JSON.stringify({ targetType: "conversation", targetId: id, reason }) });
    if (user.role === "admin") await refreshReports();
  }
  if (action === "create-story") {
    const caption = document.querySelector("#story-caption")?.value?.trim() || "";
    const mediaFile = document.querySelector("#story-media-file")?.files?.[0];
    let mediaUrl = "";
    let mediaType = "";
    if (mediaFile) {
      const [uploaded] = await uploadFiles([mediaFile], { purpose: "story" });
      mediaUrl = uploaded?.url || "";
      mediaType = uploaded?.type || mediaFile.type || "";
    }
    if (!caption && !mediaUrl) return toast("Add a caption, a photo/video, or both");
    await apiRequest("/stories", { method: "POST", body: JSON.stringify({ caption, mediaUrl, mediaType }) });
    await refreshStories();
  }
  if (action === "view-story") {
    await apiRequest(`/stories/${id}/view`, { method: "POST", body: JSON.stringify({}) });
    await refreshStories();
    const story = state.stories.find((item) => item.id === id);
    const views = story?.views?.length ?? 0;
    if (!story) return;
    if (story.mediaUrl) {
      openMediaViewer(story.mediaUrl, story.mediaType || "");
      return;
    }
    showPopup("Story", `${story.caption || story.text || ""}\n\n${userName(story.authorId)} · ${views} views`);
  }
  if (action === "delete-story") {
    const ok = await askConfirmPopup("Delete Story", "This will remove your story immediately. Continue?", "Delete");
    if (!ok) return;
    await apiRequest(`/stories/${id}`, { method: "DELETE" });
    await refreshStories();
  }
  if (action === "create-reel") {
    const title = document.querySelector("#reel-title").value.trim();
    if (!title) return toast("Add a reel title");
    const category = document.querySelector("#reel-category").value;
    const videoFile = document.querySelector("#reel-video-file").files[0];
    let videoUrl = "";
    if (videoFile) {
      const [uploaded] = await uploadFiles([videoFile]);
      videoUrl = uploaded?.url || "";
    }
    await apiRequest("/reels", {
      method: "POST",
      body: JSON.stringify({ title, category, videoUrl })
    });
    await refreshReels();
    view = "reels";
    toast("Reel published");
  }
  if (action === "load-more-reels") {
    if (reelsNextOffset == null) return;
    await refreshReels(false);
  }
  if (action === "like-reel") {
    await apiRequest(`/reels/${id}/like`, { method: "POST", body: JSON.stringify({}) });
    await refreshReels();
  }
  if (action === "comment-reel") {
    const payload = await askCommentPopup();
    if (!payload) return;
    await apiRequest(`/reels/${id}/comments`, { method: "POST", body: JSON.stringify(payload) });
    await refreshReels();
    toast("Comment added");
  }
  if (action === "verify-user") {
    await apiRequest(`/admin/verifications/${id}`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" })
    });
    await refreshAdminVerifications();
    await refreshStudents();
  }
  if (action === "reject-user") {
    const ok = await askConfirmPopup("Reject Verification", "Reject this student's verification submission?", "Reject");
    if (!ok) return;
    await apiRequest(`/admin/verifications/${id}`, {
      method: "POST",
      body: JSON.stringify({ decision: "reject" })
    });
    await refreshAdminVerifications();
    await refreshStudents();
  }
  if (action === "ban-user") {
    const ok = await askConfirmPopup("Ban User", "This will ban the account and block access. Continue?", "Ban User");
    if (!ok) return;
    await apiRequest(`/admin/users/${id}/ban`, { method: "POST", body: JSON.stringify({}) });
    await refreshAdminVerifications();
    await refreshStudents();
  }
  if (action === "resolve-report") {
    await apiRequest(`/admin/reports/${id}`, { method: "POST", body: JSON.stringify({ status: "resolved" }) });
    await refreshReports();
  }
  if (action === "mark-read") {
    await apiRequest("/notifications/read-all", { method: "POST", body: JSON.stringify({}) });
    await refreshNotifications();
  }
  if (action === "ask-qna") {
    const payload = await askQnaPopup();
    if (!payload) return;
    await apiRequest(`/users/${id}/qna`, { method: "POST", body: JSON.stringify(payload) });
    await refreshQnaForProfile(id);
  }
  if (action === "open-qna") {
    const entry = state.qna.find((item) => item.id === id);
    if (!entry) return;
    showPopup("Q&A", `${entry.question}\n\n${entry.answer || "Waiting for answer"}`);
  }
  if (action === "open-media") {
    const media = state.posts.flatMap((p) => p.media || []).find((m) => typeof m === "object" && m.url === id);
    openMediaViewer(id, media?.type || "");
    return;
  }
  saveState();
  render();
}

function askIdentityModePopup(receiverName) {
  return new Promise((resolve) => {
    const popup = showFormPopup("Choose Identity", `
      <div class="grid">
        <p class="muted" style="margin:0">Receiver: ${escapeHtml(receiverName)}</p>
        <p class="muted" style="margin:0">How should this receiver see your messages?</p>
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
      <button type="button" class="media-tile media-button media-image-tile ${loaded ? "is-loaded" : "is-loading"}" data-action="open-media" data-id="${escapeHtml(url)}">
        <img class="media-content" src="${escapeHtml(url)}" alt="Post media" loading="lazy" />
        <span class="media-loading-indicator" aria-hidden="true">Loading...</span>
      </button>
    `;
  }
  if (type.startsWith("video/")) return `<div class="media-tile"><video class="media-content media-video" src="${escapeHtml(url)}" controls preload="metadata"></video></div>`;
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

function updatePostMediaCarousel(postId) {
  const post = state.posts.find((item) => item.id === postId);
  const card = document.querySelector(`article.card[data-post-id="${postId}"]`);
  if (!post || !card) return;
  const media = Array.isArray(post.media) ? post.media : [];
  if (!media.length) return;
  const current = Math.max(0, Math.min(postMediaIndexByPostId[postId] || 0, media.length - 1));
  postMediaIndexByPostId[postId] = current;
  const stage = card.querySelector(".media-stage");
  if (stage) stage.innerHTML = renderPostMedia(media[current]);
  setupMediaLoadingIndicators(card);
  const prevButton = card.querySelector('[data-action="media-prev"]');
  if (prevButton) prevButton.disabled = current === 0;
  const nextButton = card.querySelector('[data-action="media-next"]');
  if (nextButton) nextButton.disabled = current >= media.length - 1;
  const dots = card.querySelectorAll(".media-dot");
  dots.forEach((dot, idx) => dot.classList.toggle("active", idx === current));
  preloadPostMediaAround(postId);
}

function preloadVisiblePostMedia() {
  for (const post of state.posts || []) {
    if (!post?.id) continue;
    preloadPostMediaAround(post.id);
  }
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
  const draw = () => {
    const files = [...(input.files || [])];
    chips.innerHTML = files.map((file) => `<span class="chip">${escapeHtml(file.name)}</span>`).join("");
  };
  input.addEventListener("change", draw);
  draw();
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
    const dt = new DataTransfer();
    (multiple ? files : files.slice(0, 1)).forEach((file) => dt.items.add(file));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function uploadFiles(files, options = {}) {
  const purpose = options.purpose || "media";
  const uploaded = [];
  setUploadProgress("Uploading media", 0);
  try {
    for (const file of files) {
      const shouldUseMultipart = file.size > 20 * 1024 * 1024 || (file.type || "").startsWith("video/");
      if (shouldUseMultipart) {
        const mediaUrl = await uploadFileMultipart(file, purpose);
        uploaded.push({ url: mediaUrl, type: file.type || "application/octet-stream", name: file.name });
        continue;
      }
      const sign = await apiRequest("/upload-url", {
        method: "POST",
        body: JSON.stringify({ fileName: file.name, contentType: file.type || "application/octet-stream", purpose })
      });
      const response = await fetch(sign.uploadUrl, {
        method: "PUT",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file
      });
      if (!response.ok) {
        let reason = "";
        try {
          const body = await response.json();
          reason = body?.error || body?.detail || "";
        } catch {
          reason = await response.text();
        }
        const detail = typeof reason === "string" && reason.trim().length ? ` ${reason.trim()}` : "";
        throw new Error(`Upload failed (${file.name}):${detail || " Unknown upload error."}`);
      }
      uploaded.push({
        url: sign.mediaUrl,
        type: file.type || "application/octet-stream",
        name: file.name
      });
    }
    return uploaded;
  } finally {
    clearUploadProgress();
  }
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

    const completed = await apiRequest("/verification-upload/complete", {
      method: "POST",
      body: JSON.stringify({ key: init.key, uploadId: init.uploadId, parts })
    });
    return completed.mediaUrl;
  } finally {
    clearUploadProgress();
  }
}

async function uploadMultipartPartsInParallel({ file, chunkSize, endpointPrefix, uploadId, key, onProgress = null }) {
  const totalParts = Math.ceil(file.size / chunkSize);
  const concurrency = 4;
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
      const body = await response.json();
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
