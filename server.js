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
  emptyTasks, applyTaskAction, applyLockAction, applyNoteAction,
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
  const { last_seen, live, ...rest } = s || {};
  return rest;
}

function fileSnapshot() {
  const sessions = fileListSessions();
  const tasks = readJSON(TASKS_FILE, emptyTasks());
  const locks = readJSON(LOCKS_FILE, []);
  const stable = JSON.stringify({ s: sessions.map(stripVolatile), t: tasks, l: locks });
  return {
    version: crypto.createHash('sha1').update(stable).digest('hex'),
    sessions, tasks, locks,
    inbox_counts: Object.fromEntries(sessions.map((s) => [s.name, listDir(inboxNewDir(s.name)).length])),
  };
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
      last_seen: nowISO(), joined_at: prev.joined_at || nowISO(),
    };
    writeJSONAtomic(sessionFile(NAME), session);
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
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
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
      branch: git.branch, head: git.head,
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

function describeSession(s, verbose = false) {
  const lines = [
    `${isOnline(s) ? '🟢' : '⚪'} ${s.name}${s.name === NAME ? ' (moi)' : ''}` +
      `${s.role ? ` — ${s.role}` : ''} [${s.state || 'idle'}] (vu ${ago(s.last_seen)})`,
  ];
  if (s.task) lines.push(`   tâche : ${s.task}${s.progress ? ` (${s.progress})` : ''}`);
  if (s.detail) lines.push(`   détail : ${s.detail}`);
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

function formatTask(t) {
  const icon = { todo: '⬜', in_progress: '🔵', done: '✅', blocked: '🟥' }[t.status] || '⬜';
  let line = `${icon} ${t.id} [${t.status}] ${t.title}`;
  if (t.owner) line += ` — pris par ${t.owner}`;
  if (t.detail) line += `\n     ${t.detail}`;
  if (t.notes && t.notes.length) {
    line += '\n' + t.notes.slice(-3).map((n) => `     · ${n}`).join('\n');
  }
  return line;
}

function formatBoard(tasks) {
  if (!tasks.length) return 'Tableau vide. Ajoute des tâches avec comm_task action=add.';
  const open = tasks.filter((t) => t.status !== 'done');
  const done = tasks.filter((t) => t.status === 'done');
  let out = `📋 Tableau de tâches (canal "${CHANNEL}") :\n\n` +
    (open.length ? open.map(formatTask).join('\n') : '(aucune tâche ouverte)');
  if (done.length) out += `\n\nTerminées :\n${done.map(formatTask).join('\n')}`;
  return out;
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
      "Tableau de tâches partagé pour paralléliser sans conflit. Actions : add (créer), list, next (prendre atomiquement la prochaine tâche libre), claim (prendre une tâche précise), update (statut/note), done (terminer), release (rendre). Les pairs sont notifiés des changements.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'next', 'claim', 'update', 'done', 'release'], description: 'Action à effectuer' },
        id: { type: 'string', description: "Id de la tâche (ex: 'T3') pour claim/update/done/release" },
        title: { type: 'string', description: 'Titre (pour add)' },
        detail: { type: 'string', description: 'Description (pour add)' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'], description: 'Nouveau statut (pour update)' },
        note: { type: 'string', description: 'Note de progression ou résultat' },
      },
      required: ['action'],
    },
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
      "Attente bloquante d'un événement pour se synchroniser en direct : until=message (un message arrive), peer_status (l'état d'un pair change), tasks (le tableau de tâches change), locks (des chemins se libèrent). Retourne dès que l'événement survient ou à expiration du timeout.",
    inputSchema: {
      type: 'object',
      properties: {
        until: { type: 'string', enum: ['message', 'peer_status', 'tasks', 'locks'], description: 'Événement attendu' },
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
      case 'done':
        return `✅ ${r.task.id} terminée. ${r.remaining} tâche(s) restante(s).` +
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
// Mode CLI (inspection humaine) : node server.js status
// ---------------------------------------------------------------------------

if (ARGS._[0] === 'status') {
  (async () => {
    if (MODE === 'file') ensureDir(CHAN_DIR);
    const snap = await api.snapshot();
    const notes = MODE === 'file' ? readJSON(NOTES_FILE, []) : null;
    console.log(`# claude-comm — canal "${CHANNEL}" (${MODE === 'relay' ? `relais ${RELAY_URL}` : `hub ${CHAN_DIR}`})\n`);
    console.log('## Sessions');
    console.log(snap.sessions.length ? snap.sessions.map((s) => describeSession(s, true)).join('\n\n') : '(aucune)');
    console.log('\n## Tâches');
    console.log(snap.tasks.tasks.length ? snap.tasks.tasks.map(formatTask).join('\n') : '(aucune)');
    console.log('\n## Verrous');
    console.log(snap.locks.length ? snap.locks.map((l) => `- ${l.path} → ${l.owner} (${ago(l.ts)})`).join('\n') : '(aucun)');
    if (notes && notes.length) console.log(`\n## Journal : ${notes.length} note(s)`);
    for (const [name, n] of Object.entries(snap.inbox_counts || {})) {
      if (n) console.log(`\n📬 ${name} : ${n} message(s) non lu(s)`);
    }
  })().then(() => process.exit(0), (e) => { console.error(`❌ ${e.message}`); process.exit(1); });
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
          serverInfo: { name: 'claude-comm', version: '2.0.0' },
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
