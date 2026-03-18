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

// ── Config ───────────────────────────────────────────────────────────────────
let config = {};
try {
  const cfgPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(cfgPath)) config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch(e) { console.warn('[config] Could not load config.json — using defaults:', e.message); }

// QR code generation — optional dependency, gracefully skipped if not installed
let QRCode; try { QRCode = require('qrcode'); } catch(e) { /* optional */ }
let _qrDataUrl = '';

const PORT = Number(config.port) || 3000;
const MFC_KEYWORDS = Array.isArray(config.clubKeywords) ? config.clubKeywords : ['malmö futsal', 'mfc'];

// ── Detect local LAN IP ────────────────────────────────────────────────────────
// Prefers real WiFi/Ethernet adapters; skips virtual adapters (VirtualBox, VMware, WSL, etc.)
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  const VIRTUAL  = /vmware|virtualbox|vbox|hyper.?v|wsl|loopback|bluetooth|hamachi|tap|tun|docker|teredo|isatap/i;
  const PREFERRED = /wi.?fi|wireless|wlan|ethernet|eth|local area/i;
  let fallback = null;
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const iface of addrs) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (PREFERRED.test(name)) return iface.address;
      if (!fallback) fallback = iface.address;
    }
  }
  return fallback || '<pc-ip>';
}

// ── Cloudflare Quick Tunnel ────────────────────────────────────────────────────
// Spawns cloudflared (if present in PATH or project dir) and parses the tunnel URL.
// Requires no account — generates a temporary *.trycloudflare.com URL per session.
// We wait for cloudflared's "registered" log line before advertising the URL,
// because cloudflared prints the URL *before* the edge connection is fully ready.
let _tunnelUrl   = '';
let _tunnelProc  = null;

function startCloudflaredTunnel(port, onUrl) {
  const { spawn, spawnSync } = require('child_process');
  const candidates = [
    'cloudflared',
    path.join(__dirname, 'cloudflared.exe'),
    path.join(__dirname, 'cloudflared'),
  ];

  let bin = null;
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { stdio: 'ignore', timeout: 3000 });
    if (!r.error && r.status === 0) { bin = c; break; }
  }
  if (!bin) { console.log('   [tunnel] cloudflared not found — skipping tunnel'); return false; }

  console.log('   [tunnel] starting cloudflared…');
  // Write a minimal blank config so cloudflared ignores any pre-existing
  // ~/.cloudflared/config.yaml (which may have named-tunnel ingress rules
  // with a catch-all http_status:404 that overrides our --url argument).
  const tmpCfg = path.join(os.tmpdir(), 'mfclive-cf.yaml');
  try { fs.writeFileSync(tmpCfg, '# mfclive quick tunnel\n', 'utf8'); } catch(e) { /* non-fatal */ }

  try {
    _tunnelProc = spawn(bin, ['tunnel', '--config', tmpCfg, '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch(e) { console.warn('   [tunnel] failed to spawn cloudflared:', e.message); return; }

  const urlRe        = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
  // Matches cloudflared's "Registered tunnel connection connIndex=0" line.
  // After seeing this we wait PROPAGATION_DELAY for Cloudflare's routing to
  // propagate to all edge POPs — probing from our own machine is unreliable
  // because our ISP may route us to a different POP than the one cloudflared
  // registered with, and that POP returns 404 until propagation completes.
  const registeredRe     = /Registered tunnel connection.*connIndex=0/i;
  const PROPAGATION_DELAY = 25000; // 25 s — covers global edge propagation

  let capturedUrl   = null;
  let fallbackTimer = null;

  function advertise() {
    if (_tunnelUrl || !capturedUrl) return;
    _tunnelUrl = capturedUrl;
    onUrl(_tunnelUrl);
  }

  function handle(data) {
    const str = data.toString();

    if (!capturedUrl) {
      const m = str.match(urlRe);
      if (m) {
        capturedUrl = m[0];
        console.log(`   [tunnel] URL captured — waiting for edge registration…`);
        fallbackTimer = setTimeout(advertise, 60000);
      }
    }

    if (capturedUrl && !_tunnelUrl && registeredRe.test(str)) {
      clearTimeout(fallbackTimer);
      console.log(`   [tunnel] registered — waiting ${PROPAGATION_DELAY / 1000}s for global propagation…`);
      setTimeout(advertise, PROPAGATION_DELAY);
    }
  }

  _tunnelProc.stdout.on('data', handle);
  _tunnelProc.stderr.on('data', handle);
  _tunnelProc.on('error', e => console.warn('   [tunnel] cloudflared error:', e.message));
  _tunnelProc.on('exit', code => {
    if (code !== 0 && code !== null) console.warn(`   [tunnel] cloudflared exited (code ${code})`);
    if (_tunnelUrl) { _tunnelUrl = ''; console.log('   [tunnel] tunnel disconnected'); }
  });

  process.on('exit', () => { try { _tunnelProc.kill(); } catch(e) {} });
  return true; // cloudflared is starting — caller should wait for onUrl before opening browser
}

// ── Security token — persistent across restarts ────────────────────────────────
// Stored in ~/.mfclive/token.txt (outside Dropbox/cloud sync folders).
// Generated once; delete the file to rotate.
const TOKEN_FILE = path.join(os.homedir(), '.mfclive', 'token.txt');
let SECRET;
try {
  if (fs.existsSync(TOKEN_FILE)) {
    SECRET = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } else {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    SECRET = crypto.randomBytes(6).toString('hex');
    fs.writeFileSync(TOKEN_FILE, SECRET, 'utf8');
  }
} catch (e) {
  console.warn('[token] Could not read/write token file — using in-memory token only:', e.message);
  SECRET = crypto.randomBytes(6).toString('hex');
}

// Requests from localhost are always allowed (Streamlabs browser sources).
// Requests from the network must include ?token=SECRET or X-MFCLIVE-Token header.
// Uses socket remote address (not the Host header, which is attacker-controlled).
function isAuthorised(req) {
  const ip = req.socket.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
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

const HALF_DURATION_MS = (Number(config.halfDurationMinutes) || 20) * 60 * 1000;

// ── Runtime flags ──────────────────────────────────────────────────────────────
let _wasRestored = false; // set true by restoreState() if a meaningful snapshot was recovered

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
  lowerThird: { visible: false, line1: '', line2: '', team: '', event: '' },
  // Lineup
  lineup: {
    home: ['#1 Keeper','#4 Player','#7 Player','#9 Player','#11 Player'],
    away: ['#1 Keeper','#5 Player','#8 Player','#10 Player','#14 Player'],
  },
  // Overlay visibility — controls show/hide of each browser source
  overlayVisible: {
    scoreboard:   true,
    lineup:       false,
    lowerthird:   true,
    startingsoon: false,
    brb:          false,
  },
  // YouTube stream preview URL (shared across all controller clients)
  ytUrl: '',
  // Kickoff time for Starting Soon overlay (HH:MM string, settable from controller)
  kickoffTime: '',
  // Set by processRosterData() — initialised here so getPublicState() never broadcasts undefined
  homeLogo: '',
  awayLogo: '',
  arena:    '',
  league:   '',
};

// ── State persistence ──────────────────────────────────────────────────────────
// Saves game state to ~/.mfclive/state.json after every action so a server
// restart mid-match can recover scores, timer, fouls, lineups, etc.
const STATE_FILE = path.join(os.homedir(), '.mfclive', 'state.json');

function saveState() {
  const snapshot = {
    homeTeam: state.homeTeam, awayTeam: state.awayTeam,
    homeLogo: state.homeLogo, awayLogo: state.awayLogo,
    homeScore: state.homeScore, awayScore: state.awayScore,
    period: state.period, halfTime: state.halfTime,
    timerMs: state.timerRunning ? getElapsed() : state.timerMs,
    homeFouls: state.homeFouls, awayFouls: state.awayFouls,
    redCards: state.redCards.map(rc => ({ ...rc, startedAt: null })),
    lowerThird: { ...state.lowerThird, visible: false },
    lineup: state.lineup,
    overlayVisible: state.overlayVisible,
    ytUrl: state.ytUrl,
    arena: state.arena, league: state.league, kickoffTime: state.kickoffTime || '',
    _homePlayers: state._homePlayers || [], _homeStarters: state._homeStarters || [],
    _homeSubs: state._homeSubs || [],       _homeSepLabel: state._homeSepLabel || 'Substitutes',
    _awayPlayers: state._awayPlayers || [], _awayStarters: state._awayStarters || [],
    _awaySubs: state._awaySubs || [],       _awaySepLabel: state._awaySepLabel || 'Substitutes',
  };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(snapshot), 'utf8'); } catch (e) { console.error('[state] save failed:', e.message); }
}

function restoreState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const snap = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    Object.assign(state, {
      homeTeam:  snap.homeTeam  || state.homeTeam,
      awayTeam:  snap.awayTeam  || state.awayTeam,
      homeLogo:  snap.homeLogo  || '',
      awayLogo:  snap.awayLogo  || '',
      homeScore: snap.homeScore ?? state.homeScore,
      awayScore: snap.awayScore ?? state.awayScore,
      period:    snap.period    ?? state.period,
      halfTime:  snap.halfTime  ?? state.halfTime,
      timerMs:   snap.timerMs   ?? state.timerMs,
      timerRunning: false, // always start paused
      homeFouls: snap.homeFouls ?? state.homeFouls,
      awayFouls: snap.awayFouls ?? state.awayFouls,
      redCards:  (snap.redCards || []),
      lowerThird: snap.lowerThird || state.lowerThird,
      lineup:    snap.lineup    || state.lineup,
      overlayVisible: snap.overlayVisible || state.overlayVisible,
      ytUrl:     snap.ytUrl || '',
      arena:     snap.arena  || '',
      league:    snap.league || '',
      _homePlayers:  snap._homePlayers  || [],
      _homeStarters: snap._homeStarters || [],
      _homeSubs:     snap._homeSubs     || [],
      _homeSepLabel: snap._homeSepLabel || 'Substitutes',
      _awayPlayers:  snap._awayPlayers  || [],
      _awayStarters: snap._awayStarters || [],
      _awaySubs:     snap._awaySubs     || [],
      _awaySepLabel: snap._awaySepLabel || 'Substitutes',
      kickoffTime:   snap.kickoffTime   || '',
    });
    if ((snap.homeScore || 0) > 0 || (snap.awayScore || 0) > 0 ||
        (snap.timerMs != null && snap.timerMs < HALF_DURATION_MS - 5000)) {
      _wasRestored = true;
    }
    console.log(`[state] Restored from snapshot — ${state.homeTeam} ${state.homeScore}–${state.awayScore} ${state.awayTeam}`);
  } catch (e) {
    console.warn('[state] Could not restore state:', e.message);
  }
}

restoreState();

// ── SSE clients ────────────────────────────────────────────────────────────────
const clients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of [...clients]) {
    try { res.write(msg); } catch(e) { clients.delete(res); console.error('[sse] dropped client:', e.message); }
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
    lowerThird:      state.lowerThird,
    lineup:          state.lineup,
    overlayVisible:  state.overlayVisible,
    ytUrl:           state.ytUrl,
    kickoffTime:     state.kickoffTime || '',
    arena:           state.arena,
    league:          state.league,
    wasRestored:     _wasRestored,
    homePlayers:  state._homePlayers || [],
    awayPlayers:  state._awayPlayers || [],
    homeStarters:  state._homeStarters  || [],
    homeSubs:      state._homeSubs      || [],
    homeSepLabel:  state._homeSepLabel  || 'Substitutes',
    awayStarters:  state._awayStarters  || [],
    awaySubs:      state._awaySubs      || [],
    awaySepLabel:  state._awaySepLabel  || 'Substitutes',
  };
}

// ── Tick every 500ms ───────────────────────────────────────────────────────────
setInterval(() => {
  if (!state.timerRunning || clients.size === 0) return;

  const now = Date.now();

  // Auto-stop timer first — if the game clock has expired, stop and broadcast,
  // but do NOT decrement red cards (timer was already at 0).
  const remaining = getElapsed();
  if (remaining <= 0) {
    state.timerMs      = 0;
    state.timerRunning = false;
    broadcast(getPublicState());
    return;
  }

  // Decrement red card timers only while the game clock is still running
  state.redCards.forEach(rc => {
    rc.remainingMs = Math.max(0, rc.remainingMs - (now - rc.startedAt));
    rc.startedAt = now;
  });
  state.redCards = state.redCards.filter(rc => rc.remainingMs > 0);

  broadcast(getPublicState());
}, 500);

// ── Action handler ─────────────────────────────────────────────────────────────
function handleAction(action, payload) {
  switch (action) {
    case 'timer_start':
      if (!state.timerRunning && state.timerMs > 0) {
        const startNow     = Date.now();
        state.timerBaseMs  = state.timerMs;
        state.timerStart   = startNow;
        state.timerRunning = true;
        // Use the same timestamp for red cards so there's no drift on first tick
        state.redCards.forEach(rc => rc.startedAt = startNow);
      }
      break;

    case 'timer_stop':
      if (state.timerRunning) {
        const now = Date.now();
        state.timerMs      = getElapsed();
        state.timerRunning = false;
        // Freeze red card remaining and reset startedAt so next start is clean
        state.redCards.forEach(rc => {
          rc.remainingMs = Math.max(0, rc.remainingMs - (now - rc.startedAt));
          rc.startedAt = now;
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

    case 'lower_show': {
      const validEvents = ['goal', 'redcard', 'sub'];
      state.lowerThird = {
        visible: true,
        line1: (payload.line1||'').slice(0, 100),
        line2: (payload.line2||'').slice(0, 100),
        team:  payload.team  === 'away' ? 'away' : payload.team  === 'home' ? 'home' : '',
        event: validEvents.includes(payload.event) ? payload.event : '',
      };
      break;
    }

    case 'lower_hide':
      state.lowerThird = { visible: false, line1: '', line2: '', team: '', event: '' };
      break;

    case 'set_lineup': {
      const SEP = /^---/;
      // Split a flat lineup array at the '--- <label> ---' separator line.
      // The label text between the dashes is preserved and returned as sepLabel.
      function splitLineupText(lines) {
        const idx = lines.findIndex(l => SEP.test(l.trim()));
        if (idx === -1) return { starters: lines.filter(Boolean), subs: [], sepLabel: 'Substitutes' };
        const raw = lines[idx].trim().replace(/^-+\s*/, '').replace(/\s*-+$/, '').trim();
        return {
          starters: lines.slice(0, idx).filter(Boolean),
          subs:     lines.slice(idx + 1).filter(Boolean),
          sepLabel: raw || 'Substitutes',
        };
      }
      // Parse a '#NUM Name (C)' lineup line into the player object used by quick-pick.
      function lineupLineToPlayer(line) {
        const cap   = line.includes(' (C)');
        const clean = line.replace(' (C)', '').trim();
        if (!clean.startsWith('#')) return null;
        const sp    = clean.indexOf(' ');
        const num   = sp > 0 ? (parseInt(clean.slice(1, sp)) || 0) : 0;
        const name  = sp > 0 ? clean.slice(sp + 1).trim() : clean.slice(1).trim();
        return (name || num) ? { num, name, cap } : null;
      }
      if (payload.home) {
        state.lineup.home = payload.home;
        const { starters, subs, sepLabel } = splitLineupText(payload.home);
        state._homeStarters = starters;
        state._homeSubs     = subs;
        state._homeSepLabel = sepLabel;
        state._homePlayers  = [...starters, ...subs].map(lineupLineToPlayer).filter(Boolean);
      }
      if (payload.away) {
        state.lineup.away = payload.away;
        const { starters, subs, sepLabel } = splitLineupText(payload.away);
        state._awayStarters = starters;
        state._awaySubs     = subs;
        state._awaySepLabel = sepLabel;
        state._awayPlayers  = [...starters, ...subs].map(lineupLineToPlayer).filter(Boolean);
      }
      break;
    }
    case 'set_team_names':
      if (payload.homeTeam) state.homeTeam = payload.homeTeam.slice(0,6).toUpperCase();
      if (payload.awayTeam) state.awayTeam = payload.awayTeam.slice(0,6).toUpperCase();
      break;

    case 'overlay_set': {
      const VALID_OVERLAYS = ['scoreboard','lineup','lowerthird','startingsoon','brb'];
      if (VALID_OVERLAYS.includes(payload.name) && typeof payload.visible === 'boolean') {
        state.overlayVisible[payload.name] = payload.visible;
      }
      break;
    }
    case 'set_yt_url':
      state.ytUrl = (typeof payload.url === 'string') ? payload.url.slice(0, 300) : '';
      break;
    case 'timer_set':
      state.timerMs = Math.min(HALF_DURATION_MS, Math.max(0, payload.ms || 0));
      state.timerRunning = false;
      break;

    case 'set_kickoff':
      state.kickoffTime = String(payload.time || '').slice(0, 5);
      break;

    case 'reset_game':
      state.homeScore    = 0;
      state.awayScore    = 0;
      state.homeFouls    = 0;
      state.awayFouls    = 0;
      state.redCards     = [];
      state.period       = 1;
      state.halfTime     = false;
      state.timerMs      = HALF_DURATION_MS;
      state.timerBaseMs  = HALF_DURATION_MS;
      state.timerRunning = false;
      state.timerStart   = null;
      state.lowerThird   = { visible: false, line1: '', line2: '', team: '', event: '' };
      _wasRestored       = false;
      // Intentionally keep: team names, logos, lineups, arena, league, kickoffTime, ytUrl
      break;
  }
  broadcast(getPublicState());
  saveState();
}

// ── FOGIS roster processing ────────────────────────────────────────────────────

const https = require('https');

function processRosterData(timeline, lineup) {
  const hdr = timeline?.GameHeaderInfo || {};

  const fogisHomeName = (hdr.HomeTeamDisplayName || '').toLowerCase();
  const mfcIsHome = MFC_KEYWORDS.some(k => fogisHomeName.includes(k));

  const ourHomeRoster = mfcIsHome ? lineup?.HomeTeamGameTeamRoster : lineup?.AwayTeamGameTeamRoster;
  const ourAwayRoster = mfcIsHome ? lineup?.AwayTeamGameTeamRoster : lineup?.HomeTeamGameTeamRoster;
  const ourHomeTeam   = mfcIsHome ? hdr.HomeTeamDisplayName : hdr.AwayTeamDisplayName;
  const ourAwayTeam   = mfcIsHome ? hdr.AwayTeamDisplayName : hdr.HomeTeamDisplayName;
  const ourHomeLogo   = mfcIsHome ? hdr.HomeTeamClubLogoURL : hdr.AwayTeamClubLogoURL;
  const ourAwayLogo   = mfcIsHome ? hdr.AwayTeamClubLogoURL : hdr.HomeTeamClubLogoURL;

  function abbreviateTeam(name) {
    if (!name) return name;
    const t = name.trim(); if (!t) return name;
    const KEEP = new Set(['if','ik','bk','sk','fk','fc','ff','bf','hk','ifk','iff','fik']);
    return t.split(/\s+/)
      .map(w => (KEEP.has(w.toLowerCase()) || (w === w.toUpperCase() && w.length <= 4))
        ? w.toUpperCase() : w[0].toUpperCase())
      .join('').slice(0, 6);
  }
  state.homeTeam = abbreviateTeam(ourHomeTeam) || state.homeTeam;
  state.awayTeam = abbreviateTeam(ourAwayTeam) || state.awayTeam;
  state.homeLogo = ourHomeLogo || '';
  state.awayLogo = ourAwayLogo || '';
  state.arena    = hdr.ArenaName || '';
  state.league   = hdr.LeagueDisplayName || '';

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

  function buildLineupText(split) {
    const s = split.starters.map(formatPlayer);
    const b = split.subs.map(formatPlayer);
    return b.length ? [...s, '--- Substitutes ---', ...b] : s;
  }
  state.lineup.home = buildLineupText(homeSplit);
  state.lineup.away = buildLineupText(awaySplit);

  state._homeStarters = homeSplit.starters.map(formatPlayer);
  state._homeSubs     = homeSplit.subs.map(formatPlayer);
  state._homeSepLabel = 'Substitutes';
  state._awayStarters = awaySplit.starters.map(formatPlayer);
  state._awaySubs     = awaySplit.subs.map(formatPlayer);
  state._awaySepLabel = 'Substitutes';
  state._homePlayers  = [...homeSplit.starters, ...homeSplit.subs]
    .map(p => ({ num: p.ShirtNumber, name: p.FullName, cap: p.IsTeamCaptain }));
  state._awayPlayers  = [...awaySplit.starters, ...awaySplit.subs]
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



// ── Rate limiter — max 20 /action requests per token per second ────────────────
const _actionRate = new Map();
function checkRateLimit(token) {
  const now = Date.now();
  let e = _actionRate.get(token);
  if (!e || now >= e.resetAt) { e = { count: 0, resetAt: now + 1000 }; _actionRate.set(token, e); }
  return ++e.count <= 20;
}

// ── HTTP Server ────────────────────────────────────────────────────────────────

// ── Single consolidated HTTP router ───────────────────────────────────────────
const server = http.createServer({ maxHeaderSize: 65536 }, (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = url.pathname;

  // /import-roster is called cross-origin by the bookmarklet (running on minfotboll.se).
  // It is already token-protected, so open CORS is safe for that route only.
  // All other routes only allow localhost origins (Streamlabs browser sources).
  const origin = req.headers['origin'] || '';
  if (route === '/import-roster') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    try {
      const o = new URL(origin);
      if (o.hostname === 'localhost' || o.hostname === '127.0.0.1') {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    } catch { /* malformed origin — deny */ }
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

  // ── Status API — polled by setup page to pick up tunnel URL when ready ──────
  if (route === '/api/status') {
    const localControllerUrl  = `http://${getLocalIP()}:${PORT}/controller?token=${SECRET}`;
    const tunnelControllerUrl = _tunnelUrl ? `${_tunnelUrl}/controller?token=${SECRET}` : null;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({
      localUrl:   localControllerUrl,
      tunnelUrl:  tunnelControllerUrl,
      qrDataUrl:  _qrDataUrl,
      club:       config.club || 'MFCLIVE',
      port:       PORT,
    }));
    return;
  }

  // ── State snapshot API — one-shot HTTP fetch for initial controller load ────
  if (route === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(getPublicState()));
    return;
  }

  // ── SSE stream ──────────────────────────────────────────────────────────────
  if (route === '/events') {
    res.writeHead(200, {
      'Content-Type':        'text/event-stream',
      'Cache-Control':       'no-cache, no-transform',
      'Connection':          'keep-alive',
      'X-Accel-Buffering':   'no',        // nginx / Cloudflare: disable buffering
      'Content-Encoding':    'identity',  // prevent Cloudflare gzip-buffering the stream
    });
    // Disable Nagle's algorithm so each write() flushes to the network immediately
    if (res.socket) res.socket.setNoDelay(true);
    // Padding fills Cloudflare's proxy read-buffer (typically 4 KB) before the
    // first real event, forcing an immediate flush to the browser.
    res.write(': ' + ' '.repeat(4093) + '\n\n');
    res.write(`data: ${JSON.stringify(getPublicState())}\n\n`);
    clients.add(res);
    // Keepalive ping every 25 s — prevents Cloudflare from closing idle tunnels
    const ping = setInterval(() => { if (!res.writableEnded) { try { res.write(': keepalive\n\n'); } catch { clearInterval(ping); } } }, 25000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }

  // ── Action API ──────────────────────────────────────────────────────────────
  if (req.method === 'POST' && route === '/action') {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {
      res.writeHead(415, { 'Content-Type': 'text/plain' }); res.end('Unsupported Media Type'); return;
    }
    const rateKey = req.headers['x-mfclive-token'] || url.searchParams.get('token') || req.socket.remoteAddress || 'anon';
    if (!checkRateLimit(rateKey)) { res.writeHead(429, { 'Content-Type': 'text/plain' }); res.end('Too Many Requests'); return; }
    let body = '';
    req.on('data', d => { body += d; if (body.length > 8192) { res.writeHead(413); res.end('Too large'); req.socket.destroy(); } });
    req.on('end', () => {
      try {
        const { action, payload } = JSON.parse(body || '{}');
        handleAction(action, payload || {});
      } catch(e) { console.error('[action] parse error:', e.message); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getPublicState()));
    });
    return;
  }

  // ── Import roster (called by bookmarklet — legacy support) ─��───────────────
  if (route === '/import-roster') {
    function successPage(r) {
      return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#050B18;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}.box{text-align:center;padding:40px;max-width:480px;}.icon{font-size:52px;margin-bottom:18px;}h2{color:#7DB8F7;font-size:22px;margin-bottom:10px;}p{color:rgba(255,255,255,.5);font-size:14px;line-height:1.6;}.closing{margin-top:20px;font-size:12px;color:rgba(125,184,247,.35);}</style>
</head><body><div class="box"><div class="icon">✅</div>
<h2>${esc(r.homeTeam)} vs ${esc(r.awayTeam)}</h2>
<p>${esc(r.homePlayers)} home players · ${esc(r.awayPlayers)} away players loaded<br>${esc(r.arena)}</p>
<p class="closing">This tab will close in 3 seconds…</p>
</div><script>setTimeout(()=>window.close(),3000);</script></body></html>`;
    }
    if (req.method === 'GET') {
      const raw = url.searchParams.get('data');
      if (!raw) { res.writeHead(400); res.end('Missing data param'); return; }
      try {
        const decoded = Buffer.from(decodeURIComponent(raw), 'base64').toString('utf8');
        const { timeline, lineup } = JSON.parse(decoded);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(successPage(processRosterData(timeline, lineup)));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="background:#050B18;color:#ef4444;font-family:sans-serif;padding:40px;"><h2>Parse error</h2><pre>${esc(e.message)}</pre></body></html>`);
      }
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; if (body.length > 512 * 1024) { res.writeHead(413); res.end('Too large'); req.socket.destroy(); } });
      req.on('end', () => {
        try {
          let timeline, lineup;
          if (body.startsWith('data=')) {
            const raw = Buffer.from(decodeURIComponent(body.slice(5)), 'base64').toString('utf8');
            ({ timeline, lineup } = JSON.parse(raw));
          } else {
            ({ timeline, lineup } = JSON.parse(body));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(processRosterData(timeline, lineup)));
        } catch(e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }



  // ── Serve HTML overlay files ────────────────────────────────────────────────
  const fileMap = {
    '/':              'controller.html',
    '/controller':    'controller.html',
    '/bookmarklet':   'bookmarklet.html',
    '/setup':         'setup.html',
    '/scoreboard':    'overlay-scoreboard.html',
    '/lowerthird':    'overlay-lowerthird.html',
    '/lineup':        'overlay-lineup.html',
    '/brb':           'overlay-brb.html',
    '/startingsoon':  'overlay-startingsoon.html',
    '/audio-util.js': 'audio-util.js',
  };
  const jsFiles = new Set(['audio-util.js']);
  const file = fileMap[route];
  if (file) {
    const fp = path.join(__dirname, file);
    if (fs.existsSync(fp)) {
      let html = fs.readFileSync(fp, 'utf8');
      // Inject session token into controller and bookmarklet
      if (file === 'controller.html' || file === 'bookmarklet.html') {
        html = html.replace('</head>', `<script>window._MFCLIVE_TOKEN=${JSON.stringify(SECRET)};</script>\n</head>`);
      }
      // Inject setup data (QR, URLs, club name) into setup page
      if (file === 'setup.html') {
        const localUrl   = `http://${getLocalIP()}:${PORT}/controller?token=${SECRET}`;
        const tunnelUrl  = _tunnelUrl ? `${_tunnelUrl}/controller?token=${SECRET}` : null;
        const controllerUrl = tunnelUrl || localUrl;
        const setupData = { qrDataUrl: _qrDataUrl, controllerUrl, port: PORT, club: config.club || 'MFCLIVE' };
        html = html.replace('</head>', `<script>window._SETUP=${JSON.stringify(setupData)};</script>\n</head>`);
      }
      const ct = jsFiles.has(file) ? 'application/javascript' : 'text/html';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(html);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('File not found: ' + esc(file));
    }
    return;
  }

  // ── Logo proxy — fetches FOGIS CDN logo and serves it locally (avoids CORS) ──
  // URL is validated to be HTTPS and non-private to prevent SSRF.
  function isSafeLogoUrl(raw) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:') return false;
      const h = u.hostname.toLowerCase();
      if (h === 'localhost') return false;
      // Reject any IPv6 address (always bracketed by URL parser, e.g. [::1])
      if (h.startsWith('[')) return false;
      // Reject all private / reserved IPv4 ranges
      if (/^127\./.test(h))                                         return false; // full loopback range
      if (/^0\./.test(h) || h === '0.0.0.0')                       return false; // any 0.x.x.x + 0.0.0.0
      if (/^10\./.test(h))                                          return false; // RFC 1918
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(h))                    return false; // RFC 1918
      if (/^192\.168\./.test(h))                                    return false; // RFC 1918
      if (/^169\.254\./.test(h))                                    return false; // link-local / AWS metadata
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h))     return false; // CGNAT / Tailscale
      return true;
    } catch { return false; }
  }

  if (route === '/logo/home' || route === '/logo/away') {
    const logoUrl = route === '/logo/home' ? state.homeLogo : state.awayLogo;
    if (!logoUrl) { res.writeHead(404); res.end('No logo set'); return; }
    if (!isSafeLogoUrl(logoUrl)) { res.writeHead(400); res.end('Invalid logo URL'); return; }
    const logoReq = https.get(logoUrl, { timeout: 5000 }, logoRes => {
      res.writeHead(200, {
        'Content-Type':  logoRes.headers['content-type'] || 'image/png',
        'Cache-Control': 'public, max-age=3600',
      });
      logoRes.pipe(res);
    });
    logoReq.on('timeout', () => { logoReq.destroy(); if (res.headersSent) { res.end(); } else { res.writeHead(504); res.end('Logo fetch timed out'); } });
    logoReq.on('error', () => { logoReq.destroy(); if (res.headersSent) { res.end(); } else { res.writeHead(502); res.end('Logo fetch failed'); } });
    return;
  }

  // ── Serve audio files from ./audio/ ────────────────────────────────────────
  if (route.startsWith('/audio/')) {
    const filename = path.basename(route); // prevent path traversal
    const fp = path.join(__dirname, 'audio', filename);
    if (fs.existsSync(fp)) {
      const ext = path.extname(filename).toLowerCase();
      const mime = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
      fs.createReadStream(fp).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Audio file not found: ' + esc(filename));
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  const maskedToken = SECRET.slice(0, 2) + '****' + SECRET.slice(-2);
  const controllerUrl = `http://${localIP}:${PORT}/controller?token=${SECRET}`;

  console.log(`\n✅  MFCLIVE — Overlay Server  (port ${PORT})`);
  console.log(`\n   ── Setup page (open in browser on this PC) ──`);
  console.log(`   Setup         →  http://localhost:${PORT}/setup`);
  console.log(`\n   ── Open this on your phone ──`);
  console.log(`   Controller    →  http://${localIP}:${PORT}/controller?token=${maskedToken}  (token masked — see token.txt)`);
  console.log(`\n   ── Bookmarklet setup (open once to configure) ──`);
  console.log(`   Bookmarklet   →  http://${localIP}:${PORT}/bookmarklet?token=${maskedToken}  (token masked — see token.txt)`);
  console.log(`\n   ── Streamlabs Browser Sources (localhost — no token needed) ──`);
  console.log(`   Scoreboard    →  http://localhost:${PORT}/scoreboard`);
  console.log(`   Lower Third   →  http://localhost:${PORT}/lowerthird`);
  console.log(`   Lineup        →  http://localhost:${PORT}/lineup`);
  console.log(`   Starting Soon →  http://localhost:${PORT}/startingsoon`);
  console.log(`   BRB           →  http://localhost:${PORT}/brb`);
  console.log('\n   Stop: Ctrl + C\n');

  // Opens the setup page in the default browser (Windows).
  function openBrowser() {
    try {
      const { spawn } = require('child_process');
      spawn('cmd', ['/c', 'start', '', `http://localhost:${PORT}/setup`],
        { detached: true, stdio: 'ignore', windowsHide: true });
    } catch(e) { /* non-fatal */ }
  }

  // Generates a QR data URL (for setup page) and prints to terminal.
  function generateQR(url) {
    if (!QRCode) return;
    QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1 }, (_err, dataUrl) => {
      if (!_err) _qrDataUrl = dataUrl;
    });
    QRCode.toString(url, { type: 'terminal', small: true }, (_err, str) => {
      if (str) console.log('   Scan to open controller on phone:\n' + str);
    });
  }

  // Start Cloudflare Quick Tunnel. Open the browser only when the tunnel is
  // ready so the setup page shows the tunnel QR immediately on load.
  // If cloudflared is unavailable, fall back to opening with the local URL.
  const tunnelStarting = startCloudflaredTunnel(PORT, tunnelBase => {
    const tunnelControllerUrl = `${tunnelBase}/controller?token=${SECRET}`;
    console.log(`\n   ☁  Tunnel ready — works from any network:`);
    console.log(`   Controller  →  ${tunnelBase}/controller?token=${SECRET.slice(0,2)}****${SECRET.slice(-2)}\n`);
    generateQR(tunnelControllerUrl);
    openBrowser();
  });

  if (!tunnelStarting) {
    // No cloudflared — generate local QR and open browser immediately.
    generateQR(controllerUrl);
    openBrowser();
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n❌  Port ${PORT} is already in use.`);
    console.error(`   Another MFCLIVE server may already be running.`);
    console.error(`   Close it first, or change the port in config.json.\n`);
    process.exit(1);
  }
  throw e;
});
