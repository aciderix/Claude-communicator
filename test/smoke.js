#!/usr/bin/env node
/* Test de fumée : deux instances du serveur (alice & bob) sur un hub
 * temporaire, exercées via JSON-RPC stdio comme le ferait Claude Code. */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SERVER = path.join(__dirname, '..', 'server.js');
const HUB = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-comm-test-'));

class Client {
  constructor(name) {
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, CLAUDE_COMM_NAME: name, CLAUDE_COMM_HUB: HUB, CLAUDE_COMM_CHANNEL: 'test' },
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
  rpc(method, params, timeoutMs = 15000) {
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
  const alice = new Client('alice');
  const bob = new Client('bob');
  try {
    console.log('initialisation');
    const initA = await alice.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    ok(initA.result.serverInfo.name === 'claude-comm', 'initialize alice');
    await bob.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const toolsList = await alice.rpc('tools/list', {});
    ok(toolsList.result.tools.length === 10, 'tools/list expose 10 outils');

    console.log('join & peers');
    await alice.call('comm_join', { role: 'backend', task: 'API' });
    const joinB = await bob.call('comm_join', { role: 'frontend' });
    ok(joinB.text.includes('alice'), 'bob voit alice au join');
    const peers = await alice.call('comm_peers', {});
    ok(peers.text.includes('bob') && peers.text.includes('frontend'), 'comm_peers liste bob et son rôle');

    console.log('messagerie');
    const sent = await alice.call('comm_send', { to: 'bob', kind: 'question', body: 'Tu prends quel module ?' });
    ok(sent.text.includes('envoyé à bob'), 'envoi alice → bob');
    const inboxB = await bob.call('comm_inbox', {});
    ok(inboxB.text.includes('Tu prends quel module ?'), 'bob reçoit le message');
    ok(inboxB.text.includes('attendent une réponse'), 'la question est signalée comme à répondre');
    const msgId = inboxB.text.match(/\[([0-9a-f]{8})\]/)[1];
    await bob.call('comm_send', { to: 'alice', body: 'Je prends le frontend.', reply_to: msgId });
    const inboxA = await alice.call('comm_inbox', {});
    ok(inboxA.text.includes('réponse à ' + msgId), 'alice reçoit la réponse liée');
    const badSend = await alice.call('comm_send', { to: 'charlie', body: 'hello' });
    ok(badSend.isError && badSend.text.includes('Pair inconnu'), 'envoi vers pair inconnu refusé');

    console.log('état live');
    await alice.call('comm_status_set', { state: 'working', task: 'endpoints REST', progress: '2/6' });
    const st = await bob.call('comm_status_get', { peer: 'alice' });
    ok(st.text.includes('working') && st.text.includes('2/6'), 'bob lit l\'état live d\'alice');
    await alice.call('comm_status_set', { state: 'blocked', detail: 'conflit de schéma' });
    const notif = await bob.call('comm_inbox', {});
    ok(notif.text.includes('blocked'), 'le blocage d\'alice notifie bob');

    console.log('tableau de tâches');
    await alice.call('comm_task', { action: 'add', title: 'Module users' });
    await alice.call('comm_task', { action: 'add', title: 'Module billing' });
    const nextB = await bob.call('comm_task', { action: 'next' });
    ok(nextB.text.includes('T1'), 'bob prend T1 via next');
    const claimA = await alice.call('comm_task', { action: 'claim', id: 'T1' });
    ok(claimA.isError && claimA.text.includes('déjà prise par bob'), 'claim de T1 par alice refusé');
    const nextA = await alice.call('comm_task', { action: 'next' });
    ok(nextA.text.includes('T2'), 'alice prend T2 via next');
    const doneB = await bob.call('comm_task', { action: 'done', id: 'T1', note: 'poussé' });
    ok(doneB.text.includes('terminée'), 'bob termine T1');
    const list = await alice.call('comm_task', { action: 'list' });
    ok(list.text.includes('✅ T1') && list.text.includes('🔵 T2'), 'le tableau reflète T1 done / T2 en cours');

    console.log('verrous');
    await alice.call('comm_lock', { action: 'acquire', paths: ['src/api'], reason: 'refactor' });
    const lockB = await bob.call('comm_lock', { action: 'acquire', paths: ['src/api/users.js'] });
    ok(lockB.text.includes('Verrou refusé'), 'conflit parent/enfant détecté');
    const lockB2 = await bob.call('comm_lock', { action: 'acquire', paths: ['src/ui'] });
    ok(lockB2.text.includes('Verrouillé'), 'chemin disjoint verrouillable');
    await alice.call('comm_lock', { action: 'release' });
    const lockB3 = await bob.call('comm_lock', { action: 'acquire', paths: ['src/api/users.js'] });
    ok(lockB3.text.includes('Verrouillé'), 'verrou disponible après release');

    console.log('attente bloquante');
    await bob.call('comm_inbox', {}); // purge les notifications précédentes
    const waitP = bob.call('comm_inbox', { wait_seconds: 10 }, 20000);
    await sleep(1200);
    await alice.call('comm_send', { to: 'bob', body: 'signal de synchro' });
    const waited = await waitP;
    ok(waited.text.includes('signal de synchro'), 'comm_inbox wait_seconds reçoit en direct');

    const waitTasks = bob.call('comm_wait', { until: 'tasks', timeout_seconds: 10 }, 20000);
    await sleep(800);
    await alice.call('comm_task', { action: 'done', id: 'T2' });
    const wt = await waitTasks;
    ok(wt.text.includes('tableau de tâches a changé'), 'comm_wait until=tasks se déclenche');

    console.log('diff du pair');
    const diff = await bob.call('comm_diff', { peer: 'alice', mode: 'stat' });
    ok(diff.text.includes('git status'), 'comm_diff lit le worktree du pair');

    console.log('notification de non-lus en pied de réponse');
    await alice.call('comm_send', { to: 'bob', body: 'pense à relire' });
    const footer = await bob.call('comm_peers', {});
    ok(footer.text.includes('non lu'), 'les réponses signalent les messages en attente');

    console.log('hook de notification');
    const { execFileSync } = require('child_process');
    const hookOut = execFileSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'comm-hook.js')], {
      env: { ...process.env, CLAUDE_COMM_NAME: 'bob', CLAUDE_COMM_HUB: HUB, CLAUDE_COMM_CHANNEL: 'test' },
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }),
      encoding: 'utf8',
    });
    const hook = JSON.parse(hookOut);
    ok(hook.hookSpecificOutput.additionalContext.includes('pense à relire'), 'le hook injecte le message dans le contexte');
    const hookEmpty = execFileSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'comm-hook.js')], {
      env: { ...process.env, CLAUDE_COMM_NAME: 'bob', CLAUDE_COMM_HUB: HUB, CLAUDE_COMM_CHANNEL: 'test' },
      input: '{}', encoding: 'utf8',
    });
    ok(hookEmpty.trim() === '', 'le hook est silencieux quand la boîte est vide');

    console.log(`\n✅ ${passed} assertions OK`);
  } finally {
    alice.close(); bob.close();
    await sleep(200);
    fs.rmSync(HUB, { recursive: true, force: true });
  }
})().catch((e) => { console.error('\n❌', e.message); process.exit(1); });
