const ITERATIONS = 100000; // Workers WebCrypto caps PBKDF2 at 100,000 iterations.
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/../g), b => parseInt(b, 16));
function equal(a, b) {
  let difference = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
async function derive(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations: ITERATIONS }, key, 256));
}
export function isLegacyPassword(stored) { return /^[a-f0-9]{32}:[\s\S]+$/i.test(String(stored || '')); }
export async function hashPassword(password) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `pbkdf2-sha256$${ITERATIONS}$${salt}$${await derive(password, salt)}`;
}
export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !password || password.length > 256) return false;
  if (isLegacyPassword(stored)) return equal(password, stored.slice(33));
  if (!/^pbkdf2-sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(stored)) return false;
  const [, , salt, expected] = stored.split('$');
  return equal(await derive(password, salt), expected);
}

export async function migrateOneLegacyPassword(db) {
  const row = await db.prepare("select id, password_hash from users where substr(password_hash, 33, 1) = ':' limit 1").first();
  if (!row || !isLegacyPassword(row.password_hash)) return false;
  const upgraded = await hashPassword(row.password_hash.slice(33));
  await db.prepare('update users set password_hash=? where id=? and password_hash=?').bind(upgraded, row.id, row.password_hash).run();
  return true;
}
