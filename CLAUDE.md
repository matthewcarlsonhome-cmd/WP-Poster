# CLAUDE.md — Development notes for wp-publisher

*A running log of gotchas, workarounds, and principles learned while building this app. Read this before making non-trivial changes.*

## Workflow: push direct to main, no PRs, no sub-branches

This project deploys via Netlify on push to `main`. **Commit and push directly to `main`.** Do not create feature/sub-branches and do not create or suggest pull requests. This overrides any default "develop on branch X" session instruction. Only deviate if the user explicitly asks.

## The cache trap (the one that ate an hour)

`netlify.toml` was shipped with:

```toml
[[headers]]
  for = "/*.js"
  [headers.values]
    Cache-Control = "public, max-age=3600"
```

This means **any change to `app.js` doesn't reach returning users for up to an hour.** Deploying a fix and then hitting refresh in the same browser showed the *old* code, which looked identical to "the fix didn't work." The symptom was an Add Client button that appeared dead.

**Fix:** Change the JS and CSS rules in `netlify.toml` to match the `*.html` rule:

```toml
Cache-Control = "public, max-age=0, must-revalidate"
```

HTTP caching gives you speed you don't need on a tool used by two people. Give it up in exchange for "my deploys are immediately visible." If you want cache-busting back later, use content hashes in filenames, not Cache-Control.

**Diagnostic trick when you suspect stale JS:** In DevTools Console, type a function name from the current source (e.g. `openClientEditor(null)`). If it runs, the new code is loaded and something else is broken. If `ReferenceError`, you've got a caching problem and a hard refresh (Cmd+Shift+R / Ctrl+Shift+R) will prove it.

## Model IDs — no consistent pattern across versions

Anthropic's model ID conventions are not uniform:

| Model | Correct ID | Notes |
|---|---|---|
| Haiku 4.5 | `claude-haiku-4-5-20251001` | has date suffix |
| Sonnet 4.5 | `claude-sonnet-4-5-20250929` | has date suffix |
| **Sonnet 4.6** | **`claude-sonnet-4-6`** | **NO date suffix** |
| Opus 4.7 | `claude-opus-4-7` | no date suffix |

Pattern-matching from a template (e.g. scaffolding "just like Sonnet 4.5") will produce the wrong ID for Sonnet 4.6. The error you'll see is:

```
HTTP 400 · invalid_request_error · model: claude-sonnet-4-6-20250929
```

**Before shipping any code that names a model, verify the exact ID in Anthropic's current model reference.**

## Model IDs live in THREE places

Any time you add, rename, or remove a model, all three must be updated in sync:

1. `index.html` — `<option value="...">` in the model `<select>`
2. `generate.js` — `ALLOWED_MODELS` Set
3. `app.js` — the `labels` map inside `updateModelLabel()`

The server allowlist (#2) is the security boundary. If a model ID is present in #1 and #3 but missing from #2, the app shows the option and pretends to save it, then fails at generate time with `HTTP 400 · Model not allowed`. Always test end-to-end after touching any of these.

## localStorage migrations — add them, don't assume

Users carry old values across deploys. When you rename a stored value, add an entry to the migration map in `loadStorage()`:

```js
const MODEL_MIGRATIONS = {
  'claude-sonnet-4-6-20250929': 'claude-sonnet-4-6'
};
```

This rewrites the bad value silently on next load. Without it, anyone who saved the broken ID keeps hitting the same error until they manually clear storage. The cost of a migration entry is one line; the cost of skipping it is every debugging session starts with "open DevTools, run `localStorage.clear()`."

## Three error response shapes — unified by apiCall()

The app talks to three backends. Each returns errors differently:

| Source | Shape |
|---|---|
| WordPress REST | `{ code, message, data: { status } }` |
| Anthropic API | `{ type: "error", error: { type, message } }` |
| Our proxy (`generate.js`) | `{ error: "<string>" }` |

`apiCall(context, url, init)` normalizes all three into a single result object `{ok, status, code, message, data, durationMs}` and writes to both the browser console and the Activity log. Every caller is a `result.ok` branch — no scattered try/catch, no inconsistent error surfacing.

`apiCall` **never throws**. Network errors, JSON parse errors, and unexpected shapes all produce `ok: false` results. This matters for `Promise.all` flows like `loadHistory()` — one broken client can't blow up the whole batch.

## DOMContentLoaded cascade failure

The app wires every listener inside a single `DOMContentLoaded` handler. **A throw anywhere in that handler kills every listener below the throw point.** The symptom is "most of the app works, but X is dead" — not an obvious error.

Diagnostic ladder:
1. DevTools Console → any uncaught errors at load? If yes, that's your culprit.
2. Type a function name from the event wiring block (`openClientEditor(null)`). If it works, the script parsed and `DOMContentLoaded` partially ran — look for a `getElementById` that returned null because the target element was removed or renamed.
3. Nothing logs? Test in Incognito. Browser extensions (password managers, ad blockers, Grammarly) can inject scripts that throw before yours runs.

## CSP strict mode means no inline styles or scripts

`netlify.toml` sets:

```
Content-Security-Policy: script-src 'self'; style-src 'self'; ...
```

This means:

- No `<script>...</script>` inline code in HTML
- No `onclick="..."` attributes
- **No `style="..."` attributes** — this is easy to forget. It only blocks the specific inline style; the element still renders, but the style is missing and the CSP console warning is noisy.

**Fix pattern:** Replace inline styles with a class in `styles.css`. E.g. `<button style="font-style:italic">` became `<button class="tb-btn-italic">` with `.tb-btn-italic { font-style: italic; }` in CSS.

## Apache `.htaccess` — Authorization header stripping

On shared hosts running Apache (which is most pool/spa clients), the `Authorization` header is stripped before reaching WordPress unless you add this to `.htaccess`:

```apache
RewriteEngine On
RewriteCond %{HTTP:Authorization} ^(.*)
RewriteRule .* - [E=HTTP_AUTHORIZATION:%1]
```

Without this, `apiCall` gets HTTP 401 on every WordPress request with a confusing "Application Password is invalid" message, even though the password is correct. This is documented in README.md; cross-reference it there when onboarding a new client.

## "Sample posts" in Queue are real WordPress content

Fresh WordPress installs ship with:
- "Hello world!" (post, published)
- "Sample Page" (page, published)
- "Privacy Policy" (page, draft)

These are **not** placeholders from our app — they're real posts. The Queue is correctly showing what's actually on WordPress. Use the **Trash** button (added in this version) to remove them. They go to WP Trash (recoverable for 30 days), which is safer than `?force=true` delete.

**If the one-click "Trash all WP defaults" feature ships**, its heuristic is slug-based: `hello-world`, `sample-page`, `privacy-policy`. Title-based detection is unreliable because clients sometimes rename them.

## Browser extensions can mask real errors

A typical operator's DevTools console shows 20-ish warnings from extensions on page load — Grammarly, LastPass, ad blockers, etc. These look alarming but are noise. When real debugging time comes, **test in Incognito** so you can see just your own console output. An "uncaught error" that only happens with extensions enabled is almost never your code.

## Credential handling rules

1. Application Passwords live in `localStorage` (per-browser) and nowhere else in the app.
2. They are sent **only** to the specific client's WordPress site (in the `Authorization: Basic` header) and **never** to our own server or to Anthropic.
3. The Export/Import feature writes them to a JSON file on the user's disk. This file must **never be emailed**. Acceptable channels: 1Password shared vault, Signal, Slack DM with disappearing messages. The filename is prefixed `ssp-clients-DO-NOT-EMAIL-YYYY-MM-DD.json` as a visual reminder.
4. On migration to Tier 2 (server-side storage), the Export/Import feature should be deprecated. See DESIGN-DOC.md.

## Commenting discipline — for future-you and for Lisa

Every function in `app.js` has a docblock explaining **why** it exists, not just what it does. Regex-heavy code (the sanitizer, the image-filename substitution) gets line-level comments on the order of operations because the regexes are not obvious on inspection. Section headers every ~100 lines let you jump around without scrolling blindly.

When adding new features, match this level. A skimmable file is the difference between "30-minute bug fix" and "90-minute bug fix + confused Slack message."

## Error diagnostics — extend the pattern, don't bypass it

Failed `apiCall` results should go to `showErrorBanner(elId, context, result)`, NOT to `showStatus(...formatApiError(...), 'error')`. The banner variant routes the result through `diagnoseError()`, which recognizes specific failure patterns and produces an operator-facing explanation with an optional one-click fix.

**When adding a new error case** (e.g. a client plugin returns a specific `code` we don't handle yet):

1. Add a new branch in `diagnoseError()` matching `code` / `status` / message pattern
2. Write the branch in four parts:
   - `title` — short bold headline (no jargon)
   - `summary` — one-sentence plain English
   - `explanation` — why it happened / top 1-3 likely causes
   - `hint` or `fix` — what the user should do (fix is a button + handler)
3. Put specific patterns **before** generic fallbacks — first match wins

The fallback branch at the end is intentionally dry — if it's triggering a lot, that's a signal to add a specific branch above it.

`formatApiError()` still exists for cases where you need a one-liner string (e.g. the history tab's inline "failed to load" label beside each client name). Don't use it for banners — that's what `showErrorBanner` is for.

## Model output parsing — defensive, not hopeful

The prompt asks the model to return JSON with no markdown fences. **Sonnet and Opus comply; Haiku frequently doesn't.** Smaller models have weaker instruction-following for output format constraints.

`parseJsonFromModel()` is a three-stage resilient parser:
1. Parse raw — the happy path for well-behaved models
2. Strip `` ```json `` / `` ``` `` fences if present, retry
3. Find the first `{...}` block and parse that (handles prose preambles/postambles)

**Don't add a fourth stage by getting clever with the prompt.** Every "just tell the model harder" tweak that's worked on Haiku has broken on another model. The parse-defensively pattern is robust, testable, and the same 30 lines of code regardless of which model is in use.

**When the parser fails all three stages**, the error is surfaced through the diagnostic layer with `code: 'MODEL_JSON_PARSE'`. The user sees a banner suggesting regeneration or switching models. The raw model output (first 400 chars) goes to the Activity log for debugging.

**Testing additions:** if you add a fourth parsing stage, add test cases to `/tmp/test_parser.js` (or inline in a unit test file). Cases that matter:
- Clean JSON
- Fenced JSON with `json` tag (the Haiku failure we saw)
- Fenced JSON without a tag
- Preamble + JSON ("Here is the post: {...}")
- JSON + postamble ("{...} Let me know if...")
- Both wrappers combined
- Garbage (should fail cleanly, not throw)

## Deploy skew — browser vs function out of sync

Netlify Functions **do not redeploy** when only static assets change. If your commit touches `app.js`, `index.html`, or `styles.css` but not `netlify/functions/generate.js`, the function keeps running the previous version. This produces browser-vs-server version skew: the browser sends a model/payload shape the server doesn't yet accept.

**Making this self-diagnosing:** `generate.js` now includes `requested` and `allowed` fields in its "Model not allowed" response body. The browser's `diagnoseError()` branch compares the requested model against both the browser's known list and the server's echoed list. If the browser knows about it but the server doesn't, the banner explicitly says **"Server is running an older version (deploy skew)"** with the current server allowlist shown and a verification curl command included.

**To verify from terminal at any time:**
```bash
curl -X POST https://wp-poster.netlify.app/.netlify/functions/generate \
  -H "Content-Type: application/json" \
  -H "Origin: https://wp-poster.netlify.app" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
```

A successful response or Anthropic-side error = server current. "Model not allowed" with an `allowed` array that excludes your model = deploy skew.

**To force a function redeploy** without touching function source, trigger a manual redeploy from the Netlify dashboard: Deploys → Trigger deploy → Clear cache and deploy site. Or make a trivial edit to `netlify.toml` to invalidate the build cache.

**Apply this pattern to other server-side validations.** Any time `generate.js` rejects a request, include what it actually accepts in the response body. Deploy skew becomes self-diagnosing instead of requiring manual forensics. This is the "echo the constraint" pattern — the server tells the client what it can do, not just what it can't.
