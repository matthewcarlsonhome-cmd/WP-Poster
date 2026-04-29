/**
 * Netlify Function: /.netlify/functions/generate-stream
 *
 * Streams Anthropic message events through Netlify instead of buffering the
 * full response. This avoids Netlify's inactivity timeout on longer draft
 * generations because bytes flow back to the browser while Claude is writing.
 *
 * Validation + CORS live in _shared.js so this function and generate.js can
 * never drift on their allowlist or payload caps.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { corsHeaders, isAllowedOrigin, validateRequest } = require('./_shared.js');
const { checkRateLimit, clientIpFromHeaders } = require('./_ratelimit.js');

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

  if (!isAllowedOrigin(origin)) {
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

  const v = validateRequest(payload);
  if (!v.ok) return jsonResponse(v.status, origin, v.body);

  // Rate-limit BEFORE forwarding to Anthropic so abuse can't burn quota.
  const ip = clientIpFromHeaders(request.headers);
  const rl = await checkRateLimit(ip);
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({
        error: 'Rate limit exceeded',
        retryAfterSec: rl.retryAfterSec,
        limitPerMinute: rl.limit
      }),
      {
        status: 429,
        headers: Object.assign(corsHeaders(origin), {
          'Content-Type': 'application/json',
          'Retry-After': String(rl.retryAfterSec)
        })
      }
    );
  }

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: v.model, max_tokens: v.max_tokens, messages: v.messages, stream: true })
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
