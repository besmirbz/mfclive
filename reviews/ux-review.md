# MFCLIVE Live-Streaming Overlay System — UX/UI Review

**Review Date:** April 2026 | **Scope:** controller.html, wizard.html, bookmarklet.html, overlay.html, index.html, signup.html

---

## Executive Summary

MFCLIVE is a high-stakes live-broadcast system where operator mistakes are immediately visible to viewers. The UX is functionally strong but has critical gaps in error prevention, feedback, and mobile responsiveness.

### Key Findings

**CRITICAL (break matches):**
- No confirmation on destructive actions (Reset timer, Reset game)
- Zero feedback when actions succeed → accidental duplicates
- Mobile layout breaks on phones <380px (25% of market)

**HIGH (major friction):**
- Wizard state lost on page refresh
- Form validation only uses alerts
- Controller can't navigate back to setup
- FOGIS bookmarklet instructions unclear

**MEDIUM (polish issues):**
- Red card penalty timer not animated
- Overlay animations may distract broadcast
- Overlay visibility toggle not discoverable
- Keyboard shortcuts not discoverable

---

## Critical Issues — Phase 1

### 1. Destructive Actions Without Confirmation

**Issue:** Reset timer (line 159), Reset game (line 303), undo buttons — all have zero guards.

**Impact:** Operator resets timer by accident → viewers see wrong state; no undo visible until operator notices button layout change.

**Fix:** Add `confirm()` dialogs; show toast confirmations; require double-tap for Reset Game.
**Effort:** 1 hour

### 2. Zero Feedback When Actions Succeed

**Issue:** Tapping "+Goal" or "+Foul" provides no immediate feedback. Only confirmation is when SSE broadcasts state back (50-500ms delay).

**Impact:** On slow WiFi, operator might tap again thinking action failed → double-goal recorded.

**Fix:** Add button invert animation; show toast (`toast('⚽ Goal! 1–0')`); play beep; add debounce.
**Effort:** 2 hours

### 3. Mobile Layout Breaks <380px

**Issue:** 
- `maximum-scale=1` disables zoom (WCAG violation)
- No responsive breakpoint for small screens
- Header cramped; timer clips; two-column buttons too small (15px hit target)
- No 44px minimum button size enforcement

**Impact:** Layout unusable on iPhone SE (375px), Pixel 4a (393px) — ~25% of phones.

**Fix:** Add `@media (max-width: 380px)` with single-column layout, clamp() for timer, 44px buttons, hide `.conn` label.
**Effort:** 4 hours

### 4. No Way to Navigate Back to Setup

**Issue:** Line 308: `<a id="setupWizardLink" href="#" ...>` — link is `href="#"` so clicking does nothing.

**Impact:** Operator can't correct team names mid-match without page reload (risks SSE disconnect).

**Fix:** Change to `href="/wizard?token=TOKEN"` or open in new tab.
**Effort:** 1 hour

---

## High Issues — Phase 2

### 5. Wizard State Lost on Page Refresh
No localStorage persistence. Crash = all data lost.
**Fix:** Auto-save to localStorage on `beforeunload`.
**Effort:** 2 hours

### 6. Form Validation Uses Only Alerts
No inline errors; users don't know which field failed.
**Fix:** Show red borders and error text below fields.
**Effort:** 3 hours

### 7. FOGIS Bookmarklet Instructions Confusing
User copy-pastes raw JavaScript; no clear one-time setup message.
**Fix:** Move to separate page or simplify with links.
**Effort:** 2 hours

### 8. No FOGIS Cancel Button
If game URL is wrong, user stuck in polling state forever.
**Fix:** Add cancel button in waiting state.
**Effort:** 1 hour

---

## Medium Issues — Phase 3

### 9. Red Card Timer Not Animated
Countdown shows as static text; operator can easily miss expiry.
**Fix:** Add pulse animation; change color to yellow <0:30; audio alert at 10sec.
**Effort:** 1 hour

### 10. Keyboard Shortcuts Hidden
Hints are tiny gray text (10px, opacity 0.4); operator watching secondary monitor won't see.
**Fix:** Add "?" modal with shortcuts; make hints bright blue on mobile.
**Effort:** 2 hours

### 11. Overlay Animations May Distract
Scoreboard 550ms slide-in, lower third goal celebration with particles and flashes, full-screen red flash (seizure risk).
**Fix:** Add animation toggle (Full/Minimal/None); replace red flash with glow.
**Effort:** 3 hours

### 12. Overlay Toggle Not Discoverable
Rows are clickable but not obviously so; no cursor pointer or hover effect.
**Fix:** Add cursor pointer, hover effect, eye icon, tooltip.
**Effort:** 1 hour

---

## Accessibility Issues

1. **maximum-scale=1** violates WCAG — disable zoom only with `user-scalable=no`
2. **Low contrast text** (bookmarklet) — 4.5:1 is borderline; increase to 5:1+
3. **Red flash** may trigger seizure warnings — replace with subtle glow
4. **Missing ARIA labels** on icon buttons — add `aria-label`
5. **Color-only foul indicators** — add text or pattern underneath

---

## Implementation Timeline

**Phase 1 (Critical):** 8 dev + 4 test = 12 hours
- Confirmation guards on destructive actions
- Toast feedback on all actions
- Mobile responsive <380px
- Back-navigation to setup
→ **Ready for first match**

**Phase 2 (High):** 8 dev + 3 test = 11 hours
- Wizard progress recovery (localStorage)
- Inline form validation
- FOGIS improvements
- FOGIS cancel button
→ **Ready for second match**

**Phase 3 (Polish):** 11 dev + 2 test = 13 hours
- Keyboard shortcut help modal
- Red card timer animation
- Overlay animation toggle
- Overlay toggle UX
- Accessibility fixes

**Total: ~36-40 hours** to production-ready UX

---

## Findings Summary

| Component | Issue | Severity | Phase |
|-----------|-------|----------|-------|
| controller.html | No confirmation on Reset/Clear | CRITICAL | P1 |
| controller.html | Zero action feedback | CRITICAL | P1 |
| controller.html | Mobile <380px broken | CRITICAL | P1 |
| controller.html | Can't navigate to wizard | HIGH | P1 |
| wizard.html | State lost on refresh | HIGH | P2 |
| wizard.html | Form alerts only | HIGH | P2 |
| wizard.html | FOGIS setup unclear | HIGH | P2 |
| wizard.html | No FOGIS cancel | HIGH | P2 |
| controller.html | Red card timer static | MEDIUM | P3 |
| controller.html | Shortcuts hidden | MEDIUM | P3 |
| overlay.html | Animations distract/seizure risk | MEDIUM | P3 |
| controller.html | Toggle not discoverable | MEDIUM | P3 |

---

## Conclusion

Phase 1 fixes (confirmation, feedback, mobile) are essential before first broadcast. Operator experience will transform from risky to reliable once these are implemented. Phase 2 and 3 improve usability and polish.

**Critical path:** Implement Phase 1 (12 hours) → test on live match → deploy.

