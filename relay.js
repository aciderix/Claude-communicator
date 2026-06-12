#!/usr/bin/env node
/*
 * claude-comm relay — relais réseau sécurisé pour la coordination
 * multi-machines entre sessions Claude Code.
 *
 * Chaque session lance server.js avec CLAUDE_COMM_RELAY=<url> et
 * CLAUDE_COMM_TOKEN=<secret> ; le relais héberge l'état du canal
 * (sessions, messagerie, tâches, verrous, notes) et route les requêtes
 * de service (diff/fichier) entre instances.
 *
 * Sécurité :
 *  - jeton Bearer obligatoire, comparé à temps constant (timingSafeEqual)
 *  - bind sur 127.0.0.1 par défaut (exposer explicitement avec --host)
 *  - TLS natif optionnel (--tls-cert / --tls-key), sinon reverse proxy
 *  - aucune exécution de code : le relais ne fait que stocker/router du JSON
 *  - limites : taille de corps, boîtes, sessions, canaux, débit par IP
 *
 * Démarrage :
 *   node relay.js gen-token                         # générer un secret fort
 *   CLAUDE_COMM_RELAY_SECRET=<t> node relay.js --host 0.0.0.0 --port 8787
 *
 * Zéro dépendance. Node >= 18.
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  sanitizeName, nowISO, newId, emptyTasks,
  applyTaskAction, applyLockAction, applyNoteAction,
  emptyPlan, applyPlanAction, emptyReviews, applyReviewAction,
  emptyUser, applyUserAction, userPost, userAnswer,
  emptyConfig, standupDigest,
} = require('./lib/shared');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));

if (ARGS._[0] === 'gen-token') {
  console.log(crypto.randomBytes(32).toString('base64url'));
  process.exit(0);
}

const PORT = Number(ARGS.port || process.env.PORT || 8787);
const HOST = ARGS.host || process.env.CLAUDE_COMM_RELAY_HOST || '127.0.0.1';
const DATA = ARGS.data ? path.resolve(ARGS.data) : null;

let SECRET = ARGS.secret || process.env.CLAUDE_COMM_RELAY_SECRET || '';
let secretGenerated = false;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('base64url');
  secretGenerated = true;
}
const SECRET_HASH = crypto.createHash('sha256').update(SECRET).digest();

// Appairage mobile : un code à 6 chiffres, court à taper sur un téléphone,
// échangeable contre le jeton via POST /pair. Activé avec --pair.
// Protections : validité 15 min, 20 tentatives max, puis rotation du code.
const PAIR_ENABLED = !!(ARGS.pair || process.env.CLAUDE_COMM_RELAY_PAIR);
let pairing = null;
function newPairCode(quiet = false) {
  if (!PAIR_ENABLED) return;
  pairing = {
    code: String(crypto.randomInt(100000, 1000000)),
    expiresAt: Date.now() + 15 * 60000,
    attempts: 0,
  };
  if (!quiet) console.error(`📱 Code d'appairage dashboard : ${pairing.code}  (valable 15 min)`);
}

const LIMITS = {
  channels: 100,
  sessionsPerChannel: 64,
  inboxPerSession: 500,
  bodyBytes: 512 * 1024,
  msgBodyChars: 64 * 1024,
  serviceQueue: 16,
  reqPerMinPerIp: 600,
  maxWaitS: 30,
  serviceTimeoutMs: 30000,
};

// ---------------------------------------------------------------------------
// État des canaux
// ---------------------------------------------------------------------------

const channels = new Map();

function newChannel(name) {
  return {
    name,
    sessions: {},        // name -> session
    inboxes: {},         // name -> [messages]
    tasks: emptyTasks(),
    locks: [],
    notes: [],
    plan: emptyPlan(),
    reviews: emptyReviews(),
    user: emptyUser(),
    config: emptyConfig(),
    version: 1,
    waiters: [],         // long-polls en attente (état / inbox)
    servicePollers: new Map(),  // name -> {res, timer}
    serviceQueues: new Map(),   // name -> [requests]
    pendingService: new Map(),  // id -> {res, timer}
    _saveTimer: null,
  };
}

function getChannel(name) {
  let ch = channels.get(name);
  if (!ch) {
    if (channels.size >= LIMITS.channels) throw httpError(429, 'Trop de canaux sur ce relais.');
    ch = newChannel(name);
    channels.set(name, ch);
  }
  return ch;
}

// Persistance optionnelle (--data <dir>) : l'état survit aux redémarrages.
function persist(ch) {
  if (!DATA || ch._saveTimer) return;
  ch._saveTimer = setTimeout(() => {
    ch._saveTimer = null;
    try {
      fs.mkdirSync(DATA, { recursive: true });
      const f = path.join(DATA, `${ch.name}.json`);
      const tmp = `${f}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        sessions: ch.sessions, inboxes: ch.inboxes,
        tasks: ch.tasks, locks: ch.locks, notes: ch.notes,
        plan: ch.plan, reviews: ch.reviews,
        user: ch.user, config: ch.config, version: ch.version,
      }));
      fs.renameSync(tmp, f);
    } catch (e) { console.error(`persistance ${ch.name}:`, e.message); }
  }, 500);
}

function loadPersisted() {
  if (!DATA) return;
  let files = [];
  try { files = fs.readdirSync(DATA).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
      const name = sanitizeName(f.replace(/\.json$/, ''));
      const ch = newChannel(name);
      Object.assign(ch, {
        sessions: d.sessions || {}, inboxes: d.inboxes || {},
        tasks: d.tasks || emptyTasks(), locks: d.locks || [],
        notes: d.notes || [], plan: d.plan || emptyPlan(),
        reviews: d.reviews || emptyReviews(),
        user: d.user || emptyUser(), config: d.config || emptyConfig(),
        version: (d.version || 1) + 1,
      });
      channels.set(name, ch);
    } catch (e) { console.error(`chargement ${f}:`, e.message); }
  }
  if (channels.size) console.error(`État restauré : ${channels.size} canal/canaux depuis ${DATA}`);
}

// Réveille les long-polls dont la condition est devenue vraie.
function bump(ch) {
  ch.version++;
  persist(ch);
  for (const w of ch.waiters.slice()) w.check();
}

function addWaiter(ch, check, timeoutMs, onTimeout) {
  const w = {};
  const timer = setTimeout(() => {
    ch.waiters = ch.waiters.filter((x) => x !== w);
    try { onTimeout(); } catch { /* client parti */ }
  }, timeoutMs);
  w.check = () => {
    let done = false;
    try { done = check(); } catch { done = true; }
    if (done) {
      clearTimeout(timer);
      ch.waiters = ch.waiters.filter((x) => x !== w);
    }
    return done;
  };
  ch.waiters.push(w);
  return w;
}

// ---------------------------------------------------------------------------
// Aides HTTP
// ---------------------------------------------------------------------------

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function json(res, status, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...CORS_HEADERS,
  });
  res.end(body);
}

// CORS : nécessaire pour les apps (mobile/desktop) dont la WebView a sa
// propre origine. Sans cookies, l'authentification reste le jeton Bearer
// explicite : autoriser toutes les origines n'affaiblit rien.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, bypass-tunnel-reminder',
  'access-control-max-age': '86400',
};

function tokenOk(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const h = crypto.createHash('sha256').update(header.slice(7)).digest();
  return crypto.timingSafeEqual(h, SECRET_HASH);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMITS.bodyBytes) { reject(httpError(413, 'Corps trop volumineux.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(httpError(400, 'JSON invalide.')); }
    });
    req.on('error', reject);
  });
}

// Limitation de débit par IP (fenêtre glissante grossière d'une minute).
const rateBuckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 60000 }; rateBuckets.set(ip, b); }
  b.count++;
  if (rateBuckets.size > 10000) rateBuckets.clear();
  return b.count > LIMITS.reqPerMinPerIp;
}

// ---------------------------------------------------------------------------
// Opérations sur un canal
// ---------------------------------------------------------------------------

function sessionsList(ch) {
  return Object.values(ch.sessions).map((s) => ({
    ...s,
    live: ch.servicePollers.has(s.name) ||
      Date.now() - Date.parse(s.last_seen || 0) < 90000,
  }));
}

function deliver(ch, to, msg) {
  const box = (ch.inboxes[to] = ch.inboxes[to] || []);
  box.push(msg);
  if (box.length > LIMITS.inboxPerSession) box.splice(0, box.length - LIMITS.inboxPerSession);
}

function broadcast(ch, from, kind, subject, body) {
  for (const name of Object.keys(ch.sessions)) {
    if (name === from) continue;
    deliver(ch, name, { id: newId(), from, to: name, kind, subject, body, reply_to: null, ts: nowISO() });
  }
}

function notifyFromOp(ch, actor, op) {
  if (op && op.notify) broadcast(ch, actor, 'notify', op.notify.subject, op.notify.body);
}

function statePayload(ch) {
  return {
    version: ch.version,
    sessions: sessionsList(ch),
    tasks: ch.tasks,
    locks: ch.locks,
    plan: ch.plan,
    reviews: ch.reviews,
    user: ch.user,
    config: { standup_minutes: ch.config.standup_minutes },
    notes_tail: ch.notes.slice(-20),
    notes_count: ch.notes.length,
    inbox_counts: Object.fromEntries(Object.entries(ch.inboxes).map(([k, v]) => [k, v.length])),
  };
}

// ---------------------------------------------------------------------------
// Routage
// ---------------------------------------------------------------------------

let DASHBOARD_HTML = '';
try {
  DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, 'public', 'dashboard.html'), 'utf8');
} catch { /* dashboard absent : routes API seulement */ }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// Coquille PWA : fichiers statiques publics (aucune donnée du canal).
const STATIC_FILES = {};
for (const [route, file, type] of [
  ['/manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json'],
  ['/sw.js', 'sw.js', 'text/javascript; charset=utf-8'],
  ['/icon.svg', 'icon.svg', 'image/svg+xml'],
]) {
  try {
    STATIC_FILES[route] = { body: fs.readFileSync(path.join(__dirname, 'public', file)), type };
  } catch { /* fichier absent */ }
}

// Interface React (web/dist) : servie à la racine quand elle a été
// construite (npm run build dans web/). Sinon, repli sur le dashboard
// vanilla ci-dessus — le relais reste zéro-dépendance.
(function loadWebDist(dir, prefix) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const route = `${prefix}/${e.name}`;
    if (e.isDirectory()) { loadWebDist(full, route); continue; }
    const type = MIME[path.extname(e.name).toLowerCase()] || 'application/octet-stream';
    STATIC_FILES[route] = { body: fs.readFileSync(full), type };
  }
})(path.join(__dirname, 'web', 'dist'), '');
if (STATIC_FILES['/index.html']) {
  DASHBOARD_HTML = ''; // l'interface React remplace le dashboard vanilla
  console.error('Interface React chargée (web/dist).');
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://relay');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }
  if (req.method === 'GET' && u.pathname === '/healthz') {
    return json(res, 200, { ok: true });
  }
  // Le HTML du dashboard est public (il ne contient aucune donnée) :
  // le jeton est saisi dans l'interface et requis pour tous les appels API.
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/dashboard')) {
    const index = STATIC_FILES['/index.html'];
    if (index) {
      res.writeHead(200, { 'content-type': index.type, 'cache-control': 'no-store' });
      return res.end(index.body);
    }
    if (DASHBOARD_HTML) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(DASHBOARD_HTML);
    }
  }
  if (req.method === 'GET' && STATIC_FILES[u.pathname]) {
    const f = STATIC_FILES[u.pathname];
    const immutable = u.pathname.startsWith('/assets/');
    res.writeHead(200, {
      'content-type': f.type,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    return res.end(f.body);
  }
  if (req.method === 'POST' && u.pathname === '/pair') {
    if (!PAIR_ENABLED || !pairing) return json(res, 404, { error: 'Appairage désactivé sur ce relais.' });
    if (rateLimited(req.socket.remoteAddress || '?')) return json(res, 429, { error: 'Débit trop élevé.' });
    const body = await readBody(req);
    if (Date.now() > pairing.expiresAt || pairing.attempts >= 20) {
      newPairCode();
      return json(res, 410, { error: 'Code expiré ou trop de tentatives — un nouveau code vient d\'être affiché côté serveur.' });
    }
    if (String(body.code || '') !== pairing.code) {
      pairing.attempts++;
      return json(res, 401, { error: 'Code d\'appairage invalide.' });
    }
    return json(res, 200, { token: SECRET });
  }
  if (!tokenOk(req.headers.authorization)) {
    return json(res, 401, { error: 'Non autorisé : jeton Bearer manquant ou invalide.' });
  }
  if (req.method === 'GET' && u.pathname === '/channels') {
    return json(res, 200, { channels: [...channels.keys()] });
  }
  if (req.method === 'GET' && u.pathname === '/pair-code') {
    return json(res, 200, { code: PAIR_ENABLED && pairing ? pairing.code : null });
  }
  const ip = req.socket.remoteAddress || '?';
  if (rateLimited(ip)) return json(res, 429, { error: 'Débit trop élevé, réessaie dans une minute.' });

  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'c' || !parts[1]) return json(res, 404, { error: 'Route inconnue.' });
  const ch = getChannel(sanitizeName(parts[1]));
  const rest = parts.slice(2);
  const q = u.searchParams;
  const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : {};
  const waitS = Math.min(Math.max(Number(q.get('wait')) || 0, 0), LIMITS.maxWaitS);

  // --- sessions -----------------------------------------------------------
  if (req.method === 'GET' && rest[0] === 'sessions' && !rest[1]) {
    return json(res, 200, { sessions: sessionsList(ch) });
  }
  if (req.method === 'POST' && rest[0] === 'sessions' && rest[1]) {
    const name = sanitizeName(rest[1]);
    if (!ch.sessions[name] && Object.keys(ch.sessions).length >= LIMITS.sessionsPerChannel) {
      return json(res, 429, { error: 'Trop de sessions sur ce canal.' });
    }
    const prev = ch.sessions[name] || { joined_at: nowISO() };
    const patch = {};
    for (const k of ['role', 'state', 'task', 'detail', 'progress', 'cwd', 'branch', 'head',
      'host', 'pid', 'last_model_seen', 'compacting', 'compacted_at']) {
      if (body[k] !== undefined) patch[k] = typeof body[k] === 'string' ? body[k].slice(0, 2000) : body[k];
    }
    ch.sessions[name] = { ...prev, ...patch, name, last_seen: nowISO(), joined_at: prev.joined_at };
    bump(ch);
    return json(res, 200, { session: ch.sessions[name] });
  }

  // --- messagerie ----------------------------------------------------------
  if (req.method === 'POST' && rest[0] === 'messages') {
    const from = sanitizeName(body.from);
    const kind = ['message', 'question', 'status_request', 'diff_request', 'alert', 'task', 'notify']
      .includes(body.kind) ? body.kind : 'message';
    if (!body.to || !body.body) return json(res, 400, { error: 'Paramètres requis : to, body.' });
    let targets;
    if (body.to === '*' || body.to === 'all') {
      targets = Object.keys(ch.sessions).filter((n) => n !== from);
      if (!targets.length) return json(res, 409, { error: 'Aucun pair connecté pour le broadcast.' });
    } else {
      const t = sanitizeName(body.to);
      if (!ch.sessions[t]) {
        const known = Object.keys(ch.sessions).join(', ') || '(aucune session)';
        return json(res, 404, { error: `Pair inconnu : "${body.to}". Sessions enregistrées : ${known}` });
      }
      targets = [t];
    }
    const msg = {
      id: newId(), from, kind,
      subject: String(body.subject || '').slice(0, 300),
      body: String(body.body).slice(0, LIMITS.msgBodyChars),
      reply_to: body.reply_to ? String(body.reply_to).slice(0, 16) : null,
      ts: nowISO(),
    };
    for (const t of targets) deliver(ch, t, { ...msg, to: t });
    bump(ch);
    return json(res, 200, { id: msg.id, kind: msg.kind, targets });
  }
  if (req.method === 'GET' && rest[0] === 'inbox' && rest[1] && rest[2] === 'count') {
    return json(res, 200, { count: (ch.inboxes[sanitizeName(rest[1])] || []).length });
  }
  if (req.method === 'GET' && rest[0] === 'inbox' && rest[1]) {
    const name = sanitizeName(rest[1]);
    const consume = q.get('consume') === '1';
    const read = () => {
      const box = ch.inboxes[name] || [];
      if (!box.length) return null;
      const msgs = box.slice();
      if (consume) { ch.inboxes[name] = []; persist(ch); }
      return msgs;
    };
    const first = read();
    if (first || !waitS) return json(res, 200, { messages: first || [] });
    addWaiter(ch, () => {
      const msgs = read();
      if (msgs) { json(res, 200, { messages: msgs }); return true; }
      return res.writableEnded;
    }, waitS * 1000, () => json(res, 200, { messages: [] }));
    req.on('close', () => { /* le waiter se retirera via res.writableEnded */ });
    return;
  }

  // --- tâches / verrous / notes -------------------------------------------
  if (req.method === 'POST' && rest[0] === 'tasks') {
    const actor = sanitizeName(body.actor);
    const op = applyTaskAction(ch.tasks, actor, body);
    notifyFromOp(ch, actor, op);
    if (op.changed) bump(ch);
    return json(res, 200, { result: op.result });
  }
  if (req.method === 'POST' && rest[0] === 'locks') {
    const actor = sanitizeName(body.actor);
    const op = applyLockAction(ch.locks, actor, body);
    ch.locks = op.locks;
    notifyFromOp(ch, actor, op);
    if (op.changed) bump(ch);
    return json(res, 200, { result: op.result });
  }
  if (req.method === 'POST' && rest[0] === 'notes') {
    const actor = sanitizeName(body.actor);
    const op = applyNoteAction(ch.notes, actor, body);
    notifyFromOp(ch, actor, op);
    if (op.changed) bump(ch);
    return json(res, 200, { result: op.result });
  }
  if (req.method === 'POST' && rest[0] === 'plan') {
    const actor = sanitizeName(body.actor);
    const op = applyPlanAction(ch.plan, actor, body);
    notifyFromOp(ch, actor, op);
    if (op.changed) bump(ch);
    return json(res, 200, { result: op.result });
  }
  if (req.method === 'POST' && rest[0] === 'reviews') {
    const actor = sanitizeName(body.actor);
    const op = applyReviewAction(ch.reviews, actor, body);
    notifyFromOp(ch, actor, op);
    if (op.changed) bump(ch);
    return json(res, 200, { result: op.result });
  }

  // --- interactions utilisateur (sessions ← outil comm_user) --------------
  if (req.method === 'POST' && rest[0] === 'user-ops') {
    const actor = sanitizeName(body.actor);
    const op = applyUserAction(ch.user, actor, body);
    notifyFromOp(ch, actor, op);
    if (op.changed) bump(ch);
    return json(res, 200, { result: op.result });
  }
  // --- interactions utilisateur (dashboard / CLI → sessions) --------------
  if (req.method === 'POST' && rest[0] === 'user-post') {
    const { msg, deliveries } = userPost(ch.user, Object.keys(ch.sessions), body);
    for (const d of deliveries) deliver(ch, d.to, d.message);
    bump(ch);
    return json(res, 200, { msg });
  }
  if (req.method === 'POST' && rest[0] === 'user-answer') {
    const r = userAnswer(ch.user, body);
    broadcast(ch, 'user', 'notify', r.notify.subject, r.notify.body);
    bump(ch);
    return json(res, 200, { question: r.question });
  }
  if (req.method === 'POST' && rest[0] === 'config') {
    if (body.standup_minutes !== undefined) {
      ch.config.standup_minutes = Math.max(0, Math.min(1440, Number(body.standup_minutes) || 0));
    }
    bump(ch);
    return json(res, 200, { config: { standup_minutes: ch.config.standup_minutes } });
  }

  // --- état global (long-poll pour comm_wait) ------------------------------
  if (req.method === 'GET' && rest[0] === 'state') {
    const clientV = Number(q.get('version')) || 0;
    if (ch.version > clientV || !waitS) return json(res, 200, statePayload(ch));
    addWaiter(ch, () => {
      if (res.writableEnded) return true;
      if (ch.version > clientV) { json(res, 200, statePayload(ch)); return true; }
      return false;
    }, waitS * 1000, () => json(res, 200, statePayload(ch)));
    return;
  }

  // --- requêtes de service (diff / fichier, auto-répondues par le pair) ----
  if (req.method === 'POST' && rest[0] === 'service' && rest[1]) {
    const target = sanitizeName(rest[1]);
    if (!ch.sessions[target]) return json(res, 404, { error: `Pair inconnu : "${rest[1]}".` });
    const request = {
      id: newId(), from: sanitizeName(body.from),
      action: String(body.action || '').slice(0, 32),
      params: body.params || {}, ts: nowISO(),
    };
    const timer = setTimeout(() => {
      ch.pendingService.delete(request.id);
      const offline = !ch.servicePollers.has(target);
      json(res, 200, {
        ok: false,
        error: offline
          ? `${target} ne répond pas (sa session semble déconnectée du relais).`
          : `${target} n'a pas répondu dans les ${LIMITS.serviceTimeoutMs / 1000}s.`,
      });
    }, LIMITS.serviceTimeoutMs);
    ch.pendingService.set(request.id, { res, timer });

    const poller = ch.servicePollers.get(target);
    if (poller) {
      ch.servicePollers.delete(target);
      clearTimeout(poller.timer);
      json(poller.res, 200, { request });
    } else {
      const queue = ch.serviceQueues.get(target) || [];
      if (queue.length >= LIMITS.serviceQueue) {
        clearTimeout(timer);
        ch.pendingService.delete(request.id);
        return json(res, 200, { ok: false, error: `File de service de ${target} pleine.` });
      }
      queue.push(request);
      ch.serviceQueues.set(target, queue);
    }
    return;
  }
  if (req.method === 'GET' && rest[0] === 'service-poll' && rest[1]) {
    const name = sanitizeName(rest[1]);
    if (ch.sessions[name]) { ch.sessions[name].last_seen = nowISO(); }
    const queue = ch.serviceQueues.get(name) || [];
    if (queue.length) {
      const request = queue.shift();
      return json(res, 200, { request });
    }
    const old = ch.servicePollers.get(name);
    if (old) { clearTimeout(old.timer); json(old.res, 200, { request: null }); }
    const timer = setTimeout(() => {
      if (ch.servicePollers.get(name)?.res === res) ch.servicePollers.delete(name);
      json(res, 200, { request: null });
    }, (waitS || 25) * 1000);
    ch.servicePollers.set(name, { res, timer });
    req.on('close', () => {
      const p = ch.servicePollers.get(name);
      if (p && p.res === res) { clearTimeout(p.timer); ch.servicePollers.delete(name); }
    });
    return;
  }
  if (req.method === 'POST' && rest[0] === 'service-reply') {
    const pending = ch.pendingService.get(String(body.id || ''));
    if (pending) {
      ch.pendingService.delete(String(body.id));
      clearTimeout(pending.timer);
      json(pending.res, 200, { ok: body.ok !== false, result: body.result });
    }
    return json(res, 200, {});
  }

  return json(res, 404, { error: 'Route inconnue.' });
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

loadPersisted();

// Standup périodique optionnel : digest compact (généré sans LLM) diffusé
// aux sessions seulement si l'état a changé depuis le précédent.
function maybeStandup(ch) {
  const minutes = ch.config.standup_minutes;
  if (!minutes) return;
  const last = Date.parse(ch.config.last_standup_at || 0) || 0;
  if (Date.now() - last < minutes * 60000) return;
  ch.config.last_standup_at = nowISO();
  if (!Object.keys(ch.sessions).length) { persist(ch); return; }
  const digest = standupDigest(statePayload(ch));
  const hash = crypto.createHash('sha1').update(digest).digest('hex');
  if (hash === ch.config.last_standup_hash) { persist(ch); return; }
  ch.config.last_standup_hash = hash;
  broadcast(ch, 'standup', 'notify', '🗞 standup périodique', digest);
  bump(ch);
}

const standupTimer = setInterval(() => {
  for (const ch of channels.values()) {
    try { maybeStandup(ch); } catch (e) { console.error('standup:', e.message); }
  }
  if (PAIR_ENABLED && pairing && Date.now() > pairing.expiresAt) newPairCode();
}, 60000);
standupTimer.unref();

const onRequest = (req, res) => {
  handle(req, res).catch((e) => json(res, e.status || 500, { error: e.message }));
};

let server;
if (ARGS['tls-cert'] && ARGS['tls-key']) {
  server = https.createServer({
    cert: fs.readFileSync(ARGS['tls-cert']),
    key: fs.readFileSync(ARGS['tls-key']),
  }, onRequest);
} else {
  server = http.createServer(onRequest);
}
server.requestTimeout = 0;       // long-polls
server.headersTimeout = 65000;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ Le port ${PORT} est déjà utilisé — un relais tourne peut-être déjà.`);
    console.error('   Arrête-le (pkill -f relay.js) ou choisis un autre port avec --port.');
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  const proto = ARGS['tls-cert'] ? 'https' : 'http';
  console.error(`claude-comm relay à l'écoute sur ${proto}://${HOST}:${server.address().port}`);
  if (secretGenerated) {
    console.error(`⚠️  Aucun secret fourni — secret généré pour cette instance :\n    ${SECRET}`);
    console.error('    Relance avec --secret <token> ou CLAUDE_COMM_RELAY_SECRET pour un secret stable.');
  }
  if (HOST === '127.0.0.1') {
    console.error('ℹ️  Bind local uniquement. Pour le multi-machines : --host 0.0.0.0 (avec TLS ou reverse proxy).');
  } else if (!ARGS['tls-cert']) {
    console.error('⚠️  Exposé sans TLS : place un reverse proxy HTTPS devant, ou utilise --tls-cert/--tls-key.');
  }
  if (DATA) console.error(`Persistance : ${DATA}`);
  newPairCode();
});
