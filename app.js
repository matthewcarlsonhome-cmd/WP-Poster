/*
 * =============================================================================
 * WordPress Publisher — multi-client blog automation
 * =============================================================================
 *
 * A static-frontend tool that lets one operator draft blog posts with Claude
 * and publish them to many client WordPress sites from a single interface.
 * Everything in this file runs in the browser.
 *
 * High-level flow
 * ---------------
 *   Brief form  ──►  Claude (via our Netlify Function)  ──►  HTML draft
 *                ──►  Draft editor + preview  ──►  WordPress REST API  ──►  Post
 *
 * Architecture summary
 * --------------------
 *   - One Netlify Function (netlify/functions/generate.js) proxies the
 *     Anthropic API. The API key lives server-side only; the browser never
 *     sees it. All other calls go browser ↔ WordPress directly.
 *
 *   - Client profiles (name, URL, WP username, Application Password, voice
 *     guide, sample paragraph) are stored per-browser in localStorage. This
 *     is "Option A" in our security design — fine for a pilot, but a migration
 *     to server-side storage is planned when active clients exceed ~5.
 *
 *   - No build step. index.html loads styles.css and app.js directly. Adding
 *     dependencies means adding <script> tags, which the CSP allowlist
 *     (script-src 'self') limits to same-origin files.
 *
 * Code organization (in order of appearance)
 * ------------------------------------------
 *    1. State           — module-scoped `state` + STORAGE_KEYS + endpoint const
 *    2. Error module    — logEvent + apiCall + formatApiError + Activity log
 *    3. Persistence     — localStorage read/write + migrations
 *    4. Active client   — selector + connection indicator + per-tab label sync
 *    5. Tabs            — switchTab() + tab-specific hooks
 *    6. Clients         — CRUD + connection test + export/import
 *    7. Model           — Claude model selection + persistence
 *    8. Generate        — prompt assembly + Anthropic call + draft population
 *    9. Sanitization    — allowlist-based HTML safety for Claude output
 *   10. Editor          — textarea toolbar + HTML/Preview toggle
 *   11. Images          — upload to WP media library + featured-image picker
 *   12. Publish         — WP REST create-post call
 *   13. Queue           — per-client list view + trash button
 *   14. History         — parallel list across all clients
 *   15. Danger zone     — clear-all-data
 *   16. Utilities       — escapeText, showStatus, flashSaved
 *   17. Event wiring    — one DOMContentLoaded handler wires every listener
 *
 * Error handling contract
 * -----------------------
 *   Every backend call goes through apiCall(context, url, init), which:
 *     - Never throws. Returns {ok, status, code, message, data, durationMs}.
 *     - Parses WordPress, Anthropic, and our-own error shapes uniformly.
 *     - Logs request + response to the Activity tab AND to console.error.
 *
 *   Callers display failures with formatApiError(context, result), which
 *   produces "Context · HTTP 400 · rest_code · Human message" — enough to
 *   debug without opening DevTools.
 *
 * =============================================================================
 */

/* ---------- 1. state ---------- */

/**
 * The single source of truth for anything the UI needs to re-render from.
 * Module-scoped; not exposed globally. Tabs and handlers mutate this and
 * then call a render* function to reflect the change in the DOM.
 *
 *   clients          Array of client profiles. Persisted to localStorage.
 *                    Shape: {id, name, url, user, pass, voice, sample}
 *   activeClientId   Which client the UI is currently targeting. Persisted.
 *   images           Per-session uploads for the active client. In-memory
 *                    only; resets when switching clients or reloading.
 *   view             'html' | 'preview' — which view the draft editor shows.
 *   currentBrief     The last brief submitted to Claude. Kept for potential
 *                    re-generation; not persisted.
 *   model            Claude model ID. Persisted. Validated server-side
 *                    against generate.js's ALLOWED_MODELS set.
 *   editingClientId  When non-null, the client-editor form is in "edit"
 *                    mode for that client. Null = creating a new client.
 */
const state = {
  clients: [],
  activeClientId: null,
  images: [],
  view: 'html',
  currentBrief: null,
  model: 'claude-sonnet-4-6',
  editingClientId: null,
  batchQueue: null,
  batchOpenRows: new Set(),
  batchRun: { running: false, phase: null, abortController: null }
};

// localStorage keys. Centralized so migrations and cleanup have a single
// registry instead of scattered string literals across the codebase.
const STORAGE_KEYS = {
  clients: 'wp-publisher-clients',
  active:  'wp-publisher-active-client',
  model:   'wp-publisher-model',
  batch:   'wp-publisher-batch-queue-v1'
};

const BATCH_MAX_ROWS = 15;
const BATCH_CONCURRENCY = 3;
const BATCH_AUTOSAVE_MS = 400;
let batchAutosaveTimer = null;

// The one endpoint in our own backend. Everything else is a WordPress
// REST URL under the active client's site.
const GENERATE_ENDPOINT = '/.netlify/functions/generate';

/* ---------- 2. error handling & activity log ---------- */

// In-memory ring buffer of events — requests, errors, uploads, manual
// log entries. Cleared on page reload. 200 entries is plenty for a
// debugging session without eating meaningful memory.
const APP_LOG_MAX = 200;
const appLog = []; // [{ts, level, category, message, detail}] — newest first

/**
 * Append an event to the in-memory log AND mirror to the browser console.
 * Everything important goes through here — apiCall uses it, manual
 * logging in happy-path callers uses it, and errors are always logged
 * with full detail before being shown to the user.
 *
 *   level     'info' | 'warn' | 'error'
 *   category  Short tag like 'generate', 'publish', 'queue-delete'
 *   message   One-line human-readable summary
 *   detail    Optional object with full context (url, body, status, etc.)
 */
function logEvent(level, category, message, detail) {
  const entry = {
    ts: new Date(),
    level: level,
    category: category,
    message: message,
    detail: detail || null
  };
  appLog.unshift(entry);
  if (appLog.length > APP_LOG_MAX) appLog.length = APP_LOG_MAX;

  // Mirror to browser console so DevTools is always a source of truth
  const tag = '[' + category + ']';
  const args = detail ? [tag, message, detail] : [tag, message];
  if (level === 'error') console.error.apply(console, args);
  else if (level === 'warn') console.warn.apply(console, args);
  else console.log.apply(console, args);

  // Re-render the activity panel if it's the visible tab
  const panel = document.getElementById('tab-activity');
  if (panel && panel.classList.contains('active')) {
    renderActivityLog();
  }
  updateLogBadge();
}

function clearEventLog() {
  appLog.length = 0;
  renderActivityLog();
  updateLogBadge();
}

// Red pill on the Activity tab showing unread error count — so you know
// something went wrong without having to open the tab.
function updateLogBadge() {
  const badge = document.getElementById('activity-badge');
  if (!badge) return;
  const errCount = appLog.filter(function (e) { return e.level === 'error'; }).length;
  if (errCount === 0) {
    badge.classList.add('hidden');
    badge.textContent = '';
  } else {
    badge.classList.remove('hidden');
    badge.textContent = errCount > 99 ? '99+' : String(errCount);
  }
}

/**
 * Trims a URL for display: keeps origin + path, truncates the query.
 * Handles relative URLs. Never crashes on malformed input.
 */
function redactUrl(url) {
  try {
    const u = new URL(url, location.href);
    let display = u.origin + u.pathname;
    if (u.search) {
      display += u.search.length > 80 ? u.search.slice(0, 77) + '...' : u.search;
    }
    return display;
  } catch (_) {
    return url && url.length > 140 ? url.slice(0, 137) + '...' : (url || '');
  }
}

/**
 * Unified fetch wrapper. THE centerpiece of our error handling.
 *
 *   apiCall('queue-delete', url, { method: 'DELETE', headers: {...} })
 *     → { ok, status, data, code, message, durationMs }
 *
 * Normalises error bodies across the three backends we talk to:
 *   - WordPress REST:   { code, message, data: { status } }
 *   - Anthropic API:    { type: 'error', error: { type, message } }
 *   - Our own function: { error: '<string>' }
 *
 * Never throws — network errors and parse errors become result objects
 * with ok:false, so callers don't need try/catch around this.
 */
async function apiCall(context, url, init) {
  const method = (init && init.method) || 'GET';
  const t0 = performance.now();
  const display = redactUrl(url);

  logEvent('info', context, method + ' ' + display + ' — starting');

  let r;
  try {
    r = await fetch(url, init);
  } catch (e) {
    const dur = Math.round(performance.now() - t0);
    logEvent('error', context, 'Network error — ' + e.message, {
      url: display, method: method, error: String(e), durationMs: dur
    });
    return {
      ok: false, status: 0, code: 'NETWORK',
      message: e.message, data: null, durationMs: dur
    };
  }

  const dur = Math.round(performance.now() - t0);
  const ct = r.headers.get('content-type') || '';
  let data = null;
  if (ct.indexOf('application/json') !== -1) {
    try { data = await r.json(); } catch (_) { data = null; }
  } else {
    try { data = await r.text(); } catch (_) { data = null; }
  }

  if (r.ok) {
    logEvent('info', context, method + ' ' + display + ' -> ' + r.status + ' (' + dur + 'ms)');
    return { ok: true, status: r.status, data: data, code: null, message: null, durationMs: dur };
  }

  // Extract error code + message from known response shapes
  let code = null;
  let message = null;
  if (data && typeof data === 'object') {
    if (typeof data.code === 'string' && data.message) {          // WordPress
      code = data.code;
      message = data.message;
    } else if (data.error && typeof data.error === 'object') {    // Anthropic
      code = data.error.type || null;
      message = data.error.message || null;
    } else if (typeof data.error === 'string') {                  // Our proxy
      message = data.error;
    }
  } else if (typeof data === 'string' && data.trim()) {
    message = data.trim().slice(0, 300);
  }
  if (!message) message = '(no response body)';

  logEvent('error', context,
    method + ' -> ' + r.status + (code ? ' ' + code : '') + ' — ' + message,
    { url: display, method: method, status: r.status, code: code, message: message, body: data, durationMs: dur }
  );

  return { ok: false, status: r.status, code: code, message: message, data: data, durationMs: dur };
}

/**
 * Builds a human-readable one-line error suitable for a status banner.
 *   formatApiError('Generation failed', result)
 *     -> "Generation failed · HTTP 400 · invalid_request_error · model: ..."
 */
function formatApiError(context, result) {
  const parts = [context];
  if (result.status) parts.push('HTTP ' + result.status);
  else if (result.code === 'NETWORK') parts.push('network error');
  if (result.code && result.code !== 'NETWORK') parts.push(result.code);
  if (result.message) parts.push(result.message);
  return parts.join(' · ');
}

/**
 * Translate a raw apiCall failure into a human-readable diagnosis.
 *
 * Every branch below recognizes a SPECIFIC failure pattern we've seen in
 * production and explains it in operator language:
 *   - WHAT happened (one-sentence summary, no jargon)
 *   - WHY it happened (the likely cause, the top 1-3 suspects)
 *   - WHAT TO DO (a suggestion; sometimes a one-click fix button)
 *
 * Returns:
 *   {
 *     title:        short bolded headline for the banner
 *     summary:      one-sentence plain-English explanation
 *     explanation:  longer paragraph of context / probable cause
 *     hint:         optional "try this" nudge in italic
 *     fix:          optional { label, run } — renders a button that triggers run()
 *   }
 *
 * Add new branches as we encounter new failure modes in the wild. The
 * order matters — more specific patterns come before generic fallbacks.
 */
function diagnoseError(context, result) {
  const r = result;
  const msg = (r.message || '').trim();
  const code = r.code || '';
  const status = r.status || 0;

  // Helper: reset the saved model to the current default. Used by fix buttons
  // when a stale model ID is the problem.
  function resetModelToDefault() {
    const DEFAULT = 'claude-sonnet-4-6';
    localStorage.setItem(STORAGE_KEYS.model, DEFAULT);
    state.model = DEFAULT;
    const sel = document.getElementById('model-select');
    if (sel) sel.value = DEFAULT;
    updateModelLabel();
    logEvent('info', 'diagnostic-fix', 'Model reset to ' + DEFAULT);
  }

  // Pattern: model returned something that isn't parseable JSON even after
  // three fallback attempts (raw parse, fence strip, brace extract).
  // Typically seen with Haiku, which sometimes adds prose or malformed fences.
  if (code === 'MODEL_JSON_PARSE') {
    const modelLabel = ({
      'claude-haiku-4-5-20251001': 'Haiku 4.5',
      'claude-sonnet-4-6': 'Sonnet 4.6',
      'claude-opus-4-7': 'Opus 4.7'
    })[state.model] || state.model;
    return {
      title: 'Model output was not valid JSON',
      summary: modelLabel + " returned text we couldn't parse, even after stripping markdown fences and extracting braces.",
      explanation: "This is most common with Haiku — smaller models have weaker instruction-following for output format. The prompt asks for pure JSON; sometimes the response wraps it in ```json fences, adds a preamble like \"Here is the post:\", or splits it across the content in a way our parser can't recover. The raw output is in the Activity log under this error.",
      hint: 'Try regenerating — model output is non-deterministic, so the same brief often works on a second attempt. If it keeps failing, switch to Sonnet 4.6 (the next-up model) in Settings.'
    };
  }

  // Pattern: Anthropic rejects an unrecognized model ID.
  // Message looks like: "model: claude-sonnet-4-6-20250929"
  if (code === 'invalid_request_error' && /^model:/i.test(msg)) {
    const badModel = msg.replace(/^model:\s*/i, '').trim();
    return {
      title: "Claude doesn't recognize that model ID",
      summary: '"' + badModel + '" is not a current Anthropic model.',
      explanation: "This almost always means a stale preference from an older version of this app. The saved model ID needs to be updated to one Anthropic currently recognizes.",
      fix: { label: 'Reset model to Sonnet 4.6', run: resetModelToDefault }
    };
  }

  // Pattern: our own proxy rejects a model not on its allowlist.
  //
  // We treat this specially when the server echoed its current allowlist
  // (recent generate.js versions do this). If the model IS on the browser's
  // dropdown but NOT on the server's list, that's deploy skew — the
  // function didn't redeploy when the static assets did. Surface it
  // explicitly so the operator isn't left guessing.
  if (status === 400 && /^Model not allowed/i.test(msg)) {
    const serverAllowed = (r.data && Array.isArray(r.data.allowed)) ? r.data.allowed : null;
    const browserKnown = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-7'];
    const requested = (r.data && r.data.requested) || state.model;

    // Deploy skew: browser knows about the model, server doesn't
    if (serverAllowed && browserKnown.indexOf(requested) !== -1 && serverAllowed.indexOf(requested) === -1) {
      return {
        title: 'Server is running an older version (deploy skew)',
        summary: 'The browser is sending "' + requested + '", which the server rejects.',
        explanation:
          'This browser has the current model allowlist, but the Netlify Function (generate.js) is running an older deploy that doesn\'t include "' + requested + '".' +
          '\n\nServer currently accepts: ' + serverAllowed.join(', ') +
          '\n\nFix: push the latest generate.js and redeploy. Netlify Functions do NOT redeploy automatically when only static assets change — they need a function source change or an explicit redeploy trigger.',
        hint: 'Verify with: curl -X POST ' + location.origin + '/.netlify/functions/generate -H "Content-Type: application/json" -H "Origin: ' + location.origin + '" -d \'{"model":"' + requested + '","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}\''
      };
    }

    // Non-skew case (older server response without allowlist, or genuinely
    // misconfigured client) — fall back to the original message.
    return {
      title: 'That model is not on the server allowlist',
      summary: '"' + requested + '" is not approved by the server (generate.js).',
      explanation: "The Netlify Function has its own allowlist to prevent unauthorized model IDs from reaching Anthropic. " +
        (serverAllowed ? 'Server accepts: ' + serverAllowed.join(', ') + '. ' : '') +
        "Either this browser has a stale model preference, or the allowlist in generate.js needs updating.",
      fix: { label: 'Reset model to Sonnet 4.6', run: resetModelToDefault }
    };
  }

  // Pattern: server origin rejection.
  if (status === 403 && /origin not allowed/i.test(msg)) {
    return {
      title: "This browser's origin is not on the server allowlist",
      summary: 'The server only accepts requests from approved domains.',
      explanation: 'This typically happens during local development or when opening the app from a URL other than wp-poster.netlify.app. Check ALLOWED_ORIGINS in generate.js.'
    };
  }

  // Pattern: Anthropic rate limit.
  if (status === 429) {
    return {
      title: 'Anthropic rate limit hit',
      summary: 'Too many requests in a short window.',
      explanation: 'Wait 30-60 seconds and try again. If this happens regularly, check the Anthropic console for your organization\'s rate-limit tier.',
      hint: 'The Activity tab shows the last few requests with timestamps — useful for spotting bursts.'
    };
  }

  // Pattern: Anthropic authentication (only possible if the server-side
  // ANTHROPIC_API_KEY env var is invalid or missing on Netlify).
  if (status === 401 && code === 'authentication_error') {
    return {
      title: 'Anthropic rejected the server API key',
      summary: "The ANTHROPIC_API_KEY environment variable on Netlify is invalid, expired, or missing.",
      explanation: 'Go to Netlify → Site settings → Environment variables, confirm ANTHROPIC_API_KEY is set to a currently-active key from the Anthropic console, then trigger a redeploy (env-var changes don\'t apply to running functions until redeploy).'
    };
  }

  // Pattern: Anthropic insufficient credits / over budget.
  if (code === 'billing_error' || /insufficient.*credit/i.test(msg)) {
    return {
      title: 'Anthropic account out of credit',
      summary: 'The Anthropic organization has run out of prepaid credit or hit a spend cap.',
      explanation: 'Top up at console.anthropic.com → Billing, or raise the monthly spend limit.'
    };
  }

  // Pattern: WordPress — bad Application Password or username mismatch.
  if (status === 401) {
    return {
      title: 'WordPress rejected the credentials',
      summary: "The Application Password for this client isn't working.",
      explanation: 'Most common causes: (1) the password was revoked or regenerated in WP admin, (2) the username field doesn\'t match the user the password belongs to, (3) Apache is stripping the Authorization header — needs a RewriteRule in .htaccess (see README), or (4) a security plugin like WordFence or iThemes Security is blocking REST auth.',
      hint: 'Open Clients → Edit → "Test connection" to verify credentials in isolation.'
    };
  }

  // Pattern: WordPress — REST API disabled or wrong URL.
  if (code === 'rest_no_route' || (status === 404 && /rest_no_route/i.test(JSON.stringify(r.data || '')))) {
    return {
      title: 'WordPress REST API not reachable',
      summary: "The endpoint we called doesn't exist on this site.",
      explanation: 'Usually one of: (1) the REST API is disabled by a security plugin, (2) the client URL is wrong or missing /wp-json/, (3) permalinks are set to "Plain" (REST needs pretty permalinks).',
      hint: 'Open [clientURL]/wp-json/ in a browser — you should see a JSON API listing. If you see a 404 or the site homepage, the REST API is not responding.'
    };
  }

  // Pattern: WordPress — post not found (stale queue).
  if (code === 'rest_post_invalid_id' || (status === 404 && context.indexOf('queue') === 0)) {
    return {
      title: 'Post not found',
      summary: 'The post ID we tried to modify no longer exists.',
      explanation: "Someone deleted it in WP admin, or this Queue view is stale. Refresh the Queue to sync with what's actually on the site."
    };
  }

  // Pattern: WordPress — user lacks capability (e.g. Contributor trying to publish).
  if (status === 403 && code === 'rest_cannot_create') {
    return {
      title: 'This user cannot publish posts',
      summary: "The WordPress user tied to this Application Password doesn't have publish permission.",
      explanation: 'In WP admin → Users, find this user and confirm the role is Editor or Administrator. Contributor and Author roles have limited publishing rights.'
    };
  }

  // Pattern: generic network failure (fetch threw before getting a response).
  if (r.code === 'NETWORK') {
    return {
      title: "Couldn't reach the server",
      summary: 'The network request failed before any response came back.',
      explanation: 'Either the internet connection is down, CORS blocked the request (browser extension?), the destination server is unreachable, or the URL is malformed. Check your connection, then check the Activity tab for the full URL that was attempted.',
      hint: 'If you recently changed the client URL, make sure it starts with https:// and has no typos.'
    };
  }

  // Pattern: Anthropic payload too large (rare — the proxy caps earlier).
  if (status === 413) {
    return {
      title: 'Prompt too large',
      summary: 'The brief + voice guide + sample paragraph exceeded the server-side size limit.',
      explanation: 'The proxy caps total prompt size at 20,000 characters as a safety net. Shorten the voice guide or sample paragraph, or trim the brief.'
    };
  }

  // Pattern: Anthropic server error or unknown 5xx.
  if (status >= 500 && status < 600) {
    return {
      title: 'Upstream server error',
      summary: 'The server we called is having trouble right now.',
      explanation: 'This is usually transient. Wait 30-60 seconds and try again. If it persists, check status.anthropic.com (for generation) or the client\'s WordPress host status (for publish/queue).'
    };
  }

  // Fallback — still usable but less actionable.
  return {
    title: context + ' failed',
    summary: (status ? 'HTTP ' + status : 'Error') + (code ? ' · ' + code : ''),
    explanation: msg || '(no details in the response body)',
    hint: 'Open the Activity tab for the full request URL and response body.'
  };
}

/**
 * Render a rich error banner into a status element, combining:
 *   - bold title
 *   - plain-English summary
 *   - longer explanation (smaller text)
 *   - optional italic hint
 *   - optional fix button
 *
 * Use this in preference to showStatus() when the error is a failed
 * apiCall result. The Activity-log entry is already written by apiCall,
 * so the operator can still get the raw details if they want them.
 */
function showErrorBanner(elementId, context, result) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const diag = diagnoseError(context, result);

  el.className = 'status error error-rich';
  el.innerHTML = '';
  el.style.display = '';

  // Title
  const titleEl = document.createElement('div');
  titleEl.className = 'error-title';
  titleEl.textContent = diag.title;
  el.appendChild(titleEl);

  // Summary
  if (diag.summary) {
    const sumEl = document.createElement('div');
    sumEl.className = 'error-summary';
    sumEl.textContent = diag.summary;
    el.appendChild(sumEl);
  }

  // Explanation
  if (diag.explanation) {
    const expEl = document.createElement('div');
    expEl.className = 'error-explanation';
    expEl.textContent = diag.explanation;
    el.appendChild(expEl);
  }

  // Hint
  if (diag.hint) {
    const hintEl = document.createElement('div');
    hintEl.className = 'error-hint';
    hintEl.textContent = diag.hint;
    el.appendChild(hintEl);
  }

  // Actions row (fix button + "see Activity" link)
  const actions = document.createElement('div');
  actions.className = 'error-actions';

  if (diag.fix) {
    const fixBtn = document.createElement('button');
    fixBtn.className = 'btn btn-sm btn-primary';
    fixBtn.textContent = diag.fix.label;
    fixBtn.addEventListener('click', function () {
      try {
        diag.fix.run();
        fixBtn.disabled = true;
        fixBtn.textContent = '✓ ' + diag.fix.label;
      } catch (e) {
        logEvent('error', 'diagnostic-fix', 'Fix handler threw', { error: String(e) });
      }
    });
    actions.appendChild(fixBtn);
  }

  const activityLink = document.createElement('button');
  activityLink.className = 'btn btn-sm';
  activityLink.textContent = 'See Activity log';
  activityLink.addEventListener('click', function () { switchTab('activity'); });
  actions.appendChild(activityLink);

  el.appendChild(actions);
}

/**
 * Renders the Activity tab content from the in-memory log.
 * Each entry is a collapsible <details> so details stay hidden by
 * default — the list is scannable, but full JSON bodies are one click away.
 */
function renderActivityLog() {
  const container = document.getElementById('activity-list');
  if (!container) return;
  container.innerHTML = '';

  if (appLog.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No activity yet. Events from requests, errors, and uploads will appear here.';
    container.appendChild(empty);
    return;
  }

  appLog.forEach(function (entry) {
    const row = document.createElement('details');
    row.className = 'activity-row activity-' + entry.level;

    const summary = document.createElement('summary');
    const time = document.createElement('span');
    time.className = 'activity-time';
    time.textContent = entry.ts.toLocaleTimeString();
    const cat = document.createElement('span');
    cat.className = 'activity-cat';
    cat.textContent = entry.category;
    const msg = document.createElement('span');
    msg.className = 'activity-msg';
    msg.textContent = entry.message;
    summary.appendChild(time);
    summary.appendChild(cat);
    summary.appendChild(msg);
    row.appendChild(summary);

    if (entry.detail) {
      const detailBlock = document.createElement('div');
      detailBlock.className = 'activity-detail';

      const pre = document.createElement('pre');
      pre.className = 'activity-json';
      pre.textContent = JSON.stringify(entry.detail, null, 2);
      detailBlock.appendChild(pre);

      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn btn-sm';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', function () {
        const payload = [
          entry.ts.toISOString(),
          '[' + entry.level + '] [' + entry.category + ']',
          entry.message,
          JSON.stringify(entry.detail, null, 2)
        ].join('\n');
        navigator.clipboard.writeText(payload).then(function () {
          copyBtn.textContent = 'Copied';
          setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
        }).catch(function () {
          copyBtn.textContent = 'Copy failed';
        });
      });
      detailBlock.appendChild(copyBtn);

      row.appendChild(detailBlock);
    }

    container.appendChild(row);
  });
}

/* ---------- 3. persistence ---------- */

/**
 * Called once on page load. Reads everything we persist out of localStorage,
 * applies migrations for legacy values, and triggers the initial render.
 *
 * Each read is wrapped in try/catch because:
 *   - localStorage can throw SecurityError in private-mode browsers
 *   - JSON.parse can throw on corrupted values
 * On any error we silently fall back to the default state — a corrupt
 * save shouldn't brick the whole app.
 */
function loadStorage() {
  // Clean up keys from older versions of this app. Harmless if absent.
  ['wp-publisher-settings', 'wp-publisher-voice', 'wp-publisher-anthropic-key'].forEach(function (k) {
    try { localStorage.removeItem(k); } catch (e) {}
  });

  try {
    const c = localStorage.getItem(STORAGE_KEYS.clients);
    if (c) state.clients = JSON.parse(c) || [];
  } catch (e) {}

  try {
    const a = localStorage.getItem(STORAGE_KEYS.active);
    if (a) state.activeClientId = a;
  } catch (e) {}

  try {
    const m = localStorage.getItem(STORAGE_KEYS.model);
    if (m) {
      // Migration map for model IDs. When Anthropic renames a model or
      // we ship a typo, add an entry here and it self-heals on next load.
      const MODEL_MIGRATIONS = {
        'claude-sonnet-4-6-20250929': 'claude-sonnet-4-6'
      };
      const migrated = MODEL_MIGRATIONS[m] || m;
      if (migrated !== m) {
        localStorage.setItem(STORAGE_KEYS.model, migrated);
      }
      state.model = migrated;
      const sel = document.getElementById('model-select');
      if (sel) sel.value = migrated;
    }
  } catch (e) {}

  try {
    const b = localStorage.getItem(STORAGE_KEYS.batch);
    if (b) state.batchQueue = normalizeBatchQueue(JSON.parse(b));
  } catch (e) {
    state.batchQueue = null;
  }

  // If the saved active-client ID points to a client that no longer exists,
  // fall back to the first client or none.
  if (state.activeClientId && !getActiveClient()) {
    state.activeClientId = state.clients.length > 0 ? state.clients[0].id : null;
  } else if (!state.activeClientId && state.clients.length > 0) {
    state.activeClientId = state.clients[0].id;
  }

  updateModelLabel();
  renderClientSelector();
  renderClientList();
  updateActiveClientUI();
  recoverInterruptedBatchRows();
  renderBatch();
}

function persistClients() {
  localStorage.setItem(STORAGE_KEYS.clients, JSON.stringify(state.clients));
}

function persistActive() {
  if (state.activeClientId) {
    localStorage.setItem(STORAGE_KEYS.active, state.activeClientId);
  } else {
    localStorage.removeItem(STORAGE_KEYS.active);
  }
}

function getActiveClient() {
  return state.clients.find(function (c) { return c.id === state.activeClientId; }) || null;
}

// Client ID format: 'c_<random>_<timestamp-base36>'. Random part handles
// collisions within the same millisecond; timestamp makes IDs roughly
// sortable by creation time.
function generateClientId() {
  return 'c_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
}

/* ---------- 4. active client UI sync ---------- */

function renderClientSelector() {
  const sel = document.getElementById('active-client');
  sel.innerHTML = '';

  if (state.clients.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No clients yet';
    sel.appendChild(opt);
    return;
  }

  state.clients.forEach(function (c) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    if (c.id === state.activeClientId) opt.selected = true;
    sel.appendChild(opt);
  });
}

/**
 * Reconciles all UI surfaces that depend on which client is active:
 * connection indicator, Brief tab empty state, client name labels,
 * per-session image list.
 */
function updateActiveClientUI() {
  const active = getActiveClient();

  const ind = document.getElementById('conn-indicator');
  if (active) {
    ind.textContent = 'Connected: ' + active.name;
    ind.classList.remove('conn-off');
    ind.classList.add('conn-on');
  } else {
    ind.textContent = 'No client';
    ind.classList.remove('conn-on');
    ind.classList.add('conn-off');
  }

  const noClient = document.getElementById('no-client-brief');
  const briefContent = document.getElementById('brief-content');
  if (active) {
    noClient.classList.add('hidden');
    briefContent.classList.remove('hidden');
  } else {
    noClient.classList.remove('hidden');
    briefContent.classList.add('hidden');
  }

  const qn = document.getElementById('queue-client-name');
  const inn = document.getElementById('images-client-name');
  const bn = document.getElementById('batch-client-name');
  if (active) {
    if (qn) qn.textContent = active.name;
    if (inn) inn.textContent = active.name;
    if (bn) bn.textContent = active.name;
  } else {
    if (qn) qn.textContent = '—';
    if (inn) inn.textContent = '—';
    if (bn) bn.textContent = '—';
  }

  // Session images scoped to active client — reset on switch
  state.images = [];
  renderImages();
  updateFeaturedSelect();
  updateBriefImgList();
  renderBatch();
}

function setActiveClient(id) {
  state.activeClientId = id || null;
  persistActive();
  updateActiveClientUI();
  renderClientList();
  renderClientSelector();
}

/* ---------- 5. tabs ---------- */

function switchTab(name) {
  document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
  document.getElementById('tab-' + name).classList.add('active');
  document.querySelectorAll('.tab').forEach(function (t) {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  if (name === 'queue') loadQueue();
  if (name === 'batch') renderBatch();
  if (name === 'brief') updateBriefImgList();
  if (name === 'history') loadHistory();
  if (name === 'clients') renderClientList();
  if (name === 'activity') renderActivityLog();
}

function updateBriefImgList() {
  const el = document.getElementById('b-img-list');
  if (!el) return;
  if (state.images.length === 0) {
    el.textContent = 'No images attached yet';
    el.classList.add('muted');
  } else {
    el.textContent = state.images.map(function (i) { return i.name; }).join(', ');
    el.classList.remove('muted');
  }
}

/* ---------- 6. clients ---------- */

function renderClientList() {
  const list = document.getElementById('client-list');
  list.innerHTML = '';

  if (state.clients.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No clients yet. Click "+ Add client" to get started.';
    list.appendChild(empty);
    return;
  }

  state.clients.forEach(function (c) {
    const row = document.createElement('div');
    row.className = 'client-row';
    if (c.id === state.activeClientId) row.classList.add('active');

    const main = document.createElement('div');
    main.className = 'client-row-main';

    const name = document.createElement('div');
    name.className = 'client-row-name';
    name.textContent = c.name;

    const url = document.createElement('div');
    url.className = 'client-row-url';
    url.textContent = c.url;

    main.appendChild(name);
    main.appendChild(url);

    const actions = document.createElement('div');
    actions.className = 'client-actions';

    if (c.id !== state.activeClientId) {
      const activateBtn = document.createElement('button');
      activateBtn.className = 'btn btn-sm';
      activateBtn.textContent = 'Activate';
      activateBtn.addEventListener('click', function () { setActiveClient(c.id); });
      actions.appendChild(activateBtn);
    } else {
      const activeLbl = document.createElement('span');
      activeLbl.className = 'pill pill-published';
      activeLbl.textContent = 'Active';
      actions.appendChild(activeLbl);
    }

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-sm';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', function () { openClientEditor(c.id); });
    actions.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', function () { deleteClient(c.id); });
    actions.appendChild(delBtn);

    row.appendChild(main);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

/**
 * Opens the client-editor form, populated for an existing client (edit mode)
 * or empty (add mode). Sets state.editingClientId so saveClientFromForm
 * knows whether to create or update.
 */
function openClientEditor(id) {
  state.editingClientId = id || null;
  const editor = document.getElementById('client-editor');
  const title = document.getElementById('client-editor-title');

  if (id) {
    const c = state.clients.find(function (x) { return x.id === id; });
    if (!c) return;
    title.textContent = 'Edit client';
    document.getElementById('c-name').value = c.name || '';
    document.getElementById('c-url').value = c.url || '';
    document.getElementById('c-user').value = c.user || '';
    document.getElementById('c-pass').value = c.pass || '';
    document.getElementById('c-voice').value = c.voice || '';
    document.getElementById('c-sample').value = c.sample || '';
  } else {
    title.textContent = 'Add client';
    document.getElementById('c-name').value = '';
    document.getElementById('c-url').value = '';
    document.getElementById('c-user').value = '';
    document.getElementById('c-pass').value = '';
    document.getElementById('c-voice').value = '';
    document.getElementById('c-sample').value = '';
  }

  editor.classList.remove('hidden');
  editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  showStatus('client-editor-status', '', '');
  document.getElementById('client-editor-status').style.display = 'none';
}

function closeClientEditor() {
  document.getElementById('client-editor').classList.add('hidden');
  state.editingClientId = null;
}

function saveClientFromForm() {
  const name   = document.getElementById('c-name').value.trim();
  const url    = document.getElementById('c-url').value.trim().replace(/\/$/, '');
  const user   = document.getElementById('c-user').value.trim();
  const pass   = document.getElementById('c-pass').value.trim();
  const voice  = document.getElementById('c-voice').value.trim();
  const sample = document.getElementById('c-sample').value.trim();

  if (!name || !url || !user || !pass) {
    return showStatus('client-editor-status', 'Name, URL, username, and password are required.', 'error');
  }
  if (!/^https?:\/\//.test(url)) {
    return showStatus('client-editor-status', 'URL must start with http:// or https://', 'error');
  }

  if (state.editingClientId) {
    const idx = state.clients.findIndex(function (c) { return c.id === state.editingClientId; });
    if (idx !== -1) {
      state.clients[idx] = Object.assign({}, state.clients[idx],
        { name: name, url: url, user: user, pass: pass, voice: voice, sample: sample });
    }
    logEvent('info', 'client', 'Updated client: ' + name);
  } else {
    const newClient = {
      id: generateClientId(),
      name: name, url: url, user: user, pass: pass, voice: voice, sample: sample
    };
    state.clients.push(newClient);
    if (!state.activeClientId) state.activeClientId = newClient.id;
    logEvent('info', 'client', 'Added client: ' + name);
  }

  persistClients();
  persistActive();
  closeClientEditor();
  renderClientList();
  renderClientSelector();
  updateActiveClientUI();
}

function deleteClient(id) {
  const c = state.clients.find(function (x) { return x.id === id; });
  if (!c) return;
  if (!confirm('Delete "' + c.name + '"?\n\nThis removes the profile from this browser only. WordPress Application Passwords are not revoked — do that in WP admin separately if needed.')) {
    return;
  }
  state.clients = state.clients.filter(function (x) { return x.id !== id; });
  if (state.activeClientId === id) {
    state.activeClientId = state.clients.length > 0 ? state.clients[0].id : null;
  }
  persistClients();
  persistActive();
  renderClientList();
  renderClientSelector();
  updateActiveClientUI();
  logEvent('info', 'client', 'Deleted client: ' + c.name);
}

/**
 * Ping the WP REST "me" endpoint with the entered credentials to verify
 * the Application Password works. Used BEFORE saving so the user doesn't
 * end up with a broken profile.
 */
async function testClientConnection() {
  const url  = document.getElementById('c-url').value.trim().replace(/\/$/, '');
  const user = document.getElementById('c-user').value.trim();
  const pass = document.getElementById('c-pass').value.trim();

  if (!url || !user || !pass) {
    return showStatus('client-editor-status', 'Fill in URL, username, and password first.', 'error');
  }

  const btn = document.getElementById('test-client-btn');
  btn.innerHTML = '<span class="spinner"></span>Testing...';
  btn.disabled = true;

  const result = await apiCall('test-connection', url + '/wp-json/wp/v2/users/me', {
    headers: { 'Authorization': 'Basic ' + btoa(user + ':' + pass) }
  });
  if (result.ok) {
    const u = result.data;
    showStatus('client-editor-status',
      'Connected as ' + escapeText(u.name) + ' (user ID ' + u.id + ')', 'success');
  } else {
    showErrorBanner('client-editor-status', 'Connection failed', result);
  }
  btn.textContent = 'Test connection';
  btn.disabled = false;
}

/**
 * Export all client profiles to a downloadable JSON file.
 *
 * The export INCLUDES Application Passwords (Tier 1 of our shared-storage
 * roadmap — see DESIGN-DOC.md). This is safe for trusted file handoff
 * (1Password share, Signal, Slack DM) but MUST NOT be emailed.
 *
 * Filename is prefixed "DO-NOT-EMAIL" as a visual warning. The moment we
 * migrate to Tier 2 (Netlify Blobs + Identity), this function should be
 * deprecated in favor of server-side sync.
 */
function exportClients() {
  if (state.clients.length === 0) {
    return showStatus('clients-io-status', 'No clients to export.', 'warning');
  }

  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    // activeClientId is NOT exported — each workstation picks its own active
    clients: state.clients
  };

  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ssp-clients-DO-NOT-EMAIL-' + stamp + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

  logEvent('info', 'clients-io', 'Exported ' + state.clients.length + ' client(s)');
  showStatus('clients-io-status',
    'Exported ' + state.clients.length + ' client(s). Share via 1Password or encrypted channels only.',
    'success');
}

/**
 * Import client profiles from a JSON file produced by exportClients().
 *
 * Merge strategy by URL match:
 *   - If an incoming client's URL matches an existing one, UPDATE in place
 *     (preserves the local ID so activeClientId doesn't dangle).
 *   - Otherwise ADD as a new client with a freshly-generated ID.
 *
 * Incoming IDs are ignored — we always generate fresh ones locally to
 * avoid collisions across workstations.
 */
function importClientsFromFile(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    let payload;
    try {
      payload = JSON.parse(e.target.result);
    } catch (err) {
      logEvent('error', 'clients-io', 'Import parse failed', { error: err.message });
      return showStatus('clients-io-status', 'Could not parse file: ' + escapeText(err.message), 'error');
    }

    if (!payload || !Array.isArray(payload.clients)) {
      logEvent('error', 'clients-io', 'Invalid import payload shape', { payload: payload });
      return showStatus('clients-io-status', 'File is not a valid clients export.', 'error');
    }

    if (payload.schemaVersion && payload.schemaVersion > 1) {
      return showStatus('clients-io-status',
        'File was exported by a newer version (schema v' + payload.schemaVersion + '). Please update the app.',
        'error');
    }

    let added = 0;
    let updated = 0;
    const skipped = [];

    payload.clients.forEach(function (inc) {
      if (!inc || !inc.name || !inc.url || !inc.user || !inc.pass) {
        skipped.push(inc && inc.name ? inc.name : '(unnamed)');
        return;
      }
      const cleanUrl = String(inc.url).trim().replace(/\/$/, '');
      const existing = state.clients.find(function (c) {
        return c.url.replace(/\/$/, '') === cleanUrl;
      });
      if (existing) {
        existing.name = inc.name;
        existing.user = inc.user;
        existing.pass = inc.pass;
        existing.voice = inc.voice || '';
        existing.sample = inc.sample || '';
        updated++;
      } else {
        state.clients.push({
          id: generateClientId(),
          name: inc.name,
          url: cleanUrl,
          user: inc.user,
          pass: inc.pass,
          voice: inc.voice || '',
          sample: inc.sample || ''
        });
        added++;
      }
    });

    if (!state.activeClientId && state.clients.length > 0) {
      state.activeClientId = state.clients[0].id;
    }

    persistClients();
    persistActive();
    renderClientList();
    renderClientSelector();
    updateActiveClientUI();

    const summary = added + ' added, ' + updated + ' updated' +
      (skipped.length > 0 ? ', ' + skipped.length + ' skipped (missing fields)' : '');
    logEvent('info', 'clients-io', 'Import complete: ' + summary, {
      added: added, updated: updated, skipped: skipped
    });
    showStatus('clients-io-status', 'Import complete: ' + summary, 'success');
  };
  reader.onerror = function () {
    logEvent('error', 'clients-io', 'FileReader error', { error: String(reader.error) });
    showStatus('clients-io-status', 'Could not read file.', 'error');
  };
  reader.readAsText(file);
}

/* ---------- 7. model ---------- */

function saveModel() {
  const sel = document.getElementById('model-select');
  state.model = sel.value;
  localStorage.setItem(STORAGE_KEYS.model, state.model);
  updateModelLabel();
  flashSaved('model-saved');
}

// Keep this labels map in sync with the <option> values in index.html
// AND the ALLOWED_MODELS set in generate.js — three places that must match.
function updateModelLabel() {
  const el = document.getElementById('current-model-label');
  if (!el) return;
  const labels = {
    'claude-haiku-4-5-20251001': 'Haiku 4.5',
    'claude-sonnet-4-6': 'Sonnet 4.6',
    'claude-opus-4-7': 'Opus 4.7'
  };
  el.textContent = labels[state.model] || state.model;
}

function flashSaved(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('hidden');
  setTimeout(function () { el.classList.add('hidden'); }, 2000);
}

/* ---------- 8. draft generation ---------- */

/**
 * The main "Generate draft with Claude" handler.
 *
 * Assembles a single-turn prompt from:
 *   1. The active client's voice guide + optional sample paragraph
 *      (so output matches each client's tone, not a generic house style)
 *   2. The brief form (title/audience/angle/key message/must-include/CTA)
 *   3. A filename list of any images uploaded this session, so Claude can
 *      place <img src="filename.jpg"> inline. We post-process those src
 *      attributes to substitute the real WP media URLs.
 *
 * The prompt instructs Claude to return strict JSON ({title, content})
 * with no markdown fences. Any deviation produces an Activity-log entry
 * with full detail and a one-line status banner on the Brief card.
 *
 * Output is sanitized before being placed in the editor, and AGAIN before
 * publish, as defense-in-depth against a prompt-injected model.
 */
async function generateFromBrief() {
  const active = getActiveClient();
  if (!active) {
    return showStatus('brief-status', 'Select or add a client first.', 'error');
  }

  const brief = {
    title:    document.getElementById('b-title').value.trim(),
    audience: document.getElementById('b-audience').value.trim(),
    angle:    document.getElementById('b-angle').value.trim(),
    key:      document.getElementById('b-key').value.trim(),
    must:     document.getElementById('b-must').value.trim(),
    cta:      document.getElementById('b-cta').value.trim(),
    length:   document.getElementById('b-length').value
  };

  if (!brief.angle && !brief.key) {
    return showStatus('brief-status', 'Please fill in at least the angle or key message.', 'error');
  }
  state.currentBrief = brief;

  const wc = { short: 300, medium: 600, long: 1000 }[brief.length];
  const btn = document.getElementById('gen-btn');
  btn.innerHTML = '<span class="spinner"></span>Generating draft...';
  btn.disabled = true;

  // Voice guide + sample come FIRST so the model sees the target style
  // before the instructional content.
  let prompt = 'You are writing a blog post for ' + active.name + '. Follow their voice guide strictly.\n\n';
  if (active.voice)  prompt += 'VOICE GUIDE:\n' + active.voice + '\n\n';
  if (active.sample) prompt += 'SAMPLE PARAGRAPH (match this rhythm and tone):\n' + active.sample + '\n\n';
  prompt += 'BRIEF:\n';
  if (brief.title)    prompt += '- Working title: ' + brief.title + '\n';
  if (brief.audience) prompt += '- Audience: ' + brief.audience + '\n';
  if (brief.angle)    prompt += '- Angle: ' + brief.angle + '\n';
  if (brief.key)      prompt += '- Key message: ' + brief.key + '\n';
  if (brief.must)     prompt += '- Must include: ' + brief.must + '\n';
  if (brief.cta)      prompt += '- Call to action: ' + brief.cta + '\n';
  prompt += '- Length: approximately ' + wc + ' words\n\n';

  if (state.images.length > 0) {
    prompt += 'AVAILABLE IMAGES (reference by filename for placement):\n';
    state.images.forEach(function (img) { prompt += '- ' + img.name + '\n'; });
    prompt += '\nPlace images inline using <img src="FILENAME" alt="descriptive alt text"> tags. I will substitute the real URLs from the filename.\n\n';
  }

  prompt += 'Return valid HTML using <h2>, <h3>, <p>, <ul>/<ol>/<li>, <strong>, <em>, <blockquote>, <a>, <img>. No <html> or <body> wrapper. Do NOT include <script>, <style>, <iframe>, event handlers, or javascript: URLs.\n\n';
  prompt += 'Respond ONLY with a JSON object (no markdown fences) with two keys: "title" (string) and "content" (string, the HTML). Nothing else.';

  const result = await apiCall('generate', GENERATE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: state.model,
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  try {
    if (!result.ok) {
      showErrorBanner('brief-status', 'Generation failed', result);
      return;
    }

    const data = result.data;
    if (!data || !Array.isArray(data.content)) {
      logEvent('error', 'generate', 'Unexpected response shape', { data: data });
      showStatus('brief-status', 'Generation failed · unexpected response shape (see Activity log)', 'error');
      return;
    }

    const raw = data.content.map(function (b) { return b.text || ''; }).join('').trim();
    const parseResult = parseJsonFromModel(raw);
    if (!parseResult.ok) {
      logEvent('error', 'generate', 'Model did not return valid JSON', {
        rawPrefix: raw.slice(0, 400),
        attempts: parseResult.attempts,
        finalError: parseResult.error
      });
      // Synthesize an apiCall-style result so the diagnostic layer can explain
      // this clearly, with a hint about switching to a stronger model.
      showErrorBanner('brief-status', 'Generation failed', {
        ok: false,
        status: 0,
        code: 'MODEL_JSON_PARSE',
        message: parseResult.error || 'Model output could not be parsed as JSON',
        data: { rawPrefix: raw.slice(0, 200) }
      });
      return;
    }
    const parsed = parseResult.value;

    // Sanitize, then substitute image filenames with real WP media URLs
    let content = sanitizeHtml(parsed.content || '');
    state.images.forEach(function (img) {
      const esc = img.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      content = content.replace(new RegExp('src=["\']' + esc + '["\']', 'g'), 'src="' + img.url + '"');
    });

    document.getElementById('post-title').value = (parsed.title || '').substring(0, 300);
    document.getElementById('editor').value = content;
    document.getElementById('no-draft-msg').classList.add('hidden');
    document.getElementById('draft-section').classList.remove('hidden');
    setView('html');
    toggleScheduleField();
    switchTab('draft');
    logEvent('info', 'generate', 'Draft populated (' + content.length + ' chars)');
  } finally {
    btn.textContent = 'Generate draft with Claude';
    btn.disabled = false;
  }
}

/* ---------- 9. HTML sanitization ---------- */

/**
 * Allowlist-based sanitizer for HTML output from Claude.
 *
 * WHY this exists: even with a trusted model, prompt injection through a
 * voice guide, sample paragraph, or brief field could cause the model to
 * emit a <script> tag, javascript: URL, or event handler. We run the
 * output through this function before:
 *   - Rendering it in the preview pane
 *   - Submitting it to WordPress
 *
 * WHY regex-based rather than DOMPurify: our CSP forbids external scripts,
 * and the set of tags we need to strip is small and well-known. A DOM-based
 * sanitizer would be safer but adds a dependency we don't currently need.
 */
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

function escapeText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Resilient JSON extractor for model responses.
 *
 * WHY this exists: our prompt says "Respond ONLY with a JSON object (no
 * markdown fences)" but smaller models — especially Haiku — frequently
 * ignore that constraint and return:
 *
 *     ```json
 *     { "title": "...", "content": "..." }
 *     ```
 *
 * Or occasionally add a preamble ("Here's the blog post:") before the JSON.
 * Rather than ship a prompt war we can never fully win, we parse defensively.
 *
 * Strategy (in order; first success wins):
 *   1. JSON.parse the raw string as-is.
 *   2. Strip ```json / ``` fences and retry.
 *   3. Find the first balanced {...} block in the string and parse that.
 *
 * Returns:
 *   { ok: true,  value: <parsed object> }           on success
 *   { ok: false, error: <message>, attempts: [..] } on failure (all three
 *                                                    stages tried and reported)
 *
 * The `attempts` array captures what each stage tried to parse, useful for
 * the Activity log when diagnosis is needed.
 */
function parseJsonFromModel(raw) {
  const attempts = [];

  // Stage 1 — parse as-is. This is what well-behaved models (Sonnet, Opus)
  // give us, and it's the fast path.
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e1) {
    attempts.push({ stage: 'raw', error: e1.message });
  }

  // Stage 2 — strip markdown code fences.
  // Matches:  ```json\n{...}\n```   or   ```\n{...}\n```   or variants with
  // trailing whitespace. Only strips if the string starts with a fence, to
  // avoid mangling content that happens to contain ``` internally.
  let stripped = raw.trim();
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

  // Stage 3 — find the first {...} that parses. Handles preamble/postamble
  // like "Here is the post: {...}" or "{...} Let me know if you want revisions."
  // We try progressively smaller substrings from the first { to the last }.
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

/* ---------- 10. editor controls ---------- */

function setView(v) {
  state.view = v;
  const ed = document.getElementById('editor');
  const pb = document.getElementById('preview-box');
  document.querySelectorAll('.vt-btn').forEach(function (b) {
    b.classList.toggle('active', b.dataset.view === v);
  });
  if (v === 'preview') {
    pb.innerHTML = sanitizeHtml(ed.value);
    pb.classList.remove('hidden');
    ed.classList.add('hidden');
  } else {
    pb.classList.add('hidden');
    ed.classList.remove('hidden');
  }
}

// Wrap the current textarea selection in opening/closing tags.
// Used by the H2/H3/B/I/blockquote toolbar buttons.
function wrapSelection(open, close) {
  const ed = document.getElementById('editor');
  const s = ed.selectionStart;
  const e = ed.selectionEnd;
  const sel = ed.value.substring(s, e);
  ed.value = ed.value.substring(0, s) + open + sel + close + ed.value.substring(e);
  ed.focus();
  ed.setSelectionRange(s + open.length, e + open.length);
}

function insertList(type) {
  const ed = document.getElementById('editor');
  const tag = type === 'ul' ? 'ul' : 'ol';
  const html = '<' + tag + '>\n  <li>Item 1</li>\n  <li>Item 2</li>\n</' + tag + '>\n';
  const s = ed.selectionStart;
  ed.value = ed.value.substring(0, s) + html + ed.value.substring(s);
  ed.focus();
}

function insertLink() {
  const ed = document.getElementById('editor');
  const url = prompt('Link URL:');
  if (!url) return;
  const text = prompt('Link text:', url) || url;
  const s = ed.selectionStart;
  const html = '<a href="' + escapeText(url) + '">' + escapeText(text) + '</a>';
  ed.value = ed.value.substring(0, s) + html + ed.value.substring(s);
  ed.focus();
}

function insertImageTag() {
  if (state.images.length === 0) {
    return alert('Upload images first via the Images tab.');
  }
  const names = state.images.map(function (i, idx) { return (idx + 1) + '. ' + i.name; }).join('\n');
  const pick = prompt('Which image? Type the number:\n\n' + names);
  const idx = parseInt(pick) - 1;
  if (isNaN(idx) || !state.images[idx]) return;
  const img = state.images[idx];
  const alt = prompt('Alt text:', '') || '';
  const ed = document.getElementById('editor');
  const s = ed.selectionStart;
  const html = '<img src="' + escapeText(img.url) + '" alt="' + escapeText(alt) + '">';
  ed.value = ed.value.substring(0, s) + html + ed.value.substring(s);
  ed.focus();
}

function insertHr() {
  const ed = document.getElementById('editor');
  const s = ed.selectionStart;
  ed.value = ed.value.substring(0, s) + '\n<hr>\n' + ed.value.substring(s);
  ed.focus();
}

function toggleScheduleField() {
  const st = document.getElementById('post-status').value;
  document.getElementById('schedule-field').classList.toggle('hidden', st !== 'future');
}

/* ---------- 11. images ---------- */

/**
 * Upload images to the active client's WP media library. Uses direct
 * binary body + Content-Disposition (not multipart) — simpler and WP
 * REST accepts both. The filename becomes the uploaded media's slug.
 */
async function handleFiles(files) {
  const active = getActiveClient();
  if (!active) return showStatus('upload-status', 'Select a client first.', 'error');

  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    showStatus('upload-status', '<span class="spinner"></span>Uploading ' + escapeText(file.name) + '...', 'info');
    const buf = await file.arrayBuffer();
    const result = await apiCall('upload', active.url + '/wp-json/wp/v2/media', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(active.user + ':' + active.pass),
        'Content-Type': file.type,
        'Content-Disposition': 'attachment; filename="' + file.name + '"'
      },
      body: buf
    });
    if (result.ok) {
      const data = result.data;
      state.images.push({
        id: data.id,
        name: file.name,
        url: data.source_url,
        thumb: (data.media_details && data.media_details.sizes && data.media_details.sizes.thumbnail && data.media_details.sizes.thumbnail.source_url) || data.source_url
      });
      renderImages();
      updateFeaturedSelect();
      updateBriefImgList();
      showStatus('upload-status', 'Uploaded: ' + escapeText(file.name), 'success');
    } else {
      showErrorBanner('upload-status', 'Upload failed — ' + file.name, result);
    }
  }
}

function renderImages() {
  const grid = document.getElementById('img-grid');
  grid.innerHTML = '';
  state.images.forEach(function (img, i) {
    const div = document.createElement('div');
    div.className = 'img-thumb';

    const imgEl = document.createElement('img');
    imgEl.src = img.thumb;
    imgEl.alt = img.name;

    const label = document.createElement('div');
    label.className = 'img-thumb-label';
    label.textContent = img.name;

    const del = document.createElement('button');
    del.className = 'img-thumb-del';
    del.textContent = '×';
    del.dataset.remove = String(i);

    div.appendChild(imgEl);
    div.appendChild(label);
    div.appendChild(del);
    grid.appendChild(div);
  });
}

// Removes from session only — does NOT delete from WP media library
// (the image may be in use on another post).
function removeImg(i) {
  state.images.splice(i, 1);
  renderImages();
  updateFeaturedSelect();
  updateBriefImgList();
}

function updateFeaturedSelect() {
  const sel = document.getElementById('feat-img');
  const cur = sel.value;
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = ''; none.textContent = 'None';
  sel.appendChild(none);
  state.images.forEach(function (img) {
    const opt = document.createElement('option');
    opt.value = String(img.id);
    opt.textContent = img.name;
    sel.appendChild(opt);
  });
  if (cur && state.images.find(function (i) { return String(i.id) === cur; })) {
    sel.value = cur;
  }
}

/* ---------- 12. publish ---------- */

/**
 * Send the drafted post to the active client's WordPress site.
 *
 * Four workflow modes:
 *   - draft     Private, only visible to the WP user
 *   - pending   Requires client approval before going live (default)
 *   - future    Scheduled — requires a datetime
 *   - publish   Goes live immediately
 */
async function publishPost() {
  const active = getActiveClient();
  if (!active) return showStatus('pub-status', 'Select a client first.', 'error');

  const title    = document.getElementById('post-title').value.trim();
  const content  = document.getElementById('editor').value.trim();
  if (!title || !content) return showStatus('pub-status', 'Title and content required.', 'error');
  const status   = document.getElementById('post-status').value;
  const tags     = document.getElementById('post-tags').value;
  const featId   = document.getElementById('feat-img').value;
  const scheduleVal = document.getElementById('post-schedule').value;

  if (status === 'future' && !scheduleVal) {
    return showStatus('pub-status', 'Pick a date/time to schedule.', 'error');
  }

  const btn = document.getElementById('pub-btn');
  btn.innerHTML = '<span class="spinner"></span>Sending...';
  btn.disabled = true;

  const body = { title: title, content: sanitizeHtml(content), status: status };
  if (featId) body.featured_media = parseInt(featId);
  if (tags.trim()) body.tags_input = tags;
  if (status === 'future') body.date = new Date(scheduleVal).toISOString();

  const result = await apiCall('publish', active.url + '/wp-json/wp/v2/posts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + btoa(active.user + ':' + active.pass)
    },
    body: JSON.stringify(body)
  });

  if (result.ok) {
    const labels = {
      draft: 'Saved as draft',
      pending: 'Sent for client review',
      future: 'Scheduled',
      publish: 'Published'
    };
    const lbl = labels[status] || 'Saved';
    const data = result.data;

    const statusEl = document.getElementById('pub-status');
    statusEl.className = 'status success';
    statusEl.textContent = lbl + ' on ' + active.name + '! ';
    if (data && data.link) {
      const a = document.createElement('a');
      a.href = data.link;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'View post →';
      statusEl.appendChild(a);
    }
    if (status === 'pending') {
      const note = document.createElement('div');
      note.className = 'small';
      note.textContent = 'The client can approve it in WordPress under Posts → Pending.';
      statusEl.appendChild(note);
    }
  } else {
    showErrorBanner('pub-status', 'Publish failed', result);
  }

  btn.textContent = 'Send to WordPress';
  btn.disabled = false;
}

/* ---------- 13. queue (active client only) ---------- */

/**
 * Load the 20 most recently-modified posts on the active client's site,
 * across draft/pending/future/publish. Trashed posts are excluded by
 * the status filter — that's how our Trash button makes deleted rows
 * disappear cleanly.
 */
async function loadQueue() {
  const active = getActiveClient();
  if (!active) return showStatus('queue-status', 'Select a client first.', 'error');

  const btn = document.getElementById('refresh-btn');
  btn.innerHTML = '<span class="spinner"></span>Loading...';
  btn.disabled = true;

  const result = await apiCall('queue-load',
    active.url + '/wp-json/wp/v2/posts?status=draft,pending,future,publish&per_page=20&orderby=modified',
    { headers: { 'Authorization': 'Basic ' + btoa(active.user + ':' + active.pass) } }
  );
  if (result.ok) {
    renderQueue(result.data);
    document.getElementById('queue-status').style.display = 'none';
  } else {
    showErrorBanner('queue-status', 'Could not load posts', result);
  }
  btn.textContent = 'Refresh';
  btn.disabled = false;
}

function renderQueue(posts) {
  const list = document.getElementById('queue-list');
  list.innerHTML = '';
  if (posts.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.style.padding = '16px 0';
    p.textContent = 'No posts yet.';
    list.appendChild(p);
    return;
  }
  const pillCls = { draft: 'pill-draft', pending: 'pill-pending', future: 'pill-scheduled', publish: 'pill-published' };
  const lbl = { draft: 'Draft', pending: 'Pending review', future: 'Scheduled', publish: 'Published' };

  posts.forEach(function (p) {
    const rawTitle = (p.title && p.title.rendered) || '(untitled)';
    const date = new Date(p.date).toLocaleString();

    const row = document.createElement('div');
    row.className = 'queue-row';

    const main = document.createElement('div');
    main.className = 'queue-row-main';

    // Decode HTML entities via textarea round-trip, then use textContent
    // (never innerHTML) so we can't XSS ourselves on the decoded value.
    const titleEl = document.createElement('div');
    titleEl.className = 'queue-title';
    const tmp = document.createElement('textarea');
    tmp.innerHTML = rawTitle;
    titleEl.textContent = tmp.value;

    const meta = document.createElement('div');
    meta.className = 'queue-meta';
    meta.textContent = date;

    main.appendChild(titleEl);
    main.appendChild(meta);

    const pill = document.createElement('span');
    pill.className = 'pill ' + (pillCls[p.status] || 'pill-draft');
    pill.textContent = lbl[p.status] || p.status;

    const link = document.createElement('a');
    link.href = p.link;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'btn btn-sm';
    link.textContent = 'Open';

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger queue-delete-btn';
    delBtn.textContent = 'Trash';
    delBtn.title = 'Move this post to WordPress Trash';
    const cleanTitle = tmp.value;
    delBtn.addEventListener('click', function () { deletePost(p.id, row, cleanTitle); });

    row.appendChild(main);
    row.appendChild(pill);
    row.appendChild(link);
    row.appendChild(delBtn);
    list.appendChild(row);
  });
}

/**
 * Move a post to WP trash (recoverable for 30 days) after confirmation.
 * We deliberately don't use ?force=true — the safety net matters more
 * than the cosmetic cleanup of full removal.
 */
async function deletePost(postId, rowElement, title) {
  const active = getActiveClient();
  if (!active) return showStatus('queue-status', 'No active client.', 'error');

  const displayTitle = title || '(untitled)';
  if (!confirm('Move "' + displayTitle + '" to Trash?\n\nYou can restore it from the WordPress admin under Posts → Trash.')) {
    return;
  }

  const delBtn = rowElement.querySelector('.queue-delete-btn');
  if (delBtn) {
    delBtn.disabled = true;
    delBtn.innerHTML = '<span class="spinner"></span>';
  }

  const result = await apiCall('queue-delete',
    active.url + '/wp-json/wp/v2/posts/' + encodeURIComponent(postId),
    {
      method: 'DELETE',
      headers: { 'Authorization': 'Basic ' + btoa(active.user + ':' + active.pass) }
    }
  );

  if (result.ok) {
    rowElement.style.transition = 'opacity 0.2s';
    rowElement.style.opacity = '0';
    setTimeout(function () {
      rowElement.remove();
      const list = document.getElementById('queue-list');
      if (list && list.children.length === 0) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.style.padding = '16px 0';
        p.textContent = 'No posts yet.';
        list.appendChild(p);
      }
    }, 200);
    showStatus('queue-status', 'Moved to Trash: ' + escapeText(displayTitle), 'success');
  } else {
    showErrorBanner('queue-status', 'Delete failed', result);
    if (delBtn) { delBtn.disabled = false; delBtn.textContent = 'Trash'; }
  }
}

/* ---------- 14. batch ---------- */

function emptyBatchQueue(clientId) {
  return {
    version: 1,
    clientId: clientId || null,
    model: state.model,
    rows: [],
    updatedAt: Date.now()
  };
}

function emptyBatchBrief() {
  return {
    title: '',
    audience: '',
    angle: '',
    key: '',
    must: '',
    cta: '',
    length: 'medium',
    primaryKeyword: '',
    secondaryKeywords: '',
    targetLocation: ''
  };
}

function normalizeBatchQueue(q) {
  if (!q || typeof q !== 'object' || !Array.isArray(q.rows)) return null;
  const clean = {
    version: 1,
    clientId: q.clientId || null,
    model: q.model || state.model,
    rows: [],
    updatedAt: q.updatedAt || Date.now()
  };
  q.rows.slice(0, BATCH_MAX_ROWS).forEach(function (row) {
    const brief = Object.assign(emptyBatchBrief(), row.brief || {});
    clean.rows.push({
      id: row.id || generateBatchRowId(),
      status: row.status || 'empty',
      brief: brief,
      generated: row.generated ? {
        title: row.generated.title || '',
        content: row.generated.content || '',
        metaDescription: row.generated.metaDescription || '',
        altTextSuggestions: Array.isArray(row.generated.altTextSuggestions) ? row.generated.altTextSuggestions : [],
        seoNotes: row.generated.seoNotes || ''
      } : null,
      wpPostId: row.wpPostId || null,
      wpPostUrl: row.wpPostUrl || null,
      lastError: row.lastError || null
    });
  });
  return clean;
}

function recoverInterruptedBatchRows() {
  if (!state.batchQueue) return;
  let changed = false;
  state.batchQueue.rows.forEach(function (row) {
    if (row.status === 'generating' || row.status === 'publishing') {
      const interruptedPhase = row.status === 'generating' ? 'generate' : 'publish';
      row.status = 'error';
      row.lastError = {
        phase: interruptedPhase,
        code: 'INTERRUPTED',
        message: 'The browser closed or reloaded while this row was in flight. Verify in WordPress before retrying a publish.',
        ts: Date.now()
      };
      changed = true;
    }
  });
  if (changed) persistBatchQueue();
}

function persistBatchQueue() {
  if (!state.batchQueue) {
    localStorage.removeItem(STORAGE_KEYS.batch);
    return;
  }
  state.batchQueue.updatedAt = Date.now();
  localStorage.setItem(STORAGE_KEYS.batch, JSON.stringify(state.batchQueue));
}

function ensureBatchQueueForActiveClient() {
  const active = getActiveClient();
  if (!active) return null;
  if (!state.batchQueue) {
    state.batchQueue = emptyBatchQueue(active.id);
    persistBatchQueue();
  }
  return state.batchQueue;
}

function generateBatchRowId() {
  return 'r_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
}

function createBatchRow(seed) {
  const active = getActiveClient();
  const brief = Object.assign(emptyBatchBrief(), seed || {});
  if (!brief.targetLocation && active && active.location) brief.targetLocation = active.location;
  return {
    id: generateBatchRowId(),
    status: 'empty',
    brief: brief,
    generated: null,
    wpPostId: null,
    wpPostUrl: null,
    lastError: null
  };
}

function isBatchBriefReady(row) {
  const b = row.brief || {};
  return !!(b.primaryKeyword && (b.angle || b.key || b.title));
}

function syncBatchRowStatus(row) {
  if (row.status === 'generating' || row.status === 'publishing' || row.status === 'published') return;
  if (row.generated && row.generated.title && row.generated.content) {
    row.status = 'generated';
  } else {
    row.status = isBatchBriefReady(row) ? 'ready' : 'empty';
  }
}

function batchStatusMeta(status) {
  const map = {
    empty:      { label: 'Draft', cls: 'pill-draft' },
    ready:      { label: 'Ready', cls: 'pill-pending' },
    generating: { label: 'Generating', cls: 'pill-generating' },
    generated:  { label: 'Generated', cls: 'pill-scheduled' },
    publishing: { label: 'Publishing', cls: 'pill-generating' },
    published:  { label: 'Sent', cls: 'pill-published' },
    error:      { label: 'Error', cls: 'pill-error' }
  };
  return map[status] || map.empty;
}

function estimateBatchCost(rows) {
  const model = state.batchRun.running && state.batchQueue ? state.batchQueue.model : state.model;
  const count = rows.filter(function (r) { return isBatchBriefReady(r); }).length;
  const rates = {
    'claude-haiku-4-5-20251001': { input: 1, output: 5 },
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-opus-4-7': { input: 5, output: 25 }
  };
  const rate = rates[model] || rates['claude-sonnet-4-6'];
  const inputTokens = 2500;
  const outputTokens = 1800;
  return count * ((inputTokens / 1000000) * rate.input + (outputTokens / 1000000) * rate.output);
}

function renderBatch() {
  const list = document.getElementById('batch-list');
  if (!list) return;
  const active = getActiveClient();
  const queue = state.batchQueue;
  const warning = document.getElementById('batch-client-warning');
  const countEl = document.getElementById('batch-row-count');
  const costEl = document.getElementById('batch-cost-estimate');
  const addBtn = document.getElementById('batch-add-row-btn');
  const genBtn = document.getElementById('batch-generate-btn');
  const sendBtn = document.getElementById('batch-send-btn');
  const cancelBtn = document.getElementById('batch-cancel-btn');

  list.innerHTML = '';
  if (warning) showStatus('batch-client-warning', '', '');

  const rows = queue ? queue.rows : [];
  if (countEl) countEl.textContent = rows.length + ' / ' + BATCH_MAX_ROWS;
  if (costEl) costEl.textContent = 'Est. cost: $' + estimateBatchCost(rows).toFixed(2);

  const mismatched = !!(active && queue && queue.clientId && queue.clientId !== active.id);
  if (!active) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Select or add a client before creating a batch.';
    list.appendChild(empty);
  } else if (mismatched) {
    const owner = state.clients.find(function (c) { return c.id === queue.clientId; });
    showStatus('batch-client-warning',
      'This saved batch belongs to ' + escapeText(owner ? owner.name : 'another client') + '. Clear it to start a new batch for ' + escapeText(active.name) + '.',
      'warning');
  } else if (!queue || rows.length === 0) {
    const emptyRow = document.createElement('div');
    emptyRow.className = 'empty-state';
    emptyRow.textContent = 'No batch briefs yet. Add a row or bulk paste a monthly content plan.';
    list.appendChild(emptyRow);
  } else {
    rows.forEach(function (row, idx) {
      syncBatchRowStatus(row);
      list.appendChild(renderBatchRow(row, idx));
    });
  }

  if (addBtn) addBtn.disabled = !active || mismatched || rows.length >= BATCH_MAX_ROWS || state.batchRun.running;
  if (genBtn) genBtn.disabled = !active || mismatched || rows.length === 0 || state.batchRun.running;
  if (sendBtn) sendBtn.disabled = !active || mismatched || rows.filter(function (r) { return r.status === 'generated'; }).length === 0 || state.batchRun.running;
  if (cancelBtn) cancelBtn.classList.toggle('hidden', !state.batchRun.running);
  renderBatchProgress();
}

function renderBatchRow(row, idx) {
  const wrapper = document.createElement('div');
  wrapper.className = 'batch-row';
  if (!isBatchBriefReady(row)) wrapper.classList.add('incomplete');
  wrapper.dataset.rowId = row.id;

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'batch-row-head';
  head.dataset.action = 'toggle';
  head.dataset.rowId = row.id;

  const num = document.createElement('div');
  num.className = 'batch-row-num';
  num.textContent = '#' + (idx + 1);

  const title = document.createElement('div');
  title.className = 'batch-row-title';
  const main = document.createElement('div');
  main.className = 'batch-row-title-main';
  main.textContent = (row.generated && row.generated.title) || row.brief.title || row.brief.angle || '(untitled brief)';
  const sub = document.createElement('div');
  sub.className = 'batch-row-title-sub';
  sub.textContent = row.brief.primaryKeyword ? row.brief.primaryKeyword : 'Primary keyword required';
  title.appendChild(main);
  title.appendChild(sub);

  const meta = batchStatusMeta(row.status);
  const pill = document.createElement('span');
  pill.className = 'pill ' + meta.cls;
  pill.textContent = meta.label;

  head.appendChild(num);
  head.appendChild(title);
  head.appendChild(pill);
  wrapper.appendChild(head);

  if (state.batchOpenRows.has(row.id)) {
    const body = document.createElement('div');
    body.className = 'batch-row-body';
    appendBatchBriefFields(body, row);
    if (row.generated) appendBatchGeneratedFields(body, row);
    if (row.lastError) {
      const err = document.createElement('div');
      err.className = 'batch-row-error';
      err.textContent = row.lastError.phase + ' · ' + (row.lastError.code || 'ERROR') + ' · ' + row.lastError.message;
      body.appendChild(err);
    }
    appendBatchActions(body, row, idx);
    wrapper.appendChild(body);
  }
  return wrapper;
}

function appendBatchBriefFields(parent, row) {
  const fields = [
    ['title', 'Working title', 'text'],
    ['audience', 'Audience', 'text'],
    ['primaryKeyword', 'Primary keyword', 'text'],
    ['secondaryKeywords', 'Secondary keywords', 'text'],
    ['targetLocation', 'Target location', 'text'],
    ['angle', 'Angle', 'textarea'],
    ['key', 'Key message', 'textarea'],
    ['must', 'Must include', 'textarea'],
    ['cta', 'Call to action', 'text']
  ];
  fields.forEach(function (f) {
    const wrap = document.createElement('div');
    wrap.className = 'brief-row';
    const label = document.createElement('label');
    label.textContent = f[1];
    const input = f[2] === 'textarea' ? document.createElement('textarea') : document.createElement('input');
    if (f[2] !== 'textarea') input.type = 'text';
    else input.rows = 2;
    input.value = row.brief[f[0]] || '';
    input.dataset.rowId = row.id;
    input.dataset.field = f[0];
    input.dataset.scope = 'brief';
    wrap.appendChild(label);
    wrap.appendChild(input);
    parent.appendChild(wrap);
  });

  const lengthWrap = document.createElement('div');
  lengthWrap.className = 'brief-row';
  const lengthLabel = document.createElement('label');
  lengthLabel.textContent = 'Length';
  const lengthSelect = document.createElement('select');
  lengthSelect.dataset.rowId = row.id;
  lengthSelect.dataset.field = 'length';
  lengthSelect.dataset.scope = 'brief';
  [
    ['short', 'Short (500-700 words)'],
    ['medium', 'Medium (900-1,200 words)'],
    ['long', 'Long (1,400-1,800 words)']
  ].forEach(function (optDef) {
    const opt = document.createElement('option');
    opt.value = optDef[0];
    opt.textContent = optDef[1];
    if ((row.brief.length || 'medium') === opt.value) opt.selected = true;
    lengthSelect.appendChild(opt);
  });
  lengthWrap.appendChild(lengthLabel);
  lengthWrap.appendChild(lengthSelect);
  parent.appendChild(lengthWrap);
}

function appendBatchGeneratedFields(parent, row) {
  const generated = row.generated;
  const group = document.createElement('div');
  group.className = 'batch-generated-grid';

  const titleField = document.createElement('div');
  titleField.className = 'field';
  const titleLabel = document.createElement('label');
  titleLabel.className = 'lbl';
  titleLabel.textContent = 'Generated title';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = generated.title || '';
  titleInput.dataset.rowId = row.id;
  titleInput.dataset.scope = 'generated';
  titleInput.dataset.field = 'title';
  titleField.appendChild(titleLabel);
  titleField.appendChild(titleInput);
  group.appendChild(titleField);

  const metaField = document.createElement('div');
  metaField.className = 'field';
  const metaLabel = document.createElement('label');
  metaLabel.className = 'lbl';
  metaLabel.textContent = 'Meta description';
  const metaInput = document.createElement('textarea');
  metaInput.rows = 2;
  metaInput.value = generated.metaDescription || '';
  metaInput.dataset.rowId = row.id;
  metaInput.dataset.scope = 'generated';
  metaInput.dataset.field = 'metaDescription';
  const metaCount = document.createElement('div');
  metaCount.className = 'batch-meta-count' + ((generated.metaDescription || '').length > 160 ? ' over' : '');
  metaCount.textContent = (generated.metaDescription || '').length + ' / 160';
  metaField.appendChild(metaLabel);
  metaField.appendChild(metaInput);
  metaField.appendChild(metaCount);
  group.appendChild(metaField);

  const contentField = document.createElement('div');
  contentField.className = 'field';
  const contentLabel = document.createElement('label');
  contentLabel.className = 'lbl';
  contentLabel.textContent = 'Content';
  const contentInput = document.createElement('textarea');
  contentInput.className = 'batch-content-textarea';
  contentInput.value = generated.content || '';
  contentInput.dataset.rowId = row.id;
  contentInput.dataset.scope = 'generated';
  contentInput.dataset.field = 'content';
  contentField.appendChild(contentLabel);
  contentField.appendChild(contentInput);
  group.appendChild(contentField);

  const seoField = document.createElement('div');
  seoField.className = 'field';
  const seoLabel = document.createElement('label');
  seoLabel.className = 'lbl';
  seoLabel.textContent = 'SEO notes';
  const seoInput = document.createElement('textarea');
  seoInput.rows = 2;
  seoInput.value = generated.seoNotes || '';
  seoInput.dataset.rowId = row.id;
  seoInput.dataset.scope = 'generated';
  seoInput.dataset.field = 'seoNotes';
  seoField.appendChild(seoLabel);
  seoField.appendChild(seoInput);
  group.appendChild(seoField);

  const alt = document.createElement('div');
  alt.className = 'batch-alt-list';
  const altTitle = document.createElement('div');
  altTitle.className = 'lbl';
  altTitle.textContent = 'Alt text suggestions';
  alt.appendChild(altTitle);
  if (generated.altTextSuggestions && generated.altTextSuggestions.length) {
    const ul = document.createElement('ul');
    generated.altTextSuggestions.forEach(function (suggestion) {
      const li = document.createElement('li');
      li.textContent = suggestion;
      ul.appendChild(li);
    });
    alt.appendChild(ul);
  } else {
    const none = document.createElement('div');
    none.textContent = 'No alt text suggestions returned.';
    alt.appendChild(none);
  }
  group.appendChild(alt);

  parent.appendChild(group);
}

function appendBatchActions(parent, row, idx) {
  const actions = document.createElement('div');
  actions.className = 'batch-actions';
  [
    ['duplicate', 'Duplicate', 'btn btn-sm'],
    ['up', 'Move up', 'btn btn-sm'],
    ['down', 'Move down', 'btn btn-sm'],
    ['retry-generate', 'Retry generate', 'btn btn-sm'],
    ['retry-publish', 'Retry send', 'btn btn-sm'],
    ['remove', 'Remove', 'btn btn-sm btn-danger']
  ].forEach(function (def) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = def[2];
    btn.textContent = def[1];
    btn.dataset.action = def[0];
    btn.dataset.rowId = row.id;
    if (def[0] === 'up') btn.disabled = idx === 0 || state.batchRun.running;
    if (def[0] === 'down') btn.disabled = !state.batchQueue || idx === state.batchQueue.rows.length - 1 || state.batchRun.running;
    if (def[0] === 'retry-generate') btn.disabled = state.batchRun.running || !isBatchBriefReady(row);
    if (def[0] === 'retry-publish') btn.disabled = state.batchRun.running || !row.generated || row.status === 'published';
    if (def[0] === 'remove' || def[0] === 'duplicate') btn.disabled = state.batchRun.running;
    actions.appendChild(btn);
  });
  parent.appendChild(actions);
}

function addBatchRow(seed) {
  const queue = ensureBatchQueueForActiveClient();
  if (!queue) return showStatus('batch-status', 'Select a client first.', 'error');
  const active = getActiveClient();
  if (queue.clientId && active && queue.clientId !== active.id) {
    return showStatus('batch-status', 'Clear the existing batch before starting one for this client.', 'error');
  }
  if (queue.rows.length >= BATCH_MAX_ROWS) {
    return showStatus('batch-status', 'Batch limit is ' + BATCH_MAX_ROWS + ' rows.', 'warning');
  }
  const row = createBatchRow(seed);
  syncBatchRowStatus(row);
  queue.rows.push(row);
  state.batchOpenRows.add(row.id);
  persistBatchQueue();
  renderBatch();
}

function clearBatchQueue() {
  if (state.batchRun.running) return;
  if (state.batchQueue && state.batchQueue.rows.length > 0 &&
      !confirm('Clear this batch from this browser? Generated content and send results in the batch will be removed.')) {
    return;
  }
  const active = getActiveClient();
  state.batchQueue = active ? emptyBatchQueue(active.id) : null;
  state.batchOpenRows.clear();
  persistBatchQueue();
  renderBatch();
  showStatus('batch-status', 'Batch cleared.', 'success');
}

function getBatchRow(rowId) {
  if (!state.batchQueue) return null;
  return state.batchQueue.rows.find(function (r) { return r.id === rowId; }) || null;
}

function handleBatchInput(e) {
  const target = e.target;
  if (!target || !target.dataset || !target.dataset.rowId) return;
  const row = getBatchRow(target.dataset.rowId);
  if (!row) return;
  const scope = target.dataset.scope;
  const field = target.dataset.field;
  if (scope === 'brief') {
    row.brief[field] = target.value;
    if (row.status !== 'published') syncBatchRowStatus(row);
  } else if (scope === 'generated' && row.generated) {
    row.generated[field] = target.value;
    if (field === 'content') row.generated.content = sanitizeHtml(row.generated.content);
    if (row.status !== 'published') row.status = 'generated';
  }
  row.lastError = null;
  persistBatchQueue();
  renderBatch();
}

function handleBatchTyping(e) {
  const target = e.target;
  if (!target || !target.dataset || !target.dataset.rowId) return;
  const row = getBatchRow(target.dataset.rowId);
  if (!row) return;
  const scope = target.dataset.scope;
  const field = target.dataset.field;
  if (scope === 'brief') {
    row.brief[field] = target.value;
    if (row.status !== 'published') syncBatchRowStatus(row);
  } else if (scope === 'generated' && row.generated) {
    row.generated[field] = field === 'content' ? sanitizeHtml(target.value) : target.value;
    if (row.status !== 'published') row.status = 'generated';
  }
  row.lastError = null;
  clearTimeout(batchAutosaveTimer);
  batchAutosaveTimer = setTimeout(function () {
    persistBatchQueue();
    const countEl = document.getElementById('batch-row-count');
    const costEl = document.getElementById('batch-cost-estimate');
    const rows = state.batchQueue ? state.batchQueue.rows : [];
    if (countEl) countEl.textContent = rows.length + ' / ' + BATCH_MAX_ROWS;
    if (costEl) costEl.textContent = 'Est. cost: $' + estimateBatchCost(rows).toFixed(2);
  }, BATCH_AUTOSAVE_MS);
}

function handleBatchClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const rowId = btn.dataset.rowId;
  if (action === 'toggle') {
    if (state.batchOpenRows.has(rowId)) state.batchOpenRows.delete(rowId);
    else state.batchOpenRows.add(rowId);
    renderBatch();
    return;
  }
  const queue = state.batchQueue;
  const row = getBatchRow(rowId);
  if (!queue || !row) return;
  const idx = queue.rows.findIndex(function (r) { return r.id === rowId; });
  if (action === 'remove') {
    queue.rows.splice(idx, 1);
    state.batchOpenRows.delete(rowId);
    persistBatchQueue();
    renderBatch();
  } else if (action === 'duplicate') {
    if (queue.rows.length >= BATCH_MAX_ROWS) return showStatus('batch-status', 'Batch limit is ' + BATCH_MAX_ROWS + ' rows.', 'warning');
    const copy = createBatchRow(Object.assign({}, row.brief));
    if (row.generated) copy.generated = Object.assign({}, row.generated, { altTextSuggestions: row.generated.altTextSuggestions.slice() });
    syncBatchRowStatus(copy);
    queue.rows.splice(idx + 1, 0, copy);
    state.batchOpenRows.add(copy.id);
    persistBatchQueue();
    renderBatch();
  } else if (action === 'up' && idx > 0) {
    queue.rows.splice(idx - 1, 0, queue.rows.splice(idx, 1)[0]);
    persistBatchQueue();
    renderBatch();
  } else if (action === 'down' && idx < queue.rows.length - 1) {
    queue.rows.splice(idx + 1, 0, queue.rows.splice(idx, 1)[0]);
    persistBatchQueue();
    renderBatch();
  } else if (action === 'retry-generate') {
    runBatchGenerate([row]);
  } else if (action === 'retry-publish') {
    runBatchPublish([row]);
  }
}

function parseBatchBulkLine(line) {
  const parts = line.indexOf('\t') !== -1 ? line.split('\t') :
    (line.indexOf('|') !== -1 ? line.split('|') : line.split(','));
  const cleaned = parts.map(function (p) { return p.trim(); });
  if (cleaned.length <= 1) return { title: cleaned[0] || '', angle: cleaned[0] || '' };
  return {
    title: cleaned[0] || '',
    primaryKeyword: cleaned[1] || '',
    angle: cleaned[2] || '',
    key: cleaned[3] || '',
    cta: cleaned[4] || ''
  };
}

function addBulkBatchRows() {
  const input = document.getElementById('batch-bulk-input');
  if (!input) return;
  const lines = input.value.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
  if (lines.length === 0) return showStatus('batch-status', 'Paste at least one brief line.', 'warning');
  const queue = ensureBatchQueueForActiveClient();
  if (!queue) return;
  let added = 0;
  lines.forEach(function (line) {
    if (queue.rows.length >= BATCH_MAX_ROWS) return;
    const row = createBatchRow(parseBatchBulkLine(line));
    syncBatchRowStatus(row);
    queue.rows.push(row);
    state.batchOpenRows.add(row.id);
    added++;
  });
  input.value = '';
  persistBatchQueue();
  renderBatch();
  showStatus('batch-status', 'Added ' + added + ' brief' + (added === 1 ? '' : 's') + '.', 'success');
}

function buildBatchPrompt(active, row) {
  const b = row.brief;
  const wc = { short: '500-700', medium: '900-1,200', long: '1,400-1,800' }[b.length || 'medium'];
  let prompt = 'You are writing a blog post for ' + active.name + '. Follow their voice guide strictly.\n\n';
  if (active.voice)  prompt += 'VOICE GUIDE:\n' + active.voice + '\n\n';
  if (active.sample) prompt += 'SAMPLE PARAGRAPH (match this rhythm and tone):\n' + active.sample + '\n\n';
  prompt += 'BRIEF:\n';
  if (b.title) prompt += '- Working title: ' + b.title + '\n';
  if (b.audience) prompt += '- Audience: ' + b.audience + '\n';
  if (b.angle) prompt += '- Angle: ' + b.angle + '\n';
  if (b.key) prompt += '- Key message: ' + b.key + '\n';
  if (b.must) prompt += '- Must include: ' + b.must + '\n';
  if (b.cta) prompt += '- Call to action: ' + b.cta + '\n';
  prompt += '- Primary keyword: ' + b.primaryKeyword + '\n';
  if (b.secondaryKeywords) prompt += '- Secondary keywords: ' + b.secondaryKeywords + '\n';
  if (b.targetLocation) prompt += '- Target location: ' + b.targetLocation + '\n';
  prompt += '- Length: approximately ' + wc + ' words\n\n';

  if (state.images.length > 0) {
    prompt += 'AVAILABLE IMAGES (reference by filename for placement):\n';
    state.images.forEach(function (img) { prompt += '- ' + img.name + '\n'; });
    prompt += '\nPlace images inline using <img src="FILENAME" alt="descriptive alt text"> tags. I will substitute the real URLs from the filename.\n\n';
  }

  prompt += 'SEO / GEO / AEO OPTIMIZATION REQUIREMENTS\n\n';
  prompt += 'You are writing content that must perform in traditional search, generative search, and answer engines. Follow every rule unless it would produce unnatural prose.\n\n';
  prompt += '1. Open with a 40-60 word direct answer that stands alone and includes the primary keyword.\n';
  prompt += '2. Use the primary keyword naturally in the title, first 100 words, and 2-3 H2s. Use secondary keywords naturally.\n';
  prompt += '3. Include 3-5 H2 headings phrased as natural questions, each followed by a short self-contained answer. Include a 3-5 item FAQ near the end.\n';
  prompt += '4. Include citation-worthy facts: numbers, dates, materials, measurable claims, and clear declarative sentences when truthful. Avoid vague marketing superlatives.\n';
  prompt += '5. If a target location is provided, mention it 2-3 times naturally.\n';
  prompt += '6. Return a 150-160 character metaDescription containing the primary keyword and a click-worthy reason to read.\n';
  prompt += '7. Return altTextSuggestions with descriptive, keyword-aware alt text when images are relevant.\n\n';
  prompt += 'Return valid HTML using <h2>, <h3>, <p>, <ul>/<ol>/<li>, <strong>, <em>, <blockquote>, <a>, <img>. No <html> or <body> wrapper. Do NOT include <script>, <style>, <iframe>, event handlers, or javascript: URLs.\n\n';
  prompt += 'Respond ONLY with a JSON object matching this shape: {"title":"...","metaDescription":"...","content":"<post body as HTML>","altTextSuggestions":["..."],"seoNotes":"..."}.';
  return prompt;
}

async function apiCallWithRetry(context, url, init, attempts) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    if (init && init.signal && init.signal.aborted) {
      return { ok: false, status: 0, code: 'ABORTED', message: 'Request cancelled', data: null, durationMs: 0 };
    }
    last = await apiCall(context, url, init);
    if (last.ok || (last.status !== 429 && last.code !== 'NETWORK')) return last;
    if (init && init.signal && init.signal.aborted) return last;
    const delay = [2000, 4000, 8000][i] || 8000;
    await new Promise(function (resolve) { setTimeout(resolve, delay); });
  }
  return last;
}

async function runWithConcurrency(items, worker, onDone) {
  let next = 0;
  let completed = 0;
  async function loop() {
    while (next < items.length && state.batchRun.running) {
      const item = items[next++];
      await worker(item);
      completed++;
      if (onDone) onDone(completed, items.length);
    }
  }
  const workers = [];
  const n = Math.min(BATCH_CONCURRENCY, items.length);
  for (let i = 0; i < n; i++) workers.push(loop());
  await Promise.all(workers);
}

function startBatchRun(phase) {
  state.batchRun.running = true;
  state.batchRun.phase = phase;
  state.batchRun.abortController = new AbortController();
  renderBatch();
}

function finishBatchRun() {
  state.batchRun.running = false;
  state.batchRun.phase = null;
  state.batchRun.abortController = null;
  renderBatch();
}

function cancelBatchRun() {
  if (!state.batchRun.running) return;
  if (state.batchRun.abortController) state.batchRun.abortController.abort();
  const phase = state.batchRun.phase;
  if (state.batchQueue) {
    state.batchQueue.rows.forEach(function (row) {
      if (row.status === 'generating' || row.status === 'publishing') {
        row.status = row.generated ? 'generated' : (isBatchBriefReady(row) ? 'ready' : 'empty');
        row.lastError = { phase: phase, code: 'ABORTED', message: 'Cancelled by operator.', ts: Date.now() };
      }
    });
    persistBatchQueue();
  }
  finishBatchRun();
  showStatus('batch-status', 'Batch ' + phase + ' cancelled.', 'warning');
}

function renderBatchProgress(done, total, label) {
  const box = document.getElementById('batch-progress');
  const fill = document.getElementById('batch-progress-fill');
  const text = document.getElementById('batch-progress-label');
  if (!box || !fill || !text) return;
  if (!state.batchRun.running && typeof total === 'undefined') {
    box.classList.add('hidden');
    return;
  }
  const rows = state.batchQueue ? state.batchQueue.rows : [];
  const activeTotal = total || rows.filter(function (r) {
    return r.status === 'generating' || r.status === 'publishing' || r.status === 'generated' || r.status === 'published' || r.status === 'error';
  }).length || rows.length;
  const activeDone = typeof done === 'number' ? done : rows.filter(function (r) {
    return r.status === 'generated' || r.status === 'published' || r.status === 'error';
  }).length;
  box.classList.remove('hidden');
  fill.style.width = activeTotal ? Math.round((activeDone / activeTotal) * 100) + '%' : '0%';
  text.textContent = (label ? label + ' ' : '') + activeDone + ' / ' + activeTotal;
}

async function runBatchGenerate(targetRows) {
  const active = getActiveClient();
  const queue = ensureBatchQueueForActiveClient();
  if (!active || !queue) return showStatus('batch-status', 'Select a client first.', 'error');
  if (queue.clientId !== active.id) return showStatus('batch-status', 'This batch belongs to another client. Clear it first.', 'error');

  queue.model = state.model;
  queue.rows.forEach(syncBatchRowStatus);
  const rows = (targetRows || queue.rows).filter(function (row) {
    return isBatchBriefReady(row) && row.status !== 'published';
  });
  if (rows.length === 0) return showStatus('batch-status', 'No ready rows. Add a primary keyword and at least a title, angle, or key message.', 'error');

  startBatchRun('generate');
  showStatus('batch-status', 'Generating ' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + '...', 'info');
  let ok = 0;
  let failed = 0;
  await runWithConcurrency(rows, async function (row) {
    row.status = 'generating';
    row.lastError = null;
    persistBatchQueue();
    renderBatch();

    const result = await apiCallWithRetry('batch-generate', GENERATE_ENDPOINT, {
      method: 'POST',
      signal: state.batchRun.abortController.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: queue.model,
        max_tokens: 3000,
        messages: [{ role: 'user', content: buildBatchPrompt(active, row) }]
      })
    }, 3);

    if (!state.batchRun.running) return;
    if (!result.ok) {
      row.status = 'error';
      row.lastError = { phase: 'generate', code: result.code || String(result.status || 'ERROR'), message: result.message || 'Generation failed', ts: Date.now() };
      failed++;
    } else {
      const data = result.data;
      const raw = data && Array.isArray(data.content) ? data.content.map(function (b) { return b.text || ''; }).join('').trim() : '';
      const parsed = parseJsonFromModel(raw);
      if (!parsed.ok) {
        row.status = 'error';
        row.lastError = { phase: 'generate', code: 'MODEL_JSON_PARSE', message: parsed.error || 'Model output could not be parsed as JSON', ts: Date.now() };
        failed++;
      } else {
        const value = parsed.value || {};
        let content = sanitizeHtml(value.content || '');
        state.images.forEach(function (img) {
          const esc = img.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          content = content.replace(new RegExp('src=["\']' + esc + '["\']', 'g'), 'src="' + img.url + '"');
        });
        row.generated = {
          title: String(value.title || row.brief.title || '').substring(0, 300),
          content: content,
          metaDescription: String(value.metaDescription || '').substring(0, 300),
          altTextSuggestions: Array.isArray(value.altTextSuggestions) ? value.altTextSuggestions.map(String) : [],
          seoNotes: String(value.seoNotes || '')
        };
        row.status = 'generated';
        row.lastError = null;
        ok++;
      }
    }
    persistBatchQueue();
    renderBatch();
  }, function (done, total) {
    renderBatchProgress(done, total, 'Generate');
  });
  if (state.batchRun.running) {
    finishBatchRun();
    showStatus('batch-status', ok + ' generated, ' + failed + ' failed.', failed ? 'warning' : 'success');
  }
}

async function runBatchPublish(targetRows) {
  const active = getActiveClient();
  const queue = ensureBatchQueueForActiveClient();
  if (!active || !queue) return showStatus('batch-status', 'Select a client first.', 'error');
  if (queue.clientId !== active.id) return showStatus('batch-status', 'This batch belongs to another client. Clear it first.', 'error');
  const statusEl = document.getElementById('batch-publish-status');
  const wpStatus = statusEl ? statusEl.value : 'pending';
  if (wpStatus !== 'pending' && wpStatus !== 'draft') return showStatus('batch-status', 'Batch can only send Draft or Pending Review.', 'error');

  const rows = (targetRows || queue.rows).filter(function (row) {
    return row.generated && row.status !== 'published';
  });
  if (rows.length === 0) return showStatus('batch-status', 'No generated rows to send.', 'error');

  startBatchRun('publish');
  showStatus('batch-status', 'Sending ' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + ' to WordPress...', 'info');
  let ok = 0;
  let failed = 0;
  await runWithConcurrency(rows, async function (row) {
    row.status = 'publishing';
    row.lastError = null;
    persistBatchQueue();
    renderBatch();

    const body = {
      title: row.generated.title,
      content: sanitizeHtml(row.generated.content),
      status: wpStatus
    };
    if (row.generated.metaDescription) body.excerpt = row.generated.metaDescription;

    const result = await apiCallWithRetry('batch-publish', active.url + '/wp-json/wp/v2/posts', {
      method: 'POST',
      signal: state.batchRun.abortController.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + btoa(active.user + ':' + active.pass)
      },
      body: JSON.stringify(body)
    }, 3);

    if (!state.batchRun.running) return;
    if (result.ok) {
      row.status = 'published';
      row.wpPostId = result.data && result.data.id ? result.data.id : null;
      row.wpPostUrl = result.data && result.data.link ? result.data.link : null;
      row.lastError = null;
      ok++;
    } else {
      row.status = 'error';
      row.lastError = { phase: 'publish', code: result.code || String(result.status || 'ERROR'), message: result.message || 'Publish failed', ts: Date.now() };
      failed++;
    }
    persistBatchQueue();
    renderBatch();
  }, function (done, total) {
    renderBatchProgress(done, total, 'Send');
  });
  if (state.batchRun.running) {
    finishBatchRun();
    showStatus('batch-status', ok + ' sent as ' + (wpStatus === 'pending' ? 'Pending Review' : 'Draft') + ', ' + failed + ' failed.', failed ? 'warning' : 'success');
  }
}

function initBatchUi() {
  try {
    const addBtn = document.getElementById('batch-add-row-btn');
    const bulkToggle = document.getElementById('batch-bulk-toggle-btn');
    const bulkAdd = document.getElementById('batch-bulk-add-btn');
    const clearBtn = document.getElementById('batch-clear-btn');
    const genBtn = document.getElementById('batch-generate-btn');
    const sendBtn = document.getElementById('batch-send-btn');
    const cancelBtn = document.getElementById('batch-cancel-btn');
    const list = document.getElementById('batch-list');
    if (addBtn) addBtn.addEventListener('click', function () { addBatchRow(); });
    if (bulkToggle) bulkToggle.addEventListener('click', function () {
      const panel = document.getElementById('batch-bulk-panel');
      if (panel) panel.classList.toggle('hidden');
    });
    if (bulkAdd) bulkAdd.addEventListener('click', addBulkBatchRows);
    if (clearBtn) clearBtn.addEventListener('click', clearBatchQueue);
    if (genBtn) genBtn.addEventListener('click', function () { runBatchGenerate(); });
    if (sendBtn) sendBtn.addEventListener('click', function () { runBatchPublish(); });
    if (cancelBtn) cancelBtn.addEventListener('click', cancelBatchRun);
    if (list) {
      list.addEventListener('click', handleBatchClick);
      list.addEventListener('input', handleBatchTyping);
      list.addEventListener('change', handleBatchInput);
    }
    renderBatch();
  } catch (e) {
    logEvent('error', 'batch-init', 'Batch UI failed to initialize', { error: String(e) });
  }
}

/* ---------- 15. history (all clients) ---------- */

/**
 * Load the 10 most recent posts from EVERY client in parallel, grouped
 * by client. Per-client failures are isolated — one broken Application
 * Password only affects that client's group.
 */
async function loadHistory() {
  const list = document.getElementById('history-list');
  list.innerHTML = '';

  if (state.clients.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No clients yet. Add a client to see history.';
    list.appendChild(empty);
    return;
  }

  const btn = document.getElementById('refresh-history-btn');
  btn.innerHTML = '<span class="spinner"></span>Loading...';
  btn.disabled = true;

  const pillCls = { draft: 'pill-draft', pending: 'pill-pending', future: 'pill-scheduled', publish: 'pill-published' };
  const lbl = { draft: 'Draft', pending: 'Pending', future: 'Scheduled', publish: 'Published' };

  // apiCall never throws, so no try/catch needed
  const results = await Promise.all(state.clients.map(async function (c) {
    const result = await apiCall('history:' + c.name,
      c.url + '/wp-json/wp/v2/posts?status=draft,pending,future,publish&per_page=10&orderby=modified&_embed=author',
      { headers: { 'Authorization': 'Basic ' + btoa(c.user + ':' + c.pass) } }
    );
    if (result.ok) {
      return { client: c, posts: result.data || [], error: null };
    }
    return { client: c, posts: [], error: formatApiError('Failed', result) };
  }));

  results.forEach(function (r) {
    const client = r.client;
    const posts = r.posts;
    const error = r.error;

    const group = document.createElement('div');
    group.className = 'history-client-group';

    const header = document.createElement('div');
    header.className = 'history-client-header';

    const name = document.createElement('span');
    name.textContent = client.name;

    const count = document.createElement('span');
    count.className = 'history-client-count';
    count.textContent = error ? error : (posts.length + ' recent post' + (posts.length === 1 ? '' : 's'));

    header.appendChild(name);
    header.appendChild(count);
    group.appendChild(header);

    if (error) {
      // Header already shows the reason
    } else if (posts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-item muted';
      empty.textContent = 'No recent posts.';
      group.appendChild(empty);
    } else {
      posts.forEach(function (p) {
        const item = document.createElement('div');
        item.className = 'history-item';

        const main = document.createElement('div');
        main.className = 'history-item-main';

        const titleEl = document.createElement('div');
        titleEl.className = 'history-item-title';
        const tmp = document.createElement('textarea');
        tmp.innerHTML = (p.title && p.title.rendered) || '(untitled)';
        titleEl.textContent = tmp.value;

        const metaEl = document.createElement('div');
        metaEl.className = 'history-item-meta';
        const author = (p._embedded && p._embedded.author && p._embedded.author[0] && p._embedded.author[0].name) || 'unknown';
        metaEl.textContent = new Date(p.date).toLocaleString() + ' · by ' + author;

        main.appendChild(titleEl);
        main.appendChild(metaEl);

        const pill = document.createElement('span');
        pill.className = 'pill ' + (pillCls[p.status] || 'pill-draft');
        pill.textContent = lbl[p.status] || p.status;

        const link = document.createElement('a');
        link.href = p.link;
        link.target = '_blank';
        link.rel = 'noopener';
        link.className = 'btn btn-sm';
        link.textContent = 'Open';

        item.appendChild(main);
        item.appendChild(pill);
        item.appendChild(link);
        group.appendChild(item);
      });
    }

    list.appendChild(group);
  });

  btn.textContent = 'Refresh all clients';
  btn.disabled = false;
}

/* ---------- 15. danger zone ---------- */

function clearAllLocalData() {
  if (!confirm('Clear all saved clients, credentials, and preferences from this browser?\n\nThis does NOT revoke Application Passwords on WordPress — do that separately if needed.')) {
    return;
  }
  Object.values(STORAGE_KEYS).forEach(function (k) { localStorage.removeItem(k); });
  state.clients = [];
  state.activeClientId = null;
  state.images = [];
  state.currentBrief = null;
  state.batchQueue = null;
  state.batchOpenRows.clear();
  renderClientList();
  renderClientSelector();
  updateActiveClientUI();
  logEvent('warn', 'danger-zone', 'All local data cleared');
  alert('All local data cleared.');
}

/* ---------- 16. helpers ---------- */

function showStatus(id, html, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'status' + (type ? ' ' + type : '');
  el.innerHTML = html;
  if (!type || !html) {
    el.style.display = 'none';
  } else {
    el.style.display = '';
  }
}

/* ---------- 17. event wiring ---------- */

/**
 * THE one DOMContentLoaded handler. A throw anywhere in this block will
 * cascade — all handlers below the throw-point will fail to attach and
 * the app looks dead.
 *
 * Debugging tip: if buttons seem dead, try typing openClientEditor(null)
 * in the DevTools console. If it opens the editor, DOMContentLoaded ran
 * fine and something else is eating the click (browser extension, for
 * example). If ReferenceError, the script itself didn't parse.
 */
document.addEventListener('DOMContentLoaded', function () {
  loadStorage();

  // Tabs
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { switchTab(t.dataset.tab); });
  });
  document.querySelectorAll('[data-switch-tab]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.preventDefault();
      switchTab(b.dataset.switchTab);
    });
  });

  // Active client dropdown in topbar
  document.getElementById('active-client').addEventListener('change', function (e) {
    setActiveClient(e.target.value);
  });

  // Client editor
  document.getElementById('add-client-btn').addEventListener('click', function () { openClientEditor(null); });
  document.getElementById('save-client-btn').addEventListener('click', saveClientFromForm);
  document.getElementById('test-client-btn').addEventListener('click', testClientConnection);
  document.getElementById('cancel-client-btn').addEventListener('click', closeClientEditor);

  // Export/Import — Tier 1 file-based client sync
  const exportBtn = document.getElementById('export-clients-btn');
  if (exportBtn) exportBtn.addEventListener('click', exportClients);
  const importBtn = document.getElementById('import-clients-btn');
  const importInput = document.getElementById('import-clients-file');
  if (importBtn && importInput) {
    importBtn.addEventListener('click', function () { importInput.click(); });
    importInput.addEventListener('change', function (e) {
      const file = e.target.files && e.target.files[0];
      if (file) importClientsFromFile(file);
      // Reset so picking the same file twice re-triggers change
      e.target.value = '';
    });
  }

  document.getElementById('save-model-btn').addEventListener('click', saveModel);
  document.getElementById('gen-btn').addEventListener('click', generateFromBrief);
  document.getElementById('pub-btn').addEventListener('click', publishPost);
  document.getElementById('refresh-btn').addEventListener('click', loadQueue);
  document.getElementById('refresh-history-btn').addEventListener('click', loadHistory);
  document.getElementById('post-status').addEventListener('change', toggleScheduleField);
  document.getElementById('clear-all-btn').addEventListener('click', clearAllLocalData);
  initBatchUi();

  const clearLogBtn = document.getElementById('clear-log-btn');
  if (clearLogBtn) clearLogBtn.addEventListener('click', clearEventLog);

  // Toolbar buttons
  document.querySelectorAll('.tb-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.dataset.wrap) {
        const parts = b.dataset.wrap.split('|');
        wrapSelection(parts[0], parts[1]);
      } else if (b.dataset.action === 'list-ul') insertList('ul');
      else if (b.dataset.action === 'list-ol') insertList('ol');
      else if (b.dataset.action === 'link') insertLink();
      else if (b.dataset.action === 'image') insertImageTag();
      else if (b.dataset.action === 'hr') insertHr();
    });
  });

  document.querySelectorAll('.vt-btn').forEach(function (b) {
    b.addEventListener('click', function () { setView(b.dataset.view); });
  });

  // Image grid delete — event-delegated since thumbs are dynamic
  document.getElementById('img-grid').addEventListener('click', function (e) {
    const btn = e.target.closest('[data-remove]');
    if (btn) removeImg(parseInt(btn.dataset.remove));
  });

  // Drop zone + file input
  const dz = document.getElementById('drop-zone');
  const fi = document.getElementById('file-input');
  dz.addEventListener('click', function () { fi.click(); });
  dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', function () { dz.classList.remove('drag'); });
  dz.addEventListener('drop', function (e) {
    e.preventDefault();
    dz.classList.remove('drag');
    handleFiles(e.dataTransfer.files);
  });
  fi.addEventListener('change', function () { handleFiles(fi.files); });
});
