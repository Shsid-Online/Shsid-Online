// The HTTP runtime validates Content-Length against the received body. Reject
// unknown-length streams rather than allowing unbounded storage writes.
export function uploadSizeError(request, maxBytes) {
  const value = request.headers.get('content-length');
  if (!value || !/^\d+$/.test(value)) return new Response(JSON.stringify({ error: 'Upload requires a known file size. Please choose the file again.' }), { status: 411, headers: { 'Content-Type': 'application/json' } });
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > maxBytes) return new Response(JSON.stringify({ error: 'Upload is too large.' }), { status: 413, headers: { 'Content-Type': 'application/json' } });
  if (length === 0) return new Response(JSON.stringify({ error: 'Upload is empty.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  return null;
}

export async function rememberUpload(env, key, uploadId, userId) {
  await env.SESSIONS.put(`upload-owner:${uploadId}`, JSON.stringify({ key, userId }), { expirationTtl: 3600 });
}
export async function ownsUpload(env, key, uploadId, userId) {
  const record = await env.SESSIONS.get(`upload-owner:${uploadId}`, 'json');
  return !!record && record.key === key && record.userId === userId;
}
export function partSizeLimit(key, partNumber) {
  const total = (key.startsWith('verification/') ? 100 : 25) * 1024 * 1024;
  const chunk = 8 * 1024 * 1024;
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > Math.ceil(total / chunk)) return 0;
  return Math.min(chunk, total - (partNumber - 1) * chunk);
}
export function validParts(key, parts) {
  return parts.length > 0 && parts.length <= 13 && new Set(parts.map(p => p.partNumber)).size === parts.length &&
    parts.every(p => partSizeLimit(key, p.partNumber) > 0 && typeof p.etag === 'string' && p.etag.length > 0 && p.etag.length <= 256);
}
