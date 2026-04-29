/**
 * Netlify Function: /.netlify/functions/generate
 *
 * Legacy buffered Anthropic proxy. The current browser uses
 * /.netlify/functions/generate-stream instead because long Batch/Campaign
 * generations could exceed Netlify's inactivity timeout while waiting for
 * the full buffered response.
 *
 * Kept around as a fallback contract — same validation, same allowlist,
 * via _shared.js. If you are touching this file, also touch
 * generate-stream.mjs and verify both deploy together.
 */

const { corsHeaders, isAllowedOrigin, validateRequest } = require('./_shared.js');

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const baseHeaders = Object.assign({}, corsHeaders(origin), {
    'Content-Type': 'application/json'
  });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: baseHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return reply(405, baseHeaders, { error: 'Method not allowed' });
  }

  if (!isAllowedOrigin(origin)) {
    return reply(403, baseHeaders, { error: 'Origin not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return reply(500, baseHeaders, { error: 'Server misconfigured: ANTHROPIC_API_KEY not set' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (_) {
    return reply(400, baseHeaders, { error: 'Invalid JSON body' });
  }

  const v = validateRequest(payload);
  if (!v.ok) return reply(v.status, baseHeaders, v.body);

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: v.model, max_tokens: v.max_tokens, messages: v.messages })
    });
    const body = await anthropicRes.text();
    return { statusCode: anthropicRes.status, headers: baseHeaders, body: body };
  } catch (err) {
    console.error('Anthropic request failed:', err);
    return reply(502, baseHeaders, { error: 'Upstream request failed' });
  }
};

function reply(statusCode, headers, bodyObj) {
  return { statusCode, headers, body: JSON.stringify(bodyObj) };
}
