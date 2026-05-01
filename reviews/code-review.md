# MFCLIVE Code Review Report

**Date**: 2026-04-14

## Executive Summary

MFCLIVE is a well-architected multi-tenant SaaS streaming overlay system. The codebase demonstrates strong fundamentals in separation of concerns, error handling, and security. However, several issues exist that could impact reliability at scale.

**Overall Assessment**: Production-ready with critical fixes recommended.

## CRITICAL Issues

### [C1] Unhandled Promise Rejection in Stripe Webhook (server-saas.js:1036-1076)

The async handler calls mailer.sendMail() without awaiting completion before sending the HTTP response. If email fails after response is sent, the rejection is unhandled.

**Impact**: Server process crash, lost email notifications
**Fix**: Wrap async work in IIFE, send response only after completion

## HIGH Issues

### [H1] SSE Connection Interval Leak (server-saas.js:687-690)

Keepalive interval may not be cleared on connection drop, causing memory leak.

**Fix**: Add cleanup function called on both error and close events

### [H2] Red Card State Race Condition (server-saas.js:483-486)

When goal is scored, red cards are cleared without atomicity. Overlapping actions can corrupt state.

**Fix**: Ensure state broadcast is immediate or implement action locking

### [H3] FOGIS Roster Import Race (server-saas.js:825-887)

No locking prevents concurrent roster updates, corrupting player data.

**Fix**: Add import lock flag on room object

## MEDIUM Issues

### [M1] Timer Interval Not Cleared (controller.html:395)
- **Issue**: Global interval never cleared on page unload
- **Fix**: Add beforeunload listener

### [M2] Watchdog Timeout Conflicts Backoff (controller.html:544)
- **Issue**: Fixed 10s watchdog prevents exponential backoff from working
- **Fix**: Make watchdog timeout dynamic: max(15000, backoffDelay + 5000)

### [M3] Logo URL Cache-Busting (controller.html:518)
- **Issue**: ?t=Date.now() appended on every state update, defeating caching
- **Fix**: Only update timestamp on actual URL change

### [M4] Polling Stops Permanently (controller.html:532)
- **Issue**: Once SSE works, polling stops but doesn't resume on SSE failure
- **Fix**: Resume polling in es.onerror handler

### [M5] No Rate Limit on Roster Import (server-saas.js:825)
- **Issue**: 512KB imports with no rate limiting allows DoS
- **Fix**: Apply checkRateLimit to roster imports

### [M6] Missing CSRF Protection (server-saas.js:607)
- **Issue**: Token-based auth vulnerable to fetch-based CSRF
- **Fix**: Require token in header only, disallow query parameter for POST

## LOW Issues

### [L1] Logo Proxy Timeout Incomplete (server-saas.js:722)
- **Issue**: Timeout only on connection, not body transfer
- **Fix**: Add stream timeout

### [L2] Color Validation UX (wizard.html)
- **Issue**: Server validation fails silently
- **Fix**: Display error messages

### [L3] Unused Variable (controller.html:636)
- **Issue**: pdMs variable declared but never used
- **Fix**: Remove or use in confirmation message

### [L4] Success Page Branding (server-saas.js:750)
- **Issue**: Roster import success doesn't show club name
- **Fix**: Include club name in response HTML

### [L5] Audio Fade Freeze Risk (audio-util.js:9)
- **Issue**: If durationMs=0, interval period becomes 0 (busy loop)
- **Fix**: Check duration and fade immediately if zero

### [L6] Inline Event Handlers (bookmarklet.html)
- **Issue**: onclick attributes instead of addEventListener
- **Fix**: Use addEventListener for modern consistency

## INFO Notes

- **I1**: WAL mode documentation should note that writes still serialize
- **I2**: Stripe webhook secret validation missing in production check
- **I3**: Consider JSON logging, unit tests, health endpoint, Redis for scaling

## Summary Table

| Issue | File | Severity |
|-------|------|----------|
| Unhandled async/await | server-saas.js:1036 | CRITICAL |
| SSE interval leak | server-saas.js:687 | HIGH |
| Red card race | server-saas.js:483 | HIGH |
| Roster import race | server-saas.js:825 | HIGH |
| Timer not cleared | controller.html:395 | MEDIUM |
| Watchdog conflict | controller.html:544 | MEDIUM |
| Cache-busting | controller.html:518 | MEDIUM |
| Polling fallback | controller.html:532 | MEDIUM |
| No rate limit | server-saas.js:825 | MEDIUM |
| CSRF risk | server-saas.js:607 | MEDIUM |
| Timeout incomplete | server-saas.js:722 | LOW |
| Validation UX | wizard.html | LOW |
| Dead variable | controller.html:636 | LOW |
| Success branding | server-saas.js:750 | LOW |
| Audio freeze | audio-util.js:9 | LOW |
| Event handlers | bookmarklet.html | LOW |

## Recommendations

**Immediate (Week 1)**:
1. Fix async/await in Stripe webhook (C1)
2. Add SSE cleanup function (H1)
3. Add roster import lock (H3)

**Short-term (Weeks 2-3)**:
4. Fix red card atomicity (H2)
5. Fix timer cleanup and watchdog (M1, M2)
6. Optimize logo caching (M3)
7. Resume polling on error (M4)
8. Add rate limiting (M5)

**Long-term**:
- Add unit tests for critical workflows
- Implement JSON structured logging
- Document scaling strategy
- Consider Redis for multi-process deployments

**Generated**: 2026-04-14
