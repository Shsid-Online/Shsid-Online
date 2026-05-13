const ALLOWED_ORIGINS = ["https://www.shsid.online", "https://shsid.online", "http://127.0.0.1:4173", "http://localhost:4173"];

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const EMAIL_CODE_TTL_SECONDS = 15 * 60;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const OTP_LENGTH = 6;
const MAX_TEXT_LEN = 10000;
const MAX_NAME_LEN = 100;
const MAX_TITLE_LEN = 200;
const MAX_REASON_LEN = 1000;
const MAX_CATEGORY_LEN = 50;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 10 * 60;
const VERIFICATION_UPLOAD_TTL_SECONDS = 24 * 60 * 60;
const VERIFICATION_CHUNK_SIZE = 8 * 1024 * 1024;
const MULTIPART_CHUNK_SIZE = 8 * 1024 * 1024;
const AD_SLOTS = new Set(["top_banner", "feed_inline", "students_inline", "popup"]);
const ALLOWED_UPLOAD_TYPES = [
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
  "video/mp4", "video/webm", "video/quicktime",
  "application/pdf"
];
let hasUsersProfilePhotoColumnCache = null;
let hasPostsTitleColumnCache = null;
let hasCommentsReplyToColumnCache = null;
let hasPostsEngagementColumnsCache = null;
let hasAdsTableCache = null;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; img-src 'self' data: https: blob:; media-src 'self' https: blob:; connect-src 'self' https://www.shsid.online https://shsid.online; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; form-action 'self'"
};
const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_MAX = 25;
const authRateMap = new Map();
let authRateLastSweepAt = 0;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const route = path.startsWith("/api/") ? path.slice(4) : path;
    const origin = getAllowedOrigin(request.headers.get("origin"));

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), origin);
    }

    try {
      const response = await handleApi(request, env, url, route, origin);
      return withCors(response, origin);
    } catch (error) {
      return json({ error: "Server error", detail: error instanceof Error ? error.message : String(error) }, 500);
    }
  }
};

async function handleApi(request, env, url, route) {
  const method = request.method || "GET";
  const isBinaryUploadPut = method === "PUT" && (
    route.startsWith("/upload/") ||
    route.startsWith("/verification-upload/") ||
    route.startsWith("/multipart/")
  );
  const body = method === "GET" || method === "HEAD" || isBinaryUploadPut ? {} : await readJson(request);

  if (method === "GET" && route === "/health") {
    return json({ ok: true, service: "shsid-social-api", time: new Date().toISOString() }, 200);
  }

  if (method === "POST" && route === "/upload-url") {
    const fileName = safeName(String(body.fileName || "").trim());
    const contentType = String(body.contentType || "application/octet-stream").trim().toLowerCase();
    const purpose = String(body.purpose || "media").trim().toLowerCase();
    if (!fileName) return json({ error: "fileName is required" }, 400);
    if (purpose === "verification") {
      if (!contentType.startsWith("video/")) return json({ error: "Verification upload must be a video file" }, 415);
    } else if (!ALLOWED_UPLOAD_TYPES.includes(contentType)) {
      return json({ error: "Unsupported file type" }, 415);
    }

    const key = `${purpose === "verification" ? "verification" : "uploads"}/${Date.now()}-${crypto.randomUUID()}-${fileName}`;
    const expiresAt = Math.floor(Date.now() / 1000) + (purpose === "verification" ? VERIFICATION_UPLOAD_TTL_SECONDS : UPLOAD_TTL_SECONDS);
    const uploadSecret = requireUploadSigningSecret(env);
    const token = await signToken(uploadSecret, `${key}:${expiresAt}`);
    const uploadUrl = `${url.origin}/upload/${encodeURIComponent(key)}?exp=${expiresAt}&token=${token}`;
    const mediaUrl = `${url.origin}/api/media/${encodeURIComponent(key)}`;
    return json({ key, uploadUrl, mediaUrl, method: "PUT", headers: { "content-type": contentType } }, 200);
  }

  if (method === "POST" && route === "/verification-upload/init") {
    const authUser = await maybeAuthUser(request, env);
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const fileName = safeName(String(body.fileName || "").trim());
    const contentType = String(body.contentType || "").trim().toLowerCase();
    if (!fileName) return json({ error: "fileName is required" }, 400);
    if (!contentType.startsWith("video/")) return json({ error: "Verification upload must be a video file" }, 415);
    const key = `verification/${Date.now()}-${crypto.randomUUID()}-${fileName}`;
    const upload = await env.R2_BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType }
    });
    return json({ key, uploadId: upload.uploadId, chunkSize: VERIFICATION_CHUNK_SIZE }, 200);
  }

  if (method === "POST" && route === "/multipart/init") {
    const authUser = await maybeAuthUser(request, env);
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const fileName = safeName(String(body.fileName || "").trim());
    const contentType = String(body.contentType || "").trim().toLowerCase();
    const purpose = String(body.purpose || "media").trim().toLowerCase();
    if (!fileName) return json({ error: "fileName is required" }, 400);
    if (purpose === "verification") {
      if (!contentType.startsWith("video/")) return json({ error: "Verification upload must be a video file" }, 415);
    } else if (!ALLOWED_UPLOAD_TYPES.includes(contentType)) {
      return json({ error: "Unsupported file type" }, 415);
    }
    const prefix = purpose === "verification" ? "verification" : "uploads";
    const key = `${prefix}/${Date.now()}-${crypto.randomUUID()}-${fileName}`;
    const upload = await env.R2_BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType }
    });
    return json({ key, uploadId: upload.uploadId, chunkSize: MULTIPART_CHUNK_SIZE }, 200);
  }

  const multipartPartMatch = route.match(/^\/multipart\/([^/]+)\/(\d+)$/);
  if (method === "PUT" && multipartPartMatch) {
    const authUser = await maybeAuthUser(request, env);
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const uploadId = multipartPartMatch[1];
    const partNumber = Number(multipartPartMatch[2]);
    const key = String(url.searchParams.get("key") || "");
    if (!key || !uploadId || !partNumber) return json({ error: "Missing upload parameters" }, 400);
    try {
      const upload = env.R2_BUCKET.resumeMultipartUpload(key, uploadId);
      const result = await upload.uploadPart(partNumber, request.body);
      return json({ ok: true, partNumber, etag: result.etag }, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: "Upload part failed", detail: message }, 502);
    }
  }

  if (method === "POST" && route === "/multipart/complete") {
    const authUser = await maybeAuthUser(request, env);
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const key = String(body.key || "");
    const uploadId = String(body.uploadId || "");
    const parts = Array.isArray(body.parts) ? body.parts : [];
    if (!key || !uploadId || !parts.length) return json({ error: "Missing completion payload" }, 400);
    try {
      const upload = env.R2_BUCKET.resumeMultipartUpload(key, uploadId);
      await upload.complete(parts.map((part) => ({
        partNumber: Number(part.partNumber),
        etag: String(part.etag)
      })));
      const mediaUrl = `${url.origin}/api/media/${encodeURIComponent(key)}`;
      return json({ ok: true, key, mediaUrl }, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: "Complete upload failed", detail: message }, 502);
    }
  }

  const verificationPartMatch = route.match(/^\/verification-upload\/([^/]+)\/(\d+)$/);
  if (method === "PUT" && verificationPartMatch) {
    const authUser = await maybeAuthUser(request, env);
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const uploadId = verificationPartMatch[1];
    const partNumber = Number(verificationPartMatch[2]);
    const key = String(url.searchParams.get("key") || "");
    if (!key || !uploadId || !partNumber) return json({ error: "Missing upload parameters" }, 400);
    if (!key.startsWith("verification/")) return json({ error: "Invalid upload key" }, 400);
    try {
      const upload = env.R2_BUCKET.resumeMultipartUpload(key, uploadId);
      const result = await upload.uploadPart(partNumber, request.body);
      return json({ ok: true, partNumber, etag: result.etag }, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: "Upload part failed", detail: message }, 502);
    }
  }

  if (method === "POST" && route === "/verification-upload/complete") {
    const authUser = await maybeAuthUser(request, env);
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const key = String(body.key || "");
    const uploadId = String(body.uploadId || "");
    const parts = Array.isArray(body.parts) ? body.parts : [];
    if (!key || !uploadId || !parts.length) return json({ error: "Missing completion payload" }, 400);
    if (!key.startsWith("verification/")) return json({ error: "Invalid upload key" }, 400);
    try {
      const upload = env.R2_BUCKET.resumeMultipartUpload(key, uploadId);
      await upload.complete(parts.map((part) => ({
        partNumber: Number(part.partNumber),
        etag: String(part.etag)
      })));
      const mediaUrl = `${url.origin}/api/media/${encodeURIComponent(key)}`;
      return json({ ok: true, key, mediaUrl }, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: "Complete upload failed", detail: message }, 502);
    }
  }

  const uploadMatch = route.match(/^\/upload\/(.+)$/);
  if (method === "PUT" && uploadMatch) {
    const key = decodeURIComponent(uploadMatch[1]);
    const exp = Number(url.searchParams.get("exp") || "0");
    const token = String(url.searchParams.get("token") || "");
    if (!key || !exp || !token) return json({ error: "Missing upload signature parameters" }, 400);
    if (Math.floor(Date.now() / 1000) > exp) return json({ error: "Upload URL expired" }, 401);
    const uploadSecret = requireUploadSigningSecret(env);
    const expected = await signToken(uploadSecret, `${key}:${exp}`);
    if (!timingSafeEqual(token, expected)) return json({ error: "Invalid upload signature" }, 401);

    const isVerificationUpload = key.startsWith("verification/");
    const contentLength = Number(request.headers.get("content-length") || "0");
    if (!isVerificationUpload && contentLength > MAX_UPLOAD_BYTES) return json({ error: "File too large. Max 25 MiB." }, 413);
    const contentType = (request.headers.get("content-type") || "application/octet-stream").toLowerCase();
    if (isVerificationUpload) {
      if (!contentType.startsWith("video/")) return json({ error: "Verification upload must be a video file" }, 415);
    } else if (!ALLOWED_UPLOAD_TYPES.includes(contentType)) {
      return json({ error: "Unsupported file type" }, 415);
    }

    try {
      await env.R2_BUCKET.put(key, request.body, { httpMetadata: { contentType } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      if (lower.includes("too large") || lower.includes("entity too large") || lower.includes("request body") || lower.includes("resource limits")) {
        return json({ error: "Verification video is too large for current Cloudflare upload limits. Please compress the file and try again." }, 413);
      }
      return json({ error: "Upload storage failed", detail: message }, 502);
    }
    return json({ ok: true, key }, 200);
  }

  const mediaMatch = route.match(/^\/media\/(.+)$/);
  if ((method === "GET" || method === "HEAD") && mediaMatch) {
    const key = decodeURIComponent(mediaMatch[1]);
    const head = await env.R2_BUCKET.head(key);
    if (!head) return json({ error: "Not found" }, 404);
    const headers = new Headers();
    head.writeHttpMetadata(headers);
    headers.set("etag", head.httpEtag);
    headers.set("cache-control", "public, max-age=3600");
    headers.set("accept-ranges", "bytes");

    const range = parseRangeHeader(request.headers.get("range"), head.size);
    if (range?.invalid) {
      headers.set("content-range", `bytes */${head.size}`);
      return new Response(null, { status: 416, headers });
    }
    if (range) {
      const length = range.end - range.start + 1;
      headers.set("content-length", String(length));
      headers.set("content-range", `bytes ${range.start}-${range.end}/${head.size}`);
      if (method === "HEAD") return new Response(null, { status: 206, headers });
      const object = await env.R2_BUCKET.get(key, { range: { offset: range.start, length } });
      if (!object) return json({ error: "Not found" }, 404);
      return new Response(object.body, { status: 206, headers });
    }

    headers.set("content-length", String(head.size));
    if (method === "HEAD") return new Response(null, { status: 200, headers });
    const object = await env.R2_BUCKET.get(key);
    if (!object) return json({ error: "Not found" }, 404);
    return new Response(object.body, { status: 200, headers });
  }

  if (method === "POST" && route === "/auth/start") {
    if (isAuthRateLimited(request, "auth_start")) return json({ error: "Too many requests. Please try again later." }, 429);
    const email = String(body.email || "").trim().toLowerCase();
    if (email.length > 254) return json({ error: "Email address too long" }, 400);
    if (!isEmailAddress(email)) return json({ error: "Enter a valid email address" }, 400);

    let user = await getUserByEmail(env, email);
    if (!user) {
      const supportsProfilePhoto = await hasUsersProfilePhotoColumn(env);
      user = {
        id: id("usr"),
        email,
        password_hash: null,
        role: "student",
        status: "pending_verification",
        english_name: "",
        chinese_name: "",
        grade: null,
        class_no: null,
        bio: "",
        profile_photo: "",
        verification_video: "",
        created_at: now(),
        updated_at: now()
      };
      if (supportsProfilePhoto) {
        await env.DB.prepare(`insert into users (id, email, password_hash, role, status, english_name, chinese_name, grade, class_no, bio, profile_photo, verification_video, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(user.id, user.email, user.password_hash, user.role, user.status, user.english_name, user.chinese_name, user.grade, user.class_no, user.bio, user.profile_photo, user.verification_video, user.created_at, user.updated_at)
          .run();
      } else {
        await env.DB.prepare(`insert into users (id, email, password_hash, role, status, english_name, chinese_name, grade, class_no, bio, verification_video, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(user.id, user.email, user.password_hash, user.role, user.status, user.english_name, user.chinese_name, user.grade, user.class_no, user.bio, user.verification_video, user.created_at, user.updated_at)
          .run();
      }
    }

    if (user.password_hash) {
      return json({ ok: true, hint: "login" }, 200);
    }

    const code = createVerificationCode();
    const codeHash = await sha256Hex(code);
    const key = `email:${email}`;
    await env.SESSIONS.put(key, JSON.stringify({ codeHash, attempts: 0, expiresAt: Date.now() + EMAIL_CODE_TTL_SECONDS * 1000 }), {
      expirationTtl: EMAIL_CODE_TTL_SECONDS
    });
    const emailResult = await sendVerificationEmail(env, email, code);
    return json({
      ok: true,
      hint: "verify",
      transport: emailResult.transport,
      ...(emailResult.transport === "log" ? { devCode: code } : {})
    }, 200);
  }

  if (method === "POST" && route === "/auth/verify-code") {
    if (isAuthRateLimited(request, "auth_verify")) return json({ error: "Too many requests. Please try again later." }, 429);
    const email = String(body.email || "").trim().toLowerCase();
    if (email.length > 254) return json({ error: "Email address too long" }, 400);
    if (!isEmailAddress(email)) return json({ error: "Enter a valid email address" }, 400);
    const code = normalizeVerificationCode(body.code);
    const key = `email:${email}`;
    const raw = await env.SESSIONS.get(key);
    if (!raw) return json({ error: "No verification code was requested for this email" }, 400);

    const record = JSON.parse(raw);
    if (Date.now() > Number(record.expiresAt || 0)) return json({ error: "Verification code expired" }, 400);
    if ((record.attempts || 0) >= EMAIL_CODE_MAX_ATTEMPTS) return json({ error: "Too many invalid attempts" }, 429);

    if (code.length !== OTP_LENGTH) return json({ error: "Invalid verification code" }, 400);
    const codeHash = await sha256Hex(code);
    if (codeHash !== record.codeHash) {
      record.attempts = (record.attempts || 0) + 1;
      await env.SESSIONS.put(key, JSON.stringify(record), { expirationTtl: EMAIL_CODE_TTL_SECONDS });
      return json({ error: "Invalid verification code" }, 400);
    }

    return json({ ok: true }, 200);
  }

  if (method === "POST" && route === "/auth/register") {
    if (isAuthRateLimited(request, "auth_register")) return json({ error: "Too many requests. Please try again later." }, 429);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (email.length > 254) return json({ error: "Email address too long" }, 400);
    if (!isEmailAddress(email)) return json({ error: "Enter a valid email address" }, 400);
    if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
    if (password.length > 128) return json({ error: "Password too long" }, 400);

    const user = await getUserByEmail(env, email);
    if (!user) return json({ error: "No account setup was started for this email" }, 400);

    const key = `email:${email}`;
    const raw = await env.SESSIONS.get(key);
    if (!raw) return json({ error: "No verification code was requested for this email" }, 400);
    const record = JSON.parse(raw);
    if (Date.now() > Number(record.expiresAt || 0)) return json({ error: "Verification code expired" }, 400);

    const code = normalizeVerificationCode(body.code);
    if (code.length !== OTP_LENGTH) return json({ error: "Invalid verification code" }, 400);
    const codeHash = await sha256Hex(code);
    if (codeHash !== record.codeHash) return json({ error: "Invalid verification code" }, 400);

    const passwordHash = await hashPassword(password);
    await env.DB.prepare("update users set password_hash = ?, updated_at = ? where id = ?").bind(passwordHash, now(), user.id).run();
    await env.SESSIONS.delete(key);

    const fresh = await getUserById(env, user.id);
    const session = await createSession(env, fresh.id);
    await audit(env, fresh.id, "auth_register", { email: fresh.email }, request);
    return json({ user: await userView(env, fresh, fresh), session }, 201);
  }

  if (method === "POST" && route === "/auth/login") {
    if (isAuthRateLimited(request, "auth_login")) return json({ error: "Too many requests. Please try again later." }, 429);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (email.length > 254) return json({ error: "Email address too long" }, 400);
    if (!isEmailAddress(email)) return json({ error: "Enter a valid email address" }, 400);
    if (password.length > 256) return json({ error: "Password too long" }, 400);
    const user = await getUserByEmail(env, email);
    if (!user || !user.password_hash) return json({ error: "Invalid email or password" }, 401);
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return json({ error: "Invalid email or password" }, 401);

    const session = await createSession(env, user.id);
    await audit(env, user.id, "auth_login", { email: user.email }, request);
    return json({ user: await userView(env, user, user), session }, 200);
  }

  if (method === "POST" && route === "/auth/logout") {
    const authUserForLogout = await maybeAuthUser(request, env);
    const token = getBearerToken(request);
    if (token) await env.SESSIONS.delete(`session:${await sha256Hex(token)}`);
    if (authUserForLogout?.id) await audit(env, authUserForLogout.id, "auth_logout", {}, request);
    return json({ ok: true }, 200);
  }

  const authUser = await maybeAuthUser(request, env);

  if (method === "GET" && route === "/me") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    return json({ user: await userView(env, authUser, authUser) }, 200);
  }

  if (method === "GET" && route === "/me/verification-queue") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    if (authUser.role === "admin" || authUser.status === "verified") {
      return json({ pendingTotal: 0, ahead: 0, position: 0 }, 200);
    }
    const totalRow = await env.DB.prepare("select count(*) as count from users where role='student' and status='pending_verification'").first();
    const meRow = await env.DB.prepare("select created_at from users where id=? limit 1").bind(authUser.id).first();
    if (!meRow?.created_at) return json({ pendingTotal: Number(totalRow?.count || 0), ahead: 0, position: 0 }, 200);
    const aheadRow = await env.DB.prepare("select count(*) as count from users where role='student' and status='pending_verification' and created_at < ?").bind(meRow.created_at).first();
    const ahead = Number(aheadRow?.count || 0);
    const pendingTotal = Number(totalRow?.count || 0);
    return json({ pendingTotal, ahead, position: ahead + 1 }, 200);
  }

  if (method === "PATCH" && route === "/me/profile") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const englishName = String(body.englishName || "").trim().slice(0, MAX_NAME_LEN);
    const chineseName = String(body.chineseName || "").trim().slice(0, MAX_NAME_LEN);
    const grade = Number(body.grade);
    const classNo = Number(body.classNo);
    const bio = String(body.bio || "").trim().slice(0, MAX_TEXT_LEN);
    const profilePhoto = String(body.profilePhoto || "").trim().slice(0, 2000);
    if (!englishName || !chineseName || !Number.isInteger(grade) || grade < 1 || grade > 12 || !Number.isInteger(classNo) || classNo < 1 || classNo > 13) {
      return json({ error: "Name, grade 1-12, and class 1-13 are required" }, 400);
    }
    if (await hasUsersProfilePhotoColumn(env)) {
      await env.DB.prepare("update users set english_name=?, chinese_name=?, grade=?, class_no=?, bio=?, profile_photo=?, updated_at=? where id=?")
        .bind(englishName, chineseName, grade, classNo, bio, profilePhoto, now(), authUser.id)
        .run();
    } else {
      await env.DB.prepare("update users set english_name=?, chinese_name=?, grade=?, class_no=?, bio=?, updated_at=? where id=?")
        .bind(englishName, chineseName, grade, classNo, bio, now(), authUser.id)
        .run();
    }
    const updated = await getUserById(env, authUser.id);
    await audit(env, authUser.id, "profile_updated", {}, request);
    return json({ user: await userView(env, updated, updated) }, 200);
  }

  if (method === "POST" && route === "/auth/complete-profile") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const englishName = String(body.englishName || "").trim().slice(0, MAX_NAME_LEN);
    const chineseName = String(body.chineseName || "").trim().slice(0, MAX_NAME_LEN);
    const grade = Number(body.grade);
    const classNo = Number(body.classNo);
    if (!englishName || !chineseName || grade < 1 || grade > 12 || classNo < 1 || classNo > 13) {
      return json({ error: "Name, grade 1-12, and class 1-13 are required" }, 400);
    }

    const duplicate = await env.DB.prepare("select id from users where id != ? and english_name = ? and chinese_name = ? limit 1")
      .bind(authUser.id, englishName, chineseName)
      .first();
    if (duplicate) return json({ error: "A student account with this real name already exists" }, 409);

    const status = authUser.role === "admin" ? "verified" : "pending_verification";
    const profilePhoto = String(body.profilePhoto || "").trim().slice(0, 2000);
    if (await hasUsersProfilePhotoColumn(env)) {
      await env.DB.prepare("update users set english_name=?, chinese_name=?, grade=?, class_no=?, bio=?, profile_photo=?, verification_video=?, status=?, updated_at=? where id=?")
        .bind(englishName, chineseName, grade, classNo, String(body.bio || "").trim().slice(0, MAX_TEXT_LEN), profilePhoto, String(body.verificationVideo || "pending-upload").slice(0, 200), status, now(), authUser.id)
        .run();
    } else {
      await env.DB.prepare("update users set english_name=?, chinese_name=?, grade=?, class_no=?, bio=?, verification_video=?, status=?, updated_at=? where id=?")
        .bind(englishName, chineseName, grade, classNo, String(body.bio || "").trim().slice(0, MAX_TEXT_LEN), String(body.verificationVideo || "pending-upload").slice(0, 200), status, now(), authUser.id)
        .run();
    }

    const updated = await getUserById(env, authUser.id);
    await audit(env, authUser.id, "profile_completed", { status }, request);
    return json({ user: await userView(env, updated, updated) }, 200);
  }

  if (method === "GET" && route === "/students") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const rows = await env.DB.prepare("select * from users where role='student' order by created_at desc").all();
    return json({ students: await Promise.all((rows.results || []).map((row) => userView(env, row, authUser))), pagination: { limit: 100, offset: 0, total: (rows.results || []).length, nextOffset: null } }, 200);
  }

  if (method === "GET" && route === "/posts") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const { limit, offset } = pageParams(url, 10, 30);
    const postRows = await env.DB.prepare("select * from posts where deleted_at is null order by sticky desc, created_at desc limit ? offset ?").bind(limit, offset).all();
    const totalRow = await env.DB.prepare("select count(*) as count from posts where deleted_at is null").first();
    const posts = [];
    for (const post of postRows.results || []) {
      const comments = await env.DB.prepare("select * from comments where post_id = ? and deleted_at is null order by created_at asc").bind(post.id).all();
      posts.push({
        ...fromDbPost(post),
        comments: (comments.results || []).map(fromDbComment),
        author: post.anonymous && authUser.role !== "admin" ? null : await userView(env, await getUserById(env, post.author_id), authUser),
        adminAuthor: authUser.role === "admin" ? await userView(env, await getUserById(env, post.author_id), authUser) : undefined
      });
    }
    const total = Number(totalRow?.count || 0);
    return json({ posts, pagination: { limit, offset, total, nextOffset: offset + limit < total ? offset + limit : null } }, 200);
  }

  const postByIdMatch = route.match(/^\/posts\/([^/]+)$/);
  if (method === "GET" && postByIdMatch) {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const post = await env.DB.prepare("select * from posts where id=? and deleted_at is null").bind(postByIdMatch[1]).first();
    if (!post) return json({ error: "Not found" }, 404);
    const comments = await env.DB.prepare("select * from comments where post_id = ? and deleted_at is null order by created_at asc").bind(post.id).all();
    return json({
      post: {
        ...fromDbPost(post),
        comments: (comments.results || []).map(fromDbComment),
        author: post.anonymous && authUser.role !== "admin" ? null : await userView(env, await getUserById(env, post.author_id), authUser),
        adminAuthor: authUser.role === "admin" ? await userView(env, await getUserById(env, post.author_id), authUser) : undefined
      }
    }, 200);
  }

  if (method === "POST" && route === "/posts") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    if (authUser.status !== "verified" && authUser.role !== "admin") return json({ error: "Verification required before posting" }, 403);
    const text = String(body.text || "").trim();
    const media = Array.isArray(body.media) ? body.media.slice(0, 20) : [];
    if (!text && media.length === 0) return json({ error: "Text or media is required" }, 400);

    const post = {
      id: id("pst"),
      author_id: authUser.id,
      title: String(body.title || "").trim().slice(0, MAX_TITLE_LEN),
      category: String(body.category || "school").slice(0, MAX_CATEGORY_LEN),
      text: text.slice(0, MAX_TEXT_LEN),
      media: JSON.stringify(media),
      likes: "[]",
      hearts: "[]",
      saved_by: "[]",
      anonymous: body.anonymous ? 1 : 0,
      sticky: 0,
      deleted_at: null,
      created_at: now()
    };

    const hasTitle = await hasPostsTitleColumn(env);
    const hasEngagementColumns = await hasPostsEngagementColumns(env);
    if (hasTitle && hasEngagementColumns) {
      await env.DB.prepare("insert into posts (id, author_id, title, category, text, media, likes, hearts, saved_by, anonymous, sticky, deleted_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(post.id, post.author_id, post.title, post.category, post.text, post.media, post.likes, post.hearts, post.saved_by, post.anonymous, post.sticky, post.deleted_at, post.created_at)
        .run();
    } else if (hasTitle) {
      await env.DB.prepare("insert into posts (id, author_id, title, category, text, media, likes, anonymous, sticky, deleted_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(post.id, post.author_id, post.title, post.category, post.text, post.media, post.likes, post.anonymous, post.sticky, post.deleted_at, post.created_at)
        .run();
    } else {
      await env.DB.prepare("insert into posts (id, author_id, category, text, media, likes, anonymous, sticky, deleted_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(post.id, post.author_id, post.category, post.text, post.media, post.likes, post.anonymous, post.sticky, post.deleted_at, post.created_at)
        .run();
    }
    await audit(env, authUser.id, "post_created", { postId: post.id }, request);

    return json({ post: fromDbPost(post) }, 201);
  }

  const postLikeMatch = route.match(/^\/posts\/([^/]+)\/like$/);
  if (method === "POST" && postLikeMatch) {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const row = await env.DB.prepare("select * from posts where id=? and deleted_at is null").bind(postLikeMatch[1]).first();
    if (!row) return json({ error: "Not found" }, 404);
    const likes = jsonArray(row.likes);
    const nextLikes = likes.includes(authUser.id) ? likes.filter((v) => v !== authUser.id) : [...likes, authUser.id];
    await env.DB.prepare("update posts set likes=? where id=?").bind(JSON.stringify(nextLikes), row.id).run();
    row.likes = JSON.stringify(nextLikes);
    if (!likes.includes(authUser.id) && row.author_id && row.author_id !== authUser.id) {
      await createNotification(env, row.author_id, "post_like_private", `${notificationActorName(authUser)} privately liked your post.`);
    }
    return json({ post: fromDbPost(row) }, 200);
  }

  const postHeartMatch = route.match(/^\/posts\/([^/]+)\/heart$/);
  if (method === "POST" && postHeartMatch) {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const row = await env.DB.prepare("select * from posts where id=? and deleted_at is null").bind(postHeartMatch[1]).first();
    if (!row) return json({ error: "Not found" }, 404);
    await hasPostsEngagementColumns(env);
    const hearts = jsonArray(row.hearts);
    const nextHearts = hearts.includes(authUser.id) ? hearts.filter((v) => v !== authUser.id) : [...hearts, authUser.id];
    await env.DB.prepare("update posts set hearts=? where id=?").bind(JSON.stringify(nextHearts), row.id).run();
    row.hearts = JSON.stringify(nextHearts);
    if (!hearts.includes(authUser.id) && row.author_id && row.author_id !== authUser.id) {
      await createNotification(env, row.author_id, "post_heart_public", `${notificationActorName(authUser)} hearted your post.`);
    }
    return json({ post: fromDbPost(row) }, 200);
  }

  const postSaveMatch = route.match(/^\/posts\/([^/]+)\/save$/);
  if (method === "POST" && postSaveMatch) {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const row = await env.DB.prepare("select * from posts where id=? and deleted_at is null").bind(postSaveMatch[1]).first();
    if (!row) return json({ error: "Not found" }, 404);
    await hasPostsEngagementColumns(env);
    const savedBy = jsonArray(row.saved_by);
    const nextSavedBy = savedBy.includes(authUser.id) ? savedBy.filter((v) => v !== authUser.id) : [...savedBy, authUser.id];
    await env.DB.prepare("update posts set saved_by=? where id=?").bind(JSON.stringify(nextSavedBy), row.id).run();
    row.saved_by = JSON.stringify(nextSavedBy);
    return json({ post: fromDbPost(row) }, 200);
  }

  const postCommentMatch = route.match(/^\/posts\/([^/]+)\/comments$/);
  if (method === "POST" && postCommentMatch) {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const text = String(body.text || "").trim();
    if (!text) return json({ error: "Comment text is required" }, 400);
    const post = await env.DB.prepare("select id from posts where id=? and deleted_at is null").bind(postCommentMatch[1]).first();
    if (!post) return json({ error: "Not found" }, 404);
    const replyTo = String(body.replyTo || "").trim();
    if (replyTo) {
      const target = await env.DB.prepare("select id from comments where id=? and post_id=? and deleted_at is null").bind(replyTo, post.id).first();
      if (!target) return json({ error: "Reply target not found" }, 400);
    }

    const comment = {
      id: id("cmt"),
      post_id: post.id,
      author_id: authUser.id,
      text: text.slice(0, MAX_TEXT_LEN),
      reply_to: replyTo || null,
      anonymous: body.anonymous ? 1 : 0,
      deleted_at: null,
      created_at: now()
    };
    if (await hasCommentsReplyToColumn(env)) {
      await env.DB.prepare("insert into comments (id, post_id, author_id, text, reply_to, anonymous, deleted_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(comment.id, comment.post_id, comment.author_id, comment.text, comment.reply_to, comment.anonymous, comment.deleted_at, comment.created_at)
        .run();
    } else {
      await env.DB.prepare("insert into comments (id, post_id, author_id, text, anonymous, deleted_at, created_at) values (?, ?, ?, ?, ?, ?, ?)")
        .bind(comment.id, comment.post_id, comment.author_id, comment.text, comment.anonymous, comment.deleted_at, comment.created_at)
        .run();
    }
    await audit(env, authUser.id, "comment_created", { postId: post.id, commentId: comment.id }, request);
    const postOwner = await env.DB.prepare("select author_id from posts where id=?").bind(post.id).first();
    if (postOwner?.author_id && postOwner.author_id !== authUser.id) {
      await createNotification(env, postOwner.author_id, "post_comment", `${notificationActorName(authUser)} commented on your post.`);
    }

    return json({ comment: fromDbComment(comment) }, 201);
  }

  const postCommentDeleteMatch = route.match(/^\/posts\/([^/]+)\/comments\/([^/]+)$/);
  if (method === "DELETE" && postCommentDeleteMatch) {
    if (!authUser || authUser.role !== "admin") return json({ error: "Admin access required" }, 403);
    const postId = postCommentDeleteMatch[1];
    const commentId = postCommentDeleteMatch[2];
    const comment = await env.DB.prepare("select * from comments where id=? and post_id=? and deleted_at is null").bind(commentId, postId).first();
    if (!comment) return json({ error: "Not found" }, 404);
    await env.DB.prepare("update comments set deleted_at=? where id=?").bind(now(), comment.id).run();
    await audit(env, authUser.id, "comment_deleted", { postId, commentId }, request);
    return json({ ok: true }, 200);
  }

  const postMatch = route.match(/^\/posts\/([^/]+)$/);
  if (postMatch && (method === "PATCH" || method === "DELETE")) {
    if (!authUser || authUser.role !== "admin") return json({ error: "Admin access required" }, 403);
    const row = await env.DB.prepare("select * from posts where id=?").bind(postMatch[1]).first();
    if (!row) return json({ error: "Not found" }, 404);
    if (method === "DELETE") {
      await env.DB.prepare("update posts set deleted_at=? where id=?").bind(now(), row.id).run();
      await audit(env, authUser.id, "post_deleted", { postId: row.id }, request);
      return json({ ok: true }, 200);
    }
    await env.DB.prepare("update posts set sticky=? where id=?").bind(body.sticky ? 1 : 0, row.id).run();
    row.sticky = body.sticky ? 1 : 0;
    await audit(env, authUser.id, "post_sticky_updated", { postId: row.id, sticky: Boolean(row.sticky) }, request);
    return json({ post: fromDbPost(row) }, 200);
  }

  if (method === "POST" && route === "/reports") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const reason = String(body.reason || "").trim().slice(0, MAX_REASON_LEN);
    if (!reason) return json({ error: "Report reason is required" }, 400);
    const report = {
      id: id("rpt"),
      reporter_id: authUser.id,
      target_type: String(body.targetType || "").slice(0, 50),
      target_id: String(body.targetId || "").slice(0, 100),
      reason,
      status: "pending",
      admin_notes: "",
      resolved_at: null,
      created_at: now()
    };
    await env.DB.prepare("insert into reports (id, reporter_id, target_type, target_id, reason, status, admin_notes, resolved_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(report.id, report.reporter_id, report.target_type, report.target_id, report.reason, report.status, report.admin_notes, report.resolved_at, report.created_at)
      .run();
    await audit(env, authUser.id, "report_created", { reportId: report.id, targetType: report.target_type }, request);
    return json({ report }, 201);
  }

  if (method === "GET" && route === "/stories") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const rows = await env.DB.prepare("select * from stories where archived_at is null and expires_at > ? order by created_at desc").bind(now()).all();
    return json({ stories: (rows.results || []).map((s) => storyViewModel(s)), pagination: { limit: 100, offset: 0, total: (rows.results || []).length, nextOffset: null } }, 200);
  }

  if (method === "POST" && route === "/stories") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    if (authUser.status !== "verified" && authUser.role !== "admin") return json({ error: "Verification required" }, 403);
    const caption = String(body.caption || body.text || "").trim().slice(0, MAX_TEXT_LEN);
    const mediaUrl = String(body.mediaUrl || "").trim().slice(0, 1000);
    const mediaType = String(body.mediaType || "").trim().slice(0, 120);
    if (!caption && !mediaUrl) return json({ error: "Story needs a caption, a photo/video, or both" }, 400);
    const packed = `__STORY__:${JSON.stringify({ caption, mediaUrl, mediaType })}`;
    const story = {
      id: id("sty"),
      author_id: authUser.id,
      text: packed,
      views: "[]",
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      archived_at: null,
      created_at: now()
    };
    await env.DB.prepare("insert into stories (id, author_id, text, views, expires_at, archived_at, created_at) values (?, ?, ?, ?, ?, ?, ?)")
      .bind(story.id, story.author_id, story.text, story.views, story.expires_at, story.archived_at, story.created_at)
      .run();
    await audit(env, authUser.id, "story_created", { storyId: story.id }, request);
    return json({ story: storyViewModel(story) }, 201);
  }

  const storyViewMatch = route.match(/^\/stories\/([^/]+)\/view$/);
  if (method === "POST" && storyViewMatch) {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const story = await env.DB.prepare("select * from stories where id=? and archived_at is null and expires_at > ?").bind(storyViewMatch[1], now()).first();
    if (!story) return json({ error: "Not found" }, 404);
    const views = jsonArray(story.views);
    if (!views.includes(authUser.id)) views.push(authUser.id);
    await env.DB.prepare("update stories set views=? where id=?").bind(JSON.stringify(views), story.id).run();
    story.views = JSON.stringify(views);
    return json({ story: storyViewModel(story) }, 200);
  }

  const storyDeleteMatch = route.match(/^\/stories\/([^/]+)$/);
  if (method === "DELETE" && storyDeleteMatch) {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const story = await env.DB.prepare("select * from stories where id=? and archived_at is null").bind(storyDeleteMatch[1]).first();
    if (!story) return json({ error: "Not found" }, 404);
    if (authUser.role !== "admin" && story.author_id !== authUser.id) return json({ error: "Forbidden" }, 403);
    await env.DB.prepare("update stories set archived_at=? where id=?").bind(now(), story.id).run();
    await audit(env, authUser.id, "story_deleted", { storyId: story.id }, request);
    return json({ ok: true }, 200);
  }

  if (method === "GET" && route === "/reels") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const { limit, offset } = pageParams(url, 10, 30);
    const rows = await env.DB.prepare("select * from reels order by created_at desc limit ? offset ?").bind(limit, offset).all();
    const totalRow = await env.DB.prepare("select count(*) as count from reels").first();
    const reels = [];
    for (const r of rows.results || []) {
      const commentCountRow = await env.DB.prepare("select count(*) as count from reel_comments where reel_id=? and deleted_at is null").bind(r.id).first();
      reels.push({
        ...r,
        likes: jsonArray(r.likes),
        authorId: r.author_id,
        videoUrl: r.video_url,
        createdAt: r.created_at,
        id: r.id,
        title: r.title,
        category: r.category,
        commentCount: Number(commentCountRow?.count || 0)
      });
    }
    const total = Number(totalRow?.count || 0);
    return json({ reels, pagination: { limit, offset, total, nextOffset: offset + limit < total ? offset + limit : null } }, 200);
  }

  if (method === "POST" && route === "/reels") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    if (authUser.status !== "verified" && authUser.role !== "admin") return json({ error: "Verification required" }, 403);
    const title = String(body.title || "").trim().slice(0, MAX_TITLE_LEN);
    if (!title) return json({ error: "Title is required" }, 400);
    const reel = {
      id: id("rel"),
      author_id: authUser.id,
      title,
      category: String(body.category || "school").slice(0, MAX_CATEGORY_LEN),
      video_url: String(body.videoUrl || "").trim().slice(0, 2000) || "pending-upload",
      likes: "[]",
      created_at: now()
    };
    await env.DB.prepare("insert into reels (id, author_id, title, category, video_url, likes, created_at) values (?, ?, ?, ?, ?, ?, ?)")
      .bind(reel.id, reel.author_id, reel.title, reel.category, reel.video_url, reel.likes, reel.created_at)
      .run();
    await audit(env, authUser.id, "reel_created", { reelId: reel.id }, request);
    return json({ reel: { ...reel, likes: [], authorId: reel.author_id, videoUrl: reel.video_url, createdAt: reel.created_at } }, 201);
  }

  const reelLikeMatch = route.match(/^\/reels\/([^/]+)\/like$/);
  if (method === "POST" && reelLikeMatch) {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const reel = await env.DB.prepare("select * from reels where id=?").bind(reelLikeMatch[1]).first();
    if (!reel) return json({ error: "Not found" }, 404);
    const likes = jsonArray(reel.likes);
    const nextLikes = likes.includes(authUser.id) ? likes.filter((v) => v !== authUser.id) : [...likes, authUser.id];
    await env.DB.prepare("update reels set likes=? where id=?").bind(JSON.stringify(nextLikes), reel.id).run();
    reel.likes = nextLikes;
    return json({ reel }, 200);
  }

  const reelCommentsMatch = route.match(/^\/reels\/([^/]+)\/comments$/);
  if (reelCommentsMatch && (method === "GET" || method === "POST")) {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const reel = await env.DB.prepare("select id from reels where id=?").bind(reelCommentsMatch[1]).first();
    if (!reel) return json({ error: "Not found" }, 404);
    if (method === "GET") {
      const rows = await env.DB.prepare("select * from reel_comments where reel_id=? and deleted_at is null order by created_at asc").bind(reel.id).all();
      const comments = (rows.results || []).map((c) => ({
        id: c.id,
        reelId: c.reel_id,
        authorId: c.author_id,
        text: c.text,
        anonymous: Boolean(c.anonymous),
        createdAt: c.created_at
      }));
      return json({ comments, pagination: { limit: 500, offset: 0, total: comments.length, nextOffset: null } }, 200);
    }
    const text = String(body.text || "").trim();
    if (!text) return json({ error: "Comment text is required" }, 400);
    const comment = {
      id: id("rcm"),
      reel_id: reel.id,
      author_id: authUser.id,
      text: text.slice(0, MAX_TEXT_LEN),
      anonymous: body.anonymous ? 1 : 0,
      deleted_at: null,
      created_at: now()
    };
    await env.DB.prepare("insert into reel_comments (id, reel_id, author_id, text, anonymous, deleted_at, created_at) values (?, ?, ?, ?, ?, ?, ?)")
      .bind(comment.id, comment.reel_id, comment.author_id, comment.text, comment.anonymous, comment.deleted_at, comment.created_at)
      .run();
    await audit(env, authUser.id, "reel_comment_created", { reelId: reel.id, commentId: comment.id }, request);
    return json({
      comment: {
        id: comment.id,
        reelId: comment.reel_id,
        authorId: comment.author_id,
        text: comment.text,
        anonymous: Boolean(comment.anonymous),
        createdAt: comment.created_at
      }
    }, 201);
  }

  if (method === "GET" && route === "/conversations") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const rows = await env.DB.prepare("select * from conversations order by created_at desc").all();
    const conversations = [];
    for (const row of rows.results || []) {
      const members = jsonArray(row.members);
      if (authUser.role !== "admin" && !members.includes(authUser.id)) continue;
      const msgRows = await env.DB.prepare("select * from messages where conversation_id = ? and deleted_at is null order by created_at asc").bind(row.id).all();
      const convMeta = unpackConversationTitle(row.title);
      conversations.push({
        id: row.id,
        title: convMeta.title,
        settings: convMeta.settings,
        members,
        group: Boolean(row.is_group),
        createdAt: row.created_at,
        messages: (msgRows.results || []).map(messageViewModel)
      });
    }
    return json({ conversations, pagination: { limit: 100, offset: 0, total: conversations.length, nextOffset: null } }, 200);
  }

  if (method === "POST" && route === "/conversations") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const memberIds = Array.isArray(body.memberIds) ? body.memberIds.map((v) => String(v || "").trim()).filter(Boolean) : [];
    const members = [...new Set([authUser.id, ...memberIds])];
    if (members.length < 2) return json({ error: "Select at least one other person to message" }, 400);
    const group = Boolean(body.group);

    let title = String(body.title || "").trim();
    if (!title) title = group ? "Group chat" : "Direct message";
    const settings = sanitizeConversationSettings(body.settings, members);
    const packedTitle = packConversationTitle(title, settings);

    const conversation = { id: id("cnv"), title: packedTitle, is_group: group ? 1 : 0, members: JSON.stringify(members), created_at: now() };
    await env.DB.prepare("insert into conversations (id, title, is_group, members, created_at) values (?, ?, ?, ?, ?)")
      .bind(conversation.id, conversation.title, conversation.is_group, conversation.members, conversation.created_at)
      .run();

    return json({ conversation: { id: conversation.id, title, settings, members, group, messages: [], createdAt: conversation.created_at } }, 201);
  }

  const convMatch = route.match(/^\/conversations\/([^/]+)$/);
  if (method === "PATCH" && convMatch) {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const conversation = await env.DB.prepare("select * from conversations where id=?").bind(convMatch[1]).first();
    if (!conversation) return json({ error: "Not found" }, 404);
    const members = jsonArray(conversation.members);
    if (authUser.role !== "admin" && !members.includes(authUser.id)) return json({ error: "Not found" }, 404);
    const currentMeta = unpackConversationTitle(conversation.title);
    const nextTitle = String(body.title || currentMeta.title || "").trim().slice(0, 120) || currentMeta.title || "Conversation";
    const nextSettings = sanitizeConversationSettings(body.settings || currentMeta.settings || {}, members);
    const packed = packConversationTitle(nextTitle, nextSettings);
    await env.DB.prepare("update conversations set title=? where id=?").bind(packed, conversation.id).run();
    return json({
      conversation: {
        id: conversation.id,
        title: nextTitle,
        settings: nextSettings,
        members,
        group: Boolean(conversation.is_group),
        createdAt: conversation.created_at
      }
    }, 200);
  }

  const convMsgMatch = route.match(/^\/conversations\/([^/]+)\/messages$/);
  if (convMsgMatch && (method === "GET" || method === "POST")) {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const conversation = await env.DB.prepare("select * from conversations where id=?").bind(convMsgMatch[1]).first();
    if (!conversation) return json({ error: "Not found" }, 404);
    const members = jsonArray(conversation.members);
    if (authUser.role !== "admin" && !members.includes(authUser.id)) return json({ error: "Not found" }, 404);

    if (method === "GET") {
      const msgRows = await env.DB.prepare("select * from messages where conversation_id = ? and deleted_at is null order by created_at asc limit 500")
        .bind(conversation.id)
        .all();
      return json({ messages: (msgRows.results || []).map(messageViewModel), pagination: { limit: 500, offset: 0, total: (msgRows.results || []).length, nextOffset: null } }, 200);
    }

    const text = String(body.text || "").trim();
    const media = Array.isArray(body.media) ? body.media.slice(0, 5) : [];
    if (!text && !media.length) return json({ error: "Message text or media is required" }, 400);
    const message = { id: id("msg"), conversation_id: conversation.id, author_id: authUser.id, text: packMessagePayload(text, media), anonymous: body.anonymous ? 1 : 0, deleted_at: null, created_at: now() };
    await env.DB.prepare("insert into messages (id, conversation_id, author_id, text, anonymous, deleted_at, created_at) values (?, ?, ?, ?, ?, ?, ?)")
      .bind(message.id, message.conversation_id, message.author_id, message.text, message.anonymous, message.deleted_at, message.created_at)
      .run();
    await audit(env, authUser.id, "message_created", { conversationId: conversation.id, messageId: message.id }, request);
    for (const memberId of members) {
      if (!memberId || memberId === authUser.id) continue;
      await createNotification(env, memberId, "message_new", `${notificationActorName(authUser)} sent you a new message.`);
    }

    return json({ message: messageViewModel(message) }, 201);
  }

  const followMatch = route.match(/^\/users\/([^/]+)\/follow$/);
  if (method === "POST" && followMatch) {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const targetId = followMatch[1];
    if (targetId === authUser.id) return json({ error: "Cannot follow yourself" }, 400);
    const target = await getUserById(env, targetId);
    if (!target || target.role !== "student") return json({ error: "Student not found" }, 404);

    const exists = await env.DB.prepare("select 1 from follows where follower_id=? and following_id=?").bind(authUser.id, targetId).first();
    if (exists) await env.DB.prepare("delete from follows where follower_id=? and following_id=?").bind(authUser.id, targetId).run();
    else await env.DB.prepare("insert into follows (follower_id, following_id, created_at) values (?, ?, ?)").bind(authUser.id, targetId, now()).run();
    await audit(env, authUser.id, exists ? "unfollow" : "follow", { targetId }, request);

    const followingRows = await env.DB.prepare("select following_id from follows where follower_id=?").bind(authUser.id).all();
    const following = (followingRows.results || []).map((r) => r.following_id);
    return json({ user: await userView(env, authUser, authUser), following }, 200);
  }

  const qnaMatch = route.match(/^\/users\/([^/]+)\/qna$/);
  if (qnaMatch && (method === "GET" || method === "POST")) {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const profile = await getUserById(env, qnaMatch[1]);
    if (!profile) return json({ error: "Not found" }, 404);

    if (method === "GET") {
      const visibilityFilter = authUser.role === "admin" || authUser.id === profile.id ? null : "public";
      const rows = visibilityFilter
        ? await env.DB.prepare("select * from qna where profile_id=? and visibility='public' order by created_at desc").bind(profile.id).all()
        : await env.DB.prepare("select * from qna where profile_id=? order by created_at desc").bind(profile.id).all();
      const questions = (rows.results || []).map((r) => ({ id: r.id, profileId: r.profile_id, askerId: r.asker_id, question: r.question, answer: r.answer, anonymous: Boolean(r.anonymous), visibility: r.visibility, createdAt: r.created_at }));
      return json({ questions, pagination: { limit: 100, offset: 0, total: questions.length, nextOffset: null } }, 200);
    }

    const question = String(body.question || "").trim();
    if (!question) return json({ error: "Question is required" }, 400);
    if (profile.id === authUser.id) return json({ error: "You cannot ask yourself a question" }, 400);
    const entry = {
      id: id("qna"),
      profile_id: profile.id,
      asker_id: authUser.id,
      question,
      answer: "",
      anonymous: body.anonymous ? 1 : 0,
      visibility: body.visibility === "private" ? "private" : "public",
      created_at: now()
    };
    await env.DB.prepare("insert into qna (id, profile_id, asker_id, question, answer, anonymous, visibility, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(entry.id, entry.profile_id, entry.asker_id, entry.question, entry.answer, entry.anonymous, entry.visibility, entry.created_at)
      .run();
    return json({ question: { id: entry.id, profileId: entry.profile_id, askerId: entry.asker_id, question: entry.question, answer: entry.answer, anonymous: Boolean(entry.anonymous), visibility: entry.visibility, createdAt: entry.created_at } }, 201);
  }

  const qnaAnswerMatch = route.match(/^\/qna\/([^/]+)\/answer$/);
  if (qnaAnswerMatch && method === "POST") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const entry = await env.DB.prepare("select * from qna where id=?").bind(qnaAnswerMatch[1]).first();
    if (!entry) return json({ error: "Not found" }, 404);
    if (authUser.role !== "admin" && authUser.id !== entry.profile_id) return json({ error: "Not allowed" }, 403);
    const answer = String(body.answer || "").trim().slice(0, MAX_TEXT_LEN);
    if (!answer) return json({ error: "Answer is required" }, 400);
    await env.DB.prepare("update qna set answer=? where id=?").bind(answer, entry.id).run();
    const updated = await env.DB.prepare("select * from qna where id=?").bind(entry.id).first();
    await audit(env, authUser.id, "qna_answered", { qnaId: entry.id, profileId: entry.profile_id }, request);
    if (entry.asker_id) {
      await env.DB.prepare("insert into notifications (id, user_id, type, body, read_at, created_at) values (?, ?, ?, ?, ?, ?)")
        .bind(id("ntf"), entry.asker_id, "qna", "Your Q&A question got a reply.", null, now())
        .run();
    }
    return json({ question: { id: updated.id, profileId: updated.profile_id, askerId: updated.asker_id, question: updated.question, answer: updated.answer, anonymous: Boolean(updated.anonymous), visibility: updated.visibility, createdAt: updated.created_at } }, 200);
  }

  if (method === "GET" && route === "/suggestions") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const rows = await env.DB.prepare("select * from suggestions where user_id=? order by created_at desc").bind(authUser.id).all();
    return json({ suggestions: rows.results || [], pagination: { limit: 100, offset: 0, total: (rows.results || []).length, nextOffset: null } }, 200);
  }

  if (method === "GET" && route === "/ads") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    await ensureAdsTable(env);
    const rows = authUser.role === "admin"
      ? await env.DB.prepare("select * from ads order by created_at desc").all()
      : await env.DB.prepare("select * from ads where active=1 order by created_at desc").all();
    const ads = (rows.results || []).map((row) => ({
      id: row.id,
      slot: row.slot,
      title: row.title,
      body: row.body,
      url: row.url || "",
      active: Boolean(row.active),
      createdAt: row.created_at
    }));
    return json({ ads, pagination: { limit: 200, offset: 0, total: ads.length, nextOffset: null } }, 200);
  }

  if (method === "POST" && route === "/admin/ads") {
    if (!authUser || authUser.role !== "admin") return json({ error: "Admin access required" }, 403);
    await ensureAdsTable(env);
    const slot = String(body.slot || "").trim().slice(0, 40);
    const title = String(body.title || "").trim().slice(0, 120);
    const text = String(body.body || "").trim().slice(0, 320);
    const url = normalizeExternalUrl(String(body.url || "").trim().slice(0, 500));
    if (!slot || !title) return json({ error: "Slot and title are required" }, 400);
    if (!AD_SLOTS.has(slot)) return json({ error: "Invalid ad slot" }, 400);
    const ad = { id: id("ad"), slot, title, body: text, url, active: body.active === false ? 0 : 1, created_at: now() };
    await env.DB.prepare("insert into ads (id, slot, title, body, url, active, created_at) values (?, ?, ?, ?, ?, ?, ?)")
      .bind(ad.id, ad.slot, ad.title, ad.body, ad.url, ad.active, ad.created_at)
      .run();
    return json({ ad: { id: ad.id, slot: ad.slot, title: ad.title, body: ad.body, url: ad.url, active: Boolean(ad.active), createdAt: ad.created_at } }, 201);
  }

  const adminAdToggleMatch = route.match(/^\/admin\/ads\/([^/]+)\/toggle$/);
  if (method === "POST" && adminAdToggleMatch) {
    if (!authUser || authUser.role !== "admin") return json({ error: "Admin access required" }, 403);
    await ensureAdsTable(env);
    const row = await env.DB.prepare("select * from ads where id=?").bind(adminAdToggleMatch[1]).first();
    if (!row) return json({ error: "Not found" }, 404);
    const nextActive = row.active ? 0 : 1;
    await env.DB.prepare("update ads set active=? where id=?").bind(nextActive, row.id).run();
    return json({ ad: { id: row.id, slot: row.slot, title: row.title, body: row.body, url: row.url || "", active: Boolean(nextActive), createdAt: row.created_at } }, 200);
  }

  const adminAdDeleteMatch = route.match(/^\/admin\/ads\/([^/]+)$/);
  if (method === "DELETE" && adminAdDeleteMatch) {
    if (!authUser || authUser.role !== "admin") return json({ error: "Admin access required" }, 403);
    await ensureAdsTable(env);
    await env.DB.prepare("delete from ads where id=?").bind(adminAdDeleteMatch[1]).run();
    return json({ ok: true }, 200);
  }

  if (method === "POST" && route === "/suggestions") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const text = String(body.text || "").trim();
    if (!text) return json({ error: "Suggestion text is required" }, 400);
    const suggestion = { id: id("sgg"), user_id: authUser.id, text, status: "pending", created_at: now() };
    await env.DB.prepare("insert into suggestions (id, user_id, text, status, created_at) values (?, ?, ?, ?, ?)")
      .bind(suggestion.id, suggestion.user_id, suggestion.text, suggestion.status, suggestion.created_at)
      .run();
    return json({ suggestion }, 201);
  }

  if (method === "GET" && route === "/admin/suggestions") {
    if (!authUser || authUser.role !== "admin") return json({ error: "Admin access required" }, 403);
    const rows = await env.DB.prepare("select * from suggestions order by created_at desc").all();
    return json({ suggestions: rows.results || [], pagination: { limit: 200, offset: 0, total: (rows.results || []).length, nextOffset: null } }, 200);
  }

  const adminSuggestionMatch = route.match(/^\/admin\/suggestions\/([^/]+)$/);
  if (method === "POST" && adminSuggestionMatch) {
    if (!authUser || authUser.role !== "admin") return json({ error: "Admin access required" }, 403);
    const suggestion = await env.DB.prepare("select * from suggestions where id=?").bind(adminSuggestionMatch[1]).first();
    if (!suggestion) return json({ error: "Not found" }, 404);
    const responseText = String(body.response || "").trim().slice(0, 280);
    if (!responseText) return json({ error: "Response is required" }, 400);
    const status = `responded::${responseText}`;
    await env.DB.prepare("update suggestions set status=? where id=?").bind(status, suggestion.id).run();
    await env.DB.prepare("insert into notifications (id, user_id, type, body, read_at, created_at) values (?, ?, ?, ?, ?, ?)")
      .bind(id("ntf"), suggestion.user_id, "suggestion", `Admin replied to your suggestion: ${responseText}`, null, now())
      .run();
    await audit(env, authUser.id, "suggestion_responded", { suggestionId: suggestion.id }, request);
    const updated = await env.DB.prepare("select * from suggestions where id=?").bind(suggestion.id).first();
    return json({ suggestion: updated }, 200);
  }

  if (method === "GET" && route === "/notifications") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    const rows = await env.DB.prepare("select * from notifications where user_id=? order by created_at desc").bind(authUser.id).all();
    const notifications = (rows.results || []).map((n) => ({ id: n.id, userId: n.user_id, type: n.type || "notice", text: n.body || "", read: Boolean(n.read_at), createdAt: n.created_at }));
    return json({ notifications, pagination: { limit: 100, offset: 0, total: notifications.length, nextOffset: null } }, 200);
  }

  if (method === "POST" && route === "/notifications/read-all") {
    if (!authUser) return json({ error: "Authentication required" }, 401);
    await env.DB.prepare("update notifications set read_at=? where user_id=? and read_at is null").bind(now(), authUser.id).run();
    return json({ ok: true }, 200);
  }

  if (method === "GET" && route === "/admin/verifications") {
    if (!authUser || authUser.role !== "admin") return json({ error: "Admin access required" }, 403);
    const rows = await env.DB.prepare("select * from users where status='pending_verification' order by created_at desc").all();
    return json({ students: await Promise.all((rows.results || []).map((u) => userView(env, u, authUser))), pagination: { limit: 100, offset: 0, total: (rows.results || []).length, nextOffset: null } }, 200);
  }

  const adminVerifyMatch = route.match(/^\/admin\/verifications\/([^/]+)$/);
  if (method === "POST" && adminVerifyMatch) {
    if (!authUser || authUser.role !== "admin") return json({ error: "Admin access required" }, 403);
    const user = await getUserById(env, adminVerifyMatch[1]);
    if (!user) return json({ error: "Not found" }, 404);
    const decision = body.decision === "approve" ? "verified" : "rejected";
    await env.DB.prepare("update users set status=?, updated_at=? where id=?").bind(decision, now(), user.id).run();
    await env.DB.prepare("insert into notifications (id, user_id, type, body, read_at, created_at) values (?, ?, ?, ?, ?, ?)")
      .bind(id("ntf"), user.id, "verification", `Your verification was ${decision}.`, null, now())
      .run();
    const updated = await getUserById(env, user.id);
    await audit(env, authUser.id, "verification_reviewed", { userId: user.id, decision }, request);
    return json({ user: await userView(env, updated, authUser) }, 200);
  }

  const adminBanMatch = route.match(/^\/admin\/users\/([^/]+)\/ban$/);
  if (method === "POST" && adminBanMatch) {
    if (!authUser || authUser.role !== "admin") return json({ error: "Admin access required" }, 403);
    const user = await getUserById(env, adminBanMatch[1]);
    if (!user) return json({ error: "Not found" }, 404);
    if (user.role === "admin") return json({ error: "Cannot ban admin account" }, 400);
    await env.DB.prepare("update users set status='banned', updated_at=? where id=?").bind(now(), user.id).run();
    await env.DB.prepare("insert into notifications (id, user_id, type, body, read_at, created_at) values (?, ?, ?, ?, ?, ?)")
      .bind(id("ntf"), user.id, "moderation", "Your account has been banned by admin review.", null, now())
      .run();
    await audit(env, authUser.id, "user_banned", { userId: user.id }, request);
    const updated = await getUserById(env, user.id);
    return json({ user: await userView(env, updated, authUser) }, 200);
  }

  if (method === "GET" && route === "/admin/reports") {
    if (!authUser || authUser.role !== "admin") return json({ error: "Admin access required" }, 403);
    const rows = await env.DB.prepare("select * from reports order by created_at desc").all();
    return json({ reports: rows.results || [], pagination: { limit: 100, offset: 0, total: (rows.results || []).length, nextOffset: null } }, 200);
  }

  const adminReportMatch = route.match(/^\/admin\/reports\/([^/]+)$/);
  if (method === "POST" && adminReportMatch) {
    if (!authUser || authUser.role !== "admin") return json({ error: "Admin access required" }, 403);
    const report = await env.DB.prepare("select * from reports where id=?").bind(adminReportMatch[1]).first();
    if (!report) return json({ error: "Not found" }, 404);
    const status = String(body.status || "resolved");
    const adminNotes = String(body.adminNotes || report.admin_notes || "");
    const resolvedAt = now();
    await env.DB.prepare("update reports set status=?, admin_notes=?, resolved_at=? where id=?").bind(status, adminNotes, resolvedAt, report.id).run();
    report.status = status;
    report.admin_notes = adminNotes;
    report.resolved_at = resolvedAt;
    await audit(env, authUser.id, "report_reviewed", { reportId: report.id, status }, request);
    return json({ report }, 200);
  }

  if (method === "GET" && route === "/admin/audit-logs") {
    if (!authUser || authUser.role !== "admin") return json({ error: "Admin access required" }, 403);
    const rows = await env.DB.prepare("select * from audit_logs order by created_at desc limit 500").all();
    return json({ auditLogs: rows.results || [], pagination: { limit: 500, offset: 0, total: (rows.results || []).length, nextOffset: null } }, 200);
  }

  if (method === "GET" && route === "/admin/bans") {
    if (!authUser || authUser.role !== "admin") return json({ error: "Admin access required" }, 403);
    const rows = await env.DB.prepare("select * from bans order by created_at desc").all();
    const enriched = (rows.results || []).map((ban) => {
      const targetUser = rows.results?.find ? null : ban;
      const targetRow = ban;
      return { ...ban, targetName: ban.target_name || "Unknown", adminName: ban.admin_name || "Unknown" };
    });
    return json({ bans: enriched, pagination: { limit: 100, offset: 0, total: (rows.results || []).length, nextOffset: null } }, 200);
  }

  const banUserMatch = route.match(/^\/admin\/bans\/([^/]+)\/user$/);
  if (method === "POST" && banUserMatch) {
    if (!authUser || authUser.role !== "admin") return json({ error: "Admin access required" }, 403);
    const targetRow = await env.DB.prepare("select * from users where id=?").bind(banUserMatch[1]).first();
    if (!targetRow) return json({ error: "Not found" }, 404);
    if (targetRow.role === "admin") return json({ error: "Cannot ban admin account" }, 400);
    const action = String(body.action || "warn");
    const reason = String(body.reason || "Violation of community guidelines").slice(0, 500);
    let endsAt = null;
    if (action === "ban_temp") {
      const days = Math.max(1, Math.min(365, parseInt(body.days || "7", 10)));
      endsAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }
    if (action !== "warn") {
      await env.DB.prepare("update users set status='banned', updated_at=? where id=?").bind(now(), targetRow.id).run();
    }
    const banId = id("ban");
    await env.DB.prepare("insert into bans (id, user_id, admin_id, action, reason, starts_at, ends_at, revoked_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(banId, targetRow.id, authUser.id, action, reason, now(), endsAt, null, now())
      .run();
    const notifBody = action === "warn"
      ? `You have received a warning from admin: ${reason}`
      : action === "ban_temp"
        ? `Your account has been temporarily suspended for ${body.days || 7} days. Reason: ${reason}`
        : "Your account has been banned by admin review.";
    await env.DB.prepare("insert into notifications (id, user_id, type, body, read_at, created_at) values (?, ?, ?, ?, ?, ?)")
      .bind(id("ntf"), targetRow.id, "moderation", notifBody, null, now())
      .run();
    const auditAction = action === "warn" ? "user_warned" : (action === "ban_temp" ? "user_temp_banned" : "user_banned");
    await audit(env, authUser.id, auditAction, { userId: targetRow.id, action, reason, endsAt }, request);
    return json({ ban: { id: banId, userId: targetRow.id, adminId: authUser.id, action, reason, startsAt: now(), endsAt } }, 201);
  }

  const revokeBanMatch = route.match(/^\/admin\/bans\/([^/]+)$/);
  if ((method === "DELETE" || method === "PATCH") && revokeBanMatch) {
    if (!authUser || authUser.role !== "admin") return json({ error: "Admin access required" }, 403);
    const ban = await env.DB.prepare("select * from bans where id=?").bind(revokeBanMatch[1]).first();
    if (!ban) return json({ error: "Not found" }, 404);
    await env.DB.prepare("update bans set revoked_at=? where id=?").bind(now(), ban.id).run();
    await env.DB.prepare("update users set status='verified', updated_at=? where id=?").bind(now(), ban.user_id).run();
    await env.DB.prepare("insert into notifications (id, user_id, type, body, read_at, created_at) values (?, ?, ?, ?, ?, ?)")
      .bind(id("ntf"), ban.user_id, "moderation", "Your account suspension has been lifted.", null, now())
      .run();
    await audit(env, authUser.id, "ban_revoked", { banId: ban.id, userId: ban.user_id }, request);
    return json({ ban: { ...ban, revoked_at: now() } }, 200);
  }

  return json({ error: "Not found" }, 404);
}

function storyViewModel(row) {
  const text = String(row.text || "");
  if (text.startsWith("__STORY__:")) {
    try {
      const parsed = JSON.parse(text.slice("__STORY__:".length));
      return {
        ...row,
        views: jsonArray(row.views),
        storyType: "media",
        caption: String(parsed?.caption || ""),
        mediaUrl: String(parsed?.mediaUrl || ""),
        mediaType: String(parsed?.mediaType || "")
      };
    } catch {
      // fall through
    }
  }
  return {
    ...row,
    views: jsonArray(row.views),
    storyType: "text",
    caption: text,
    mediaUrl: "",
    mediaType: "",
    text
  };
}

function packMessagePayload(text, media) {
  const cleanText = String(text || "").trim().slice(0, MAX_TEXT_LEN);
  const normalizedMedia = (media || []).map((item) => ({
    url: String(item?.url || "").trim().slice(0, 1000),
    type: String(item?.type || "application/octet-stream").trim().slice(0, 120),
    name: String(item?.name || "").trim().slice(0, 260)
  })).filter((item) => item.url);
  if (!normalizedMedia.length) return cleanText;
  return `__MSG__:${JSON.stringify({ text: cleanText, media: normalizedMedia })}`;
}

function unpackMessagePayload(rawText) {
  const source = String(rawText || "");
  if (!source.startsWith("__MSG__:")) return { text: source, media: [] };
  try {
    const parsed = JSON.parse(source.slice("__MSG__:".length));
    return {
      text: String(parsed?.text || ""),
      media: Array.isArray(parsed?.media) ? parsed.media : []
    };
  } catch {
    return { text: source, media: [] };
  }
}

function messageViewModel(row) {
  const unpacked = unpackMessagePayload(row.text);
  return {
    id: row.id,
    authorId: row.author_id,
    text: unpacked.text,
    media: unpacked.media,
    anonymous: Boolean(row.anonymous),
    createdAt: row.created_at,
    deletedAt: row.deleted_at
  };
}

function sanitizeConversationSettings(raw, members) {
  const input = raw && typeof raw === "object" ? raw : {};
  const memberList = Array.isArray(members) ? members.map((id) => String(id || "").trim()).filter(Boolean) : [];
  const validMembers = new Set(memberList);
  const rawAnonUsers = Array.isArray(input.anonUserIds) ? input.anonUserIds.map((id) => String(id || "").trim()).filter(Boolean) : [];
  const anonUsers = memberList.length ? rawAnonUsers.filter((id) => validMembers.has(id)) : rawAnonUsers;
  return {
    forceAnonymousAll: Boolean(input.forceAnonymousAll),
    anonUserIds: [...new Set(anonUsers)],
    showMembers: input.showMembers !== false,
    allowStatusChange: input.allowStatusChange !== false
  };
}

function packConversationTitle(title, settings) {
  return `__CNV__:${JSON.stringify({ title: String(title || "").slice(0, 120), settings: sanitizeConversationSettings(settings) })}`;
}

function unpackConversationTitle(rawTitle) {
  const raw = String(rawTitle || "");
  if (!raw.startsWith("__CNV__:")) {
    return {
      title: raw || "Conversation",
      settings: sanitizeConversationSettings({}, [])
    };
  }
  try {
    const parsed = JSON.parse(raw.slice("__CNV__:".length));
    return {
      title: String(parsed?.title || "Conversation"),
      settings: sanitizeConversationSettings(parsed?.settings || {}, [])
    };
  } catch {
    return {
      title: raw,
      settings: sanitizeConversationSettings({}, [])
    };
  }
}

function fromDbPost(row) {
  return {
    id: row.id,
    authorId: row.author_id,
    title: row.title || "",
    category: row.category,
    text: row.text,
    media: jsonArray(row.media),
    likes: jsonArray(row.likes),
    hearts: jsonArray(row.hearts),
    savedBy: jsonArray(row.saved_by),
    anonymous: Boolean(row.anonymous),
    sticky: Boolean(row.sticky),
    deletedAt: row.deleted_at,
    createdAt: row.created_at
  };
}

function fromDbComment(row) {
  return {
    id: row.id,
    postId: row.post_id,
    authorId: row.author_id,
    text: row.text,
    replyTo: row.reply_to || null,
    anonymous: Boolean(row.anonymous),
    deletedAt: row.deleted_at,
    createdAt: row.created_at
  };
}

async function maybeAuthUser(request, env) {
  const token = getBearerToken(request);
  if (!token) return null;
  const digest = await sha256Hex(token);
  const userId = await env.SESSIONS.get(`session:${digest}`);
  if (!userId) return null;
  return getUserById(env, userId);
}

function getBearerToken(request) {
  const auth = request.headers.get("authorization") || "";
  const [scheme, token] = auth.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token.trim();
}

async function createSession(env, userId) {
  const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  const digest = await sha256Hex(token);
  await env.SESSIONS.put(`session:${digest}`, userId, { expirationTtl: SESSION_TTL_SECONDS });
  return { token, expiresAt };
}

async function getUserByEmail(env, email) {
  return env.DB.prepare("select * from users where email = ? limit 1").bind(email).first();
}

async function getUserById(env, idValue) {
  return env.DB.prepare("select * from users where id = ? limit 1").bind(idValue).first();
}

async function userView(env, target, viewer) {
  if (!target) return null;
  const safe = {
    id: target.id,
    email: target.email,
    role: target.role,
    status: target.status,
    englishName: target.english_name,
    chineseName: target.chinese_name,
    grade: target.grade,
    classNo: target.class_no,
    bio: target.bio || "",
    profilePhoto: target.profile_photo || "",
    verificationVideo: target.verification_video || "",
    createdAt: target.created_at,
    updatedAt: target.updated_at
  };

  const canSeePrivate = viewer?.role === "admin" || viewer?.id === target.id;
  if (!canSeePrivate) {
    delete safe.email;
    delete safe.verificationVideo;
  }

  if (viewer?.id === target.id) {
    const followingRows = await env.DB.prepare("select following_id from follows where follower_id=?").bind(target.id).all();
    const followerRows = await env.DB.prepare("select follower_id from follows where following_id=?").bind(target.id).all();
    safe.following = (followingRows.results || []).map((row) => row.following_id);
    safe.followers = (followerRows.results || []).map((row) => row.follower_id);
  }

  return safe;
}

async function hasUsersProfilePhotoColumn(env) {
  if (hasUsersProfilePhotoColumnCache !== null) return hasUsersProfilePhotoColumnCache;
  try {
    const rows = await env.DB.prepare("pragma table_info(users)").all();
    const names = (rows.results || []).map((row) => String(row.name || "").toLowerCase());
    if (names.includes("profile_photo")) {
      hasUsersProfilePhotoColumnCache = true;
      return true;
    }
    await env.DB.prepare("alter table users add column profile_photo text default ''").run();
    hasUsersProfilePhotoColumnCache = true;
    return true;
  } catch {
    hasUsersProfilePhotoColumnCache = false;
    return false;
  }
}

async function hasPostsTitleColumn(env) {
  if (hasPostsTitleColumnCache !== null) return hasPostsTitleColumnCache;
  try {
    const rows = await env.DB.prepare("pragma table_info(posts)").all();
    const names = (rows.results || []).map((row) => String(row.name || "").toLowerCase());
    if (names.includes("title")) {
      hasPostsTitleColumnCache = true;
      return true;
    }
    await env.DB.prepare("alter table posts add column title text default ''").run();
    hasPostsTitleColumnCache = true;
    return true;
  } catch {
    hasPostsTitleColumnCache = false;
    return false;
  }
}

async function hasCommentsReplyToColumn(env) {
  if (hasCommentsReplyToColumnCache !== null) return hasCommentsReplyToColumnCache;
  try {
    const rows = await env.DB.prepare("pragma table_info(comments)").all();
    const names = (rows.results || []).map((row) => String(row.name || "").toLowerCase());
    if (names.includes("reply_to")) {
      hasCommentsReplyToColumnCache = true;
      return true;
    }
    await env.DB.prepare("alter table comments add column reply_to text").run();
    hasCommentsReplyToColumnCache = true;
    return true;
  } catch {
    hasCommentsReplyToColumnCache = false;
    return false;
  }
}

async function hasPostsEngagementColumns(env) {
  if (hasPostsEngagementColumnsCache !== null) return hasPostsEngagementColumnsCache;
  try {
    const rows = await env.DB.prepare("pragma table_info(posts)").all();
    const names = (rows.results || []).map((row) => String(row.name || "").toLowerCase());
    if (!names.includes("hearts")) await env.DB.prepare("alter table posts add column hearts text default '[]'").run();
    if (!names.includes("saved_by")) await env.DB.prepare("alter table posts add column saved_by text default '[]'").run();
    hasPostsEngagementColumnsCache = true;
    return true;
  } catch {
    hasPostsEngagementColumnsCache = false;
    return false;
  }
}

async function ensureAdsTable(env) {
  if (hasAdsTableCache) return true;
  try {
    await env.DB.prepare("create table if not exists ads (id text primary key, slot text not null, title text not null, body text not null default '', url text not null default '', active integer not null default 1, created_at text not null)").run();
    hasAdsTableCache = true;
    return true;
  } catch {
    return false;
  }
}

function getAllowedOrigin(origin) {
  if (!origin) return null;
  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

function getClientIp(request) {
  const cfIp = String(request.headers.get("cf-connecting-ip") || "").trim();
  if (cfIp) return cfIp;
  const xff = String(request.headers.get("x-forwarded-for") || "").trim();
  if (!xff) return "unknown";
  return xff.split(",")[0].trim() || "unknown";
}

function isAuthRateLimited(request, scope = "auth") {
  const nowMs = Date.now();
  if (nowMs - authRateLastSweepAt > AUTH_RATE_WINDOW_MS) {
    for (const [k, row] of authRateMap.entries()) {
      if (nowMs - Number(row?.start || 0) > AUTH_RATE_WINDOW_MS) authRateMap.delete(k);
    }
    authRateLastSweepAt = nowMs;
  }
  const key = `${scope}:${getClientIp(request)}`;
  const row = authRateMap.get(key) || { count: 0, start: nowMs };
  if (nowMs - row.start > AUTH_RATE_WINDOW_MS) {
    authRateMap.set(key, { count: 1, start: nowMs });
    return false;
  }
  row.count += 1;
  authRateMap.set(key, row);
  return row.count > AUTH_RATE_MAX;
}

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file.bin";
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

function parseRangeHeader(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match || !Number.isFinite(size) || size <= 0) return { invalid: true };

  let start;
  let end;
  const rawStart = match[1];
  const rawEnd = match[2];

  if (rawStart === "" && rawEnd === "") return { invalid: true };
  if (rawStart === "") {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return { invalid: true };
  }

  return { start, end: Math.min(end, size - 1) };
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
  }
  headers.set("access-control-allow-methods", "GET,HEAD,POST,PATCH,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "Content-Type, Authorization, Range");
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isEmailAddress(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function createVerificationCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  const num = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return String(num % 10 ** OTP_LENGTH).padStart(OTP_LENGTH, "0");
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function signToken(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendVerificationEmail(env, to, code) {
  const apiKey = String(env.RESEND_API_KEY || "").trim();
  const from = String(env.EMAIL_FROM || "").trim();
  const allowDevOtp = String(env.ALLOW_DEV_OTP || "").trim().toLowerCase() === "true";
  if (!apiKey || !from) {
    if (!allowDevOtp) {
      throw new Error("Email provider is not configured. Set RESEND_API_KEY and EMAIL_FROM.");
    }
    console.log(`[OTP][dev] ${to} -> ${code}`);
    return { transport: "log" };
  }

  const payload = {
    from,
    to: [to],
    subject: "Your SHSID Social verification code",
    text: `Your verification code is: ${code}\n\nThis code expires in 15 minutes.`,
    html: `<p>Your verification code is: <strong>${code}</strong></p><p>This code expires in 15 minutes.</p>`
  };

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Email send failed: ${response.status} ${detail}`);
  }

  return { transport: "resend" };
}

async function audit(env, actorId, action, metadata = {}, request = null) {
  try {
    const ip = request?.headers?.get("cf-connecting-ip") || request?.headers?.get("x-forwarded-for") || null;
    await env.DB.prepare("insert into audit_logs (id, actor_id, action, metadata, ip_address, created_at) values (?, ?, ?, ?, ?, ?)")
      .bind(id("aud"), actorId || null, action, JSON.stringify(metadata || {}), ip, now())
      .run();
  } catch {
    // Best-effort logging only.
  }
}

async function createNotification(env, userId, type, body) {
  if (!userId) return;
  await env.DB.prepare("insert into notifications (id, user_id, type, body, read_at, created_at) values (?, ?, ?, ?, ?, ?)")
    .bind(id("ntf"), userId, String(type || "notice").slice(0, 50), String(body || "").slice(0, 500), null, now())
    .run();
}

function notificationActorName(user) {
  const raw = String(user?.english_name || user?.email || "A student").trim();
  return raw.slice(0, 80) || "A student";
}

function requireUploadSigningSecret(env) {
  const secret = String(env.UPLOAD_SIGNING_SECRET || "").trim();
  if (!secret) {
    throw new Error("UPLOAD_SIGNING_SECRET is not configured");
  }
  return secret;
}

function pageParams(url, defaultLimit = 10, maxLimit = 30) {
  const limitRaw = Number(url.searchParams.get("limit") || defaultLimit);
  const offsetRaw = Number(url.searchParams.get("offset") || 0);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(maxLimit, Math.floor(limitRaw))) : defaultLimit;
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
  return { limit, offset };
}

function normalizeVerificationCode(value) {
  return String(value || "").replace(/[\s-]+/g, "");
}

async function hashPassword(password) {
  const salt = crypto.randomUUID().replaceAll("-", "");
  const hash = await sha256Hex(`${salt}:${password}`);
  return `${salt}:${hash}`;
}

async function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || "").split(":");
  if (!salt || !expected) return false;
  const actual = await sha256Hex(`${salt}:${password}`);
  return timingSafeEqual(actual, expected);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
