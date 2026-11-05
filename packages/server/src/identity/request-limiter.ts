import { IdentityError } from './errors.js';

interface Bucket {
  count: number;
  expiresAt: number;
}
type Operation = 'login' | 'register' | 'password';
const LIMITS: Record<Operation, { count: number; duration: number }> = {
  login: { count: 20, duration: 15 * 60_000 },
  register: { count: 5, duration: 60 * 60_000 },
  password: { count: 10, duration: 60 * 60_000 },
};

/** Bounded process-local rate and concurrency limits before expensive Argon2 work. */
export class AuthRequestLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private active = 0;
  private global: Bucket = { count: 0, expiresAt: 0 };

  constructor(private readonly now: () => number = Date.now) {}

  async run<T>(address: string, operation: Operation, work: () => Promise<T>): Promise<T> {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= now) this.buckets.delete(key);
    }
    if (this.global.expiresAt <= now) this.global = { count: 0, expiresAt: now + 15 * 60_000 };
    const key = `${operation}:${address}`;
    const limit = LIMITS[operation];
    let bucket = this.buckets.get(key);
    if (
      this.active >= 8 ||
      this.global.count >= 300 ||
      (bucket === undefined && this.buckets.size >= 4096) ||
      (bucket !== undefined && bucket.count >= limit.count)
    ) {
      throw new IdentityError(
        429,
        'RATE_LIMITED',
        'Too many authentication attempts. Try again later.',
      );
    }
    if (bucket === undefined) {
      bucket = { count: 0, expiresAt: now + limit.duration };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    this.global.count += 1;
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
    }
  }
}
