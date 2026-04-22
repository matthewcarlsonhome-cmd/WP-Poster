# BATCH-DESIGN.md — Batch brief entry and bulk Pending-Review publish

*Design for the "write 15 posts in one sitting, push them all to WordPress as Pending Review" workflow. Read DESIGN-DOC.md first — this builds on the single-post architecture and reuses its primitives.*

## One-line summary

A new **Batch** tab that lets one operator stage up to 15 briefs for the active client, generate them all in one run, review/edit, then publish the entire set to WordPress as Pending Review — with per-row progress, per-row retry, and resume-on-reload.

## Why now

Today's flow is one-at-a-time: fill brief → Generate → review → Publish → repeat. For an operator working a single client's monthly editorial calendar (8–15 posts), the context-switching and waiting between each post is the bottleneck. Compressing the "fill briefs" phase (can be done offline, pasted in bulk) from the "generate" phase (parallelizable) from the "publish" phase (one-shot) cuts a typical 45-minute session to ~10 minutes and makes client-approval handoff a single action.

## Design goals

1. **Stage before spend.** Briefs can be drafted, reordered, edited, and saved without touching the Anthropic API. You pay only when you click Generate All.
2. **One client per batch, many posts.** v1 does not support "same brief to three clients." See *What v1 explicitly is NOT*.
3. **Pending Review is the default and the only status.** The point of batching is reviewer-handoff. Draft, Publish, and Scheduled remain available on the single-post flow.
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
     → one-at-a-time with configurable concurrency (default 3)
5. Review. Click any row to expand the generated post and edit inline.
6. Click "Send all to WordPress as Pending Review"
     → per-row publishing → published/error pill
     → final summary: "13 sent, 2 failed (retry)"
7. Client sees all 13 in their WP Posts → Pending queue.
```

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
        key: "", must: "", cta: "", length: "medium"
      },
      // populated after generate:
      generated: { title: "...", content: "<p>...</p>" } | null,
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
   d. Run a bounded-concurrency loop (default 3):
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

4. Click "Send all to WordPress as Pending Review"
   a. Guard: at least one row with status == 'generated'.
   b. For each generated row (bounded concurrency 3):
        - status → 'publishing', persist
        - Build WP body: { title, content: sanitizeHtml(content), status: 'pending' }
        - apiCall('batch-publish', active.url + '/wp-json/wp/v2/posts', {...})
        - On success: row.wpPostId, row.wpPostUrl set, status = 'published'
        - On failure: row.lastError, status = 'error'
        - Persist after each row.
   c. Render summary banner with count + link to client's WP Pending queue.
```

**Cancellation.** `state.batch.abortController` is wired into every fetch. "Cancel" button flips all `generating`/`publishing` rows back to their prior status and records `lastError = {code: 'ABORTED'}`.

**Resume on reload.** On page load, if `state.batch.running` was true and any row is stuck in `generating` or `publishing`, that row is flipped to `error` with `code: 'INTERRUPTED'` — safer than silently retrying a request we don't know the outcome of (a `publishing` row may have succeeded on WP but we never saw the response).

## Concurrency, rate limits, and cost

**Concurrency.** Default 3 parallel requests per phase. Anthropic's tier-1 rate limit on Sonnet is well above 3 req/s; 3 gives us headroom for retries. Configurable per-user in Settings if we find the default wrong.

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
| `netlify/functions/generate.js` | **No change.** Single-prompt contract is sufficient; batching is client-side. |
| `CLAUDE.md`                     | Add a note in the localStorage-migrations section about `batch-queue-v1` |
| `DESIGN-DOC.md`                 | Cross-link in the Functionality Roadmap: item #2 "Bulk select" supersedes some of this, but batch-compose is a distinct feature |

## Rollout phases

### Phase 1 — MVP (target: 3–4 days of work)

- New Batch tab, up to 15 rows, single active client, Generate All + Publish All (Pending only)
- Bounded concurrency (3), in-flight progress bar, per-row error + retry
- Persist batch queue to localStorage, resume-safe on reload
- Existing diagnostics pipeline

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
- **Rate-limit exposure.** Batch amplifies a compromised-browser scenario (a malicious actor could burn 15× the Anthropic quota per click vs 1×). This doesn't change the severity of the existing security roadmap item #4 (per-session rate limiting on `generate.js`), but it raises its priority once batch ships.

## What v1 explicitly is NOT

- **Not cross-client.** One batch = one client. Cross-client is Phase 3.
- **Not a scheduled publisher.** The batch goes out as Pending Review, all at once. The client approves on WordPress (which can itself schedule publication). Staggered scheduling from our app is Phase 3.
- **Not a brief library.** Brief templates are Phase 2; v1 is freehand-only.
- **Not a cost-optimizer.** No auto-switch to cheaper models for low-risk briefs. The operator picks the model; we just show the estimate.
- **Not a review workflow.** Review happens in WordPress, same as single-post. We are not replicating comment threads, approvals, or status transitions in our UI.

## Demo script (5 minutes, for the team)

1. **Open the tool, switch to Batch tab.** *(10s)* Show the empty state. Explain: "This is where you stage multiple posts for one client's month."
2. **Click +Add brief five times.** *(10s)* Empty rows appear numbered 1–5, each with a `draft` pill.
3. **Fill row 1 fully, row 2 fully, row 3 partially.** *(60s)* Rows 1 and 2 flip to `ready`; row 3 stays `draft`. Point out the per-row status indicator.
4. **Click Generate All.** *(60–90s)* Progress bar appears. Watch pills flip `ready → generating → generated`. Row 3 skipped (still `draft`). Announce the final summary: "2 generated, 0 failed."
5. **Click a generated row to expand.** *(30s)* Show the editable title and content. Make a small edit. Point out the auto-save.
6. **Click Send all to WordPress as Pending Review.** *(30s)* Pills flip `generated → publishing → published`. Final banner: "2 sent for client review."
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
- **Rate-limit on `generate.js` (security roadmap #4).** If we ship batch first, we widen the abuse surface. Sequencing suggestion: ship batch behind a feature flag, land rate-limiting within the same week.
