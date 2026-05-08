import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

loadEnvFile(new URL("../.env", import.meta.url));

const adminEmail = process.env.INITIAL_ADMIN_EMAIL;
const adminPassword = process.env.INITIAL_ADMIN_PASSWORD;

if (!adminEmail || !adminPassword) {
  throw new Error("INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD are required for smoke tests");
}

const externalBaseUrl = process.env.API_BASE_URL;
let baseUrl = externalBaseUrl || "";

function loadEnvFile(url) {
  try {
    const text = fs.readFileSync(url, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...valueParts] = trimmed.split("=");
      if (!process.env[key]) process.env[key] = valueParts.join("=").replace(/^["']|["']$/g, "");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function runSmokeTests() {
  const health = await request("/health");
  const login = await request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail, password: adminPassword })
  });

  const authHeaders = { authorization: `Bearer ${login.session.token}` };
  const me = await request("/me", { headers: authHeaders });
  const verifications = await request("/admin/verifications", { headers: authHeaders });
  const posts = await request("/posts", { headers: authHeaders });
  const students = await request("/students", { headers: authHeaders });

  console.log(JSON.stringify({
    ok: true,
    service: health.service,
    user: me.user.email,
    pendingVerifications: verifications.students.length,
    posts: posts.posts.length,
    students: students.students.length
  }, null, 2));
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Failed to allocate a free port");
  return port;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(baseUrl, timeoutMs = 10_000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  const hint = lastError ? ` (last error: ${lastError.message})` : "";
  throw new Error(`Timed out waiting for server health${hint}`);
}

async function withEphemeralServer(run) {
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shsid-smoke-"));
  const dataFile = path.join(tmpDir, "dev-db.json");

  const child = spawn(process.execPath, [path.resolve("server/server.js")], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_FILE: dataFile,
      INITIAL_ADMIN_EMAIL: adminEmail,
      INITIAL_ADMIN_PASSWORD: adminPassword
    }
  });

  const apiBaseUrl = `http://127.0.0.1:${port}/api`;
  try {
    await waitForHealth(apiBaseUrl);
    await run(apiBaseUrl);
  } finally {
    if (!child.killed) child.kill("SIGTERM");
  }
}

if (externalBaseUrl) {
  await runSmokeTests();
} else {
  await withEphemeralServer(async (apiBaseUrl) => {
    baseUrl = apiBaseUrl;
    await runSmokeTests();
  });
}
