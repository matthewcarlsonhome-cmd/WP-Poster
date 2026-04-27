# DESIGN-DOC.md — wp-publisher architecture & roadmap

*The architecture as it stands, the trade-offs taken to get here, and where it goes next.*

## One-line summary

A static single-page app on Netlify that lets one operator draft single posts or 15-post batches with Claude and send them to many client WordPress sites, with each client's voice, credentials, and content kept separate.

## Current app state — April 2026

The app now has three creation modes:

1. **Single-post flow.** The original Brief → Draft → WordPress path remains intact. It supports keyword/location context, image upload, preview, featured image selection, tags, Draft/Pending/Future/Publish workflows, and activity-log diagnostics.
2. **Batch flow.** A new Batch tab lets the operator stage up to 15 briefs for the active client, generate SEO/GEO/AEO-ready drafts one row at a time, review/edit each row, and send generated rows to WordPress as **Draft** or **Pending Review** only. Batch intentionally never offers live Publish.
3. **Campaign flow.** A Campaign tab lets the operator enter one shared topic, select multiple clients, generate localized client-specific versions, and send each version to that client's WordPress site as **Draft** or **Pending Review** only.

The current production architecture is still no-build static HTML/CSS/JS plus one Netlify Function. No server-side database has been added. Browser storage now contains client profiles, active client ID, preferred Claude model, and the current batch queue. The Anthropic model IDs in the UI and function are the tested IDs for this deployment; do not rename them from pattern-matching alone.

What shipped with Batch:

- Persistent batch queue in `localStorage` under `wp-publisher-batch-queue-v1`
- One active client per batch, up to 15 rows
- Per-row fields for title, audience, angle, key message, must-include notes, CTA, length, primary keyword, secondary keywords, and target location
- Bulk-paste importer for simple line-based, TSV, pipe-delimited, or comma-delimited briefs
- SEO/GEO/AEO prompt requirements built into every batch generation
- Generated title, content, meta description, alt text suggestions, and SEO notes
- Editable generated content before send
- One-at-a-time bulk generation/sending to avoid Netlify inactivity timeouts
- Retry/backoff for HTTP 429 and network failures
- Per-row retry for generation and send failures
- Cancel button for in-flight batch runs
- Resume-safe reload behavior: stuck `generating` / `publishing` rows become `error` with `INTERRUPTED`
- Cost preview based on rough model rates and expected token usage
- WordPress send body includes `excerpt` from generated `metaDescription`

What shipped with Campaign:

- Shared campaign brief with topic, keyword template, angle, must-include notes, CTA, and length
- Client picker using existing client profiles
- One campaign row per selected client
- Per-row local market, primary keyword, and local notes
- Per-client prompt that combines shared campaign message with each client's voice guide and local specifics
- Generated title, content, meta description, and SEO notes
- One-at-a-time campaign generation/sending to avoid Netlify inactivity timeouts
- Draft/Pending Review only; live Publish is intentionally excluded
- Persistent local queue under `wp-publisher-campaign-v1`

## Design goals

1. **One operator, many clients.** An SSP Google Ads Manager shouldn't have to log into thirty WordPress admin panels to queue blog posts. All client contexts live in one interface.
2. **Per-client voice consistency.** Each client has a voice guide and optional sample paragraph that Claude reads before every draft. No house style bleeding across accounts.
3. **Client approval built into the workflow.** "Pending review" status is the default. The client sees the draft in their own WP dashboard, approves with one click. No email thread.
4. **No server-side database for v1.** Credentials and profiles live in `localStorage`. Easy to set up, easy to audit. This was a deliberate trade-off with a planned migration path — see *Shared-storage roadmap*.
5. **Model-agnostic.** Drop-down model picker covers Haiku → Sonnet → Opus. The server allowlists so the browser can't ask for models you haven't sanctioned.

## Architecture

```
┌────────────────────────┐        ┌──────────────────────────┐
│      Browser           │        │  Netlify CDN + Functions │
│                        │        │                          │
│  index.html + app.js   │◄──────►│  generate.js (proxy)     │
│  styles.css            │        │  Serves static files     │
│                        │        │  Holds ANTHROPIC_API_KEY │
│  localStorage:         │        └────────────┬─────────────┘
│    clients             │                     │
│    active-client       │                     ▼
│    model               │        ┌──────────────────────────┐
│    batch queue         │        │   api.anthropic.com      │
│                        │        └──────────────────────────┘
│                        │
│                        │        ┌──────────────────────────┐
│                        │───────►│  client1.com/wp-json     │
│                        │───────►│  client2.com/wp-json     │
│                        │───────►│  client3.com/wp-json     │
│                        │        └──────────────────────────┘
└────────────────────────┘
```

Three things worth calling out:

1. **The Anthropic key never reaches the browser.** `generate.js` is the only place it's unsealed. The browser sends `{model, max_tokens, messages}` to `/.netlify/functions/generate`; the function rejects unknown origins, validates payload size + model allowlist, then forwards to Anthropic and streams back the response.
2. **WordPress credentials go browser-direct.** Each client's Application Password is held in that browser's `localStorage` and used only in the `Authorization: Basic` header on requests to that specific client's site. Nothing server-side of ours touches these.
3. **No database.** Netlify is serving static files + one function. The database is the user's browser + every client's WordPress install.

## Data model

### Client profile (persisted as `wp-publisher-clients`)

```js
{
  id: "c_<random>_<base36 timestamp>",  // locally generated, never sent to server
  name: "Acme Pools",                    // display name only
  url: "https://acmepools.com",          // no trailing slash
  user: "ssp-publisher",                 // WP username
  pass: "xxxx xxxx xxxx xxxx",           // WP Application Password (not user password)
  voice: "Write in first person...",     // free-form voice guide sent in every prompt
  sample: "When we talk about..."        // optional sample paragraph for tone-matching
}
```

### Active client (persisted as `wp-publisher-active-client`)

Just the ID string. Resolved to a profile by `getActiveClient()` on every access, so deleting a client and falling back to another works transparently.

### Model (persisted as `wp-publisher-model`)

Just the model ID string. Migration map in `loadStorage()` auto-rewrites stale IDs.

### Session images (in-memory only)

Images uploaded this session are held in `state.images` as `{id, name, url, thumb}`. **Reset on client switch** — images are scoped to the active client's WordPress media library. The `id` and `url` come back from WordPress after upload; the `name` is the original filename (used for in-prompt filename substitution).

### Batch queue (persisted as `wp-publisher-batch-queue-v1`)

```js
{
  version: 1,
  clientId: "c_<client>",
  model: "claude-sonnet-4-6",
  rows: [
    {
      id: "r_<random>",
      status: "empty" | "ready" | "generating" | "generated" |
              "publishing" | "published" | "error",
      brief: {
        title: "",
        audience: "",
        angle: "",
        key: "",
        must: "",
        cta: "",
        length: "medium",
        primaryKeyword: "",
        secondaryKeywords: "",
        targetLocation: ""
      },
      generated: {
        title: "",
        content: "<p>...</p>",
        metaDescription: "",
        altTextSuggestions: [],
        seoNotes: ""
      } | null,
      wpPostId: 123 | null,
      wpPostUrl: "https://..." | null,
      lastError: {
        phase: "generate" | "publish",
        code: "",
        message: "",
        ts: 1714000000000
      } | null
    }
  ],
  updatedAt: 1714000000000
}
```

The batch queue does **not** duplicate WordPress Application Passwords. It references the active client by ID and uses the existing client profile when sending to WordPress. Only one saved batch exists per browser in v1. If the operator switches clients while a batch exists for another client, the UI asks them to clear it before starting a new one.

### Campaign queue (persisted as `wp-publisher-campaign-v1`)

The campaign queue stores one shared topic and one row per selected client. It does not duplicate credentials; each row references a client profile by `clientId`.

See `MULTI-CLIENT-CAMPAIGN-DESIGN.md` for the full schema and prompt strategy.

### Activity log (in-memory only, 200-entry ring buffer)

`appLog = [{ts, level, category, message, detail}]`. Cleared on reload. Re-rendered in the Activity tab on demand. The `detail` field holds full request/response bodies for debugging.

## Data flow: "Generate and publish a post"

```
1. Operator picks client     → state.activeClientId updated, UI reflects it
2. Operator fills brief      → gathered into `brief` object
3. Click "Generate"
   a. Prompt assembled:
      VOICE GUIDE + SAMPLE + BRIEF + IMAGE_FILENAMES + JSON_OUTPUT_SPEC
   b. apiCall POST → /.netlify/functions/generate
   c. generate.js:
      - Origin check
      - Payload validation
      - Model allowlist check
      - Forward to api.anthropic.com
   d. Response returned as-is
4. Browser parses {title, content}
   a. content run through sanitizeHtml()
   b. <img src="FILENAME"> replaced with real WP media URLs
   c. Title → post-title input, content → editor textarea
5. Operator edits / previews
6. Click "Send to WordPress"
   a. sanitizeHtml() applied AGAIN (defense in depth)
   b. apiCall POST → {client}/wp-json/wp/v2/posts
   c. Response link shown in status banner
```

## Data flow: "Generate and send a batch"

```
1. Operator opens Batch tab
   a. If no batch exists, app creates an empty queue for active client
   b. If a saved batch exists for another client, app blocks new work until cleared

2. Operator adds rows or bulk-pastes briefs
   a. Rows persist after every field change
   b. Rows become "ready" when they have a primary keyword plus a title, angle, or key message
   c. Cost estimate updates from ready-row count and selected model

3. Click "Generate all"
   a. Batch snapshots the selected model
   b. Ready rows move to `generating`
   c. Claude requests run one at a time through the existing Netlify Function
   d. 429/network failures retry with 2s/4s/8s backoff
   e. Model output is parsed with `parseJsonFromModel()`, sanitized, and persisted row-by-row
   f. Success rows become `generated`; failures become `error`

4. Operator reviews generated rows
   a. Title, meta description, content, and SEO notes are editable
   b. Alt text suggestions are visible for manual use in WordPress media
   c. Retry buttons rerun generation or send for one row

5. Click "Send all to WordPress"
   a. Dropdown only allows `pending` or `draft`
   b. Generated rows move to `publishing`
   c. WordPress POSTs run one at a time
   d. Body includes title, sanitized content, status, and excerpt from meta description
   e. Success rows store WordPress post ID/link and become `published`
   f. Failures become `error` and remain retryable
```

Cancellation uses `AbortController`. Any in-flight rows are restored to `ready` or `generated` and marked with `ABORTED`. On reload, any row stuck in `generating` or `publishing` becomes `error` with `INTERRUPTED` so the operator can verify WordPress before retrying.

## Data flow: "Generate and send a campaign"

```
1. Operator opens Campaign tab
2. Operator enters one shared topic and keyword template
3. Operator selects multiple client profiles
4. Click "Build campaign rows"
   a. App creates one row per selected client
   b. Row pre-fills local market where it can infer one from the client name
   c. Primary keyword is built from the keyword template by replacing {market}
5. Click "Generate all"
   a. Each row gets a separate prompt containing shared brief + that client's voice guide + local row data
   b. Claude requests run one at a time through the existing Netlify Function
   c. Results persist row-by-row as generated client-specific drafts
6. Operator reviews and edits each generated version
7. Click "Send all to WordPress"
   a. Each row posts to its own client URL with that client's Application Password
   b. Campaign only allows Draft or Pending Review
```

## Error handling architecture

**Design principle:** every backend call produces the same shape of result, so callers are uniform.

```js
const result = await apiCall('context-name', url, init);
if (result.ok) {
  // result.data is the parsed JSON (or text)
} else {
  showStatus('xyz-status', formatApiError('What failed', result), 'error');
}
```

`apiCall` internals:

1. Logs start of request to Activity log + console.
2. Wraps `fetch` — network errors become `ok: false, code: "NETWORK"` rather than exceptions.
3. Reads body as JSON if Content-Type says so, else as text.
4. On `!r.ok`, extracts error shape from WP / Anthropic / our-proxy response and normalizes into `{code, message}`.
5. Logs full detail to Activity log with `level: 'error'`.
6. Returns the normalized result.

Callers never write try/catch around this. The Activity tab is always the single source of truth for "what happened" — no combing through DevTools Console tabs across multiple failed requests.

## Activity log — design rationale

An in-memory ring buffer (max 200 entries) rather than a real logging backend because:

- We'd need auth to log to anywhere server-side, and we don't have auth yet.
- The tool is used interactively by one operator; batch debugging across days isn't a use case.
- 200 entries is enough for any single debugging session; older entries age out naturally.

Each entry renders as a collapsible `<details>` so the list is scannable without flooding the viewport with JSON dumps. The Copy button builds a paste-ready payload (timestamp + level + category + message + full detail) for sharing bug reports.

The error-count badge on the tab caption gives you ambient awareness — you notice a red "2" pill without having to check the tab proactively.

## Sanitization — why regex, not DOMPurify

`sanitizeHtml()` is regex-based rather than DOM-parser-based. The trade-off:

| Pro (regex) | Con (regex) |
|---|---|
| Zero dependencies — matters under strict CSP | Less robust against exotic injections |
| Small enough to fit on one screen | Requires careful test cases |
| No risk of a supply-chain compromise | Future additions need regex discipline |

DOMPurify would be safer but pulling in a CDN dependency violates our `script-src 'self'` CSP. We could vendor it, but that's 65KB of third-party code we'd have to review every update. For an output source we trust (Claude) and a paranoid double-pass (sanitize at populate AND at publish), the regex approach is appropriate. **If we ever start accepting HTML from less-trusted sources — e.g. rich paste from clients — migrate to DOMPurify.**

## Shared-storage roadmap (the "Option C" problem)

Today's `localStorage`-only storage has a known limit: each teammate needs the full client list on their own browser. This is the problem Export/Import solves for now and a server migration solves properly.

### Tier 1 — Export/Import JSON files  ✅ shipped in current build

- Operator clicks Export → JSON file downloads (`ssp-clients-DO-NOT-EMAIL-<date>.json`)
- Teammate receives file via 1Password / Signal / encrypted channel
- Teammate clicks Import → merge by URL match, new clients added, existing updated
- **Includes Application Passwords** — this is the point, otherwise Import is useless

**Pro:** Zero backend changes. Works today.
**Con:** Manual sync. Two operators editing same client in parallel = last-exporter wins. Passwords traveling across channels.
**Trigger to outgrow:** more than two active operators, or any operator edits clients regularly.

### Tier 2 — Netlify Blobs + Netlify Identity  (target: before end of May 2026)

- Add a second Netlify Function `/.netlify/functions/clients` with GET/POST/DELETE
- Persist the clients array in Netlify Blobs (built-in KV store, free tier ample for our scale)
- Add Netlify Identity for auth: you invite Lisa by email, she creates a password, the Identity JWT gates the function
- `localStorage` becomes a cache, not the primary store. On load, fetch from Blobs; on mutation, write to Blobs then update cache.
- Deprecate Export/Import (or keep as backup / offline use)

**Pro:** Real shared state. Credential changes propagate automatically. Auth gives you an audit surface.
**Con:** Half-day of work. Introduces auth as a dependency.
**Trigger to migrate:** Lisa (and/or Michael Adams) actively editing client profiles, or first time someone asks "what did I do to client X yesterday".

### Tier 3 — Supabase / Neon  (not planned; document trigger)

- Real Postgres behind an API
- Row-level security, audit logging, foreign keys to a future "users" table
- Overkill until we need: per-user permissions (e.g. some operators see only their book of business), audit trail required for compliance, or historic drafts kept outside WordPress itself.
- **Don't build until a specific requirement demands it.** Netlify Blobs + Identity covers us for a long time.

## Security roadmap

In rough priority order:

1. **Tier 2 migration.** Moves credentials off individual browsers and onto a single audited backend with real auth. Subsumes most of what follows, so prioritize this over incremental hardening of the current browser-storage model.
2. **Client-side encryption for `localStorage`** (if Tier 2 is delayed). Derive a key from a passphrase entered on each session; encrypt Application Passwords at rest. Not a replacement for Tier 2 — a compromised browser process still sees the session key — but raises the bar against "someone walked up to my unlocked laptop."
3. **Credential rotation enforcement.** Track `passUpdatedAt` per client; flag any > 90 days old in the Clients tab with a "rotate" nudge. Application Passwords can be revoked and reissued in seconds.
4. **Per-session rate limiting on `generate.js`.** Today, a compromised browser could burn through a lot of Anthropic quota before someone notices. Add a rolling window limit per origin.
5. **HTTPS enforcement on client URLs.** Today we accept `http://` for local dev. Production should reject anything but HTTPS — add a check in `saveClientFromForm()`.
6. **CSP tightening.** Inline style dependencies are eliminated (✅ done — italic/bold buttons moved to classes). Next step: nonce-based `script-src` so even an injected `<script>` can't run.
7. **Audit trail for publish/delete.** Once Tier 2 is in place, log every publish/delete action with actor + timestamp. Retention 90 days.
8. **Secret scanning on Export file.** Before download, confirm with a modal: "This file contains credentials for N clients. Continue?"

## Future development path

The practical path from here is to harden the new Batch surface, then move credentials server-side, then add richer content and reporting features.

### Next 1-2 weeks — Batch hardening

1. **Browser QA pass.** Test Batch in Chrome, Edge, and Safari with a real WordPress staging site. Cover reload mid-generate, reload mid-send, cancel, per-row retry, and bad Application Password diagnostics.
2. **Duplicate detection on retry.** For interrupted publish rows, add a best-effort search against WordPress by slug/title before retrying. Today the UI warns the operator; a lookup would reduce duplicate-post risk.
3. **Token/cost actuals.** Anthropic responses include usage. Store per-row input/output token counts and replace the current estimate with actual batch cost after generation.
4. **Configurable concurrency.** Move `BATCH_CONCURRENCY` from a constant to Settings with a conservative default of 3 and a max of 5.
5. **Batch templates.** Save reusable brief skeletons per client or industry: pool opening, hot tub maintenance, seasonal checklist, service-area FAQ.
6. **CSV import/export.** The current bulk paste handles simple lines. Add a structured CSV template with headers so an editorial calendar spreadsheet can become a batch with fewer edits.

### Next month — Storage and security

1. **Netlify Identity + server-side client storage.** Move client profiles and Application Passwords out of individual browser storage. Keep localStorage as cache only.
2. **Audit trail.** Once users authenticate, log generate/send/trash actions with actor, client, post ID, status, and timestamp.
3. **Credential age tracking.** Add `passUpdatedAt` and warnings for credentials older than 90 days.
4. **Rate limiting on `generate.js`.** Batch increases quota-burn potential, so add per-session and per-origin limits.
5. **HTTPS-only client URLs.** Keep `http://` only behind an explicit local-dev bypass.

### Product expansion

1. **Single-post SEO/GEO/AEO fields.** Batch has primary keyword, meta description, SEO notes, and alt text suggestions. Bring those same fields into the single-post Brief/Draft flow.
2. **Image optimization.** Resize/compress before upload, store image dimensions, and write alt text back to WP media when the operator chooses a suggestion.
3. **Scheduled batch sends.** Allow rows to be sent as future posts with staggered dates, while keeping batch live Publish disabled by default.
4. **WordPress plugin adapters.** Support Yoast/RankMath meta fields directly instead of relying on `excerpt` as the generic meta-description carrier.
5. **Client approval notifications.** Optional email to client when posts are sent to Pending Review.
6. **Analytics feedback loop.** Pull post performance from GA4 or Search Console and show results beside history/queue items.
7. **Anthropic Message Batches API.** Revisit when jobs grow beyond 50 posts or cost becomes more important than interactive turnaround.
8. **Client market defaults.** Add `market`, `serviceArea`, and `defaultCTA` fields to client profiles so Campaign rows prefill accurately instead of inferring from client names.

## Functionality roadmap

Grouped by theme, rough priority within each group:

### Operator quality-of-life
1. **"Trash WordPress defaults" one-click button.** Detect `hello-world`, `sample-page`, `privacy-policy` slugs in the Queue and offer a single-click sweep.
2. **Bulk select + bulk trash in Queue.** Checkboxes on queue rows, "Trash selected" button.
3. **Keyboard shortcuts.** Cmd+Enter to generate from brief, Cmd+S to publish, Esc to close editor.
4. **Undo draft generation.** Keep the previous draft one step back; pressing "Generate" shouldn't be a cliff.
5. **Diff view on regenerate.** Show what changed between the previous draft and the new one.

### Client workflow
6. **WP revision history view.** Fetch the revisions endpoint for a post and show a diff.
7. **Preview in client's own CSS.** Iframe the draft into a stub page loading the client's actual stylesheet, so the operator sees what the client will see.
8. **Approval email to client.** When marking "Pending review", optionally trigger an email to the client with a deep link to the WP pending-posts queue.
9. **Scheduled send at SSP level.** A queue of drafts scheduled for future publish, managed in our app rather than relying on WP's own scheduling.
10. **Multi-site publish from one draft.** "Publish to all three Acme brands" — useful for franchises.

### Content tooling
11. **Brief template library per industry.** Starter briefs for pool-opening, hot-tub-maintenance, etc. Each client can have a set.
12. **Image compression + alt-text suggestion.** Before upload, resize to sensible dimensions; ask Claude to propose alt text.
13. **Server-side prompt templates.** Move the prompt scaffolding from `app.js` to a templated string on the server; version the template and allow A/B testing.
14. **IndexedDB for draft persistence.** Right now an unsent draft is lost on reload. Persist to IndexedDB with client scoping.

### Reporting
15. **Analytics integration.** Wire up GA4 / PostHog for each client and show post-view counts next to each published post in Queue.
16. **Aggregate telemetry.** "You published 47 posts across 32 clients in April" — useful for SSP internal reporting.

## What v1 explicitly is NOT

These are intentional omissions, not oversights:

- **Not a WordPress replacement.** We don't store post content ourselves. Once published, it lives in WordPress. This keeps our surface area small and respects client data sovereignty.
- **Not a multi-user system.** One browser, one operator at a time. Tier 2 adds light multi-user support; Tier 3 adds real multi-user.
- **Not a CMS.** No page editing, no media management beyond uploads, no theme/plugin concerns.
- **Not an approval workflow engine.** We use WordPress's built-in "pending review" status. Real approval chains (e.g. "marketing approves, then legal approves") should live in a dedicated tool.

## Deployment notes

- Deploy target: `https://wp-poster.netlify.app`
- Production branch: `main`
- Required env var: `ANTHROPIC_API_KEY` (Netlify UI → Site settings → Environment variables)
- Cache rules: `*.html`, `*.js`, `*.css` should all use `Cache-Control: public, max-age=0, must-revalidate` — see CLAUDE.md for why
- CSP: strict, enforced via `netlify.toml`. Every dependency change potentially needs a CSP update.

## How to onboard a new teammate

Today (Tier 1):
1. You (primary operator) click Export
2. Send them the JSON over 1Password shared vault or Signal
3. They open `https://wp-poster.netlify.app`, click Import, select the file
4. All clients appear with working connections

After Tier 2:
1. You invite them via Netlify Identity (email)
2. They set a password, log in, see all clients automatically
3. Nothing traveled as a file
