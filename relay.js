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
  sanitizeName, nowISO, newId, emptyTasks, unmetDeps,
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

// Persistance externe optionnelle : permet de survivre aux redemarrages/
// sommeils sur un hote SANS disque (ex: Render gratuit). Deux backends :
//  - REDIS_URL (redis:// ou rediss://) : protocole Redis standard. Marche
//    avec le Key Value NATIF de Render (cable automatiquement via render.yaml,
//    ZERO saisie) ou n'importe quel Redis (Upstash fournit aussi une redis://).
//  - UPSTASH_REDIS_REST_URL + _TOKEN : API REST Upstash (a saisir a la main).
const REDIS_URL = process.env.REDIS_URL || process.env.KEYVALUE_URL || '';
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const STORE_KEY = process.env.CLAUDE_COMM_STATE_KEY || 'claude-comm:state';
const STORE_BACKEND = REDIS_URL ? 'redis' : (UPSTASH_URL && UPSTASH_TOKEN) ? 'upstash' : 'none';
const STORE_ON = STORE_BACKEND !== 'none';

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
const NATIVE_LOG = []; // journal de diagnostic natif (Android), lu à distance

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
// Etat serialisable d'un canal (sans les structures runtime : waiters,
// pollers, files de service, timers).
function serializeChannel(ch) {
  return {
    sessions: ch.sessions, inboxes: ch.inboxes,
    tasks: ch.tasks, locks: ch.locks, notes: ch.notes,
    plan: ch.plan, reviews: ch.reviews,
    user: ch.user, config: ch.config, version: ch.version,
  };
}

function deserializeInto(ch, d) {
  Object.assign(ch, {
    sessions: d.sessions || {}, inboxes: d.inboxes || {},
    tasks: d.tasks || emptyTasks(), locks: d.locks || [],
    notes: d.notes || [], plan: d.plan || emptyPlan(),
    reviews: d.reviews || emptyReviews(),
    user: d.user || emptyUser(), config: d.config || emptyConfig(),
    version: (d.version || 1) + 1,
  });
}

function persist(ch) {
  upstashSave();
  if (!DATA || ch._saveTimer) return;
  ch._saveTimer = setTimeout(() => {
    ch._saveTimer = null;
    try {
      fs.mkdirSync(DATA, { recursive: true });
      const f = path.join(DATA, `${ch.name}.json`);
      const tmp = `${f}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(serializeChannel(ch)));
      fs.renameSync(tmp, f);
    } catch (e) { console.error(`persistance ${ch.name}:`, e.message); }
  }, 500);
}

// --- Backend Upstash REST ----------------------------------------------------
async function upstashRest(cmd) {
  const r = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${UPSTASH_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(8000),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

// --- Backend Redis (protocole RESP, zero dependance) -------------------------
const net = require('net');
const tls = require('tls');

function respEncode(args) {
  let s = `*${args.length}\r\n`;
  for (const a of args) { const str = String(a); s += `$${Buffer.byteLength(str)}\r\n${str}\r\n`; }
  return Buffer.from(s, 'utf8');
}

// Decode UNE reponse RESP a partir de offset. Retourne {value, next} ou null
// si incomplete.
function respDecode(buf, offset) {
  if (offset >= buf.length) return null;
  const type = buf[offset];
  const nl = buf.indexOf('\r\n', offset);
  if (nl === -1) return null;
  const line = buf.toString('utf8', offset + 1, nl);
  if (type === 0x2b) return { value: line, next: nl + 2 };               // +simple
  if (type === 0x2d) return { value: new Error(line), next: nl + 2 };    // -error
  if (type === 0x3a) return { value: Number(line), next: nl + 2 };       // :int
  if (type === 0x24) {                                                   // $bulk
    const len = Number(line);
    if (len === -1) return { value: null, next: nl + 2 };
    const start = nl + 2;
    if (start + len + 2 > buf.length) return null;
    return { value: buf.toString('utf8', start, start + len), next: start + len + 2 };
  }
  if (type === 0x2a) {                                                   // *array
    const count = Number(line);
    if (count === -1) return { value: null, next: nl + 2 };
    let cur = nl + 2; const arr = [];
    for (let i = 0; i < count; i++) {
      const r = respDecode(buf, cur);
      if (!r) return null;
      arr.push(r.value); cur = r.next;
    }
    return { value: arr, next: cur };
  }
  return null;
}

// Ouvre une connexion, AUTH si besoin, envoie les commandes en pipeline,
// renvoie la reponse de la DERNIERE.
function redisExec(url, commands) {
  return new Promise((resolve, reject) => {
    let u;
    // tolerant aux collages approximatifs :
    //  - si l'URL redis:// est presente quelque part (ex: on a colle
    //    REDIS_URL="rediss://..." avec le prefixe/les guillemets), on l'extrait
    //  - sinon, valeur sans schema (host:port) -> on prefixe redis://
    let raw = String(url).trim();
    const m = raw.match(/rediss?:\/\/[^\s"']+/i);
    if (m) raw = m[0];
    else { raw = raw.replace(/^["']|["']$/g, ''); if (raw) raw = 'redis://' + raw; }
    try { u = new URL(raw); }
    catch { return reject(new Error(`REDIS_URL invalide (debut : "${String(url).slice(0, 24)}…")`)); }
    const useTls = u.protocol === 'rediss:';
    const host = u.hostname;
    const port = Number(u.port) || 6379;
    const password = decodeURIComponent(u.password || '');
    const username = decodeURIComponent(u.username || '');
    const all = [];
    if (password) all.push(username ? ['AUTH', username, password] : ['AUTH', password]);
    for (const c of commands) all.push(c);

    const sock = useTls
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });
    let buf = Buffer.alloc(0);
    let done = false;
    const replies = [];
    const finish = (err, val) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* ignore */ }
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('redis timeout')), 8000);
    sock.on('error', (e) => finish(e));
    const send = () => sock.write(Buffer.concat(all.map(respEncode)));
    sock.on(useTls ? 'secureConnect' : 'connect', send);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let off = 0;
      for (;;) {
        const r = respDecode(buf, off);
        if (!r) break;
        off = r.next; replies.push(r.value);
        if (replies.length >= all.length) {
          for (const rep of replies) if (rep instanceof Error) return finish(rep);
          return finish(null, replies[replies.length - 1]);
        }
      }
      buf = buf.subarray(off);
    });
  });
}

// --- API de stockage unifiee -------------------------------------------------
async function storeSet(key, value) {
  if (STORE_BACKEND === 'redis') return redisExec(REDIS_URL, [['SET', key, value]]);
  return upstashRest(['SET', key, value]);
}
async function storeGet(key) {
  if (STORE_BACKEND === 'redis') return redisExec(REDIS_URL, [['GET', key]]);
  return upstashRest(['GET', key]);
}

// Sauvegarde debouncee de TOUS les canaux dans une seule cle.
let storeTimer = null;
function upstashSave() { // nom conserve : appele depuis persist()
  if (!STORE_ON || storeTimer) return;
  storeTimer = setTimeout(async () => {
    storeTimer = null;
    try {
      const all = {};
      for (const [name, ch] of channels) all[name] = serializeChannel(ch);
      await storeSet(STORE_KEY, JSON.stringify(all));
    } catch (e) { console.error('persistance externe (save):', e.message); }
  }, 2000);
}

async function upstashLoad() { // nom conserve : appele au demarrage
  if (!STORE_ON) return;
  try {
    const raw = await storeGet(STORE_KEY);
    if (!raw) { console.error(`Persistance ${STORE_BACKEND} : aucun etat sauvegarde (premier demarrage).`); return; }
    const all = JSON.parse(raw);
    for (const [name, d] of Object.entries(all)) {
      const ch = newChannel(sanitizeName(name));
      deserializeInto(ch, d);
      channels.set(ch.name, ch);
    }
    console.error(`Etat restaure depuis ${STORE_BACKEND} : ${channels.size} canal/canaux.`);
  } catch (e) { console.error('persistance externe (load):', e.message); }
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
      deserializeInto(ch, d);
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

// Envoi d'un message direct/broadcast — partagé entre l'API HTTP et le MCP.
function sendChannelMessage(ch, from, payload) {
  const kind = ['message', 'question', 'status_request', 'diff_request', 'alert', 'task', 'notify']
    .includes(payload.kind) ? payload.kind : 'message';
  if (!payload.to || !payload.body) return { error: 'Paramètres requis : to, body.', status: 400 };
  let targets;
  if (payload.to === '*' || payload.to === 'all') {
    targets = Object.keys(ch.sessions).filter((n) => n !== from);
    if (!targets.length) return { error: 'Aucun pair connecté pour le broadcast.', status: 409 };
  } else {
    const t = sanitizeName(payload.to);
    if (!ch.sessions[t]) {
      const known = Object.keys(ch.sessions).join(', ') || '(aucune session)';
      return { error: `Pair inconnu : "${payload.to}". Sessions enregistrées : ${known}`, status: 404 };
    }
    targets = [t];
  }
  const msg = {
    id: newId(), from, kind,
    subject: String(payload.subject || '').slice(0, 300),
    body: String(payload.body).slice(0, LIMITS.msgBodyChars),
    reply_to: payload.reply_to ? String(payload.reply_to).slice(0, 16) : null,
    ts: nowISO(),
  };
  for (const t of targets) deliver(ch, t, { ...msg, to: t });
  bump(ch);
  return { id: msg.id, kind: msg.kind, targets };
}

// Requête de service (diff/fichier auto-répondus par le pair) — la réponse
// est livrée via un callback : utilisable par l'API HTTP comme par le MCP.
function requestService(ch, from, target, action, params, deliverResult) {
  const t = sanitizeName(target);
  if (!ch.sessions[t]) { deliverResult({ ok: false, error: `Pair inconnu : "${target}".` }); return; }
  const request = {
    id: newId(), from: sanitizeName(from),
    action: String(action || '').slice(0, 32),
    params: params || {}, ts: nowISO(),
  };
  const timer = setTimeout(() => {
    ch.pendingService.delete(request.id);
    const offline = !ch.servicePollers.has(t);
    deliverResult({
      ok: false,
      error: offline
        ? `${t} ne répond pas (sa session semble déconnectée du relais).`
        : `${t} n'a pas répondu dans les ${LIMITS.serviceTimeoutMs / 1000}s.`,
    });
  }, LIMITS.serviceTimeoutMs);
  ch.pendingService.set(request.id, { deliver: deliverResult, timer });

  const poller = ch.servicePollers.get(t);
  if (poller) {
    ch.servicePollers.delete(t);
    clearTimeout(poller.timer);
    json(poller.res, 200, { request });
  } else {
    const queue = ch.serviceQueues.get(t) || [];
    if (queue.length >= LIMITS.serviceQueue) {
      clearTimeout(timer);
      ch.pendingService.delete(request.id);
      deliverResult({ ok: false, error: `File de service de ${t} pleine.` });
      return;
    }
    queue.push(request);
    ch.serviceQueues.set(t, queue);
  }
}

// Lecture de boîte (avec attente optionnelle) — partagée HTTP/MCP.
function readInboxNow(ch, name, consume) {
  const box = ch.inboxes[name] || [];
  if (!box.length) return null;
  const msgs = box.slice();
  if (consume) { ch.inboxes[name] = []; persist(ch); }
  return msgs;
}

function waitInboxPromise(ch, name, consume, waitMs) {
  return new Promise((resolve) => {
    const first = readInboxNow(ch, name, consume);
    if (first || !waitMs) return resolve(first || []);
    addWaiter(ch, () => {
      const msgs = readInboxNow(ch, name, consume);
      if (msgs) { resolve(msgs); return true; }
      return false;
    }, waitMs, () => resolve([]));
  });
}

// ---------------------------------------------------------------------------
// MCP distant (Streamable HTTP) — pour le connecteur claude.ai et tout client
// MCP HTTP. Le canal claude-comm devient joignable par un Claude web/mobile,
// qui y participe comme n'importe quelle session.
// URL : /mcp/<jeton>[/<canal>[/<nom>]] — le jeton vit dans l'URL car les
// connecteurs ne permettent pas d'en-têtes personnalisés.
// ---------------------------------------------------------------------------

const MCP_TOOLS = [
  { name: 'comm_join',
    description: "Rejoindre le canal de coordination claude-comm : annonce ton rôle et ta mission aux autres sessions Claude.",
    inputSchema: { type: 'object', properties: {
      role: { type: 'string', description: 'Ton rôle (ex: « assistant mobile »)' },
      task: { type: 'string', description: 'Ce sur quoi tu démarres' } } } },
  { name: 'comm_peers',
    description: 'Lister les sessions Claude du canal et leur état live.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'comm_send',
    description: "Envoyer un message à une session (ou à toutes avec to='*'). kinds : message, question, status_request, diff_request, alert. reply_to=<id> pour répondre.",
    inputSchema: { type: 'object', properties: {
      to: { type: 'string' }, body: { type: 'string' },
      kind: { type: 'string', enum: ['message', 'question', 'status_request', 'diff_request', 'alert'] },
      subject: { type: 'string' }, reply_to: { type: 'string' } },
      required: ['to', 'body'] } },
  { name: 'comm_inbox',
    description: 'Relever tes messages. wait_seconds (max 20) attend l\'arrivée d\'un message.',
    inputSchema: { type: 'object', properties: {
      wait_seconds: { type: 'number', description: '0-20' } } } },
  { name: 'comm_status_set',
    description: 'Publier ton état live (working/blocked/done/idle/reviewing), tâche et progression.',
    inputSchema: { type: 'object', properties: {
      state: { type: 'string', enum: ['idle', 'working', 'blocked', 'done', 'reviewing'] },
      task: { type: 'string' }, detail: { type: 'string' }, progress: { type: 'string' } },
      required: ['state'] } },
  { name: 'comm_status_get',
    description: "Consulter l'état publié d'un pair (peer omis = tous).",
    inputSchema: { type: 'object', properties: { peer: { type: 'string' } } } },
  { name: 'comm_overview',
    description: "Vue d'ensemble du canal : cap, jalons, tâches, sessions, revues, verrous.",
    inputSchema: { type: 'object', properties: {} } },
  { name: 'comm_task',
    description: 'Tableau de tâches partagé : add (milestone/deps), list, next (claim atomique), claim, assign, update, done, release.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['add', 'list', 'next', 'claim', 'assign', 'update', 'done', 'release'] },
      id: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' },
      milestone: { type: 'string' }, deps: { type: 'array', items: { type: 'string' } },
      to: { type: 'string' }, status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] },
      note: { type: 'string' } },
      required: ['action'] } },
  { name: 'comm_plan',
    description: 'Feuille de route partagée : goal (cap), add (jalon), update, done, list.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['goal', 'add', 'update', 'done', 'list'] },
      text: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' },
      detail: { type: 'string' }, status: { type: 'string', enum: ['todo', 'active', 'done', 'dropped'] },
      note: { type: 'string' } },
      required: ['action'] } },
  { name: 'comm_note',
    description: 'Journal partagé de décisions/conventions : add (avec tags), list (filtre tag).',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['add', 'list'] },
      text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
      tag: { type: 'string' }, limit: { type: 'number' } },
      required: ['action'] } },
  { name: 'comm_lock',
    description: "Verrous coopératifs de fichiers (évite d'éditer la même chose) : acquire, release, list.",
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['acquire', 'release', 'list'] },
      paths: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } },
      required: ['action'] } },
  { name: 'comm_user',
    description: "Fil avec l'utilisateur humain (dashboard) : post (lui écrire spontanément), claim (verrou de réponse sur ses messages « à tous »), reply, ask (question avec options), list.",
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['post', 'claim', 'reply', 'ask', 'list'] },
      id: { type: 'string' }, body: { type: 'string' }, text: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } }, context: { type: 'string' } },
      required: ['action'] } },
  { name: 'comm_diff',
    description: "Diff git du worktree d'un pair (répondu automatiquement par sa machine). mode : stat ou full.",
    inputSchema: { type: 'object', properties: {
      peer: { type: 'string' }, mode: { type: 'string', enum: ['stat', 'full'] } },
      required: ['peer'] } },
];

const mcpSession = (s) => {
  const on = Date.now() - Date.parse(s.last_seen || 0) < 90000 ? '🟢' : '⚪';
  return `${on} ${s.name}${s.role ? ` (${s.role})` : ''} [${s.state || 'idle'}]` +
    `${s.task ? ` — ${s.task}` : ''}${s.progress ? ` (${s.progress})` : ''}`;
};
const mcpTask = (t, db) => {
  const icon = { todo: '⬜', in_progress: '🔵', done: '✅', blocked: '🟥' }[t.status] || '⬜';
  let l = `${icon} ${t.id}${t.milestone ? `(${t.milestone})` : ''} ${t.title}${t.owner ? ` →${t.owner}` : ''}`;
  if (t.deps && t.deps.length) {
    const um = db ? unmetDeps(db, t) : [];
    l += ` ⛓${t.deps.map((d) => (um.includes(d) ? `${d}⏳` : `${d}✓`)).join(',')}`;
  }
  return l;
};
const mcpMsg = (m) => `[${m.id}] ${m.from} (${m.kind}${m.subject ? ` · ${m.subject}` : ''}) : ${m.body}`;

async function mcpToolCall(ch, actor, name, a) {
  // heartbeat de l'appelant : il apparaît comme une session du canal
  const prev = ch.sessions[actor] || { joined_at: nowISO(), role: 'claude (connecteur MCP)', state: 'idle' };
  ch.sessions[actor] = { ...prev, name: actor, last_seen: nowISO(), last_model_seen: nowISO() };
  bump(ch);

  switch (name) {
    case 'comm_join': {
      const s = ch.sessions[actor];
      if (a.role) s.role = String(a.role).slice(0, 200);
      if (a.task) { s.task = String(a.task).slice(0, 300); s.state = 'working'; }
      broadcast(ch, actor, 'notify', 'arrivée', `${actor} a rejoint le canal${a.role ? ` (${a.role})` : ''}.`);
      bump(ch);
      const others = Object.values(ch.sessions).filter((x) => x.name !== actor);
      return `✅ Connecté au canal "${ch.name}" en tant que "${actor}".\n` +
        (others.length ? `Pairs :\n${others.map(mcpSession).join('\n')}` : 'Aucun autre pair pour le moment.') +
        `\nPense à relever comm_inbox régulièrement.`;
    }
    case 'comm_peers':
      return Object.values(ch.sessions).map(mcpSession).join('\n') || 'Aucune session.';
    case 'comm_send': {
      const r = sendChannelMessage(ch, actor, a);
      if (r.error) throw new Error(r.error);
      return `📤 ${r.id} envoyé à ${r.targets.join(', ')}.`;
    }
    case 'comm_inbox': {
      const wait = Math.min(Math.max(Number(a.wait_seconds) || 0, 0), 20);
      const msgs = await waitInboxPromise(ch, actor, true, wait * 1000);
      return msgs.length ? `📬 ${msgs.length} message(s) :\n${msgs.map(mcpMsg).join('\n')}` : '📭 Boîte vide.';
    }
    case 'comm_status_set': {
      const s = ch.sessions[actor];
      if (a.state) s.state = a.state;
      for (const k of ['task', 'detail', 'progress']) if (a[k] !== undefined) s[k] = String(a[k]).slice(0, 500);
      if (a.state === 'blocked' || a.state === 'done') {
        broadcast(ch, actor, 'notify', `état : ${a.state}`, `${actor} est ${a.state}${a.task ? ` sur ${a.task}` : ''}.`);
      }
      bump(ch);
      return `✅ État publié : ${a.state}${a.task ? ` — ${a.task}` : ''}`;
    }
    case 'comm_status_get': {
      if (a.peer) {
        const s = ch.sessions[sanitizeName(a.peer)];
        if (!s) throw new Error(`Pair inconnu : "${a.peer}".`);
        return mcpSession(s) + (s.detail ? `\ndétail : ${s.detail}` : '');
      }
      const others = Object.values(ch.sessions).filter((x) => x.name !== actor);
      return others.length ? others.map(mcpSession).join('\n') : 'Aucun pair.';
    }
    case 'comm_overview':
      return `🎯 ${ch.plan.goal || '(cap non défini)'}\n${standupDigest(statePayload(ch))}`;
    case 'comm_task': {
      const op = applyTaskAction(ch.tasks, actor, a);
      notifyFromOp(ch, actor, op);
      if (op.changed) bump(ch);
      const r = op.result;
      if (r.type === 'list') {
        return ch.tasks.tasks.length
          ? ch.tasks.tasks.map((t) => mcpTask(t, ch.tasks)).join('\n')
          : 'Tableau vide (action=add pour créer).';
      }
      if (r.type === 'none') return 'Aucune tâche libre.';
      if (r.type === 'done') return `✅ ${r.task.id} terminée.${r.unblocked.length ? ` ⛓ Débloquées : ${r.unblocked.join(', ')}.` : ''} ${r.remaining} restante(s).`;
      return mcpTask(r.task, ch.tasks);
    }
    case 'comm_plan': {
      const op = applyPlanAction(ch.plan, actor, a);
      notifyFromOp(ch, actor, op);
      if (op.changed) bump(ch);
      const r = op.result;
      if (r.type === 'plan') {
        const icon = { todo: '⬜', active: '🔵', done: '✅', dropped: '🚫' };
        return `🎯 ${r.plan.goal || '(cap non défini)'}\n` +
          (r.plan.milestones.map((m) => `${icon[m.status] || '⬜'} ${m.id} ${m.title}`).join('\n') || 'Aucun jalon.');
      }
      if (r.type === 'goal') return `🎯 Cap fixé : ${r.goal}`;
      return `✅ ${r.milestone.id} [${r.milestone.status}] ${r.milestone.title}`;
    }
    case 'comm_note': {
      const op = applyNoteAction(ch.notes, actor, a);
      notifyFromOp(ch, actor, op);
      if (op.changed) bump(ch);
      const r = op.result;
      if (r.type === 'note') return `📝 Note ${r.note.id} ajoutée.`;
      return r.notes.length
        ? r.notes.map((n) => `[${n.by}] ${n.text}`).join('\n')
        : 'Journal vide.';
    }
    case 'comm_lock': {
      const op = applyLockAction(ch.locks, actor, a);
      ch.locks = op.locks;
      notifyFromOp(ch, actor, op);
      if (op.changed) bump(ch);
      const r = op.result;
      if (r.type === 'conflict') return `🟥 Refusé : ${r.conflicts.map((c) => `${c.path} (par ${c.lock.owner})`).join(', ')}`;
      if (r.type === 'acquired') return `🔒 Verrouillé : ${r.paths.join(', ')}`;
      if (r.type === 'released') return r.paths.length ? `🔓 Libéré : ${r.paths.join(', ')}` : 'Rien à libérer.';
      return r.locks.length ? r.locks.map((l) => `🔒 ${l.path} → ${l.owner}`).join('\n') : 'Aucun verrou.';
    }
    case 'comm_user': {
      const op = applyUserAction(ch.user, actor, a);
      notifyFromOp(ch, actor, op);
      if (op.changed) bump(ch);
      const r = op.result;
      if (r.type === 'posted') return `📨 ${r.msg.id} publié dans le fil de l'utilisateur (visible dans son dashboard).`;
      if (r.type === 'claimed_msg') return `✋ Claim sur ${r.msg.id} — rédige puis action=reply.\nMessage : ${r.msg.body}`;
      if (r.type === 'replied') return `📤 Réponse à ${r.msg.id} publiée.`;
      if (r.type === 'question') return `❔ ${r.question.id} posée à l'utilisateur (réponse diffusée à tous).`;
      const msgs = r.msgs.map((m) => `${m.id}${m.from && m.from !== 'user' ? ` (de ${m.from})` : ''} [${m.status}] ${m.body.slice(0, 120)}`).join('\n');
      const qs = r.questions.map((q) => `${q.id} [${q.status}] ${q.text}${q.answer ? ` → ${q.answer}` : ''}`).join('\n');
      return `Fil :\n${msgs || '(vide)'}\nQuestions :\n${qs || '(aucune)'}`;
    }
    case 'comm_diff':
      if (!a.peer) throw new Error('Paramètre requis : peer.');
      return new Promise((resolve) => {
        requestService(ch, actor, a.peer, 'diff', { mode: a.mode || 'stat' },
          (r) => resolve(r.ok ? r.result : `❌ ${r.error}`));
      });
    default:
      throw new Error(`Outil inconnu : ${name}`);
  }
}

async function mcpRpcOne(ch, actor, m) {
  const { id, method, params } = m || {};
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: (params && params.protocolVersion) || '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'claude-comm-relay', version: '1.0.0' },
          instructions:
            `Tu es connecté au canal "${ch.name}" de claude-comm sous le nom "${actor}". ` +
            `D'autres sessions Claude collaborent ici en direct. Commence par comm_join, ` +
            `regarde comm_overview, et relève comm_inbox régulièrement.`,
        },
      };
    }
    if (!isRequest) return null; // notification : pas de réponse
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
    if (method === 'tools/call') {
      try {
        const text = await mcpToolCall(ch, actor, params && params.name, (params && params.arguments) || {});
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
      } catch (e) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `❌ ${e.message}` }], isError: true } };
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Méthode inconnue : ${method}` } };
  } catch (e) {
    return isRequest ? { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } } : null;
  }
}

async function mcpRpc(ch, actor, msg) {
  if (Array.isArray(msg)) {
    const replies = [];
    for (const m of msg) {
      const r = await mcpRpcOne(ch, actor, m);
      if (r) replies.push(r);
    }
    return replies.length ? replies : null;
  }
  return mcpRpcOne(ch, actor, msg);
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
    // persistance : disk (--data), backend externe (redis/upstash), ou aucune
    const persistence = DATA ? 'disk' : STORE_ON ? STORE_BACKEND : 'none';
    // ?store=1 : test REEL d'ecriture+lecture sur le backend externe
    if (u.searchParams.get('store') === '1' && STORE_ON) {
      const marker = `ok-${Date.now()}`;
      try {
        await storeSet('claude-comm:healthcheck', marker);
        const back = await storeGet('claude-comm:healthcheck');
        return json(res, 200, { ok: true, persistence, persistent: true, storeOk: back === marker });
      } catch (e) {
        return json(res, 200, { ok: true, persistence, persistent: false, storeOk: false, storeError: e.message });
      }
    }
    return json(res, 200, { ok: true, persistence, persistent: persistence !== 'none' });
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

  // --- MCP distant : /mcp/<jeton>[/<canal>[/<nom>]] -------------------------
  if (u.pathname === '/mcp' || u.pathname.startsWith('/mcp/')) {
    const segs = u.pathname.split('/').filter(Boolean); // mcp, jeton, canal?, nom?
    if (!tokenOk(`Bearer ${decodeURIComponent(segs[1] || '')}`)) {
      return json(res, 401, { jsonrpc: '2.0', id: null, error: {
        code: -32000,
        message: 'Jeton invalide. URL attendue : /mcp/<jeton>[/<canal>[/<nom>]]',
      } });
    }
    const ch = getChannel(sanitizeName(decodeURIComponent(segs[2] || 'default')));
    const actor = sanitizeName(decodeURIComponent(segs[3] || 'claude-connecteur'));
    if (req.method === 'DELETE') { res.writeHead(200, CORS_HEADERS); return res.end(); }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST, DELETE, OPTIONS', ...CORS_HEADERS });
      return res.end();
    }
    const rpcBody = await readBody(req);
    const reply = await mcpRpc(ch, actor, rpcBody);
    if (reply === null) { res.writeHead(202, CORS_HEADERS); return res.end(); }
    return json(res, 200, reply);
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
  // Journal de diagnostic NATIF (Android) : l'app y pousse ses événements
  // (retour au premier plan, écran noir...) ; lisible à distance via le
  // tunnel — débogage natif sans PC ni ADB.
  if (req.method === 'POST' && u.pathname === '/native-log') {
    const body = await readBody(req);
    NATIVE_LOG.push(`${nowISO()} ${String(body.line || '').slice(0, 500)}`);
    if (NATIVE_LOG.length > 200) NATIVE_LOG.shift();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && u.pathname === '/native-log') {
    return json(res, 200, { lines: NATIVE_LOG });
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
    const r = sendChannelMessage(ch, sanitizeName(body.from), body);
    if (r.error) return json(res, r.status, { error: r.error });
    return json(res, 200, r);
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
    requestService(ch, body.from, rest[1], body.action, body.params,
      (result) => json(res, 200, result));
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
      pending.deliver({ ok: body.ok !== false, result: body.result });
    }
    return json(res, 200, {});
  }

  return json(res, 404, { error: 'Route inconnue.' });
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

loadPersisted();
// Restauration Upstash (async) : avant l'ecoute si possible. Non bloquant si
// Upstash est lent — l'etat sera la dans la foulee.
const upstashReady = upstashLoad();

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
  if (DATA) console.error(`Persistance disque : ${DATA}`);
  if (STORE_ON) {
    console.error(`Persistance externe : ${STORE_BACKEND} activee.`);
    upstashReady.catch(() => {});
  }
  newPairCode();
});
