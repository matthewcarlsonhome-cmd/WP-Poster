/**
 * Netlify Function: /.netlify/functions/generate
 *
 * Proxies Claude API calls. The Anthropic API key lives in the
 * ANTHROPIC_API_KEY environment variable — never in the browser.
 *
 * Allowed models are checked against an allowlist so the browser
 * can't request unapproved or expensive models.
 */

const ALLOWED_ORIGINS = [
  'https://wp-poster.netlify.app'
];

const MAX_PROMPT_CHARS = 20000;
const MAX_TOKENS_CAP = 3000;

// Current Claude models (as of April 2026). Update this list when
// Anthropic releases new models or deprecates existing ones.
const ALLOWED_MODELS = new Set([
  'claude-haiku-4-5-20251001',   // Haiku 4.5 — $1 / $5 per MTok
  'claude-sonnet-4-6',           // Sonnet 4.6 — $3 / $15 per MTok (NO date suffix, unlike 4.5)
  'claude-opus-4-7'              // Opus 4.7 — $5 / $25 per MTok
]);

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  const baseHeaders = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: baseHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  if (!ALLOWED_ORIGINS.includes(origin)) {
    return {
      statusCode: 403,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Origin not allowed' })
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Server misconfigured: ANTHROPIC_API_KEY not set' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  const { model, max_tokens, messages } = payload;

  if (!model || !ALLOWED_MODELS.has(model)) {
    // Echo both the requested model and the server's current allowlist so
    // the browser's diagnostic layer can identify deploy skew (browser
    // sending a model that the server's older allowlist doesn't accept).
    return {
      statusCode: 400,
      headers: baseHeaders,
      body: JSON.stringify({
        error: 'Model not allowed',
        requested: model || null,
        allowed: Array.from(ALLOWED_MODELS)
      })
    };
  }

  if (!Number.isInteger(max_tokens) || max_tokens < 1 || max_tokens > MAX_TOKENS_CAP) {
    return {
      statusCode: 400,
      headers: baseHeaders,
      body: JSON.stringify({ error: `max_tokens must be an integer between 1 and ${MAX_TOKENS_CAP}` })
    };
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      statusCode: 400,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'messages must be a non-empty array' })
    };
  }

  let totalChars = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      return {
        statusCode: 400,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'invalid message format' })
      };
    }
    if (m.role !== 'user' && m.role !== 'assistant') {
      return {
        statusCode: 400,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'message role must be user or assistant' })
      };
    }
    if (typeof m.content !== 'string') {
      return {
        statusCode: 400,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'message content must be a string' })
      };
    }
    totalChars += m.content.length;
  }

  if (totalChars > MAX_PROMPT_CHARS) {
    return {
      statusCode: 413,
      headers: baseHeaders,
      body: JSON.stringify({ error: `Prompt too large (${totalChars} chars, max ${MAX_PROMPT_CHARS})` })
    };
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model, max_tokens, messages })
    });

    const body = await anthropicRes.text();

    return {
      statusCode: anthropicRes.status,
      headers: baseHeaders,
      body: body
    };
  } catch (err) {
    console.error('Anthropic request failed:', err);
    return {
      statusCode: 502,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Upstream request failed' })
    };
  }
};
