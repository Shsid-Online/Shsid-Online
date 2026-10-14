import { rejection } from './abuse-protection.mjs';

// One stable object for every region and hostname. Fixed keys store no identities.
export class BoardAbuseGuard {
  constructor(state) { this.storage = state.storage; }
  async fetch(request) {
    const url = new URL(request.url);
    const kind = url.pathname.slice(1);
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
      if (['content', 'auth', 'upload'].includes(kind)) rolling.push([`rolling-${kind}-v1`, 20, 120]);
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
