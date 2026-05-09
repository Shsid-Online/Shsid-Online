const ALLOWED_ORIGINS = [
  "https://www.shsid.online",
  "https://shsid.online"
];

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 10 * 60;
const ALLOWED_UPLOAD_TYPES = [
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
  "video/mp4", "video/webm", "video/quicktime",
  "application/pdf"
];
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains"
};
const RATE_LIMIT_MAP = new Map();
const RATE_LIMIT = { max: 30, windowMs: 60000 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const effectivePath = path.startsWith("/api/") ? path.slice("/api".length) : path;
    const corsOrigin = getAllowedOrigin(request.headers.get("Origin"));
    const clientIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
    const now = Date.now();
    const rlKey = `${clientIp}:${effectivePath}`;
    const rl = RATE_LIMIT_MAP.get(rlKey) || { count: 0, windowStart: now };
    if (now - rl.windowStart > RATE_LIMIT.windowMs) {
      RATE_LIMIT_MAP.set(rlKey, { count: 1, windowStart: now });
    } else if (rl.count >= RATE_LIMIT.max) {
      return json({ error: "Rate limit exceeded" }, 429, corsOrigin);
    } else {
      RATE_LIMIT_MAP.set(rlKey, { count: rl.count + 1, windowStart: rl.windowStart });
    }
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), corsOrigin);
    }

    try {
      if (effectivePath === "/health" && request.method === "GET") {
        return json({ ok: true, service: "shsid-online-api", date: new Date().toISOString() }, 200, corsOrigin);
      }

      if (effectivePath === "/upload-url" && request.method === "POST") {
        const body = await readJson(request);
        const fileName = String(body.fileName || "").trim();
        const contentType = String(body.contentType || "application/octet-stream").trim();

        if (!fileName) {
          return json({ error: "fileName is required" }, 400, corsOrigin);
        }

        const key = `uploads/${Date.now()}-${safeName(fileName)}`;
        const expiresAt = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
        const token = await signToken(env.UPLOAD_SIGNING_SECRET, `${key}:${expiresAt}`);
        const uploadUrl = `${url.origin}/upload/${encodeURIComponent(key)}?exp=${expiresAt}&token=${token}`;

        return json({ key, uploadUrl, method: "PUT", headers: { "content-type": contentType } }, 200, corsOrigin);
      }

      if (effectivePath.startsWith("/upload/") && request.method === "PUT") {
        const key = decodeURIComponent(effectivePath.slice("/upload/".length));
        const exp = Number(url.searchParams.get("exp") || "0");
        const token = String(url.searchParams.get("token") || "");

        if (!key || !exp || !token) {
          return json({ error: "Missing upload signature parameters" }, 400, corsOrigin);
        }

        const now = Math.floor(Date.now() / 1000);
        if (exp < now) {
          return json({ error: "Upload URL expired" }, 401, corsOrigin);
        }

        const expected = await signToken(env.UPLOAD_SIGNING_SECRET, `${key}:${exp}`);
        if (!timingSafeEqual(token, expected)) {
          return json({ error: "Invalid upload signature" }, 401, corsOrigin);
        }

        const contentLength = Number(request.headers.get("content-length") || "0");
        if (contentLength > MAX_UPLOAD_BYTES) {
          return json({ error: "File too large. Max 25 MiB." }, 413, corsOrigin);
        }

        const contentType = request.headers.get("content-type") || "application/octet-stream";
        if (!ALLOWED_UPLOAD_TYPES.includes(contentType.toLowerCase())) {
          return json({ error: "Unsupported file type" }, 415, corsOrigin);
        }
        await env.R2_BUCKET.put(key, request.body, {
          httpMetadata: { contentType }
        });

        return json({ ok: true, key }, 200, corsOrigin);
      }

      if (effectivePath === "/files" && request.method === "GET") {
        const prefix = url.searchParams.get("prefix") || "uploads/";
        const listed = await env.R2_BUCKET.list({ prefix, limit: 100 });
        const files = listed.objects.map((obj) => ({
          key: obj.key,
          size: obj.size,
          uploaded: obj.uploaded.toISOString()
        }));

        return json({ files, truncated: listed.truncated }, 200, corsOrigin);
      }

      } catch (error) {
      return json({ error: "Server error", detail: error instanceof Error ? error.message : String(error) }, 500, corsOrigin);
    }
  }
};

function getAllowedOrigin(origin) {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Vary", "Origin");
  return new Response(response.body, { ...response, headers });
}

function json(payload, status, origin) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...SECURITY_HEADERS
  });
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  return new Response(JSON.stringify(payload), { status, headers });
}

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file.bin";
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function signToken(secret, message) {
  if (!secret) {
    throw new Error("UPLOAD_SIGNING_SECRET is not configured");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(sig);
}

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
