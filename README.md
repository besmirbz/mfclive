# MFCLIVE — Stream Overlay System

A live streaming overlay system for **Malmö Futsal Club**, built for use with Streamlabs and a local RTMP setup. Provides a real-time scoreboard, player lineup display, lower-third announcements, a starting soon countdown, and a be-right-back screen — all controlled from a phone or tablet during the game.

---

## Jump to your role

### 🖥️ Stream Operator (admin)
You set up and run the streaming PC, manage Streamlabs, and own the first-time setup.

1. [First-Time Setup](#first-time-setup) — do this once before your first game
2. [Every Game Day](#every-game-day) — your pre-match checklist
3. [Troubleshooting](#troubleshooting) — if something breaks

### 🎮 Controls Operator
You run the controller on your phone during the game. You don't need to touch the PC.

1. [Opening the Controller](#step-5--open-the-controller-on-your-phone) — get the URL from the stream operator
2. [Using the Controller](#using-the-controller) — timer, score, lower thirds, overlays

---

## Files Overview

| File / Folder | Purpose |
|---|---|
| `START MFCLIVE.bat` | **Double-click to launch** — installs requirements automatically and starts the server |
| `server.js` | The backend server — started automatically by the bat file |
| `config.json` | Club configuration — name, keywords, port, half duration |
| `wizard.html` | Game setup wizard — opens automatically in your browser after launch |
| `controller.html` | The control panel — open on your phone/tablet via QR code |
| `overlay-scoreboard.html` | Scoreboard overlay — add as Browser Source in Streamlabs |
| `overlay-lineup.html` | Starting lineup overlay — add as Browser Source in Streamlabs |
| `overlay-lowerthird.html` | Lower-third announcements — add as Browser Source in Streamlabs |
| `overlay-startingsoon.html` | Pre-match countdown overlay — add as Browser Source in Streamlabs |
| `overlay-brb.html` | "We'll Be Right Back" overlay — add as Browser Source in Streamlabs |
| `bookmarklet.html` | One-time setup page for the FOGIS roster loader |
| `audio/` | Drop your royalty-free audio files here (see [Audio Setup](#4-audio-setup)) |

All files must be kept in the **same folder** on the stream PC.

---

## Requirements

- [Streamlabs](https://streamlabs.com/) for streaming
- Google Chrome on the stream PC (for the bookmarklet)
- A phone or tablet with a browser (any network — see [Cloudflare tunnel](#cloudflare-tunnel))

> Node.js and cloudflared are installed automatically by `START MFCLIVE.bat` if not already present.

---

## First-Time Setup

### 1. Configure your club

Open `config.json` and update it for your club:

```json
{
  "club": "Malmö Futsal Club",
  "clubKeywords": ["malmö futsal", "mfc"],
  "halfDurationMinutes": 20,
  "port": 3000
}
```

- **`club`** — display name shown on the setup page
- **`clubKeywords`** — used to identify your team in FOGIS results (lowercase, partial match)
- **`halfDurationMinutes`** — timer start value (20 for futsal, 45 for football)
- **`port`** — leave as 3000 unless something else is using it

### 2. Set up the FOGIS bookmarklet

> **Swedish clubs only.** FOGIS (minfotboll.se) is the Swedish Football Federation's game management system. This step lets you load team rosters, logos, and venue info automatically with one click. If your club doesn't use FOGIS, skip this step — you can enter team names and lineups manually in the controller.

> ⚠️ **Important:** The bookmarklet setup page must be opened through the server, not by double-clicking the file. Start the server first (double-click `START MFCLIVE.bat`), then open `http://localhost:3000/bookmarklet` in Chrome.

1. Start the server and open `http://localhost:3000/bookmarklet` in Chrome
2. Press **Ctrl+Shift+B** to show the bookmarks bar
3. Click **Copy to Clipboard**
4. Right-click the bookmarks bar → **Add page** (or "Add bookmark")
5. Set the **Name** to `⚽ Load Roster`
6. Paste the copied code into the **URL** field
7. Click **Save**

You only need to do this once. The bookmark works on any game going forward.

### 3. Add Browser Sources in Streamlabs

Add five Browser Sources across your scenes. For each one, paste the following into the **Custom CSS** field in the Browser Source properties to ensure transparency works correctly:

```css
body { background-color: rgba(0, 0, 0, 0) !important; }
```

| Browser Source | URL | Width | Height | Scene |
|---|---|---|---|---|
| Scoreboard | `http://localhost:3000/scoreboard` | 1920 | 1080 | Main / Live |
| Lower Third | `http://localhost:3000/lowerthird` | 1920 | 1080 | Main / Live |
| Lineup | `http://localhost:3000/lineup` | 1920 | 1080 | Main / Live |
| Starting Soon | `http://localhost:3000/startingsoon` | 1920 | 1080 | Starting Soon |
| BRB | `http://localhost:3000/brb` | 1920 | 1080 | BRB |

> The scoreboard positions itself in the **top-left corner** automatically. Set all sources to 1920×1080 and let the overlay handle positioning.

> The kickoff time for the Starting Soon overlay is set from the controller (Overlays card → Kickoff time field) — no need to edit the URL in Streamlabs.

### 4. Streamlabs output settings

Choose the hardware encoder that matches your GPU for best performance:

| GPU | Encoder to select |
|---|---|
| AMD (Radeon) | AMD HW H.264 (AMF) |
| Nvidia | NVENC H.264 |
| Intel (integrated) | QuickSync H.264 |
| No dedicated GPU | x264 — preset `veryfast` |

Recommended settings regardless of encoder:

| Setting | Value |
|---|---|
| Output resolution | 1920×1080 |
| FPS | 30 |
| Bitrate | 4000–5000 kbps (test on the day — see below) |
| Keyframe interval | 2s |
| Audio bitrate | 160 kbps AAC |

All five Browser Sources can live in a **single scene** — overlay visibility is now controlled from the controller (the 🎬 Overlays card), so you no longer need separate Streamlabs scenes for Starting Soon or BRB.

For any Browser Source you never want running in the background, right-click → Properties → tick **"Shutdown source when not visible"** to reduce GPU load.

### 5. Audio Setup

The overlays play royalty-free audio effects that fade in and out in sync with the visual transitions:

| Overlay | File to place in `audio/` | Effect |
|---|---|---|
| Starting Soon | `startingsoon-loop.mp3` | Loops while the overlay is visible, fades out on hide |
| Lineup | `lineup-fanfare.mp3` | Plays once when the lineup overlay appears |
| Lower Third — Goal | `goal.mp3` | Plays when a goal announcement is shown |
| Lower Third — Red Card | `redcard-whistle.mp3` | Plays when a red card announcement is shown |

**Recommended sources (royalty-free, free to download):**
- [pixabay.com/music](https://pixabay.com/music/) — search "lofi chill ambient", "stadium fanfare", "crowd goal cheer", "referee whistle crowd"
- [freesound.org](https://freesound.org/) — filter by CC0 licence

Download your chosen files, rename them to match the filenames above, and drop them into the `audio/` folder in the project directory.

**Routing audio through OBS / Streamlabs:**

Browser Source audio does not appear in the mixer by default. For each Browser Source that plays audio (Starting Soon, Lineup, Lower Third):

1. In Streamlabs, right-click the Browser Source → **Properties**
2. Tick **"Control audio via OBS"**
3. The source will now appear as a track in the Audio Mixer — set the volume there

> If you don't route audio this way, the sounds play inside the browser source process but are never sent to your stream or monitoring output.

---

## Every Game Day

### Step 1 — Start the server

Double-click **`START MFCLIVE.bat`**.

The launcher checks for Node.js, cloudflared, and npm packages — installing anything missing automatically. The server starts in its own terminal window. After ~30 seconds the **game setup wizard opens in your browser** automatically once the Cloudflare tunnel is ready.

Leave the server terminal open for the entire stream. To stop, close its window or press **Ctrl+C** inside it.

### Step 2 — Set the kickoff time

In the game setup wizard, complete the pre-game setup (team names, lineups, kickoff time). The wizard will redirect you to the controller when done — or scan the QR code in the wizard's connection bar to open the controller on your phone.

### Step 3 — Check upload speed and set bitrate

Run [speedtest.net](https://www.speedtest.net) on the stream PC connected to the hall's Wi-Fi. Use **70% of your upload speed** as your bitrate:

| Upload speed | Recommended bitrate | Resolution |
|---|---|---|
| 7 Mbps or more | 4500–5000 kbps | 1080p30 |
| 4–7 Mbps | 3000–4000 kbps | 1080p30 |
| Under 4 Mbps | 2500 kbps | 720p30 |

Set bitrate in Streamlabs → Settings → Output.

### Step 4 — Set Windows power plan

Search "power plan" in the Start menu and select **Best Performance**. Plug in the charger. Never stream on battery.

### Step 5 — Open the controller on your phone

The game setup wizard (which opens automatically) shows a QR code in the connection bar at the top. Scan it with your phone — the controller opens in the phone's browser. The QR points to a Cloudflare tunnel URL, so **the phone does not need to be on the same Wi-Fi** as the stream PC.

The token is baked into the QR URL and persists across restarts (stored in `~/.mfclive/token.txt`), so you only need to re-scan if you switch devices.

> **Fallback:** If the Cloudflare tunnel is unavailable, the QR shows the local network URL. In that case the phone must be on the same Wi-Fi as the stream PC.

### Step 6 — Load the roster from FOGIS

1. On the stream PC, log in to [minfotboll.se](https://www.minfotboll.se)
2. Navigate to today's game page
3. Click **⚽ MFC Load Roster** in your bookmarks bar
4. A small banner confirms the fetch. A new tab opens briefly showing team names and player counts, then closes automatically
5. The controller, scoreboard, lineup, and starting soon overlay all update instantly with real team names, logos, and squad

> **Your club is always shown on the left (home side)** regardless of how FOGIS lists the teams. The server identifies your club by matching the team name against a keyword list in `server.js` — look for `MFC_KEYWORDS` near the top of the `processRosterData` function and update it to match your club's name.

### Step 7 — Check team short names

After loading, check the **Team Short Names** card at the top of the controller. The system auto-abbreviates team names by taking the first letter of each word and keeping known sport suffixes whole (e.g. "Malmö Futsal Club" → "MFC", "Öjersjö IF" → "ÖIF", "Hammarby IF" → "HIF"). If the result looks wrong for the opponent, just type the correct abbreviation — the scoreboard updates live.

### Step 8 — Run a test stream

Start an unlisted stream to YouTube for 2–3 minutes to confirm video quality, audio, and overlays are all working before the real stream begins.

---

## Using the Controller

### Overlays

The **🎬 Overlays** card at the top of the controller lets you show or hide any overlay directly — no need to switch scenes in Streamlabs.

Each row shows a live status pill:
- **● LIVE** (green, pulsing) — the overlay is currently visible on stream
- **○ HIDDEN** (grey) — the overlay is invisible; the Browser Source is still connected

Tap any row to toggle it. Transitions are animated (each overlay has its own effect).

**Default visibility when the server starts:**

| Overlay | Default |
|---|---|
| Scoreboard | ● LIVE |
| Lineup | ○ HIDDEN |
| Lower Third | ● LIVE |
| Starting Soon | ○ HIDDEN |
| BRB | ○ HIDDEN |

> **Tip:** A typical pre-match flow — show Starting Soon while waiting, then hide it and show the Scoreboard when the game begins. For half time, show BRB, then hide it when play resumes.

---

### Timer

| Button | Action |
|---|---|
| **▶ Start** | Start the countdown timer |
| **⏸ Stop** | Pause the timer |
| **↺ Reset** | Reset to 20:00 (asks for confirmation) |
| **↩ Undo** | Restores the timer to before the reset (available for 10 seconds) |
| **✎ Adjust** | Opens the exact-time setter to correct drift (see below) |

The timer counts **down** from 20:00 (futsal effective time). It turns red and pulses in the last 60 seconds. The pulsing dot on the scoreboard shows whether the timer is running.

A horizontal divider separates **▶ Start** and **⏸ Stop** from the secondary controls (Reset, Adjust, Undo) to reduce the risk of accidental taps during play.

#### Adjusting for drift

If the on-screen timer falls out of sync with the official hall timer, tap **✎ Adjust**. The panel opens pre-loaded with the current live value, showing independent ▲ / ▼ steppers for minutes and seconds. Step to the exact time the referee calls, then tap **✓ Apply**. The panel closes automatically and the overlay updates instantly. It also auto-closes after 15 seconds of inactivity.

**Keyboard shortcuts** (with the controller page focused, not in a text field):

| Key | Action |
|---|---|
| `Space` | Start / Stop timer |
| `1` | Home goal |
| `2` | Away goal |
| `Q` | Undo home goal |
| `W` | Undo away goal |
| `F` | Home foul |
| `G` | Away foul |
| `H` | Hide lower third |

### Half

Switch between **1st Half** and **2nd Half**. Changing the period automatically resets foul counts for both teams, resets the timer to 20:00, and clears the half time state on the scoreboard.

**☕ Half Time — 15:00** does the following in one tap:
- Stops the timer and loads 15:00
- Sets the scoreboard period label to **HALF TIME**

Press **▶ Start** when the break begins. When play resumes, tap **2nd Half** — this clears the HALF TIME label and resets fouls automatically. If the teams are ready before 15 minutes, tap **↺ Reset** to snap back to 20:00 first, then tap **2nd Half** and **▶ Start**.

### Team Short Names

Editable text fields for the 3–4 letter abbreviations shown on the scoreboard. Auto-populated when the roster loads, but can be changed at any time.

### Score & Fouls

- **+ Goal** / **– Undo** for each team
- **+ Foul** / **– Undo** for each team

Fouls are tracked per half (reset when you change period). The scoreboard shows 5 orange dots per team. At 5 fouls the label reads **MAX**. From foul 6 onwards it shows the count above 5 — at this point the opposing team is entitled to a free kick from 10m without a wall.

### Red Cards (2-minute penalties)

1. Type the player's name in the text field
2. Tap **Home** or **Away** to assign the penalty
3. A 2-minute countdown appears on the scoreboard
4. The penalty clears automatically when the opposing team scores, or you can tap **✕** to clear it manually

### Lower Third

Used for on-screen announcements (goals, substitutions, etc.). The graphic adapts to the event type: goals show a gold bar with the team logo and trigger a particle burst + shine sweep; red cards use red accents with a strobe flash; substitutions use blue accents. Each event type has its own full-screen flash effect and a matching audio cue.

1. Fill in **Line 1** (player name or event) and **Line 2** (label, e.g. "GOAL")
2. Choose a duration from the dropdown: **6s / 8s / 10s / 15s / ∞**
3. Tap **▶ Show** — the graphic slides in from the left
4. It auto-hides after the chosen duration, or tap **✕ Hide** to dismiss early

**∞ (infinity)** keeps it on screen permanently until you tap Hide — useful for pre-match or half-time announcements.

**Quick-pick player buttons** appear below the duration selector after the roster is loaded. Tap any player to instantly fill Line 1 with their name and Line 2 with `GOAL · [current time]`. The full squad is shown — starters and substitutes.

### Players

The **Players** card shows the full squad for each team — starters and substitutes in separate sections when the away team has uploaded their roster with substitutes flagged in FOGIS. If a team uploaded a flat list (no substitute distinction), all players are shown together.

The text areas are populated automatically when the roster loads. You can also edit them manually — one player per line. Tap **Save & Push to Overlay** to send them to the lineup overlay.

Once you manually edit a textarea the field is locked and will not be overwritten by live state updates. To re-sync with the latest roster, tap the **↺ Re-sync** button next to the section heading, or simply run the bookmarklet again — a fresh FOGIS import always clears the lock automatically.

**Quick-pick player buttons** (in the Lower Third card) show the full squad after the roster loads — starters and subs — so you can tap any player for a goal announcement regardless of whether they started.

---

## Overlay Reference

### Scoreboard

```
● 1ST HALF   20:00
[LOGO] MFC    3  ●●●○○
[LOGO] ÖJE    1  ●○○○○  🟥 01:45
```

- **Timer bar** — period label, pulsing dot (running indicator), countdown
- **Team rows** — logo, abbreviated name, score (flashes on goal), foul dots, red card timer (hidden when no active penalty)

### Team Lineup

Full-screen overlay showing both squads side by side in a mirrored layout (home right-aligned, away left-aligned, logos in the centre). When a team has uploaded substitutes in FOGIS, the overlay automatically shows **Starting** and **Substitutes** section labels. Teams with a flat roster upload show all players without section labels. Populated from FOGIS automatically after the bookmarklet runs.

Plays an attention-grabbing fanfare when it becomes visible and fades the audio out on hide.

### Starting Soon

Full-screen pre-match overlay showing both team logos, names, league, arena, and a live countdown to kickoff. The hours column hides automatically under 60 minutes. Turns green and shows "It's time!" at zero. Populated from FOGIS automatically after the bookmarklet runs.

Loops a relaxing ambient track while visible — audio fades in on show and fades out on hide, in sync with the visual transition.

### Lower Third

Slides in from the left when triggered. Audio cues:
- **Goal** — hype crowd track fades in with the slide-in, fades out when dismissed
- **Red card** — whistle + crowd reaction fires immediately on appearance, fades out on dismiss
- **Substitution** — no audio (visual-only: orange accents)

### BRB

Full-screen "We'll Be Right Back" overlay for unexpected breaks. Transparent body — sits over your background image in Streamlabs. Connects to the server via SSE so its visibility can be toggled from the 🎬 Overlays card in the controller.

---

## Cloudflare Tunnel

MFCLIVE uses [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) to make the controller accessible from any network — no port forwarding, no static IP, no account required.

When the server starts, it spawns `cloudflared` in the background and waits for the tunnel to be fully registered at Cloudflare's edge (~30 seconds). Only then does the game setup wizard open and show the tunnel QR. The QR URL looks like:

```
https://random-words.trycloudflare.com/controller?token=...
```

The tunnel URL changes on every server restart (this is a Cloudflare limitation for account-less tunnels). The token in the URL is persistent.

`cloudflared.exe` is downloaded automatically to the project folder by `START MFCLIVE.bat` if not already present. No installation or account needed.

---

## Troubleshooting

**Server won't start**
Run `START MFCLIVE.bat` — it installs Node.js automatically if missing. If the bat file itself fails, check that you have internet access and that your antivirus is not blocking it.

**Port already in use**
`START MFCLIVE.bat` will detect this and ask if you want to kill the existing instance. Answer **Y** to restart cleanly.

**Controller actions work but UI doesn't update (timer doesn't run on phone)**
The EventSource connection is being blocked — the controller was likely opened without the token in the URL. Scan the QR from the wizard's connection bar instead of typing the URL manually.

**Controller won't load on phone via tunnel**
The wizard's connection bar shows the tunnel status. If the tunnel is unavailable, the phone must be on the same Wi-Fi as the stream PC. Check that `cloudflared.exe` is present in the project folder — re-running `START MFCLIVE.bat` will download it if missing.

**Tunnel shows active but QR gives 404**
A previous cloudflared named-tunnel config at `%USERPROFILE%\.cloudflared\config.yaml` may be interfering. Rename or delete that file and restart.

**Bookmarklet gives an error**
Make sure you are logged in to minfotboll.se and are on the actual game page (the URL must contain the game ID, e.g. `/1993474`). The server must be running. If the error mentions `file://`, you generated the bookmarklet by opening the HTML file directly — open `http://localhost:3000/bookmarklet` through the server instead, regenerate, and re-save the bookmark.

**Logos not showing**
The logos are fetched from the FOGIS CDN and proxied through the local server at `/logo/home` and `/logo/away`. They load after the bookmarklet runs. If they still don't appear, check the server terminal for errors.

**Overlay background not transparent**
In the Browser Source properties in Streamlabs, paste this into the **Custom CSS** field:
```css
body { background-color: rgba(0, 0, 0, 0) !important; }
```

**Timer / scores not updating on overlays**
The overlays connect via Server-Sent Events. Refresh the Browser Source in Streamlabs (right-click → Refresh). Make sure the server is still running.

**No audio on overlays**
Check in order:
1. Confirm the `.mp3` files exist in the `audio/` folder with the exact filenames listed in [Audio Setup](#4-audio-setup)
2. In Streamlabs, right-click each audio-enabled Browser Source → Properties → tick **"Control audio via OBS"**
3. Check the Audio Mixer in Streamlabs — the browser source track must not be muted and volume must not be at zero
4. If testing outside OBS in a regular browser (Chrome/Edge), audio will be blocked until you click somewhere on the page — this is a browser autoplay restriction that does not affect OBS

**Audio plays but volume doesn't fade correctly**
Refresh the Browser Source in Streamlabs. This can happen if the overlay page was loaded before the server was ready.

**Dropped frames / stuttering stream**
Check Windows power plan is set to Best Performance and the charger is plugged in. If still dropping frames, switch to x264 at `veryfast` preset in Streamlabs Output settings — it's slower to encode but uses the CPU instead of the GPU and is more stable on low-end hardware.

**Red card shows on scoreboard with no active penalty**
Restart the server — this was a known display bug that has since been fixed.

---

## Stopping the Server

Close the **MFCLIVE Server** terminal window, or press **Ctrl+C** inside it. cloudflared is stopped automatically when the server exits.

If the terminal was closed without stopping first:

```
taskkill /F /IM node.exe
```

---

*MFCLIVE — built for Malmö Futsal Club*
© 2025 Besmir Pepa. All rights reserved.
