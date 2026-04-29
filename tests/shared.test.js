/*
 * Tests for the shared validator used by both Netlify Functions.
 *
 * Why these cases matter: validateRequest() is the security boundary that
 * keeps the browser from asking the server to forward a request with an
 * unknown model, oversize prompt, or malformed message shape. Drift here
 * was the original reason for extracting the helper.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ALLOWED_MODELS,
  MAX_PROMPT_CHARS,
  MAX_TOKENS_CAP,
  corsHeaders,
  isAllowedOrigin,
  validateRequest
} = require('../netlify/functions/_shared.js');

const { MODELS, DEFAULT_MODEL_ID } = require('../models.js');

/* ---------- ALLOWED_MODELS sourced from models.js ---------- */

test('ALLOWED_MODELS contains every model from models.js', () => {
  MODELS.forEach((m) => {
    assert.ok(ALLOWED_MODELS.has(m.id), `missing ${m.id} from ALLOWED_MODELS`);
  });
  assert.equal(ALLOWED_MODELS.size, MODELS.length);
});

/* ---------- isAllowedOrigin ---------- */

test('isAllowedOrigin: production origin allowed', () => {
  assert.equal(isAllowedOrigin('https://wp-poster.netlify.app'), true);
});

test('isAllowedOrigin: stranger origins rejected', () => {
  assert.equal(isAllowedOrigin('https://evil.example.com'), false);
  assert.equal(isAllowedOrigin('http://wp-poster.netlify.app'), false); // protocol mismatch
  assert.equal(isAllowedOrigin(''), false);
  assert.equal(isAllowedOrigin(undefined), false);
});

/* ---------- corsHeaders ---------- */

test('corsHeaders: echoes the request origin when allowed', () => {
  const h = corsHeaders('https://wp-poster.netlify.app');
  assert.equal(h['Access-Control-Allow-Origin'], 'https://wp-poster.netlify.app');
  assert.equal(h['Vary'], 'Origin');
});

test('corsHeaders: falls back to canonical origin when stranger', () => {
  const h = corsHeaders('https://evil.example.com');
  // Browser will still refuse cross-origin response — fallback is just to
  // make sure the response shape is well-formed.
  assert.equal(h['Access-Control-Allow-Origin'], 'https://wp-poster.netlify.app');
});

/* ---------- validateRequest happy path ---------- */

test('validateRequest: valid payload passes through', () => {
  const r = validateRequest({
    model: DEFAULT_MODEL_ID,
    max_tokens: 1000,
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(r.ok, true);
  assert.equal(r.model, DEFAULT_MODEL_ID);
  assert.equal(r.max_tokens, 1000);
  assert.equal(r.messages.length, 1);
});

/* ---------- validateRequest model rejections ---------- */

test('validateRequest: missing model rejected with allowlist echo', () => {
  const r = validateRequest({ max_tokens: 100, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Model not allowed');
  assert.equal(r.body.requested, null);
  assert.ok(Array.isArray(r.body.allowed));
  assert.ok(r.body.allowed.includes(DEFAULT_MODEL_ID));
});

test('validateRequest: unknown model rejected, requested echoed', () => {
  const r = validateRequest({
    model: 'claude-fictional-9-9',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'x' }]
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.body.requested, 'claude-fictional-9-9');
});

test('validateRequest: stale dated Sonnet 4.6 ID rejected (the migration trap)', () => {
  // The README/CLAUDE.md flags this exact pattern: Sonnet 4.6 has NO date suffix.
  const r = validateRequest({
    model: 'claude-sonnet-4-6-20250929',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'x' }]
  });
  assert.equal(r.ok, false);
  assert.equal(r.body.requested, 'claude-sonnet-4-6-20250929');
});

/* ---------- validateRequest token rejections ---------- */

test('validateRequest: max_tokens missing rejected', () => {
  const r = validateRequest({
    model: DEFAULT_MODEL_ID,
    messages: [{ role: 'user', content: 'x' }]
  });
  assert.equal(r.ok, false);
  assert.match(r.body.error, /max_tokens/);
});

test('validateRequest: max_tokens over cap rejected', () => {
  const r = validateRequest({
    model: DEFAULT_MODEL_ID,
    max_tokens: MAX_TOKENS_CAP + 1,
    messages: [{ role: 'user', content: 'x' }]
  });
  assert.equal(r.ok, false);
});

test('validateRequest: max_tokens at cap allowed', () => {
  const r = validateRequest({
    model: DEFAULT_MODEL_ID,
    max_tokens: MAX_TOKENS_CAP,
    messages: [{ role: 'user', content: 'x' }]
  });
  assert.equal(r.ok, true);
});

test('validateRequest: max_tokens non-integer rejected', () => {
  const r = validateRequest({
    model: DEFAULT_MODEL_ID,
    max_tokens: 1.5,
    messages: [{ role: 'user', content: 'x' }]
  });
  assert.equal(r.ok, false);
});

test('validateRequest: max_tokens zero or negative rejected', () => {
  for (const n of [0, -1, -100]) {
    const r = validateRequest({
      model: DEFAULT_MODEL_ID,
      max_tokens: n,
      messages: [{ role: 'user', content: 'x' }]
    });
    assert.equal(r.ok, false, `expected reject for max_tokens=${n}`);
  }
});

/* ---------- validateRequest messages rejections ---------- */

test('validateRequest: missing messages rejected', () => {
  const r = validateRequest({ model: DEFAULT_MODEL_ID, max_tokens: 100 });
  assert.equal(r.ok, false);
  assert.match(r.body.error, /messages/);
});

test('validateRequest: empty messages array rejected', () => {
  const r = validateRequest({ model: DEFAULT_MODEL_ID, max_tokens: 100, messages: [] });
  assert.equal(r.ok, false);
});

test('validateRequest: bad role rejected', () => {
  const r = validateRequest({
    model: DEFAULT_MODEL_ID, max_tokens: 100,
    messages: [{ role: 'system', content: 'x' }]
  });
  assert.equal(r.ok, false);
  assert.match(r.body.error, /role/);
});

test('validateRequest: non-string content rejected', () => {
  const r = validateRequest({
    model: DEFAULT_MODEL_ID, max_tokens: 100,
    messages: [{ role: 'user', content: { not: 'a string' } }]
  });
  assert.equal(r.ok, false);
});

test('validateRequest: total prompt size cap', () => {
  const r = validateRequest({
    model: DEFAULT_MODEL_ID, max_tokens: 100,
    messages: [{ role: 'user', content: 'x'.repeat(MAX_PROMPT_CHARS + 1) }]
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
});

test('validateRequest: assistant role accepted (for multi-turn)', () => {
  const r = validateRequest({
    model: DEFAULT_MODEL_ID, max_tokens: 100,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'continue' }
    ]
  });
  assert.equal(r.ok, true);
});

test('validateRequest: null/undefined payload rejected cleanly (no throw)', () => {
  assert.equal(validateRequest(null).ok, false);
  assert.equal(validateRequest(undefined).ok, false);
  assert.equal(validateRequest('not an object').ok, false);
});
