import { clearReadCache } from './read-cache.mjs';

// User-authorized, one-time cleanup. Exact substring matching; comments untouched.
export const CLEANUP_MARKER = 'maintenance:post-phrase-cleanup-20261014-v1';
export const CLEANUP_PHRASE = '马蜂万岁';
export async function runPostCleanup(env) {
  if (await env.SESSIONS.get(CLEANUP_MARKER)) return { skipped: true };
  const deletedAt = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE posts SET deleted_at = ?
    WHERE deleted_at IS NULL AND
    (instr(coalesce(title, ''), ?) > 0 OR instr(coalesce(text, ''), ?) > 0)`)
    .bind(deletedAt, CLEANUP_PHRASE, CLEANUP_PHRASE).run();
  if (result.success === false) throw new Error('Post cleanup did not succeed');
  clearReadCache(env.DB);
  const record = { completedAt: deletedAt, matchedPosts: Number(result.meta?.changes || 0) };
  // Do not mark complete on database failure. Repeating after a marker-write
  // failure is safe: already soft-deleted rows cannot be changed again.
  await env.SESSIONS.put(CLEANUP_MARKER, JSON.stringify(record));
  return record;
}
