#!/usr/bin/env node
/*
 * Hook Claude Code : injecte les messages claude-comm en attente dans le
 * contexte de la session, pour des notifications "en direct" sans que le
 * modèle ait besoin d'appeler comm_inbox.
 *
 * À brancher sur UserPromptSubmit et/ou PostToolUse (voir examples/settings.hooks.json).
 * Utilise les mêmes variables d'environnement que server.js :
 *   CLAUDE_COMM_NAME, CLAUDE_COMM_CHANNEL, CLAUDE_COMM_HUB
 *
 * Note : si CLAUDE_COMM_NAME n'est pas défini, le hook ne fait rien (il ne
 * peut pas deviner la boîte à relever).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const NAME = (process.env.CLAUDE_COMM_NAME || '')
  .toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
if (!NAME) process.exit(0);

const HUB = path.resolve(process.env.CLAUDE_COMM_HUB || path.join(os.homedir(), '.claude-comm'));
const CHANNEL = (process.env.CLAUDE_COMM_CHANNEL || 'default')
  .toLowerCase().replace(/[^a-z0-9_-]/g, '-');

const NEW_DIR = path.join(HUB, CHANNEL, 'inbox', NAME, 'new');
const READ_DIR = path.join(HUB, CHANNEL, 'inbox', NAME, 'read');
const SESSION_FILE = path.join(HUB, CHANNEL, 'sessions', `${NAME}.json`);

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return '{}'; }
}

// Heartbeat : signale aux pairs que cette session est vivante.
try {
  const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  s.last_seen = new Date().toISOString();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
} catch { /* session pas encore enregistrée */ }

let files = [];
try { files = fs.readdirSync(NEW_DIR).sort(); } catch { /* pas de boîte */ }
if (!files.length) process.exit(0);

const msgs = [];
for (const f of files) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(NEW_DIR, f), 'utf8'));
    msgs.push(m);
    fs.mkdirSync(READ_DIR, { recursive: true });
    fs.renameSync(path.join(NEW_DIR, f), path.join(READ_DIR, f));
  } catch { /* message corrompu : on le laisse */ }
}
if (!msgs.length) process.exit(0);

const lines = msgs.map((m) =>
  `- [${m.id}] de ${m.from} (${m.kind}${m.subject ? ` · ${m.subject}` : ''}) : ${m.body}`
);
const context =
  `🔔 claude-comm — ${msgs.length} message(s) reçu(s) d'autres sessions Claude :\n` +
  lines.join('\n') +
  `\nSi un message est de type question/status_request/diff_request, réponds via comm_send (reply_to=<id>). ` +
  `Tiens compte de ces informations pour la coordination.`;

let event = 'UserPromptSubmit';
try {
  const input = JSON.parse(readStdin());
  if (input.hook_event_name) event = input.hook_event_name;
} catch { /* défaut */ }

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: event, additionalContext: context },
}));
