// Rate limiting. Locally a simple in-memory counter; on Amplify requests land on many short-lived
// instances, so counts live in DynamoDB (atomic increment per time window, rows expire on their own).
export function createMemoryLimiter() {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 86400_000)) hits.delete(k); }, 600_000).unref();
  return {
    async hit(key, max, windowMs) {
      const now = Date.now();
      const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
      list.push(now);
      hits.set(key, list);
      return list.length > max;
    },
  };
}

export function createTableLimiter(table, log = console.error) {
  return {
    // Fixed windows: simple and cheap (one write per check). Returns true when the limit is exceeded.
    async hit(key, max, windowMs) {
      const bucket = Math.floor(Date.now() / windowMs);
      try {
        const n = await table.incr(`L#${key}`, `W${windowMs}#${bucket}`, Math.floor(((bucket + 1) * windowMs) / 1000) + 3600);
        return n > max;
      } catch (e) {
        log("rate limiter unavailable, letting the request through:", String(e && e.message || e)); // don't take the app down with it
        return false;
      }
    },
  };
}
