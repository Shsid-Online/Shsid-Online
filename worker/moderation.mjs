const schemas = new WeakMap();
export async function ensureModerationSchema(db) {
  const previous = schemas.get(db);
  if (previous && (previous.ready || previous.retryAt > Date.now())) return previous.promise;
  const state = { ready: false, retryAt: Date.now() + 60000 };
  state.promise = (async () => {
    await db.prepare('CREATE TABLE IF NOT EXISTS board_moderators (user_id TEXT PRIMARY KEY REFERENCES users(id), created_at TEXT NOT NULL)').run();
    await db.prepare('CREATE TABLE IF NOT EXISTS hidden_board_posts (post_id TEXT PRIMARY KEY REFERENCES posts(id), hidden_at TEXT NOT NULL, hidden_by TEXT NOT NULL REFERENCES users(id))').run();
    state.ready = true;
  })();
  schemas.set(db, state);
  return state.promise;
}

export async function withModeratorRole(env, user) {
  if (!user || user.role === 'admin' || user.role === 'moderator') return user;
  await ensureModerationSchema(env.DB);
  const membership = await env.DB.prepare('SELECT user_id FROM board_moderators WHERE user_id=?').bind(user.id).first();
  return membership?.user_id === user.id ? { ...user, role: 'moderator' } : user;
}

export async function hiddenPost(env, postId) {
  await ensureModerationSchema(env.DB);
  return env.DB.prepare('SELECT hidden_at, hidden_by FROM hidden_board_posts WHERE post_id=?').bind(postId).first();
}

// One-shot deployment provisioning. Only a password hash is supplied as a
// Worker secret. Never promote or reset an existing account by its username.
export async function provisionModerator(env) {
  if (!env.MODERATOR_SETUP) return;
  const config = JSON.parse(env.MODERATOR_SETUP);
  if (!/^usr_[a-zA-Z0-9-]+$/.test(config.id || '') || !/^[a-zA-Z0-9_]{3,32}$/.test(config.username || '') ||
    !/^pbkdf2-sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(config.passwordHash || '')) throw new Error('Invalid moderator setup');
  const marker = `maintenance:moderator:${config.id}`;
  if (await env.SESSIONS.get(marker)) return;
  await ensureModerationSchema(env.DB);
  const existing = await env.DB.prepare("SELECT id FROM users WHERE lower(trim(english_name))=lower(?) AND id!=?").bind(config.username, config.id).first();
  if (existing) throw new Error('Moderator username is already in use');
  const existingId = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(config.id).first();
  if (existingId) {
    const membership = await env.DB.prepare('SELECT user_id FROM board_moderators WHERE user_id=?').bind(config.id).first();
    if (!membership || existingId.email !== `${config.id}@system.local` || existingId.english_name !== config.username || existingId.password_hash !== config.passwordHash || existingId.role !== 'student') {
      throw new Error('Moderator account already exists; setup will not alter it');
    }
    await env.SESSIONS.put(marker, JSON.stringify({ username: config.username, completedAt: new Date().toISOString() }));
    return;
  }
  const time = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id,email,password_hash,role,status,english_name,chinese_name,bio,created_at,updated_at) VALUES (?,?,?,'student','verified',?,'','',?,?)")
      .bind(config.id, `${config.id}@system.local`, config.passwordHash, config.username, time, time),
    env.DB.prepare('INSERT INTO board_moderators (user_id,created_at) VALUES (?,?)').bind(config.id, time)
  ]);
  await env.SESSIONS.put(marker, JSON.stringify({ username: config.username, completedAt: time }));
}
