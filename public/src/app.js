const STORAGE_KEY = "shsid-social-state-v2";
const API_BASE = window.SHISD_API_BASE || (window.location.hostname === "127.0.0.1" ? "http://127.0.0.1:4174/api" : `${window.location.origin}/api`);

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
  selectedProfileId: null
};

let state = loadState();
let view = "feed";
let activeConversationId = state.conversations[0]?.id;
let authEmailSubmitIntent = "login";
let authRequestInFlight = false;
let resendCooldownUntil = 0;

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
  document.querySelectorAll("#auth-email-form button, #auth-verify-form button, #auth-password-form button").forEach((button) => {
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

async function refreshPosts() {
  if (!state.apiToken) return;
  try {
    const result = await apiRequest("/posts");
    state.posts = (result.posts || []).map(normalizePost);
    saveState();
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

async function refreshReels() {
  if (!state.apiToken) return;
  try {
    const result = await apiRequest("/reels");
    state.reels = (result.reels || []).map((reel) => ({
      ...reel,
      createdAt: at(reel.createdAt),
      likes: Array.isArray(reel.likes) ? reel.likes : []
    }));
    saveState();
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
      type: report.targetType || report.type,
      targetId: report.targetId
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

function toast(message) {
  const existing = document.querySelector(".toast");
  existing?.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 2200);
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
    toast(result.devCode ? `Dev OTP: ${result.devCode}` : `Verification code sent via ${result.transport || "email provider"}`);
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
    renderAuth();
    return;
  }

  const adminVisible = user.role === "admin";
  const visibleNav = navItems.filter((item) => item[0] !== "admin" || adminVisible);
  document.querySelector("#app").innerHTML = `
    <div class="app">
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
  `;
  bindEvents();
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
      ? "Enter the verification code we sent to your email."
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
      <div class="field"><label>Verification video</label><input id="reg-video" type="file" accept="video/*" required></div>
      <p class="muted">${state.pendingVideoName ? `Selected: ${escapeHtml(state.pendingVideoName)}` : "Please upload a 10-15 second video."}</p>
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
  `, `<button class="btn primary" data-view="post">New post</button>`);
}

function renderStoryMini(story) {
  return `<button class="story" data-action="view-story" data-id="${story.id}">${escapeHtml(userName(story.authorId))}<span style="font-size:12px">${timeAgo(story.createdAt)}</span></button>`;
}

function renderPost(post) {
  const author = state.users.find((u) => u.id === post.authorId);
  const likes = post.likes || [];
  const liked = likes.includes(state.currentUserId);
  const media = post.media || [];
  return `
    <article class="card">
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
      ${media.length ? `<div class="media-grid">${media.slice(0, 9).map((item) => `<div class="media-tile">${escapeHtml(item)}</div>`).join("")}</div>` : ""}
      ${(post.comments || []).map((comment) => `<p class="comment"><strong>${escapeHtml(userName(comment.authorId, comment.anonymous))}:</strong> ${escapeHtml(comment.text)}</p>`).join("")}
      <div class="post-actions">
        <button class="btn small" data-action="like-post" data-id="${post.id}">${liked ? "Liked" : "Like"} · ${likes.length}</button>
        <button class="btn small" data-action="comment-post" data-id="${post.id}">Comment</button>
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
      <div class="field"><label>Media uploads</label><input id="post-media" type="file" multiple accept="image/*,video/*"></div>
      <button class="btn primary" data-action="create-post">Publish</button>
    </section>
  `);
}

function renderReels() {
  const uid = state.currentUserId;
  const tiles = state.reels.map((reel) => {
    const likes = reel.likes || [];
    const liked = likes.includes(uid);
    const openable = reel.videoUrl && reel.videoUrl !== "pending-upload" && /^https?:\/\//i.test(reel.videoUrl);
    return `
      <article class="card video-tile">
        <span class="chip">${escapeHtml(reel.category)}</span>
        <h2>${escapeHtml(reel.title)}</h2>
        <p class="reel-meta">${escapeHtml(userName(reel.authorId))} · ${likes.length} likes · ${timeAgo(reel.createdAt)}</p>
        <div class="reel-actions">
          <button class="btn small" data-action="like-reel" data-id="${reel.id}">${liked ? "Liked" : "Like"}</button>
          ${openable ? `<a class="reel-link" href="${escapeHtml(reel.videoUrl)}" target="_blank" rel="noopener noreferrer">Open video</a>` : `<span class="muted" style="font-size:13px">Video link pending</span>`}
        </div>
      </article>
    `;
  }).join("");
  const grid = tiles || `<div class="empty-state">No reels yet. Add one below or ask classmates to share.</div>`;
  return page("Reels", "Short vertical videos — add a title and optional hosted video URL.", `
    <section class="composer" style="margin-bottom:16px">
      <div class="grid two">
        <div class="field"><label>Title</label><input id="reel-title" placeholder="What is this reel about?" /></div>
        <div class="field"><label>Category</label><select id="reel-category"><option>school</option><option>lifestyle</option><option>gaming</option><option>academic</option></select></div>
      </div>
      <div class="field"><label>Video URL (optional)</label><input id="reel-video-url" type="url" placeholder="https://… (YouTube, Drive share link, etc.)" /></div>
      <button class="btn primary" data-action="create-reel">Publish reel</button>
    </section>
    <section class="grid three">${grid}</section>
  `);
}

function renderStudents() {
  return page("Students", "Browse verified classmates, follow profiles, message students, and ask Q&A box questions.", `
    <section class="grid two">${state.users.filter((u) => u.role !== "admin").map((user) => `
      <article class="panel" data-action="view-profile" data-id="${user.id}" style="cursor:pointer">
        <div class="between">
          <div class="row"><div class="avatar">${initials(user)}</div><div><strong>${escapeHtml(user.englishName)}</strong><div class="muted">Grade ${user.grade}, Class ${user.classNo} · ${escapeHtml(user.chineseName)}</div></div></div>
          <span class="status ${user.status === "verified" ? "green" : "gold"}">${user.status}</span>
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
  const active = state.conversations.find((item) => item.id === activeConversationId) || state.conversations[0];
  return page("Messages", "Real-time style direct and group messaging, anonymous sending, reporting, and admin monitoring.", `
    <section class="grid two">
      <div class="panel">
        <div class="between" style="margin-bottom:12px"><strong>Conversations</strong><button class="btn small" data-action="new-group">Group</button></div>
        <div class="grid">${state.conversations.map((conv) => `<button class="btn ${active?.id === conv.id ? "primary" : ""}" data-action="open-conv" data-id="${conv.id}">${escapeHtml(conv.title)} · ${conv.group ? "group" : "direct"}</button>`).join("")}</div>
      </div>
      <div class="panel">
        <div class="between"><strong>${escapeHtml(active?.title || "No conversation")}</strong><span class="chip">Active</span></div>
        <div class="grid" style="margin:14px 0">${(active?.messages || []).map((message) => `
          <div class="comment" style="margin:0"><strong>${escapeHtml(userName(message.authorId, message.anonymous))}:</strong> ${escapeHtml(message.text)} ${currentUser().role === "admin" && message.anonymous ? `<span class="muted">(real: ${escapeHtml(userName(message.authorId))})</span>` : ""}</div>
        `).join("")}</div>
        <div class="field"><label>Message</label><textarea id="message-text" placeholder="Type a message"></textarea></div>
        <div class="row">
          <select id="message-anon" class="btn"><option value="false">Public</option><option value="true">Anonymous</option></select>
          <button class="btn primary" data-action="send-message" data-id="${active?.id || ""}">Send</button>
          <button class="btn" data-action="report-message" data-id="${active?.id || ""}">Report</button>
        </div>
      </div>
    </section>
  `);
}

function renderStories() {
  return page("Stories", "24-hour stories with viewers and archives planned for production retention.", `
    <section class="composer" style="margin-bottom:16px">
      <div class="field"><label>Story text</label><input id="story-text" placeholder="Add a short story"></div>
      <button class="btn primary" data-action="create-story">Post story</button>
    </section>
    <section class="grid three">${state.stories.map((story) => `
      <article class="story" style="min-height:220px">
        <strong>${escapeHtml(story.text)}</strong>
        <span>${escapeHtml(userName(story.authorId))} · ${story.views.length} views</span>
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
        ${questions.length ? questions.map((q) => `<p class="comment"><strong>${escapeHtml(q.question)}</strong><br>${escapeHtml(q.answer || "Waiting for answer")}</p>`).join("") : `<p class="muted">No questions yet.</p>`}
        <h3>Suggestion Box</h3>
        ${state.suggestions.map((s) => `<p class="comment">${escapeHtml(s.text)} · ${escapeHtml(s.status)}</p>`).join("")}
      </div>
    </section>
  `);
}

function renderAdmin() {
  if (currentUser().role !== "admin") return page("Unavailable", "Admin access required.", "");
  const pending = state.adminVerifications || [];
  return page("Admin", "Verification, reports, bans, audit trails, anonymous author visibility, and compliance exports.", `
    <section class="grid">
      <div class="grid three">
        <div class="panel"><span class="muted">Pending verification</span><h2>${pending.length}</h2></div>
        <div class="panel"><span class="muted">Open reports</span><h2>${state.reports.filter((r) => r.status === "pending").length}</h2></div>
        <div class="panel"><span class="muted">Audit events</span><h2>${state.audit.length}</h2></div>
      </div>
      <div class="panel">
        <h2>Student Verification Queue</h2>
        <table class="table"><thead><tr><th>Student</th><th>Status</th><th>Video</th><th>Actions</th></tr></thead><tbody>
          ${pending.map((user) => `<tr><td>${escapeHtml(user.englishName)}<br><span class="muted">${escapeHtml(user.chineseName)} · G${user.grade} C${user.classNo}</span></td><td><span class="status gold">${user.status}</span></td><td>${user.verificationVideo ? `<span class="chip">${escapeHtml(user.verificationVideo)}</span>` : `<span class="muted">No video file</span>`}</td><td><button class="btn small primary" data-action="verify-user" data-id="${user.id}">Approve</button> <button class="btn small danger" data-action="reject-user" data-id="${user.id}">Reject</button></td></tr>`).join("") || `<tr><td colspan="4" class="muted">No pending students.</td></tr>`}
        </tbody></table>
      </div>
      <div class="panel">
        <h2>Report Queue</h2>
        <table class="table"><thead><tr><th>Type</th><th>Reason</th><th>Reporter</th><th>Status</th><th>Actions</th></tr></thead><tbody>
          ${state.reports.map((report) => `<tr><td>${escapeHtml(report.type)}</td><td>${escapeHtml(report.reason)}</td><td>${escapeHtml(userName(report.reporterId))}</td><td>${escapeHtml(report.status)}</td><td><button class="btn small" data-action="resolve-report" data-id="${report.id}">Resolve</button></td></tr>`).join("")}
        </tbody></table>
      </div>
      <div class="panel">
        <h2>Audit Trail</h2>
        <table class="table"><thead><tr><th>User</th><th>Action</th><th>IP</th><th>Time</th></tr></thead><tbody>
          ${state.audit.map((item) => `<tr><td>${escapeHtml(userName(item.userId))}</td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.ip)}</td><td>${timeAgo(item.createdAt)} ago</td></tr>`).join("")}
        </tbody></table>
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
      try {
        await handleAction(button.dataset.action, button.dataset.id);
      } catch (error) {
        toast(error.message || "Action failed");
      }
    });
  });
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
  document.querySelector('[data-auth-intent="register"]')?.addEventListener("click", () => {
    authEmailSubmitIntent = "register";
  });
  document.querySelector('[data-auth-intent="login"]')?.addEventListener("click", () => {
    authEmailSubmitIntent = "login";
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
          toast(result.devCode ? `Dev OTP: ${result.devCode}` : `Verification code resent via ${result.transport || "email provider"}`);
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
    const code = document.querySelector("#auth-code").value.trim();
    if (!code) return toast("Enter the verification code");
    const confirmed = confirm(`Use this verification code?\n\n${code}`);
    if (!confirmed) return;
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
      toast(error.message);
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
      const videoFile = document.querySelector("#reg-video").files[0];
      if (!videoFile) return toast("Upload a verification video");
      state.pendingVideoName = videoFile.name;
      const result = await apiRequest("/auth/complete-profile", {
        method: "POST",
        body: JSON.stringify({
          englishName: state.pendingEnglishName,
          chineseName: state.pendingChineseName,
          grade: Number(state.pendingGrade),
          classNo: Number(state.pendingClassNo),
          verificationVideo: videoFile.name || "pending-upload"
        })
      });
      mergeApiUser(result.user);
      state.authStep = "waiting";
      saveState();
      render();
      toast("Submitted for admin review");
    } catch (error) {
      toast(error.message);
    }
  });
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
  }
  if (action === "create-post") {
    const text = document.querySelector("#post-text").value.trim();
    const files = [...document.querySelector("#post-media").files].slice(0, 9).map((file) => (file.type.startsWith("video") ? "Video" : "Photo"));
    if (!text && !files.length) return toast("Write something or attach media");
    await apiRequest("/posts", {
      method: "POST",
      body: JSON.stringify({
        text,
        anonymous: document.querySelector("#post-anon").value === "true",
        category: document.querySelector("#post-category").value,
        media: files
      })
    });
    await refreshPosts();
    view = "feed";
    toast("Post published");
  }
  if (action === "like-post") {
    const result = await apiRequest(`/posts/${id}/like`, { method: "POST", body: JSON.stringify({}) });
    const idx = state.posts.findIndex((item) => item.id === id);
    if (idx >= 0) state.posts[idx] = normalizePost(result.post);
  }
  if (action === "comment-post") {
    const text = prompt("Comment text");
    if (text) {
      const anonymous = confirm("Post comment anonymously?");
      await apiRequest(`/posts/${id}/comments`, { method: "POST", body: JSON.stringify({ text, anonymous }) });
      await refreshPosts();
    }
  }
  if (action === "report-post") {
    const reason = prompt("Report reason");
    if (reason) {
      await apiRequest("/reports", { method: "POST", body: JSON.stringify({ targetType: "post", targetId: id, reason }) });
      if (user.role === "admin") await refreshReports();
    }
  }
  if (action === "toggle-sticky") {
    const post = state.posts.find((item) => item.id === id);
    if (!post) return;
    await apiRequest(`/posts/${id}`, { method: "PATCH", body: JSON.stringify({ sticky: !post.sticky }) });
    await refreshPosts();
  }
  if (action === "delete-post") {
    await apiRequest(`/posts/${id}`, { method: "DELETE" });
    await refreshPosts();
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
    const result = await apiRequest("/conversations", { method: "POST", body: JSON.stringify({ memberIds: [id], group: false }) });
    await refreshConversations();
    activeConversationId = result.conversation.id;
    view = "messages";
  }
  if (action === "send-message") {
    const text = document.querySelector("#message-text").value.trim();
    if (!text || !id) return toast("Enter a message");
    await apiRequest(`/conversations/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, anonymous: document.querySelector("#message-anon").value === "true" })
    });
    document.querySelector("#message-text").value = "";
    await refreshConversations();
  }
  if (action === "open-conv") activeConversationId = id;
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
    const reason = prompt("Message report reason");
    if (reason) {
      await apiRequest("/reports", { method: "POST", body: JSON.stringify({ targetType: "conversation", targetId: id, reason }) });
      if (user.role === "admin") await refreshReports();
    }
  }
  if (action === "create-story") {
    const text = document.querySelector("#story-text").value.trim();
    if (text) {
      await apiRequest("/stories", { method: "POST", body: JSON.stringify({ text }) });
      await refreshStories();
    }
  }
  if (action === "view-story") {
    await apiRequest(`/stories/${id}/view`, { method: "POST", body: JSON.stringify({}) });
    await refreshStories();
    const story = state.stories.find((item) => item.id === id);
    const views = story?.views?.length ?? 0;
    if (story) toast(`${story.text} · ${views} views`);
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
    await apiRequest(`/admin/verifications/${id}`, {
      method: "POST",
      body: JSON.stringify({ decision: "reject" })
    });
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
    const question = prompt("Question");
    if (question) {
      const anonymous = confirm("Ask anonymously?");
      const visibility = confirm("Display publicly on their profile?") ? "public" : "private";
      await apiRequest(`/users/${id}/qna`, { method: "POST", body: JSON.stringify({ question, anonymous, visibility }) });
      await refreshQnaForProfile(id);
    }
  }
  saveState();
  render();
}

bootstrapSession();
