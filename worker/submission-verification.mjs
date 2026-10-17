// Verification is independent of login and never receives the post's contents.
const COOKIE = '__Host-board-visitor';
const MAX_AGE = 30 * 86400;
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export const submissionAction = (method, route) => method === 'POST'
  ? route === '/posts' ? 'post' : /^\/posts\/[^/]+\/comments$/.test(route) ? 'comment' : '' : '';
export const verificationEnabled = env => env.SUBMISSION_VERIFICATION === 'required';

function failure(status, message) {
  return Response.json({ error: message, code: 'SUBMISSION_VERIFICATION_REQUIRED' }, {
    status, headers: { 'Cache-Control': 'no-store' }
  });
}
async function signingKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(`board-visitor-v1:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function existingVisitor(request, key, now) {
  const value = (request.headers.get('cookie') || '').split(';').map(s => s.trim())
    .find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
  const match = /^([a-f0-9-]{36})\.(\d{10})\.([a-f0-9]{64})$/.exec(value);
  if (!match) return null;
  const [, id, expiry, signature] = match;
  if (Number(expiry) <= now || Number(expiry) > now + MAX_AGE) return null;
  const bytes = Uint8Array.from(signature.match(/../g), x => parseInt(x, 16));
  return await crypto.subtle.verify('HMAC', key, bytes, encoder.encode(`${id}.${expiry}`)) ? id : null;
}

export async function verifySubmission(request, env, action, fetcher = fetch) {
  if (!verificationEnabled(env)) return {};
  if (!env.TURNSTILE_SECRET_KEY || !env.UPLOAD_SIGNING_SECRET || !env.TURNSTILE_SITE_KEY) {
    return { response: failure(503, 'Posting is temporarily unavailable. Your draft has not been sent.') };
  }
  const token = request.headers.get('X-Submission-Token') || '';
  if (!token || token.length > 2048) return { response: failure(403, 'Please refresh the page before posting. Your draft has not been sent.') };
  const hostname = new URL(request.url).hostname;
  if (!['shsid.online', 'www.shsid.online'].includes(hostname)) return { response: failure(403, 'Posting is not available on this hostname.') };
  let result;
  try {
    const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('Verification unavailable');
    result = await response.json();
  } catch {
    return { response: failure(503, 'Could not complete verification. Your draft is still here; please try again.') };
  }
  // A valid token for another hostname or another action is not a posting permit.
  if (result.success !== true || result.hostname !== hostname || result.action !== action) {
    return { response: failure(403, 'Verification expired or could not complete. Please try posting again.') };
  }
  const now = Math.floor(Date.now() / 1000);
  const key = await signingKey(env.UPLOAD_SIGNING_SECRET);
  const old = await existingVisitor(request, key, now);
  const visitor = old || crypto.randomUUID();
  if (old) return { visitor };
  const value = `${visitor}.${now + MAX_AGE}`;
  const signature = hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return { visitor, cookie: `${COOKIE}=${value}.${signature}; Path=/; Max-Age=${MAX_AGE}; Secure; HttpOnly; SameSite=Strict` };
}
