/**
 * Netlify Function: /.netlify/functions/generate-stream
 *
 * Streams Anthropic message events through Netlify instead of buffering the
 * full response. This avoids Netlify's inactivity timeout on longer draft
 * generations because bytes flow back to the browser while Claude is writing.
 */

// Models come from /models.js (single source of truth shared with the
// browser AND with generate.js). Bundled by esbuild at deploy time.
import models from '../../models.js';
const { MODELS } = models;

const ALLOWED_ORIGINS = [
  'https://wp-poster.netlify.app'
];

const MAX_PROMPT_CHARS = 20000;
const MAX_TOKENS_CAP = 3000;
const ALLOWED_MODELS = new Set(MODELS.map((m) => m.id));

function corsHeaders(origin) {
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function jsonResponse(status, origin, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign(corsHeaders(origin), {
      'Content-Type': 'application/json'
    })
  });
}

export default async function handler(request) {
  const origin = request.headers.get('origin') || '';

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: corsHeaders(origin) });
  }

  if (request.method !== 'POST') {
    return jsonResponse(405, origin, { error: 'Method not allowed' });
  }

  if (!ALLOWED_ORIGINS.includes(origin)) {
    return jsonResponse(403, origin, { error: 'Origin not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return jsonResponse(500, origin, { error: 'Server misconfigured: ANTHROPIC_API_KEY not set' });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return jsonResponse(400, origin, { error: 'Invalid JSON body' });
  }

  const { model, max_tokens, messages } = payload;

  if (!model || !ALLOWED_MODELS.has(model)) {
    return jsonResponse(400, origin, {
      error: 'Model not allowed',
      requested: model || null,
      allowed: Array.from(ALLOWED_MODELS)
    });
  }

  if (!Number.isInteger(max_tokens) || max_tokens < 1 || max_tokens > MAX_TOKENS_CAP) {
    return jsonResponse(400, origin, { error: `max_tokens must be an integer between 1 and ${MAX_TOKENS_CAP}` });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse(400, origin, { error: 'messages must be a non-empty array' });
  }

  let totalChars = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      return jsonResponse(400, origin, { error: 'invalid message format' });
    }
    if (m.role !== 'user' && m.role !== 'assistant') {
      return jsonResponse(400, origin, { error: 'message role must be user or assistant' });
    }
    if (typeof m.content !== 'string') {
      return jsonResponse(400, origin, { error: 'message content must be a string' });
    }
    totalChars += m.content.length;
  }

  if (totalChars > MAX_PROMPT_CHARS) {
    return jsonResponse(413, origin, { error: `Prompt too large (${totalChars} chars, max ${MAX_PROMPT_CHARS})` });
  }

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model, max_tokens, messages, stream: true })
  });

  if (!anthropicRes.ok) {
    const body = await anthropicRes.text();
    return new Response(body, {
      status: anthropicRes.status,
      headers: Object.assign(corsHeaders(origin), {
        'Content-Type': anthropicRes.headers.get('content-type') || 'application/json'
      })
    });
  }

  return new Response(anthropicRes.body, {
    status: 200,
    headers: Object.assign(corsHeaders(origin), {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform'
    })
  });
}
