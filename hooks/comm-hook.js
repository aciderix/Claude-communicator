#!/usr/bin/env node
/*
 * Hook Claude Code pour claude-comm. Selon l'événement :
 *
 *  - UserPromptSubmit / PostToolUse : heartbeat "modèle actif" + injection
 *    des messages en attente dans le contexte (notifications en direct).
 *  - Stop : heartbeat "modèle actif" (fin de réponse).
 *  - PreCompact : signale aux pairs que le contexte va être compacté.
 *  - SessionStart (source=compact) : signale la compaction aux pairs et
 *    rappelle à la session de se resynchroniser (comm_overview + comm_inbox).
 *  - SessionEnd : marque la session offline et prévient les pairs.
 *
 * Grâce à ces signaux, chaque session sait si l'autre est indisponible
 * (limite d'usage, attente d'input) ou a perdu du contexte (compaction).
 *
 * À brancher via examples/settings.hooks.json. Variables d'environnement :
 *   CLAUDE_COMM_NAME (requis), CLAUDE_COMM_CHANNEL, CLAUDE_COMM_HUB
 *   et en mode relais : CLAUDE_COMM_RELAY, CLAUDE_COMM_TOKEN
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const sanitize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);

const NAME = sanitize(process.env.CLAUDE_COMM_NAME);
if (!NAME) process.exit(0);

const CHANNEL = sanitize(process.env.CLAUDE_COMM_CHANNEL || 'default');
const RELAY = String(process.env.CLAUDE_COMM_RELAY || '').replace(/\/+$/, '');
const TOKEN = process.env.CLAUDE_COMM_TOKEN || '';
const HUB = path.resolve(process.env.CLAUDE_COMM_HUB || path.join(os.homedir(), '.claude-comm'));
const CHAN_DIR = path.join(HUB, CHANNEL);

const nowISO = () => new Date().toISOString();
const newId = () => crypto.randomBytes(4).toString('hex');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return '{}'; }
}

// --- accès au canal (fichier ou relais), best effort ------------------------

async function rfetch(method, p, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(`${RELAY}/c/${CHANNEL}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'bypass-tunnel-reminder': '1',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    return res.ok ? res.json() : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function patchSession(patch) {
  if (RELAY) { await rfetch('POST', `/sessions/${NAME}`, patch); return; }
  const file = path.join(CHAN_DIR, 'sessions', `${NAME}.json`);
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...s, ...patch, last_seen: nowISO() }, null, 2));
  } catch { /* session pas encore enregistrée */ }
}

async function notifyPeers(subject, body) {
  if (RELAY) {
    await rfetch('POST', '/messages', { from: NAME, to: '*', kind: 'notify', subject, body });
    return;
  }
  let sessions = [];
  try {
    sessions = fs.readdirSync(path.join(CHAN_DIR, 'sessions'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .filter((n) => n !== NAME);
  } catch { return; }
  for (const to of sessions) {
    try {
      const dir = path.join(CHAN_DIR, 'inbox', to, 'new');
      fs.mkdirSync(dir, { recursive: true });
      const msg = { id: newId(), from: NAME, to, kind: 'notify', subject, body, reply_to: null, ts: nowISO() };
      fs.writeFileSync(path.join(dir, `${Date.now()}-${msg.id}.json`), JSON.stringify(msg, null, 2));
    } catch { /* best effort */ }
  }
}

async function collectMessages() {
  if (RELAY) {
    const data = await rfetch('GET', `/inbox/${NAME}?consume=1`);
    return (data && data.messages) || [];
  }
  const newDir = path.join(CHAN_DIR, 'inbox', NAME, 'new');
  const readDir = path.join(CHAN_DIR, 'inbox', NAME, 'read');
  let files = [];
  try { files = fs.readdirSync(newDir).sort(); } catch { return []; }
  const msgs = [];
  for (const f of files) {
    try {
      msgs.push(JSON.parse(fs.readFileSync(path.join(newDir, f), 'utf8')));
      fs.mkdirSync(readDir, { recursive: true });
      fs.renameSync(path.join(newDir, f), path.join(readDir, f));
    } catch { /* message corrompu : on le laisse */ }
  }
  return msgs;
}

function emitContext(event, context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  }));
}

function messagesContext(msgs) {
  const lines = msgs.map((m) =>
    `- [${m.id}] de ${m.from} (${m.kind}${m.subject ? ` · ${m.subject}` : ''}) : ${m.body}`);
  return `🔔 claude-comm — ${msgs.length} message(s) reçu(s) d'autres sessions Claude :\n` +
    lines.join('\n') +
    `\nSi un message est de type question/status_request/diff_request, réponds via comm_send (reply_to=<id>). ` +
    `Si le sujet contient "claim id=Ux", fais comm_user action=claim avant toute réponse à l'utilisateur. ` +
    `Tiens compte de ces informations pour la coordination.`;
}

// --- dispatch par événement --------------------------------------------------

(async () => {
  let input = {};
  try { input = JSON.parse(readStdin()); } catch { /* défaut */ }
  const event = input.hook_event_name || 'UserPromptSubmit';

  switch (event) {
    case 'Stop':
    case 'SubagentStop': {
      await patchSession({ last_model_seen: nowISO() });
      // REVEIL : avant que la session ne devienne inactive, si des messages
      // de coordination sont arrives pendant son travail, on EMPECHE l'arret
      // et on les injecte -> la session les traite au lieu de s'endormir avec
      // des messages non lus. (Boucle bornee : les messages sont consommes,
      // donc le prochain Stop sans message s'arrete normalement.)
      if (input.stop_hook_active) return; // evite toute reentrance
      const msgs = await collectMessages();
      if (msgs.length) {
        process.stdout.write(JSON.stringify({
          decision: 'block',
          reason: messagesContext(msgs) +
            '\nTraite ces messages maintenant (reponds via comm_send/comm_user si besoin), ' +
            'puis tu pourras t\'arreter.',
        }));
      }
      return;
    }

    case 'PreCompact':
      await patchSession({ compacting: true });
      await notifyPeers('♻️ compaction imminente',
        `${NAME} : compaction de contexte imminente (${input.trigger || 'auto'}). ` +
        `Ses détails récents vont être résumés — re-précise-lui les points critiques après coup si besoin.`);
      return;

    case 'SessionEnd':
      await patchSession({ state: 'offline' });
      await notifyPeers('session terminée',
        `${NAME} a quitté (${input.reason || 'fin de session'}). Ne compte plus sur lui ; réassigne ses tâches si nécessaire.`);
      return;

    case 'SessionStart': {
      const compacted = input.source === 'compact';
      await patchSession(compacted
        ? { compacting: false, compacted_at: nowISO(), last_model_seen: nowISO() }
        : { state: 'idle', last_model_seen: nowISO() });
      if (compacted) {
        await notifyPeers('♻️ contexte compacté',
          `${NAME} vient d'être compacté : il peut avoir perdu des détails récents. ` +
          `Re-précise-lui les décisions/conventions critiques si vous étiez en plein échange.`);
      }
      const msgs = await collectMessages();
      const parts = [];
      if (compacted) {
        parts.push(`♻️ Ton contexte vient d'être compacté. Resynchronise-toi : appelle comm_overview ` +
          `(feuille de route, tâches, revues) puis comm_note action=list (décisions d'équipe). ` +
          `Tes pairs ont été prévenus.`);
      }
      if (msgs.length) parts.push(messagesContext(msgs));
      if (parts.length) emitContext(event, parts.join('\n\n'));
      return;
    }

    case 'UserPromptSubmit':
    case 'PostToolUse':
    default: {
      await patchSession({ last_model_seen: nowISO() });
      const msgs = await collectMessages();
      if (msgs.length) emitContext(event, messagesContext(msgs));
      return;
    }
  }
})();
