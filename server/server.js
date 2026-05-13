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

const RATE_LIMIT = { windowMs: 15 * 60 * 1000, maxAuthRequests: 20, maxOtpAttempts: 5 };
const rateLimitMap = new Map();
const OTP_LENGTH = 6;
const MAX_TEXT_LEN = 10000;
const MAX_NAME_LEN = 100;
const MAX_TITLE_LEN = 200;
const MAX_REASON_LEN = 1000;
const MAX_CATEGORY_LEN = 50;
const AD_SLOTS = new Set(["top_banner", "feed_inline", "students_inline", "popup"]);
const REPORT_TARGET_TYPES = new Set(["post", "conversation", "comment", "user"]);
const REPORT_STATUSES = new Set(["pending", "dismissed", "actioned", "resolved"]);
const VERIFICATION_DECISIONS = new Set(["approve", "reject"]);

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
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "x-xss-protection": "1; mode=block",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy": "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; img-src 'self' data: https: blob:; media-src 'self' https: blob:; connect-src 'self' https://www.shsid.online https://shsid.online; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; form-action 'self'"
};
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://www.shsid.online,https://shsid.online").split(",").map((o) => o.trim());
function getCorsOrigin(origin) {
  if (!origin) return null;
  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
}
function getCommonHeaders(req) {
  const origin = getCorsOrigin(req.headers.origin);
  return {
    ...commonHeaders,
    ...(origin ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true" } : {})
  };
}
function send(res, status, payload, headers = {}, req = null) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const h = req ? getCommonHeaders(req) : commonHeaders;
  res.writeHead(status, {
    ...h,
    "content-type": typeof payload === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  res.end(body);
}

function sendJson(res, status, payload, req = null) {
  send(res, status, payload, {}, req);
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

function checkRateLimit(ip, action) {
  const now = Date.now();
  const key = `${ip}:${action}`;
  const entry = rateLimitMap.get(key) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_LIMIT.windowMs) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return true;
  }
  const max = action === "otp_attempt" ? RATE_LIMIT.maxOtpAttempts : RATE_LIMIT.maxAuthRequests;
  if (entry.count >= max) return false;
  rateLimitMap.set(key, { count: entry.count + 1, windowStart: entry.windowStart });
  return true;
}

function getClientIp(req) {
  return req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

function isEmailAddress(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeExternalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const protocol = String(parsed.protocol || "").toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function sanitizeCategory(value) {
  const category = String(value || "school").trim().toLowerCase().slice(0, MAX_CATEGORY_LEN);
  return category || "school";
}

function sanitizeMediaItems(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).map((item) => ({
    url: normalizeExternalUrl(String(item?.url || "").trim().slice(0, 1000)),
    type: String(item?.type || "application/octet-stream").trim().slice(0, 120),
    name: String(item?.name || "").trim().slice(0, 260)
  })).filter((item) => item.url);
}

function createVerificationCode() {
  const bytes = crypto.randomBytes(5);
  const num = bytes.readUInt32BE(0) % 10 ** OTP_LENGTH;
  return String(num).padStart(OTP_LENGTH, "0");
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
  if (viewer?.id === target.id) {
    safe.following = store.data.follows.filter((row) => row.followerId === target.id).map((row) => row.followingId);
    safe.followers = store.data.follows.filter((row) => row.followingId === target.id).map((row) => row.followerId);
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
    const ip = getClientIp(req);
    if (!checkRateLimit(ip, "auth")) return sendJson(res, 429, { error: "Too many requests, please try again later" }, req);
    const email = String(body.email || "").trim().toLowerCase();
    if (!isEmailAddress(email)) return sendJson(res, 400, { error: "Enter a valid email address" }, req);
    const dispEmail = email.replace(/(.{2}).*(@.{3})/, "$1***$2");
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
    if (user.passwordHash) {
      return sendJson(res, 200, { ok: true, hint: "login" }, req);
    }
    try {
      const result = await issueVerificationEmail(user);
      store.save();
      return sendJson(res, 200, {
        ok: true,
        hint: "verify",
        transport: result.transport,
        ...(result.transport === "log" ? { devCode: result.code } : {})
      }, req);
    } catch (error) {
      return sendJson(res, 502, {
        error: "Failed to send verification email",
        detail: process.env.NODE_ENV === "production" ? undefined : error.message
      }, req);
    }
  }

  if (method === "POST" && url.pathname === "/api/auth/register") {
    const email = String(body.email || "").trim().toLowerCase();
    if (email.length > 254) return sendJson(res, 400, { error: "Email address too long" }, req);
    const user = store.findUserByEmail(email);
    if (!user) return sendJson(res, 400, { error: "No account setup was started for this email" }, req);
    const firebaseVerified = body.firebaseVerified === true;
    if (!firebaseVerified) {
      const verification = user.emailVerification;
      if (!verification) return sendJson(res, 400, { error: "No verification code was requested for this email" }, req);
      if (new Date(verification.expiresAt).getTime() < Date.now()) {
        return sendJson(res, 400, { error: "Verification code expired" }, req);
      }
      if (verification.attempts >= EMAIL_VERIFICATION_MAX_ATTEMPTS) {
        return sendJson(res, 429, { error: "Too many invalid attempts" }, req);
      }
      if (verification.codeHash !== verificationCodeDigest(body.code)) {
        verification.attempts += 1;
        user.updatedAt = now();
        store.save();
        return sendJson(res, 400, { error: "Invalid verification code" }, req);
      }
    }
    if (!body.password || String(body.password).length < 8) return sendJson(res, 400, { error: "Password must be at least 8 characters" }, req);
    if (String(body.password).length > 128) return sendJson(res, 400, { error: "Password too long" }, req);
    user.passwordHash = hashPassword(String(body.password));
    delete user.emailVerification;
    user.updatedAt = now();
    const session = store.createSession(user, SESSION_TTL_HOURS);
    return sendJson(res, 201, { user: userView(user, user), session }, req);
  }

  if (method === "POST" && url.pathname === "/api/auth/verify-code") {
    const ip = getClientIp(req);
    if (!checkRateLimit(ip, "otp_attempt")) return sendJson(res, 429, { error: "Too many attempts, please try again later" }, req);
    const email = String(body.email || "").trim().toLowerCase();
    const code = String(body.code || "").trim();
    const user = store.findUserByEmail(email);
    const verification = user?.emailVerification;
    if (!user || !verification) return sendJson(res, 400, { error: "No verification code was requested for this email" }, req);
    if (new Date(verification.expiresAt).getTime() < Date.now()) {
      return sendJson(res, 400, { error: "Verification code expired" }, req);
    }
    if (verification.attempts >= EMAIL_VERIFICATION_MAX_ATTEMPTS) {
      return sendJson(res, 429, { error: "Too many invalid attempts" }, req);
    }
    if (verification.codeHash !== verificationCodeDigest(code)) {
      verification.attempts += 1;
      user.updatedAt = now();
      store.save();
      return sendJson(res, 400, { error: "Invalid verification code" }, req);
    }
    return sendJson(res, 200, { ok: true }, req);
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    const ip = getClientIp(req);
    if (!checkRateLimit(ip, "auth")) return sendJson(res, 429, { error: "Too many requests, please try again later" }, req);
    const email = String(body.email || "").trim().toLowerCase();
    const user = store.findUserByEmail(email);
    if (!user || !user.passwordHash || !verifyPassword(String(body.password || ""), user.passwordHash)) {
      return sendJson(res, 401, { error: "Invalid email or password" }, req);
    }
    const session = store.createSession(user, SESSION_TTL_HOURS);
    return sendJson(res, 200, { user: userView(user, user), session }, req);
  }

  if (method === "POST" && url.pathname === "/api/auth/logout") {
    const user = requireAuth(req, res);
    if (!user) return;
    const header = req.headers.authorization || "";
    const token = header.split(/\s+/)[1];
    store.audit(user.id, "session_revoked");
    if (token) store.revokeSessionByToken(token);
    else store.save();
    return sendJson(res, 200, { ok: true });
  }

  if (method === "POST" && url.pathname === "/api/auth/complete-profile") {
    const user = requireAuth(req, res);
    if (!user) return;
    const englishName = String(body.englishName || "").trim().slice(0, MAX_NAME_LEN);
    const chineseName = String(body.chineseName || "").trim().slice(0, MAX_NAME_LEN);
    const grade = Number(body.grade);
    const classNo = Number(body.classNo);
    if (!englishName || !chineseName || grade < 1 || grade > 12 || classNo < 1 || classNo > 13) {
      return sendJson(res, 400, { error: "Name, grade 1-12, and class 1-13 are required" }, req);
    }
    const duplicate = store.data.users.find((item) => item.id !== user.id && item.englishName === englishName && item.chineseName === chineseName);
    if (duplicate) return sendJson(res, 409, { error: "A student account with this real name already exists" }, req);
    Object.assign(user, {
      englishName,
      chineseName,
      grade,
      classNo,
      verificationVideo: String(body.verificationVideo || "pending-upload").slice(0, 200),
      bio: String(body.bio || "").trim().slice(0, MAX_TEXT_LEN),
      status: user.role === "admin" ? "verified" : "pending_verification",
      updatedAt: now()
    });
    store.audit(user.id, "profile_completed");
    store.save();
    return sendJson(res, 200, { user: userView(user, user) }, req);
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
    const categoryFilter = String(url.searchParams.get("category") || "").trim().toLowerCase();
    const visiblePosts = store.data.posts.filter((post) => {
      if (post.deletedAt) return false;
      if (!categoryFilter) return true;
      return String(post.category || "").trim().toLowerCase() === categoryFilter;
    });
    const { items, pagination } = paginate(visiblePosts, url, { limit: 25, maxLimit: 100 });
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
    if (user.status !== "verified" && user.role !== "admin") return sendJson(res, 403, { error: "Verification required before posting" }, req);
    const text = String(body.text || "").trim();
    if (!text && !(body.media || []).length) return sendJson(res, 400, { error: "Text or media is required" }, req);
    const sanitizedText = text.slice(0, MAX_TEXT_LEN);
    const category = sanitizeCategory(body.category);
    const post = {
      id: id("pst"),
      authorId: user.id,
      anonymous: Boolean(body.anonymous),
      category,
      text: sanitizedText,
      media: sanitizeMediaItems(body.media, 9),
      likes: [],
      hearts: [],
      savedBy: [],
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
    const wasLiked = post.likes.includes(user.id);
    post.likes = wasLiked ? post.likes.filter((item) => item !== user.id) : [...post.likes, user.id];
    if (!wasLiked && post.authorId && post.authorId !== user.id) {
      store.data.notifications.push({ id: id("ntf"), userId: post.authorId, type: "post_like_private", body: `${user.englishName || "A student"} privately liked your post.`, readAt: null, createdAt: now() });
    }
    store.save();
    return sendJson(res, 200, { post });
  }

  const postHeartMatch = url.pathname.match(/^\/api\/posts\/([^/]+)\/heart$/);
  if (method === "POST" && postHeartMatch) {
    const user = requireAuth(req, res);
    if (!user) return;
    const post = store.data.posts.find((item) => item.id === postHeartMatch[1] && !item.deletedAt);
    if (!post) return notFound(res);
    post.hearts ||= [];
    const wasHearted = post.hearts.includes(user.id);
    post.hearts = wasHearted ? post.hearts.filter((item) => item !== user.id) : [...post.hearts, user.id];
    if (!wasHearted && post.authorId && post.authorId !== user.id) {
      store.data.notifications.push({ id: id("ntf"), userId: post.authorId, type: "post_heart_public", body: `${user.englishName || "A student"} hearted your post.`, readAt: null, createdAt: now() });
    }
    store.save();
    return sendJson(res, 200, { post });
  }

  const postSaveMatch = url.pathname.match(/^\/api\/posts\/([^/]+)\/save$/);
  if (method === "POST" && postSaveMatch) {
    const user = requireAuth(req, res);
    if (!user) return;
    const post = store.data.posts.find((item) => item.id === postSaveMatch[1] && !item.deletedAt);
    if (!post) return notFound(res);
    post.savedBy ||= [];
    post.savedBy = post.savedBy.includes(user.id) ? post.savedBy.filter((item) => item !== user.id) : [...post.savedBy, user.id];
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
    if (!text) return sendJson(res, 400, { error: "Comment text is required" }, req);
    const replyTo = String(body.replyTo || "").trim();
    if (replyTo && !post.comments.some((item) => item.id === replyTo && !item.deletedAt)) {
      return sendJson(res, 400, { error: "Reply target not found" }, req);
    }
    const comment = {
      id: id("cmt"),
      authorId: user.id,
      anonymous: Boolean(body.anonymous),
      text: text.slice(0, MAX_TEXT_LEN),
      replyTo: replyTo || null,
      createdAt: now(),
      deletedAt: null
    };
    post.comments.push(comment);
    if (post.authorId && post.authorId !== user.id) {
      store.data.notifications.push({ id: id("ntf"), userId: post.authorId, type: "post_comment", body: `${user.englishName || "A student"} commented on your post.`, readAt: null, createdAt: now() });
    }
    store.audit(user.id, "comment_created", { postId: post.id, commentId: comment.id });
    store.save();
    return sendJson(res, 201, { comment });
  }

  const postIdOnlyMatch = url.pathname.match(/^\/api\/posts\/([^/]+)$/);
  if (postIdOnlyMatch && (method === "PATCH" || method === "DELETE")) {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const post = store.data.posts.find((item) => item.id === postIdOnlyMatch[1]);
    if (!post) return notFound(res);
    if (method === "DELETE") {
      post.deletedAt = now();
      store.audit(admin.id, "post_deleted", { postId: post.id });
      store.save();
      return sendJson(res, 200, { ok: true });
    }
    if (body.sticky !== undefined) post.sticky = Boolean(body.sticky);
    store.audit(admin.id, "post_updated", { postId: post.id, sticky: post.sticky });
    store.save();
    return sendJson(res, 200, { post });
  }

  if (method === "POST" && url.pathname === "/api/reports") {
    const user = requireAuth(req, res);
    if (!user) return;
    const targetType = String(body.targetType || "").trim().toLowerCase();
    const targetId = String(body.targetId || "").trim().slice(0, 100);
    const reason = String(body.reason || "").trim().slice(0, MAX_REASON_LEN);
    if (!reason) return sendJson(res, 400, { error: "Report reason is required" }, req);
    if (!REPORT_TARGET_TYPES.has(targetType)) return sendJson(res, 400, { error: "Invalid report target type" }, req);
    if (!targetId) return sendJson(res, 400, { error: "Report target is required" }, req);
    if (targetType === "post") {
      const targetPost = store.data.posts.find((item) => item.id === targetId && !item.deletedAt);
      if (!targetPost) return sendJson(res, 404, { error: "Report target not found" }, req);
    }
    if (targetType === "conversation") {
      const targetConversation = store.data.conversations.find((item) => item.id === targetId);
      if (!targetConversation) return sendJson(res, 404, { error: "Report target not found" }, req);
      if (user.role !== "admin" && !targetConversation.members.includes(user.id)) {
        return sendJson(res, 403, { error: "Not allowed to report this conversation" }, req);
      }
    }
    const duplicatePending = store.data.reports.find((item) =>
      item.reporterId === user.id
      && item.targetType === targetType
      && item.targetId === targetId
      && item.status === "pending"
    );
    if (duplicatePending) return sendJson(res, 409, { error: "Report already pending for this target" }, req);
    const report = {
      id: id("rpt"),
      reporterId: user.id,
      targetType,
      targetId,
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

  if (method === "POST" && url.pathname === "/api/conversations") {
    const user = requireAuth(req, res);
    if (!user) return;
    if (user.role !== "admin" && user.status !== "verified") return sendJson(res, 403, { error: "Verification required before messaging" });
    const memberIds = Array.isArray(body.memberIds) ? body.memberIds.map((item) => String(item || "").trim()).filter(Boolean) : [];
    const uniqueMembers = [...new Set([user.id, ...memberIds])];
    if (uniqueMembers.length < 2) return sendJson(res, 400, { error: "Select at least one other person to message" });
    if (uniqueMembers.length > 50) return sendJson(res, 400, { error: "Conversation has too many members" });
    const otherMembers = uniqueMembers.filter((memberId) => memberId !== user.id);
    for (const memberId of otherMembers) {
      const target = store.findUserById(memberId);
      if (!target || target.role !== "student" || target.status !== "verified") {
        return sendJson(res, 400, { error: "Only verified students can be added to conversations" });
      }
    }
    const group = Boolean(body.group);
    if (!group && uniqueMembers.length !== 2) return sendJson(res, 400, { error: "Direct conversations must include exactly one other user" });
    if (!group) {
      const existingDirect = store.data.conversations.find((item) =>
        !item.group
        && Array.isArray(item.members)
        && item.members.length === 2
        && item.members.includes(uniqueMembers[0])
        && item.members.includes(uniqueMembers[1])
      );
      if (existingDirect) return sendJson(res, 200, { conversation: existingDirect });
    }
    let title = String(body.title || "").trim();
    if (!title) {
      if (group) title = "Group chat";
      else {
        const otherId = uniqueMembers.find((memberId) => memberId !== user.id);
        const other = otherId ? store.findUserById(otherId) : null;
        title = other?.englishName || other?.email || "Direct message";
      }
    }
    const conversation = {
      id: id("cnv"),
      title,
      members: uniqueMembers,
      group,
      messages: [],
      createdAt: now()
    };
    store.data.conversations.unshift(conversation);
    store.audit(user.id, "conversation_created", { conversationId: conversation.id });
    store.save();
    return sendJson(res, 201, { conversation });
  }

  const messageMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (messageMatch && (method === "GET" || method === "POST")) {
    const user = requireAuth(req, res);
    if (!user) return;
    const conversation = store.data.conversations.find((item) => item.id === messageMatch[1]);
    if (!conversation || (!conversation.members.includes(user.id) && user.role !== "admin")) return notFound(res);
    if (method === "GET") {
      const msgs = (conversation.messages || []).filter((item) => !item.deletedAt);
      const { items, pagination } = paginate(msgs, url, { limit: 100, maxLimit: 500 });
      return sendJson(res, 200, { messages: items, pagination });
    }
    const text = String(body.text || "").trim();
    const media = sanitizeMediaItems(body.media, 5);
    if (!text && !media.length) return sendJson(res, 400, { error: "Message text or media is required" }, req);
    const message = {
      id: id("msg"),
      authorId: user.id,
      anonymous: Boolean(body.anonymous),
      text: text.slice(0, MAX_TEXT_LEN),
      media,
      createdAt: now(),
      deletedAt: null
    };
    conversation.messages.push(message);
    for (const memberId of conversation.members || []) {
      if (!memberId || memberId === user.id) continue;
      store.data.notifications.push({ id: id("ntf"), userId: memberId, type: "message_new", body: `${user.englishName || "A student"} sent you a new message.`, readAt: null, createdAt: now() });
    }
    store.audit(user.id, "message_created", { conversationId: conversation.id, messageId: message.id });
    store.save();
    return sendJson(res, 201, { message });
  }

  if (method === "GET" && url.pathname === "/api/notifications") {
    const user = requireAuth(req, res);
    if (!user) return;
    const mine = store.data.notifications
      .filter((item) => item.userId === user.id)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const { items, pagination } = paginate(mine, url, { limit: 50, maxLimit: 100 });
    const notifications = items.map((item) => ({
      id: item.id,
      userId: item.userId,
      type: item.type || "notice",
      text: item.body || item.text || "",
      read: Boolean(item.readAt),
      createdAt: item.createdAt
    }));
    return sendJson(res, 200, { notifications, pagination });
  }

  if (method === "POST" && url.pathname === "/api/notifications/read-all") {
    const user = requireAuth(req, res);
    if (!user) return;
    const marked = now();
    for (const item of store.data.notifications) {
      if (item.userId === user.id && !item.readAt) item.readAt = marked;
    }
    store.save();
    return sendJson(res, 200, { ok: true });
  }

  if (method === "GET" && url.pathname === "/api/stories") {
    const user = requireAuth(req, res);
    if (!user) return;
    const active = store.data.stories.filter((story) => {
      if (story.archivedAt) return false;
      const exp = new Date(story.expiresAt || 0).getTime();
      return exp > Date.now();
    });
    const sorted = active.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const { items, pagination } = paginate(sorted, url, { limit: 50, maxLimit: 100 });
    return sendJson(res, 200, { stories: items, pagination });
  }

  if (method === "POST" && url.pathname === "/api/stories") {
    const user = requireAuth(req, res);
    if (!user) return;
    if (user.status !== "verified" && user.role !== "admin") return sendJson(res, 403, { error: "Verification required" });
    const text = String(body.text || "").trim();
    if (!text) return sendJson(res, 400, { error: "Story text is required" }, req);
    const story = {
      id: id("sty"),
      authorId: user.id,
      text: text.slice(0, MAX_TEXT_LEN),
      views: [],
      createdAt: now(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      archivedAt: null
    };
    store.data.stories.unshift(story);
    store.audit(user.id, "story_created", { storyId: story.id });
    store.save();
    return sendJson(res, 201, { story });
  }

  const storyViewMatch = url.pathname.match(/^\/api\/stories\/([^/]+)\/view$/);
  if (method === "POST" && storyViewMatch) {
    const user = requireAuth(req, res);
    if (!user) return;
    const story = store.data.stories.find((item) => item.id === storyViewMatch[1]);
    if (!story || story.archivedAt || new Date(story.expiresAt || 0).getTime() <= Date.now()) return notFound(res);
    story.views ||= [];
    if (!story.views.includes(user.id)) story.views.push(user.id);
    store.save();
    return sendJson(res, 200, { story });
  }

  if (method === "GET" && url.pathname === "/api/reels") {
    const user = requireAuth(req, res);
    if (!user) return;
    const categoryFilter = String(url.searchParams.get("category") || "").trim().toLowerCase();
    const visibleReels = store.data.reels.filter((reel) => {
      if (!categoryFilter) return true;
      return String(reel.category || "").trim().toLowerCase() === categoryFilter;
    });
    const { items, pagination } = paginate(visibleReels, url, { limit: 30, maxLimit: 100 });
    return sendJson(res, 200, { reels: items, pagination });
  }

  if (method === "POST" && url.pathname === "/api/reels") {
    const user = requireAuth(req, res);
    if (!user) return;
    if (user.status !== "verified" && user.role !== "admin") return sendJson(res, 403, { error: "Verification required" });
    const title = String(body.title || "").trim().slice(0, MAX_TITLE_LEN);
    const category = sanitizeCategory(body.category);
    const videoUrl = normalizeExternalUrl(String(body.videoUrl || "").trim().slice(0, 2000)) || "pending-upload";
    if (!title) return sendJson(res, 400, { error: "Title is required" }, req);
    const reel = {
      id: id("rel"),
      authorId: user.id,
      title,
      category,
      videoUrl,
      likes: [],
      createdAt: now()
    };
    store.data.reels.unshift(reel);
    store.audit(user.id, "reel_created", { reelId: reel.id });
    store.save();
    return sendJson(res, 201, { reel });
  }

  const reelLikeMatch = url.pathname.match(/^\/api\/reels\/([^/]+)\/like$/);
  if (method === "POST" && reelLikeMatch) {
    const user = requireAuth(req, res);
    if (!user) return;
    const reel = store.data.reels.find((item) => item.id === reelLikeMatch[1]);
    if (!reel) return notFound(res);
    reel.likes ||= [];
    reel.likes = reel.likes.includes(user.id) ? reel.likes.filter((item) => item !== user.id) : [...reel.likes, user.id];
    store.save();
    return sendJson(res, 200, { reel });
  }

  const userFollowMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/follow$/);
  if (method === "POST" && userFollowMatch) {
    const user = requireAuth(req, res);
    if (!user) return;
    if (user.role === "admin") return sendJson(res, 403, { error: "Admins cannot follow students" });
    if (user.role !== "admin" && user.status !== "verified") return sendJson(res, 403, { error: "Verification required before following" });
    const targetId = userFollowMatch[1];
    const target = store.findUserById(targetId);
    if (!target || target.role !== "student") return sendJson(res, 404, { error: "Student not found" });
    if (target.status !== "verified") return sendJson(res, 400, { error: "Only verified students can be followed" });
    if (targetId === user.id) return sendJson(res, 400, { error: "Cannot follow yourself" });
    const idx = store.data.follows.findIndex((row) => row.followerId === user.id && row.followingId === targetId);
    if (idx >= 0) {
      store.data.follows.splice(idx, 1);
      store.audit(user.id, "unfollow", { targetId });
    } else {
      store.data.follows.push({ followerId: user.id, followingId: targetId, createdAt: now() });
      store.audit(user.id, "follow", { targetId });
    }
    store.save();
    return sendJson(res, 200, { user: userView(user, user), following: store.data.follows.filter((row) => row.followerId === user.id).map((row) => row.followingId) });
  }

  const userQnaMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/qna$/);
  if (userQnaMatch && (method === "GET" || method === "POST")) {
    const user = requireAuth(req, res);
    if (!user) return;
    const profileId = userQnaMatch[1];
    const profile = store.findUserById(profileId);
    if (!profile) return notFound(res);
    if (profile.role !== "student" || profile.status !== "verified") return sendJson(res, 400, { error: "Q&A is only available for verified students" });
    if (method === "GET") {
      const visibility = user.role === "admin" || user.id === profileId ? null : "public";
      let rows = store.data.qna.filter((row) => row.profileId === profileId);
      if (visibility) rows = rows.filter((row) => row.visibility === "public");
      const { items, pagination } = paginate(rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()), url, { limit: 50, maxLimit: 100 });
      return sendJson(res, 200, { questions: items, pagination });
    }
    const question = String(body.question || "").trim().slice(0, MAX_TEXT_LEN);
    const visibility = String(body.visibility || "public").trim().toLowerCase();
    if (!question) return sendJson(res, 400, { error: "Question is required" });
    if (user.role !== "admin" && user.status !== "verified") return sendJson(res, 403, { error: "Verification required before asking questions" });
    if (profileId === user.id) return sendJson(res, 400, { error: "You cannot ask yourself a question" });
    if (!["public", "private"].includes(visibility)) return sendJson(res, 400, { error: "Invalid visibility" });
    const entry = {
      id: id("qna"),
      profileId,
      askerId: user.id,
      anonymous: Boolean(body.anonymous),
      visibility,
      question,
      answer: "",
      createdAt: now()
    };
    store.data.qna.push(entry);
    store.audit(user.id, "qna_asked", { profileId, questionId: entry.id });
    store.save();
    return sendJson(res, 201, { question: entry });
  }

  const qnaAnswerMatch = url.pathname.match(/^\/api\/qna\/([^/]+)\/answer$/);
  if (qnaAnswerMatch && method === "POST") {
    const user = requireAuth(req, res);
    if (!user) return;
    const entry = store.data.qna.find((item) => item.id === qnaAnswerMatch[1]);
    if (!entry) return notFound(res);
    if (user.role !== "admin" && user.id !== entry.profileId) return sendJson(res, 403, { error: "Not allowed" });
    const answer = String(body.answer || "").trim().slice(0, MAX_TEXT_LEN);
    if (!answer) return sendJson(res, 400, { error: "Answer is required" });
    entry.answer = answer;
    if (entry.askerId && entry.askerId !== user.id) {
      store.data.notifications.push({
        id: id("ntf"),
        userId: entry.askerId,
        type: "qna",
        body: "Your Q&A question got a reply.",
        readAt: null,
        createdAt: now()
      });
    }
    store.audit(user.id, "qna_answered", { qnaId: entry.id, profileId: entry.profileId });
    store.save();
    return sendJson(res, 200, { question: entry });
  }

  if (method === "GET" && url.pathname === "/api/suggestions") {
    const user = requireAuth(req, res);
    if (!user) return;
    const mine = store.data.suggestions
      .filter((item) => item.userId === user.id)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const { items, pagination } = paginate(mine, url, { limit: 50, maxLimit: 100 });
    return sendJson(res, 200, { suggestions: items, pagination });
  }

  if (method === "GET" && url.pathname === "/api/ads") {
    const user = requireAuth(req, res);
    if (!user) return;
    store.data.ads ||= [];
    const rows = user.role === "admin" ? store.data.ads : store.data.ads.filter((ad) => ad.active);
    return sendJson(res, 200, { ads: rows, pagination: { limit: 200, offset: 0, total: rows.length, nextOffset: null } });
  }

  if (method === "POST" && url.pathname === "/api/admin/ads") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const slot = String(body.slot || "").trim().slice(0, 40);
    const title = String(body.title || "").trim().slice(0, 120);
    const adBody = String(body.body || "").trim().slice(0, 320);
    const adUrl = normalizeExternalUrl(String(body.url || "").trim().slice(0, 500));
    if (!slot || !title) return sendJson(res, 400, { error: "Slot and title are required" });
    if (!AD_SLOTS.has(slot)) return sendJson(res, 400, { error: "Invalid ad slot" });
    store.data.ads ||= [];
    const ad = { id: id("ad"), slot, title, body: adBody, url: adUrl, active: body.active === false ? false : true, createdAt: now() };
    store.data.ads.push(ad);
    store.save();
    return sendJson(res, 201, { ad });
  }

  const adminAdToggleMatch = url.pathname.match(/^\/api\/admin\/ads\/([^/]+)\/toggle$/);
  if (method === "POST" && adminAdToggleMatch) {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    store.data.ads ||= [];
    const ad = store.data.ads.find((item) => item.id === adminAdToggleMatch[1]);
    if (!ad) return notFound(res);
    ad.active = !ad.active;
    store.save();
    return sendJson(res, 200, { ad });
  }

  const adminAdDeleteMatch = url.pathname.match(/^\/api\/admin\/ads\/([^/]+)$/);
  if (method === "DELETE" && adminAdDeleteMatch) {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    store.data.ads ||= [];
    store.data.ads = store.data.ads.filter((item) => item.id !== adminAdDeleteMatch[1]);
    store.save();
    return sendJson(res, 200, { ok: true });
  }

  if (method === "POST" && url.pathname === "/api/suggestions") {
    const user = requireAuth(req, res);
    if (!user) return;
    if (user.role === "admin") return sendJson(res, 403, { error: "Admins cannot submit suggestions" });
    if (user.status !== "verified") return sendJson(res, 403, { error: "Verification required before submitting suggestions" });
    const text = String(body.text || "").trim().slice(0, 1000);
    if (!text) return sendJson(res, 400, { error: "Suggestion text is required" });
    const suggestion = {
      id: id("sgg"),
      userId: user.id,
      text,
      status: "pending",
      createdAt: now()
    };
    store.data.suggestions.push(suggestion);
    store.audit(user.id, "suggestion_created", { suggestionId: suggestion.id });
    store.save();
    return sendJson(res, 201, { suggestion });
  }

  if (method === "GET" && url.pathname === "/api/admin/suggestions") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const all = [...store.data.suggestions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const { items, pagination } = paginate(all, url, { limit: 100, maxLimit: 200 });
    return sendJson(res, 200, { suggestions: items, pagination });
  }

  const adminSuggestionMatch = url.pathname.match(/^\/api\/admin\/suggestions\/([^/]+)$/);
  if (method === "POST" && adminSuggestionMatch) {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const suggestion = store.data.suggestions.find((item) => item.id === adminSuggestionMatch[1]);
    if (!suggestion) return notFound(res);
    if (String(suggestion.status || "").startsWith("responded::")) return sendJson(res, 400, { error: "Suggestion already responded" });
    const response = String(body.response || "").trim().slice(0, 280);
    if (!response) return sendJson(res, 400, { error: "Response is required" });
    suggestion.status = `responded::${response}`;
    suggestion.updatedAt = now();
    store.audit(admin.id, "suggestion_replied", { suggestionId: suggestion.id });
    store.save();
    return sendJson(res, 200, { suggestion });
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
    if (user.role !== "student") return sendJson(res, 400, { error: "Only student accounts can be verified" });
    if (user.role === "admin") return sendJson(res, 400, { error: "Cannot verify admin account" });
    if (user.status !== "pending_verification") return sendJson(res, 400, { error: "User is not pending verification" });
    const requestedDecision = String(body.decision || "").trim().toLowerCase();
    if (!VERIFICATION_DECISIONS.has(requestedDecision)) return sendJson(res, 400, { error: "Invalid verification decision" });
    const decision = requestedDecision === "approve" ? "verified" : "rejected";
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
    if (report.status && report.status !== "pending") return sendJson(res, 400, { error: "Report already handled" });
    const nextStatus = String(body.status || "resolved").trim().toLowerCase();
    if (!REPORT_STATUSES.has(nextStatus)) return sendJson(res, 400, { error: "Invalid report status" });
    report.status = nextStatus;
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

  if (method === "GET" && url.pathname === "/api/admin/bans") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const { items, pagination } = paginate(store.data.bans, url, { limit: 100, maxLimit: 500 });
    const enriched = items.map((ban) => {
      const targetUser = store.findUserById(ban.userId);
      const adminUser = store.findUserById(ban.adminId);
      return {
        ...ban,
        targetName: targetUser ? `${targetUser.englishName} (${targetUser.chineseName})` : "Unknown",
        targetGrade: targetUser ? `G${targetUser.grade} C${targetUser.classNo}` : "-",
        adminName: adminUser ? adminUser.englishName : "Unknown"
      };
    });
    return sendJson(res, 200, { bans: enriched, pagination });
  }

  const banCheckMatch = url.pathname.match(/^\/api\/admin\/bans\/check\/([^/]+)$/);
  if (method === "GET" && banCheckMatch) {
    const user = requireAuth(req, res);
    if (!user) return;
    const targetUser = store.findUserById(banCheckMatch[1]);
    if (!targetUser) return notFound(res);
    const nowMs = Date.now();
    const activeBan = store.data.bans.find((ban) => {
      if (ban.userId !== targetUser.id) return false;
      if (ban.revokedAt) return false;
      const starts = new Date(ban.startsAt).getTime();
      if (starts > nowMs) return false;
      if (!ban.endsAt) return true;
      return new Date(ban.endsAt).getTime() > nowMs;
    });
    return sendJson(res, 200, { banned: Boolean(activeBan), ban: activeBan || null });
  }

  const banUserMatch = url.pathname.match(/^\/api\/admin\/bans\/([^/]+)\/user$/);
  if (method === "POST" && banUserMatch) {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const targetUser = store.findUserById(banUserMatch[1]);
    if (!targetUser) return notFound(res);
    if (targetUser.role === "admin") return sendJson(res, 400, { error: "Cannot ban admin account" });
    if (targetUser.status === "banned") return sendJson(res, 400, { error: "User is already banned" });
    const action = String(body.action || "warn");
    if (!["warn", "ban_temp", "ban_perm"].includes(action)) {
      return sendJson(res, 400, { error: "Invalid moderation action" });
    }
    const reason = String(body.reason || "Violation of community guidelines").slice(0, 500);
    let endsAt = null;
    let days = 7;
    if (action === "ban_temp") {
      const parsedDays = parseInt(String(body.days || "7"), 10);
      days = Number.isInteger(parsedDays) ? Math.max(1, Math.min(365, parsedDays)) : 7;
      endsAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }
    if (action !== "warn") {
      targetUser.status = "banned";
      targetUser.updatedAt = now();
    }
    const ban = {
      id: id("ban"),
      userId: targetUser.id,
      adminId: admin.id,
      action,
      reason,
      startsAt: now(),
      endsAt,
      revokedAt: null,
      createdAt: now()
    };
    store.data.bans.unshift(ban);
    const notifBody = action === "warn"
      ? `You have received a warning from admin: ${reason}`
      : action === "ban_temp"
        ? `Your account has been temporarily suspended for ${days} days. Reason: ${reason}`
        : "Your account has been banned by admin review.";
    store.data.notifications.push({ id: id("ntf"), userId: targetUser.id, type: "moderation", body: notifBody, readAt: null, createdAt: now() });
    store.audit(admin.id, action === "warn" ? "user_warned" : (action === "ban_temp" ? "user_temp_banned" : "user_banned"), { userId: targetUser.id, action, reason, endsAt });
    store.save();
    return sendJson(res, 201, { ban });
  }

  const revokeBanMatch = url.pathname.match(/^\/api\/admin\/bans\/([^/]+)$/);
  if ((method === "DELETE" || method === "PATCH") && revokeBanMatch) {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const ban = store.data.bans.find((item) => item.id === revokeBanMatch[1]);
    if (!ban) return notFound(res);
    if (ban.action === "warn") return sendJson(res, 400, { error: "Warnings cannot be revoked" });
    if (ban.revokedAt) return sendJson(res, 400, { error: "Ban already revoked" });
    ban.revokedAt = now();
    const targetUser = store.findUserById(ban.userId);
    if (targetUser) {
      if (targetUser.status === "banned") {
        targetUser.status = "verified";
        targetUser.updatedAt = now();
      }
      store.data.notifications.push({ id: id("ntf"), userId: targetUser.id, type: "moderation", body: "Your account suspension has been lifted.", readAt: null, createdAt: now() });
    }
    store.audit(admin.id, "ban_revoked", { banId: ban.id, userId: ban.userId });
    store.save();
    return sendJson(res, 200, { ban });
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
    if (method === "OPTIONS") {
      send(res, 204, "", {}, req);
      return;
    }
    if (!["GET", "HEAD", "POST", "PATCH", "DELETE"].includes(req.method || "")) {
      sendJson(res, 405, { error: "Method not allowed" }, req);
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
    sendJson(res, status, { error: message }, req);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`SHSID Social running at http://${HOST}:${PORT}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
