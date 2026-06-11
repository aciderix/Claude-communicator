#!/usr/bin/env node
/*
 * claude-comm — serveur MCP de coordination entre sessions Claude Code.
 *
 * Chaque session Claude lance sa propre instance de ce serveur (stdio).
 * Deux transports au choix :
 *
 *  - MODE FICHIER (défaut) : hub partagé sur disque (~/.claude-comm/<canal>)
 *    pour des sessions sur la même machine (ou un montage partagé).
 *
 *  - MODE RELAIS (multi-machines) : CLAUDE_COMM_RELAY=<url> et
 *    CLAUDE_COMM_TOKEN=<secret> pointent vers relay.js. Les requêtes de
 *    service (diff, fichier) sont auto-répondues par l'instance du pair,
 *    sans déranger son modèle.
 *
 * Capacités : messagerie directe/broadcast, état live, diff git du pair,
 * lecture de fichier du pair, tableau de tâches partagé (claim atomique),
 * verrous coopératifs, journal de décisions, attentes bloquantes.
 *
 * Zéro dépendance externe. Node >= 18.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const {
  sanitizeName, nowISO, newId, normalizePath, pathsOverlap,
  emptyTasks, applyTaskAction, applyLockAction, applyNoteAction, unmetDeps,
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

const HUB = path.resolve(
  ARGS.hub || process.env.CLAUDE_COMM_HUB || path.join(os.homedir(), '.claude-comm')
);
const CHANNEL = sanitizeName(ARGS.channel || process.env.CLAUDE_COMM_CHANNEL || 'default');
const NAME_PROVIDED = !!(ARGS.name || process.env.CLAUDE_COMM_NAME);
const NAME = sanitizeName(
  ARGS.name || process.env.CLAUDE_COMM_NAME || `claude-${crypto.randomBytes(2).toString('hex')}`
);
const ROLE = ARGS.role || process.env.CLAUDE_COMM_ROLE || '';
const RELAY_URL = String(ARGS.relay || process.env.CLAUDE_COMM_RELAY || '').replace(/\/+$/, '');
const TOKEN = ARGS.token || process.env.CLAUDE_COMM_TOKEN || '';
const MODE = RELAY_URL ? 'relay' : 'file';
const CWD = process.cwd();
const HOSTNAME = os.hostname();

const CHAN_DIR = path.join(HUB, CHANNEL);
const SESSIONS_DIR = path.join(CHAN_DIR, 'sessions');
const INBOX_DIR = path.join(CHAN_DIR, 'inbox');
const TASKS_FILE = path.join(CHAN_DIR, 'tasks.json');
const LOCKS_FILE = path.join(CHAN_DIR, 'locks.json');
const NOTES_FILE = path.join(CHAN_DIR, 'notes.json');
const PLAN_FILE = path.join(CHAN_DIR, 'plan.json');
const REVIEWS_FILE = path.join(CHAN_DIR, 'reviews.json');
const USER_FILE = path.join(CHAN_DIR, 'user.json');
const CONFIG_FILE = path.join(CHAN_DIR, 'config.json');
const STATE_LOCK = path.join(CHAN_DIR, 'state.lock');

const OFFLINE_AFTER_MS = 15 * 60 * 1000;
const MAX_DIFF_CHARS = 30000;
const MAX_FILE_BYTES = 100 * 1024;
const MAX_WAIT_S = 300;

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJSONAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function ago(iso) {
  const ms = Date.now() - Date.parse(iso || 0);
  if (!isFinite(ms)) return '?';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `il y a ${s}s`;
  if (s < 3600) return `il y a ${Math.round(s / 60)}min`;
  return `il y a ${(s / 3600).toFixed(1)}h`;
}

function truncate(text, max = MAX_DIFF_CHARS) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... [tronqué : ${text.length - max} caractères omis]`;
}

let gitCache = { at: 0, info: { branch: null, head: null } };
function gitInfo() {
  if (Date.now() - gitCache.at < 10000) return gitCache.info;
  const run = (args) => {
    try {
      return execFileSync('git', ['-C', CWD, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
      }).trim();
    } catch { return null; }
  };
  gitCache = {
    at: Date.now(),
    info: { branch: run(['rev-parse', '--abbrev-ref', 'HEAD']), head: run(['rev-parse', '--short', 'HEAD']) },
  };
  return gitCache.info;
}

// ---------------------------------------------------------------------------
// Diff / fichier locaux (utilisés en direct et comme services auto-répondus)
// ---------------------------------------------------------------------------

function gitRun(cwd, args) {
  try {
    return {
      ok: true,
      out: execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000, maxBuffer: 16 * 1024 * 1024,
      }),
    };
  } catch (e) {
    return { ok: false, out: (e.stderr || e.message || 'erreur git').toString() };
  }
}

function localDiff(cwd, label, mode, pathFilter) {
  if (!cwd || !fs.existsSync(cwd)) {
    return `Le répertoire de ${label} (${cwd}) n'est pas accessible.`;
  }
  const filter = pathFilter ? ['--', String(pathFilter)] : [];
  const parts = [];
  const status = gitRun(cwd, ['status', '-sb']);
  parts.push(`# ${label} — ${cwd}`);
  parts.push(`## git status -sb\n${status.out.trim() || '(propre)'}`);

  const hasHead = gitRun(cwd, ['rev-parse', '--verify', 'HEAD']).ok;
  const base = hasHead ? ['HEAD'] : [];

  if (mode === 'stat' || mode === 'files') {
    const flag = mode === 'stat' ? '--stat' : '--name-status';
    const d = gitRun(cwd, ['diff', flag, ...base, ...filter]);
    parts.push(`## git diff ${flag}\n${d.out.trim() || '(aucune modification suivie)'}`);
  } else {
    const d = gitRun(cwd, ['diff', ...base, ...filter]);
    parts.push(`## git diff${hasHead ? ' HEAD' : ''}\n${d.out.trim() || '(aucune modification suivie)'}`);
  }
  const untracked = gitRun(cwd, ['ls-files', '--others', '--exclude-standard']);
  if (untracked.ok && untracked.out.trim()) {
    parts.push(`## fichiers non suivis\n${untracked.out.trim()}`);
  }
  return truncate(parts.join('\n\n'));
}

function localFile(cwd, rel) {
  if (!rel) throw new Error('Paramètre requis : path.');
  const abs = path.resolve(cwd, String(rel));
  if (abs !== cwd && !abs.startsWith(cwd + path.sep)) {
    throw new Error('Chemin refusé : en dehors du répertoire de travail du pair.');
  }
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error(`Fichier introuvable : ${rel}`); }
  if (st.isDirectory()) {
    const entries = listDir(abs).slice(0, 200);
    return `# ${rel}/ (dossier, ${entries.length} entrées)\n${entries.join('\n')}`;
  }
  const size = st.size;
  const fd = fs.openSync(abs, 'r');
  let buf;
  try {
    buf = Buffer.alloc(Math.min(size, MAX_FILE_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
  } finally { fs.closeSync(fd); }
  if (buf.includes(0)) return `# ${rel} (${size} octets) — fichier binaire, contenu non transmis.`;
  const note = size > MAX_FILE_BYTES ? `\n... [tronqué : fichier de ${size} octets, ${MAX_FILE_BYTES} transmis]` : '';
  return `# ${rel} (${size} octets)\n${buf.toString('utf8')}${note}`;
}

// Services auto-répondus par cette instance quand un pair les demande
// (sans intervention du modèle de cette session).
const SERVICES = {
  ping: async () => `pong de ${NAME}@${HOSTNAME} (${nowISO()})`,
  diff: async (p) => localDiff(CWD, NAME, (p && p.mode) || 'stat', p && p.path),
  file: async (p) => localFile(CWD, p && p.path),
};

// ---------------------------------------------------------------------------
// Backend FICHIER (même machine / montage partagé)
// ---------------------------------------------------------------------------

function sessionFile(name) { return path.join(SESSIONS_DIR, `${name}.json`); }
function inboxNewDir(name) { return path.join(INBOX_DIR, name, 'new'); }
function inboxReadDir(name) { return path.join(INBOX_DIR, name, 'read'); }

async function withStateLock(fn) {
  for (let i = 0; i < 100; i++) {
    try { fs.mkdirSync(STATE_LOCK); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(STATE_LOCK);
        if (Date.now() - st.mtimeMs > 30000) { fs.rmdirSync(STATE_LOCK); continue; }
      } catch { /* disparu entre-temps */ }
      if (i === 99) throw new Error("Impossible d'obtenir le verrou d'état du canal.");
      await sleep(25);
    }
  }
  try { return await fn(); }
  finally { try { fs.rmdirSync(STATE_LOCK); } catch { /* ignore */ } }
}

function fileListSessions() {
  return listDir(SESSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJSON(path.join(SESSIONS_DIR, f), null))
    .filter(Boolean)
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function fileDeliver(to, msg) {
  const dir = inboxNewDir(to);
  ensureDir(dir);
  writeJSONAtomic(path.join(dir, `${Date.now()}-${msg.id}.json`), msg);
}

function fileNotify(op) {
  if (!op || !op.notify) return;
  for (const s of fileListSessions()) {
    if (s.name === NAME) continue;
    fileDeliver(s.name, {
      id: newId(), from: NAME, to: s.name, kind: 'notify',
      subject: op.notify.subject, body: op.notify.body, reply_to: null, ts: nowISO(),
    });
  }
}

function fileReadInbox(consume) {
  const dir = inboxNewDir(NAME);
  const files = listDir(dir).sort();
  const msgs = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const m = readJSON(full, null);
    if (m) msgs.push(m);
    if (consume) {
      ensureDir(inboxReadDir(NAME));
      try { fs.renameSync(full, path.join(inboxReadDir(NAME), f)); } catch { /* ignore */ }
    }
  }
  return msgs;
}

function stripVolatile(s) {
  const { last_seen, live, last_model_seen, ...rest } = s || {};
  return rest;
}

function fileSnapshot() {
  const sessions = fileListSessions();
  const tasks = readJSON(TASKS_FILE, emptyTasks());
  const locks = readJSON(LOCKS_FILE, []);
  const plan = readJSON(PLAN_FILE, emptyPlan());
  const reviews = readJSON(REVIEWS_FILE, emptyReviews());
  const user = readJSON(USER_FILE, emptyUser());
  const stable = JSON.stringify({ s: sessions.map(stripVolatile), t: tasks, l: locks, p: plan, r: reviews, u: user });
  return {
    version: crypto.createHash('sha1').update(stable).digest('hex'),
    sessions, tasks, locks, plan, reviews, user,
    inbox_counts: Object.fromEntries(sessions.map((s) => [s.name, listDir(inboxNewDir(s.name)).length])),
  };
}

// Standup périodique en mode fichier : généré en s'adossant aux appels
// d'outils (pas de démon), diffusé seulement si l'état a changé.
async function maybeFileStandup() {
  const cfg = readJSON(CONFIG_FILE, emptyConfig());
  if (!cfg.standup_minutes) return;
  if (Date.now() - (Date.parse(cfg.last_standup_at || 0) || 0) < cfg.standup_minutes * 60000) return;
  await withStateLock(async () => {
    const c = readJSON(CONFIG_FILE, emptyConfig());
    if (Date.now() - (Date.parse(c.last_standup_at || 0) || 0) < c.standup_minutes * 60000) return;
    c.last_standup_at = nowISO();
    const digest = standupDigest(fileSnapshot());
    const hash = crypto.createHash('sha1').update(digest).digest('hex');
    if (hash !== c.last_standup_hash) {
      c.last_standup_hash = hash;
      for (const s of fileListSessions()) {
        fileDeliver(s.name, {
          id: newId(), from: 'standup', to: s.name, kind: 'notify',
          subject: '🗞 standup périodique', body: digest, reply_to: null, ts: nowISO(),
        });
      }
    }
    writeJSONAtomic(CONFIG_FILE, c);
  });
}

const fileApi = {
  mode: 'file',

  async heartbeat(patch = {}) {
    const prev = readJSON(sessionFile(NAME), {});
    const git = gitInfo();
    const session = {
      state: 'idle', role: ROLE, task: '', detail: '', progress: '',
      ...prev, ...patch,
      name: NAME, pid: process.pid, cwd: CWD, host: HOSTNAME,
      branch: git.branch, head: git.head,
      last_model_seen: nowISO(),
      last_seen: nowISO(), joined_at: prev.joined_at || nowISO(),
    };
    writeJSONAtomic(sessionFile(NAME), session);
    try { await maybeFileStandup(); } catch { /* best effort */ }
    return session;
  },

  async sessions() { return fileListSessions(); },

  async session(name) { return readJSON(sessionFile(sanitizeName(name)), null); },

  async send({ to, kind = 'message', subject = '', body, reply_to = null }) {
    const sessions = fileListSessions();
    let targets;
    if (to === '*' || to === 'all') {
      targets = sessions.map((s) => s.name).filter((n) => n !== NAME);
      if (!targets.length) throw new Error('Aucun pair connecté pour le broadcast.');
    } else {
      const t = sanitizeName(to);
      if (!sessions.some((s) => s.name === t)) {
        const known = sessions.map((s) => s.name).join(', ') || '(aucune session)';
        throw new Error(`Pair inconnu : "${to}". Sessions enregistrées : ${known}`);
      }
      targets = [t];
    }
    const msg = { id: newId(), from: NAME, kind, subject, body, reply_to, ts: nowISO() };
    for (const t of targets) fileDeliver(t, { ...msg, to: t });
    return { id: msg.id, kind, targets };
  },

  async inboxCount() { return listDir(inboxNewDir(NAME)).length; },

  async inboxRead({ consume = true, waitSeconds = 0 } = {}) {
    const deadline = Date.now() + waitSeconds * 1000;
    let msgs = fileReadInbox(consume);
    while (!msgs.length && Date.now() < deadline) {
      await sleep(1000);
      await this.heartbeat();
      msgs = fileReadInbox(consume);
    }
    return msgs;
  },

  async taskOp(a) {
    return withStateLock(async () => {
      const db = readJSON(TASKS_FILE, emptyTasks());
      const op = applyTaskAction(db, NAME, a);
      if (op.changed) writeJSONAtomic(TASKS_FILE, db);
      fileNotify(op);
      return op.result;
    });
  },

  async lockOp(a) {
    return withStateLock(async () => {
      const locks = readJSON(LOCKS_FILE, []);
      const op = applyLockAction(locks, NAME, a);
      if (op.changed) writeJSONAtomic(LOCKS_FILE, op.locks);
      fileNotify(op);
      return op.result;
    });
  },

  async noteOp(a) {
    return withStateLock(async () => {
      const notes = readJSON(NOTES_FILE, []);
      const op = applyNoteAction(notes, NAME, a);
      if (op.changed) writeJSONAtomic(NOTES_FILE, notes);
      fileNotify(op);
      return op.result;
    });
  },

  async planOp(a) {
    return withStateLock(async () => {
      const plan = readJSON(PLAN_FILE, emptyPlan());
      const op = applyPlanAction(plan, NAME, a);
      if (op.changed) writeJSONAtomic(PLAN_FILE, plan);
      fileNotify(op);
      return op.result;
    });
  },

  async reviewOp(a) {
    return withStateLock(async () => {
      const reviews = readJSON(REVIEWS_FILE, emptyReviews());
      const op = applyReviewAction(reviews, NAME, a);
      if (op.changed) writeJSONAtomic(REVIEWS_FILE, reviews);
      fileNotify(op);
      return op.result;
    });
  },

  async userOp(a) {
    return withStateLock(async () => {
      const user = readJSON(USER_FILE, emptyUser());
      const op = applyUserAction(user, NAME, a);
      if (op.changed) writeJSONAtomic(USER_FILE, user);
      fileNotify(op);
      return op.result;
    });
  },

  async snapshot() { return fileSnapshot(); },

  async waitChange(version, seconds) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const snap = fileSnapshot();
      if (snap.version !== version) return snap;
    }
    return null;
  },

  async peerDiff(peer, { mode, path: p }) {
    const s = await this.session(peer);
    if (!s) throw new Error(`Pair inconnu : "${peer}".`);
    if (s.host && s.host !== HOSTNAME) {
      throw new Error(`${s.name} tourne sur une autre machine (${s.host}). Utilise le mode relais (CLAUDE_COMM_RELAY) pour le multi-machines.`);
    }
    return localDiff(s.cwd, `${s.name} (branche ${s.branch || '?'})`, mode, p);
  },

  async peerFile(peer, { path: p }) {
    const s = await this.session(peer);
    if (!s) throw new Error(`Pair inconnu : "${peer}".`);
    if (s.host && s.host !== HOSTNAME) {
      throw new Error(`${s.name} tourne sur une autre machine (${s.host}). Utilise le mode relais (CLAUDE_COMM_RELAY) pour le multi-machines.`);
    }
    return localFile(s.cwd, p);
  },

  startBackground() { /* rien : tout est lisible directement sur disque */ },
};

// ---------------------------------------------------------------------------
// Backend RELAIS (multi-machines, sécurisé)
// ---------------------------------------------------------------------------

async function rfetch(method, p, body, timeoutMs = 35000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(`${RELAY_URL}/c/${CHANNEL}${p}`, {
        method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          // contourne la page interstitielle des tunnels type loca.lt
          'bypass-tunnel-reminder': '1',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } catch (e) {
      throw new Error(`Relais injoignable (${RELAY_URL}) : ${e.cause?.code || e.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Relais : HTTP ${res.status}`);
    return data;
  } finally { clearTimeout(timer); }
}

const relayApi = {
  mode: 'relay',

  async heartbeat(patch = {}) {
    const git = gitInfo();
    const data = await rfetch('POST', `/sessions/${NAME}`, {
      ...patch, cwd: CWD, host: HOSTNAME, pid: process.pid,
      branch: git.branch, head: git.head, last_model_seen: nowISO(),
      ...(patch.role === undefined && ROLE ? { role: ROLE } : {}),
    });
    return data.session;
  },

  async sessions() { return (await rfetch('GET', '/sessions')).sessions; },

  async session(name) {
    const all = await this.sessions();
    return all.find((s) => s.name === sanitizeName(name)) || null;
  },

  async send({ to, kind = 'message', subject = '', body, reply_to = null }) {
    return rfetch('POST', '/messages', { from: NAME, to, kind, subject, body, reply_to });
  },

  async inboxCount() { return (await rfetch('GET', `/inbox/${NAME}/count`)).count; },

  async inboxRead({ consume = true, waitSeconds = 0 } = {}) {
    const deadline = Date.now() + waitSeconds * 1000;
    const consumeQ = consume ? '&consume=1' : '';
    for (;;) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      const wait = Math.max(Math.min(remaining, 25), 0);
      const data = await rfetch('GET', `/inbox/${NAME}?wait=${wait}${consumeQ}`, null, (wait + 15) * 1000);
      if (data.messages.length || Date.now() >= deadline) return data.messages;
    }
  },

  async taskOp(a) { return (await rfetch('POST', '/tasks', { ...a, actor: NAME })).result; },
  async lockOp(a) { return (await rfetch('POST', '/locks', { ...a, actor: NAME })).result; },
  async noteOp(a) { return (await rfetch('POST', '/notes', { ...a, actor: NAME })).result; },
  async planOp(a) { return (await rfetch('POST', '/plan', { ...a, actor: NAME })).result; },
  async reviewOp(a) { return (await rfetch('POST', '/reviews', { ...a, actor: NAME })).result; },
  async userOp(a) { return (await rfetch('POST', '/user-ops', { ...a, actor: NAME })).result; },

  async snapshot() { return rfetch('GET', '/state'); },

  async waitChange(version, seconds) {
    const wait = Math.max(Math.min(seconds, 30), 1);
    const snap = await rfetch('GET', `/state?version=${version}&wait=${wait}`, null, (wait + 15) * 1000);
    return snap.version === version ? null : snap;
  },

  async service(target, action, params) {
    const t = sanitizeName(target);
    const data = await rfetch('POST', `/service/${t}`, { from: NAME, action, params }, 45000);
    if (!data.ok) {
      const detail = typeof data.result === 'string' ? data.result.replace(/^❌\s*/, '') : null;
      throw new Error(data.error || detail || `${t} n'a pas pu répondre.`);
    }
    return data.result;
  },

  async peerDiff(peer, { mode, path: p }) {
    return this.service(peer, 'diff', { mode, path: p });
  },

  async peerFile(peer, { path: p }) {
    return this.service(peer, 'file', { path: p });
  },

  // Boucle de service : répond automatiquement aux demandes de diff/fichier
  // des pairs, sans intervention du modèle de cette session.
  startBackground() {
    if (this._loop) return;
    this._loop = (async () => {
      for (;;) {
        try {
          const data = await rfetch('GET', `/service-poll/${NAME}?wait=25`, null, 40000);
          if (data && data.request) {
            const { id, action, params } = data.request;
            let ok = true, result;
            try {
              const fn = SERVICES[action];
              if (!fn) throw new Error(`Service inconnu : ${action}`);
              result = await fn(params || {});
            } catch (e) { ok = false; result = `❌ ${e.message}`; }
            await rfetch('POST', '/service-reply', { id, ok, result });
          }
        } catch { await sleep(3000); }
      }
    })();
  },
};

const api = MODE === 'relay' ? relayApi : fileApi;

// ---------------------------------------------------------------------------
// Mise en forme
// ---------------------------------------------------------------------------

function isOnline(s) {
  if (typeof s.live === 'boolean') return s.live;
  return Date.now() - Date.parse(s.last_seen || 0) < OFFLINE_AFTER_MS;
}

const MODEL_SILENT_MS = 10 * 60 * 1000;

function modelSilent(s) {
  if (!isOnline(s) || ['done', 'offline'].includes(s.state)) return false;
  const ms = s.last_model_seen ? Date.now() - Date.parse(s.last_model_seen) : null;
  return ms !== null && ms > MODEL_SILENT_MS;
}

function describeSession(s, verbose = false) {
  const silent = modelSilent(s);
  const dot = !isOnline(s) ? '⚪' : silent ? '🟡' : '🟢';
  const lines = [
    `${dot} ${s.name}${s.name === NAME ? ' (moi)' : ''}` +
      `${s.role ? ` — ${s.role}` : ''} [${s.state || 'idle'}] (vu ${ago(s.last_seen)})`,
  ];
  if (s.task) lines.push(`   tâche : ${s.task}${s.progress ? ` (${s.progress})` : ''}`);
  if (s.detail) lines.push(`   détail : ${s.detail}`);
  if (silent) {
    lines.push(`   🟡 modèle inactif depuis ${ago(s.last_model_seen).replace('il y a ', '')} alors que sa session est connectée` +
      ` — probablement hors d'usage (limite 5 h/hebdo atteinte ?) ou en attente d'input humain.` +
      ` Ne compte pas sur une réponse rapide : avance sans lui ou réassigne ses tâches si ça dure.`);
  }
  if (s.compacting) {
    lines.push('   ♻️ compaction de son contexte en cours — il risque de perdre des détails récents.');
  } else if (s.compacted_at && Date.now() - Date.parse(s.compacted_at) < 30 * 60 * 1000) {
    lines.push(`   ♻️ contexte compacté ${ago(s.compacted_at)} — re-précise-lui les points critiques si nécessaire.`);
  }
  if (verbose) {
    lines.push(`   machine : ${s.host || '?'} | cwd : ${s.cwd}`);
    lines.push(`   branche : ${s.branch || '?'} @ ${s.head || '?'}`);
    lines.push(`   rejoint : ${s.joined_at} | pid ${s.pid}`);
  }
  return lines.join('\n');
}

function formatMessage(m) {
  const kindIcon = {
    message: '💬', question: '❓', status_request: '📊', diff_request: '🔀',
    notify: '🔔', alert: '🚨', task: '📋',
  }[m.kind] || '💬';
  const head = `${kindIcon} [${m.id}] de ${m.from} (${ago(m.ts)})` +
    `${m.kind !== 'message' ? ` · type=${m.kind}` : ''}` +
    `${m.reply_to ? ` · réponse à ${m.reply_to}` : ''}` +
    `${m.subject ? `\n   objet : ${m.subject}` : ''}`;
  return `${head}\n${String(m.body).split('\n').map((l) => '   ' + l).join('\n')}`;
}

function formatTask(t, db = null) {
  const icon = { todo: '⬜', in_progress: '🔵', done: '✅', blocked: '🟥' }[t.status] || '⬜';
  let line = `${icon} ${t.id}${t.milestone ? ` (${t.milestone})` : ''} [${t.status}] ${t.title}`;
  if (t.owner) line += ` — pris par ${t.owner}`;
  if (t.deps && t.deps.length) {
    const unmet = db ? unmetDeps(db, t) : [];
    line += `\n     ⛓ dépend de : ${t.deps.map((d) => db ? `${d}${unmet.includes(d) ? '⏳' : '✓'}` : d).join(', ')}`;
  }
  if (t.detail) line += `\n     ${t.detail}`;
  if (t.notes && t.notes.length) {
    line += '\n' + t.notes.slice(-3).map((n) => `     · ${n}`).join('\n');
  }
  return line;
}

function formatBoard(tasks) {
  if (!tasks.length) return 'Tableau vide. Ajoute des tâches avec comm_task action=add.';
  const db = { tasks };
  const open = tasks.filter((t) => t.status !== 'done');
  const done = tasks.filter((t) => t.status === 'done');
  let out = `📋 Tableau de tâches (canal "${CHANNEL}") :\n\n` +
    (open.length ? open.map((t) => formatTask(t, db)).join('\n') : '(aucune tâche ouverte)');
  if (done.length) out += `\n\nTerminées :\n${done.map((t) => formatTask(t, db)).join('\n')}`;
  return out;
}

function formatMilestone(m, tasks = []) {
  const icon = { todo: '⬜', active: '🔵', done: '✅', dropped: '🚫' }[m.status] || '⬜';
  const linked = tasks.filter((t) => t.milestone === m.id);
  const doneCount = linked.filter((t) => t.status === 'done').length;
  let line = `${icon} ${m.id} [${m.status}] ${m.title}`;
  if (linked.length) line += ` — ${doneCount}/${linked.length} tâche(s) faite(s)`;
  if (m.detail) line += `\n     ${m.detail}`;
  if (m.notes && m.notes.length) {
    line += '\n' + m.notes.slice(-2).map((n) => `     · ${n}`).join('\n');
  }
  return line;
}

function formatPlan(plan, tasks = []) {
  const lines = [plan.goal
    ? `🎯 Cap : ${plan.goal}`
    : '🎯 Cap : (non défini — fixe-le avec comm_plan action=goal)'];
  if (!plan.milestones.length) {
    lines.push('\nAucun jalon. Construis la feuille de route avec comm_plan action=add.');
    return lines.join('\n');
  }
  lines.push('');
  for (const m of plan.milestones) lines.push(formatMilestone(m, tasks));
  const doneM = plan.milestones.filter((m) => m.status === 'done').length;
  const active = plan.milestones.filter((m) => m.status !== 'done' && m.status !== 'dropped').length;
  lines.push(`\nProgression : ${doneM}/${plan.milestones.length} jalon(s) terminé(s), ${active} en cours ou à faire.`);
  return lines.join('\n');
}

function formatReview(r) {
  const icon = { pending: '🟡', approved: '✅', changes_requested: '🟠', closed: '⚪' }[r.status] || '🟡';
  let line = `${icon} ${r.id} [${r.status}] ${r.title || '(sans titre)'} — ${r.from} → relu par ${r.to} (${ago(r.updated_at)})`;
  if (r.note) line += `\n     ${r.note}`;
  if (r.events && r.events.length) {
    line += '\n' + r.events.slice(-3).map((e) => `     · ${e}`).join('\n');
  }
  return line;
}

async function inboxFooter() {
  try {
    const n = await api.inboxCount();
    return n > 0
      ? `\n\n📬 ${n} message(s) non lu(s) dans ta boîte — appelle comm_inbox pour les lire.`
      : '';
  } catch { return ''; }
}

async function notifyPeers(subject, body) {
  try { await api.send({ to: '*', kind: 'notify', subject, body }); }
  catch { /* aucun pair : pas grave */ }
}

// ---------------------------------------------------------------------------
// Définition des outils MCP
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'comm_join',
    description:
      "Rejoindre (ou mettre à jour) le canal de coordination. À appeler en début de session pour annoncer ton nom, ton rôle et ta mission. Les autres sessions te verront via comm_peers.",
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: "Ton rôle dans l'équipe (ex: 'frontend', 'tests', 'refactor API')" },
        task: { type: 'string', description: 'La tâche sur laquelle tu démarres' },
        announce: { type: 'boolean', description: 'Notifier les autres sessions de ton arrivée (défaut: true)' },
      },
    },
  },
  {
    name: 'comm_peers',
    description:
      'Lister toutes les sessions Claude du canal avec leur état live : statut, tâche en cours, progression, machine, branche git, dernière activité.',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Inclure machine, cwd, branche, pid (défaut: false)' },
      },
    },
  },
  {
    name: 'comm_send',
    description:
      "Envoyer un message direct à une autre session Claude (ou à toutes avec to='*'). Types : message (info), question (attend une réponse), status_request (demande son état), diff_request (demande son diff), alert (urgent), task (coordination de tâches). Pour répondre à un message reçu, passe reply_to=<id du message>.",
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: "Nom du destinataire, ou '*' pour broadcast" },
        body: { type: 'string', description: 'Contenu du message' },
        kind: {
          type: 'string',
          enum: ['message', 'question', 'status_request', 'diff_request', 'alert', 'task'],
          description: 'Type de message (défaut: message)',
        },
        subject: { type: 'string', description: 'Objet court (optionnel)' },
        reply_to: { type: 'string', description: "Id du message auquel tu réponds (optionnel)" },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'comm_inbox',
    description:
      "Lire les messages reçus des autres sessions. Avec wait_seconds > 0, attend l'arrivée d'un message (bloquant) — utile pour se synchroniser en direct. Réponds aux questions/status_request/diff_request reçus via comm_send avec reply_to.",
    inputSchema: {
      type: 'object',
      properties: {
        wait_seconds: { type: 'number', description: `Attendre jusqu'à N secondes si la boîte est vide (0-${MAX_WAIT_S}, défaut: 0)` },
        peek: { type: 'boolean', description: 'Lire sans marquer comme lu (défaut: false)' },
      },
    },
  },
  {
    name: 'comm_status_set',
    description:
      "Publier ton état live, visible instantanément par les autres sessions. À faire à chaque changement significatif : début/fin de tâche, blocage, progression. state=blocked ou done notifie automatiquement les pairs.",
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['idle', 'working', 'blocked', 'done', 'reviewing'], description: 'Ton état' },
        task: { type: 'string', description: 'Tâche en cours' },
        detail: { type: 'string', description: 'Détail libre (fichiers touchés, prochaine étape...)' },
        progress: { type: 'string', description: "Progression (ex: '3/5 fichiers', '80%')" },
        notify: { type: 'boolean', description: 'Forcer une notification aux pairs (défaut: auto)' },
      },
      required: ['state'],
    },
  },
  {
    name: 'comm_status_get',
    description:
      "Consulter instantanément l'état publié d'un pair (sans le déranger). Pour lui demander activement un compte-rendu, utilise plutôt comm_send kind=status_request.",
    inputSchema: {
      type: 'object',
      properties: {
        peer: { type: 'string', description: 'Nom du pair (omis = tous les pairs)' },
      },
    },
  },
  {
    name: 'comm_diff',
    description:
      "Obtenir le diff git en direct du worktree d'un pair, sans le déranger : status, modifications, fichiers non suivis. Fonctionne aussi entre machines (mode relais : son instance répond automatiquement). Modes : stat (résumé), files (liste), full (diff complet).",
    inputSchema: {
      type: 'object',
      properties: {
        peer: { type: 'string', description: 'Nom du pair dont tu veux le diff' },
        mode: { type: 'string', enum: ['stat', 'files', 'full'], description: 'Niveau de détail (défaut: stat)' },
        path: { type: 'string', description: 'Limiter à un chemin (optionnel)' },
      },
      required: ['peer'],
    },
  },
  {
    name: 'comm_file',
    description:
      "Lire un fichier (ou lister un dossier) du worktree d'un pair, en lecture seule — utile pour voir sa version d'un fichier avant de coordonner une interface commune. Plafonné à 100 Ko, contenu binaire refusé, chemin confiné à son répertoire de travail.",
    inputSchema: {
      type: 'object',
      properties: {
        peer: { type: 'string', description: 'Nom du pair' },
        path: { type: 'string', description: 'Chemin relatif à son répertoire de travail' },
      },
      required: ['peer', 'path'],
    },
  },
  {
    name: 'comm_task',
    description:
      "Tableau de tâches partagé pour paralléliser sans conflit. Actions : add (créer, rattachable à un jalon de la feuille de route via milestone), list, next (prendre atomiquement la prochaine tâche : d'abord celles qui te sont assignées, puis les libres), claim (prendre une tâche précise), assign (confier une tâche à un pair — tout en continuant toi-même à travailler en parallèle), update (statut/note), done (terminer), release (rendre). Les pairs sont notifiés des changements.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'next', 'claim', 'assign', 'update', 'done', 'release'], description: 'Action à effectuer' },
        id: { type: 'string', description: "Id de la tâche (ex: 'T3') pour claim/assign/update/done/release" },
        title: { type: 'string', description: 'Titre (pour add)' },
        detail: { type: 'string', description: 'Description (pour add)' },
        milestone: { type: 'string', description: "Jalon de la feuille de route auquel rattacher la tâche (ex: 'M2', pour add)" },
        deps: { type: 'array', items: { type: 'string' }, description: "Ids des tâches qui doivent être done avant celle-ci (ex: ['T2'], pour add). next/claim les respectent ; done signale les tâches débloquées" },
        to: { type: 'string', description: 'Pair à qui confier la tâche (pour assign)' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'], description: 'Nouveau statut (pour update)' },
        note: { type: 'string', description: 'Note de progression ou résultat' },
      },
      required: ['action'],
    },
  },
  {
    name: 'comm_plan',
    description:
      "Feuille de route partagée du canal : un cap (goal) et des jalons (M1, M2...) que TOUTES les sessions peuvent compléter et faire évoluer. Les tâches s'y rattachent (comm_task add milestone=M2) et la progression est agrégée automatiquement. Actions : goal (fixer/mettre à jour le cap), add (jalon), update (titre/détail/statut/note), done, list.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['goal', 'add', 'update', 'done', 'list'], description: 'Action à effectuer' },
        text: { type: 'string', description: 'Le cap de la mission (pour goal)' },
        id: { type: 'string', description: "Id du jalon (ex: 'M2') pour update/done" },
        title: { type: 'string', description: 'Titre du jalon (pour add/update)' },
        detail: { type: 'string', description: 'Description du jalon' },
        status: { type: 'string', enum: ['todo', 'active', 'done', 'dropped'], description: 'Statut (pour update)' },
        note: { type: 'string', description: 'Note de progression' },
      },
      required: ['action'],
    },
  },
  {
    name: 'comm_review',
    description:
      "Revue croisée avant merge : request demande à un pair de relire ton travail (ton diff stat est joint automatiquement ; le relecteur peut voir le détail avec comm_diff). Le relecteur répond avec approve ou changes (avec note). Le demandeur clôt avec close une fois mergé. list montre les revues du canal. Chaque étape notifie les intéressés.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['request', 'approve', 'changes', 'close', 'list'], description: 'Action à effectuer' },
        to: { type: 'string', description: 'Le pair qui doit relire (pour request)' },
        id: { type: 'string', description: "Id de la revue (ex: 'R1') pour approve/changes/close" },
        title: { type: 'string', description: 'Objet de la revue (pour request)' },
        note: { type: 'string', description: 'Contexte, retours ou justification' },
      },
      required: ['action'],
    },
  },
  {
    name: 'comm_user',
    description:
      "Interactions avec l'utilisateur humain (via son dashboard/CLI). Quand un message utilisateur « à tous » arrive (sujet Ux) : fais action=claim AVANT de rédiger — si un pair a déjà le claim, n'écris RIEN (tu verras sa réponse et pourras la compléter seulement si elle est incorrecte : économie de tokens). action=reply publie ta réponse à l'utilisateur. action=ask lui pose une question (avec options éventuelles) — utile en cas de désaccord entre sessions sur un point clé ; sa réponse est diffusée à tous. action=list montre l'historique.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['claim', 'reply', 'ask', 'list'], description: 'Action à effectuer' },
        id: { type: 'string', description: "Id du message utilisateur (ex: 'U2') pour claim/reply" },
        body: { type: 'string', description: "Ta réponse à l'utilisateur (pour reply)" },
        text: { type: 'string', description: 'La question à poser (pour ask)' },
        options: { type: 'array', items: { type: 'string' }, description: 'Choix proposés en boutons dans le dashboard (pour ask, optionnel)' },
        context: { type: 'string', description: 'Contexte court pour éclairer la décision (pour ask)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'comm_overview',
    description:
      "Vue d'ensemble du canal en un appel : cap et feuille de route (avec progression par jalon), sessions et leur état live, tâches ouvertes, revues en attente, verrous, dernières notes. À consulter en début de session et entre deux tâches pour rester synchronisé.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'comm_lock',
    description:
      "Verrous coopératifs sur fichiers/dossiers pour éviter que deux sessions éditent la même chose. acquire échoue si un pair détient un verrou qui chevauche (un chemin parent ou enfant compte comme conflit). Verrouille AVANT d'éditer des zones partagées, libère dès que c'est fini.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['acquire', 'release', 'list'], description: 'Action' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Chemins relatifs au repo (pour acquire/release ; release sans paths = libérer tous mes verrous)' },
        reason: { type: 'string', description: 'Pourquoi tu verrouilles (visible par les pairs)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'comm_note',
    description:
      "Journal partagé de décisions et conventions de l'équipe (persiste pour toutes les sessions). Note les décisions d'architecture, les interfaces convenues, les pièges découverts. Actions : add (les pairs sont notifiés), list (filtrable par tag).",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list'], description: 'Action' },
        text: { type: 'string', description: 'Contenu de la note (pour add)' },
        tags: { type: 'array', items: { type: 'string' }, description: "Tags (ex: ['api', 'decision'])" },
        tag: { type: 'string', description: 'Filtrer par tag (pour list)' },
        limit: { type: 'number', description: 'Nombre max de notes (pour list, défaut: 20)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'comm_wait',
    description:
      "Attente bloquante d'un événement pour se synchroniser en direct : until=message (un message arrive), peer_status (l'état d'un pair change), tasks (le tableau de tâches change), plan (la feuille de route change), reviews (une revue évolue), locks (des chemins se libèrent). Retourne dès que l'événement survient ou à expiration du timeout.",
    inputSchema: {
      type: 'object',
      properties: {
        until: { type: 'string', enum: ['message', 'peer_status', 'tasks', 'plan', 'reviews', 'locks'], description: 'Événement attendu' },
        peer: { type: 'string', description: 'Pair à surveiller (pour peer_status)' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Chemins à surveiller (pour locks)' },
        timeout_seconds: { type: 'number', description: `Timeout en secondes (défaut: 60, max: ${MAX_WAIT_S})` },
      },
      required: ['until'],
    },
  },
];

// ---------------------------------------------------------------------------
// Implémentation des outils
// ---------------------------------------------------------------------------

const HANDLERS = {
  async comm_join(a = {}) {
    const session = await api.heartbeat({
      ...(a.role !== undefined ? { role: a.role } : {}),
      ...(a.task !== undefined ? { task: a.task } : {}),
      state: a.task ? 'working' : 'idle',
    });
    if (a.announce !== false) {
      await notifyPeers('arrivée',
        `${NAME} a rejoint le canal "${CHANNEL}"${a.role ? ` (rôle : ${a.role})` : ''}${a.task ? ` — démarre : ${a.task}` : ''}.`);
    }
    const others = (await api.sessions()).filter((s) => s.name !== NAME);
    const peersTxt = others.length
      ? `Pairs présents :\n${others.map((s) => describeSession(s)).join('\n')}`
      : 'Aucun autre pair pour le moment. Ils te verront dès leur comm_join.';
    const where = MODE === 'relay' ? `relais ${RELAY_URL}` : `hub ${CHAN_DIR}`;
    return `✅ Connecté au canal "${CHANNEL}" en tant que "${session.name}" (${where}, machine ${HOSTNAME}).\n\n${peersTxt}\n\n` +
      `Pense à publier ton état (comm_status_set) et à relever ta boîte (comm_inbox) régulièrement.`;
  },

  async comm_peers(a = {}) {
    const sessions = await api.sessions();
    if (!sessions.length) return 'Aucune session enregistrée sur ce canal.';
    return sessions.map((s) => describeSession(s, !!a.verbose)).join('\n');
  },

  async comm_send(a) {
    if (!a || !a.to || !a.body) throw new Error('Paramètres requis : to, body.');
    const r = await api.send(a);
    const hint = ['question', 'status_request', 'diff_request'].includes(a.kind)
      ? `\nPour attendre la réponse en direct : comm_inbox avec wait_seconds (ex: 60).`
      : '';
    return `📤 Message ${r.id} (${r.kind || a.kind || 'message'}) envoyé à ${r.targets.join(', ')}.${hint}`;
  },

  async comm_inbox(a = {}) {
    const wait = Math.min(Math.max(Number(a.wait_seconds) || 0, 0), MAX_WAIT_S);
    const msgs = await api.inboxRead({ consume: !a.peek, waitSeconds: wait });
    if (!msgs.length) {
      return wait > 0 ? `⏳ Aucun message après ${wait}s d'attente.` : '📭 Boîte vide.';
    }
    const toAnswer = msgs.filter((m) => ['question', 'status_request', 'diff_request'].includes(m.kind));
    let footer = '';
    if (toAnswer.length) {
      footer = `\n\n⚠️ ${toAnswer.length} message(s) attendent une réponse de ta part :` +
        toAnswer.map((m) => {
          if (m.kind === 'status_request') return `\n- ${m.from} demande ton état → réponds via comm_send (reply_to=${m.id}) avec ton avancement, et mets à jour comm_status_set.`;
          if (m.kind === 'diff_request') return `\n- ${m.from} demande ton diff → il peut aussi le lire via comm_diff ; réponds avec un résumé de tes changements (reply_to=${m.id}).`;
          return `\n- question de ${m.from} → réponds via comm_send (reply_to=${m.id}).`;
        }).join('');
    }
    return `📬 ${msgs.length} message(s) :\n\n${msgs.map(formatMessage).join('\n\n')}${footer}`;
  },

  async comm_status_set(a) {
    if (!a || !a.state) throw new Error('Paramètre requis : state.');
    const patch = { state: a.state };
    if (a.task !== undefined) patch.task = a.task;
    if (a.detail !== undefined) patch.detail = a.detail;
    if (a.progress !== undefined) patch.progress = a.progress;
    await api.heartbeat(patch);
    const shouldNotify = a.notify === true || (a.notify !== false && (a.state === 'blocked' || a.state === 'done'));
    if (shouldNotify) {
      await notifyPeers(`état : ${a.state}`,
        `${NAME} est passé à "${a.state}"${a.task ? ` sur : ${a.task}` : ''}` +
        `${a.progress ? ` (${a.progress})` : ''}${a.detail ? `\n${a.detail}` : ''}`);
    }
    return `✅ État publié : ${a.state}${a.task ? ` — ${a.task}` : ''}${a.progress ? ` (${a.progress})` : ''}` +
      (shouldNotify ? '\n🔔 Les pairs ont été notifiés.' : '');
  },

  async comm_status_get(a = {}) {
    if (a.peer) {
      const s = await api.session(a.peer);
      if (!s) throw new Error(`Pair inconnu : "${a.peer}".`);
      return describeSession(s, true);
    }
    const others = (await api.sessions()).filter((s) => s.name !== NAME);
    if (!others.length) return 'Aucun pair sur ce canal.';
    return others.map((s) => describeSession(s, true)).join('\n\n');
  },

  async comm_diff(a) {
    if (!a || !a.peer) throw new Error('Paramètre requis : peer.');
    return api.peerDiff(a.peer, { mode: a.mode || 'stat', path: a.path });
  },

  async comm_file(a) {
    if (!a || !a.peer || !a.path) throw new Error('Paramètres requis : peer, path.');
    return api.peerFile(a.peer, { path: a.path });
  },

  async comm_task(a) {
    if (!a || !a.action) throw new Error('Paramètre requis : action.');
    const r = await api.taskOp(a);
    switch (r.type) {
      case 'task':
        return `${a.action === 'add' ? '✅ Tâche créée' : '✅ Mise à jour'} :\n${formatTask(r.task)}`;
      case 'list':
        return formatBoard(r.tasks);
      case 'none':
        return 'Aucune tâche libre. Vérifie comm_task action=list ou ajoute des tâches.';
      case 'claimed':
        await api.heartbeat({ state: 'working', task: `${r.task.id}: ${r.task.title}` });
        return `🔵 Tu prends :\n${formatTask(r.task)}`;
      case 'assigned':
        return `📌 ${r.task.id} assignée à ${r.to} (il sera notifié ; son prochain "next" la prendra en priorité) :\n${formatTask(r.task)}`;
      case 'done':
        return `✅ ${r.task.id} terminée.` +
          (r.unblocked && r.unblocked.length ? ` ⛓ Débloquées : ${r.unblocked.join(', ')}.` : '') +
          ` ${r.remaining} tâche(s) restante(s).` +
          (r.remaining ? ' Enchaîne avec comm_task action=next.' : ' 🎉 Tableau vide !');
      case 'released_task':
        return `↩️ ${r.task.id} rendue au tableau.`;
      default:
        return JSON.stringify(r);
    }
  },

  async comm_lock(a) {
    if (!a || !a.action) throw new Error('Paramètre requis : action.');
    const r = await api.lockOp(a);
    switch (r.type) {
      case 'conflict':
        return `🟥 Verrou refusé :\n- ` + r.conflicts
          .map((c) => `"${c.path}" chevauche "${c.lock.path}" verrouillé par ${c.lock.owner} (${ago(c.lock.ts)})${c.lock.reason ? ` — ${c.lock.reason}` : ''}`)
          .join('\n- ') +
          `\n\nOptions : travaille ailleurs, demande au pair quand il libère (comm_send kind=question), ou attends avec comm_wait until=locks.`;
      case 'acquired':
        return `🔒 Verrouillé pour ${NAME} : ${r.paths.join(', ')}${a.reason ? ` (${a.reason})` : ''}\nLibère avec comm_lock action=release dès que tu as fini.`;
      case 'released':
        return r.paths.length ? `🔓 Libéré : ${r.paths.join(', ')}` : 'Aucun verrou à libérer.';
      case 'list':
        if (!r.locks.length) return 'Aucun verrou actif.';
        return '🔒 Verrous actifs :\n' + r.locks
          .map((l) => `- ${l.path} → ${l.owner}${l.owner === NAME ? ' (moi)' : ''} (${ago(l.ts)})${l.reason ? ` — ${l.reason}` : ''}`)
          .join('\n');
      default:
        return JSON.stringify(r);
    }
  },

  async comm_note(a) {
    if (!a || !a.action) throw new Error('Paramètre requis : action.');
    const r = await api.noteOp(a);
    if (r.type === 'note') {
      return `📝 Note ${r.note.id} ajoutée au journal partagé${r.note.tags.length ? ` [${r.note.tags.join(', ')}]` : ''}.\n🔔 Les pairs ont été notifiés.`;
    }
    if (!r.notes.length) return 'Journal vide. Note les décisions importantes avec comm_note action=add.';
    return `📓 Journal partagé (${r.notes.length} note(s)) :\n\n` + r.notes
      .map((n) => `[${n.id}] ${n.by} (${ago(n.ts)})${n.tags.length ? ` [${n.tags.join(', ')}]` : ''}\n${n.text}`)
      .join('\n\n');
  },

  async comm_plan(a) {
    if (!a || !a.action) throw new Error('Paramètre requis : action.');
    const r = await api.planOp(a);
    switch (r.type) {
      case 'goal':
        return `🎯 Cap fixé : ${r.goal}\n🔔 Les pairs ont été notifiés.`;
      case 'milestone':
        return `${a.action === 'add' ? '✅ Jalon ajouté à la feuille de route' : '✅ Jalon mis à jour'} :\n${formatMilestone(r.milestone)}\n🔔 Les pairs ont été notifiés.`;
      case 'plan': {
        const tl = await api.taskOp({ action: 'list' });
        return `🗺️ Feuille de route (canal "${CHANNEL}") :\n\n${formatPlan(r.plan, tl.tasks)}`;
      }
      default:
        return JSON.stringify(r);
    }
  },

  async comm_review(a) {
    if (!a || !a.action) throw new Error('Paramètre requis : action.');
    if (a.action === 'request') {
      // joint automatiquement un résumé du diff courant pour le relecteur
      a = { ...a, diff: truncate(localDiff(CWD, NAME, 'stat'), 4000) };
    }
    const r = await api.reviewOp(a);
    if (r.type === 'review') {
      const rv = r.review;
      const extra = {
        request: `\n🔔 ${rv.to} a été notifié. Ton diff (stat) est joint ; il peut voir le détail avec comm_diff peer=${rv.from}.` +
          `\nAttends son verdict avec comm_wait until=reviews, ou continue sur une autre tâche.`,
        approve: `\n🔔 ${rv.from} a été notifié : il peut merger puis clore avec comm_review action=close.`,
        changes: `\n🔔 ${rv.from} a été notifié des changements demandés.`,
        close: '',
      }[a.action] || '';
      return `🔍 ${rv.id} → ${rv.status}\n${formatReview(rv)}${extra}`;
    }
    const open = r.reviews.filter((x) => x.status === 'pending' || x.status === 'changes_requested');
    const closed = r.reviews.filter((x) => x.status === 'approved' || x.status === 'closed');
    if (!r.reviews.length) return 'Aucune revue sur ce canal. Demandes-en une avec comm_review action=request.';
    let out = `🔍 Revues (canal "${CHANNEL}") :\n\n` +
      (open.length ? open.map(formatReview).join('\n') : '(aucune revue en attente)');
    if (closed.length) out += `\n\nTerminées :\n${closed.slice(-5).map(formatReview).join('\n')}`;
    return out;
  },

  async comm_user(a) {
    if (!a || !a.action) throw new Error('Paramètre requis : action.');
    const r = await api.userOp(a);
    switch (r.type) {
      case 'claimed_msg':
        return `✋ Claim obtenu sur ${r.msg.id} — les pairs sont prévenus de ne pas rédiger en parallèle.\n` +
          `Message de l'utilisateur :\n${r.msg.body}\n\nPublie ta réponse avec comm_user action=reply id=${r.msg.id}.`;
      case 'replied':
        return `📤 Réponse à ${r.msg.id} publiée — l'utilisateur la voit dans son dashboard, les pairs sont notifiés (ils ne complèteront que si nécessaire).`;
      case 'question':
        return `❔ ${r.question.id} posée à l'utilisateur (visible dans son dashboard).\n` +
          `Sa réponse te parviendra par message et sera diffusée à tous. En attendant : avance sur autre chose, ou comm_wait until=message si tu es bloqué dessus.`;
      case 'user_list': {
        const msgs = r.msgs.length
          ? r.msgs.map((m) => {
            let t = `📥 ${m.id} → ${m.to} [${m.status}${m.claimed_by ? ` par ${m.claimed_by}` : ''}] (${ago(m.ts)})\n   ${m.body}`;
            for (const rep of m.replies || []) t += `\n   ↳ ${rep.by} : ${rep.body.slice(0, 500)}`;
            return t;
          }).join('\n')
          : '(aucun message utilisateur)';
        const qs = r.questions.length
          ? r.questions.map((q) => `❔ ${q.id} [${q.status}] de ${q.from} : ${q.text}${q.answer ? `\n   → réponse : ${q.answer}` : ''}`).join('\n')
          : '(aucune question)';
        return `💬 Messages de l'utilisateur :\n${msgs}\n\n❔ Questions à l'utilisateur :\n${qs}`;
      }
      default:
        return JSON.stringify(r);
    }
  },

  async comm_overview() {
    const snap = await api.snapshot();
    const notesR = await api.noteOp({ action: 'list', limit: 5 });
    const openTasks = snap.tasks.tasks.filter((t) => t.status !== 'done');
    const openReviews = (snap.reviews.items || [])
      .filter((x) => x.status === 'pending' || x.status === 'changes_requested');
    const parts = [`# Vue d'ensemble — canal "${CHANNEL}"`];
    parts.push(`## 🗺️ Feuille de route\n${formatPlan(snap.plan, snap.tasks.tasks)}`);
    parts.push(`## 👥 Sessions\n${snap.sessions.length ? snap.sessions.map((s) => describeSession(s)).join('\n') : '(aucune)'}`);
    parts.push(`## 📋 Tâches ouvertes (${openTasks.length})\n${openTasks.length ? openTasks.map(formatTask).join('\n') : '(aucune — comm_task action=add pour en créer)'}`);
    if (openReviews.length) {
      parts.push(`## 🔍 Revues en attente\n${openReviews.map(formatReview).join('\n')}`);
    }
    const openUserMsgs = ((snap.user && snap.user.msgs.items) || []).filter((m) => m.status !== 'answered');
    const openQuestions = ((snap.user && snap.user.questions.items) || []).filter((q) => q.status === 'open');
    if (openUserMsgs.length || openQuestions.length) {
      parts.push(`## 💬 Utilisateur\n` +
        openUserMsgs.map((m) => `- ${m.id} sans réponse${m.claimed_by ? ` (${m.claimed_by} rédige)` : ' — claim avant de répondre'} : ${m.body.slice(0, 200)}`).join('\n') +
        (openUserMsgs.length && openQuestions.length ? '\n' : '') +
        openQuestions.map((q) => `- ${q.id} posée par ${q.from}, en attente de réponse utilisateur : ${q.text.slice(0, 200)}`).join('\n'));
    }
    if (snap.locks.length) {
      parts.push(`## 🔒 Verrous\n${snap.locks.map((l) => `- ${l.path} → ${l.owner}${l.owner === NAME ? ' (moi)' : ''}${l.reason ? ` — ${l.reason}` : ''}`).join('\n')}`);
    }
    if (notesR.notes.length) {
      parts.push(`## 📓 Dernières notes\n${notesR.notes.map((n) => `- [${n.by}] ${n.text}`).join('\n')}`);
    }
    return parts.join('\n\n');
  },

  async comm_wait(a) {
    if (!a || !a.until) throw new Error('Paramètre requis : until.');
    const timeout = Math.min(Math.max(Number(a.timeout_seconds) || 60, 1), MAX_WAIT_S);
    const started = Date.now();
    const deadline = started + timeout * 1000;
    const elapsed = () => Math.round((Date.now() - started) / 1000);

    if (a.until === 'message') {
      const msgs = await api.inboxRead({ consume: true, waitSeconds: timeout });
      if (msgs.length) return `⚡ Message reçu après ${elapsed()}s :\n\n${msgs.map(formatMessage).join('\n\n')}`;
      return timeoutText(a.until, timeout);
    }

    const peerName = a.peer ? sanitizeName(a.peer) : null;
    if (a.until === 'peer_status' && !peerName) throw new Error('peer_status nécessite le paramètre peer.');
    if (a.until === 'locks' && (!a.paths || !a.paths.length)) throw new Error('locks nécessite le paramètre paths.');

    let snap = await api.snapshot();
    const stripped = (s) => JSON.stringify(stripVolatile(s));
    let baselinePeer = a.until === 'peer_status'
      ? stripped(snap.sessions.find((s) => s.name === peerName)) : null;
    let baselineTasks = a.until === 'tasks' ? JSON.stringify(snap.tasks) : null;
    let baselinePlan = a.until === 'plan' ? JSON.stringify(snap.plan) : null;
    let baselineReviews = a.until === 'reviews' ? JSON.stringify(snap.reviews) : null;

    const evaluate = (cur) => {
      if (a.until === 'peer_status') {
        const s = cur.sessions.find((x) => x.name === peerName);
        if (s && stripped(s) !== baselinePeer) {
          return `⚡ L'état de ${peerName} a changé (après ${elapsed()}s) :\n${describeSession(s, true)}`;
        }
      }
      if (a.until === 'tasks' && JSON.stringify(cur.tasks) !== baselineTasks) {
        return `⚡ Le tableau de tâches a changé (après ${elapsed()}s) :\n\n${formatBoard(cur.tasks.tasks)}`;
      }
      if (a.until === 'plan' && JSON.stringify(cur.plan) !== baselinePlan) {
        return `⚡ La feuille de route a changé (après ${elapsed()}s) :\n\n${formatPlan(cur.plan, cur.tasks.tasks)}`;
      }
      if (a.until === 'reviews' && JSON.stringify(cur.reviews) !== baselineReviews) {
        const items = (cur.reviews.items || []).slice(-5);
        return `⚡ Les revues ont évolué (après ${elapsed()}s) :\n${items.map(formatReview).join('\n')}`;
      }
      if (a.until === 'locks') {
        const others = cur.locks.filter((l) => l.owner !== NAME);
        const blocked = a.paths.filter((p) => others.some((l) => pathsOverlap(p, l.path)));
        if (!blocked.length) {
          return `⚡ Chemins libres : ${a.paths.join(', ')}. Verrouille-les maintenant avec comm_lock action=acquire.`;
        }
      }
      return null;
    };

    const immediate = evaluate(snap);
    if (immediate) return immediate;

    while (Date.now() < deadline) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      const next = await api.waitChange(snap.version, Math.min(remaining, 25));
      if (next) {
        snap = next;
        const hit = evaluate(snap);
        if (hit) return hit;
      }
      if (MODE === 'file') { try { await api.heartbeat(); } catch { /* ignore */ } }
    }
    return timeoutText(a.until, timeout);
  },
};

function timeoutText(until, timeout) {
  return `⏳ Timeout (${timeout}s) — l'événement "${until}" n'est pas survenu. ` +
    `Tu peux relancer comm_wait, ou avancer sur autre chose et revérifier plus tard.`;
}

// ---------------------------------------------------------------------------
// Mode CLI : participation et supervision humaines
//   node server.js status               → tableau de bord du canal
//   node server.js send <pair|*> <msg>  → envoyer un message aux sessions
//   node server.js inbox                → lire les réponses
// (définir CLAUDE_COMM_NAME pour avoir une identité stable, ex: "patron")
// ---------------------------------------------------------------------------

const CLI_COMMANDS = {
  async status() {
    if (MODE === 'file') ensureDir(CHAN_DIR);
    const snap = await api.snapshot();
    const notes = MODE === 'file' ? readJSON(NOTES_FILE, []) : null;
    console.log(`# claude-comm — canal "${CHANNEL}" (${MODE === 'relay' ? `relais ${RELAY_URL}` : `hub ${CHAN_DIR}`})\n`);
    console.log('## Feuille de route');
    console.log(formatPlan(snap.plan, snap.tasks.tasks));
    console.log('\n## Sessions');
    console.log(snap.sessions.length ? snap.sessions.map((s) => describeSession(s, true)).join('\n\n') : '(aucune)');
    console.log('\n## Tâches');
    console.log(snap.tasks.tasks.length ? snap.tasks.tasks.map(formatTask).join('\n') : '(aucune)');
    console.log('\n## Revues');
    const items = snap.reviews.items || [];
    console.log(items.length ? items.map(formatReview).join('\n') : '(aucune)');
    console.log('\n## Verrous');
    console.log(snap.locks.length ? snap.locks.map((l) => `- ${l.path} → ${l.owner} (${ago(l.ts)})`).join('\n') : '(aucun)');
    if (notes && notes.length) console.log(`\n## Journal : ${notes.length} note(s)`);
    for (const [name, n] of Object.entries(snap.inbox_counts || {})) {
      if (n) console.log(`\n📬 ${name} : ${n} message(s) non lu(s)`);
    }
  },

  async send() {
    const to = ARGS._[1];
    const message = ARGS._.slice(2).join(' ');
    if (!to || !message) {
      console.error('Usage : node server.js send <pair|*> <message...>');
      process.exit(1);
    }
    if (!NAME_PROVIDED) {
      console.error(`⚠️ CLAUDE_COMM_NAME non défini : tu apparais comme "${NAME}" (nom jetable). ` +
        `Définis-le (ex: CLAUDE_COMM_NAME=patron) pour recevoir les réponses.`);
    }
    await api.heartbeat({ role: ROLE || 'humain' });
    const r = await api.send({ to, body: message, kind: 'message' });
    console.log(`📤 Envoyé à ${r.targets.join(', ')} (id ${r.id}). Lis les réponses avec : node server.js inbox`);
  },

  async inbox() {
    await api.heartbeat({ role: ROLE || 'humain' });
    const msgs = await api.inboxRead({ consume: true });
    console.log(msgs.length ? msgs.map(formatMessage).join('\n\n') : '📭 Boîte vide.');
  },

  async questions() {
    const snap = await api.snapshot();
    const items = (snap.user && snap.user.questions.items) || [];
    const open = items.filter((q) => q.status === 'open');
    const answered = items.filter((q) => q.status === 'answered').slice(-5);
    console.log(open.length
      ? `❔ Questions en attente de TA réponse :\n` + open.map((q) =>
        `- ${q.id} de ${q.from} (${ago(q.ts)}) : ${q.text}` +
        (q.options.length ? `\n  options : ${q.options.join(' | ')}` : '') +
        (q.context ? `\n  contexte : ${q.context}` : '') +
        `\n  → node server.js answer ${q.id} "ta réponse"`).join('\n')
      : 'Aucune question en attente.');
    if (answered.length) {
      console.log(`\nDéjà répondues :\n` + answered.map((q) => `- ${q.id} : ${q.text} → ${q.answer}`).join('\n'));
    }
  },

  async answer() {
    const id = ARGS._[1];
    const answer = ARGS._.slice(2).join(' ');
    if (!id || !answer) {
      console.error('Usage : node server.js answer <Qx> <réponse...>');
      process.exit(1);
    }
    if (MODE === 'relay') {
      const r = await rfetch('POST', '/user-answer', { id, answer });
      console.log(`✅ Réponse à ${r.question.id} diffusée à toutes les sessions.`);
      return;
    }
    await withStateLock(async () => {
      const user = readJSON(USER_FILE, emptyUser());
      const r = userAnswer(user, { id, answer });
      writeJSONAtomic(USER_FILE, user);
      for (const s of fileListSessions()) {
        fileDeliver(s.name, {
          id: newId(), from: 'user', to: s.name, kind: 'notify',
          subject: r.notify.subject, body: r.notify.body, reply_to: null, ts: nowISO(),
        });
      }
      console.log(`✅ Réponse à ${r.question.id} diffusée à toutes les sessions.`);
    });
  },

  async standup() {
    const minutes = Math.max(0, Math.min(1440, Number(ARGS._[1]) || 0));
    if (MODE === 'relay') {
      await rfetch('POST', '/config', { standup_minutes: minutes });
    } else {
      const cfg = readJSON(CONFIG_FILE, emptyConfig());
      cfg.standup_minutes = minutes;
      writeJSONAtomic(CONFIG_FILE, cfg);
    }
    console.log(minutes
      ? `🗞 Standup périodique activé : toutes les ${minutes} min (diffusé seulement si l'état a changé).`
      : '🗞 Standup périodique désactivé.');
  },
};

if (CLI_COMMANDS[ARGS._[0]]) {
  CLI_COMMANDS[ARGS._[0]]()
    .then(() => process.exit(0), (e) => { console.error(`❌ ${e.message}`); process.exit(1); });
} else {
  startMcp();
}

// ---------------------------------------------------------------------------
// Boucle MCP (JSON-RPC sur stdio, messages délimités par des sauts de ligne)
// ---------------------------------------------------------------------------

function startMcp() {
  if (MODE === 'file') {
    ensureDir(SESSIONS_DIR);
    ensureDir(inboxNewDir(NAME));
  } else if (!TOKEN) {
    console.error('⚠️ CLAUDE_COMM_RELAY défini sans CLAUDE_COMM_TOKEN : le relais refusera les requêtes.');
  }

  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
  const respondError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function handleRequest(req) {
    const { id, method, params } = req;
    try {
      if (method === 'initialize') {
        try { await api.heartbeat(); } catch { /* relais down : les outils le diront */ }
        api.startBackground();
        respond(id, {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'claude-comm', version: '4.0.0' },
          instructions:
            `Tu es connecté au canal de coordination "${CHANNEL}" sous le nom "${NAME}"` +
            `${MODE === 'relay' ? ` via le relais ${RELAY_URL}` : ''}. ` +
            `D'autres sessions Claude peuvent travailler en parallèle avec toi (y compris sur d'autres machines). ` +
            `Commence par comm_join pour t'annoncer, publie ton état avec comm_status_set, ` +
            `et relève ta boîte avec comm_inbox régulièrement (au minimum entre deux tâches).`,
        });
        return;
      }
      if (!id && typeof method === 'string' && method.startsWith('notifications/')) return;
      if (method === 'ping') { respond(id, {}); return; }
      if (method === 'tools/list') { respond(id, { tools: TOOLS }); return; }
      if (method === 'tools/call') {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        const handler = HANDLERS[name];
        if (!handler) { respondError(id, -32602, `Outil inconnu : ${name}`); return; }
        try {
          if (name !== 'comm_join' && name !== 'comm_status_set') {
            try { await api.heartbeat(); } catch { /* le handler remontera l'erreur */ }
          }
          let text = await handler(args);
          if (name !== 'comm_inbox' && name !== 'comm_wait') text += await inboxFooter();
          respond(id, { content: [{ type: 'text', text }] });
        } catch (e) {
          respond(id, { content: [{ type: 'text', text: `❌ ${e.message}` }], isError: true });
        }
        return;
      }
      if (id !== undefined && id !== null) respondError(id, -32601, `Méthode inconnue : ${method}`);
    } catch (e) {
      if (id !== undefined && id !== null) respondError(id, -32603, e.message);
    }
  }

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handleRequest(msg);
    }
  });

  async function shutdown() {
    try {
      if (MODE === 'file') {
        const s = readJSON(sessionFile(NAME), null);
        if (s && s.pid === process.pid) {
          writeJSONAtomic(sessionFile(NAME), { ...s, state: 'offline', last_seen: nowISO() });
        }
      } else {
        await Promise.race([api.heartbeat({ state: 'offline' }), sleep(2000)]);
      }
    } catch { /* ignore */ }
    process.exit(0);
  }

  process.stdin.on('end', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
