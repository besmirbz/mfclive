/**
 * MFCLIVE — Stream Overlay Server
 * © 2025 Besmir Pepa
 * Run: node server.js
 * Controller (phone/tablet): http://<pc-local-ip>:3000/controller
 * Browser Sources in Streamlabs:
 *   Scoreboard  → http://localhost:3000/scoreboard   (1920×100px)
 *   Lower Third → http://localhost:3000/lowerthird   (1920×1080px)
 *   Lineup      → http://localhost:3000/lineup       (1920×1080px)
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const os   = require('os');
const PORT = 3000;

// ── Detect local LAN IP ────────────────────────────────────────────────────────
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '<pc-ip>';
}

// ── Security token — generated fresh on every server start ────────────────────
// Anyone who wants to control the overlay must have the URL printed below.
const SECRET = crypto.randomBytes(6).toString('hex'); // e.g. "a3f9c2b1e4d7"

// Requests from localhost are always allowed (Streamlabs browser sources).
// Requests from the network must include ?token=SECRET or X-MFCLIVE-Token header.
function isAuthorised(req) {
  const host = req.headers['host'] || '';
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) return true;
  const url  = new URL(req.url, `http://localhost:${PORT}`);
  const qTok = url.searchParams.get('token');
  const hTok = req.headers['x-mfclive-token'];
  return qTok === SECRET || hTok === SECRET;
}

// Simple HTML-escape for user-supplied strings injected into HTML responses
function esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const HALF_DURATION_MS = 20 * 60 * 1000; // 20:00

// ── Game State ─────────────────────────────────────────────────────────────────
const state = {
  homeTeam:  'MFC',
  awayTeam:  'AWAY',
  homeScore: 0,
  awayScore: 0,
  period:    1,
  // Timer — counts DOWN from HALF_DURATION_MS to 0
  timerMs:      HALF_DURATION_MS,
  timerRunning: false,
  timerStart:   null,   // Date.now() snapshot when last started
  timerBaseMs:  HALF_DURATION_MS, // value of timerMs at last start
  // Fouls — reset each half
  homeFouls: 0,
  awayFouls: 0,
  // Red cards — array of active penalties
  // { id, team:'home'|'away', player:string, remainingMs:number, startedAt:number }
  redCards: [],
  _nextRedCardId: 1,
  // Half time flag
  halfTime: false,
  // Lower third
  lowerThird: { visible: false, line1: '', line2: '' },
  // Lineup
  lineup: {
    home: ['#1 Keeper','#4 Player','#7 Player','#9 Player','#11 Player'],
    away: ['#1 Keeper','#5 Player','#8 Player','#10 Player','#14 Player'],
  }
};

// ── SSE clients ────────────────────────────────────────────────────────────────
const clients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch(e) { clients.delete(res); }
  }
}

function getElapsed() {
  if (!state.timerRunning) return state.timerMs;
  const elapsed = Date.now() - state.timerStart;
  return Math.max(0, state.timerBaseMs - elapsed);
}

function getPublicState() {
  const now = Date.now();
  const redCards = state.redCards.map(rc => ({
    ...rc,
    remainingMs: Math.max(0, rc.remainingMs - (state.timerRunning ? now - rc.startedAt : 0))
  })).filter(rc => rc.remainingMs > 0);
  return {
    type:         'state',
    homeTeam:     state.homeTeam,
    awayTeam:     state.awayTeam,
    homeLogo:     state.homeLogo,
    awayLogo:     state.awayLogo,
    homeScore:    state.homeScore,
    awayScore:    state.awayScore,
    period:       state.period,
    halfTime:     state.halfTime,
    timerMs:      getElapsed(),
    timerRunning: state.timerRunning,
    homeFouls:    state.homeFouls,
    awayFouls:    state.awayFouls,
    redCards,
    lowerThird:   state.lowerThird,
    lineup:       state.lineup,
    arena:        state.arena,
    league:       state.league,
    homePlayers:  state._homePlayers || [],
    awayPlayers:  state._awayPlayers || [],
    homeStarters: state._homeStarters || [],
    homeSubs:     state._homeSubs     || [],
    awayStarters: state._awayStarters || [],
    awaySubs:     state._awaySubs     || [],
  };
}

// ── Tick every 500ms ───────────────────────────────────────────────────────────
setInterval(() => {
  if (!state.timerRunning) return;

  const now = Date.now();

  // Auto-expire red cards
  state.redCards = state.redCards.filter(rc => {
    const elapsed = now - rc.startedAt;
    return (rc.remainingMs - elapsed) > 0;
  });
  // Update remaining on survivors
  state.redCards.forEach(rc => {
    rc.remainingMs = Math.max(0, rc.remainingMs - (now - rc.startedAt));
    rc.startedAt = now;
  });

  // Auto-stop timer at 00:00
  const remaining = getElapsed();
  if (remaining <= 0) {
    state.timerMs      = 0;
    state.timerRunning = false;
  }

  broadcast(getPublicState());
}, 500);

// ── Action handler ─────────────────────────────────────────────────────────────
function handleAction(action, payload) {
  switch (action) {
    case 'timer_start':
      if (!state.timerRunning && state.timerMs > 0) {
        state.timerBaseMs  = state.timerMs;
        state.timerStart   = Date.now();
        state.timerRunning = true;
        // Also refresh red card startedAt so they tick correctly
        state.redCards.forEach(rc => rc.startedAt = Date.now());
      }
      break;

    case 'timer_stop':
      if (state.timerRunning) {
        state.timerMs      = getElapsed();
        state.timerRunning = false;
        // Freeze red card remaining
        state.redCards.forEach(rc => {
          rc.remainingMs = Math.max(0, rc.remainingMs - (Date.now() - rc.startedAt));
        });
      }
      break;

    case 'timer_reset':
      state.timerMs      = HALF_DURATION_MS;
      state.timerBaseMs  = HALF_DURATION_MS;
      state.timerRunning = false;
      state.timerStart   = null;
      break;

    case 'goal_home':
      state.homeScore++;
      // Clear away red cards (opponents scored → player returns)
      state.redCards = state.redCards.filter(rc => rc.team !== 'away');
      break;

    case 'goal_away':
      state.awayScore++;
      state.redCards = state.redCards.filter(rc => rc.team !== 'home');
      break;

    case 'undo_home':
      state.homeScore = Math.max(0, state.homeScore - 1);
      break;

    case 'undo_away':
      state.awayScore = Math.max(0, state.awayScore - 1);
      break;

    case 'foul_home':
      state.homeFouls = Math.min(9, state.homeFouls + 1);
      break;

    case 'foul_away':
      state.awayFouls = Math.min(9, state.awayFouls + 1);
      break;

    case 'undo_foul_home':
      state.homeFouls = Math.max(0, state.homeFouls - 1);
      break;

    case 'undo_foul_away':
      state.awayFouls = Math.max(0, state.awayFouls - 1);
      break;

    case 'red_card_add':
      state.redCards.push({
        id:          state._nextRedCardId++,
        team:        payload.team === 'away' ? 'away' : 'home',
        player:      String(payload.player || '').slice(0, 60).replace(/[<>"']/g, ''),
        remainingMs: 2 * 60 * 1000,
        startedAt:   Date.now(),
      });
      break;

    case 'red_card_remove':
      state.redCards = state.redCards.filter(rc => rc.id !== payload.id);
      break;

    case 'set_period':
      state.period    = payload.period;
      state.halfTime  = false;
      state.homeFouls = 0;
      state.awayFouls = 0;
      state.timerMs   = HALF_DURATION_MS;
      state.timerBaseMs = HALF_DURATION_MS;
      state.timerRunning = false;
      break;

    case 'set_halftime':
      state.halfTime = payload.active === true;
      break;

    case 'lower_show':
      state.lowerThird = { visible: true, line1: payload.line1||'', line2: payload.line2||'' };
      break;

    case 'lower_hide':
      state.lowerThird = { visible: false, line1: '', line2: '' };
      break;

    case 'set_lineup':
      if (payload.home) state.lineup.home = payload.home;
      if (payload.away) state.lineup.away = payload.away;
      break;
    case 'set_team_names':
      if (payload.homeTeam) state.homeTeam = payload.homeTeam.slice(0,6).toUpperCase();
      if (payload.awayTeam) state.awayTeam = payload.awayTeam.slice(0,6).toUpperCase();
      break;
    case 'timer_set':
      state.timerMs = Math.min(HALF_DURATION_MS, Math.max(0, payload.ms || 0));
      state.timerStartedAt = Date.now();
      state.timerRunning = false;
      break;
  }
  broadcast(getPublicState());
}

// ── HTTP Server ────────────────────────────────────────────────────────────────

// ── Single consolidated HTTP router ───────────────────────────────────────────
const https = require('https');
const server = http.createServer({ maxHeaderSize: 65536 }, (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = url.pathname;

  // Tighten CORS — only allow localhost origins, not the open web
  const origin = req.headers['origin'] || '';
  if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MFCLIVE-Token');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Single auth gate — blocks ALL non-localhost requests without token ───────
  // Streamlabs browser sources connect from localhost → always pass.
  // Your phone on the hall WiFi → must have token in URL (?token=SECRET)
  //   or X-MFCLIVE-Token header (set automatically by the controller).
  if (!isAuthorised(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // ── SSE stream ──────────────────────────────────────────────────────────────
  if (route === '/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    res.write(`data: ${JSON.stringify(getPublicState())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // ── Action API ──────────────────────────────────────────────────────────────
  if (req.method === 'POST' && route === '/action') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 8192) { res.writeHead(413); res.end('Too large'); req.destroy(); } });
    req.on('end', () => {
      try {
        const { action, payload } = JSON.parse(body || '{}');
        handleAction(action, payload || {});
      } catch(e) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getPublicState()));
    });
    return;
  }

  // ── Import roster (called by bookmarklet via window.open GET) ───────────────
  if (route === '/import-roster') {
    function processRosterData(timeline, lineup) {
      const hdr = timeline?.GameHeaderInfo || {};

      // Determine if MFC is the home or away team in FOGIS data
      // so we always show MFC on the left (home) side in our overlay
      const MFC_KEYWORDS = ['malmö futsal', 'mfc'];
      const fogisHomeName = (hdr.HomeTeamDisplayName || '').toLowerCase();
      const mfcIsHome = MFC_KEYWORDS.some(k => fogisHomeName.includes(k));

      // Assign home/away so MFC is always our "home" side
      const ourHomeRoster  = mfcIsHome ? lineup?.HomeTeamGameTeamRoster : lineup?.AwayTeamGameTeamRoster;
      const ourAwayRoster  = mfcIsHome ? lineup?.AwayTeamGameTeamRoster : lineup?.HomeTeamGameTeamRoster;
      const ourHomeTeam    = mfcIsHome ? hdr.HomeTeamDisplayName : hdr.AwayTeamDisplayName;
      const ourAwayTeam    = mfcIsHome ? hdr.AwayTeamDisplayName : hdr.HomeTeamDisplayName;
      const ourHomeLogo    = mfcIsHome ? hdr.HomeTeamClubLogoURL : hdr.AwayTeamClubLogoURL;
      const ourAwayLogo    = mfcIsHome ? hdr.AwayTeamClubLogoURL : hdr.HomeTeamClubLogoURL;

      // Abbreviate team name for scoreboard display.
      // Known sport suffixes (IF, FC, BK etc.) are kept whole.
      // All other words contribute their first letter only.
      // e.g. "Malmö Futsal Club" → "MFC", "Öjersjö IF" → "ÖIF", "Malmö FC" → "MFC"
      function abbreviateTeam(name) {
        if (!name) return name;
        const KEEP = new Set(['if','ik','bk','sk','fk','fc','ff','bf','hk','ifk','iff','fik']);
        return name.trim().split(/\s+/)
          .map(w => (KEEP.has(w.toLowerCase()) || (w === w.toUpperCase() && w.length <= 4))
            ? w.toUpperCase() : w[0].toUpperCase())
          .join('')
          .slice(0, 6);
      }
      state.homeTeam = abbreviateTeam(ourHomeTeam) || state.homeTeam;
      state.awayTeam = abbreviateTeam(ourAwayTeam) || state.awayTeam;
      state.homeLogo = ourHomeLogo || '';
      state.awayLogo = ourAwayLogo || '';
      state.arena    = hdr.ArenaName || '';
      state.league   = hdr.LeagueDisplayName || '';

      // Split a roster into { starters, subs } using the separate FOGIS arrays.
      // roster.Players = starting 5, roster.Substitutes = bench players.
      // If Substitutes is absent or empty (flat upload), subs is [] — graceful fallback.
      function splitRoster(roster) {
        if (!roster) return { starters: [], subs: [] };
        const starters = (roster.Players || [])
          .filter(p => !p.IsPlayingTeamStaff && !p.IsContactPerson)
          .sort((a, b) => a.ShirtNumber - b.ShirtNumber);
        const subs = (roster.Substitutes || [])
          .filter(p => !p.IsPlayingTeamStaff && !p.IsContactPerson)
          .sort((a, b) => a.ShirtNumber - b.ShirtNumber);
        return { starters, subs };
      }

      function formatPlayer(p) {
        return `#${p.ShirtNumber} ${p.FullName}${p.IsTeamCaptain ? ' (C)' : ''}`;
      }

      const homeSplit = splitRoster(ourHomeRoster);
      const awaySplit = splitRoster(ourAwayRoster);

      // lineup.home / lineup.away keep the flat string format for the controller textarea
      state.lineup.home = [...homeSplit.starters, ...homeSplit.subs].map(formatPlayer);
      state.lineup.away = [...awaySplit.starters, ...awaySplit.subs].map(formatPlayer);

      // Expose starters and subs separately for the lineup overlay
      state._homeStarters = homeSplit.starters.map(formatPlayer);
      state._homeSubs     = homeSplit.subs.map(formatPlayer);
      state._awayStarters = awaySplit.starters.map(formatPlayer);
      state._awaySubs     = awaySplit.subs.map(formatPlayer);

      // Quick-pick buttons in the controller — full squad (starters then subs)
      state._homePlayers = [...homeSplit.starters, ...homeSplit.subs]
        .map(p => ({ num: p.ShirtNumber, name: p.FullName, cap: p.IsTeamCaptain }));
      state._awayPlayers = [...awaySplit.starters, ...awaySplit.subs]
        .map(p => ({ num: p.ShirtNumber, name: p.FullName, cap: p.IsTeamCaptain }));
      broadcast(getPublicState());
      return {
        homeTeam:    state.homeTeam,
        awayTeam:    state.awayTeam,
        homePlayers: state._homePlayers.length,
        awayPlayers: state._awayPlayers.length,
        arena:       state.arena,
      };
    }

    function successPage(r) {
      return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>*{margin:0;padding:0;box-sizing:border-box;}
body{background:#050B18;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}
.box{text-align:center;padding:40px;max-width:480px;}
.icon{font-size:52px;margin-bottom:18px;}
h2{color:#7DB8F7;font-size:22px;margin-bottom:10px;}
p{color:rgba(255,255,255,.5);font-size:14px;line-height:1.6;}
.closing{margin-top:20px;font-size:12px;color:rgba(125,184,247,.35);}
</style></head><body><div class="box">
<div class="icon">✅</div>
<h2>${esc(r.homeTeam)} vs ${esc(r.awayTeam)}</h2>
<p>${esc(r.homePlayers)} home players · ${esc(r.awayPlayers)} away players loaded<br>${esc(r.arena)}</p>
<p class="closing">This tab will close in 3 seconds…</p>
</div><script>setTimeout(()=>window.close(),3000);</script>
</body></html>`;
    }

    // GET — data in base64 query param from bookmarklet
    if (req.method === 'GET') {
      const raw = url.searchParams.get('data');
      if (!raw) { res.writeHead(400); res.end('Missing data param'); return; }
      try {
        const decoded = Buffer.from(decodeURIComponent(raw), 'base64').toString('utf8');
        const { timeline, lineup } = JSON.parse(decoded);
        const result = processRosterData(timeline, lineup);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(successPage(result));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="background:#050B18;color:#ef4444;font-family:sans-serif;padding:40px;"><h2>Parse error</h2><pre>${e.message}</pre></body></html>`);
      }
      return;
    }

    // POST — from bookmarklet via form submit (data=BASE64 in body)
    if (req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; if (body.length > 512 * 1024) { res.writeHead(413); res.end('Too large'); req.destroy(); } });
      req.on('end', () => {
        try {
          // Support both form-encoded (data=BASE64) and raw JSON
          let timeline, lineup;
          if (body.startsWith('data=')) {
            const raw = Buffer.from(decodeURIComponent(body.slice(5)), 'base64').toString('utf8');
            ({ timeline, lineup } = JSON.parse(raw));
          } else {
            ({ timeline, lineup } = JSON.parse(body));
          }
          const result = processRosterData(timeline, lineup);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(successPage(result));
        } catch(e) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<html><body style="background:#050B18;color:#ef4444;font-family:sans-serif;padding:40px;"><h2>Parse error</h2><pre>${e.message}</pre></body></html>`);
        }
      });
      return;
    }
  }

  // ── Serve HTML overlay files ────────────────────────────────────────────────
  const fileMap = {
    '/':              'controller.html',
    '/controller':    'controller.html',
    '/scoreboard':    'overlay-scoreboard.html',
    '/lowerthird':    'overlay-lowerthird.html',
    '/lineup':        'overlay-lineup.html',
    '/brb':           'overlay-brb.html',
    '/startingsoon':  'overlay-startingsoon.html',
  };
  const file = fileMap[route];
  if (file) {
    const fp = path.join(__dirname, file);
    if (fs.existsSync(fp)) {
      let html = fs.readFileSync(fp, 'utf8');
      // Inject the session token into the controller so it can auth its fetch calls
      if (file === 'controller.html') {
        html = html.replace('</head>', `<script>window._MFCLIVE_TOKEN="${SECRET}";</script>\n</head>`);
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } else {
      res.writeHead(404); res.end('File not found: ' + file);
    }
    return;
  }

  // ── Logo proxy — fetches FOGIS CDN logo and serves it locally (avoids CORS) ──
  if (route === '/logo/home' || route === '/logo/away') {
    const logoUrl = route === '/logo/home' ? state.homeLogo : state.awayLogo;
    if (!logoUrl) { res.writeHead(404); res.end('No logo set'); return; }
    const logoReq = https.get(logoUrl, logoRes => {
      res.writeHead(200, {
        'Content-Type':  logoRes.headers['content-type'] || 'image/png',
        'Cache-Control': 'public, max-age=3600',
      });
      logoRes.pipe(res);
    });
    logoReq.on('error', () => { res.writeHead(502); res.end('Logo fetch failed'); });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── Broadcast tick every 500ms ─────────────────────────────────────────────────
setInterval(() => {
  if (!state.timerRunning) return;
  const now = Date.now();
  state.redCards = state.redCards.filter(rc => {
    rc.remainingMs = Math.max(0, rc.remainingMs - (now - rc.startedAt));
    rc.startedAt = now;
    return rc.remainingMs > 0;
  });
  if (getElapsed() <= 0) {
    state.timerMs = 0;
    state.timerRunning = false;
  }
  broadcast(getPublicState());
}, 500);

server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log(`\n✅  MFCLIVE — Overlay Server  (port ${PORT})`);
  console.log(`\n   ── Open this on your phone ──`);
  console.log(`   Controller    →  http://${localIP}:${PORT}/controller?token=${SECRET}`);
  console.log(`\n   ── Streamlabs Browser Sources (localhost — no token needed) ──`);
  console.log(`   Scoreboard    →  http://localhost:${PORT}/scoreboard`);
  console.log(`   Lower Third   →  http://localhost:${PORT}/lowerthird`);
  console.log(`   Lineup        →  http://localhost:${PORT}/lineup`);
  console.log(`   Starting Soon →  http://localhost:${PORT}/startingsoon`);
  console.log(`   BRB           →  http://localhost:${PORT}/brb`);
  console.log('\n   Stop: Ctrl + C\n');
});
