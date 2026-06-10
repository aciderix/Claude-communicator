#!/usr/bin/env node
/*
 * Hook Claude Code : injecte les messages claude-comm en attente dans le
 * contexte de la session, pour des notifications "en direct" sans que le
 * modèle ait besoin d'appeler comm_inbox. Fait aussi office de heartbeat.
 *
 * À brancher sur UserPromptSubmit et/ou PostToolUse (voir examples/settings.hooks.json).
 * Utilise les mêmes variables d'environnement que server.js :
 *   CLAUDE_COMM_NAME (requis), CLAUDE_COMM_CHANNEL, CLAUDE_COMM_HUB
 *   et en mode relais : CLAUDE_COMM_RELAY, CLAUDE_COMM_TOKEN
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const sanitize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);

const NAME = sanitize(process.env.CLAUDE_COMM_NAME);
if (!NAME) process.exit(0);

const CHANNEL = sanitize(process.env.CLAUDE_COMM_CHANNEL || 'default');
const RELAY = String(process.env.CLAUDE_COMM_RELAY || '').replace(/\/+$/, '');
const TOKEN = process.env.CLAUDE_COMM_TOKEN || '';
const HUB = path.resolve(process.env.CLAUDE_COMM_HUB || path.join(os.homedir(), '.claude-comm'));

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return '{}'; }
}

async function collectFile() {
  const newDir = path.join(HUB, CHANNEL, 'inbox', NAME, 'new');
  const readDir = path.join(HUB, CHANNEL, 'inbox', NAME, 'read');
  const sessionFile = path.join(HUB, CHANNEL, 'sessions', `${NAME}.json`);
  try {
    const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    s.last_seen = new Date().toISOString();
    fs.writeFileSync(sessionFile, JSON.stringify(s, null, 2));
  } catch { /* session pas encore enregistrée */ }

  let files = [];
  try { files = fs.readdirSync(newDir).sort(); } catch { return []; }
  const msgs = [];
  for (const f of files) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(newDir, f), 'utf8'));
      msgs.push(m);
      fs.mkdirSync(readDir, { recursive: true });
      fs.renameSync(path.join(newDir, f), path.join(readDir, f));
    } catch { /* message corrompu : on le laisse */ }
  }
  return msgs;
}

async function collectRelay() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(`${RELAY}/c/${CHANNEL}/inbox/${NAME}?consume=1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: ctl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.messages || [];
  } catch { return []; }
  finally { clearTimeout(timer); }
}

(async () => {
  const msgs = RELAY ? await collectRelay() : await collectFile();
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
})();
