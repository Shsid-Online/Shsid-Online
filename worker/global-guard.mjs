import { rejection } from './abuse-protection.mjs';

// One stable object for every region and hostname. Fixed keys store no identities.
export class BoardAbuseGuard {
  constructor(state) { this.storage = state.storage; }
  async fetch(request) {
    const kind = new URL(request.url).pathname.slice(1);
    if (!['read', 'write', 'content'].includes(kind)) return new Response(null, { status: 400 });
    const now = Date.now();
    const budgets = [['minute', 60000, 180], ['day', 86400000, 12000]];
    if (kind !== 'read') budgets.push(['write', 60000, 60]);
    if (kind === 'content') budgets.push(['content', 60000, 20]);
    const allowed = await this.storage.transaction(async tx => {
      const updates = {};
      for (const [key, period, limit] of budgets) {
        const bucket = Math.floor(now / period);
        const old = await tx.get(key);
        const count = old?.bucket === bucket ? old.count : 0;
        if (count >= limit) return false;
        updates[key] = { bucket, count: count + 1 };
      }
      await tx.put(updates);
      return true;
    });
    return allowed ? new Response(null, { status: 204 }) : rejection(429, 'The board is receiving too much traffic. Please try again later.');
  }
}
