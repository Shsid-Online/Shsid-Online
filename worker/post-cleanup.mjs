import { clearReadCache } from './read-cache.mjs';

// User-authorized, one-time cleanup. Posts only; comments remain untouched.
export const CLEANUP_MARKER = 'maintenance:post-spam-cleanup-20261015-v5';
export const CLEANUP_PHRASE = '马校长万岁';
export async function runPostCleanup(env) {
  if (await env.SESSIONS.get(CLEANUP_MARKER)) return { skipped: true };
  const deletedAt = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE posts SET deleted_at = ?
    WHERE deleted_at IS NULL AND
    (instr(coalesce(title, ''), ?) > 0 OR instr(coalesce(text, ''), ?) > 0 OR
      (lower(trim(coalesce(title, ''))) = 'gay' AND trim(coalesce(text, '')) = '') OR
      (lower(trim(coalesce(text, ''))) = 'gay' AND
        (trim(coalesce(title, '')) = '' OR lower(trim(title)) = 'gay' OR
          (lower(trim(title)) GLOB 'gay #[0-9]*' AND substr(trim(title), 6) NOT GLOB '*[^0-9]*'))) OR
      lower(trim(coalesce(text, ''))) = 'automated spam poc — delete me' OR
      lower(trim(coalesce(text, ''))) = 'sniped by 张永臻，u l guys s my dik' OR
      (lower(trim(coalesce(text, ''))) = 'fuck you ur hacked' AND
       (lower(trim(title)) = 'you are hacked' OR
        (lower(trim(title)) GLOB 'you are hacked #[0-9]*' AND substr(trim(title), 17) NOT GLOB '*[^0-9]*'))) OR
      (instr(lower(trim(coalesce(text, ''))), 'stress 20261014-144037-fb97ba53 #') = 1
       AND substr(trim(text), -length('please ignore, will delete')) = 'please ignore, will delete'))`)
    .bind(deletedAt, CLEANUP_PHRASE, CLEANUP_PHRASE).run();
  if (result.success === false) throw new Error('Post cleanup did not succeed');
  clearReadCache(env.DB);
  const record = { completedAt: deletedAt, matchedPosts: Number(result.meta?.changes || 0) };
  // Do not mark complete on database failure. Repeating after a marker-write
  // failure is safe: already soft-deleted rows cannot be changed again.
  await env.SESSIONS.put(CLEANUP_MARKER, JSON.stringify(record));
  return record;
}
