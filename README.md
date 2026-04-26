# WordPress Publisher — multi-client edition

A self-hosted web tool for managing blog content across multiple client WordPress sites. Each client is a profile with its own URL, credentials, and voice guide. Draft with Claude, upload images, and publish to the selected client — all from one interface.

The app supports one-post-at-a-time drafting, a Batch workflow for staging up to 15 briefs for one client, and a Campaign workflow for generating localized versions of one shared topic across multiple client sites.

## Architecture

- **Static frontend** hosted on Netlify: HTML/CSS/JS
- **One Netlify Function** (`generate.js`) proxies Claude API calls — API key is server-side only
- **Client credentials** stored per-client in the user's browser localStorage
- **Batch queue** stored in the user's browser localStorage; generated batch content survives reloads
- **No shared database** — each user maintains their own client profiles in their own browser
- **History** reads directly from each client's WordPress REST API — no separate log

## Security notes — please read

This build uses browser-stored WordPress credentials. Every client profile (URL, username, Application Password, voice guide) lives in the user's browser localStorage in plaintext. This is **Option A** in our architecture discussion — appropriate for pilot with up to ~5 clients. **Plan to migrate to Option C (server-side storage with a database) once active client count exceeds 5.**

The Anthropic API key is always server-side and never in the browser — that security boundary is preserved.

See "Security posture" section below for details.

## Client onboarding — once per client

For each client site you add, these steps must happen (one-time):

### 1. Generate a WordPress Application Password for the user account

On the client's WordPress site:
- Log in as the user who will post (ideally a new dedicated "SSP Publisher" account with Editor role)
- Go to **Users → Profile → Application Passwords**
- Name it something like "SSP Publisher — wp-poster"
- Copy the generated password (one-time display)

### 2. Add the Netlify origin to the client site's CORS config

Every client site needs `.htaccess` (or equivalent) updated to allow `https://wp-poster.netlify.app` to make REST API requests. Send this to their IT or server admin:

```apache
<IfModule mod_headers.c>
    SetEnvIf Origin "^https://wp-poster\.netlify\.app$" ALLOWED_ORIGIN=$0
    Header always set Access-Control-Allow-Origin "%{ALLOWED_ORIGIN}e" env=ALLOWED_ORIGIN
    Header always set Access-Control-Allow-Methods "GET, POST, OPTIONS, PUT, DELETE"
    Header always set Access-Control-Allow-Headers "Authorization, Content-Type, Content-Disposition"
    Header always set Access-Control-Allow-Credentials "true"
    Header always set Vary "Origin"
</IfModule>
```

On Apache, this block also typically needs the Authorization-header preservation rule if the server strips it:

```apache
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteCond %{HTTP:Authorization} ^(.+)$
    RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
</IfModule>
```

### 3. Add the client profile in the app

Open the tool → **Clients** tab → **+ Add client**:
- **Name**: for your reference (e.g. "Acme Pools")
- **Site URL**: https://clientsite.com (no trailing slash, no `/wp-admin/`)
- **Username**: the WP user you generated the password for
- **Application password**: paste the generated password
- **Voice guide + sample paragraph**: how this client writes (tone, preferred phrases, words to avoid)

Click **Test connection** before saving. If it succeeds, click **Save client**.

## Daily workflow

1. Pick the target client from the dropdown in the topbar
2. **Brief tab** → fill in the brief, including optional Keywords and Target area/location for SEO/local context
3. **Images tab** → upload pool images (go to that client's media library)
4. Click **Generate draft with Claude** — uses the active client's voice guide
5. Edit in **Draft tab**, pick featured image and tags
6. Select **Pending review** → **Send to WordPress**
7. Client approves in their WordPress dashboard under Posts → Pending

To switch clients mid-session, use the topbar dropdown. Context (brief, draft) resets; it doesn't carry over between clients.

## Batch workflow

1. Pick the target client from the dropdown in the topbar
2. Open **Batch** and add up to 15 briefs, or use **Bulk paste**
3. Fill each row's primary keyword plus title, angle, or key message
4. Click **Generate all**; rows generate with SEO/GEO/AEO structure and per-row diagnostics
5. Review/edit generated title, meta description, content, and SEO notes
6. Choose **Pending review** or **Draft**
7. Click **Send all to WordPress**

Batch never offers live Publish. Generated rows are persisted in this browser until the batch is cleared.

## Campaign workflow

Use Campaign when one topic should become localized posts for several clients.

1. Open **Campaign**
2. Enter the shared topic, keyword template, angle, must-include notes, CTA, and length
3. Select target clients
4. Click **Build campaign rows**
5. Fill or adjust each row's local market, primary keyword, and local notes
6. Click **Generate all**
7. Review/edit each generated client-specific version
8. Choose **Pending review** or **Draft**
9. Click **Send all to WordPress**

Campaign never offers live Publish. See `MULTI-CLIENT-CAMPAIGN-DESIGN.md` for design details and future improvements.

## Files

- `index.html` — UI
- `styles.css` — styling
- `app.js` — client profile management, draft generation, publishing, history
- `netlify.toml` — deploy config + security headers
- `netlify/functions/generate.js` — Anthropic proxy
- `.gitignore`
- `README.md` — this file

## Initial deploy (one-time, ~15 min)

### 1. Push to a private Git repo

```bash
cd wp-publisher
git init
git add .
git commit -m "Multi-client deploy"
git remote add origin https://github.com/YOUR_ORG/wp-publisher.git
git push -u origin main
```

### 2. Link repo to Netlify site `wp-poster`

- **Site settings → Build & deploy → Continuous deployment → Link site to Git**
- Pick repo, accept defaults

### 3. Set the SSP Anthropic API key

Get an SSP-scoped API key from Anthropic (see "Anthropic workspace setup" below), then:

- **Site settings → Environment variables → Add a variable**
- Key: `ANTHROPIC_API_KEY`
- Value: the SSP-scoped key
- Scope: **Functions only**
- Save, trigger a new deploy

## Anthropic workspace setup (for IT)

For the SSP-specific Anthropic key, request:

1. A **dedicated workspace** within the SSP Anthropic org (not a shared key)
2. A **monthly spending limit** on the workspace ($50/mo is plenty for current volume)
3. A **key with minimal scope** — just the message creation permission
4. Document the key location and rotation policy

This keeps SSP's Claude usage attributable, cost-capped, and independently revocable.

## Security posture

### What's locked down

| Surface | Protection |
|---|---|
| Anthropic API key | Server-side only, scoped to Netlify Functions |
| Function endpoint | CORS allowlist, origin check, model allowlist, token cap, prompt size cap |
| Claude HTML output → preview | Sanitizer strips scripts, events, dangerous URLs |
| Claude HTML output → WordPress | Same sanitizer applied before submission |
| Status message DOM injection | DOM APIs for trusted content; user input escaped |
| Site headers | Strict CSP, X-Frame-Options DENY, HSTS |

### What's in the browser

Each user's browser stores:
- List of client profiles (name, URL, username, Application Password, voice guide, sample paragraph) as JSON in localStorage
- Active client selection
- Preferred Claude model

No other sensitive data is kept. Session images and drafts are in memory only and cleared on reload or client switch.

### Risk model and mitigations

**Physical access to a user's laptop** — any user with access to the browser profile can read localStorage. *Mitigation:* disk encryption + screen lock + dedicated browser profile for this tool.

**Malicious browser extensions** — any extension with `storage` permission can read localStorage. *Mitigation:* audit user's extensions; use a dedicated browser profile.

**Compromised Netlify site** — if a Netlify account is compromised, the attacker could push malicious code that exfiltrates browser storage. *Mitigation:* Netlify account has 2FA; limit who has push access to the repo.

**Compromised WordPress site** — a compromised client WP site could be used to phish the Application Password by returning a specially-crafted error. *Mitigation:* we only fetch JSON responses; we never render HTML from the WP site.

**Lost/stolen laptop** — any active client profiles could be used by whoever has the device. *Mitigation:* Application Passwords can be revoked individually in WordPress, invalidating the password immediately.

### Credential rotation policy

| Credential | Rotation | How |
|---|---|---|
| Anthropic API key | Every 90 days | Revoke at console.anthropic.com → create new → update `ANTHROPIC_API_KEY` in Netlify → trigger redeploy |
| WordPress Application Password | Every 60-90 days per client | Revoke in WP → generate new → paste into client profile in app |

### Incident response

**User's laptop is lost or stolen:**
1. In each affected client's WordPress, go to Users → [user] → Application Passwords → revoke the SSP Publisher password for that client
2. Generate new Application Passwords
3. Update the client profiles in a trusted browser

**Anthropic key leak:**
1. Revoke the key at console.anthropic.com
2. Generate a new key
3. Update `ANTHROPIC_API_KEY` in Netlify → trigger redeploy

**Unexpected posts on a client site:**
1. Check the Queue tab for that client to see what was published and by which WP user
2. Revoke the Application Password immediately if suspicious
3. Audit the WP user's post history in WordPress admin

## When to migrate to Option C (server-side database)

Consider migrating when any of these happen:
- Active client count exceeds 5
- More than one team member is using the tool regularly
- An audit trail of "who at SSP published what" is required (not just who on WP)
- You want to pre-seed team members with client access instead of re-entering credentials per browser

Option C is a 1-2 day project: add a Netlify Function that talks to Netlify Blobs (or Supabase) and a thin auth layer (Netlify Identity works). The UI we built stays the same — we swap the storage backend behind the scenes.

## Troubleshooting

**"Failed to fetch"** on a client's Test Connection
→ That client's WP site doesn't have the Netlify CORS rule. See client onboarding step 2.

**"401 rest_not_logged_in"** despite correct credentials
→ Apache is stripping the Authorization header. Add the RewriteRule from client onboarding step 2.

**Generation works but draft is generic**
→ That client doesn't have a voice guide set. Go to Clients → Edit that client → fill in the voice guide.

**"Model not allowed" error**
→ Browser model choice doesn't match server allowlist. Usually happens after a model selector update — refresh the page.

**Can't see clients after switching browsers/devices**
→ Expected. Client profiles are per-browser. Either re-enter them, or migrate to Option C..
