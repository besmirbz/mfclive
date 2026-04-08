/**
 * MFCLIVE — Multi-Tenant SaaS Server
 *
 * Architecture: one Node.js process, many clubs.
 * Each club gets its own isolated in-memory "room" (state + SSE clients + config).
 * Club configuration and game state are persisted to SQLite.
 *
 * URL structure:
 *   Controller : /clubs/:slug/controller
 *   Overlays   : /clubs/:slug/scoreboard | /lowerthird | /lineup | /brb | /startingsoon
 *   SSE stream : /clubs/:slug/events
 *   Action API : /clubs/:slug/action  (POST)
 *   State API  : /clubs/:slug/api/state
 *
 * Admin (token-protected):
 *   POST /admin/clubs        — create a new club (returns slug + secret)
 *   GET  /admin/clubs        — list all clubs
 *
 * TODO (not implemented here, required before production):
 *   - Logo uploads → Cloudflare R2 (replace local LOGOS_DIR)
 *   - Session-cookie auth for the controller (replace query-token model)
 *   - FOGIS roster import (port processRosterData() with room scoping)
 *   - Stripe/billing integration for the paid tier
 *   - Proper admin UI (currently just raw JSON API)
 */

'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');
const https  = require('https');

// ── SQLite (better-sqlite3 — synchronous, zero async overhead) ─────────────────
const Database = require('better-sqlite3');

// ── Stripe (payments) ─────────────────────────────────────────────────────────
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');

// ── Nodemailer (transactional email via Zoho SMTP) ────────────────────────────
const nodemailer = require('nodemailer');
const mailer = nodemailer.createTransport({
  host: 'smtp.zoho.eu',
  port: 587,
  secure: false,
  requireTLS: true,
  auth: {
    user: 'info@futsalplay.live',
    pass: process.env.SMTP_PASS || '',
  },
});

const DB_PATH    = path.join(os.homedir(), '.mfclive-saas', 'saas.db');
const LOGOS_DIR  = path.join(os.homedir(), '.mfclive-saas', 'logos');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(LOGOS_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // safe for concurrent reads

db.exec(`
  CREATE TABLE IF NOT EXISTS clubs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slug       TEXT    UNIQUE NOT NULL,
    name       TEXT    NOT NULL,
    secret     TEXT    NOT NULL,
    config     TEXT    NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS game_states (
    club_id    INTEGER PRIMARY KEY REFERENCES clubs(id) ON DELETE CASCADE,
    state      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

// ── Admin secret — gates the /admin/* API ─────────────────────────────────────
// Set MFCLIVE_ADMIN_SECRET env var on the server, or it falls back to a file.
const ADMIN_SECRET_FILE = path.join(os.homedir(), '.mfclive-saas', 'admin-secret.txt');
let ADMIN_SECRET;
try {
  if (process.env.MFCLIVE_ADMIN_SECRET) {
    ADMIN_SECRET = process.env.MFCLIVE_ADMIN_SECRET.trim();
  } else if (fs.existsSync(ADMIN_SECRET_FILE)) {
    ADMIN_SECRET = fs.readFileSync(ADMIN_SECRET_FILE, 'utf8').trim();
  } else {
    ADMIN_SECRET = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(ADMIN_SECRET_FILE, ADMIN_SECRET, 'utf8');
    console.log(`\n[admin] Generated admin secret. Store this safely:\n  ${ADMIN_SECRET}\n`);
  }
} catch (e) {
  ADMIN_SECRET = crypto.randomBytes(16).toString('hex');
  console.warn('[admin] Could not persist admin secret — using in-memory only.');
}

const PORT = Number(process.env.PORT) || 3000;

// ── Room model ─────────────────────────────────────────────────────────────────
//
// A "room" is the in-memory representation of one club's live session.
// It holds:
//   - state      : the live game state (scores, timer, lineups, etc.)
//   - clients    : the Set of active SSE response objects for this club
//   - config     : club configuration (colours, period count, etc.)
//   - clubId     : the SQLite clubs.id for persistence
//   - slug       : URL-safe identifier (e.g. "mfc")
//   - secret     : per-club auth token
//
// Rooms are created lazily on first request and kept alive indefinitely
// (the memory footprint per room is tiny — a few KB).
// ──────────────────────────────────────────────────────────────────────────────

const rooms = new Map(); // slug -> room

function parseConfig(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function periodMs(cfg) {
  return (Number(cfg.periodDuration) || 20) * 60 * 1000;
}

function numPeriods(cfg) {
  return Math.max(1, Math.min(10, Number(cfg.numberOfPeriods) || 2));
}

function createInitialState(cfg) {
  const dur = periodMs(cfg);
  return {
    homeTeam: '', awayTeam: '',
    homeScore: 0, awayScore: 0,
    homeLogo: '', awayLogo: '',
    period: 1,
    timerMs: dur, timerRunning: false, timerStart: null, timerBaseMs: dur,
    homeFouls: 0, awayFouls: 0,
    redCards: [], _nextRedCardId: 1,
    halfTime: false,
    lowerThird: { visible: false, line1: '', line2: '', team: '', event: '' },
    lineup: {
      home: ['#1 Keeper','#4 Player','#7 Player','#9 Player','#11 Player'],
      away: ['#1 Keeper','#5 Player','#8 Player','#10 Player','#14 Player'],
    },
    overlayVisible: {
      scoreboard: true, lineup: false, lowerthird: true,
      startingsoon: false, brb: false,
    },
    ytUrl: '',
    kickoffTime: '',
    arena: '', league: '',
    _homePlayers: [], _homeStarters: [], _homeSubs: [], _homeSepLabel: 'Substitutes',
    _awayPlayers: [], _awayStarters: [], _awaySubs: [], _awaySepLabel: 'Substitutes',
    wasRestored: false,
  };
}

function createRoom(clubRow) {
  const cfg = parseConfig(clubRow.config);
  return {
    clubId:  clubRow.id,
    slug:    clubRow.slug,
    name:    clubRow.name,
    secret:  clubRow.secret,
    config:  cfg,
    state:   createInitialState(cfg),
    clients: new Set(),
  };
}

/**
 * Load all clubs from SQLite into the rooms Map, and restore their last
 * persisted game state. Called once at startup.
 */
function loadAllRooms() {
  const clubs = db.prepare('SELECT * FROM clubs').all();
  for (const club of clubs) {
    const room = createRoom(club);
    restoreRoomState(room);
    rooms.set(club.slug, room);
  }
  console.log(`[rooms] Loaded ${rooms.size} club(s) from DB`);
}

/**
 * Look up a room by slug. Returns undefined if the club doesn't exist.
 * If the club exists in the DB but hasn't been loaded into memory yet
 * (e.g. created after startup), we load it on demand.
 */
function getRoom(slug) {
  if (rooms.has(slug)) return rooms.get(slug);
  // lazy load — handles clubs created after the process started
  const row = db.prepare('SELECT * FROM clubs WHERE slug = ?').get(slug);
  if (!row) return undefined;
  const room = createRoom(row);
  restoreRoomState(room);
  rooms.set(slug, room);
  return room;
}

// ── State persistence — SQLite instead of flat JSON ───────────────────────────

const upsertState = db.prepare(`
  INSERT INTO game_states (club_id, state, updated_at)
  VALUES (?, ?, unixepoch())
  ON CONFLICT(club_id) DO UPDATE SET state = excluded.state, updated_at = unixepoch()
`);

function saveRoomState(room) {
  const s = room.state;
  const snapshot = {
    homeTeam: s.homeTeam, awayTeam: s.awayTeam,
    homeLogo: s.homeLogo, awayLogo: s.awayLogo,
    homeScore: s.homeScore, awayScore: s.awayScore,
    period: s.period, halfTime: s.halfTime,
    timerMs: s.timerRunning ? getElapsed(room) : s.timerMs,
    homeFouls: s.homeFouls, awayFouls: s.awayFouls,
    redCards: s.redCards.map(rc => ({ ...rc, startedAt: null })),
    lowerThird: { ...s.lowerThird, visible: false },
    lineup: s.lineup, overlayVisible: s.overlayVisible,
    ytUrl: s.ytUrl, arena: s.arena, league: s.league,
    kickoffTime: s.kickoffTime || '',
    _homePlayers: s._homePlayers, _homeStarters: s._homeStarters,
    _homeSubs: s._homeSubs, _homeSepLabel: s._homeSepLabel,
    _awayPlayers: s._awayPlayers, _awayStarters: s._awayStarters,
    _awaySubs: s._awaySubs, _awaySepLabel: s._awaySepLabel,
  };
  try { upsertState.run(room.clubId, JSON.stringify(snapshot)); }
  catch (e) { console.error(`[state:${room.slug}] save failed:`, e.message); }
}

function restoreRoomState(room) {
  try {
    const row = db.prepare('SELECT state FROM game_states WHERE club_id = ?').get(room.clubId);
    if (!row) return;
    const snap = JSON.parse(row.state);
    const dur  = periodMs(room.config);
    Object.assign(room.state, {
      homeTeam: snap.homeTeam || '', awayTeam: snap.awayTeam || '',
      homeLogo: snap.homeLogo || '', awayLogo: snap.awayLogo || '',
      homeScore: snap.homeScore ?? 0, awayScore: snap.awayScore ?? 0,
      period: snap.period ?? 1, halfTime: snap.halfTime ?? false,
      timerMs: snap.timerMs ?? dur, timerRunning: false,
      homeFouls: snap.homeFouls ?? 0, awayFouls: snap.awayFouls ?? 0,
      redCards: snap.redCards || [],
      lowerThird: snap.lowerThird || room.state.lowerThird,
      lineup: snap.lineup || room.state.lineup,
      overlayVisible: snap.overlayVisible || room.state.overlayVisible,
      ytUrl: snap.ytUrl || '', arena: snap.arena || '', league: snap.league || '',
      kickoffTime: snap.kickoffTime || '',
      _homePlayers: snap._homePlayers || [], _homeStarters: snap._homeStarters || [],
      _homeSubs: snap._homeSubs || [], _homeSepLabel: snap._homeSepLabel || 'Substitutes',
      _awayPlayers: snap._awayPlayers || [], _awayStarters: snap._awayStarters || [],
      _awaySubs: snap._awaySubs || [], _awaySepLabel: snap._awaySepLabel || 'Substitutes',
    });
    const meaningful = (snap.homeScore || 0) > 0 || (snap.awayScore || 0) > 0
      || (snap.timerMs != null && snap.timerMs < dur - 5000);
    if (meaningful) room.state.wasRestored = true;
    console.log(`[state:${room.slug}] restored — ${room.state.homeTeam} ${room.state.homeScore}–${room.state.awayScore} ${room.state.awayTeam}`);
  } catch (e) {
    console.warn(`[state:${room.slug}] restore failed:`, e.message);
  }
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

function broadcastToRoom(room, data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of [...room.clients]) {
    try { res.write(msg); }
    catch (e) { room.clients.delete(res); }
  }
}

function getElapsed(room) {
  const s = room.state;
  if (!s.timerRunning) return s.timerMs;
  return Math.max(0, s.timerBaseMs - (Date.now() - s.timerStart));
}

function getPublicState(room) {
  const s   = room.state;
  const now = Date.now();
  const redCards = s.redCards
    .map(rc => ({
      ...rc,
      remainingMs: Math.max(0, rc.remainingMs - (s.timerRunning ? now - rc.startedAt : 0)),
    }))
    .filter(rc => rc.remainingMs > 0);
  return {
    type: 'state',
    homeTeam: s.homeTeam, awayTeam: s.awayTeam,
    homeLogo: s.homeLogo, awayLogo: s.awayLogo,
    homeScore: s.homeScore, awayScore: s.awayScore,
    period: s.period, halfTime: s.halfTime,
    timerMs: getElapsed(room), timerRunning: s.timerRunning,
    homeFouls: s.homeFouls, awayFouls: s.awayFouls,
    redCards,
    lowerThird: s.lowerThird,
    lineup: s.lineup, overlayVisible: s.overlayVisible,
    ytUrl: s.ytUrl, kickoffTime: s.kickoffTime || '',
    arena: s.arena, league: s.league,
    wasRestored: s.wasRestored,
    periodDurationMs: periodMs(room.config),
    numberOfPeriods:  numPeriods(room.config),
    homePlayers: s._homePlayers, awayPlayers: s._awayPlayers,
    homeStarters: s._homeStarters, homeSubs: s._homeSubs, homeSepLabel: s._homeSepLabel,
    awayStarters: s._awayStarters, awaySubs: s._awaySubs, awaySepLabel: s._awaySepLabel,
    // Club branding — overlays use these for accent colour etc.
    club:         room.name,
    accentColour: room.config.accentColour || '#3D82F6',
  };
}

// ── Single shared tick — iterates ALL rooms ───────────────────────────────────
// One interval for the whole process. Never create per-room intervals — they
// will leak if a room is cleaned up while a game is in progress.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const s = room.state;
    if (!s.timerRunning || room.clients.size === 0) continue;

    const remaining = getElapsed(room);
    if (remaining <= 0) {
      s.timerMs = 0;
      s.timerRunning = false;
      broadcastToRoom(room, getPublicState(room));
      continue;
    }

    // Advance red card countdowns
    s.redCards.forEach(rc => {
      rc.remainingMs = Math.max(0, rc.remainingMs - (now - rc.startedAt));
      rc.startedAt = now;
    });
    s.redCards = s.redCards.filter(rc => rc.remainingMs > 0);

    broadcastToRoom(room, getPublicState(room));
  }
}, 500);

// ── Action handler (room-scoped) ──────────────────────────────────────────────

function handleAction(room, action, payload) {
  const s   = room.state;
  const dur = periodMs(room.config);

  switch (action) {
    case 'timer_start':
      if (!s.timerRunning && s.timerMs > 0) {
        const t = Date.now();
        s.timerBaseMs = s.timerMs; s.timerStart = t; s.timerRunning = true;
        s.redCards.forEach(rc => rc.startedAt = t);
      }
      break;

    case 'timer_stop':
      if (s.timerRunning) {
        const now = Date.now();
        s.timerMs = getElapsed(room); s.timerRunning = false;
        s.redCards.forEach(rc => {
          rc.remainingMs = Math.max(0, rc.remainingMs - (now - rc.startedAt));
          rc.startedAt = now;
        });
      }
      break;

    case 'timer_reset':
      s.timerMs = dur; s.timerBaseMs = dur;
      s.timerRunning = false; s.timerStart = null;
      break;

    case 'timer_set':
      s.timerMs = Math.min(dur, Math.max(0, payload.ms || 0));
      s.timerRunning = false;
      break;

    case 'goal_home':
      s.homeScore++;
      s.redCards = s.redCards.filter(rc => rc.team !== 'away');
      break;

    case 'goal_away':
      s.awayScore++;
      s.redCards = s.redCards.filter(rc => rc.team !== 'home');
      break;

    case 'undo_home': s.homeScore = Math.max(0, s.homeScore - 1); break;
    case 'undo_away': s.awayScore = Math.max(0, s.awayScore - 1); break;

    case 'foul_home': s.homeFouls = Math.min(9, s.homeFouls + 1); break;
    case 'foul_away': s.awayFouls = Math.min(9, s.awayFouls + 1); break;
    case 'undo_foul_home': s.homeFouls = Math.max(0, s.homeFouls - 1); break;
    case 'undo_foul_away': s.awayFouls = Math.max(0, s.awayFouls - 1); break;

    case 'red_card_add':
      s.redCards.push({
        id:          s._nextRedCardId++,
        team:        payload.team === 'away' ? 'away' : 'home',
        player:      String(payload.player || '').slice(0, 60).replace(/[<>"']/g, ''),
        remainingMs: 2 * 60 * 1000,
        startedAt:   Date.now(),
      });
      break;

    case 'red_card_remove':
      s.redCards = s.redCards.filter(rc => rc.id !== payload.id);
      break;

    case 'set_period':
      s.period = payload.period; s.halfTime = false;
      s.homeFouls = 0; s.awayFouls = 0;
      s.timerMs = dur; s.timerBaseMs = dur;
      s.timerRunning = false;
      break;

    case 'set_halftime':
      s.halfTime = payload.active === true;
      break;

    case 'lower_show': {
      const validEvents = ['goal', 'redcard', 'sub'];
      s.lowerThird = {
        visible: true,
        line1: (payload.line1 || '').slice(0, 100),
        line2: (payload.line2 || '').slice(0, 100),
        team:  payload.team === 'away' ? 'away' : payload.team === 'home' ? 'home' : '',
        event: validEvents.includes(payload.event) ? payload.event : '',
      };
      break;
    }

    case 'lower_hide':
      s.lowerThird = { visible: false, line1: '', line2: '', team: '', event: '' };
      break;

    case 'set_lineup': {
      const SEP = /^---/;
      function splitLineupText(lines) {
        const idx = lines.findIndex(l => SEP.test(l.trim()));
        if (idx === -1) return { starters: lines.filter(Boolean), subs: [], sepLabel: 'Substitutes' };
        const raw = lines[idx].trim().replace(/^-+\s*/, '').replace(/\s*-+$/, '').trim();
        return { starters: lines.slice(0, idx).filter(Boolean), subs: lines.slice(idx + 1).filter(Boolean), sepLabel: raw || 'Substitutes' };
      }
      function lineupLineToPlayer(line) {
        const cap   = line.includes(' (C)');
        const clean = line.replace(' (C)', '').trim();
        if (!clean.startsWith('#')) return null;
        const sp = clean.indexOf(' ');
        const num  = sp > 0 ? (parseInt(clean.slice(1, sp)) || 0) : 0;
        const name = sp > 0 ? clean.slice(sp + 1).trim() : clean.slice(1).trim();
        return (name || num) ? { num, name, cap } : null;
      }
      if (payload.home) {
        s.lineup.home = payload.home;
        const { starters, subs, sepLabel } = splitLineupText(payload.home);
        s._homeStarters = starters; s._homeSubs = subs; s._homeSepLabel = sepLabel;
        s._homePlayers = [...starters, ...subs].map(lineupLineToPlayer).filter(Boolean);
      }
      if (payload.away) {
        s.lineup.away = payload.away;
        const { starters, subs, sepLabel } = splitLineupText(payload.away);
        s._awayStarters = starters; s._awaySubs = subs; s._awaySepLabel = sepLabel;
        s._awayPlayers = [...starters, ...subs].map(lineupLineToPlayer).filter(Boolean);
      }
      break;
    }

    case 'set_team_names': // alias sent by controller inline-edit
    case 'set_game_info':
      if (payload.homeTeam    !== undefined) s.homeTeam    = String(payload.homeTeam).slice(0, 6).toUpperCase();
      if (payload.awayTeam    !== undefined) s.awayTeam    = String(payload.awayTeam).slice(0, 6).toUpperCase();
      if (payload.homeLogo    !== undefined) s.homeLogo    = String(payload.homeLogo    || '');
      if (payload.awayLogo    !== undefined) s.awayLogo    = String(payload.awayLogo    || '');
      if (payload.league      !== undefined) s.league      = String(payload.league      || '').slice(0, 100);
      if (payload.arena       !== undefined) s.arena       = String(payload.arena       || '').slice(0, 100);
      if (payload.kickoffTime !== undefined) s.kickoffTime = String(payload.kickoffTime || '').slice(0, 5);
      break;

    case 'overlay_set': {
      const VALID = ['scoreboard','lineup','lowerthird','startingsoon','brb'];
      if (VALID.includes(payload.name) && typeof payload.visible === 'boolean') {
        s.overlayVisible[payload.name] = payload.visible;
      }
      break;
    }

    case 'set_yt_url':
      s.ytUrl = (typeof payload.url === 'string') ? payload.url.slice(0, 300) : '';
      break;

    case 'set_kickoff':
      s.kickoffTime = String(payload.time || '').slice(0, 5);
      break;

    case 'reset_game':
      s.homeScore = 0; s.awayScore = 0;
      s.homeFouls = 0; s.awayFouls = 0;
      s.redCards = []; s.period = 1; s.halfTime = false;
      s.timerMs = dur; s.timerBaseMs = dur;
      s.timerRunning = false; s.timerStart = null;
      s.lowerThird = { visible: false, line1: '', line2: '', team: '', event: '' };
      s.wasRestored = false;
      break;
  }

  broadcastToRoom(room, getPublicState(room));
  saveRoomState(room);
}

// ── Rate limiter ──────────────────────────────────────────────────────────────

const _actionRate = new Map();
function checkRateLimit(key) {
  const now = Date.now();
  let e = _actionRate.get(key);
  if (!e || now >= e.resetAt) { e = { count: 0, resetAt: now + 1000 }; _actionRate.set(key, e); }
  return ++e.count <= 20;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function isAuthorisedForRoom(req, room) {
  // When behind Caddy (same machine), socket IP is always 127.0.0.1.
  // Use X-Real-IP forwarded by Caddy to get the actual client IP.
  // Local-only access (e.g. direct curl on the VPS without a token) is still allowed.
  const socketIp = req.socket.remoteAddress || '';
  const realIp   = req.headers['x-real-ip'] || '';
  const isLocal  = (realIp === '' || realIp === '127.0.0.1' || realIp === '::1')
                && (socketIp === '127.0.0.1' || socketIp === '::1' || socketIp === '::ffff:127.0.0.1');
  if (isLocal) return true;
  const url  = new URL(req.url, `http://localhost:${PORT}`);
  const qTok = url.searchParams.get('token');
  const hTok = req.headers['x-mfclive-token'];
  return qTok === room.secret || hTok === room.secret;
}

function isAdminAuthorised(req) {
  const url  = new URL(req.url, `http://localhost:${PORT}`);
  const qTok = url.searchParams.get('admin_secret');
  const hTok = req.headers['x-mfclive-admin'];
  return qTok === ADMIN_SECRET || hTok === ADMIN_SECRET;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// ── Logo proxy (FOGIS CDN) ────────────────────────────────────────────────────

function isSafeLogoUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.startsWith('[')) return false;
    if (/^(127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  } catch { return false; }
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const server = http.createServer({ maxHeaderSize: 65536 }, (req, res) => {
  const url   = new URL(req.url, `http://localhost:${PORT}`);
  const route = url.pathname;

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MFCLIVE-Token, X-MFCLIVE-Admin');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Admin routes ─────────────────────────────────────────────────────────────

  if (route === '/admin/clubs') {
    if (!isAdminAuthorised(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    // GET — list all clubs
    if (req.method === 'GET') {
      const clubs = db.prepare('SELECT id, slug, name, config, created_at FROM clubs ORDER BY created_at DESC').all();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(clubs.map(c => ({ ...c, config: parseConfig(c.config) }))));
      return;
    }

    // POST — create a new club
    if (req.method === 'POST') {
      if (!(req.headers['content-type'] || '').startsWith('application/json')) {
        res.writeHead(415); res.end('Unsupported Media Type'); return;
      }
      let body = '';
      req.on('data', d => { body += d; if (body.length > 4096) { res.writeHead(413); res.end(); req.socket.destroy(); } });
      req.on('end', () => {
        try {
          const { name, accentColour, numberOfPeriods, periodDuration } = JSON.parse(body || '{}');
          if (!name || typeof name !== 'string' || !name.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'name is required' }));
            return;
          }
          const baseSlug = slugify(name);
          // ensure slug uniqueness by appending a counter if needed
          let slug = baseSlug, counter = 2;
          while (db.prepare('SELECT 1 FROM clubs WHERE slug = ?').get(slug)) {
            slug = `${baseSlug}-${counter++}`;
          }
          const secret = crypto.randomBytes(8).toString('hex');
          const cfg = {
            accentColour:    (typeof accentColour === 'string' && /^#[0-9a-fA-F]{6}$/.test(accentColour)) ? accentColour : '#3D82F6',
            numberOfPeriods: Number.isInteger(numberOfPeriods) ? Math.max(1, Math.min(10, numberOfPeriods)) : 2,
            periodDuration:  Number.isInteger(periodDuration)  ? Math.max(1, Math.min(90, periodDuration))  : 20,
          };
          const info = db.prepare('INSERT INTO clubs (slug, name, secret, config) VALUES (?, ?, ?, ?)').run(slug, name.trim().slice(0, 80), secret, JSON.stringify(cfg));
          const newClub = db.prepare('SELECT * FROM clubs WHERE id = ?').get(info.lastInsertRowid);
          const room = createRoom(newClub);
          rooms.set(slug, room);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true, slug, secret,
            controllerUrl:  `/clubs/${slug}/controller?token=${secret}`,
            overlayBase:    `/clubs/${slug}/`,
          }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  // ── Club routes — all under /clubs/:slug/* ────────────────────────────────────

  const clubMatch = route.match(/^\/clubs\/([a-z0-9-]{1,40})(\/.*)?$/);
  if (clubMatch) {
    const slug    = clubMatch[1];
    const subpath = clubMatch[2] || '/';
    const room    = getRoom(slug);

    if (!room) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Club "${esc(slug)}" not found` }));
      return;
    }

    if (!isAuthorisedForRoom(req, room)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return;
    }

    // SSE stream
    if (subpath === '/events') {
      res.writeHead(200, {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache, no-transform',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
        'Content-Encoding':  'identity',
      });
      if (res.socket) res.socket.setNoDelay(true);
      res.write(': ' + ' '.repeat(4093) + '\n\n'); // flush Cloudflare/nginx proxy buffer
      res.write(`data: ${JSON.stringify(getPublicState(room))}\n\n`);
      room.clients.add(res);
      const ping = setInterval(() => {
        if (!res.writableEnded) { try { res.write(': keepalive\n\n'); } catch { clearInterval(ping); } }
      }, 25000);
      req.on('close', () => { room.clients.delete(res); clearInterval(ping); });
      return;
    }

    // State snapshot
    if (subpath === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(getPublicState(room)));
      return;
    }

    // Action handler
    if (req.method === 'POST' && subpath === '/action') {
      if (!(req.headers['content-type'] || '').startsWith('application/json')) {
        res.writeHead(415); res.end('Unsupported Media Type'); return;
      }
      const rateKey = room.slug + ':' + (req.headers['x-mfclive-token'] || url.searchParams.get('token') || req.socket.remoteAddress || 'anon');
      if (!checkRateLimit(rateKey)) { res.writeHead(429); res.end('Too Many Requests'); return; }
      let body = '';
      req.on('data', d => { body += d; if (body.length > 8192) { res.writeHead(413); res.end(); req.socket.destroy(); } });
      req.on('end', () => {
        try {
          const { action, payload } = JSON.parse(body || '{}');
          handleAction(room, action, payload || {});
        } catch (e) { console.error(`[action:${room.slug}] parse error:`, e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getPublicState(room)));
      });
      return;
    }

    // Logo proxy (home/away team logos — FOGIS CDN or uploaded)
    if (subpath === '/logo/home' || subpath === '/logo/away') {
      const logoUrl = subpath === '/logo/home' ? room.state.homeLogo : room.state.awayLogo;
      if (!logoUrl) { res.writeHead(404); res.end('No logo'); return; }
      if (logoUrl.startsWith('__upload__:')) {
        const fname = path.basename(logoUrl.slice(11));
        const fp = path.join(LOGOS_DIR, room.slug, fname);
        if (!fs.existsSync(fp)) { res.writeHead(404); res.end('Logo not found'); return; }
        const mime = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.svg':'image/svg+xml','.webp':'image/webp' }[path.extname(fname).toLowerCase()] || 'image/png';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
        fs.createReadStream(fp).pipe(res);
        return;
      }
      if (!isSafeLogoUrl(logoUrl)) { res.writeHead(400); res.end('Invalid logo URL'); return; }
      const lr = https.get(logoUrl, { timeout: 5000 }, lr2 => {
        res.writeHead(200, { 'Content-Type': lr2.headers['content-type'] || 'image/png', 'Cache-Control': 'public, max-age=3600' });
        lr2.pipe(res);
      });
      lr.on('timeout', () => { lr.destroy(); if (!res.headersSent) { res.writeHead(504); res.end(); } });
      lr.on('error',   () => { lr.destroy(); if (!res.headersSent) { res.writeHead(502); res.end(); } });
      return;
    }

    // Overlay / controller HTML files
    const fileMap = {
      '/':             'controller.html',
      '/controller':   'controller.html',
      '/overlay':      'overlays/overlay.html',
      '/scoreboard':   'overlays/overlay.html',
      '/lowerthird':   'overlays/overlay.html',
      '/lineup':       'overlays/overlay.html',
      '/brb':          'overlays/overlay.html',
      '/startingsoon': 'overlays/overlay.html',
      '/audio-util.js':'audio-util.js',
    };
    const file = fileMap[subpath];
    if (file) {
      const fp = path.join(PUBLIC_DIR, file);
      if (!fs.existsSync(fp)) { res.writeHead(404); res.end('File not found'); return; }
      let html = fs.readFileSync(fp, 'utf8');
      // Inject per-club session context (token + config) into controller + overlays
      const clientCfg = JSON.stringify({
        club:            room.name,
        accentColour:    room.config.accentColour || '#3D82F6',
        numberOfPeriods: numPeriods(room.config),
        periodDuration:  Number(room.config.periodDuration) || 20,
        // Overlays must use club-scoped API paths, not the single-tenant /events
        eventsPath:      `/clubs/${room.slug}/events`,
        actionPath:      `/clubs/${room.slug}/action`,
        statePath:       `/clubs/${room.slug}/api/state`,
        logoHomePath:    `/clubs/${room.slug}/logo/home`,
        logoAwayPath:    `/clubs/${room.slug}/logo/away`,
      });
      html = html.replace('</head>',
        `<script>window._MFCLIVE_TOKEN=${JSON.stringify(room.secret)};window._MFCLIVE_CONFIG=${clientCfg};</script>\n</head>`
      );
      const ct = file.endsWith('.js') ? 'application/javascript' : 'text/html';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(html);
      return;
    }

    res.writeHead(404); res.end('Not found');
    return;
  }

  // ── Signup: serve form ────────────────────────────────────────────────────────
  if (route === '/signup') {
    const fp = path.join(PUBLIC_DIR, 'signup.html');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '<h1>Signup page not found</h1>');
    return;
  }

  // ── Signup: create Stripe Checkout Session ────────────────────────────────────
  if (route === '/signup/create-session' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 4096) { res.writeHead(413); res.end(); req.socket.destroy(); } });
    req.on('end', async () => {
      try {
        const { clubName, email } = JSON.parse(body || '{}');
        if (!clubName || !email) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Club name and email are required.' })); return; }

        const session = await stripe.checkout.sessions.create({
          mode:           'subscription',
          payment_method_types: ['card'],
          customer_email: email.trim(),
          line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
          metadata:   { clubName: clubName.trim().slice(0, 80), email: email.trim() },
          success_url: `https://futsalplay.live/signup/success`,
          cancel_url:  `https://futsalplay.live/signup`,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: session.url }));
      } catch (e) {
        console.error('[stripe] session creation failed:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not create payment session. Please try again.' }));
      }
    });
    return;
  }

  // ── Signup: success page ──────────────────────────────────────────────────────
  if (route === '/signup/success') {
    const fp = path.join(PUBLIC_DIR, 'signup-success.html');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '<h1>Payment confirmed. Check your email.</h1>');
    return;
  }

  // ── Stripe webhook ────────────────────────────────────────────────────────────
  if (route === '/webhooks/stripe' && req.method === 'POST') {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks);
      const sig     = req.headers['stripe-signature'];
      const secret  = process.env.STRIPE_WEBHOOK_SECRET;

      let event;
      try {
        event = secret
          ? stripe.webhooks.constructEvent(rawBody, sig, secret)
          : JSON.parse(rawBody.toString());
      } catch (e) {
        console.error('[stripe webhook] signature verification failed:', e.message);
        res.writeHead(400); res.end('Webhook signature invalid');
        return;
      }

      if (event.type === 'checkout.session.completed') {
        const session  = event.data.object;
        const clubName = session.metadata && session.metadata.clubName;
        const email    = session.metadata && session.metadata.email;

        if (clubName && email) {
          try {
            // Generate slug and ensure uniqueness
            const baseSlug = clubName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
            let slug = baseSlug, counter = 2;
            while (db.prepare('SELECT 1 FROM clubs WHERE slug = ?').get(slug)) {
              slug = `${baseSlug}-${counter++}`;
            }
            const secret = crypto.randomBytes(8).toString('hex');
            const cfg    = JSON.stringify({ accentColour: '#3D82F6', numberOfPeriods: 2, periodDuration: 20 });
            db.prepare('INSERT INTO clubs (slug, name, secret, config) VALUES (?, ?, ?, ?)').run(slug, clubName.slice(0, 80), secret, cfg);
            const newClub = db.prepare('SELECT * FROM clubs WHERE slug = ?').get(slug);
            const room    = createRoom(newClub);
            rooms.set(slug, room);

            const controllerUrl = `https://futsalplay.live/clubs/${slug}/controller?token=${secret}`;
            const overlayUrl    = `https://futsalplay.live/clubs/${slug}/overlay?token=${secret}`;

            await mailer.sendMail({
              from:    '"Futsalplay.live" <info@futsalplay.live>',
              to:      email,
              subject: 'Your FutsalPlay club is ready',
              text: [
                `Hi,`,
                ``,
                `Your club "${clubName}" is live on Futsalplay.live.`,
                ``,
                `Controller (open on any device to manage the game):`,
                controllerUrl,
                ``,
                `Overlay URL (add as a browser source in OBS or Streamlabs):`,
                overlayUrl,
                ``,
                `Keep these links safe. Anyone with the link can access your controller.`,
                ``,
                `Questions? Reply to this email or write to info@futsalplay.live.`,
                ``,
                `Welcome aboard,`,
                `The FutsalPlay team`,
              ].join('\n'),
              html: `
                <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a2340;">
                  <img src="https://futsalplay.live/img/logo.png" alt="Futsalplay.live" style="height:60px;margin-bottom:24px;">
                  <h2 style="font-size:1.4rem;margin-bottom:8px;">Your club is ready!</h2>
                  <p style="color:#5a6580;">Hi, welcome to Futsalplay.live. Here are your links for <strong>${esc(clubName)}</strong>.</p>

                  <div style="background:#F4F6FA;border-radius:10px;padding:20px 24px;margin:24px 0;">
                    <p style="font-size:0.8rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#3D82F6;margin-bottom:8px;">Controller</p>
                    <p style="font-size:0.82rem;color:#5a6580;margin-bottom:8px;">Open on any phone or tablet to manage your live game.</p>
                    <a href="${controllerUrl}" style="display:inline-block;background:#3D82F6;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:0.9rem;">Open Controller</a>
                    <p style="font-size:0.75rem;color:#9aaabf;margin-top:10px;word-break:break-all;">${controllerUrl}</p>
                  </div>

                  <div style="background:#F4F6FA;border-radius:10px;padding:20px 24px;margin:24px 0;">
                    <p style="font-size:0.8rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#3D82F6;margin-bottom:8px;">Overlay URL</p>
                    <p style="font-size:0.82rem;color:#5a6580;margin-bottom:8px;">Add this as a browser source in OBS or Streamlabs (1920x1080).</p>
                    <p style="font-size:0.75rem;color:#9aaabf;word-break:break-all;">${overlayUrl}</p>
                  </div>

                  <p style="font-size:0.85rem;color:#5a6580;">Keep these links safe. Anyone with the link can access your controller.</p>
                  <p style="font-size:0.85rem;color:#5a6580;margin-top:16px;">Questions? Reply to this email and we will help you get set up.</p>
                  <hr style="border:none;border-top:1px solid #e4eaf5;margin:28px 0;">
                  <p style="font-size:0.78rem;color:#9aaabf;">Futsalplay.live &mdash; You play, we stream it.</p>
                </div>
              `,
            });

            console.log(`[signup] Club created: ${slug} (${email})`);
          } catch (e) {
            console.error('[signup] club creation or email failed:', e.message);
          }
        }
      }

      res.writeHead(200); res.end('ok');
    });
    return;
  }

  // ── Static assets (logo etc.) ─────────────────────────────────────────────────
  if (route.startsWith('/img/')) {
    const fname = path.basename(route);
    const fp = path.join(PUBLIC_DIR, 'img', fname);
    if (fs.existsSync(fp)) {
      const ext  = path.extname(fname).toLowerCase();
      const mime = { '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.webp':'image/webp' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(fp).pipe(res);
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // ── Landing page ──────────────────────────────────────────────────────────────
  if (route === '/' || route === '') {
    const fp = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(fp)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(fp, 'utf8'));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>futsalplay.live</h1>');
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── Boot ──────────────────────────────────────────────────────────────────────

loadAllRooms();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  MFCLIVE SaaS — port ${PORT}`);
  console.log(`\n   Admin API  : http://localhost:${PORT}/admin/clubs`);
  console.log(`   Admin key  : ${ADMIN_SECRET.slice(0, 4)}****${ADMIN_SECRET.slice(-4)}`);
  console.log(`\n   Clubs loaded: ${rooms.size}`);
  for (const room of rooms.values()) {
    console.log(`     /clubs/${room.slug}/controller  (token: ${room.secret.slice(0,2)}****${room.secret.slice(-2)})`);
  }
  console.log('');
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[shutdown] Saving all room states…');
  for (const room of rooms.values()) saveRoomState(room);
  db.close();
  process.exit(0);
});
