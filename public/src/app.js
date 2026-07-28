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
  board: "all",
  sort: "recent",
  search: "",
  composerBoard: "school",
  composerTitle: "",
  composerBody: "",
  composerPostNumber: "",
  composerQuote: null,
  composerQuoteSearch: "",
  composerOpen: false,
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
let authReason = "";
let toastTimer = null;
let openReplyPostId = "";
let threadSubmitting = false;
const replySubmittingPostIds = new Set();
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
  // Keep unsent board drafts session-only so old text does not reappear after refresh.
  base.composerTitle = "";
  base.composerBody = "";
  base.composerPostNumber = "";
  base.composerQuote = null;
  base.composerQuoteSearch = "";
  base.replyDrafts = {};
  return base;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    token: state.token,
    currentUser: state.currentUser,
    board: state.board,
    sort: state.sort,
    search: state.search,
    composerBoard: state.composerBoard,
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
    name: "/board/",
    blurb: ""
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

function hasUnsavedReplyDrafts() {
  if (Object.values(state.replyDrafts || {}).some((value) => String(value || "").trim())) return true;
  return [...document.querySelectorAll("[id^='reply-photo-']")].some((input) => input.files?.length);
}

function hasUnsavedComposerDraft() {
  if (String(state.composerTitle || "").trim()) return true;
  if (String(state.composerBody || "").trim()) return true;
  if (String(state.composerPostNumber || "").trim()) return true;
  if (state.composerQuote) return true;
  if (String(state.composerQuoteSearch || "").trim()) return true;
  const photoInput = document.querySelector("#composer-photo");
  return Boolean(photoInput?.files?.length);
}

function hasUnsavedBoardChanges() {
  return hasUnsavedComposerDraft() || hasUnsavedReplyDrafts();
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
  const postNumber = Number(post.postNumber);
  const anonymous = Boolean(post.anonymous);
  const viewerId = currentUser()?.id || "";
  const authorId = String(post.authorId || "");
  const realAuthorLabel = post.adminAuthor?.englishName
    || post.author?.englishName
    || (post.adminAuthor?.role === "admin" || post.author?.role === "admin" ? "Admin" : "");
  const authorLabel = String(
    post.anonymousLabel
      || (anonymous ? "Anonymous" : realAuthorLabel)
      || "Anonymous"
  ).trim();
  return {
    id: post.id,
    authorId,
    title: String(post.title || "").trim() || "Untitled thread",
    postNumber: Number.isInteger(postNumber) && postNumber > 0 ? postNumber : null,
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
      canDelete: Boolean(comment.canDelete || (viewerId && String(comment.authorId || "") === viewerId)),
      media: Array.isArray(comment.media) ? comment.media : [],
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

async function uploadPhotos(fileList, limit) {
  const files = [...(fileList || [])].slice(0, limit);
  if ([...(fileList || [])].length > limit) throw new Error(`Please choose at most ${limit} photos`);
  return Promise.all(files.map(uploadSinglePhoto));
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

function startPostQuote(quoteRef) {
  if (!quoteRef) return;
  state.composerQuote = quoteRef;
  state.composerQuoteSearch = "";
  state.composerOpen = true;
  saveState();
  render();
  document.querySelector("#composer-body")?.focus();
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
  if (threadSubmitting) return;
  const title = String(document.querySelector("#composer-title")?.value || "").trim();
  const body = String(document.querySelector("#composer-body")?.value || "").trim();
  const category = String(document.querySelector("#composer-board")?.value || state.composerBoard || "school").trim().toLowerCase();
  const photoFiles = document.querySelector("#composer-photo")?.files || [];
  const postNumber = currentUser()?.role === "admin"
    ? String(document.querySelector("#composer-post-number")?.value || "").trim()
    : "";
  const quoteRef = state.composerQuote || null;
  if (!title && !body && !photoFiles.length && !quoteRef) return toast("Please add a subject, comment, photo, or quote");
  threadSubmitting = true;
  try {
    const media = await uploadPhotos(photoFiles, 9);
    const result = await apiRequest("/posts", {
      method: "POST",
      body: { title, text: body, category, media, ...(quoteRef ? { quoteRef } : {}), ...(postNumber ? { postNumber } : {}) },
      auth: false,
      optionalAuth: true
    });
    if (result.post) mergePost(result.post);
    state.composerBoard = category;
    state.composerTitle = "";
    state.composerBody = "";
    state.composerPostNumber = "";
    state.composerQuote = null;
    state.composerQuoteSearch = "";
    state.composerOpen = false;
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
  const photoFiles = photoInput?.files || [];
  if (!text && !photoFiles.length) return toast("Please write a reply or add a photo");
  replySubmittingPostIds.add(postId);
  try {
    const media = await uploadPhotos(photoFiles, 5);
    const result = await apiRequest(`/posts/${postId}/comments`, {
      method: "POST",
      body: { text, media },
      auth: false,
      optionalAuth: true
    });
    const target = state.posts.find((post) => post.id === postId);
    if (target && result.comment) {
      const nextComment = {
        id: result.comment.id,
        text: String(result.comment.text || "").trim(),
        anonymousLabel: String(result.comment.anonymousLabel || "Anonymous").trim(),
        authorId: String(result.comment.authorId || ""),
        canDelete: Boolean(result.comment.canDelete || result.comment.authorId === currentUser()?.id),
        media: Array.isArray(result.comment.media) ? result.comment.media : [],
        likes: Array.isArray(result.comment.likes) ? result.comment.likes : [],
        createdAt: result.comment.createdAt
      };
      if (!(target.comments || []).some((comment) => comment.id === nextComment.id)) {
        target.comments = [...(target.comments || []), nextComment];
      }
    }
    state.replyDrafts[postId] = "";
    openReplies.add(postId);
    if (openReplyPostId === postId) openReplyPostId = "";
    if (photoInput) photoInput.value = "";
    saveState();
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
  if (!user || (user.role !== "admin" && !post?.canDelete && post?.authorId !== user.id)) return toast("You can only delete your own post");
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
  if (!user || (user.role !== "admin" && !comment?.canDelete && comment?.authorId !== user.id)) return toast("You can only delete your own reply");
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
  const posts = state.posts.filter((post) => {
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
  return posts.sort((left, right) => {
    if (left.sticky !== right.sticky) return Number(right.sticky) - Number(left.sticky);
    if (state.sort === "trending") {
      const scoreDiff = trendingScore(right) - trendingScore(left);
      if (scoreDiff) return scoreDiff;
    }
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });
}

function trendingScore(post) {
  const likes = Array.isArray(post.likes) ? post.likes.length : 0;
  const replies = Array.isArray(post.comments) ? post.comments.length : 0;
  const createdAt = new Date(post.createdAt || Date.now()).getTime();
  const ageHours = Math.max(1, (Date.now() - createdAt) / 3600000);
  return (likes * 4) + (replies * 3) - (ageHours * 0.35);
}

function renderThreadCard(post, index) {
  const board = boardMeta(post.category);
  const liked = userCanLike(post);
  const adminMode = currentUser()?.role === "admin";
  const canDeletePost = adminMode || Boolean(post.canDelete);
  const replyOpen = openReplyPostId === post.id;
  const replyCount = (post.comments || []).length;
  const repliesOpen = openReplies.has(post.id);
  const replySubmitting = replySubmittingPostIds.has(post.id);
  const activityLabel = replyCount ? "last bump" : "posted";
  const displayNumber = Number.isInteger(post.postNumber) ? post.postNumber : 5000 + index;
  return `
    <article class="thread-card">
      <div class="thread-head">
        <div class="thread-topline">
          <span class="thread-board">${escapeHtml(board.slug)}</span>
          <span class="thread-author">${escapeHtml(post.authorLabel || "Anonymous")}</span>
          <span class="thread-separator">/</span>
          <span class="thread-id">No.${displayNumber}</span>
          ${canDeletePost ? `<button class="inline-admin-link" data-action="delete-post" data-id="${escapeHtml(post.id)}">Delete</button>` : ""}
        </div>
        <div class="thread-title">${escapeHtml(post.title)}</div>
      </div>
      ${post.quoteRef ? `
        <div class="quote-card">
          <div class="quote-label">${escapeHtml(post.quoteRef.label || "Quoted post")}</div>
          ${post.quoteRef.excerpt ? `<div class="quote-excerpt">&gt; ${escapeHtml(post.quoteRef.excerpt)}</div>` : ""}
        </div>
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
        <span>${activityLabel} ${escapeHtml(timeAgo(post.createdAt))}</span>
        ${replyCount ? `<button class="plain-board-action" type="button" data-action="${repliesOpen ? "hide-replies" : "show-replies"}" data-id="${escapeHtml(post.id)}">${repliesOpen ? "Hide replies" : "Show replies"}</button>` : ""}
        <button class="vote-button ${liked ? "liked" : ""}" data-action="like-post" data-id="${escapeHtml(post.id)}">
          ${liked ? "▲" : "△"} ${Array.isArray(post.likes) ? post.likes.length : 0}
        </button>
      </div>
      ${replyCount && repliesOpen ? `
        <div class="reply-list">
          ${(post.comments || []).map((comment, commentIndex) => `
            <div class="reply">
              <div class="reply-head">
                <span>${escapeHtml(comment.anonymousLabel || "Anonymous")}</span>
                <div class="reply-head-actions">
                  ${(adminMode || comment.canDelete) ? `<button class="inline-admin-link" data-action="delete-comment" data-id="${escapeHtml(post.id)}" data-comment-id="${escapeHtml(comment.id)}">Delete</button>` : ""}
                </div>
              </div>
              ${comment.text ? `<p class="reply-body">${escapeHtml(comment.text)}</p>` : ""}
              ${(comment.media || []).length ? `
                <div class="reply-media">
                  ${(comment.media || []).map((item) => `
                    <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name || "Reply image")}" loading="lazy">
                  `).join("")}
                </div>
              ` : ""}
            </div>
          `).join("")}
        </div>
      ` : ""}
      ${replyOpen ? `
        <form class="reply-form" data-reply-form="${escapeHtml(post.id)}">
          <label>
            Reply
            <textarea id="reply-${escapeHtml(post.id)}" class="reply-input" rows="3" maxlength="280" placeholder="Post a public reply">${escapeHtml(state.replyDrafts[post.id] || "")}</textarea>
          </label>
          <label class="reply-photo-row">
            Photos
            <input id="reply-photo-${escapeHtml(post.id)}" type="file" accept="image/*" multiple>
          </label>
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

function render() {
  const app = document.querySelector("#app");
  const posts = filteredPosts();
  const activeBoard = state.board === "all" ? null : boardMeta(state.board);
  const signedInUser = currentUser();
  const adminComposer = signedInUser?.role === "admin";
  const quoteResults = quoteSearchResults();
  const composerOpen = Boolean(state.composerOpen || hasUnsavedComposerDraft());
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
        <form id="thread-form" class="thread-form">
          ${state.composerQuote ? `
            <div class="quote-card composer-quote">
              <div>
                <div class="quote-label">Replying with post to ${escapeHtml(state.composerQuote.label || "quoted post")}</div>
                ${state.composerQuote.excerpt ? `<div class="quote-excerpt">&gt; ${escapeHtml(state.composerQuote.excerpt)}</div>` : ""}
              </div>
              <button class="plain-board-action" type="button" data-action="clear-quote">Remove quote</button>
            </div>
          ` : ""}
          <div class="form-row">
            <label for="composer-board">Board</label>
            <select id="composer-board">
              ${BOARDS.map((board) => `<option value="${escapeHtml(board.category)}"${(state.composerBoard || state.board || "school") === board.category ? " selected" : ""}>${escapeHtml(board.slug)}</option>`).join("")}
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
          ${adminComposer ? `
            <div class="form-row">
              <label for="composer-post-number">Post No. (admin)</label>
              <input id="composer-post-number" type="number" min="1000" max="9999" value="${escapeHtml(state.composerPostNumber || "")}" placeholder="Unused 4-digit number">
            </div>
          ` : ""}
          <div class="form-actions">
            <button class="board-button primary" type="submit"${threadSubmitting ? " disabled" : ""}>${threadSubmitting ? "Posting..." : "Post thread"}</button>
            <span class="form-note">At most 9 photos per thread.</span>
          </div>
        </form>
        ` : ""}
      </section>

      <section class="thread-controls">
        <label class="control">
          <span>Search</span>
          <input id="search-input" type="search" value="${escapeHtml(state.search || "")}" placeholder="search threads and replies">
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
  document.querySelector("#composer-post-number")?.addEventListener("input", (event) => {
    state.composerPostNumber = String(event.target.value || "");
    saveState();
  });
  document.querySelector("#composer-quote-search")?.addEventListener("input", (event) => {
    state.composerQuoteSearch = String(event.target.value || "");
    saveState();
    render();
    document.querySelector("#composer-quote-search")?.focus();
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
      const commentId = button.dataset.commentId || "";
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
        return;
      }
      if (action === "open-composer") {
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
