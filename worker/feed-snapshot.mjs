async function signature(secret, stamp) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const value = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`feed:${stamp}`));
  return Array.from(new Uint8Array(value), b => b.toString(16).padStart(2, '0')).join('');
}
export async function feedSnapshot(raw, secret, time = Date.now()) {
  if (!secret) throw new Error('Snapshot signing unavailable');
  if (!raw) {
    const stamp = String(Math.floor(time / 5000) * 5000);
    return { before: new Date(Number(stamp)).toISOString(), token: `${stamp}.${await signature(secret, stamp)}` };
  }
  const [stamp, mac, extra] = String(raw).split('.');
  if (extra || !/^\d{13}$/.test(stamp) || !/^[a-f0-9]{64}$/.test(mac || '') || Number(stamp) > time || time - Number(stamp) > 86400000) return null;
  const expected = await signature(secret, stamp);
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ mac.charCodeAt(i);
  return mismatch ? null : { before: new Date(Number(stamp)).toISOString(), token: raw };
}
