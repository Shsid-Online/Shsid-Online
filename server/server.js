const http = require("node:http");
const crypto = require("node:crypto");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const tls = require("node:tls");

loadEnvFile(path.resolve(__dirname, "..", ".env"));

const { Store, hashPassword, verifyPassword, publicUser, id, now } = require("./store");

const PORT = Number(process.env.PORT || 4174);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_FILE = process.env.DATA_FILE || "./data/dev-db.json";
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 168);
const EMAIL_VERIFICATION_TTL_MINUTES = Number(process.env.EMAIL_VERIFICATION_TTL_MINUTES || 15);
const EMAIL_VERIFICATION_MAX_ATTEMPTS = Number(process.env.EMAIL_VERIFICATION_MAX_ATTEMPTS || 5);
const EMAIL_TRANSPORT = process.env.EMAIL_TRANSPORT || (process.env.RESEND_API_KEY ? "resend" : (process.env.SMTP_HOST ? "smtp" : "log"));
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || "";
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || (process.env.SMTP_SECURE === "true" ? 465 : 587));
const SMTP_SECURE = process.env.SMTP_SECURE === "true" || SMTP_PORT === 465;
const SMTP_STARTTLS = process.env.SMTP_STARTTLS !== "false";
const SMTP_ALLOW_SELF_SIGNED = process.env.SMTP_ALLOW_SELF_SIGNED === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "no-reply@example.com";
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || "SHSID Social";
const MAX_JSON_BODY_BYTES = 1_000_000;
const ROOT = path.resolve(__dirname, "..");
const store = new Store(DATA_FILE);
store.load();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (process.env[key]) continue;
    process.env[key] = valueParts.join("=").replace(/^["']|["']$/g, "");
  }
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const commonHeaders = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "access-control-allow-origin": process.env.CORS_ORIGIN || "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type, authorization"
};

function send(res, status, payload, headers = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    ...commonHeaders,
    "content-type": typeof payload === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, payload);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_JSON_BODY_BYTES) {
        rejected = true;
        reject(new HttpError(413, "Request body too large"));
      }
    });
    req.on("end", () => {
      if (rejected) return;
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpError(400, "Invalid JSON"));
      }
    });
    req.on("error", () => reject(new HttpError(400, "Request stream error")));
  });
}

function isEmailAddress(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function createVerificationCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function verificationCodeDigest(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

function createLineReader(socket) {
  let buffer = "";
  const queue = [];
  const waiters = [];
  let closed = false;
  let failure = null;

  function flush() {
    while (queue.length && waiters.length) {
      waiters.shift().resolve(queue.shift());
    }
    if ((closed || failure) && waiters.length) {
      const error = failure || new Error("SMTP connection closed");
      while (waiters.length) waiters.shift().reject(error);
    }
  }

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      queue.push(line);
    }
    flush();
  });
  socket.on("end", () => {
    closed = true;
    flush();
  });
  socket.on("close", () => {
    closed = true;
    flush();
  });
  socket.on("error", (error) => {
    failure = error;
    flush();
  });

  return {
    nextLine() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (failure) return Promise.reject(failure);
      if (closed) return Promise.reject(new Error("SMTP connection closed"));
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    }
  };
}

function readSmtpReply(reader) {
  return new Promise(async (resolve, reject) => {
    try {
      const lines = [];
      let code = null;
      while (true) {
        const line = await reader.nextLine();
        lines.push(line);
        const match = /^(\d{3})([ -])/.exec(line);
        if (match) {
          code = match[1];
          if (match[2] === " ") break;
        } else if (lines.length === 1) {
          break;
        }
      }
      resolve({ code, lines });
    } catch (error) {
      reject(error);
    }
  });
}

async function writeSmtpLine(socket, line) {
  socket.write(`${line}\r\n`);
}

async function sendSmtpCommand(socket, reader, line) {
  await writeSmtpLine(socket, line);
  return readSmtpReply(reader);
}

function parseSmtpExtensions(lines) {
  const extensions = new Set();
  for (const line of lines.slice(1)) {
    const match = /^\d{3}[ -](.+)$/.exec(line);
    if (!match) continue;
    const token = match[1].split(/\s+/)[0];
    if (token) extensions.add(token.toUpperCase());
  }
  return extensions;
}

function formatMessageId() {
  return `${crypto.randomUUID()}@${osHostname()}`;
}

function osHostname() {
  return process.env.HOSTNAME || "localhost";
}

function formatEmailMessage({ fromName, from, to, subject, text, html }) {
  const safeSubject = String(subject).replace(/[\r\n]+/g, " ").trim();
  const safeText = String(text || "").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const headers = [
    `From: "${fromName}" <${from}>`,
    `To: <${to}>`,
    `Subject: ${safeSubject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${formatMessageId()}>`,
    "MIME-Version: 1.0"
  ];
  if (html) {
    const boundary = `boundary_${crypto.randomUUID().replaceAll("-", "")}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return [
      ...headers,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      "",
      safeText,
      `--${boundary}`,
      'Content-Type: text/html; charset="utf-8"',
      "",
      html,
      `--${boundary}--`,
      ""
    ].join("\r\n");
  }
  headers.push('Content-Type: text/plain; charset="utf-8"');
  return [...headers, "", safeText, ""].join("\r\n");
}

async function connectSmtp() {
  if (!SMTP_HOST) throw new Error("SMTP_HOST is not configured");
  const socket = SMTP_SECURE
    ? tls.connect({
        host: SMTP_HOST,
        port: SMTP_PORT,
        servername: SMTP_HOST,
        rejectUnauthorized: !SMTP_ALLOW_SELF_SIGNED
      })
    : net.connect({ host: SMTP_HOST, port: SMTP_PORT });
  await new Promise((resolve, reject) => {
    socket.once(SMTP_SECURE ? "secureConnect" : "connect", resolve);
    socket.once("error", reject);
  });
  socket.setEncoding("utf8");
  return socket;
}

async function upgradeToTls(socket) {
  const secureSocket = tls.connect({
    socket,
    servername: SMTP_HOST,
    rejectUnauthorized: !SMTP_ALLOW_SELF_SIGNED
  });
  await new Promise((resolve, reject) => {
    secureSocket.once("secureConnect", resolve);
    secureSocket.once("error", reject);
  });
  secureSocket.setEncoding("utf8");
  return secureSocket;
}

async function authenticateSmtp(socket, reader) {
  if (!SMTP_USER) return { socket, reader };

  let reply = await sendSmtpCommand(socket, reader, `AUTH PLAIN ${Buffer.from(`\0${SMTP_USER}\0${SMTP_PASS}`).toString("base64")}`);
  if (String(reply.code).startsWith("2")) return { socket, reader };

  reply = await sendSmtpCommand(socket, reader, "AUTH LOGIN");
  if (reply.code !== "334") throw new Error(`SMTP AUTH LOGIN rejected: ${reply.lines.join(" | ")}`);

  reply = await sendSmtpCommand(socket, reader, Buffer.from(SMTP_USER).toString("base64"));
  if (reply.code !== "334") throw new Error(`SMTP username rejected: ${reply.lines.join(" | ")}`);

  reply = await sendSmtpCommand(socket, reader, Buffer.from(SMTP_PASS).toString("base64"));
  if (!String(reply.code).startsWith("2")) throw new Error(`SMTP password rejected: ${reply.lines.join(" | ")}`);

  return { socket, reader };
}

async function sendVerificationEmail({ to, code }) {
  const subject = "Your SHSID Social verification code";
  const text = `Your verification code is ${code}.\n\nIt expires in ${EMAIL_VERIFICATION_TTL_MINUTES} minutes.\nIf you did not request this, you can ignore this email.`;
  const html = `<p>Your verification code is <strong>${code}</strong>.</p><p>It expires in ${EMAIL_VERIFICATION_TTL_MINUTES} minutes.</p><p>If you did not request this, you can ignore this email.</p>`;

  if (EMAIL_TRANSPORT === "resend") {
    if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");
    if (!EMAIL_FROM) throw new Error("EMAIL_FROM is not configured");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${RESEND_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [to],
        subject,
        text,
        html,
        ...(EMAIL_REPLY_TO ? { reply_to: EMAIL_REPLY_TO } : {})
      })
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Resend request failed (${response.status}): ${detail}`);
    }
    return { transport: "resend" };
  }

  if (EMAIL_TRANSPORT === "log" || !SMTP_HOST) {
    console.log(`[email:${EMAIL_TRANSPORT}] to=${to} code=${code}`);
    return { transport: "log" };
  }

  let socket = await connectSmtp();
  let reader = createLineReader(socket);
  let reply = await readSmtpReply(reader);
  if (!String(reply.code).startsWith("2")) throw new Error(`SMTP greeting failed: ${reply.lines.join(" | ")}`);

  reply = await sendSmtpCommand(socket, reader, `EHLO ${osHostname()}`);
  if (!String(reply.code).startsWith("2")) throw new Error(`SMTP EHLO failed: ${reply.lines.join(" | ")}`);

  const extensions = parseSmtpExtensions(reply.lines);
  if (!SMTP_SECURE && SMTP_STARTTLS && extensions.has("STARTTLS")) {
    reply = await sendSmtpCommand(socket, reader, "STARTTLS");
    if (reply.code !== "220") throw new Error(`SMTP STARTTLS failed: ${reply.lines.join(" | ")}`);
    socket = await upgradeToTls(socket);
    reader = createLineReader(socket);
    reply = await sendSmtpCommand(socket, reader, `EHLO ${osHostname()}`);
    if (!String(reply.code).startsWith("2")) throw new Error(`SMTP EHLO after STARTTLS failed: ${reply.lines.join(" | ")}`);
  }

  const auth = await authenticateSmtp(socket, reader);
  socket = auth.socket;
  reader = auth.reader;

  reply = await sendSmtpCommand(socket, reader, `MAIL FROM:<${SMTP_FROM}>`);
  if (!String(reply.code).startsWith("2")) throw new Error(`SMTP MAIL FROM failed: ${reply.lines.join(" | ")}`);

  reply = await sendSmtpCommand(socket, reader, `RCPT TO:<${to}>`);
  if (!String(reply.code).startsWith("2")) throw new Error(`SMTP RCPT TO failed: ${reply.lines.join(" | ")}`);

  reply = await sendSmtpCommand(socket, reader, "DATA");
  if (reply.code !== "354") throw new Error(`SMTP DATA failed: ${reply.lines.join(" | ")}`);

  const body = formatEmailMessage({
    fromName: SMTP_FROM_NAME,
    from: SMTP_FROM,
    to,
    subject,
    text,
    html
  }).replace(/\r\n\./g, "\r\n..");
  await writeSmtpLine(socket, body.replace(/\r\n$/, ""));
  await writeSmtpLine(socket, ".");
  reply = await readSmtpReply(reader);
  if (!String(reply.code).startsWith("2")) throw new Error(`SMTP message rejected: ${reply.lines.join(" | ")}`);

  try {
    await sendSmtpCommand(socket, reader, "QUIT");
  } finally {
    socket.end();
  }

  return { transport: "smtp" };
}

async function issueVerificationEmail(user) {
  const code = createVerificationCode();
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MINUTES * 60 * 1000).toISOString();
  user.emailVerification = {
    codeHash: verificationCodeDigest(code),
    expiresAt,
    attempts: 0,
    updatedAt: now()
  };
  user.updatedAt = now();
  store.audit(user.id, "email_otp_requested", { email: user.email, transport: EMAIL_TRANSPORT });
  store.save();

  const result = await sendVerificationEmail({ to: user.email, code });
  return { ...result, code };
}

function getAuthUser(req) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return store.findUserByToken(token);
}

function requireAuth(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Authentication required" });
    return null;
  }
  if (user.status === "banned") {
    sendJson(res, 403, { error: "Account banned" });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    sendJson(res, 403, { error: "Admin access required" });
    return null;
  }
  return user;
}

function userView(target, viewer) {
  const safe = publicUser(target);
  if (!safe) return null;
  const canSeePrivate = viewer?.role === "admin" || viewer?.id === target.id;
  if (!canSeePrivate) {
    delete safe.email;
    delete safe.verificationVideo;
  }
  return safe;
}

function pageParams(url, defaults = {}) {
  const limit = Math.min(Number(url.searchParams.get("limit") || defaults.limit || 50), defaults.maxLimit || 100);
  const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? limit : defaults.limit || 50,
    offset: Number.isFinite(offset) ? offset : 0
  };
}

function paginate(items, url, defaults) {
  const { limit, offset } = pageParams(url, defaults);
  return {
    items: items.slice(offset, offset + limit),
    pagination: {
      limit,
      offset,
      total: items.length,
      nextOffset: offset + limit < items.length ? offset + limit : null
    }
  };
}

function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

async function handleApi(req, res, url) {
  const method = req.method || "GET";
  const body = method === "GET" || method === "HEAD" ? {} : await parseBody(req);

  if (method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, service: "shsid-social-api", time: now() });
  }

  if (method === "POST" && url.pathname === "/api/auth/start") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!isEmailAddress(email)) return sendJson(res, 400, { error: "Enter a valid email address" });
    let user = store.findUserByEmail(email);
    if (!user) {
      user = {
        id: id("usr"),
        email,
        passwordHash: null,
        role: "student",
        status: "pending_verification",
        englishName: "",
        chineseName: "",
        grade: null,
        classNo: null,
        bio: "",
        createdAt: now(),
        updatedAt: now()
      };
      store.data.users.push(user);
      store.rebuildIndexes();
    }
    try {
      const result = await issueVerificationEmail(user);
      store.save();
      return sendJson(res, 200, {
        ok: true,
        transport: result.transport,
        ...(result.transport === "log" ? { devCode: result.code } : {})
      });
    } catch (error) {
      return sendJson(res, 502, {
        error: "Failed to send verification email",
        detail: process.env.NODE_ENV === "production" ? undefined : error.message
      });
    }
  }

  if (method === "POST" && url.pathname === "/api/auth/register") {
    const email = String(body.email || "").trim().toLowerCase();
    const user = store.findUserByEmail(email);
    if (!user) return sendJson(res, 400, { error: "No account setup was started for this email" });
    const firebaseVerified = body.firebaseVerified === true;
    if (!firebaseVerified) {
      const verification = user.emailVerification;
      if (!verification) return sendJson(res, 400, { error: "No verification code was requested for this email" });
      if (new Date(verification.expiresAt).getTime() < Date.now()) {
        return sendJson(res, 400, { error: "Verification code expired" });
      }
      if (verification.attempts >= EMAIL_VERIFICATION_MAX_ATTEMPTS) {
        return sendJson(res, 429, { error: "Too many invalid attempts" });
      }
      if (verification.codeHash !== verificationCodeDigest(body.code)) {
        verification.attempts += 1;
        user.updatedAt = now();
        store.save();
        return sendJson(res, 400, { error: "Invalid verification code" });
      }
    }
    if (!body.password || String(body.password).length < 8) return sendJson(res, 400, { error: "Password must be at least 8 characters" });
    user.passwordHash = hashPassword(String(body.password));
    delete user.emailVerification;
    user.updatedAt = now();
    const session = store.createSession(user, SESSION_TTL_HOURS);
    return sendJson(res, 201, { user: userView(user, user), session });
  }

  if (method === "POST" && url.pathname === "/api/auth/verify-code") {
    const email = String(body.email || "").trim().toLowerCase();
    const code = String(body.code || "").trim();
    const user = store.findUserByEmail(email);
    const verification = user?.emailVerification;
    if (!user || !verification) return sendJson(res, 400, { error: "No verification code was requested for this email" });
    if (new Date(verification.expiresAt).getTime() < Date.now()) {
      return sendJson(res, 400, { error: "Verification code expired" });
    }
    if (verification.attempts >= EMAIL_VERIFICATION_MAX_ATTEMPTS) {
      return sendJson(res, 429, { error: "Too many invalid attempts" });
    }
    if (verification.codeHash !== verificationCodeDigest(code)) {
      verification.attempts += 1;
      user.updatedAt = now();
      store.save();
      return sendJson(res, 400, { error: "Invalid verification code" });
    }
    return sendJson(res, 200, { ok: true });
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    const email = String(body.email || "").trim().toLowerCase();
    const user = store.findUserByEmail(email);
    if (!user || !user.passwordHash || !verifyPassword(String(body.password || ""), user.passwordHash)) {
      return sendJson(res, 401, { error: "Invalid email or password" });
    }
    const session = store.createSession(user, SESSION_TTL_HOURS);
    return sendJson(res, 200, { user: userView(user, user), session });
  }

  if (method === "POST" && url.pathname === "/api/auth/complete-profile") {
    const user = requireAuth(req, res);
    if (!user) return;
    const englishName = String(body.englishName || "").trim();
    const chineseName = String(body.chineseName || "").trim();
    const grade = Number(body.grade);
    const classNo = Number(body.classNo);
    if (!englishName || !chineseName || grade < 1 || grade > 12 || classNo < 1 || classNo > 13) {
      return sendJson(res, 400, { error: "Name, grade 1-12, and class 1-13 are required" });
    }
    const duplicate = store.data.users.find((item) => item.id !== user.id && item.englishName === englishName && item.chineseName === chineseName);
    if (duplicate) return sendJson(res, 409, { error: "A student account with this real name already exists" });
    Object.assign(user, {
      englishName,
      chineseName,
      grade,
      classNo,
      verificationVideo: body.verificationVideo || "pending-upload",
      status: user.role === "admin" ? "verified" : "pending_verification",
      updatedAt: now()
    });
    store.audit(user.id, "profile_completed");
    store.save();
    return sendJson(res, 200, { user: userView(user, user) });
  }

  if (method === "GET" && url.pathname === "/api/me") {
    const user = requireAuth(req, res);
    if (!user) return;
    return sendJson(res, 200, { user: userView(user, user) });
  }

  if (method === "GET" && url.pathname === "/api/students") {
    const user = requireAuth(req, res);
    if (!user) return;
    const { items, pagination } = paginate(store.data.users.filter((item) => item.role === "student"), url, { limit: 50, maxLimit: 100 });
    return sendJson(res, 200, { students: items.map((item) => userView(item, user)), pagination });
  }

  if (method === "GET" && url.pathname === "/api/posts") {
    const user = requireAuth(req, res);
    if (!user) return;
    const { items, pagination } = paginate(store.data.posts.filter((post) => !post.deletedAt), url, { limit: 25, maxLimit: 100 });
    const posts = items.map((post) => ({
      ...post,
      author: post.anonymous && user.role !== "admin" ? null : userView(store.findUserById(post.authorId), user),
      adminAuthor: user.role === "admin" ? userView(store.findUserById(post.authorId), user) : undefined
    }));
    return sendJson(res, 200, { posts, pagination });
  }

  if (method === "POST" && url.pathname === "/api/posts") {
    const user = requireAuth(req, res);
    if (!user) return;
    if (user.status !== "verified" && user.role !== "admin") return sendJson(res, 403, { error: "Verification required before posting" });
    const text = String(body.text || "").trim();
    if (!text && !(body.media || []).length) return sendJson(res, 400, { error: "Text or media is required" });
    const post = {
      id: id("pst"),
      authorId: user.id,
      anonymous: Boolean(body.anonymous),
      category: String(body.category || "school"),
      text,
      media: Array.isArray(body.media) ? body.media.slice(0, 9) : [],
      likes: [],
      comments: [],
      sticky: false,
      createdAt: now(),
      deletedAt: null
    };
    store.data.posts.unshift(post);
    store.audit(user.id, "post_created", { postId: post.id });
    store.save();
    return sendJson(res, 201, { post });
  }

  const postLikeMatch = url.pathname.match(/^\/api\/posts\/([^/]+)\/like$/);
  if (method === "POST" && postLikeMatch) {
    const user = requireAuth(req, res);
    if (!user) return;
    const post = store.data.posts.find((item) => item.id === postLikeMatch[1] && !item.deletedAt);
    if (!post) return notFound(res);
    post.likes = post.likes.includes(user.id) ? post.likes.filter((item) => item !== user.id) : [...post.likes, user.id];
    store.save();
    return sendJson(res, 200, { post });
  }

  const postCommentMatch = url.pathname.match(/^\/api\/posts\/([^/]+)\/comments$/);
  if (method === "POST" && postCommentMatch) {
    const user = requireAuth(req, res);
    if (!user) return;
    const post = store.data.posts.find((item) => item.id === postCommentMatch[1] && !item.deletedAt);
    if (!post) return notFound(res);
    const text = String(body.text || "").trim();
    if (!text) return sendJson(res, 400, { error: "Comment text is required" });
    const comment = { id: id("cmt"), authorId: user.id, anonymous: Boolean(body.anonymous), text, createdAt: now(), deletedAt: null };
    post.comments.push(comment);
    store.audit(user.id, "comment_created", { postId: post.id, commentId: comment.id });
    store.save();
    return sendJson(res, 201, { comment });
  }

  if (method === "POST" && url.pathname === "/api/reports") {
    const user = requireAuth(req, res);
    if (!user) return;
    const reason = String(body.reason || "").trim();
    if (!reason) return sendJson(res, 400, { error: "Report reason is required" });
    const report = {
      id: id("rpt"),
      reporterId: user.id,
      targetType: String(body.targetType || ""),
      targetId: String(body.targetId || ""),
      reason,
      status: "pending",
      adminNotes: "",
      createdAt: now(),
      resolvedAt: null
    };
    store.data.reports.push(report);
    store.audit(user.id, "report_created", { reportId: report.id });
    store.save();
    return sendJson(res, 201, { report });
  }

  if (method === "GET" && url.pathname === "/api/conversations") {
    const user = requireAuth(req, res);
    if (!user) return;
    const visible = store.data.conversations.filter((item) => item.members.includes(user.id) || user.role === "admin");
    const { items, pagination } = paginate(visible, url, { limit: 30, maxLimit: 100 });
    return sendJson(res, 200, { conversations: items, pagination });
  }

  const messageMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (method === "POST" && messageMatch) {
    const user = requireAuth(req, res);
    if (!user) return;
    const conversation = store.data.conversations.find((item) => item.id === messageMatch[1]);
    if (!conversation || (!conversation.members.includes(user.id) && user.role !== "admin")) return notFound(res);
    const text = String(body.text || "").trim();
    if (!text) return sendJson(res, 400, { error: "Message text is required" });
    const message = { id: id("msg"), authorId: user.id, anonymous: Boolean(body.anonymous), text, createdAt: now(), deletedAt: null };
    conversation.messages.push(message);
    store.audit(user.id, "message_created", { conversationId: conversation.id, messageId: message.id });
    store.save();
    return sendJson(res, 201, { message });
  }

  if (method === "GET" && url.pathname === "/api/admin/verifications") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const { items, pagination } = paginate(store.data.users.filter((user) => user.status === "pending_verification"), url, { limit: 50, maxLimit: 100 });
    return sendJson(res, 200, { students: items.map((item) => userView(item, admin)), pagination });
  }

  const verifyMatch = url.pathname.match(/^\/api\/admin\/verifications\/([^/]+)$/);
  if (method === "POST" && verifyMatch) {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const user = store.findUserById(verifyMatch[1]);
    if (!user) return notFound(res);
    const decision = body.decision === "approve" ? "verified" : "rejected";
    user.status = decision;
    user.updatedAt = now();
    store.data.notifications.push({ id: id("ntf"), userId: user.id, type: "verification", body: `Your verification was ${decision}.`, readAt: null, createdAt: now() });
    store.audit(admin.id, "verification_reviewed", { userId: user.id, decision });
    store.save();
    return sendJson(res, 200, { user: userView(user, admin) });
  }

  if (method === "GET" && url.pathname === "/api/admin/reports") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const { items, pagination } = paginate(store.data.reports, url, { limit: 50, maxLimit: 100 });
    return sendJson(res, 200, { reports: items, pagination });
  }

  const reportMatch = url.pathname.match(/^\/api\/admin\/reports\/([^/]+)$/);
  if (method === "POST" && reportMatch) {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const report = store.data.reports.find((item) => item.id === reportMatch[1]);
    if (!report) return notFound(res);
    report.status = body.status || "resolved";
    report.adminNotes = body.adminNotes || report.adminNotes;
    report.resolvedAt = now();
    store.audit(admin.id, "report_reviewed", { reportId: report.id, status: report.status });
    store.save();
    return sendJson(res, 200, { report });
  }

  if (method === "GET" && url.pathname === "/api/admin/audit-logs") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const { items, pagination } = paginate(store.data.auditLogs, url, { limit: 100, maxLimit: 500 });
    return sendJson(res, 200, { auditLogs: items, pagination });
  }

  return notFound(res);
}

function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.resolve(ROOT, `.${requested}`);
  if (!filePath.startsWith(ROOT) || filePath.includes(`${path.sep}server${path.sep}`) || filePath.includes(`${path.sep}data${path.sep}`)) {
    return notFound(res);
  }
  fs.readFile(filePath, (error, data) => {
    if (error) return notFound(res);
    res.writeHead(200, {
      ...commonHeaders,
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "OPTIONS") {
      send(res, 204, "");
      return;
    }
    if (!["GET", "HEAD", "POST"].includes(req.method || "")) {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    if (res.headersSent) return;
    const status = error.status || 500;
    const message = status >= 500 ? "Server error" : error.message;
    sendJson(res, status, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`SHSID Social running at http://${HOST}:${PORT}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
