# MFCLIVE — Comprehensive Code Review #2
**Date:** 2026-03-17
**Reviewer:** Claude Code (automated static analysis)
**Branch:** dev

---

## Executive Summary

The MFCLIVE system is a real-time streaming overlay management platform with reasonably strong foundational security practices. The codebase demonstrates awareness of critical attack vectors (XSS, SSRF, injection) and implements token-based authentication and URL validation. However, there remain several issues across security, error handling, performance, and code quality categories that should be addressed.

**Overall Assessment**: Functional and defensively coded in key areas, but has gaps in robustness, edge-case handling, and resource management that could cause runtime failures or provide footholds for exploitation in certain scenarios.

**Findings:** 19 distinct issues across all categories
- **High Priority:** 6
- **Medium Priority:** 8
- **Low Priority:** 5

---

## Per-File Findings

### server.js

#### S1-001 · HIGH — Red card timer uses stale timestamp after pause
The timer tick (line ~243–246) computes `now - rc.startedAt`. On `timer_stop`, `rc.remainingMs` is updated but `rc.startedAt` is **not reset**, so on the next start cycle the delta is applied twice, causing the countdown to jump backwards.
**Fix:** After updating `rc.remainingMs` on stop, set `rc.startedAt = now` so the next tick begins from a clean baseline.

#### S1-002 · HIGH — Race condition in SSE broadcast loop
`broadcast()` iterates the `clients` Set directly. Removing a failed client mid-iteration can skip entries. Errors are also silently swallowed with no logging.
**Fix:** Snapshot the set before iterating: `const snapshot = [...clients];`. Add `console.error` inside the catch block.

#### S1-003 · HIGH — No rate limiting on /action
An authenticated client (e.g. with a leaked token) can flood the endpoint with state mutations, exhausting resources or causing flicker.
**Fix:** Track requests-per-second per token; reject with HTTP 429 if exceeded (e.g. 20 req/s).

#### S1-004 · MEDIUM — Incomplete cleanup in logo proxy error paths
If headers have already been sent when the timeout fires, the response is never ended and the socket stays open.
**Fix:** `logoReq.on('error', () => { logoReq.destroy(); res.headersSent ? res.end() : (res.writeHead(502), res.end()); });`

#### S1-005 · MEDIUM — `abbreviateTeam` doesn't guard empty-string input
Whitespace-only names survive the `if (!name)` guard; `.trim().split(/\s+/)` then produces `['']`, and `[0][0]` returns `undefined`.
**Fix:** Add `const t = name.trim(); if (!t) return name;` before splitting.

#### S1-006 · MEDIUM — `lower_show` fields are unbounded
`line1` and `line2` are stored and broadcast without length limits, which can break the overlay layout.
**Fix:** Add `.slice(0, 100)` (or similar) to both fields in `lower_show` handling.

#### S1-007 · MEDIUM — SSE keepalive interval may write to a closed response
If a client disconnects mid-interval, the next keepalive tick attempts `res.write()` on a closed socket, triggering the error handler unnecessarily.
**Fix:** Check `!res.writableEnded` before sending the keepalive comment.

#### S1-008 · MEDIUM — `/import-roster` body accumulation without backpressure
Large-but-valid payloads (just under 512 KB) are fully buffered in a string variable before being processed. Using `req.destroy()` may not close the underlying socket in all Node versions.
**Fix:** Track byte count on each `data` event and call `req.socket.destroy()` rather than `req.destroy()` for more reliable teardown.

#### S1-009 · LOW — Unused error variable in catch blocks
Several `catch (e)` blocks (lines ~130, ~566–569, ~595–598) discard `e` silently.
**Fix:** Log to `console.error` or rename to `_e` to signal intent.

#### S1-010 · LOW — Token printed in plain text at startup
`console.log` on startup exposes the full token. CI/CD pipelines, Docker logs, or shared terminals may capture it.
**Fix:** Print a masked version: `token.slice(0, 2) + '****' + token.slice(-2)`.

---

### controller.html

#### C1-001 · HIGH — Logo URL from SSE state used without validation
`d.homeLogo` / `d.awayLogo` are set as image `src` without checking they originate from the expected server path. A compromised server could point these at arbitrary hosts.
**Fix:** Only accept URLs matching `/^\/logo\//` or the same origin before assigning to `src`.

#### C1-002 · HIGH — Lower third inputs not sanitised before sending
Fields are rendered via `textContent` on the overlay (safe), but no length or character validation is applied at the controller before the action is dispatched.
**Fix:** Add client-side length validation and strip control characters before `act('lower_show', …)`.

#### C1-003 · MEDIUM — SSE "zombie" connection not detected
Exponential backoff fires on `onerror`, but a silently stalled stream (socket alive, no data) will never reconnect. The controller will display stale state indefinitely.
**Fix:** Set a client-side watchdog (`setTimeout`) reset on every `onmessage`; fire a close/reconnect if no message arrives within ~10 s.

#### C1-004 · MEDIUM — Local red card tick may briefly show a removed card
The local 100 ms decrement interval runs independently of SSE sync. A card removed on the server may still display for up to one tick cycle.
**Fix:** On each SSE state update, immediately reconcile `localRedCards` by filtering to only IDs present in `d.redCards`.

#### C1-005 · MEDIUM — Lower third inputs not cleared after dispatch
If the user double-triggers `lower_show`, the same data is re-sent. Inputs remain populated after the action.
**Fix:** Clear `ltLine1.value` and `ltLine2.value` after a successful send.

#### C1-006 · MEDIUM — No debounce on timer adjust buttons
Rapid clicks can flood the server with `adjustStep` calls, causing the overlay time to flicker.
**Fix:** Add a 200 ms debounce or disable the buttons for one frame after each click.

#### C1-007 · LOW — SSE `JSON.parse` has no error guard
A malformed SSE message will throw an uncaught exception in the message handler.
**Fix:** Wrap `JSON.parse(e.data)` in `try/catch` and log the error.

---

### overlay-lineup.html

#### L1-001 · HIGH — Fanfare audio will not play (autoplay policy)
`fanfareAudio.play()` is called without muting first. Modern browsers block unmuted autoplay, and `.catch(() => {})` hides the failure entirely.
**Fix:** Set `fanfareAudio.muted = true` (or `volume = 0`) before the first `play()`. The existing `fadeAudio(fanfareAudio, 0.8, 400)` already handles ramp-up.

#### L1-002 · MEDIUM — `renderList` doesn't guard against non-array input
If the server sends `null` for starters (e.g. during roster reset), `.forEach` will throw.
**Fix:** `if (!Array.isArray(starters) || !starters.length) { ul.innerHTML = ''; return 0; }`

#### L1-003 · MEDIUM — Team names not re-synced on SSE reconnect
Names are updated inside the SSE handler but there is no initialisation fallback, so names may remain blank if the connection is established after the first state push.
**Fix:** Ensure the server sends full state on every SSE connection (already done by `getPublicState()`), and the handler always sets `textContent` unconditionally.

#### L1-004 · LOW — Logo col filler unnecessary on equal-length lists
Minor: `syncLogoColFiller` runs even when count hasn't changed. Already mitigated by `_logoColCount` cache — low priority.

---

### overlay-lowerthird.html

#### LT1-001 · HIGH — Audio fade starts before graphic is visible
`fadeAudio(goalAudio, 0.85, 250)` fires immediately on state change. The CSS slide-in transition takes 550 ms, so audio begins ~300 ms before the graphic appears.
**Fix:** Delay the audio fade to start at the same time as the graphic appears, or begin with a shorter fade (`fadeAudio(goalAudio, 0.85, 450)` matching the transition).

#### LT1-002 · HIGH — Rapid show/hide can confuse `wasVisible` flag
If `lowerThird.visible` toggles `true→false→true` within the same SSE batch, the `wasVisible` boolean may not correctly identify whether this is a new display event.
**Fix:** Compare the full event+team+line1 tuple to the previous state, rather than just the boolean.

#### LT1-003 · MEDIUM — Particle elements may leak if animation is interrupted
`p.remove()` inside `.onfinish` is not guaranteed to fire if the element is detached mid-animation.
**Fix:** Add `setTimeout(() => p.remove(), 2000)` immediately after starting each particle animation.

#### LT1-004 · MEDIUM — `screenFlash` colour is hardcoded per event type
Not a current risk, but the colour is derived from the event string. If the event types are ever exposed to user input, arbitrary CSS colour strings could be injected.
**Fix:** Validate the event value against the known `THEMES` object keys before calling `screenFlash`.

#### LT1-005 · LOW — Broken team logo leaves a placeholder visible
`onerror="this.style.opacity=0.3"` shows a broken-image icon at 30 % opacity rather than hiding the element.
**Fix:** `onerror="this.style.display='none'"`

---

### overlay-scoreboard.html

#### SB1-001 · MEDIUM — Score pop animation may stack if goals fire in quick succession
The `scored` class is removed and re-added via `void el.offsetWidth`. If two goals arrive within the animation duration, the second trigger is dropped or overlaps.
**Fix:** Listen for the `animationend` event before allowing a re-trigger.

#### SB1-002 · MEDIUM — Optional chaining used without null fallback
`d.overlayVisible?.scoreboard !== false` is safe in modern browsers, but will throw in older engines that don't support `?.`.
**Fix:** `const ov = (d.overlayVisible || {}).scoreboard !== false;`

#### SB1-003 · LOW — Single-letter variable names in SSE handler
Reduces readability and debuggability. Not a security issue.

---

### overlay-startingsoon.html

#### SS1-001 · MEDIUM — Kickoff time parser accepts out-of-range values
`99:99` passes the `/^\d{1,2}:\d{2}$/` regex and `isNaN()` guards, but is not a valid time.
**Fix:** Add `if (h > 23 || m > 59) return null;` after parsing `h` and `m`.

#### SS1-002 · MEDIUM — Background audio autoplay will be blocked
Same issue as L1-001. `bgAudio.play()` without muting first will silently fail in all standard browsers.
**Fix:** `bgAudio.muted = true; bgAudio.play().catch(() => {});` then unmute via `fadeAudio`.

#### SS1-003 · LOW — Countdown `setInterval` never cleared
The interval ID is discarded; the tick runs forever even if the overlay is torn down.
**Fix:** `const _countdownId = setInterval(tick, 1000);` and clear on hide.

---

### overlay-brb.html

#### BR1-001 · LOW — SSE retry loop never terminates
Exponential backoff caps at 30 s but retries indefinitely. If the server is permanently down, the overlay wastes bandwidth forever.
**Fix:** Give up after N attempts and display a "server offline" state.

---

### bookmarklet.html

#### BM1-001 · MEDIUM — Server URL not validated before bookmarklet build
Any string entered in the server URL field is injected into the bookmarklet. `JSON.stringify` escapes it safely, but malformed URLs will generate a broken bookmarklet with no user feedback.
**Fix:** Validate the input matches `http(s)://hostname(:port)` before enabling the copy button.

#### BM1-002 · MEDIUM — `execCommand('copy')` fallback is deprecated
The fallback (lines 122–127) has no error handling. Some browsers have already removed `execCommand`.
**Fix:** Wrap in `try/catch` and show an error message if both clipboard methods fail.

#### BM1-003 · LOW — Hardcoded FOGIS magic value lacks documentation
`'THIS_IS_MAGIC_VALUE'` in the bookmarklet is a valid FOGIS API constant but is not explained in a comment.
**Fix:** Add a short comment: `// FOGIS public SharedSecret — required by the API`.

---

### audio-util.js

#### AU1-001 · MEDIUM — Interval continues after `toVol === 0` pause
When fading to 0, `audio.pause()` is called at step completion, but the interval has already been ticking. This wastes a few cycles after the fade completes.
**Fix:** After calling `audio.pause()`, the `clearInterval` is already there — no extra change needed. (Low actual impact; consider a guard `if (step >= steps) { clearInterval(...); if (toVol === 0) audio.pause(); return; }` to make intent clearer.)

#### AU1-002 · LOW — No parameter validation
`toVol > 1` or negative `durationMs` produce silent misbehaviour.
**Fix:** `toVol = Math.max(0, Math.min(1, toVol)); durationMs = Math.max(0, durationMs);` at function entry.

---

## Issues Addressed in Previous Reviews

The following categories were fixed in Review #1 (commit `bd8016a`) and prior work:

- HTML escaping via `esc()` helper — XSS on 404 pages and filenames
- SSRF blocklist for logo proxy (127.x/8, 0.0.0.0, CGNAT 100.64/10, IPv6)
- Token moved from query string to `X-MFCLIVE-Token` header
- Content-Type gating on `/action` (415 for non-JSON)
- Logo proxy 5 s timeout + `on('timeout')` handler
- Timer tick skip when `clients.size === 0`
- Duplicate `id="homeLogoImg"` in controller header
- `syncLogoColFiller` O(1) cache
- Score pop animation skip on first sync (`prevHome = null`)
- SSE wrapped in `connectSSE()` with exponential backoff across all overlays
- Red card team validation before dispatch
- `renderOverlays` and `buildPlayerBtns` DOM diff optimisation
- State persistence to `~/.mfclive/state.json`
- `saveState()` called at end of `handleAction()`
- `audio-util.js` shared `fadeAudio` module extracted from inline copies

---

## Summary Table

| ID | File | Priority | Category |
|----|------|----------|----------|
| S1-001 | server.js | **HIGH** | Logic bug — red card timer stale timestamp |
| S1-002 | server.js | **HIGH** | Race condition — SSE broadcast loop |
| S1-003 | server.js | **HIGH** | DoS risk — no rate limiting on /action |
| S1-004 | server.js | MEDIUM | Error handling — logo proxy cleanup |
| S1-005 | server.js | MEDIUM | Input validation — abbreviateTeam empty string |
| S1-006 | server.js | MEDIUM | Input validation — lower_show unbounded fields |
| S1-007 | server.js | MEDIUM | Robustness — keepalive on closed response |
| S1-008 | server.js | MEDIUM | Resource exhaustion — import-roster body |
| S1-009 | server.js | LOW | Code quality — unused catch variables |
| S1-010 | server.js | LOW | Info disclosure — token in plain text logs |
| C1-001 | controller.html | **HIGH** | SSRF risk — unvalidated logo URL |
| C1-002 | controller.html | **HIGH** | XSS risk — lower third input validation |
| C1-003 | controller.html | MEDIUM | Robustness — no SSE heartbeat timeout |
| C1-004 | controller.html | MEDIUM | State sync — red card local tick race |
| C1-005 | controller.html | MEDIUM | UX — form not cleared after send |
| C1-006 | controller.html | MEDIUM | Input validation — timer adjust debounce |
| C1-007 | controller.html | LOW | Code quality — unhandled SSE parse error |
| L1-001 | overlay-lineup.html | **HIGH** | Autoplay — fanfare muted required |
| L1-002 | overlay-lineup.html | MEDIUM | Error handling — renderList non-array guard |
| L1-003 | overlay-lineup.html | MEDIUM | State sync — team name reconnect |
| L1-004 | overlay-lineup.html | LOW | Performance — logo col filler |
| LT1-001 | overlay-lowerthird.html | **HIGH** | UX — audio fires before graphic visible |
| LT1-002 | overlay-lowerthird.html | **HIGH** | Race condition — wasVisible flag |
| LT1-003 | overlay-lowerthird.html | MEDIUM | Memory leak — particle cleanup |
| LT1-004 | overlay-lowerthird.html | MEDIUM | Input validation — screenFlash colour |
| LT1-005 | overlay-lowerthird.html | LOW | UX — broken logo placeholder |
| SB1-001 | overlay-scoreboard.html | MEDIUM | Visual glitch — score animation stacking |
| SB1-002 | overlay-scoreboard.html | MEDIUM | Compatibility — optional chaining |
| SB1-003 | overlay-scoreboard.html | LOW | Readability — variable names |
| SS1-001 | overlay-startingsoon.html | MEDIUM | Input validation — kickoff time range |
| SS1-002 | overlay-startingsoon.html | MEDIUM | Autoplay — bgAudio muted required |
| SS1-003 | overlay-startingsoon.html | LOW | Resource leak — countdown interval |
| BR1-001 | overlay-brb.html | LOW | Robustness — infinite SSE retry |
| BM1-001 | bookmarklet.html | MEDIUM | Input validation — URL not validated |
| BM1-002 | bookmarklet.html | MEDIUM | Deprecated API — execCommand fallback |
| BM1-003 | bookmarklet.html | LOW | Code quality — magic value undocumented |
| AU1-001 | audio-util.js | MEDIUM | Resource management — interval after pause |
| AU1-002 | audio-util.js | LOW | Defensive programming — no param validation |
