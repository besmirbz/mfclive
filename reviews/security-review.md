# MFCLIVE — Security Review Report

> Reviewed: 2026-04-14  
> Scope: `server-saas.js`, `controller.html`, `overlay.html`, `wizard.html`, `bookmarklet.html`  
> Deployment: Hetzner VPS · Caddy reverse proxy · futsalplay.live

---

## Executive Summary

The MFCLIVE multi-tenant SaaS overlay system exhibits **several vulnerabilities ranging from Critical to Low severity**. The most pressing issues are:

1. **XSS via unsanitised red-card player names** rendered with `innerHTML`
2. **Authentication tokens permanently embedded in URLs and email** (browser history, server logs, Referer leakage)
3. **Stripe webhook falls back to unsigned JSON parsing** when `STRIPE_WEBHOOK_SECRET` is unset
4. **Wildcard CORS** (`Access-Control-Allow-Origin: *`) on all routes including state/action endpoints
5. **SVG upload accepted and served with `image/svg+xml`**, enabling stored XSS

The system has a solid foundation (parameterised SQLite, SSRF guard on logo proxy, file-extension whitelist, rate limiting), but the critical issues above require remediation before the service handles paying clubs.

---

## Threat Model

| Actor | Capability |
|---|---|
| Unauthenticated external attacker | Probe public routes, attempt slug enumeration |
| Attacker with valid token | Full state manipulation, roster injection |
| Compromised FOGIS API / MITM | Inject malicious logo URLs into roster import |
| Internal misconfig | Missing env vars (Stripe secret, SMTP) silently degrade security |

**Assets at risk:** club tokens, player/team data, Stripe payment flow, VPS file storage, operator email addresses.

---

## Findings

### CRITICAL

#### C1 — XSS via red-card player name rendered with `innerHTML`

**File:** `controller.html` · `renderRedCards()` ~line 440  
**Also:** `server-saas.js` · `handleAction()` `red_card_add`

The server strips `< > " '` from the player name but **not backticks or other characters**. The controller then renders the list via `innerHTML` string concatenation:

```js
el.innerHTML = cards.map(rc =>
  '<div class="rc-item"><div class="rc-player-lbl">🟥 ' + (rc.player||'—') + '</div>...'
).join('');
```

Any operator (or attacker with a valid token) can inject markup that executes in every other operator's browser.

**Fix:** Replace `innerHTML` concatenation with `textContent` on individual elements, or use a dedicated `escHtml()` helper before insertion.

---

#### C2 — Club tokens permanently in URLs and email

**File:** `server-saas.js` · Stripe webhook handler ~line 1073

Controller, wizard, and overlay URLs containing the token are sent in the welcome email and stored in browser history, Referer headers, Caddy access logs, and any log aggregation service:

```js
const controllerUrl = `https://futsalplay.live/clubs/${slug}/controller?token=${secret}`;
```

A token that never rotates and lives forever in logs is a persistent credential exposure.

**Fix:**
- Issue a short-lived one-time setup link; establish a `HttpOnly; Secure; SameSite=Strict` session cookie on first visit.
- Strip query strings from Caddy access logs (`log { format filter … }`).
- At minimum, rotate tokens on demand (add `/clubs/:slug/rotate-token` admin endpoint).

---

#### C3 — Stripe webhook accepts unsigned JSON when secret is missing

**File:** `server-saas.js` · `/webhooks/stripe` handler ~line 1043

```js
event = secret
  ? stripe.webhooks.constructEvent(rawBody, sig, secret)
  : JSON.parse(rawBody.toString());   // ← no signature check
```

If `STRIPE_WEBHOOK_SECRET` is empty or missing from `ecosystem.config.js`, any attacker can POST a forged `checkout.session.completed` event, create a free club account, and receive credentials via email.

**Fix:** Require the secret at startup and reject all webhook traffic without it:

```js
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  console.error('[FATAL] STRIPE_WEBHOOK_SECRET not set — exiting');
  process.exit(1);
}
// Always call constructEvent; never fall back to JSON.parse
event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
```

---

### HIGH

#### H1 — Wildcard CORS on all routes including state and action endpoints

**File:** `server-saas.js` ~line 585

```js
res.setHeader('Access-Control-Allow-Origin', '*');
```

Combined with token-in-URL, any page can silently fetch `/clubs/:slug/api/state` or POST `/clubs/:slug/action` when a user visits. Attackers can exfiltrate live game state or manipulate scores from a third-party site.

**Fix:** Restrict CORS to the overlay's own origin. For the bookmarklet specifically (which must POST cross-origin from minfotboll.se), scope the wildcard to the `/import-roster` route only:

```js
const BOOKMARKLET_ROUTES = ['/import-roster'];
if (BOOKMARKLET_ROUTES.some(r => subpath === r)) {
  res.setHeader('Access-Control-Allow-Origin', '*');
} else {
  res.setHeader('Access-Control-Allow-Origin', 'https://futsalplay.live');
}
```

---

#### H2 — SVG uploads served as `image/svg+xml` — stored XSS

**File:** `server-saas.js` · `/upload-logo` and `/logo/home|away` routes ~lines 873, 726

SVG files are accepted, stored, and later served with `Content-Type: image/svg+xml`. An SVG with an `onload` or `<script>` element executes JavaScript in the context of `futsalplay.live` when loaded in a browser tab or iframe.

**Fix (choose one):**
- Remove SVG from the allowed-extension list.
- Serve all uploaded logos with `Content-Disposition: attachment` so they can't be rendered inline.
- Sanitise SVG content before saving (strip `<script>`, event attributes, `<use href=...>`).

---

#### H3 — Rate limit too permissive and not applied to upload/roster endpoints

**File:** `server-saas.js` · `checkRateLimit()` and `/upload-logo`, `/import-roster` handlers

Rate limiting (20 req/s per token) is only applied to `/action`. The roster import (512 KB max) and logo upload (6 MB max) have no rate limiting, allowing storage/memory exhaustion with a valid token.

**Fix:** Apply per-token rate limiting to all POST endpoints. Lower the action limit to 5 req/s for realistic game play.

---

### MEDIUM

#### M1 — Admin secret printed in full to stdout on first run

**File:** `server-saas.js` ~line 94

```js
console.log(`\n[admin] Generated admin secret. Store this safely:\n  ${ADMIN_SECRET}\n`);
```

PM2 captures stdout to `~/.pm2/logs/`. Anyone with read access to those logs obtains the admin key.

**Fix:** Print only the file path, not the secret value.

---

#### M2 — Missing HTTP security headers

No `X-Frame-Options`, `X-Content-Type-Options`, `Content-Security-Policy`, or `Strict-Transport-Security` are set at the application layer.

**Fix:** Add a middleware-style header block early in the request handler:

```js
res.setHeader('X-Frame-Options', 'SAMEORIGIN');
res.setHeader('X-Content-Type-Options', 'nosniff');
res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
```

CSP requires more care given inline scripts and Google Fonts, but at minimum `nosniff` and `X-Frame-Options` are one-liners.

---

#### M3 — SSE connections have no per-room limit or idle timeout

**File:** `server-saas.js` · `/events` handler

Connections accumulate in `room.clients` indefinitely. An attacker can open thousands of connections, exhausting file descriptors and memory.

**Fix:** Reject new SSE connections beyond a per-room cap (e.g. 20) and close idle connections after 10 minutes.

---

#### M4 — FOGIS external data stored without URL validation at ingestion

**File:** `server-saas.js` · `processRosterData()` ~line 763

`homeLogoUrl` from the external FOGIS API passes through `isSafeLogoUrl()` before being stored (line 809 guard). This is correct. However, league/arena strings are stored without sanitisation and later returned in state and rendered by the overlay. A MITM on the FOGIS API could inject unusually long or specially crafted strings.

**Fix:** Already length-capped (100 chars). Additionally, strip control characters: `.replace(/[\x00-\x1f]/g, '')`.

---

### LOW

#### L1 — Database directory created with default umask (world-readable on some systems)

**Fix:** `fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });`

#### L2 — SMTP username hardcoded in source

The password comes from env var; the username (`info@futsalplay.live`) is hardcoded. Externalise both to `SMTP_USER` / `SMTP_PASS` env vars.

#### L3 — Club token entropy is 64 bits (8 random bytes)

64-bit tokens are sufficient for most threat models but below the NIST recommendation of 112 bits for secrets. Consider upgrading to `crypto.randomBytes(16)` (128 bits) for new clubs.

---

## Positive Security Controls Already in Place

| Control | Location |
|---|---|
| Parameterised SQLite queries throughout | `better-sqlite3` prepared statements |
| SSRF guard on logo proxy — blocks private IPs, requires HTTPS | `isSafeLogoUrl()` |
| Server-generated logo filenames (user filename discarded) | `/upload-logo` handler |
| Input truncation on all user-supplied strings | `handleAction()` |
| Request body size caps (8 KB actions, 512 KB roster, 6 MB logo) | All POST handlers |
| Rate limiting on `/action` | `checkRateLimit()` |
| `X-Real-IP` forwarded by Caddy for correct auth bypass detection | Caddyfile + `isLocalhost()` |
| HTML escaping (`esc()`) in server-rendered strings | Inline import success page |
| Stripe library used for checkout session creation | `/signup/create-session` |

---

## Remediation Priority

| Priority | Action |
|---|---|
| **Immediate** | Fix XSS in red-card renderer (use `textContent`) |
| **Immediate** | Require `STRIPE_WEBHOOK_SECRET` at startup, remove JSON fallback |
| **Immediate** | Disable SVG uploads or force `Content-Disposition: attachment` |
| **This week** | Scope CORS to `/import-roster` only; use `SAMEORIGIN` everywhere else |
| **This week** | Add `X-Frame-Options: SAMEORIGIN` and `X-Content-Type-Options: nosniff` |
| **This week** | Add rate limiting to upload and roster import endpoints |
| **Soon** | Replace URL tokens with session cookies |
| **Soon** | Suppress admin secret from stdout; restrict log file permissions |
| **Later** | SSE connection cap and idle timeout per room |
| **Later** | Upgrade token entropy to 128 bits |
