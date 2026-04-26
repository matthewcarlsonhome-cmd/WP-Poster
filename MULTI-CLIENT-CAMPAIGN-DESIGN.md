# MULTI-CLIENT-CAMPAIGN-DESIGN.md — one topic, many client sites

## One-line summary

The **Campaign** workflow lets one operator write one shared blog concept once, select multiple client WordPress sites, generate localized client-specific versions, review/edit each version, and send every generated post to its own site as Draft or Pending Review.

Example:

- Shared topic: "Benefits of relaxing in hot tubs"
- Client A: Houston hot tub dealer → "Benefits of relaxing in hot tubs in Houston"
- Client B: Miami hot tub dealer → "Benefits of relaxing in hot tubs in Miami"

The posts share the same core campaign message, but each version uses that client's voice guide, local market, keyword, CTA, and site credentials.

## Why this exists

Batch solves **many posts for one client**.

Campaign solves **one post concept for many clients**.

These should stay separate because the operator's mental model is different:

- Batch: monthly content calendar for Acme Pools
- Campaign: same seasonal/service idea localized across several clients

## Current implementation

The current implementation is a fast client-side MVP:

- New **Campaign** tab
- Shared campaign brief:
  - topic
  - keyword template with `{market}`
  - shared angle
  - must-include notes
  - default CTA
  - length
- Client picker from existing client profiles
- One generated row per selected client
- Per-client row fields:
  - local market
  - primary keyword
  - client/local specifics
- Per-client generated draft:
  - title
  - meta description
  - HTML content
  - SEO notes
- Generate all with bounded concurrency of 3
- Send all as Draft or Pending Review only
- Per-row retry for generate/send
- Cancel in-flight campaign run
- Persisted localStorage queue under `wp-publisher-campaign-v1`

No server changes were needed. The existing `/.netlify/functions/generate` proxy is still sufficient.

## Data model

```js
{
  version: 1,
  model: "claude-sonnet-4-6",
  brief: {
    topic: "Benefits of relaxing in hot tubs",
    keywordTemplate: "benefits of hot tubs in {market}",
    angle: "Hot tubs help people relax, sleep better, and reconnect at home.",
    must: "Mention hydrotherapy, stress relief, year-round use.",
    cta: "Visit the showroom or schedule a consultation.",
    length: "medium"
  },
  rows: [
    {
      id: "mc_<random>",
      clientId: "c_<client>",
      market: "Houston",
      primaryKeyword: "benefits of hot tubs in Houston",
      localNotes: "Mention humid evenings, backyard patios, and showroom visits.",
      status: "ready" | "generating" | "generated" |
              "publishing" | "published" | "error",
      generated: {
        title: "...",
        metaDescription: "...",
        content: "<p>...</p>",
        seoNotes: "..."
      } | null,
      wpPostId: 123 | null,
      wpPostUrl: "https://..." | null,
      lastError: {
        phase: "generate" | "publish",
        code: "...",
        message: "...",
        ts: 1714000000000
      } | null
    }
  ],
  updatedAt: 1714000000000
}
```

## Prompt strategy

Each generated row gets its own prompt. The prompt combines:

1. The target client's voice guide and sample paragraph
2. The shared campaign brief
3. The row's local market, primary keyword, and local notes
4. SEO/GEO/AEO instructions
5. A strict JSON output contract

The prompt explicitly asks Claude to preserve the core message while localizing examples, climate/use cases, service-area language, CTA, and phrasing. This reduces duplicate-content risk and keeps each post aligned with the selected client.

## Send strategy

Campaign sends each row to the row's own client WordPress URL using that client's saved username and Application Password. The body sent to WordPress is:

```js
{
  title: generated.title,
  content: sanitizeHtml(generated.content),
  status: "draft" | "pending",
  excerpt: generated.metaDescription
}
```

Campaign intentionally does not offer live Publish. Multi-site publishing has too much blast radius for a one-click live action.

## Fast MVP limitations

- One saved campaign per browser
- No structured CSV import yet
- No automatic client market field in client profiles
- No duplicate detection after interrupted publish
- No actual token/cost capture yet
- No per-client image selection
- No cross-client scheduling or staggered publish dates

## Recommended next steps

1. Add `market`, `serviceArea`, and `defaultCTA` fields to client profiles so Campaign rows prefill more accurately.
2. Add a CSV import format: `clientName, market, keyword, localNotes`.
3. Capture Anthropic token usage per row and show actual campaign cost.
4. Add duplicate detection before retrying interrupted WordPress sends.
5. Add per-client Yoast/RankMath meta support instead of relying on `excerpt`.
6. Add "regenerate all failed" and "send all generated except selected" controls.
7. Add campaign templates for recurring topics such as hot tub relaxation, pool opening, maintenance checklists, and backyard design.
