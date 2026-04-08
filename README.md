# MFCLIVE — Live Streaming Overlay System

A real-time scoreboard, lineup, lower-third, and countdown overlay system for futsal and football clubs streaming with OBS or Streamlabs. Controlled from any phone or tablet during the game.

Two deployment modes:

| Mode | Description |
|---|---|
| **SaaS** (`server-saas.js`) | Multi-tenant cloud deployment — live at [futsalplay.live](https://futsalplay.live). Clubs sign up via Stripe, get credentials by email, no local setup required. |
| **Local** (`server.js`) | Single-tenant, runs on the stream PC. Started via `START MFCLIVE.bat`. Original setup for club-internal use. |

---

## SaaS Deployment (futsalplay.live)

### Infrastructure

| Component | Detail |
|---|---|
| VPS | Hetzner, Debian 13 |
| IPv4 | 204.168.245.146 |
| Domain | futsalplay.live (SSL via Let's Encrypt, Caddy) |
| Stack | Node.js v20 + better-sqlite3 + PM2 + Caddy |
| App root | `/var/www/mfclive` (git repo, branch `feat/club-config`) |
| DB + secret | `~/.mfclive-saas/saas.db` and `~/.mfclive-saas/admin-secret.txt` |
| SSH key | `C:\Users\BPEP0001\.ssh\futsalplay` |
| PM2 name | `mfclive-saas` |

### Deploy

```bash
# Local
git push

# VPS
cd /var/www/mfclive && git pull && pm2 restart mfclive-saas
```

### Caddyfile (`/etc/caddy/Caddyfile`)

```
futsalplay.live {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Real-IP {remote_host}
    }
}
```

The `header_up` line is required — Caddy proxies all requests as 127.0.0.1, so without it the server would skip token auth for every request.

### Environment (`/var/www/mfclive/ecosystem.config.js`)

```js
module.exports = {
  apps: [{
    name: 'mfclive-saas',
    script: 'server-saas.js',
    env: {
      MFCLIVE_ADMIN_SECRET: '...',
      STRIPE_SECRET_KEY:    'sk_live_...',
      STRIPE_PRICE_ID:      'price_...',
      STRIPE_WEBHOOK_SECRET:'whsec_...',
      SMTP_USER:            'info@futsalplay.live',
      SMTP_PASS:            '...',
    }
  }]
};
```

After editing ecosystem.config.js: `pm2 delete mfclive-saas && pm2 start ecosystem.config.js && pm2 save`

### Admin API

```
Header:      X-MFCLIVE-Admin: <key>
Query param: ?admin_secret=<key>
```

Key lives in `~/.mfclive-saas/admin-secret.txt`.

```bash
# List clubs
curl -H "X-MFCLIVE-Admin: <key>" https://futsalplay.live/admin/clubs

# Create club manually
curl -X POST https://futsalplay.live/admin/clubs \
  -H "X-MFCLIVE-Admin: <key>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test FC","slug":"testfc"}'

# Query DB directly (sqlite3 CLI not installed — use node)
node -e "const D=require('better-sqlite3')(require('path').join(require('os').homedir(),'.mfclive-saas/saas.db')); console.log(D.prepare('SELECT slug,secret FROM clubs').all())"
```

### Club API routes

All club routes are scoped under `/clubs/:slug/` and require either `?token=<secret>` or `X-MFCLIVE-Token` header. Localhost (127.0.0.1 direct, not via Caddy) bypasses token auth.

| Route | Method | Description |
|---|---|---|
| `/clubs/:slug/controller` | GET | Controller UI |
| `/clubs/:slug/wizard` | GET | Game setup wizard |
| `/clubs/:slug/overlay` | GET | Scoreboard overlay |
| `/clubs/:slug/events` | GET | SSE stream |
| `/clubs/:slug/api/state` | GET | Current game state |
| `/clubs/:slug/action` | POST | Send action (start/stop timer, goal, etc.) |
| `/clubs/:slug/api/config` | POST | Update club settings |
| `/clubs/:slug/import-roster` | POST | FOGIS bookmarklet receiver |
| `/clubs/:slug/upload-logo` | POST | Team logo (base64 JSON) |
| `/clubs/:slug/logo/home` | GET | Serve home team logo |
| `/clubs/:slug/logo/away` | GET | Serve away team logo |

### Stripe + email flow

1. Club visits `/signup`, enters name and email
2. POST `/signup/create-session` creates a Stripe Checkout session
3. On payment, Stripe sends `checkout.session.completed` to `/webhooks/stripe`
4. Server creates the club record in DB, sends credentials email via Zoho SMTP (port 587)
5. Email contains: wizard link, controller link, overlay URL

SMTP: `smtp.zoho.eu:587`, `secure: false, requireTLS: true` (port 465 is blocked on Hetzner).

### Logos

Team logos are uploaded by the wizard (base64 POST) and stored at `~/.mfclive-saas/logos/:slug/home.*` and `away.*`. Referenced in state as `__upload__:filename`. The `/logo/home` and `/logo/away` routes serve them with a 24-hour cache header.

Club logos (`/upload-club-logo`) are not implemented in the SaaS version — the club logo field is hidden in the wizard settings panel.

---

## Local / Self-Hosted Version

The local version runs on the stream PC and serves a single club. It uses Cloudflare Quick Tunnels to expose the controller over the internet without port forwarding.

### Files

| File | Purpose |
|---|---|
| `START MFCLIVE.bat` | Launch script — installs requirements and starts the server |
| `server.js` | Single-tenant backend |
| `config.json` | Club name, keywords, port, half duration |
| `public/wizard.html` | Game setup wizard |
| `public/controller.html` | Controller UI (phone/tablet) |
| `public/overlays/overlay.html` | All overlays in one file (mode driven by URL path) |
| `public/bookmarklet.html` | FOGIS bookmarklet installer |

### Requirements

- [OBS](https://obsproject.com/) or [Streamlabs](https://streamlabs.com/)
- Google Chrome (for bookmarklet)
- A phone or tablet with a browser

Node.js and cloudflared are installed automatically by `START MFCLIVE.bat`.

### First-time setup

**1. Configure club**

Edit `config.json`:

```json
{
  "club": "Your Club Name",
  "clubKeywords": ["your club", "yc"],
  "halfDurationMinutes": 20,
  "port": 3000
}
```

**2. Install FOGIS bookmarklet**

Start the server, then open `http://localhost:3000/bookmarklet` in Chrome. Follow the instructions on that page to save the bookmarklet. Do this once.

**3. Add Browser Sources in OBS/Streamlabs**

For each source, set width/height to `1920x1080` and add this to Custom CSS:

```css
body { background-color: rgba(0, 0, 0, 0) !important; }
```

| Browser Source | URL |
|---|---|
| Scoreboard | `http://localhost:3000/scoreboard` |
| Lower Third | `http://localhost:3000/lowerthird` |
| Lineup | `http://localhost:3000/lineup` |
| Starting Soon | `http://localhost:3000/startingsoon` |
| BRB | `http://localhost:3000/brb` |

**4. Add audio files**

Drop royalty-free `.mp3` files into the `audio/` folder:

| File | When it plays |
|---|---|
| `startingsoon-loop.mp3` | Loops while Starting Soon overlay is visible |
| `lineup-fanfare.mp3` | Plays once when Lineup overlay appears |
| `goal.mp3` | Goal lower third |
| `redcard-whistle.mp3` | Red card lower third |

### Game day

1. Double-click `START MFCLIVE.bat`
2. The wizard opens automatically — enter teams, lineups, kickoff time
3. Scan the QR in the wizard connection bar to open the controller on your phone
4. On the FOGIS page, click the bookmarklet to load the roster automatically
5. Run a short test stream before the real one

### Stopping

Close the server terminal window, or `Ctrl+C` inside it. To kill any leftover node process: `taskkill /F /IM node.exe`

---

## Controller Reference

Works identically in both local and SaaS versions.

### Overlays card

Toggle any overlay on/off. Each row shows a live status pill (LIVE / HIDDEN). No need to switch scenes in OBS.

### Timer

| Control | Action |
|---|---|
| Start / Stop | Run or pause the countdown |
| Reset | Reset to period duration (confirms first) |
| Undo | Restore timer to before the reset (10s window) |
| Adjust | Open exact-time setter to correct drift |

**Keyboard shortcuts** (controller page focused, not in a text field):

| Key | Action |
|---|---|
| `Space` | Start / Stop |
| `1` / `2` | Home / Away goal |
| `Q` / `W` | Undo home / away goal |
| `F` / `G` | Home / Away foul |
| `H` | Hide lower third |

### Score and fouls

Goals and fouls tracked per team. Fouls reset when the period changes. At 5 fouls the scoreboard shows MAX; from foul 6 it shows the count above 5 (free kick from 10m).

### Red cards (2-minute penalties)

Enter the player's name, tap Home or Away. A 2-minute countdown appears on the scoreboard. Clears automatically on the next opposing goal, or tap X to clear manually.

### Lower Third

Set Line 1 (name/event) and Line 2 (label), choose duration (6s / 8s / 10s / 15s / hold), tap Show. Quick-pick player buttons appear once the roster is loaded.

### Half time

Tap **Half Time — 15:00** to stop the timer and display HALF TIME on the scoreboard. When play resumes, tap **2nd Half** — this clears the label and resets fouls.

### New Game / Game Setup

At the bottom of the controller, **Reset for New Game** clears scores, timer, fouls and penalties but keeps team names and lineups. **Change teams / lineups** opens the wizard to change teams for the next game.

---

## Overlay Reference

All overlays are served from `public/overlays/overlay.html`. The active mode is determined by the URL path (scoreboard, lineup, lowerthird, startingsoon, brb). In SaaS mode the path is `/clubs/:slug/<mode>?token=...`.

| Overlay | Notes |
|---|---|
| Scoreboard | Top-left corner. Period, timer, scores, foul dots, red card countdown. |
| Lineup | Full-screen. Home and away squads side by side. Fanfare audio on show. |
| Starting Soon | Full-screen. Team logos, league, arena, live kickoff countdown. Ambient audio loop. |
| Lower Third | Slides in from left. Goal/red card/substitution event types. Matching audio cues. |
| BRB | Full-screen. "We'll be right back." Transparent background. |

---

## Troubleshooting

**Forbidden on admin API** — check header name (`X-MFCLIVE-Admin`, not `X-Admin-Secret`) and that the key matches `~/.mfclive-saas/admin-secret.txt` on the VPS.

**PM2 not picking up env vars** — `pm2 restart` does not re-read ecosystem.config.js. Must run `pm2 delete mfclive-saas && pm2 start ecosystem.config.js && pm2 save`.

**SMTP timeout** — port 465 is blocked on Hetzner. Use port 587 with `secure: false, requireTLS: true`.

**Controller says "reconnecting"** — token check or SSE path is wrong. Confirm the `X-Real-IP` header is forwarded in Caddyfile, and that the overlay/controller HTML reads paths from `_MFCLIVE_CONFIG`.

**Overlay URLs hardcoded** — the controller and overlay pages read API paths from `window._MFCLIVE_CONFIG` injected by the server. If you see requests going to `/api/state` instead of `/clubs/:slug/api/state`, the server is not injecting the config block (check the file path in `fileMap`).

**Port 3000 accessible directly** — it should only be reachable via Caddy. Add a firewall rule: `ufw deny 3000` (UFW) or equivalent.

**Local: tunnel URL changes on restart** — this is expected with Cloudflare Quick Tunnels (no account). The token in the URL stays the same; only the subdomain changes. Re-scan the QR after each server start.

---

*Futsalplay.live — You play, we stream it.*
© 2025 Besmir Pepa. All rights reserved.
