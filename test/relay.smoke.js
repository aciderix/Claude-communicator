#!/usr/bin/env node
/* Test de fumée du mode relais : un relais sécurisé + deux instances du
 * serveur MCP (alice & bob) qui communiquent à travers lui, comme si elles
 * étaient sur deux machines différentes. */
'use strict';

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SECRET = crypto.randomBytes(24).toString('base64url');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const RELAY_URL = `http://127.0.0.1:${PORT}`;

class Client {
  constructor(name, token = SECRET) {
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        CLAUDE_COMM_NAME: name, CLAUDE_COMM_CHANNEL: 'relay-test',
        CLAUDE_COMM_RELAY: RELAY_URL, CLAUDE_COMM_TOKEN: token,
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p(msg); }
      }
    });
  }
  rpc(method, params, timeoutMs = 50000) {
    const id = this.nextId++;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.name}: timeout sur ${method}`)), timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
    });
  }
  async call(tool, args, timeoutMs) {
    const res = await this.rpc('tools/call', { name: tool, arguments: args || {} }, timeoutMs);
    assert(!res.error, `${tool}: erreur RPC ${JSON.stringify(res.error)}`);
    return { text: res.result.content[0].text, isError: !!res.result.isError };
  }
  close() { this.proc.stdin.end(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, label) {
  assert(cond, `ÉCHEC : ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

(async () => {
  console.log('démarrage du relais');
  const relay = spawn(process.execPath, [path.join(ROOT, 'relay.js'), '--port', String(PORT), '--secret', SECRET], {
    stdio: ['ignore', 'inherit', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('relais : pas de démarrage')), 8000);
    relay.stderr.on('data', (d) => {
      process.stderr.write(d);
      if (String(d).includes("à l'écoute")) { clearTimeout(t); resolve(); }
    });
  });

  let alice, bob, mallory;
  try {
    console.log('sécurité HTTP');
    const noAuth = await fetch(`${RELAY_URL}/c/relay-test/sessions`);
    ok(noAuth.status === 401, 'requête sans jeton → 401');
    const badAuth = await fetch(`${RELAY_URL}/c/relay-test/sessions`, { headers: { authorization: 'Bearer mauvais-jeton' } });
    ok(badAuth.status === 401, 'mauvais jeton → 401');
    const health = await fetch(`${RELAY_URL}/healthz`);
    ok(health.status === 200, 'healthz accessible sans jeton');
    ok(execFileSync(process.execPath, [path.join(ROOT, 'relay.js'), 'gen-token'], { encoding: 'utf8' }).trim().length >= 32, 'gen-token produit un secret fort');

    console.log('connexion des deux sessions via le relais');
    alice = new Client('alice');
    bob = new Client('bob');
    await alice.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    await bob.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    await alice.call('comm_join', { role: 'backend', task: 'API' });
    const joinB = await bob.call('comm_join', { role: 'frontend' });
    ok(joinB.text.includes('alice') && joinB.text.includes(RELAY_URL), 'bob voit alice via le relais');

    console.log('messagerie temps réel à travers le relais');
    await bob.call('comm_inbox', {});   // purge les notifications d'arrivée
    await alice.call('comm_inbox', {});
    const waitP = bob.call('comm_inbox', { wait_seconds: 15 }, 40000);
    await sleep(1000);
    await alice.call('comm_send', { to: 'bob', kind: 'question', body: 'Quel module prends-tu ?' });
    const got = await waitP;
    ok(got.text.includes('Quel module prends-tu ?'), 'message reçu en direct (long-poll)');
    const msgId = got.text.match(/\[([0-9a-f]{8})\]/)[1];
    await bob.call('comm_send', { to: 'alice', body: 'Le frontend.', reply_to: msgId });
    const inboxA = await alice.call('comm_inbox', { wait_seconds: 10 }, 30000);
    ok(inboxA.text.includes('réponse à ' + msgId), 'réponse liée reçue');

    console.log('état live');
    await alice.call('comm_status_set', { state: 'working', task: 'endpoints', progress: '1/4' });
    const st = await bob.call('comm_status_get', { peer: 'alice' });
    ok(st.text.includes('working') && st.text.includes('1/4'), 'état lu à travers le relais');

    console.log('tâches et verrous (atomicité côté relais)');
    await alice.call('comm_task', { action: 'add', title: 'Module A' });
    const nextB = await bob.call('comm_task', { action: 'next' });
    ok(nextB.text.includes('T1'), 'bob prend T1');
    const claimA = await alice.call('comm_task', { action: 'claim', id: 'T1' });
    ok(claimA.isError && claimA.text.includes('déjà prise'), 'claim concurrent refusé');
    await alice.call('comm_lock', { action: 'acquire', paths: ['src/core'] });
    const lockB = await bob.call('comm_lock', { action: 'acquire', paths: ['src/core/x.js'] });
    ok(lockB.text.includes('Verrou refusé'), 'conflit de verrou détecté côté relais');

    console.log('services auto-répondus (diff / fichier entre "machines")');
    const diff = await bob.call('comm_diff', { peer: 'alice', mode: 'stat' }, 45000);
    ok(diff.text.includes('git status'), "comm_diff répondu automatiquement par l'instance d'alice");
    const file = await bob.call('comm_file', { peer: 'alice', path: 'package.json' }, 45000);
    ok(file.text.includes('claude-comm'), "comm_file répondu automatiquement par l'instance d'alice");
    const escape = await bob.call('comm_file', { peer: 'alice', path: '../secrets' }, 45000);
    ok(escape.text.includes('refusé'), 'confinement des chemins appliqué côté pair');

    console.log('journal et comm_wait via long-poll');
    const waitTasks = bob.call('comm_wait', { until: 'tasks', timeout_seconds: 20 }, 40000);
    await sleep(800);
    await alice.call('comm_note', { action: 'add', text: 'Convention : tests sous tests/' });
    await alice.call('comm_task', { action: 'add', title: 'Module B' });
    const wt = await waitTasks;
    ok(wt.text.includes('tableau de tâches a changé'), 'comm_wait until=tasks réveillé par le long-poll');
    const notes = await bob.call('comm_note', { action: 'list' });
    ok(notes.text.includes('Convention'), 'journal partagé via le relais');

    console.log('feuille de route, revue et overview via le relais');
    await alice.call('comm_plan', { action: 'goal', text: 'API v2 en production' });
    await bob.call('comm_plan', { action: 'add', title: 'Spec validée' });
    const pl = await alice.call('comm_plan', { action: 'list' });
    ok(pl.text.includes('API v2') && pl.text.includes('M1'), 'feuille de route complétée à travers le relais');
    const rr = await alice.call('comm_review', { action: 'request', to: 'bob', title: 'revue endpoints' });
    ok(rr.text.includes('R1'), 'revue demandée via le relais');
    const appr = await bob.call('comm_review', { action: 'approve', id: 'R1' });
    ok(appr.text.includes('approved'), 'revue approuvée via le relais');
    const ov = await bob.call('comm_overview', {});
    ok(ov.text.includes('API v2') && ov.text.includes('Sessions'), 'overview agrégé via le relais');

    console.log('client avec mauvais jeton');
    mallory = new Client('mallory', 'jeton-invalide');
    await mallory.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const denied = await mallory.call('comm_peers', {});
    ok(denied.isError && denied.text.includes('Non autorisé'), 'outils refusés sans jeton valide');

    console.log('hook en mode relais');
    await alice.call('comm_send', { to: 'bob', body: 'note pour le hook' });
    const hookOut = execFileSync(process.execPath, [path.join(ROOT, 'hooks', 'comm-hook.js')], {
      env: {
        ...process.env, CLAUDE_COMM_NAME: 'bob', CLAUDE_COMM_CHANNEL: 'relay-test',
        CLAUDE_COMM_RELAY: RELAY_URL, CLAUDE_COMM_TOKEN: SECRET,
      },
      input: JSON.stringify({ hook_event_name: 'PostToolUse' }),
      encoding: 'utf8',
    });
    ok(JSON.parse(hookOut).hookSpecificOutput.additionalContext.includes('note pour le hook'),
      'le hook relève la boîte via le relais');

    console.log(`\n✅ ${passed} assertions OK (mode relais)`);
  } finally {
    for (const c of [alice, bob, mallory]) { try { c && c.close(); } catch { /* déjà fermé */ } }
    await sleep(300);
    relay.kill('SIGTERM');
  }
  process.exit(0);
})().catch((e) => { console.error('\n❌', e.message); process.exit(1); });
