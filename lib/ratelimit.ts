import { RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS } from "./limits";

/**
 * In-memory per-IP rate limiter.
 *
 * NOTE: This is an in-memory implementation. On serverless platforms like Vercel,
 * lambdas are ephemeral and distributed across multiple instances/regions, so this
 * in-memory rate limiting is best-effort. It effectively guards against rapid-fire bursts
 * hitting the same container instance.
 */

interface RateLimitRecord {
  timestamps: number[];
}

const ipRequestMap = new Map<string, RateLimitRecord>();

// Cleanup stale records periodically to avoid memory leaks
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000;
let lastCleanup = Date.now();

function cleanupStaleEntries(now: number) {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  for (const [ip, record] of ipRequestMap.entries()) {
    const validTimestamps = record.timestamps.filter((ts) => ts > windowStart);
    if (validTimestamps.length === 0) {
      ipRequestMap.delete(ip);
    } else {
      record.timestamps = validTimestamps;
    }
  }
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export function checkRateLimit(clientIp: string): RateLimitResult {
  const now = Date.now();
  cleanupStaleEntries(now);

  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  let record = ipRequestMap.get(clientIp);

  if (!record) {
    record = { timestamps: [] };
    ipRequestMap.set(clientIp, record);
  }

  // Filter timestamps to current sliding window
  record.timestamps = record.timestamps.filter((ts) => ts > windowStart);

  if (record.timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    // Oldest timestamp in window determines when the next slot frees up
    const oldest = record.timestamps[0];
    const retryAfterMs = Math.max(0, oldest + RATE_LIMIT_WINDOW_MS - now);
    const retryAfterSeconds = Math.ceil(retryAfterMs / 1000) || 1;

    return {
      allowed: false,
      retryAfterSeconds,
    };
  }

  record.timestamps.push(now);
  return { allowed: true };
}
