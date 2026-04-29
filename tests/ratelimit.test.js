/*
 * Tests for the rate-limiter's pure window evaluator.
 *
 * The Blobs read/write side of checkRateLimit() is not unit-tested
 * (would need a Blobs mock); end-to-end behavior is verified after
 * deploy. The decision logic — "given these timestamps and now, allow
 * or deny?" — is what bugs are likely to hide in, and that's pure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateWindow,
  clientIpFromHeaders,
  DEFAULT_LIMIT,
  DEFAULT_WINDOW_MS
} = require('../netlify/functions/_ratelimit.js');

const NOW = 1_700_000_000_000; // arbitrary fixed "now" so tests don't drift
const W = 60_000;              // 60s window
const LIMIT = 5;               // small limit for readable tests

/* ---------- below the limit ---------- */

test('evaluateWindow: empty list allows and adds now', () => {
  const r = evaluateWindow([], NOW, { windowMs: W, limit: LIMIT });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.fresh, [NOW]);
  assert.equal(r.remaining, LIMIT - 1);
});

test('evaluateWindow: under the limit allows', () => {
  const ts = [NOW - 30_000, NOW - 20_000, NOW - 10_000];
  const r = evaluateWindow(ts, NOW, { windowMs: W, limit: LIMIT });
  assert.equal(r.allowed, true);
  assert.equal(r.fresh.length, 4);
  assert.equal(r.remaining, 1);
});

test('evaluateWindow: drops timestamps older than window before counting', () => {
  // 6 timestamps total but 4 are older than the window — only 2 count.
  const ts = [
    NOW - 120_000, NOW - 90_000, NOW - 80_000, NOW - 70_000, // expired
    NOW - 30_000, NOW - 10_000                                // fresh
  ];
  const r = evaluateWindow(ts, NOW, { windowMs: W, limit: LIMIT });
  assert.equal(r.allowed, true);
  assert.equal(r.fresh.length, 3); // 2 fresh + the new one
  assert.equal(r.remaining, LIMIT - 3);
});

/* ---------- at and above the limit ---------- */

test('evaluateWindow: exactly at the limit denies', () => {
  const ts = [NOW - 50_000, NOW - 40_000, NOW - 30_000, NOW - 20_000, NOW - 10_000];
  const r = evaluateWindow(ts, NOW, { windowMs: W, limit: LIMIT });
  assert.equal(r.allowed, false);
  assert.equal(r.fresh.length, LIMIT); // unchanged on deny
});

test('evaluateWindow: retryAfterSec measures from earliest fresh request', () => {
  // Earliest fresh ts is NOW-50s. It falls out of the window at NOW+10s.
  const ts = [NOW - 50_000, NOW - 40_000, NOW - 30_000, NOW - 20_000, NOW - 10_000];
  const r = evaluateWindow(ts, NOW, { windowMs: W, limit: LIMIT });
  assert.equal(r.allowed, false);
  assert.equal(r.retryAfterSec, 10);
});

test('evaluateWindow: retryAfterSec is at least 1 even when nearly free', () => {
  // 5 timestamps, oldest 1ms inside the window.
  const ts = [NOW - (W - 1), NOW - 40_000, NOW - 30_000, NOW - 20_000, NOW - 10_000];
  const r = evaluateWindow(ts, NOW, { windowMs: W, limit: LIMIT });
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfterSec >= 1, 'retryAfterSec should clamp to >= 1');
});

/* ---------- malformed input ---------- */

test('evaluateWindow: ignores non-number entries', () => {
  const ts = ['junk', null, undefined, NaN, NOW - 10_000];
  const r = evaluateWindow(ts, NOW, { windowMs: W, limit: LIMIT });
  assert.equal(r.allowed, true);
  assert.equal(r.fresh.length, 2); // 1 valid + the new one
});

test('evaluateWindow: falsy timestamps array treated as empty', () => {
  for (const v of [null, undefined]) {
    const r = evaluateWindow(v, NOW, { windowMs: W, limit: LIMIT });
    assert.equal(r.allowed, true);
    assert.deepEqual(r.fresh, [NOW]);
  }
});

test('evaluateWindow: defaults to module constants when options absent', () => {
  // Just confirms the wrapper doesn't blow up — actual default values
  // (60/min over 60s) are correctness-tested implicitly elsewhere.
  const r = evaluateWindow([], NOW);
  assert.equal(r.allowed, true);
  assert.equal(r.limit, DEFAULT_LIMIT);
});

/* ---------- clientIpFromHeaders ---------- */

test('clientIpFromHeaders: prefers x-nf-client-connection-ip', () => {
  assert.equal(
    clientIpFromHeaders({ 'x-nf-client-connection-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' }),
    '1.2.3.4'
  );
});

test('clientIpFromHeaders: falls back to client-ip', () => {
  assert.equal(clientIpFromHeaders({ 'client-ip': '5.6.7.8' }), '5.6.7.8');
});

test('clientIpFromHeaders: parses first hop of x-forwarded-for', () => {
  assert.equal(
    clientIpFromHeaders({ 'x-forwarded-for': '203.0.113.1, 198.51.100.5, 10.0.0.1' }),
    '203.0.113.1'
  );
});

test('clientIpFromHeaders: works with Headers-like .get() interface', () => {
  const headers = {
    get(name) {
      return ({ 'x-nf-client-connection-ip': '4.4.4.4' })[name] || null;
    }
  };
  assert.equal(clientIpFromHeaders(headers), '4.4.4.4');
});

test('clientIpFromHeaders: returns "unknown" when no headers present', () => {
  assert.equal(clientIpFromHeaders({}), 'unknown');
  assert.equal(clientIpFromHeaders(null), 'unknown');
});
