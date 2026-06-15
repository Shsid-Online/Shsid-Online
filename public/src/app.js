const STORAGE_KEY = "shsid-board-state-v1";
const LEGACY_STATE_KEY = "shsid-social-state-v2";
const API_BASE = window.SHSID_API_BASE || (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost"
  ? "http://127.0.0.1:4174/api"
  : "https://www.shsid.online/api");

const BOARDS = [
  { category: "school", slug: "/campus/", name: "Campus Talk", blurb: "Hallway drama, teachers, school changes, and campus rumors." },
  { category: "academic", slug: "/study/", name: "Study Hall", blurb: "Tests, workload, tutoring, and class survival notes." },
  { category: "lifestyle", slug: "/caf/", name: "Lunchroom", blurb: "Food, outfits, plans, and whatever people are talking about." },
  { category: "gaming", slug: "/clubs/", name: "Clubs + Games", blurb: "Gaming, club life, tournaments, and after-school energy." },
  { category: "shitpost", slug: "/random/", name: "After Hours", blurb: "Memes, chaos, and low-stakes nonsense." }
];

const initialState = {
  token: "",
  currentUser: null,
  posts: [],
  board: "all",
  search: "",
  composerBoard: "school",
  composerTitle: "",
  composerBody: "",
  replyDrafts: {},
  authOpen: false,
  authMode: "login",
  authStep: "email",
  pendingEmail: "",
  pendingCode: "",
  pendingUsername: "",
  toast: ""
};

const boardByCategory = new Map(BOARDS.map((board) => [board.category, board]));
let state = loadState();
let authBusy = false;
let queuedLikePostId = "";
let toastTimer = null;

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
  return base;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    token: state.token,
    currentUser: state.currentUser,
    board: state.board,
    search: state.search,
    composerBoard: state.composerBoard,
    composerTitle: state.composerTitle,
    composerBody: state.composerBody,
    replyDrafts: state.replyDrafts,
    authOpen: state.authOpen,
    authMode: state.authMode,
    authStep: state.authStep,
    pendingEmail: state.pendingEmail,
    pendingCode: state.pendingCode,
    pendingUsername: state.pendingUsername
  }));
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
    name: "School Board",
    blurb: "Current discussion"
  };
}

function currentUser() {
  return state.currentUser || null;
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

function toast(message) {
  clearTimeout(toastTimer);
  state.toast = String(message || "").trim();
  render();
  if (!state.toast) return;
  toastTimer = setTimeout(() => {
    state.toast = "";
    render();
  }, 2600);
}

async function apiRequest(path, { method = "GET", body, auth = true, optionalAuth = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if ((auth || optionalAuth) && state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  const response = await fetch(`${API_BASE}${path}`, {
    method,
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
  return {
    id: post.id,
    title: String(post.title || "").trim() || "Untitled thread",
    category: String(post.category || "school").trim().toLowerCase(),
    text: String(post.text || "").trim(),
    likes: Array.isArray(post.likes) ? post.likes : [],
    comments: Array.isArray(post.comments) ? post.comments.map((comment) => ({
      id: comment.id,
      text: String(comment.text || "").trim(),
      likes: Array.isArray(comment.likes) ? comment.likes : [],
      createdAt: comment.createdAt
    })) : [],
    createdAt: post.createdAt,
    sticky: Boolean(post.sticky)
  };
}

async function fetchPosts() {
  const result = await apiRequest("/posts?limit=100", { auth: false, optionalAuth: true });
  const posts = Array.isArray(result.posts) ? result.posts.map(normalizePost) : [];
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

async function uploadSinglePhoto(file) {
  const fileName = String(file?.name || "photo").trim();
  const contentType = String(file?.type || "").trim().toLowerCase();
  if (!contentType.startsWith("image/")) throw new Error("Please choose an image file");
  const signed = await apiRequest("/upload-url", {
    method: "POST",
    body: { fileName, contentType, purpose: "media" },
    auth: false
  });
  const response = await fetch(signed.uploadUrl, {
    method: signed.method || "PUT",
    headers: signed.headers || { "content-type": contentType },
    body: file
  });
  if (!response.ok) throw new Error("Photo upload failed");
  return { url: signed.mediaUrl, type: contentType, name: fileName };
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
    openAuth("login");
    return;
  }
  const result = await apiRequest(`/posts/${postId}/like`, { method: "POST" });
  if (result.post) mergePost(result.post);
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

function openAuth(mode = "login") {
  state.authOpen = true;
  state.authMode = mode === "register" ? "register" : "login";
  state.authStep = "email";
  render();
}

function closeAuth() {
  state.authOpen = false;
  resetAuthDraft({ keepEmail: true });
  authBusy = false;
  saveState();
  render();
}

async function finishAuthFlow() {
  state.authOpen = false;
  resetAuthDraft({ keepEmail: false });
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
      const username = String(document.querySelector("#auth-username")?.value || "").trim();
      const confirm = String(document.querySelector("#auth-password-confirm")?.value || "");
      if (!username) throw new Error("Please choose a username");
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
  const username = String(document.querySelector("#reg-username")?.value || "").trim();
  if (!username) return toast("Please choose a username");
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
  clearQueuedLike();
  saveState();
  render();
}

async function submitThread(event) {
  event.preventDefault();
  const title = String(document.querySelector("#composer-title")?.value || "").trim();
  const body = String(document.querySelector("#composer-body")?.value || "").trim();
  const category = String(document.querySelector("#composer-board")?.value || state.composerBoard || "school").trim().toLowerCase();
  const photoFile = document.querySelector("#composer-photo")?.files?.[0] || null;
  if (!title) return toast("Please add a subject");
  if (!body && !photoFile) return toast("Please add a post or a photo");
  try {
    const media = photoFile ? [await uploadSinglePhoto(photoFile)] : [];
    const result = await apiRequest("/posts", {
      method: "POST",
      body: { title, text: body, category, media },
      auth: false,
      optionalAuth: true
    });
    if (result.post) mergePost(result.post);
    state.composerBoard = category;
    state.composerTitle = "";
    state.composerBody = "";
    const photoInput = document.querySelector("#composer-photo");
    if (photoInput) photoInput.value = "";
    saveState();
    render();
    toast("Thread posted");
  } catch (error) {
    toast(error.message || "Could not post thread");
  }
}

async function submitReply(postId) {
  const replyKey = `reply-${postId}`;
  const text = String(document.querySelector(`#${replyKey}`)?.value || "").trim();
  if (!text) return toast("Please write a reply");
  try {
    const result = await apiRequest(`/posts/${postId}/comments`, {
      method: "POST",
      body: { text },
      auth: false,
      optionalAuth: true
    });
    const target = state.posts.find((post) => post.id === postId);
    if (target && result.comment) {
      target.comments = [...(target.comments || []), {
        id: result.comment.id,
        text: String(result.comment.text || "").trim(),
        likes: Array.isArray(result.comment.likes) ? result.comment.likes : [],
        createdAt: result.comment.createdAt
      }];
    }
    state.replyDrafts[postId] = "";
    saveState();
    render();
    toast("Reply posted");
  } catch (error) {
    toast(error.message || "Could not post reply");
  }
}

function filteredPosts() {
  const query = String(state.search || "").trim().toLowerCase();
  return state.posts.filter((post) => {
    const matchesBoard = state.board === "all" || post.category === state.board;
    if (!matchesBoard) return false;
    if (!query) return true;
    const haystack = [
      post.title,
      post.text,
      boardMeta(post.category).name,
      boardMeta(post.category).slug,
      ...(post.comments || []).map((comment) => comment.text)
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function renderThreadCard(post, index) {
  const board = boardMeta(post.category);
  const liked = userCanLike(post);
  return `
    <article class="thread-card">
      <div class="thread-head">
        <span class="thread-board">${escapeHtml(board.slug)}</span>
        <span class="thread-title">${escapeHtml(post.title)}</span>
        <span class="thread-id">No.${5000 + index}</span>
      </div>
      <p class="thread-body">${escapeHtml(post.text || "No text added.")}</p>
      ${(post.media || []).length ? `
        <div class="thread-media">
          <img src="${escapeHtml(post.media[0].url)}" alt="${escapeHtml(post.media[0].name || post.title || "Thread image")}" loading="lazy">
        </div>
      ` : ""}
      <div class="thread-foot">
        <span>${escapeHtml(board.name)}</span>
        <span>${(post.comments || []).length} repl${(post.comments || []).length === 1 ? "y" : "ies"}</span>
        <span>last bump ${escapeHtml(timeAgo(post.createdAt))}</span>
        <button class="vote-button ${liked ? "liked" : ""}" data-action="like-post" data-id="${escapeHtml(post.id)}">
          ${liked ? "▲" : "△"} ${Array.isArray(post.likes) ? post.likes.length : 0}
        </button>
      </div>
      ${(post.comments || []).length ? `
        <div class="reply-list">
          ${(post.comments || []).map((comment, commentIndex) => `
            <div class="reply">
              <div class="reply-head">Anonymous No.${7000 + commentIndex}</div>
              <p class="reply-body">${escapeHtml(comment.text)}</p>
            </div>
          `).join("")}
        </div>
      ` : ""}
      <form class="reply-form" data-reply-form="${escapeHtml(post.id)}">
        <label>
          Reply
          <textarea id="reply-${escapeHtml(post.id)}" class="reply-input" rows="3" maxlength="280" placeholder="Post a public reply">${escapeHtml(state.replyDrafts[post.id] || "")}</textarea>
        </label>
        <button class="board-button" type="submit">Reply</button>
      </form>
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
    ? "You only need an account to upvote threads. Browsing the board stays open."
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

function render() {
  const app = document.querySelector("#app");
  const posts = filteredPosts();
  const activeBoard = state.board === "all" ? null : boardMeta(state.board);
  const signedInUser = currentUser();
  app.innerHTML = `
    <div class="page">
      <header class="site-header">
        <div class="account-strip">
          <div class="account-copy">
            ${signedInUser
              ? `Signed in as <strong>${escapeHtml(signedInUser.englishName || signedInUser.email || "Student")}</strong>`
              : "Browsing is open. Sign in only if you want to upvote."}
          </div>
          <div class="account-actions">
            ${signedInUser
              ? `<button class="board-button small" data-action="logout">Log out</button>`
              : `<button class="board-button small primary" data-action="open-auth">Sign in / Create account</button>`}
          </div>
        </div>
        <h1>SHSID Board</h1>
        <p class="tagline">School board style threads for campus talk, study stress, lunch complaints, clubs, and random drama.</p>
        <p class="notice">The old social dashboard is out for now. This version keeps the board public and only uses accounts for upvoting.</p>
      </header>

      <nav class="board-nav" id="boards">
        <button class="board-link ${state.board === "all" ? "active" : ""}" data-board="all">/all/</button>
        ${BOARDS.map((board) => `
          <button class="board-link ${state.board === board.category ? "active" : ""}" data-board="${escapeHtml(board.category)}">${escapeHtml(board.slug)}</button>
        `).join("")}
      </nav>

      <section class="post-box">
        <h2>${escapeHtml(activeBoard?.name || "School Board")}</h2>
        <p class="post-box-copy">${escapeHtml(activeBoard?.blurb || "Open browsing, simple threads, and login-only upvotes.")}</p>
        <div class="post-box-actions">
          <span class="status-pill">${signedInUser ? "Upvotes unlocked" : "Sign in to upvote"}</span>
          ${signedInUser
            ? `<span class="status-note">You can vote on threads right now.</span>`
            : `<button class="board-button primary" data-action="open-auth">Unlock upvotes</button>`}
        </div>
        <form id="thread-form" class="thread-form">
          <div class="form-row">
            <label for="composer-board">Board</label>
            <select id="composer-board">
              ${BOARDS.map((board) => `<option value="${escapeHtml(board.category)}"${(state.composerBoard || state.board || "school") === board.category ? " selected" : ""}>${escapeHtml(board.slug)} ${escapeHtml(board.name)}</option>`).join("")}
            </select>
          </div>
          <div class="form-row">
            <label for="composer-title">Subject</label>
            <input id="composer-title" type="text" maxlength="90" value="${escapeHtml(state.composerTitle || "")}" placeholder="Thread subject">
          </div>
          <div class="form-row form-row-textarea">
            <label for="composer-body">Comment</label>
            <textarea id="composer-body" rows="5" maxlength="5000" placeholder="Write your thread">${escapeHtml(state.composerBody || "")}</textarea>
          </div>
          <div class="form-row">
            <label for="composer-photo">Photo</label>
            <input id="composer-photo" type="file" accept="image/*">
          </div>
          <div class="form-actions">
            <button class="board-button primary" type="submit">Post thread</button>
            <span class="form-note">One photo max per thread.</span>
          </div>
        </form>
      </section>

      <section class="thread-controls">
        <label class="control">
          <span>Search</span>
          <input id="search-input" type="search" value="${escapeHtml(state.search || "")}" placeholder="search threads and replies">
        </label>
        <label class="control">
          <span>Board</span>
          <select id="board-filter">
            <option value="all"${state.board === "all" ? " selected" : ""}>All boards</option>
            ${BOARDS.map((board) => `<option value="${escapeHtml(board.category)}"${state.board === board.category ? " selected" : ""}>${escapeHtml(board.slug)} ${escapeHtml(board.name)}</option>`).join("")}
          </select>
        </label>
      </section>

      <main class="thread-list">
        ${posts.length
          ? posts.map((post, index) => renderThreadCard(post, index)).join("")
          : `<div class="empty-state">No threads matched that search.</div>`}
      </main>
    </div>
    ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ""}
    ${renderAuthModal()}
  `;
  bindEvents();
}

function bindEvents() {
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
    state.search = String(event.target.value || "");
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

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;
      const id = button.dataset.id || "";
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
      if (action === "like-post") {
        await likePost(id);
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
  await fetchCurrentUser();
  await fetchPosts();
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
