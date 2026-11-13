/**
 * Counts attempts per key in windows of `windowMs` that open at a key's first
 * attempt, allowing `max` in each. Held in memory: trail runs as one process.
 */
export function windowLimiter({
  max,
  windowMs,
}: {
  max: number;
  windowMs: number;
}) {
  const windows = new Map<string, { opened: number; count: number }>();
  const open = (key: string, now: number) => {
    const w = windows.get(key);
    return w && now - w.opened < windowMs ? w : undefined;
  };
  return {
    /** Seconds until `key` has room again; 0 when it has room now. */
    wait(key: string): number {
      const now = Date.now();
      const w = open(key, now);
      if (!w || w.count < max) return 0;
      return Math.ceil((w.opened + windowMs - now) / 1000);
    },
    /** Counts one attempt for `key`. */
    take(key: string): void {
      const now = Date.now();
      const w = open(key, now);
      if (w) w.count++;
      else windows.set(key, { opened: now, count: 1 });
      if (windows.size > 10_000) {
        for (const [k, v] of windows) {
          if (now - v.opened >= windowMs) windows.delete(k);
        }
      }
    },
  };
}
