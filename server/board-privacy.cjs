// Apply at the API boundary, including mutations, so hidden UI fields cannot leak identity.
function privateBoardItem(item, viewer) {
  const safe = { ...item };
  delete safe.ownerTokenDigest;
  delete safe.owner_token_digest;
  if (safe.anonymous && viewer?.role !== 'admin') {
    delete safe.authorId;
    delete safe.adminAnonymousAccountNumber;
  }
  for (const field of ['likes', 'hearts', 'savedBy']) {
    if (Array.isArray(safe[field])) {
      // Preserve existing count/has-liked UI without disclosing other account IDs.
      safe[field] = safe[field].map(id => viewer?.id && id === viewer.id ? id : 'anonymous');
    }
  }
  if (Array.isArray(safe.media)) safe.media = safe.media.filter(item => safeMediaUrl(item.url)).map(item => ({ ...item, name: 'Attachment' }));
  return safe;
}
function safeMediaUrl(value) {
  try {
    const url = new URL(String(value), 'https://www.shsid.online');
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password &&
      ['www.shsid.online', 'shsid.online', 'localhost', '127.0.0.1'].includes(url.hostname) &&
      decodeURIComponent(url.pathname).startsWith('/api/media/uploads/');
  } catch { return false; }
}
function uploadExtension(type) {
  return ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'application/pdf': '.pdf' })[type] || '.bin';
}
module.exports = { privateBoardItem, safeMediaUrl, uploadExtension };
