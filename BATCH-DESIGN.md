# BATCH-DESIGN.md — Batch brief entry and bulk Draft/Pending publish

*Design for the "write 15 posts in one sitting, push them all to WordPress as Draft or Pending Review" workflow. Read DESIGN-DOC.md first — this builds on the single-post architecture and reuses its primitives.*

## One-line summary

A new **Batch** tab that lets one operator stage up to 15 briefs for the active client, generate them all in one run (with built-in SEO/GEO/AEO optimization), review/edit, then send the entire set to WordPress as Draft or Pending Review — never auto-Publish.

## Implementation status

Implemented in the current app:

- Batch tab with up to 15 persisted rows for one active client
- Manual row add, duplicate, remove, move up/down, and bulk paste
- Per-row SEO/GEO/AEO fields, including required Primary keyword
- SEO/GEO/AEO prompt additions with generated meta description, alt text suggestions, and SEO notes
- One-at-a-time generation and WordPress sends to avoid Netlify inactivity timeouts
- Retry/backoff on HTTP 429 and network failures
- Per-row retry for generation and send failures
- Cancel in-flight batch runs
- Reload recovery for interrupted rows
- Draft/Pending Review send only; live Publish is not offered in Batch
- Cost estimate before generation

Still future work:

- Actual token/cost capture from Anthropic usage fields
- Saved brief templates
- Structured CSV import/export with headers
- Cross-client batch mode
- Anthropic Message Batches API for large async jobs

## What ships today (same-day MVP)

Paste up to 15 briefs into a new Batch tab, click **Generate** to have Claude write them all (optimized for SEO, GEO, and AEO in one pass), review or edit each one inline, then click **Send** to push the whole set to WordPress as either **Draft** or **Pending Review** — your choice at send time. That's it.

What's **not** in the same-day build (lands in Phase 2 next week): fancy concurrency tuning, polished per-row retry, resume-on-reload after a browser close, brief templates, and bulk CSV paste. Those are all designed below but deliberately left out of the first cut so we can ship today and iterate on real usage.

## Why now

Today's flow is one-at-a-time: fill brief → Generate → review → Publish → repeat. For an operator working a single client's monthly editorial calendar (8–15 posts), the context-switching and waiting between each post is the bottleneck. Compressing the "fill briefs" phase (can be done offline, pasted in bulk) from the "generate" phase (parallelizable) from the "publish" phase (one-shot) cuts a typical 45-minute session to ~10 minutes and makes client-approval handoff a single action.

## Design goals

1. **Stage before spend.** Briefs can be drafted, reordered, edited, and saved without touching the Anthropic API. You pay only when you click Generate All.
2. **One client per batch, many posts.** v1 does not support "same brief to three clients." See *What v1 explicitly is NOT*.
3. **Draft or Pending Review only — never auto-Publish.** A batch sends every post in "Draft" or "Pending Review" state (operator picks per-batch at send time). Publishing live is reserved for single-post flow; a batch can't ever push content live by mistake.
4. **Resumable.** A reload mid-batch does not lose briefs or already-generated content. Only in-flight generates are re-tried.
5. **Per-row failure isolation.** One bad brief, one WordPress 5xx, or one model JSON-parse failure does not abort the other 14 rows.
6. **Reuse, don't fork.** `apiCall`, `parseJsonFromModel`, `sanitizeHtml`, `publishPost`'s request shape, `diagnoseError`, and `showErrorBanner` are all reused as-is. No parallel code paths to maintain.

## User-facing flow

```
1. Open Batch tab
2. Click "Add brief" up to 15 times — or paste a bulk briefs CSV/text (v1.1)
3. Fill each row's fields inline (title, angle, key points, etc.)
4. Click "Generate all"
     → progress bar, per-row status pill flips draft → generating → generated/error
     → one-at-a-time by default to avoid Netlify inactivity timeouts
5. Review. Click any row to expand the generated post and edit inline.
6. Choose Draft or Pending Review, click "Send all to WordPress"
     → per-row publishing → sent/error pill
     → final summary: "13 sent, 2 failed (retry)"
7. Client sees all 13 in their WP Posts → Pending queue.
```

## SEO / GEO / AEO optimization (baked into every batch post)

Every brief generated through the batch tab is optimized for three overlapping discovery channels, without the operator having to think about it. The operator provides a **Primary keyword** per row (and optional secondary keywords); the prompt handles the rest.

**What each acronym means, in plain terms:**

| | Stands for | What it targets | What it favors |
|---|---|---|---|
| **SEO** | Search Engine Optimization | Traditional Google results | Keyword placement, meta description, heading structure, alt text, word count |
| **GEO** | Generative Engine Optimization | ChatGPT, Perplexity, Google AI Overviews | Citation-worthy facts, declarative sentences, clean semantic hierarchy, E-E-A-T signals |
| **AEO** | Answer Engine Optimization | Featured snippets, "People Also Ask", voice assistants | Short self-contained answers, question-form headings, FAQ sections |

**New per-row brief field:**

| Field | Required? | Example |
|---|---|---|
| `primaryKeyword` | Yes | "Virginia Beach pool winterization" |
| `secondaryKeywords` | No | "pool closing, off-season pool care" |
| `targetLocation` | Auto-filled from client profile if available | "Virginia Beach, VA" |

**Prompt additions (appended to the existing voice/brief/image/JSON-spec prompt):**

```
SEO / GEO / AEO OPTIMIZATION REQUIREMENTS

You are writing content that must perform in three channels at once:
  traditional search (Google), generative search (LLMs / AI Overviews),
  and answer engines (featured snippets / voice). Follow every rule
  below unless it would produce unnatural prose.

1. TL;DR ANSWER FIRST
   - Open with a 40–60 word direct answer to the post's core question.
   - This paragraph must stand alone as a quotable snippet.
   - Include the primary keyword within this opening.

2. KEYWORD PLACEMENT (natural, not stuffed)
   - Primary keyword: in the title, the first 100 words, and 2–3 H2s.
   - Secondary keywords: distributed naturally across body copy.
   - Target keyword density ~1–2%. Never at the cost of readability.

3. QUESTION-FORM HEADING STRUCTURE (AEO)
   - 3–5 H2 headings phrased as natural questions a reader would ask.
   - Under each, a short (≤60 words) self-contained answer, then
     optional expanded detail.
   - Also include an FAQ section of 3–5 additional Q&A pairs near the end.

4. CITATION-WORTHY FACTS (GEO)
   - Include specific numbers, dates, brand/material names, and
     measurable claims wherever truthful.
   - Use declarative sentences ("X costs $Y", "A does B in Z minutes")
     that LLMs can lift verbatim.
   - Avoid vague superlatives ("the best", "amazing", "premium") —
     LLMs downrank vague marketing copy.

5. LOCAL SIGNALS (SEO + GEO)
   - If a targetLocation is provided, mention the city/region 2–3
     times naturally (service-area copy, local context, nearby
     landmarks where relevant). Never force it.

6. META DESCRIPTION
   - Return a separate field `metaDescription` (150–160 characters)
     containing the primary keyword and a compelling reason to click.

7. ALT TEXT SUGGESTIONS
   - For each image referenced in the brief, return an `altTextSuggestions`
     array with 1–2 descriptive, keyword-aware alt-text strings.

8. WORD COUNT TARGET
   - Short brief  → 400–550 words
   - Medium brief → 650–850 words
   - Long brief   → 900–1,100 words

Return JSON matching this shape:
{
  "title":                "...",
  "metaDescription":      "...",
  "content":              "<post body as HTML>",
  "altTextSuggestions":   ["...", "..."],
  "seoNotes":             "<1–2 sentences on SEO choices made>"
}
```

**What the operator sees in the UI post-generate:**

- The generated post body (editable as today).
- A **Meta description** field (copyable, highlighted if over 160 chars).
- An **Alt text** list, one suggestion per image.
- An **SEO notes** line explaining Claude's choices (useful for the reviewer and for training the operator over time).

**What gets sent to WordPress on publish:**

- `title`, `content` → standard WP fields (unchanged from today).
- `excerpt` ← `metaDescription` (WordPress uses `excerpt` for Yoast/RankMath meta in most setups; if a client uses a different SEO plugin, this is one extra setting to configure).
- Alt text is left as operator-paste for now (WP's media library is per-image; automating alt-text injection across uploaded media is Phase 2).

**Why this is mostly a client-side prompt change:** the prompt lives in `app.js` (per DESIGN-DOC.md's current architecture) and is sent as the `messages[0].content` payload. `generate-stream.mjs` doesn't need to know about SEO at all — it's pass-through to Anthropic with streaming enabled. The prompt addition is purely additive; single-post flow can opt in to the same optimization by reading the same `primaryKeyword` field.

**What this is NOT doing:**

- Not running a separate "SEO audit" pass after generate. Every post is optimized in one pass; no second API call.
- Not scoring posts against a checklist in the UI. If Claude misses a rule, the operator catches it in review — cheaper than building a linter.
- Not generating schema.org JSON-LD markup. Phase 2 candidate; most WP SEO plugins handle FAQ / Article schema automatically.
- Not stuffing keywords for ranking tricks. Natural prose is non-negotiable.

## UI structure (new tab + new components)

```
┌─ Batch tab header ──────────────────────────────────────────┐
│  Client: [Acme Pools ▾]   Model: [Sonnet 4.6 ▾]             │
│  Briefs: 7 / 15           Est. cost: ~$0.42                 │
│  [+ Add brief]  [Generate all ▶]  [Send all to WP ▶]        │
├─ Progress bar (visible during batch runs) ──────────────────┤
│  ████████████░░░░░░░  12/15 generated                       │
├─ Brief rows ────────────────────────────────────────────────┤
│  #1  ● ready      "Spring pool opening checklist"      […]  │
│  #2  ● generated  "Hot tub winterization"              […]  │
│  #3  ● error      "..." (see diagnostic)         [retry]    │
│  #4  ● publishing "..."                                     │
│  ...                                                        │
└─────────────────────────────────────────────────────────────┘
```

Each row is a collapsible card using the existing `.card` + `.queue-row` styling. Expanded state shows:
- Editable brief form (same seven fields as the single-post brief: `title`, `audience`, `angle`, `key`, `must`, `cta`, `length`)
- Post-generate: editable title + content textarea (same as the single-post Draft tab)
- Row actions: Edit, Duplicate, Remove, Move up, Move down, Retry (on error)

Status pill reuses the existing `.pill-*` variants plus one new class:

| Row status      | Pill class         | Meaning                                        |
|-----------------|--------------------|------------------------------------------------|
| `empty`         | `pill-draft`       | Row exists, brief incomplete                   |
| `ready`         | `pill-pending`     | Brief complete, not yet generated              |
| `generating`    | `pill-generating`* | API call in flight                             |
| `generated`     | `pill-scheduled`   | Content returned, awaiting publish             |
| `publishing`    | `pill-generating`* | WordPress POST in flight                       |
| `published`     | `pill-published`   | Live on WordPress as Pending                   |
| `error`         | `pill-error`*      | Generate or publish failed — retry button      |

`*` = new CSS class, single-color extensions of the existing pill pattern. No new design-language work.

## Data model

### Batch queue (persisted as `wp-publisher-batch-queue-v1`)

```js
{
  version: 1,
  clientId: "c_xxx_yyy",     // batch is scoped to a single client
  model: "claude-sonnet-4-6", // snapshotted at batch start; cannot change mid-run
  rows: [
    {
      id: "r_<random>",
      status: "empty" | "ready" | "generating" | "generated"
            | "publishing" | "published" | "error",
      brief: {
        title: "", audience: "", angle: "",
        key: "", must: "", cta: "", length: "medium",
        primaryKeyword: "", secondaryKeywords: "",
        targetLocation: ""  // auto-filled from client profile if available
      },
      // populated after generate:
      generated: {
        title:              "...",
        content:            "<p>...</p>",
        metaDescription:    "...",           // 150–160 chars, for Yoast/RankMath
        altTextSuggestions: ["...", "..."],  // operator pastes into WP media library
        seoNotes:           "..."            // Claude's explanation of SEO choices
      } | null,
      // populated after publish:
      wpPostId: 1234 | null,
      wpPostUrl: "https://..." | null,
      // last failure, if any:
      lastError: {
        phase: "generate" | "publish",
        code: "...", message: "...", ts: 1714000000000
      } | null
    },
    // ... up to 15
  ],
  updatedAt: 1714000000000
}
```

Keyed with `-v1` because we will rev the schema rather than mutate-in-place. `loadBatchQueue()` follows the same migration-map pattern as `loadStorage()` (see CLAUDE.md, "localStorage migrations").

### In-memory run state (not persisted)

```js
state.batch = {
  running: false,
  phase: null,          // 'generate' | 'publish' | null
  abortController: null // so "Cancel" works mid-batch
};
```

## Data flow: "Generate and publish a batch"

```
1. Operator adds rows, fills briefs        → batchQueue.rows grows, status = 'ready'
                                              persisted on every edit (debounced 500ms)

2. Click "Generate all"
   a. Guard: all rows have required brief fields? (row.status == 'ready')
      If not, highlight incomplete rows, abort.
   b. Snapshot model, disable model selector.
   c. For each row: status → 'generating', persist.
   d. Run one row at a time:
        - Build prompt (same assembler as single-post flow)
        - apiCall('batch-generate', GENERATE_ENDPOINT, {...})
        - parseJsonFromModel(raw)
        - sanitizeHtml(content), image-filename substitution
        - On success: row.generated = {title, content}, status = 'generated'
        - On failure: row.lastError = {...}, status = 'error'
        - Persist after each row (atomic-ish — single row update per write)
   e. Render summary: "N generated, M failed."

3. Operator reviews, optionally expands and edits rows.
   Every edit re-persists the row. Status stays 'generated'.

4. Operator picks **Draft** or **Pending Review** at the top of the tab, clicks "Send all to WordPress"
   a. Guard: at least one row with status == 'generated'.
   b. Guard: `publish` is NEVER an allowed batch status — the dropdown only offers `draft` and `pending`. Batch cannot push content live by mistake.
   c. For each generated row, one at a time:
        - status → 'publishing', persist
        - Build WP body: { title, content: sanitizeHtml(content), status: <draft|pending> }
        - apiCall('batch-publish', active.url + '/wp-json/wp/v2/posts', {...})
        - On success: row.wpPostId, row.wpPostUrl set, status = 'published'
        - On failure: row.lastError, status = 'error'
        - Persist after each row.
   c. Render summary banner with count + link to client's WP Pending queue.
```

**Cancellation.** `state.batch.abortController` is wired into every fetch. "Cancel" button flips all `generating`/`publishing` rows back to their prior status and records `lastError = {code: 'ABORTED'}`.

**Resume on reload.** On page load, if `state.batch.running` was true and any row is stuck in `generating` or `publishing`, that row is flipped to `error` with `code: 'INTERRUPTED'` — safer than silently retrying a request we don't know the outcome of (a `publishing` row may have succeeded on WP but we never saw the response).

## Concurrency, rate limits, and cost

**Concurrency.** Default is 1 request per phase. The first production test hit Netlify's roughly 30-second inactivity timeout on long batch generations, so reliability matters more than parallel speed. The app now uses `generate-stream.mjs` so Anthropic chunks flow through Netlify instead of buffering silently.

**Backoff on 429.** Existing `apiCall` doesn't retry; `generateBatch()` wraps it with an exponential-backoff retry on `status === 429` or `code === 'NETWORK'` (2s / 4s / 8s, max 3 tries). Other failures are not retried automatically — they go to `error` status for the operator.

**Cost preview.** Before Generate All, show an estimate:

```
Est. cost: ~$0.42  (15 posts × ~2.5k tokens in + ~1.8k tokens out × Sonnet 4.6)
```

Uses a rough token-per-brief constant times the model's published rates. Purely advisory — it doesn't block the run.

**Why not Anthropic's Message Batches API?** It's async (up to 24h turnaround), returns a 50% discount, and is ideal for overnight jobs of thousands of messages. For 15 interactive posts where the operator is watching, sync requests at 3× concurrency finish in 30–60 seconds and keep the existing `apiCall` + diagnostics pipeline unchanged. Revisit when batch sizes regularly exceed 50 or cost becomes the dominant concern. See *Phase 3* below.

## Error handling

Every row-level failure runs through the existing `diagnoseError(context, result)` pipeline. Two additions:

1. **New context strings.** `'batch-generate'` and `'batch-publish'`. These are recognized by `diagnoseError()` only insofar as the rest of the result (`code`, `status`, `message`) is handled the same way as the single-post equivalents — no new branches needed up front.
2. **New top-level code: `MODEL_JSON_PARSE`.** Already exists per CLAUDE.md; batch flow surfaces it per-row instead of globally.

Per-row errors render in the expanded row using a compact `showErrorBanner`-style block. Clicking Retry reruns just that row through the current phase, independent of the rest.

Batch-level errors (e.g. no active client, empty queue, invalid model) surface in a banner at the top of the tab using the existing `.status.error` class.

## CSP + DOMContentLoaded considerations

Per CLAUDE.md:

- All new listeners wire into the single `DOMContentLoaded` handler at `app.js:2008`. If a helper throws during init, every listener below dies — so wrap batch init in a try/catch that logs to Activity and proceeds.
- No inline `style`/`onclick`/`<script>`. All row actions are delegated via `addEventListener` on a parent container, keyed by `data-row-id` and `data-action` attributes.
- All new CSS goes in `styles.css`. No dependencies added.

## Files touched

| File                            | Change                                                                 |
|---------------------------------|------------------------------------------------------------------------|
| `index.html`                    | New tab button, new `#tab-batch` panel with header + empty row list   |
| `app.js`                        | New section "14. batch" with ~300 LOC: state, render, generate, publish |
| `styles.css`                    | `.batch-row`, `.batch-progress`, `.pill-generating`, `.pill-error`    |
| `netlify/functions/generate-stream.mjs` | Streaming Anthropic proxy used by the app to avoid Netlify inactivity timeouts. |
| `CLAUDE.md`                     | Add a note in the localStorage-migrations section about `batch-queue-v1` |
| `DESIGN-DOC.md`                 | Cross-link in the Functionality Roadmap: item #2 "Bulk select" supersedes some of this, but batch-compose is a distinct feature |

## Rollout phases

### Phase 0 — Same-day MVP (today)

- New Batch tab, up to 15 rows, single active client.
- Per-row brief form including the new **Primary keyword** field.
- **Generate All** runs sequentially (not parallel) — simpler, ships today.
- SEO/GEO/AEO prompt additions active by default (no toggle).
- **Send All** with a Draft-or-Pending dropdown — Publish is never offered.
- Brief queue auto-saves to localStorage so a reload doesn't lose brief input.
- Errors surface via the existing `diagnoseError` + banner pipeline; no per-row retry polish yet.

### Phase 1 — Hardening (target: 3–4 days after MVP)

- One-at-a-time runs, in-flight progress bar, per-row retry button.
- Resume-safe on reload (generated content persists, stuck rows flip to error).
- Cost preview before Generate All.
- Existing diagnostics pipeline extended with batch contexts.

### Phase 2 — Quality of life (target: +1 week)

- **Bulk brief paste.** Paste a TSV/CSV or a markdown list; auto-split into rows.
- **Brief templates.** Save common brief skeletons per client (pool-opening, hot-tub-maintenance), instantiate into the batch.
- **Cancel mid-run.** Wire `AbortController` to the UI Cancel button.
- **Per-row cost display** post-generate (actual tokens used × model rate).
- **Diff view on regenerate** (stretch — reuses roadmap item #5).

### Phase 3 — Scale (target: when someone asks)

- **Cross-client batch.** Send the same brief to multiple clients (franchises, multi-brand). Requires a per-row client selector.
- **Anthropic Message Batches API** for jobs ≥ 50 posts. 50% cost reduction, ~1–2h latency. Needs a server-side poller since Netlify Functions time out at 10s (sync) / 15min (background).
- **Bulk scheduled publish.** "Send all 15, but stagger publish dates 2 days apart." Requires the WP future-status flow already present on single-post.

## Security considerations

- **No new credential flows.** Batch uses the active client's existing Application Password on every WP POST, exactly like single-post. No credentials are ever serialized into the batch queue JSON.
- **Persisted briefs are low-sensitivity** (editorial content, not PII), but the batch queue still lives in per-browser localStorage and is cleared by the existing Export/Import flow on client swap.
- **Rate-limit exposure.** Batch amplifies a compromised-browser scenario (a malicious actor could burn 15× the Anthropic quota per click vs 1×). This doesn't change the severity of the existing security roadmap item #4 (per-session rate limiting on `generate-stream.mjs`), but it raises its priority once batch ships.

## What v1 explicitly is NOT

- **Not cross-client.** One batch = one client. Cross-client is Phase 3.
- **Not a scheduled publisher.** The batch goes out as Draft or Pending Review, all at once. The client (or operator) approves on WordPress, which can then schedule publication. Staggered scheduling from our app is Phase 3.
- **Never auto-Publishes.** Batch can never push a post live — Publish status is intentionally excluded from the batch status dropdown. Going live stays a single-post, deliberate action.
- **Not a brief library.** Brief templates are Phase 2; v1 is freehand-only.
- **Not a cost-optimizer.** No auto-switch to cheaper models for low-risk briefs. The operator picks the model; we just show the estimate.
- **Not a review workflow.** Review happens in WordPress, same as single-post. We are not replicating comment threads, approvals, or status transitions in our UI.

## Demo script (5 minutes, for the team)

1. **Open the tool, switch to Batch tab.** *(10s)* Show the empty state. Explain: "This is where you stage multiple posts for one client's month."
2. **Click +Add brief five times.** *(10s)* Empty rows appear numbered 1–5, each with a `draft` pill.
3. **Fill row 1 fully, row 2 fully, row 3 partially.** *(60s)* Rows 1 and 2 flip to `ready`; row 3 stays `draft`. Point out the per-row status indicator.
4. **Click Generate All.** *(60–90s)* Progress bar appears. Watch pills flip `ready → generating → generated`. Row 3 skipped (still `draft`). Announce the final summary: "2 generated, 0 failed."
5. **Click a generated row to expand.** *(30s)* Show the editable title and content. Make a small edit. Point out the auto-save.
6. **Pick Pending Review from the status dropdown and click Send all.** *(30s)* Pills flip `generated → publishing → sent`. Final banner: "2 sent for client review." (Point out the dropdown offers only Draft or Pending — Publish is not an option here.)
7. **Open the client's WordPress admin in a side tab.** *(30s)* Point to Posts → Pending: the two new drafts are there, ready for the client to approve.
8. **Reload the page.** *(15s)* Batch tab is preserved — rows and their statuses persist. This is the resumability story.
9. **Demo an error.** *(45s)* Break an Application Password temporarily, click Retry on a row, show the diagnostic banner naming the exact problem, then restore and retry successfully.

**Total: ~5 minutes.** This is short because the feature is a direct composition of existing primitives — the novelty is the staging and orchestration, not new infrastructure.

## Success metrics (to evaluate after 2 weeks of use)

1. **Time-to-publish-N:** median wall-clock time from opening the tool to N posts live as Pending on WordPress. Target: 10 posts in ≤ 12 minutes (vs ~45 today).
2. **Error rate:** fraction of rows needing manual retry. Target: < 5% over a full batch.
3. **Operator-reported friction:** one qualitative check-in with Lisa after 2 batches. Ship changes for anything hit twice.
4. **Cost predictability:** estimated vs actual Anthropic spend per batch within ±15%.

## Open questions

- **Row limit — 15 the right number?** Picked to cover a monthly calendar with slack. If 15 feels small in practice, raise to 25; beyond that, the Anthropic Message Batches API becomes more attractive than sync fan-out.
- **Resume policy on `publishing`-phase interruption.** Current plan: mark as `error` + `INTERRUPTED` and require operator to verify in WordPress before retry. Alternative: best-effort GET to check if the post exists. The second is slicker but introduces a new failure mode.
- **Should batch briefs auto-inherit the last-used brief as a template?** Operators writing monthly pool-maintenance content may want each row pre-filled with the previous month's structure. Defer to Phase 2.
- **Rate-limit on `generate-stream.mjs` (security roadmap #4).** If we ship batch first, we widen the abuse surface. Sequencing suggestion: ship batch behind a feature flag, land rate-limiting within the same week.
