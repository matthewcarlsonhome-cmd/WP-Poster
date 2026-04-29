/*
 * recovery.js — pure helpers for sanitizing model output and recovering
 * from partial / malformed responses.
 *
 * Loaded as a plain <script> in the browser AND as a CommonJS module in
 * tests/. The UMD-ish wrapper is the only thing keeping both worlds happy
 * without a build step.
 *
 * If a function below grows a DOM, fetch, or localStorage dependency it
 * does NOT belong here — keep this file pure so the test harness in
 * tests/recovery.test.js can run it in plain Node without stubs.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    // Browser: attach each export to the global so app.js can call
    // sanitizeHtml(...) etc. as if it were defined inline.
    Object.keys(api).forEach(function (k) { root[k] = api[k]; });
  }
})(typeof self !== 'undefined' ? self : this, function () {

  /* ---------- HTML sanitizer (allowlist regex) ---------- */
  function sanitizeHtml(html) {
    if (!html) return '';
    // 1. Strip block elements with their content (script, style, iframe, etc.)
    html = html.replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
    // 2. Strip self-closing / void versions of the same tags
    html = html.replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)\b[^>]*\/?>/gi, '');
    // 3. Strip inline event handlers — on[anything]=...
    html = html.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
    html = html.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
    html = html.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '');
    // 4. Neutralize dangerous URL schemes in href/src/xlink:href attributes
    html = html.replace(/(href|src|xlink:href)\s*=\s*"(\s*(javascript|data|vbscript):[^"]*)"/gi, '$1="#"');
    html = html.replace(/(href|src|xlink:href)\s*=\s*'(\s*(javascript|data|vbscript):[^']*)'/gi, "$1='#'");
    return html;
  }

  /* ---------- HTML-attribute-safe text escape ---------- */
  function escapeText(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ---------- 3-stage JSON extractor for model responses ---------- */
  function parseJsonFromModel(raw) {
    const attempts = [];

    // Stage 1 — parse as-is. Sonnet/Opus typically land here.
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch (e1) {
      attempts.push({ stage: 'raw', error: e1.message });
    }

    // Stage 2 — strip ```json or ``` fences if the string is fence-wrapped.
    let stripped = (raw || '').trim();
    if (/^```/.test(stripped)) {
      stripped = stripped
        .replace(/^```(?:json|JSON)?\s*\n?/, '')
        .replace(/\n?```\s*$/, '')
        .trim();
      try {
        return { ok: true, value: JSON.parse(stripped) };
      } catch (e2) {
        attempts.push({ stage: 'fence-stripped', error: e2.message });
      }
    }

    // Stage 3 — extract first {...} substring (handles preamble/postamble).
    const firstBrace = stripped.indexOf('{');
    const lastBrace = stripped.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const candidate = stripped.slice(firstBrace, lastBrace + 1);
      try {
        return { ok: true, value: JSON.parse(candidate) };
      } catch (e3) {
        attempts.push({ stage: 'brace-extract', error: e3.message });
      }
    }

    return {
      ok: false,
      error: attempts.length > 0 ? attempts[attempts.length - 1].error : 'no parseable JSON found',
      attempts: attempts
    };
  }

  /* ---------- Anthropic response → plain text ---------- */
  // Two shapes:
  //   1. Non-streaming JSON: { content: [{text}, ...] }  ← legacy generate.js path
  //   2. SSE stream as a string: "event: ...\ndata: {...}\n\n..."  ← generate-stream.mjs
  // Returns the concatenated text, trimmed. Never throws.
  function extractClaudeText(data) {
    if (data && typeof data === 'object' && Array.isArray(data.content)) {
      return data.content.map(function (b) { return b.text || ''; }).join('').trim();
    }
    if (typeof data !== 'string') return '';

    let out = '';
    const events = data.split(/\n\n+/);
    events.forEach(function (eventBlock) {
      const dataLines = eventBlock.split(/\n/).filter(function (line) {
        return line.indexOf('data:') === 0;
      });
      dataLines.forEach(function (line) {
        const json = line.replace(/^data:\s*/, '').trim();
        if (!json || json === '[DONE]') return;
        try {
          const evt = JSON.parse(json);
          if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
            out += evt.delta.text || '';
          } else if (evt.type === 'content_block_start' && evt.content_block && evt.content_block.text) {
            out += evt.content_block.text;
          }
        } catch (_) {
          // Malformed event line — skip, don't throw. Real streams sometimes
          // include partial chunks across packet boundaries.
        }
      });
    });
    return out.trim();
  }

  /* ---------- last-resort recovery from truncated / malformed output ---------- */
  // Returns a {title, content, metaDescription, altTextSuggestions, seoNotes}
  // object on a best-effort recovery, or null if we can't get usable HTML.
  // Never throws.
  function fallbackPostFromRawModelText(raw, fallbackTitle) {
    const text = (raw || '').trim();
    if (!text) return null;

    // Case A: model emitted bare HTML instead of JSON.
    if (/^\s*</.test(text) && /<\/(p|h2|h3|ul|ol|blockquote)>/i.test(text)) {
      return {
        title: fallbackTitle || 'Generated post',
        content: sanitizeHtml(text),
        metaDescription: '',
        altTextSuggestions: [],
        seoNotes: 'Recovered from raw HTML because the model did not return complete JSON.'
      };
    }

    // Case B: JSON was truncated mid-content. Extract everything after
    // `"content": "` and clean up trailing garbage.
    const contentMatch = text.match(/"content"\s*:\s*"([\s\S]*)/);
    if (!contentMatch) return null;
    let content = contentMatch[1];
    content = content
      .replace(/",\s*"metaDescription"[\s\S]*$/i, '')
      .replace(/",\s*"seoNotes"[\s\S]*$/i, '')
      .replace(/",\s*"altTextSuggestions"[\s\S]*$/i, '')
      .replace(/"\s*}\s*$/i, '');
    content = content
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\\//g, '/');
    if (!/<(p|h2|h3|ul|ol|blockquote)\b/i.test(content)) return null;

    const titleMatch = text.match(/"title"\s*:\s*"([^"]{1,300})"/);
    const metaMatch = text.match(/"metaDescription"\s*:\s*"([^"]{1,300})"/);
    const seoMatch = text.match(/"seoNotes"\s*:\s*"([^"]{1,500})"/);
    return {
      title: titleMatch ? titleMatch[1] : (fallbackTitle || 'Generated post'),
      content: sanitizeHtml(content),
      metaDescription: metaMatch ? metaMatch[1] : '',
      altTextSuggestions: [],
      seoNotes: seoMatch ? seoMatch[1] : 'Recovered from incomplete JSON because the model output was cut off.'
    };
  }

  return {
    sanitizeHtml: sanitizeHtml,
    escapeText: escapeText,
    parseJsonFromModel: parseJsonFromModel,
    extractClaudeText: extractClaudeText,
    fallbackPostFromRawModelText: fallbackPostFromRawModelText
  };
});
