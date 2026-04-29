# TIER2-PLAN.md — Server-side client storage migration plan

*An execution plan for moving client profiles off browser localStorage and onto Netlify Blobs + Identity. Read DESIGN-DOC.md "Shared-storage roadmap" first — this is the implementation half of the Tier 2 plan documented there.*

## Why this is a separate doc, not just a session of code

Tier 2 introduces auth as a hard runtime dependency. A botched migration can lock Lisa out of the tool, leak credentials, or both. Three things must be decided BEFORE writing code:

1. **Auth choice.** Netlify Identity, Netlify Auth (the newer thing), Auth0, Clerk, custom-rolled, or none-with-a-shared-secret. Each has cost, lock-in, UX, and revocation implications.
2. **Migration strategy** for browsers that already have client profiles in localStorage. Auto-upload vs. operator-initiated vs. nothing.
3. **Schema** for the Blobs key/value layout — flat `clients` blob vs. one blob per client, indexes, audit trail row.

This document captures the open decisions, the architectural choices that depend on them, and the implementation plan once they're answered.

## Open decisions (need operator input)

### D1 — Auth provider

| Option | Pros | Cons | Cost |
|---|---|---|---|
| **Netlify Identity (legacy)** | Built-in, free, JWT-based, Netlify hosts the login page | Deprecated; new sites can no longer enable it | $0 |
| **Netlify Auth (new)** | Active product, Netlify-managed | Still maturing; check current limits/pricing | check pricing page |
| **Auth0** | Mature, generous free tier, easy SDK | More complex setup; vendor lock-in | $0 up to 7,500 MAU |
| **Clerk** | Great UX, good docs, easy SDK | Vendor lock-in; pricing scales | $0 up to 10,000 MAU |
| **Shared-secret header** | Simplest possible — one env var | No per-user audit trail, no individual revocation, no MFA | $0 |

**My recommendation:** Auth0 for v1 (mature, generous free tier, individual revocation, JWT integrates cleanly with Netlify Functions). If a third operator joins inside the year, Auth0's MAU pricing is still effectively free.

If Lisa is the only other operator and audit trail isn't required, **shared-secret** is half a day of work and might be the right answer for now. Revisit when a third operator joins or compliance asks.

**Recommended decision: pick Auth0 OR shared-secret. Don't try to land both.**

### D2 — Migration strategy

| Option | Operator experience | Risk |
|---|---|---|
| **Auto-upload on first authenticated load** | Seamless. App detects local clients, pushes them to Blobs, clears localStorage. | Two browsers with diverging local state hit a merge conflict on first sync — last-uploader wins. |
| **One-shot Export → Upload to Tier 2** | Operator clicks a button explicitly. | Requires the operator to remember to do it. If they don't, they keep editing locally and drift. |
| **Read-only first** | Tier 2 reads only; localStorage stays the source of truth for writes until manual cutover. | Doubles complexity for weeks. Probably not worth it. |

**My recommendation:** Auto-upload, scoped to the FIRST browser that authenticates. Subsequent browsers just download. If two browsers race the first-load (unlikely with two operators), accept "last write wins" — the export-import flow can paper over any actual conflict.

Pre-migration: ask Lisa to NOT edit clients on the day of the migration. Belt + suspenders.

### D3 — Blobs schema

| Option | Pros | Cons |
|---|---|---|
| **One blob: all clients** | Simple. Single read/write. | Concurrent writes race; entire blob rewritten on every change. |
| **One blob per client (key = `client:<id>`)** | Concurrent writes don't race. Per-client retention. | Need an index blob (or a list operation) to enumerate. |
| **Single blob + per-client audit log blob** | Audit trail captured for free. | More complexity. |

**My recommendation:** One blob per client + a small `clients-index` blob listing IDs. Netlify Blobs supports `list()` natively (no index needed) but the index keeps client ordering deterministic. ~50 LOC of helper code in `_clients.js`.

## Implementation plan once D1–D3 are answered

### Step 1 — Decide D1, D2, D3 (estimate: 30 min meeting)

Output: a paragraph in this doc with the decisions.

### Step 2 — New Netlify Function `clients.js` (estimate: 2 hours)

`netlify/functions/clients.js` — CRUD over the `clients` Blobs store.

- `GET /.netlify/functions/clients` → returns `{clients: [...]}` for authenticated user.
- `POST /.netlify/functions/clients` → upsert one client (body is the client profile).
- `DELETE /.netlify/functions/clients/:id` → remove.
- Auth check: validate JWT (D1) on every request; reject with 401 if missing/invalid.
- Reuses `_shared.js` for CORS + response shape.
- Reuses `_ratelimit.js` (different bucket: `client-store:<userId>`).

Tests in `tests/clients.test.js` — pure JWT verification helpers + Blobs schema validators. The Blobs read/write is verified end-to-end after deploy.

### Step 3 — Browser auth integration (estimate: 1.5 hours)

- Add the auth provider's SDK to `index.html` (CSP allowlist update if needed).
- New `auth.js` module: `getCurrentUser()`, `signIn()`, `signOut()`, `getAuthHeader()`.
- Topbar: replace "Connected: <client>" with "Signed in as <user> | <client>" + a sign-out link.
- Block the rest of the app on a "Sign in to continue" splash if no user.

### Step 4 — Browser storage adapter (estimate: 1 hour)

`storage.js`:
- Two backends: `localStorageBackend` (Tier 1) and `blobsBackend` (Tier 2).
- `state.storageBackend` selected at boot based on auth presence.
- Same `loadClients()` / `saveClient()` / `deleteClient()` / `listClients()` API regardless of backend.
- All existing call sites in `app.js` (currently `localStorage.setItem(STORAGE_KEYS.clients, ...)`) become `storage.saveClient(c)`.

### Step 5 — One-shot migration on first authenticated load (estimate: 30 min)

```js
async function migrateLocalToTier2() {
  if (!auth.user) return;
  const local = JSON.parse(localStorage.getItem(STORAGE_KEYS.clients) || '[]');
  if (local.length === 0) return;
  const remote = await storage.listClients();
  if (remote.length > 0) return; // someone else already migrated
  for (const c of local) await storage.saveClient(c);
  localStorage.removeItem(STORAGE_KEYS.clients);
  logEvent('info', 'tier2-migration', 'Migrated ' + local.length + ' clients to Tier 2');
}
```

### Step 6 — Deprecate Export/Import (estimate: 15 min)

- The button still works (renders a JSON file from current data).
- Add a banner in the Clients tab: "Tier 2 is live — Export/Import is no longer needed. Use it only as a backup."
- Don't remove the code yet; remove after one month of stable Tier 2 use.

### Step 7 — Documentation (estimate: 30 min)

- README.md — update onboarding (no more "send JSON over Signal").
- DESIGN-DOC.md — mark Tier 2 ✅ shipped, list Tier 1 as deprecated.
- CLAUDE.md — add a section on the auth flow + Blobs schema, especially the JWT-validation gotcha (clock skew, expired tokens).

## Estimated total: ~6 hours of focused work

Plus the 30-min decisions session. Realistic to complete in one focused day.

## What it doesn't change

- **WordPress credentials still travel browser-direct.** Application Passwords go from the browser to that client's WP site, never through our backend. Tier 2 is about where the *credentials are stored*, not where they're used.
- **Anthropic key stays server-side.** No change.
- **Single-post drafts and batch/campaign queues** stay in browser localStorage. Drafts are working content, not credentials; per-browser state is appropriate. (Roadmap item #14 — IndexedDB for drafts — is a separate project.)

## Risk register

| Risk | Mitigation |
|---|---|
| Auth provider outage locks every operator out | Add a "Use local backup" mode that falls back to the last cached `localStorage` copy of clients. Read-only, but the operator can still publish. |
| Blobs outage blocks credential reads | Same fallback as above. Cache last-good clients list in `localStorage` even after migration. |
| JWT expires mid-session (operator gets 401 on next save) | Auto-refresh on 401, with one retry. If refresh fails, surface "session expired, sign in again." |
| Operator signs in on a new device with no migration history | App detects empty Tier 2 + populated localStorage and offers "Upload these N profiles to your account." Same migration step as Step 5, manually-triggered. |
| Stale Tier 1 export file gets re-imported on top of Tier 2 | Import flow checks if Tier 2 is active and warns: "You're connected to Tier 2 — do you want to overwrite the server with this file?" Default to NO. |

## Decision log

(Fill in once D1–D3 are answered.)

- D1 (auth provider): _TBD — recommend Auth0 or shared-secret_
- D2 (migration strategy): _TBD — recommend auto-upload on first authenticated load_
- D3 (Blobs schema): _TBD — recommend one blob per client + index_
