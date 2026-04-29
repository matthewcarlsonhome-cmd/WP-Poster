/*
 * _ratelimit.js — per-IP sliding-window rate limiter for the generation
 *                  Netlify Functions.
 *
 * Why this exists: the browser's WordPress Application Password and the
 * server's Anthropic key both have spend exposure. With Batch (15× per
 * click) and Campaign (N× per click) shipping, a compromised browser or
 * accidental loop could burn through quota in seconds. We don't have a
 * full WAF — this helper is the cheap-but-effective backstop.
 *
 * Design:
 *   evaluateWindow() is a pure function — given a list of past request
 *   timestamps, it decides whether the current request is within the
 *   limit. Tested in tests/ratelimit.test.js.
 *
 *   checkRateLimit() is the thin async wrapper that reads/writes a
 *   Netlify Blobs store. Not unit-tested (would need a Blobs mock); end-
 *   to-end behavior is verified after deploy.
 *
 * Fail-open policy: if the Blobs store is unreachable, we LET THE REQUEST
 * THROUGH. Rationale: a Blobs outage is internal Netlify infrastructure
 * the client cannot induce. Failing closed would punish legitimate
 * operators during a Netlify outage; the whole point of the limiter is
 * to bound abuse, not to be a single point of failure.
 *
 * Configuration:
 *   RATE_LIMIT_PER_MINUTE   env var, default 60. Per-IP. Applies to both
 *                           generate.js and generate-stream.mjs combined.
 *   RATE_LIMIT_WINDOW_MS    env var, default 60_000. The sliding window.
 */

const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_MS = 60 * 1000;

/**
 * Decide whether the current request is within the rate-limit window.
 *
 *   evaluateWindow(timestamps, nowMs, { windowMs, limit })
 *     timestamps: array of past request timestamps (ms epoch), oldest first
 *     nowMs: current time
 *     options: windowMs (sliding window length), limit (max requests in window)
 *
 *   Returns:
 *     { allowed: true,  fresh: <updated timestamps incl. now>, remaining }
 *     { allowed: false, fresh: <timestamps unchanged>, retryAfterSec }
 *
 * Pure. No I/O. Safe to test directly.
 */
function evaluateWindow(timestamps, nowMs, options) {
  const limit = (options && options.limit) || DEFAULT_LIMIT;
  const windowMs = (options && options.windowMs) || DEFAULT_WINDOW_MS;
  const cutoff = nowMs - windowMs;

  const fresh = (timestamps || []).filter(function (t) {
    return typeof t === 'number' && t > cutoff;
  });

  if (fresh.length >= limit) {
    // Earliest fresh request will fall out of the window at fresh[0] + windowMs.
    const retryAfterSec = Math.max(1, Math.ceil((fresh[0] + windowMs - nowMs) / 1000));
    return { allowed: false, fresh: fresh, retryAfterSec: retryAfterSec, limit: limit };
  }

  fresh.push(nowMs);
  return { allowed: true, fresh: fresh, remaining: limit - fresh.length, limit: limit };
}

/**
 * Look up an IP's recent request timestamps in Blobs, evaluate, and write
 * back the updated list. Returns the same shape as evaluateWindow plus a
 * `key` field for logging.
 *
 * Concurrent invocations from the same IP can race: both read N
 * timestamps, both write N+1, end up under-counting by one. Acceptable
 * at our scale (1-2 operators, generation requests are seconds apart).
 */
async function checkRateLimit(ipKey) {
  const limit = parseInt(process.env.RATE_LIMIT_PER_MINUTE || DEFAULT_LIMIT, 10);
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || DEFAULT_WINDOW_MS, 10);

  let store;
  try {
    // Lazy-require so the module loads in environments without the SDK
    // (e.g. local Node tests just exercising evaluateWindow).
    const { getStore } = require('@netlify/blobs');
    store = getStore('rate-limits');
  } catch (e) {
    console.warn('Rate-limit: @netlify/blobs unavailable, failing open:', e.message);
    return { allowed: true, fresh: [Date.now()], remaining: limit - 1, limit: limit, key: ipKey };
  }

  const key = 'rl:' + ipKey;
  const now = Date.now();

  let timestamps = [];
  try {
    const raw = await store.get(key);
    if (raw) timestamps = JSON.parse(raw);
    if (!Array.isArray(timestamps)) timestamps = [];
  } catch (e) {
    console.warn('Rate-limit: read failed, failing open:', e.message);
    return { allowed: true, fresh: [now], remaining: limit - 1, limit: limit, key: ipKey };
  }

  const verdict = evaluateWindow(timestamps, now, { windowMs: windowMs, limit: limit });

  if (verdict.allowed) {
    try {
      await store.set(key, JSON.stringify(verdict.fresh));
    } catch (e) {
      // Write failed but we already decided to allow — log and proceed.
      console.warn('Rate-limit: write failed, allowing anyway:', e.message);
    }
  }

  return Object.assign({}, verdict, { key: ipKey });
}

/**
 * Pull a stable client IP from request/event headers. Netlify's documented
 * header is x-nf-client-connection-ip. Falls back to client-ip and the
 * first hop of x-forwarded-for for non-Netlify dev environments. Returns
 * a non-empty string; uses 'unknown' if no header is set so we still rate-
 * limit anonymous traffic as a single bucket.
 */
function clientIpFromHeaders(headers) {
  const get = function (name) {
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(name) || '';
    return headers[name] || headers[name.toLowerCase()] || '';
  };
  const direct = get('x-nf-client-connection-ip') || get('client-ip');
  if (direct) return String(direct).trim();
  const xff = get('x-forwarded-for');
  if (xff) return String(xff).split(',')[0].trim();
  return 'unknown';
}

module.exports = {
  evaluateWindow: evaluateWindow,
  checkRateLimit: checkRateLimit,
  clientIpFromHeaders: clientIpFromHeaders,
  DEFAULT_LIMIT: DEFAULT_LIMIT,
  DEFAULT_WINDOW_MS: DEFAULT_WINDOW_MS
};
