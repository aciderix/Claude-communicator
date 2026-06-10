#!/usr/bin/env node
/*
 * claude-comm — serveur MCP de coordination entre sessions Claude Code.
 *
 * Chaque session Claude lance sa propre instance de ce serveur (stdio).
 * Les instances communiquent via un "hub" partagé sur disque
 * (par défaut ~/.claude-comm/<channel>), ce qui permet :
 *   - messagerie directe + broadcast entre sessions
 *   - état live de chaque session (statut, tâche en cours, progression)
 *   - demande de diff git du pair (lecture directe de son worktree)
 *   - tableau de tâches partagé avec claim atomique
 *   - verrous de fichiers pour éviter les collisions d'édition
 *   - attente bloquante d'événements (message, changement d'état...)
 *
 * Zéro dépendance externe. Node >= 18.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else {
      out._.push(a);
    }
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
const CWD = process.cwd();

const CHAN_DIR = path.join(HUB, CHANNEL);
const SESSIONS_DIR = path.join(CHAN_DIR, 'sessions');
const INBOX_DIR = path.join(CHAN_DIR, 'inbox');
const LOCKS_DIR = path.join(CHAN_DIR, 'locks');
const TASKS_FILE = path.join(CHAN_DIR, 'tasks.json');
const TASKS_LOCK = path.join(CHAN_DIR, 'tasks.lock');

const OFFLINE_AFTER_MS = 15 * 60 * 1000; // sans heartbeat depuis 15 min => probablement parti
const MAX_DIFF_CHARS = 30000;
const MAX_WAIT_S = 300;

function sanitizeName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40) || 'anon';
}

// ---------------------------------------------------------------------------
// Utilitaires fichiers
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

async function withTasksLock(fn) {
  for (let i = 0; i < 100; i++) {
    try { fs.mkdirSync(TASKS_LOCK); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // verrou abandonné ? (> 30 s)
      try {
        const st = fs.statSync(TASKS_LOCK);
        if (Date.now() - st.mtimeMs > 30000) { fs.rmdirSync(TASKS_LOCK); continue; }
      } catch { /* disparu entre-temps */ }
      if (i === 99) throw new Error('Impossible d\'obtenir le verrou du tableau de tâches.');
      await sleep(25);
    }
  }
  try { return await fn(); }
  finally { try { fs.rmdirSync(TASKS_LOCK); } catch { /* ignore */ } }
}

function nowISO() { return new Date().toISOString(); }

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

// ---------------------------------------------------------------------------
// Sessions (état live)
// ---------------------------------------------------------------------------

function sessionFile(name) { return path.join(SESSIONS_DIR, `${name}.json`); }

function loadSession(name) { return readJSON(sessionFile(name), null); }

function listSessions() {
  return listDir(SESSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJSON(path.join(SESSIONS_DIR, f), null))
    .filter(Boolean)
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function gitInfo(cwd) {
  const run = (args) => {
    try {
      return execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
      }).trim();
    } catch (e) {
      return null;
    }
  };
  return {
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    head: run(['rev-parse', '--short', 'HEAD']),
  };
}

function heartbeat(extra = {}) {
  const prev = loadSession(NAME) || {};
  const git = gitInfo(CWD);
  writeJSONAtomic(sessionFile(NAME), {
    state: 'idle',
    role: ROLE,
    task: '',
    detail: '',
    progress: '',
    ...prev,
    ...extra,
    name: NAME,
    pid: process.pid,
    cwd: CWD,
    branch: git.branch,
    head: git.head,
    last_seen: nowISO(),
    joined_at: prev.joined_at || nowISO(),
  });
}

function describeSession(s, verbose = false) {
  const online = Date.now() - Date.parse(s.last_seen || 0) < OFFLINE_AFTER_MS;
  const lines = [
    `${online ? '🟢' : '⚪'} ${s.name}${s.name === NAME ? ' (moi)' : ''}` +
      `${s.role ? ` — ${s.role}` : ''} [${s.state || 'idle'}] (vu ${ago(s.last_seen)})`,
  ];
  if (s.task) lines.push(`   tâche : ${s.task}${s.progress ? ` (${s.progress})` : ''}`);
  if (s.detail) lines.push(`   détail : ${s.detail}`);
  if (verbose) {
    lines.push(`   cwd : ${s.cwd}`);
    lines.push(`   branche : ${s.branch || '?'} @ ${s.head || '?'}`);
    lines.push(`   rejoint : ${s.joined_at} | pid ${s.pid}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Messagerie
// ---------------------------------------------------------------------------

function inboxNewDir(name) { return path.join(INBOX_DIR, name, 'new'); }
function inboxReadDir(name) { return path.join(INBOX_DIR, name, 'read'); }

function deliver(to, msg) {
  const dir = inboxNewDir(to);
  ensureDir(dir);
  const file = path.join(dir, `${Date.now()}-${msg.id}.json`);
  writeJSONAtomic(file, msg);
}

function sendMessage({ to, kind = 'message', subject = '', body, reply_to = null }) {
  const sessions = listSessions();
  let targets;
  if (to === '*' || to === 'all') {
    targets = sessions.map((s) => s.name).filter((n) => n !== NAME);
    if (targets.length === 0) throw new Error('Aucun pair connecté pour le broadcast.');
  } else {
    const t = sanitizeName(to);
    if (!sessions.some((s) => s.name === t)) {
      const known = sessions.map((s) => s.name).join(', ') || '(aucune session)';
      throw new Error(`Pair inconnu : "${to}". Sessions enregistrées : ${known}`);
    }
    targets = [t];
  }
  const msg = {
    id: crypto.randomBytes(4).toString('hex'),
    from: NAME,
    kind,
    subject,
    body,
    reply_to,
    ts: nowISO(),
  };
  for (const t of targets) deliver(t, { ...msg, to: t });
  return { msg, targets };
}

function countNewMessages(name) { return listDir(inboxNewDir(name)).length; }

function readInbox(name, { consume = true } = {}) {
  const dir = inboxNewDir(name);
  const files = listDir(dir).sort();
  const msgs = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const m = readJSON(full, null);
    if (m) msgs.push(m);
    if (consume) {
      ensureDir(inboxReadDir(name));
      try { fs.renameSync(full, path.join(inboxReadDir(name), f)); } catch { /* ignore */ }
    }
  }
  return msgs;
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

function inboxFooter() {
  const n = countNewMessages(NAME);
  return n > 0
    ? `\n\n📬 ${n} message(s) non lu(s) dans ta boîte — appelle comm_inbox pour les lire.`
    : '';
}

// ---------------------------------------------------------------------------
// Tableau de tâches
// ---------------------------------------------------------------------------

function loadTasks() { return readJSON(TASKS_FILE, { next_id: 1, tasks: [] }); }
function saveTasks(t) { writeJSONAtomic(TASKS_FILE, t); }

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

function notifyPeers(subject, body) {
  try { sendMessage({ to: '*', kind: 'notify', subject, body }); }
  catch { /* aucun pair : pas grave */ }
}

// ---------------------------------------------------------------------------
// Verrous de fichiers
// ---------------------------------------------------------------------------

function lockId(p) {
  return crypto.createHash('sha1').update(normalizePath(p)).digest('hex').slice(0, 16);
}

function normalizePath(p) { return String(p).replace(/\\/g, '/').replace(/\/+$/, ''); }

function pathsOverlap(a, b) {
  a = normalizePath(a); b = normalizePath(b);
  if (a === b) return true;
  return a.startsWith(b + '/') || b.startsWith(a + '/');
}

function listLocks() {
  return listDir(LOCKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJSON(path.join(LOCKS_DIR, f), null))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Diff git d'un pair
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

function peerDiff(session, mode, pathFilter) {
  const cwd = session.cwd;
  if (!cwd || !fs.existsSync(cwd)) {
    return `Le répertoire de ${session.name} (${cwd}) n'est pas accessible depuis cette machine.`;
  }
  const filter = pathFilter ? ['--', pathFilter] : [];
  const parts = [];
  const status = gitRun(cwd, ['status', '-sb']);
  parts.push(`# ${session.name} — ${cwd} (branche ${session.branch || '?'})`);
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
      'Lister toutes les sessions Claude du canal avec leur état live : statut, tâche en cours, progression, branche git, dernière activité.',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Inclure cwd, branche, pid (défaut: false)' },
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
      "Lire les messages reçus des autres sessions. Avec wait_seconds > 0, attend l'arrivée d'un message (poll bloquant) — utile pour se synchroniser en direct. Réponds aux questions/status_request/diff_request reçus via comm_send avec reply_to.",
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
      "Obtenir le diff git en direct du worktree d'un pair (lecture directe, sans le déranger) : status, modifications, fichiers non suivis. Modes : stat (résumé), files (liste), full (diff complet).",
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
    const existing = loadSession(NAME);
    let warning = '';
    if (existing && existing.pid !== process.pid &&
        Date.now() - Date.parse(existing.last_seen || 0) < 60000) {
      warning = `\n⚠️ Une autre session utilisait le nom "${NAME}" il y a moins d'une minute (pid ${existing.pid}). ` +
        `Si ce n'est pas un redémarrage, relance avec CLAUDE_COMM_NAME=<autre-nom>.`;
    }
    heartbeat({
      role: a.role !== undefined ? a.role : (existing && existing.role) || ROLE,
      task: a.task !== undefined ? a.task : (existing && existing.task) || '',
      state: a.task ? 'working' : 'idle',
    });
    if (a.announce !== false) {
      notifyPeers('arrivée', `${NAME} a rejoint le canal "${CHANNEL}"${a.role ? ` (rôle : ${a.role})` : ''}${a.task ? ` — démarre : ${a.task}` : ''}.`);
    }
    const others = listSessions().filter((s) => s.name !== NAME);
    const peersTxt = others.length
      ? `Pairs présents :\n${others.map((s) => describeSession(s)).join('\n')}`
      : 'Aucun autre pair pour le moment. Ils te verront dès leur comm_join.';
    return `✅ Connecté au canal "${CHANNEL}" en tant que "${NAME}".${warning}\n\n${peersTxt}\n\n` +
      `Hub : ${CHAN_DIR}\nPense à publier ton état (comm_status_set) et à relever ta boîte (comm_inbox) régulièrement.`;
  },

  async comm_peers(a = {}) {
    const sessions = listSessions();
    if (!sessions.length) return 'Aucune session enregistrée sur ce canal.';
    return sessions.map((s) => describeSession(s, !!a.verbose)).join('\n');
  },

  async comm_send(a) {
    if (!a || !a.to || !a.body) throw new Error('Paramètres requis : to, body.');
    const { msg, targets } = sendMessage(a);
    const hint = a.kind === 'question' || a.kind === 'status_request' || a.kind === 'diff_request'
      ? `\nPour attendre la réponse en direct : comm_inbox avec wait_seconds (ex: 60).`
      : '';
    return `📤 Message ${msg.id} (${msg.kind}) envoyé à ${targets.join(', ')}.${hint}`;
  },

  async comm_inbox(a = {}) {
    const wait = Math.min(Math.max(Number(a.wait_seconds) || 0, 0), MAX_WAIT_S);
    const deadline = Date.now() + wait * 1000;
    let msgs = readInbox(NAME, { consume: !a.peek });
    while (!msgs.length && Date.now() < deadline) {
      await sleep(1000);
      heartbeat();
      msgs = readInbox(NAME, { consume: !a.peek });
    }
    if (!msgs.length) {
      return wait > 0
        ? `⏳ Aucun message après ${wait}s d'attente.`
        : '📭 Boîte vide.';
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
    heartbeat(patch);
    const shouldNotify = a.notify === true || (a.notify !== false && (a.state === 'blocked' || a.state === 'done'));
    if (shouldNotify) {
      notifyPeers(`état : ${a.state}`,
        `${NAME} est passé à "${a.state}"${a.task ? ` sur : ${a.task}` : ''}` +
        `${a.progress ? ` (${a.progress})` : ''}${a.detail ? `\n${a.detail}` : ''}`);
    }
    return `✅ État publié : ${a.state}${a.task ? ` — ${a.task}` : ''}${a.progress ? ` (${a.progress})` : ''}` +
      (shouldNotify ? '\n🔔 Les pairs ont été notifiés.' : '');
  },

  async comm_status_get(a = {}) {
    if (a.peer) {
      const s = loadSession(sanitizeName(a.peer));
      if (!s) throw new Error(`Pair inconnu : "${a.peer}".`);
      return describeSession(s, true);
    }
    const others = listSessions().filter((s) => s.name !== NAME);
    if (!others.length) return 'Aucun pair sur ce canal.';
    return others.map((s) => describeSession(s, true)).join('\n\n');
  },

  async comm_diff(a) {
    if (!a || !a.peer) throw new Error('Paramètre requis : peer.');
    const s = loadSession(sanitizeName(a.peer));
    if (!s) throw new Error(`Pair inconnu : "${a.peer}".`);
    return peerDiff(s, a.mode || 'stat', a.path);
  },

  async comm_task(a) {
    if (!a || !a.action) throw new Error('Paramètre requis : action.');
    return withTasksLock(async () => {
      const db = loadTasks();
      const find = (id) => {
        const t = db.tasks.find((t) => t.id === String(id).toUpperCase());
        if (!t) throw new Error(`Tâche inconnue : "${id}". Utilise comm_task action=list.`);
        return t;
      };
      const touch = (t, note) => {
        t.updated_at = nowISO();
        if (note) (t.notes = t.notes || []).push(`[${NAME}] ${note}`);
      };

      switch (a.action) {
        case 'add': {
          if (!a.title) throw new Error('Paramètre requis pour add : title.');
          const t = {
            id: `T${db.next_id++}`, title: a.title, detail: a.detail || '',
            status: 'todo', owner: null, created_by: NAME,
            created_at: nowISO(), updated_at: nowISO(), notes: [],
          };
          db.tasks.push(t);
          saveTasks(db);
          notifyPeers('nouvelle tâche', `${NAME} a ajouté ${t.id} : ${t.title}`);
          return `✅ Tâche créée :\n${formatTask(t)}`;
        }
        case 'list': {
          if (!db.tasks.length) return 'Tableau vide. Ajoute des tâches avec comm_task action=add.';
          const open = db.tasks.filter((t) => t.status !== 'done');
          const done = db.tasks.filter((t) => t.status === 'done');
          let out = `📋 Tableau de tâches (canal "${CHANNEL}") :\n\n` +
            (open.length ? open.map(formatTask).join('\n') : '(aucune tâche ouverte)');
          if (done.length) out += `\n\nTerminées :\n${done.map(formatTask).join('\n')}`;
          return out;
        }
        case 'next': {
          const t = db.tasks.find((t) => t.status === 'todo' && !t.owner);
          if (!t) return 'Aucune tâche libre. Vérifie comm_task action=list ou ajoute des tâches.';
          t.owner = NAME; t.status = 'in_progress';
          touch(t, 'prise (next)');
          saveTasks(db);
          heartbeat({ state: 'working', task: `${t.id}: ${t.title}` });
          notifyPeers('tâche prise', `${NAME} prend ${t.id} : ${t.title}`);
          return `🔵 Tu prends :\n${formatTask(t)}`;
        }
        case 'claim': {
          const t = find(a.id);
          if (t.owner && t.owner !== NAME) {
            throw new Error(`${t.id} est déjà prise par ${t.owner}. Choisis-en une autre (action=next) ou demande-lui de la libérer.`);
          }
          t.owner = NAME; t.status = 'in_progress';
          touch(t, 'prise (claim)');
          saveTasks(db);
          heartbeat({ state: 'working', task: `${t.id}: ${t.title}` });
          notifyPeers('tâche prise', `${NAME} prend ${t.id} : ${t.title}`);
          return `🔵 Tu prends :\n${formatTask(t)}`;
        }
        case 'update': {
          const t = find(a.id);
          if (a.status) t.status = a.status;
          touch(t, a.note || (a.status ? `statut → ${a.status}` : 'mise à jour'));
          saveTasks(db);
          if (a.status === 'blocked') notifyPeers('tâche bloquée', `${NAME} : ${t.id} bloquée — ${a.note || t.title}`);
          return `✅ Mise à jour :\n${formatTask(t)}`;
        }
        case 'done': {
          const t = find(a.id);
          t.status = 'done'; t.owner = t.owner || NAME;
          touch(t, a.note || 'terminée');
          saveTasks(db);
          notifyPeers('tâche terminée', `${NAME} a terminé ${t.id} : ${t.title}${a.note ? `\n${a.note}` : ''}`);
          const remaining = db.tasks.filter((x) => x.status !== 'done').length;
          return `✅ ${t.id} terminée. ${remaining} tâche(s) restante(s).` +
            (remaining ? ' Enchaîne avec comm_task action=next.' : ' 🎉 Tableau vide !');
        }
        case 'release': {
          const t = find(a.id);
          if (t.owner !== NAME) throw new Error(`${t.id} ne t'appartient pas (owner: ${t.owner || 'aucun'}).`);
          t.owner = null; t.status = 'todo';
          touch(t, a.note || 'libérée');
          saveTasks(db);
          notifyPeers('tâche libérée', `${NAME} a libéré ${t.id} : ${t.title}`);
          return `↩️ ${t.id} rendue au tableau.`;
        }
        default:
          throw new Error(`Action inconnue : ${a.action}`);
      }
    });
  },

  async comm_lock(a) {
    if (!a || !a.action) throw new Error('Paramètre requis : action.');
    ensureDir(LOCKS_DIR);
    switch (a.action) {
      case 'acquire': {
        if (!a.paths || !a.paths.length) throw new Error('Paramètre requis pour acquire : paths.');
        const existing = listLocks();
        const conflicts = [];
        for (const p of a.paths) {
          for (const l of existing) {
            if (l.owner !== NAME && pathsOverlap(p, l.path)) {
              conflicts.push(`"${p}" chevauche "${l.path}" verrouillé par ${l.owner} (${ago(l.ts)})${l.reason ? ` — ${l.reason}` : ''}`);
            }
          }
        }
        if (conflicts.length) {
          return `🟥 Verrou refusé :\n- ${conflicts.join('\n- ')}\n\n` +
            `Options : travaille ailleurs, demande au pair quand il libère (comm_send kind=question), ou attends avec comm_wait until=locks.`;
        }
        for (const p of a.paths) {
          writeJSONAtomic(path.join(LOCKS_DIR, `${lockId(p)}.json`), {
            path: normalizePath(p), owner: NAME, reason: a.reason || '', ts: nowISO(),
          });
        }
        return `🔒 Verrouillé pour ${NAME} : ${a.paths.join(', ')}${a.reason ? ` (${a.reason})` : ''}\nLibère avec comm_lock action=release dès que tu as fini.`;
      }
      case 'release': {
        const mine = listLocks().filter((l) => l.owner === NAME);
        const targets = a.paths && a.paths.length
          ? mine.filter((l) => a.paths.some((p) => normalizePath(p) === l.path))
          : mine;
        if (!targets.length) return 'Aucun verrou à libérer.';
        for (const l of targets) {
          try { fs.unlinkSync(path.join(LOCKS_DIR, `${lockId(l.path)}.json`)); } catch { /* ignore */ }
        }
        notifyPeers('verrous libérés', `${NAME} a libéré : ${targets.map((l) => l.path).join(', ')}`);
        return `🔓 Libéré : ${targets.map((l) => l.path).join(', ')}`;
      }
      case 'list': {
        const locks = listLocks();
        if (!locks.length) return 'Aucun verrou actif.';
        return '🔒 Verrous actifs :\n' + locks
          .map((l) => `- ${l.path} → ${l.owner}${l.owner === NAME ? ' (moi)' : ''} (${ago(l.ts)})${l.reason ? ` — ${l.reason}` : ''}`)
          .join('\n');
      }
      default:
        throw new Error(`Action inconnue : ${a.action}`);
    }
  },

  async comm_wait(a) {
    if (!a || !a.until) throw new Error('Paramètre requis : until.');
    const timeout = Math.min(Math.max(Number(a.timeout_seconds) || 60, 1), MAX_WAIT_S);
    const deadline = Date.now() + timeout * 1000;
    const started = Date.now();

    const peerName = a.peer ? sanitizeName(a.peer) : null;
    let baseline = null;
    if (a.until === 'peer_status') {
      if (!peerName) throw new Error('peer_status nécessite le paramètre peer.');
      baseline = JSON.stringify(loadSession(peerName) || {});
    } else if (a.until === 'tasks') {
      baseline = JSON.stringify(loadTasks());
    }

    while (Date.now() < deadline) {
      heartbeat();
      if (a.until === 'message' && countNewMessages(NAME) > 0) {
        const msgs = readInbox(NAME);
        return `⚡ Message reçu après ${Math.round((Date.now() - started) / 1000)}s :\n\n${msgs.map(formatMessage).join('\n\n')}`;
      }
      if (a.until === 'peer_status') {
        const cur = loadSession(peerName);
        const curStr = JSON.stringify(cur || {});
        // ignorer le simple heartbeat : comparer sans last_seen
        const strip = (s) => s.replace(/"last_seen":"[^"]*"/, '');
        if (cur && strip(curStr) !== strip(baseline)) {
          return `⚡ L'état de ${peerName} a changé :\n${describeSession(cur, true)}`;
        }
      }
      if (a.until === 'tasks') {
        const cur = JSON.stringify(loadTasks());
        if (cur !== baseline) {
          return `⚡ Le tableau de tâches a changé :\n\n${await HANDLERS.comm_task({ action: 'list' })}`;
        }
      }
      if (a.until === 'locks') {
        const paths = a.paths || [];
        if (!paths.length) throw new Error('locks nécessite le paramètre paths.');
        const locks = listLocks().filter((l) => l.owner !== NAME);
        const blocked = paths.filter((p) => locks.some((l) => pathsOverlap(p, l.path)));
        if (!blocked.length) {
          return `⚡ Chemins libres : ${paths.join(', ')}. Verrouille-les maintenant avec comm_lock action=acquire.`;
        }
      }
      await sleep(1000);
    }
    return `⏳ Timeout (${timeout}s) — l'événement "${a.until}" n'est pas survenu. ` +
      `Tu peux relancer comm_wait, ou avancer sur autre chose et revérifier plus tard.`;
  },
};

// ---------------------------------------------------------------------------
// Mode CLI (inspection humaine) : node server.js status
// ---------------------------------------------------------------------------

if (ARGS._[0] === 'status') {
  ensureDir(CHAN_DIR);
  const sessions = listSessions();
  console.log(`# claude-comm — canal "${CHANNEL}" (hub: ${CHAN_DIR})\n`);
  console.log('## Sessions');
  console.log(sessions.length ? sessions.map((s) => describeSession(s, true)).join('\n\n') : '(aucune)');
  const db = loadTasks();
  console.log('\n## Tâches');
  console.log(db.tasks.length ? db.tasks.map(formatTask).join('\n') : '(aucune)');
  const locks = listLocks();
  console.log('\n## Verrous');
  console.log(locks.length ? locks.map((l) => `- ${l.path} → ${l.owner} (${ago(l.ts)})`).join('\n') : '(aucun)');
  for (const s of sessions) {
    const n = countNewMessages(s.name);
    if (n) console.log(`\n📬 ${s.name} : ${n} message(s) non lu(s)`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Boucle MCP (JSON-RPC sur stdio, messages délimités par des sauts de ligne)
// ---------------------------------------------------------------------------

ensureDir(SESSIONS_DIR);
ensureDir(inboxNewDir(NAME));
ensureDir(LOCKS_DIR);

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function respond(id, result) { send({ jsonrpc: '2.0', id, result }); }

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(req) {
  const { id, method, params } = req;
  try {
    if (method === 'initialize') {
      heartbeat();
      respond(id, {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-comm', version: '1.0.0' },
        instructions:
          `Tu es connecté au canal de coordination "${CHANNEL}" sous le nom "${NAME}". ` +
          `D'autres sessions Claude peuvent travailler en parallèle avec toi. ` +
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
      heartbeat();
      try {
        let text = await handler(args);
        if (name !== 'comm_inbox' && name !== 'comm_wait') text += inboxFooter();
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

function markLeft() {
  try {
    const s = loadSession(NAME);
    if (s && s.pid === process.pid) {
      writeJSONAtomic(sessionFile(NAME), { ...s, state: 'offline', last_seen: nowISO() });
    }
  } catch { /* ignore */ }
}

process.stdin.on('end', () => { markLeft(); process.exit(0); });
process.on('SIGTERM', () => { markLeft(); process.exit(0); });
process.on('SIGINT', () => { markLeft(); process.exit(0); });
