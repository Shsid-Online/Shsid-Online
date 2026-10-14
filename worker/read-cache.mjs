const databases = new WeakMap();
// Cache raw database rows only, never viewer-specific JSON or permissions.
export function clearReadCache(db) { databases.delete(db); }
export async function cachedRead(db, key, read) {
  let entries = databases.get(db);
  if (!entries) { entries = new Map(); databases.set(db, entries); }
  const cached = entries.get(key);
  if (cached && cached.expires > Date.now()) return structuredClone(await cached.promise);
  if (entries.size >= 128) entries.delete(entries.keys().next().value);
  const entry = { expires: Date.now() + 5000, promise: Promise.resolve().then(read) };
  entries.set(key, entry);
  try { return structuredClone(await entry.promise); }
  catch (error) { if (entries.get(key) === entry) entries.delete(key); throw error; }
}
