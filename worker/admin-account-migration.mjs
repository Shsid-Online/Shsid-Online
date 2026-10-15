import { hashPassword } from './passwords.mjs';

const MARKER_KEY = 'maintenance:admin-username-migration-v1';
const TARGET_USERNAME = 'anon2221';
const INTERNAL_EMAIL_DOMAIN = 'system.local';

async function digest(value) {
  const bytes = new TextEncoder().encode(String(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function revokeUserSessions(sessions, userId) {
  let cursor;
  do {
    const page = await sessions.list({ prefix: 'session:', ...(cursor ? { cursor } : {}) });
    for (const key of page.keys || []) {
      if (await sessions.get(key.name) === userId) await sessions.delete(key.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

export async function runAdminAccountMigration(env) {
  if (await env.SESSIONS.get(MARKER_KEY)) return { status: 'complete' };

  const sourceEmail = String(env.ADMIN_ACCOUNT_MIGRATION_SOURCE || '').trim().toLowerCase();
  const password = String(env.ADMIN_ACCOUNT_MIGRATION_PASSWORD || '');
  if (!sourceEmail || !password) return { status: 'not_configured' };
  if (sourceEmail.endsWith(`@${INTERNAL_EMAIL_DOMAIN}`) || password.length < 8 || password.length > 128) {
    throw new Error('Admin migration configuration is invalid');
  }

  let user = await env.DB.prepare('select * from users where lower(email)=? limit 1').bind(sourceEmail).first();
  if (!user) {
    user = await env.DB.prepare("select * from users where lower(trim(english_name))=? and lower(email) like '%@system.local' limit 1")
      .bind(TARGET_USERNAME).first();
    if (!user) throw new Error('Admin migration source account was not found');
  }
  if (user.role !== 'admin') throw new Error('Admin migration source account is not an admin');

  const conflict = await env.DB.prepare("select id from users where id != ? and lower(trim(coalesce(english_name, ''))) = ? limit 1")
    .bind(user.id, TARGET_USERNAME).first();
  if (conflict) throw new Error('Admin migration username is already in use');

  const alreadyMigrated = String(user.email || '').toLowerCase().endsWith(`@${INTERNAL_EMAIL_DOMAIN}`)
    && String(user.english_name || '').trim().toLowerCase() === TARGET_USERNAME;
  if (!alreadyMigrated) {
    const internalEmail = `admin-${(await digest(user.id)).slice(0, 24)}@${INTERNAL_EMAIL_DOMAIN}`;
    const passwordHash = await hashPassword(password);
    const result = await env.DB.prepare("update users set email=?, english_name=?, password_hash=?, status='verified', updated_at=? where id=? and lower(email)=?")
      .bind(internalEmail, TARGET_USERNAME, passwordHash, new Date().toISOString(), user.id, sourceEmail).run();
    if (Number(result?.meta?.changes ?? result?.changes ?? 0) !== 1) throw new Error('Admin migration update was not applied');
  }

  await revokeUserSessions(env.SESSIONS, user.id);
  await env.SESSIONS.put(MARKER_KEY, JSON.stringify({ completedAt: new Date().toISOString(), userId: user.id }));
  return { status: 'migrated', userId: user.id };
}

