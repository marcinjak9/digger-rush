import { randomBytes, createHash } from 'node:crypto';

// Token bucket: `rate` tokens per second, at most `burst` stored. take() is O(1), no allocation.
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(readonly rate: number, readonly burst: number, now: number) {
    this.tokens = burst;
    this.last = now;
  }

  take(now: number): boolean {
    const dt = now - this.last;
    this.last = now;
    if (dt > 0) {
      this.tokens += dt * this.rate / 1000;
      if (this.tokens > this.burst) this.tokens = this.burst;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// Per address join limiter. In memory only: the key is a salted hash (the salt is random per process and
// never stored), and an entry disappears as soon as its window has passed.
export class JoinLimiter {
  private readonly salt = randomBytes(8);
  private readonly hits = new Map<string, { start: number; n: number }>();
  private lastSweep = 0;

  constructor(private max: number, private windowMs: number) {}

  configure(max: number, windowMs: number): void {
    this.max = max;
    this.windowMs = windowMs;
    this.hits.clear();
  }

  private key(addr: string): string {
    return createHash('sha256').update(this.salt).update(addr).digest('base64url').slice(0, 16);
  }

  // Returns false when this address has used up its joins for the current window.
  allow(addr: string, now: number): boolean {
    this.sweep(now);
    const k = this.key(addr);
    const e = this.hits.get(k);
    if (e === undefined || now - e.start >= this.windowMs) {
      this.hits.set(k, { start: now, n: 1 });
      return true;
    }
    if (e.n >= this.max) return false;
    e.n++;
    return true;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 1000 && this.hits.size < 10000) return;
    this.lastSweep = now;
    for (const [k, e] of this.hits) if (now - e.start >= this.windowMs) this.hits.delete(k);
  }

  get size(): number {
    return this.hits.size;
  }
}

// Picks the client address from the auth context. Forwarded headers count only behind a trusted proxy:
// then the last entry (appended by that proxy) is used, otherwise the socket address.
export function clientAddress(ip: string | string[] | undefined): string {
  const v = Array.isArray(ip) ? ip[ip.length - 1] : ip;
  if (typeof v !== 'string') return 'unknown';
  const parts = v.split(',');
  return parts[parts.length - 1].trim() || 'unknown';
}

// Server tick time recorder (ms) over a ring of recent ticks. No personal data.
export class TickStats {
  private readonly ring = new Float64Array(2048);
  private n = 0;
  total = 0;
  count = 0;
  max = 0;
  snapshotsSent = 0;

  record(ms: number): void {
    this.ring[this.n++ & 2047] = ms;
    this.total += ms;
    this.count++;
    if (ms > this.max) this.max = ms;
  }

  reset(): void {
    this.n = 0;
    this.total = 0;
    this.count = 0;
    this.max = 0;
    this.snapshotsSent = 0;
  }

  summary(): { ticks: number; avgMs: number; p95Ms: number; maxMs: number; snapshotsSent: number } {
    const len = Math.min(this.n, 2048);
    const a = Array.from(this.ring.subarray(0, len)).sort((x, y) => x - y);
    const p95 = len > 0 ? a[Math.min(len - 1, Math.floor(len * 0.95))] : 0;
    const r = (v: number): number => Math.round(v * 1000) / 1000;
    return {
      ticks: this.count, avgMs: r(this.count > 0 ? this.total / this.count : 0), p95Ms: r(p95), maxMs: r(this.max),
      snapshotsSent: this.snapshotsSent,
    };
  }
}

export const tickStats = new TickStats();
export const joinLimiter = new JoinLimiter(10, 60000);
