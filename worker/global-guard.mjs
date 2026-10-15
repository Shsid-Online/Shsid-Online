import { rejection } from './abuse-protection.mjs';

// One stable object for every region and hostname. Fixed keys store no identities.
export class BoardAbuseGuard {
  constructor(state) { this.storage = state.storage; }
  async fetch(request) {
    const url = new URL(request.url);
    const kind = url.pathname.slice(1);
    if (kind === 'submission') {
      const body = await request.json();
      if (!/^[a-f0-9]{64}$/.test(body.fingerprint || '') || !/^[a-f0-9]{64}$/.test(body.client || '')) return new Response(null, { status: 400 });
      const now = Date.now();
      const allowed = await this.storage.transaction(async tx => {
        const records = await tx.get('submissions-v1') || { duplicates: {}, clients: {} };
        for (const [key, expiry] of Object.entries(records.duplicates)) if (expiry <= now) delete records.duplicates[key];
        for (const [key, value] of Object.entries(records.clients)) if (now - value.at > 86400000) delete records.clients[key];
        if (records.duplicates[body.fingerprint]) return false;
        // Bound storage even when an attacker rotates network addresses and text.
        if (Object.keys(records.duplicates).length >= 10000 || Object.keys(records.clients).length >= 10000) return false;
        const previous = records.clients[body.client];
        const tokens = previous ? Math.min(5, previous.tokens + Math.max(0, now - previous.at) * 10 / 3600000) : 5;
        if (tokens < 1) return false;
        records.clients[body.client] = { tokens: tokens - 1, at: now };
        records.duplicates[body.fingerprint] = now + 86400000;
        await tx.put({ 'submissions-v1': records });
        return true;
      });
      return allowed ? new Response(null, { status: 204 }) : rejection(429, 'Repeated submission or posting limit reached. Please wait before posting again.');
    }
    if (!['read', 'write', 'content', 'auth', 'upload'].includes(kind)) return new Response(null, { status: 400 });
    const cost = Number(url.searchParams.get('cost') || 1);
    if (!Number.isInteger(cost) || cost < 1 || cost > 101) return new Response(null, { status: 400 });
    const now = Date.now();
    const budgets = [['minute', 60000, 180], ['day', 86400000, 12000]];
    if (kind !== 'read') budgets.push(['write', 60000, 60]);
    if (kind === 'content') budgets.push(['content', 60000, 20]);
    if (kind === 'auth') budgets.push(['auth', 60000, 20]);
    if (kind === 'upload') budgets.push(['upload', 60000, 10]);
    const allowed = await this.storage.transaction(async tx => {
      const updates = {};
      // Token buckets refill continuously, including across midnight UTC. Never
      // replenish a whole day's attack budget when the database quota resets.
      const rolling = [['rolling-all-v1', 300, 500]];
      if (kind !== 'read') rolling.push(['rolling-write-v1', 60, 200]);
      if (['content', 'auth', 'upload'].includes(kind)) rolling.push([`rolling-${kind}-v1`, 20, kind === 'content' ? 30 : 120]);
      for (const [key, capacity, perHour] of rolling) {
        const previous = await tx.get(key);
        const tokens = previous ? Math.min(capacity, previous.tokens + Math.max(0, now - previous.at) * perHour / 3600000) : capacity;
        if (tokens < cost) return false;
        updates[key] = { tokens: tokens - cost, at: now };
      }
      for (const [key, period, limit] of budgets) {
        const bucket = Math.floor(now / period);
        const old = await tx.get(key);
        const count = old?.bucket === bucket ? old.count : 0;
        if (count + cost > limit) return false;
        updates[key] = { bucket, count: count + cost };
      }
      await tx.put(updates);
      return true;
    });
    return allowed ? new Response(null, { status: 204 }) : rejection(429, 'The board is receiving too much traffic. Please try again later.');
  }
}
