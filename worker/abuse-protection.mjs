// Cloudflare's counters are shared across isolates in a location, without D1/KV reads.
export async function protectRequest(request, env, route) {
  if (route === '/health' || request.method === 'OPTIONS') return null;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const isWrite = !['GET', 'HEAD'].includes(request.method);
  const checks = [[env.API_RATE_LIMIT, `ip:${ip}`]];
  if (isWrite) checks.push([env.WRITE_RATE_LIMIT, `ip:${ip}`]);
  const isContent = request.method === 'POST' &&
    (route === '/posts' || /^\/posts\/[^/]+\/comments$/.test(route));
  if (isContent) {
    checks.push([env.POST_RATE_LIMIT, `ip:${ip}`]);
    const owner = request.headers.get('X-Board-Owner-Token');
    if (owner) checks.push([env.POST_RATE_LIMIT, `owner:${owner.slice(0, 256)}`]);
  }
  for (const [binding, key] of checks) {
    // Fail closed if deployment omitted a required binding.
    if (!binding) return rejection(503, 'Protection temporarily unavailable. Please try again shortly.');
    if (!(await binding.limit({ key })).success) return rejection(429, 'Too many requests. Please wait a minute and try again.');
  }
  // Media reads do not hit D1 unless they require private-media authorization.
  if (['GET', 'HEAD'].includes(request.method) && route.startsWith('/media/uploads')) return null;
  if (!env.GLOBAL_GUARD) return rejection(503, 'Protection temporarily unavailable.');
  try {
    const guard = env.GLOBAL_GUARD.get(env.GLOBAL_GUARD.idFromName('board-budget-v1'));
    const isUpload = /^\/(upload(?:-url)?|verification-upload|multipart)(?:\/|$)/.test(route);
    const kind = isContent ? 'content' : isUpload ? 'upload' : isWrite && route.startsWith('/auth/') ? 'auth' : isWrite ? 'write' : 'read';
    const offset = Number(new URL(request.url).searchParams.get('offset') || 0);
    if (route === '/posts' && (!Number.isInteger(offset) || offset < 0 || offset > 10000)) return rejection(400, 'Invalid page');
    // Deep OFFSET scans cost more than a first-page read and cannot cheaply burn D1.
    const cost = route === '/posts' && !isWrite ? 1 + Math.ceil(offset / 100) : 1;
    const result = await guard.fetch(`https://guard/${kind}?cost=${cost}`);
    return result.status === 204 ? null : rejection(result.status === 429 ? 429 : 503, 'The board is temporarily limiting traffic. Please try again later.');
  } catch {
    return rejection(503, 'Protection temporarily unavailable.');
  }
}

export function rejection(status, error) {
  return new Response(JSON.stringify({ error }), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '60'
  } });
}

export async function rejectDuplicate(env, route, body, request) {
  const content = JSON.stringify([route, String(body.title || '').trim().toLowerCase(),
    String(body.text || '').trim().toLowerCase(), body.media || [], body.replyTo || '', body.quoteRef || null]);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  const key = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  if (!env.DUPLICATE_RATE_LIMIT) return rejection(503, 'Protection temporarily unavailable.');
  if (!(await env.DUPLICATE_RATE_LIMIT.limit({ key })).success) {
    return rejection(429, 'This was recently submitted. Check the board before posting again.');
  }
  if (!env.GLOBAL_GUARD) return rejection(503, 'Protection temporarily unavailable.');
  // Fingerprint meaningful text, not attacker-controlled metadata or counters.
  const normalize = value => String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, '').replace(/#\s*\d+/g, '')
    .replace(/[\p{P}\p{Z}\s]+/gu, ' ').trim();
  const text = normalize(body.text);
  const title = normalize(body.title);
  const canonical = JSON.stringify([route, body.replyTo || '', text || title || body.media || []]);
  const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
  try {
    const guard = env.GLOBAL_GUARD.get(env.GLOBAL_GUARD.idFromName('board-budget-v1'));
    const response = await guard.fetch(new Request('https://guard/submission', { method: 'POST', body: JSON.stringify({
      fingerprint: await hash(canonical), client: await hash(request?.headers.get('CF-Connecting-IP') || 'unknown')
    }) }));
    if (response.status !== 204) return rejection(response.status === 429 ? 429 : 503, 'Repeated submission or posting limit reached. Please wait before posting again.');
  } catch { return rejection(503, 'Protection temporarily unavailable.'); }
  return null;
}
