-- Additive and safe to run again; no posts or comments are removed.
CREATE INDEX IF NOT EXISTS idx_posts_active_feed ON posts(sticky DESC, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_posts_number_lookup ON posts(post_number);
CREATE INDEX IF NOT EXISTS idx_comments_active_post ON comments(post_id, created_at) WHERE deleted_at IS NULL;
