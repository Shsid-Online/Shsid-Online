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
  authOpen: false,
  authMode: "login",
  authStep: "email",
  pendingEmail: "",
  pendingCode: "",
  pendingFirstName: "",
  pendingMiddleName: "",
  pendingLastName: "",
  pendingChineseName: "",
  pendingGrade: 10,
  pendingClassNo: 1,
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
    authOpen: state.authOpen,
    authMode: state.authMode,
    authStep: state.authStep,
    pendingEmail: state.pendingEmail,
    pendingCode: state.pendingCode,
    pendingFirstName: state.pendingFirstName,
    pendingMiddleName: state.pendingMiddleName,
    pendingLastName: state.pendingLastName,
    pendingChineseName: state.pendingChineseName,
    pendingGrade: state.pendingGrade,
    pendingClassNo: state.pendingClassNo
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
  return !user?.englishName || !user?.grade || !user?.classNo;
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
  state.posts = state.posts.map((post) => (
    post.id === normalized.id
      ? { ...post, ...normalized, comments: normalized.comments.length ? normalized.comments : post.comments }
      : post
  ));
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
  state.pendingFirstName = "";
  state.pendingMiddleName = "";
  state.pendingLastName = "";
  state.pendingChineseName = "";
  state.pendingGrade = 10;
  state.pendingClassNo = 1;
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
      const confirm = String(document.querySelector("#auth-password-confirm")?.value || "");
      if (!confirm) throw new Error("Please confirm your password");
      if (confirm !== password) throw new Error("Passwords do not match");
      const result = await apiRequest("/auth/register", {
        method: "POST",
        body: {
          email: state.pendingEmail,
          code: state.pendingCode,
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
  const firstName = String(document.querySelector("#reg-first")?.value || "").trim();
  const middleName = String(document.querySelector("#reg-middle")?.value || "").trim();
  const lastName = String(document.querySelector("#reg-last")?.value || "").trim();
  const chineseName = String(document.querySelector("#reg-cn")?.value || "").trim();
  const grade = Number(document.querySelector("#reg-grade")?.value);
  const classNo = Number(document.querySelector("#reg-class")?.value);
  if (!firstName || !lastName) return toast("Please enter your first and last name");
  if (!Number.isInteger(grade) || grade < 1 || grade > 12) return toast("Please choose a year from 1 to 12");
  if (!Number.isInteger(classNo) || classNo < 1 || classNo > 13) return toast("Please choose a class from 1 to 13");
  authBusy = true;
  render();
  try {
    const englishName = middleName ? `${firstName} ${middleName} ${lastName}` : `${firstName} ${lastName}`;
    const result = await apiRequest("/auth/complete-profile", {
      method: "POST",
      body: {
        englishName,
        chineseName,
        grade,
        classNo
      }
    });
    state.currentUser = result.user || null;
    await finishAuthFlow();
    toast("Account ready. You can upvote now.");
  } catch (error) {
    toast(error.message || "Could not save your school info");
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
        : "Your school info";
  const subtitle = step === "email"
    ? "You only need an account to upvote threads. Browsing the board stays open."
    : step === "verify"
      ? "Enter the 6-digit code we sent to your email."
      : step === "password"
        ? (mode === "register"
          ? "Finish setting up your account."
          : "Sign in to unlock upvotes.")
        : "Tell us the name you use at school and your class information.";

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
      <div class="auth-grid">
        <label class="auth-field">
          <span>First name</span>
          <input id="reg-first" value="${escapeHtml(state.pendingFirstName || "")}" placeholder="First name" required>
        </label>
        <label class="auth-field">
          <span>Middle name</span>
          <input id="reg-middle" value="${escapeHtml(state.pendingMiddleName || "")}" placeholder="Optional">
        </label>
      </div>
      <label class="auth-field">
        <span>Last name</span>
        <input id="reg-last" value="${escapeHtml(state.pendingLastName || "")}" placeholder="Last name" required>
      </label>
      <label class="auth-field">
        <span>Chinese name</span>
        <input id="reg-cn" value="${escapeHtml(state.pendingChineseName || "")}" placeholder="Optional">
      </label>
      <div class="auth-grid">
        <label class="auth-field">
          <span>Year</span>
          <input id="reg-grade" type="number" min="1" max="12" value="${Number(state.pendingGrade || 10)}" required>
        </label>
        <label class="auth-field">
          <span>Class</span>
          <input id="reg-class" type="number" min="1" max="13" value="${Number(state.pendingClassNo || 1)}" required>
        </label>
      </div>
      <div class="auth-actions">
        <button class="board-button primary" type="submit"${authBusy ? " disabled" : ""}>Finish account</button>
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
