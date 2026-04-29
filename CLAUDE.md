# CLAUDE.md — Development notes for wp-publisher

*A running log of gotchas, workarounds, and principles learned while building this app. Read this before making non-trivial changes.*

## Workflow: push direct, no PRs

This project deploys via Netlify on push. **Do not create or suggest pull requests.** The user pushes directly to the deploy branch for fast iteration. Only open a PR if the user explicitly asks for one.

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

## Model IDs live in ONE place — `/models.js`

Used to live in five (HTML options, two function allowlists, two label maps in app.js). It's now the single source of truth at `/models.js`:

- The browser loads it via `<script src="models.js">` ahead of `app.js`. `populateModelSelect()` builds the `<option>` list at boot. `updateModelLabel()` and `diagnoseError()` look up labels via `modelLabel(id)`.
- Both Netlify Functions pull `MODELS` via `require('../../models.js')` — `_shared.js` builds the `ALLOWED_MODELS` Set from it, and esbuild bundles the file into the function deploy.

To add or rename a model: edit `/models.js`, deploy. **No drift possible.** The schema per model is `{ id, label, uiNote, inputCostPerMtok, outputCostPerMtok }` — see the file's docblock.

Note on Anthropic ID conventions: Sonnet 4.6 has NO date suffix; Sonnet 4.5 and Haiku 4.5 do. Don't pattern-match — verify against Anthropic's current model reference before adding.

## Current product modes — keep the mental models separate

The app now has three authoring surfaces. Do not collapse them into one generic "bulk" feature; they solve different operator jobs.

| Mode | Job | Scope | Publish options |
|---|---|---|---|
| Brief / Draft | One post for the active client | One client, one topic | Draft, Pending, Future, Publish |
| Batch | Many topics for the active client | One client, up to 15 rows | Draft or Pending only |
| Campaign | One shared topic localized across clients | Many clients, one row per client | Draft or Pending only |

Single-post Brief now includes optional **Keywords** and **Target area/location** fields. These are sent as SEO/local context in the prompt, not stored as separate persisted draft state.

Batch is for a monthly editorial calendar for one client. Campaign is for "benefits of relaxing in hot tubs" across Houston, Miami, etc. Keep their data models, UI labels, and safeguards distinct.

## localStorage migrations — add them, don't assume

Users carry old values across deploys. When you rename a stored value, add an entry to the migration map in `loadStorage()`:

```js
const MODEL_MIGRATIONS = {
  'claude-sonnet-4-6-20250929': 'claude-sonnet-4-6'
};
```

This rewrites the bad value silently on next load. Without it, anyone who saved the broken ID keeps hitting the same error until they manually clear storage. The cost of a migration entry is one line; the cost of skipping it is every debugging session starts with "open DevTools, run `localStorage.clear()`."

Batch queues use a separate versioned key: `wp-publisher-batch-queue-v1`. If the batch row schema changes, add a new key (`-v2`) or a normalizer that preserves old rows. Do not silently drop generated posts; operators may have unsent work saved there.

On load, any batch row left in `generating` or `publishing` is marked `error` with `INTERRUPTED`. This is deliberate: a publish request may have succeeded in WordPress even if the browser never received the response, so automatic retry could create duplicates.

Campaign queues use `wp-publisher-campaign-v1`. The same rule applies: preserve rows when changing schema. Campaign rows reference existing client profiles by `clientId`; they do **not** copy WordPress credentials into the campaign queue.

## Three error response shapes — unified by apiCall()

The app talks to three backends. Each returns errors differently:

| Source | Shape |
|---|---|
| WordPress REST | `{ code, message, data: { status } }` |
| Anthropic API | `{ type: "error", error: { type, message } }` |
| Our proxy (`generate-stream.mjs` / `generate.js`) | `{ error: "<string>" }` |

`apiCall(context, url, init)` normalizes all three into a single result object `{ok, status, code, message, data, durationMs}` and writes to both the browser console and the Activity log. Every caller is a `result.ok` branch — no scattered try/catch, no inconsistent error surfacing.

`apiCall` **never throws**. Network errors, JSON parse errors, and unexpected shapes all produce `ok: false` results. This matters for `Promise.all` flows like `loadHistory()` — one broken client can't blow up the whole batch.

## Per-IP rate limit on generation — `_ratelimit.js`

Both Netlify Functions go through `netlify/functions/_ratelimit.js` before forwarding to Anthropic. Sliding window, default **60 requests per minute per client IP**, stored in Netlify Blobs (`rate-limits` store, key `rl:<ip>`).

Configurable via env vars (Netlify → Site settings → Environment variables):

- `RATE_LIMIT_PER_MINUTE` — default 60. If a legitimate batch run hits this regularly, raise it.
- `RATE_LIMIT_WINDOW_MS` — default 60000. Probably leave alone.

When the limit trips, the function returns HTTP 429 with `{ error: "Rate limit exceeded", retryAfterSec, limitPerMinute }` plus a `Retry-After` header. The browser's `diagnoseError()` distinguishes this from Anthropic's own 429 and shows a banner naming the actual wait time.

**Fail-open policy:** if Netlify Blobs is unreachable, the limiter logs and lets the request through. Rationale: a Blobs outage is internal Netlify infrastructure the client can't induce, and failing closed would punish legitimate operators during a Netlify incident. The limiter is the cheap-but-effective backstop, not a single point of failure.

The pure decision logic lives in `evaluateWindow()` and is unit-tested in `tests/ratelimit.test.js`. The Blobs read/write side is verified end-to-end after deploy.

## Validation lives in `_shared.js` — both functions go through it

Origin allowlist, model allowlist, and payload validation (max_tokens, message shape, prompt size) all live in `netlify/functions/_shared.js`. Both `generate.js` and `generate-stream.mjs` route their request through `validateRequest(payload)` and use `corsHeaders(origin)` for response headers. Drift between the two functions is now mechanically impossible.

Files starting with `_` in `netlify/functions/` are skipped by Netlify's function discovery, so `_shared.js` and `_ratelimit.js` are helpers, not deployable functions.

Tests in `tests/shared.test.js` pin the contract for the validator end-to-end (model allowlist, max_tokens cap, message shape, prompt size cap).

## Generation proxy — use streaming, not buffered responses

The app now points `GENERATE_ENDPOINT` at:

```js
const GENERATE_ENDPOINT = '/.netlify/functions/generate-stream';
```

Do not switch it back to `/.netlify/functions/generate` unless you are deliberately testing the legacy buffered function. The buffered function caused real production failures:

```text
HTTP 504 Inactivity Timeout
Description: Too much time has passed without sending any data for document.
durationMs: ~30900
```

Root cause: the old proxy waited for the full Anthropic response before sending anything to the browser. Long Batch/Campaign generations could take more than Netlify's quiet-time window, so Netlify killed the function even though Claude was still working.

Fix: `netlify/functions/generate-stream.mjs` calls Anthropic with `stream: true` and returns the upstream `text/event-stream` body directly. The browser then reconstructs Claude's text with `extractClaudeText()`.

Important implementation details:

- `extractClaudeText()` supports both old buffered Anthropic JSON and streamed SSE text deltas. Keep that backward compatibility.
- `generate-stream.mjs` and legacy `generate.js` must share the same model allowlist and payload caps.
- If you change the streaming function's validation response shape, update `diagnoseError()` and the deploy-skew docs.
- Netlify deploys functions separately enough that static-only changes can leave the function stale. When touching generation behavior, touch/check `generate-stream.mjs` and verify the deployed endpoint.

## DOMContentLoaded — defused via `safeInit()`

The app wires listeners in a single `DOMContentLoaded` handler. Each block is now wrapped in `safeInit('label', fn)` so a throw in one block is caught, logged to the Activity tab with the block name + stack, and the remaining blocks still wire up. The "most of the app works, but X is dead" cascade is no longer possible from a single null `getElementById`.

If you add a new wiring block, **wrap it in `safeInit`**. Example:
```js
safeInit('my-feature', function () {
  document.getElementById('my-btn').addEventListener('click', doThing);
});
```

Diagnostic ladder when something seems dead:
1. Activity tab → look for a red `[init]` row. The `label` field names the failing block; the `stack` field points to the line.
2. DevTools Console → any uncaught errors at load? `safeInit` swallows wiring throws but other top-level errors (e.g. a syntax error in `app.js`) will still surface here.
3. Type a function from the failing area (`openClientEditor(null)`). If it works, the script parsed; the failure is in the wiring. If `ReferenceError`, the script itself didn't parse.
4. Nothing logs? Test in Incognito. Browser extensions (password managers, ad blockers, Grammarly) can inject scripts that throw before yours runs.

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

## Batch + Campaign — what's shared, what isn't (yet)

The two workflows have intentionally distinct user-facing models (one client × many topics vs. many clients × one topic), but their plumbing is the same. The shared helpers live in section 13b of `app.js`:

- `recoverInterruptedRows(queue, persistFn, message)` — flips `generating`/`publishing` rows to `error: INTERRUPTED` on reload. Used by both `recoverInterruptedBatchRows` and `recoverInterruptedCampaignRows`.
- `makeRunController(spec)` — factory returning `{start, finish, cancel}`. Replaced 6 near-identical functions (batch + campaign × start/finish/cancel) with a 14-line spec each.
- `renderQueueProgress(ids, isRunning, done, total, label)` — used by Campaign. **Batch's progress uses its own implementation** because the no-arg call from `renderBatch()` computes totals from row statuses, which the helper doesn't do. Don't unify without adding the row-status fallback.

What's still duplicated and worth extracting in a follow-up: `runBatchGenerate` / `runCampaignGenerate` (~80 LOC each) and the matching publish loops, plus `renderBatch` / `renderCampaign` (~156 LOC each). The differences are real (Batch substitutes session image filenames; Campaign looks up the per-row client; the `runWithConcurrency` `isRunning` callback gotcha below) so the extraction needs unit tests for the new helper before shipping.

## Batch and Campaign run loops — shared helper gotcha

`runWithConcurrency(items, worker, onDone, isRunning)` is shared by Batch and Campaign.

Roadblock encountered: Campaign's **Generate all** and **Retry generate** initially did nothing and showed `0 generated, 0 failed`. The buttons were wired correctly; the shared helper was checking `state.batchRun.running`, so Campaign loops exited immediately because Batch was not running.

Fix: `runWithConcurrency` accepts an optional `isRunning` callback. Batch uses the default Batch run flag. Campaign must pass:

```js
function () { return state.campaignRun.running; }
```

Do not remove that callback or Campaign generation/sending will silently no-op again.

Current concurrency:

```js
const BATCH_CONCURRENCY = 1;
```

The name is historical. It controls the shared worker helper for both Batch and Campaign. It is intentionally `1` after timeout/debugging work. Streaming solved the inactivity timeout, but one-at-a-time generation keeps UI/debugging predictable and avoids bursts against Anthropic and WordPress.

## Send button activation rules

Batch and Campaign send buttons are intentionally disabled until there is generated content.

- Batch **Send all to WordPress** activates when at least one row has `status === 'generated'`.
- Campaign **Send all to WordPress** activates when at least one row has `row.generated` and `row.status !== 'published'`.

This prevents empty rows from being posted to WordPress. A row must generate first, or be recovered into a generated draft by `fallbackPostFromRawModelText()`.

Batch/Campaign only offer `draft` and `pending`. Do not add `publish` to bulk flows without a separate confirmation/safety design; one-click live publishing across many posts/sites has too much blast radius.

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

### Incomplete JSON recovery — do not show recovered drafts as errors

Campaign testing hit this failure after streaming was introduced:

```text
MODEL_JSON_PARSE · Unterminated string in JSON at position ...
```

Root cause: Claude generated useful post HTML inside the JSON `content` field, but the JSON wrapper was cut off before the final closing quote/brace. This can happen when output length is near the token cap.

Workaround in code: `fallbackPostFromRawModelText(raw, fallbackTitle)` tries to recover usable HTML from:

- raw HTML output, or
- an incomplete JSON `"content": "<html...` field

If recovery succeeds, the row becomes `generated` and `lastError` must be cleared. We intentionally do **not** render a red error banner for a recovered draft. The recovery note goes into `seoNotes` so the operator knows to review before sending.

Current cap:

```js
const BULK_GENERATE_MAX_TOKENS = 3000;
```

That is the server-side max. Do not lower it again as a timeout workaround now that streaming exists; lowering it increased incomplete JSON risk. If output length is still a problem, shorten the prompt or ask for shorter content, not fewer max tokens.

**Testing additions:** if you add a fourth parsing stage, add test cases to `/tmp/test_parser.js` (or inline in a unit test file). Cases that matter:
- Clean JSON
- Fenced JSON with `json` tag (the Haiku failure we saw)
- Fenced JSON without a tag
- Preamble + JSON ("Here is the post: {...}")
- JSON + postamble ("{...} Let me know if...")
- Both wrappers combined
- Garbage (should fail cleanly, not throw)

## Deploy skew — browser vs function out of sync

Netlify Functions **do not redeploy** when only static assets change. If your commit touches `app.js`, `index.html`, or `styles.css` but not `netlify/functions/generate-stream.mjs`, the function keeps running the previous version. This produces browser-vs-server version skew: the browser sends a model/payload shape the server doesn't yet accept.

**Making this self-diagnosing:** `generate-stream.mjs` and legacy `generate.js` include `requested` and `allowed` fields in the "Model not allowed" response body. The browser's `diagnoseError()` branch compares the requested model against both the browser's known list and the server's echoed list. If the browser knows about it but the server doesn't, the banner explicitly says **"Server is running an older version (deploy skew)"** with the current server allowlist shown and a verification curl command included.

**To verify from terminal at any time:**
```bash
curl -X POST https://wp-poster.netlify.app/.netlify/functions/generate-stream \
  -H "Content-Type: application/json" \
  -H "Origin: https://wp-poster.netlify.app" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
```

A successful response or Anthropic-side error = server current. "Model not allowed" with an `allowed` array that excludes your model = deploy skew.

**To force a function redeploy** without touching function source, trigger a manual redeploy from the Netlify dashboard: Deploys → Trigger deploy → Clear cache and deploy site. Or make a trivial edit to `netlify.toml` to invalidate the build cache.

**Apply this pattern to other server-side validations.** Any time `generate-stream.mjs` rejects a request, include what it actually accepts in the response body. Deploy skew becomes self-diagnosing instead of requiring manual forensics. This is the "echo the constraint" pattern — the server tells the client what it can do, not just what it can't.
