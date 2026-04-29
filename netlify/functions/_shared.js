/*
 * _shared.js — validation + CORS helpers shared by generate.js and
 *               generate-stream.mjs.
 *
 * Netlify treats files in `netlify/functions/` whose names start with `_`
 * as helper modules, not deployable functions — so this file isn't
 * exposed at /.netlify/functions/_shared. The two real functions both
 * pull from it.
 *
 * Why this exists: validation drifted between the two functions in the
 * past (allowlist updates, MAX_TOKENS_CAP changes, error response shape).
 * One source of truth means a fix applies everywhere; no second place to
 * forget.
 *
 * Tests in tests/shared.test.js cover validateRequest end-to-end, since
 * the validator is where the security boundary lives.
 */

const { MODELS } = require('../../models.js');

const ALLOWED_ORIGINS = [
  'https://wp-poster.netlify.app'
];

const MAX_PROMPT_CHARS = 20000;
const MAX_TOKENS_CAP = 3000;
const ALLOWED_MODELS = new Set(MODELS.map((m) => m.id));

// CORS headers for an origin. Falls back to the canonical allowed origin
// if the request origin isn't on the allowlist (browsers will then refuse
// the response, which is the desired behavior).
function corsHeaders(origin) {
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function isAllowedOrigin(origin) {
  return ALLOWED_ORIGINS.includes(origin);
}

/**
 * Validate a generation request payload.
 *
 *   validateRequest({ model, max_tokens, messages })
 *     → { ok: true, model, max_tokens, messages }    on valid input
 *     → { ok: false, status, body }                  on rejection
 *
 * Body always includes a human-readable `error` string. The "Model not
 * allowed" rejection echoes the requested model and the current allowlist
 * so the browser's diagnoseError() can identify deploy skew.
 */
function validateRequest(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, status: 400, body: { error: 'Invalid JSON body' } };
  }

  const { model, max_tokens, messages } = payload;

  if (!model || !ALLOWED_MODELS.has(model)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'Model not allowed',
        requested: model || null,
        allowed: Array.from(ALLOWED_MODELS)
      }
    };
  }

  if (!Number.isInteger(max_tokens) || max_tokens < 1 || max_tokens > MAX_TOKENS_CAP) {
    return {
      ok: false,
      status: 400,
      body: { error: `max_tokens must be an integer between 1 and ${MAX_TOKENS_CAP}` }
    };
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, status: 400, body: { error: 'messages must be a non-empty array' } };
  }

  let totalChars = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      return { ok: false, status: 400, body: { error: 'invalid message format' } };
    }
    if (m.role !== 'user' && m.role !== 'assistant') {
      return { ok: false, status: 400, body: { error: 'message role must be user or assistant' } };
    }
    if (typeof m.content !== 'string') {
      return { ok: false, status: 400, body: { error: 'message content must be a string' } };
    }
    totalChars += m.content.length;
  }

  if (totalChars > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      status: 413,
      body: { error: `Prompt too large (${totalChars} chars, max ${MAX_PROMPT_CHARS})` }
    };
  }

  return { ok: true, model, max_tokens, messages };
}

module.exports = {
  ALLOWED_ORIGINS,
  ALLOWED_MODELS,
  MAX_PROMPT_CHARS,
  MAX_TOKENS_CAP,
  corsHeaders,
  isAllowedOrigin,
  validateRequest
};
