const attempts = new WeakMap();
export const indexStatements = [
  'CREATE INDEX IF NOT EXISTS idx_posts_active_feed ON posts(sticky DESC, created_at DESC, id DESC) WHERE deleted_at IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_posts_number_lookup ON posts(post_number)',
  'CREATE INDEX IF NOT EXISTS idx_comments_active_post ON comments(post_id, created_at) WHERE deleted_at IS NULL'
];
// Apply once per isolate after D1 recovers; retries back off while quota is exhausted.
export async function ensureReadIndexes(db) {
  const existing = attempts.get(db);
  if (existing && (existing.ready || existing.retryAt > Date.now())) return existing.promise;
  const attempt = { retryAt: Date.now() + 60000, ready: false };
  attempt.promise = db.batch(indexStatements.map(sql => db.prepare(sql))).then(() => { attempt.ready = true; });
  attempts.set(db, attempt);
  return attempt.promise;
}
