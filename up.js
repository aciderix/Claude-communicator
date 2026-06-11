#!/usr/bin/env node
/*
 * claude-comm up — démarrage tout-en-un, autonome (aucun service tiers
 * par défaut) :
 *
 *   node up.js [--project /chemin/projet] [--channel equipe]
 *              [--sessions alice,bob] [--port 8787]
 *              [--tunnel cloudflared|ngrok] [--hooks]
 *
 * En une commande :
 *  1. génère/réutilise un secret (~/.claude-comm/up.json)
 *  2. lance le relais (LAN, persistance, appairage mobile activé)
 *  3. écrit le .mcp.json du projet (sans secret → committable)
 *  4. (--hooks) branche les hooks de notification dans .claude/settings.json
 *  5. affiche : URL mobile + code d'appairage à 6 chiffres, commandes
 *     prêtes à coller pour chaque session Claude, commandes humaines
 *  6. (--tunnel) expose aussi le relais publiquement pour l'extérieur
 *
 * Ctrl+C arrête tout proprement.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

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
const ROOT = __dirname;
const HOME_DIR = path.join(os.homedir(), '.claude-comm');
const PORT = Number(ARGS.port || 8787);
const CHANNEL = String(ARGS.channel || 'default');
const PROJECT = path.resolve(ARGS.project || process.cwd());
const SESSIONS = String(ARGS.sessions || 'alice,bob').split(',').map((s) => s.trim()).filter(Boolean);

// --- 1. secret persistant -----------------------------------------------

fs.mkdirSync(HOME_DIR, { recursive: true });
const UP_CONF = path.join(HOME_DIR, 'up.json');
let conf = {};
try { conf = JSON.parse(fs.readFileSync(UP_CONF, 'utf8')); } catch { /* première fois */ }
if (!conf.secret) {
  conf.secret = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(UP_CONF, JSON.stringify(conf, null, 2), { mode: 0o600 });
}
const SECRET = conf.secret;

// --- réseau local ----------------------------------------------------------

function lanIPs() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

// --- 3. .mcp.json du projet (sans secret : committable) --------------------

function writeMcpJson() {
  if (!fs.existsSync(PROJECT)) {
    console.error(`⚠️  Projet introuvable (${PROJECT}) — .mcp.json non écrit.`);
    console.error('    Relance avec --project <dossier où tu lances claude>, ou sans --project pour utiliser le dossier courant.');
    return null;
  }
  const file = path.join(PROJECT, '.mcp.json');
  const serverAbs = path.join(ROOT, 'server.js');
  const rel = path.relative(PROJECT, serverAbs);
  const serverPath = rel.startsWith('..') ? serverAbs : `./${rel}`;
  let json = {};
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* absent */ }
  const entry = { command: 'node', args: [serverPath] };
  const existing = JSON.stringify((json.mcpServers || {}).comm);
  if (existing && existing !== JSON.stringify(entry)) {
    fs.copyFileSync(file, `${file}.bak`);
  }
  json.mcpServers = { ...(json.mcpServers || {}), comm: entry };
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  return file;
}

// --- 4. hooks (optionnel) ---------------------------------------------------

const HOOK_EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop', 'PreCompact', 'SessionStart', 'SessionEnd'];

function writeHooks() {
  if (!fs.existsSync(PROJECT)) return null;
  const dir = path.join(PROJECT, '.claude');
  const file = path.join(dir, 'settings.json');
  fs.mkdirSync(dir, { recursive: true });
  let json = {};
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); fs.copyFileSync(file, `${file}.bak`); }
  catch { /* absent */ }
  const command = `node ${path.join(ROOT, 'hooks', 'comm-hook.js')}`;
  json.hooks = json.hooks || {};
  for (const ev of HOOK_EVENTS) {
    const entries = json.hooks[ev] = json.hooks[ev] || [];
    const already = JSON.stringify(entries).includes('comm-hook.js');
    if (!already) {
      const entry = { hooks: [{ type: 'command', command }] };
      if (ev === 'PostToolUse') entry.matcher = '*';
      entries.push(entry);
    }
  }
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  return file;
}

// --- 6. tunnel public optionnel ----------------------------------------------

async function startTunnel(kind) {
  if (kind === 'pinggy') {
    // Tunnel SSH sur le port 443 (Termux : pkg install openssh).
    // Gratuit sans compte ; sessions limitées à ~60 min, relancer au besoin.
    try { execFileSync('ssh', ['-V'], { stdio: 'ignore' }); }
    catch { console.error('⚠️  ssh introuvable (Termux : pkg install openssh). Tunnel ignoré.'); return null; }
    const child = spawn('ssh', ['-p', '443',
      '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes',
      // auth "none" d'abord (souvent aucun prompt) ; sinon prompt mot de
      // passe : il suffit d'appuyer sur Entrée (mode anonyme pinggy)
      '-o', 'PreferredAuthentications=none,password',
      `-R0:127.0.0.1:${PORT}`, 'qr@free.pinggy.io'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    console.error('⏳ Tunnel pinggy via SSH… Si « password: » s\'affiche, appuie simplement sur Entrée.');
    const url = await new Promise((resolve) => {
      let buf = '';
      let resolved = false;
      const finish = (v) => { if (!resolved) { resolved = true; resolve(v); } };
      const timer = setTimeout(() => {
        console.error('⚠️  Pas d\'URL pinggy après 75 s. Si le prompt « password: » est affiché, appuie sur Entrée — l\'URL s\'affichera ci-dessous.');
        finish(null);
      }, 75000);
      const scan = (d) => {
        buf += d;
        const m = buf.match(/https:\/\/[a-z0-9.-]+\.pinggy\.link/i);
        if (m) {
          clearTimeout(timer);
          if (resolved) console.log(`\n🌐 Tunnel établi (tardivement) — URL publique : ${m[0]}\n`);
          finish(m[0]);
        }
      };
      child.stdout.on('data', scan);
      child.stderr.on('data', scan);
      child.on('exit', (code) => {
        if (!resolved) {
          clearTimeout(timer);
          console.error(`⚠️  ssh s'est arrêté (code ${code}).${buf.trim() ? `\n    ${buf.trim().split('\n').slice(-3).join('\n    ')}` : ''}`);
          finish(null);
        }
      });
    });
    if (url) console.error('ℹ️  Tunnel pinggy gratuit : ~60 min par session, relance up.js si l\'URL expire.');
    return url;
  }
  if (kind === 'ngrok') {
    try { execFileSync('ngrok', ['version'], { stdio: 'ignore' }); }
    catch { console.error('⚠️  ngrok introuvable dans le PATH (et il faut NGROK_AUTHTOKEN). Tunnel ignoré.'); return null; }
    const child = spawn('ngrok', ['http', String(PORT), '--log', 'stdout', '--log-format', 'logfmt'], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 20000);
      child.stdout.on('data', (d) => {
        const m = String(d).match(/url=(https:\/\/[^\s]+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
    });
  }
  // cloudflared (défaut) : binaire du PATH, ou téléchargé dans ~/.claude-comm/bin
  let bin = 'cloudflared';
  try { execFileSync(bin, ['--version'], { stdio: 'ignore' }); }
  catch {
    bin = path.join(HOME_DIR, 'bin', 'cloudflared');
    if (!fs.existsSync(bin)) {
      // Termux/Android : process.platform === 'android', le binaire linux statique fonctionne.
      const linuxLike = process.platform === 'linux' || process.platform === 'android';
      if (!linuxLike) {
        console.error('⚠️  cloudflared introuvable. Installe-le (brew install cloudflared / https://github.com/cloudflare/cloudflared/releases) et relance, ou utilise --tunnel pinggy. Tunnel ignoré.');
        return null;
      }
      console.error('⬇️  Téléchargement de cloudflared…');
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
      try {
        execFileSync('curl', ['-sL', '--max-time', '120', '-o', bin,
          `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`]);
        fs.chmodSync(bin, 0o755);
      } catch (e) {
        console.error(`⚠️  Téléchargement impossible (${e.message}). Tunnel ignoré.`);
        return null;
      }
    }
  }
  const child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  console.error('⏳ Établissement du tunnel cloudflared (jusqu\'à 90 s, surtout sur mobile)…');
  return new Promise((resolve) => {
    let buf = '';
    let resolved = false;
    const finish = (v) => { if (!resolved) { resolved = true; resolve(v); } };
    const timer = setTimeout(() => {
      const errs = (buf.match(/ERR.*$/gm) || []).slice(-3).join('\n    ');
      if (errs) console.error(`⚠️  cloudflared en difficulté :\n    ${errs}`);
      console.error('    Le tunnel peut encore s\'établir : son URL s\'affichera alors ci-dessous.');
      console.error('    Sinon, plan B sans binaire : pkg install openssh && node up.js --tunnel pinggy');
      finish(null);
    }, 90000);
    child.stderr.on('data', (d) => {
      buf += d;
      // ignorer api.trycloudflare.com (endpoint interne des logs cloudflared) :
      // l'URL attribuée est du type https://mots-aleatoires.trycloudflare.com
      const urls = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g) || [];
      const real = urls.find((u) => u !== 'https://api.trycloudflare.com');
      if (real) {
        clearTimeout(timer);
        if (resolved) console.log(`\n🌐 Tunnel établi (tardivement) — URL publique : ${real}\n`);
        finish(real);
      }
    });
    child.on('exit', (code) => {
      if (!resolved) {
        clearTimeout(timer);
        const errs = (buf.match(/ERR.*$/gm) || []).slice(-3).join('\n    ');
        console.error(`⚠️  cloudflared s'est arrêté (code ${code}).${errs ? `\n    ${errs}` : ''}`);
        console.error('    Plan B sans binaire : pkg install openssh && node up.js --tunnel pinggy');
        finish(null);
      }
    });
  });
}

// --- 2. relais ----------------------------------------------------------------

const children = [];

function killChildren() {
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* déjà mort */ } }
}

function shutdown() { killChildren(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', killChildren);
process.on('uncaughtException', (e) => { console.error(`❌ ${e.message}`); killChildren(); process.exit(1); });

// Un relais tourne déjà sur ce port ? S'il utilise notre secret (lancement
// précédent), on le réutilise au lieu d'échouer sur EADDRINUSE.
async function probeExisting() {
  const t = (ms) => ({ signal: AbortSignal.timeout(ms) });
  try {
    const h = await fetch(`http://127.0.0.1:${PORT}/healthz`, t(1500));
    if (!h.ok) return 'busy';
    const data = await h.json().catch(() => null);
    if (!data || data.ok !== true) return 'busy';
    const c = await fetch(`http://127.0.0.1:${PORT}/channels`,
      { headers: { authorization: `Bearer ${SECRET}` }, ...t(1500) });
    return c.ok ? 'ours' : 'other';
  } catch { return 'free'; }
}

(async () => {
  const probe = await probeExisting();
  if (probe === 'busy' || probe === 'other') {
    console.error(`❌ Le port ${PORT} est occupé par ${probe === 'other' ? 'un relais utilisant un autre secret' : 'un autre service'}.`);
    console.error(`   Arrête-le (pkill -f relay.js) ou relance avec --port ${PORT + 1}.`);
    process.exit(1);
  }
  const reused = probe === 'ours';

  if (reused) {
    console.error(`♻️  Un relais claude-comm tourne déjà sur le port ${PORT} avec ce secret — je le réutilise.`);
    let code = null;
    try {
      const d = await (await fetch(`http://127.0.0.1:${PORT}/pair-code`,
        { headers: { authorization: `Bearer ${SECRET}` }, signal: AbortSignal.timeout(1500) })).json();
      code = d.code || null;
    } catch { /* ancienne version sans /pair-code */ }
    if (code) console.error(`📱 Code d'appairage dashboard : ${code}`);
    else {
      console.error(`ℹ️  Code d'appairage indisponible (relais d'une version précédente) :`);
      console.error(`    utilise le jeton complet dans le dashboard, ou redémarre proprement :`);
      console.error(`    pkill -f relay.js  puis relance up.js`);
    }
  } else {
    const relay = spawn(process.execPath, [
      path.join(ROOT, 'relay.js'),
      '--host', '0.0.0.0', '--port', String(PORT),
      '--secret', SECRET, '--data', path.join(HOME_DIR, 'relay-data'),
      '--pair',
    ], { stdio: ['ignore', 'inherit', 'pipe'] });
    children.push(relay);
    relay.on('exit', (code) => {
      console.error(`Le relais s'est arrêté (code ${code}).`);
      process.exit(code || 1);
    });

    // relaie la sortie du relais (codes d'appairage inclus) et attend l'écoute
    let ready = false;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 8000);
      relay.stderr.on('data', (d) => {
        process.stderr.write(d);
        if (!ready && String(d).includes("à l'écoute")) { ready = true; clearTimeout(timer); resolve(); }
      });
    });
    if (!ready) { console.error('❌ Le relais ne démarre pas.'); killChildren(); process.exit(1); }
  }

  let mcpFile = null, hooksFile = null, publicUrl = null;
  try { mcpFile = writeMcpJson(); } catch (e) { console.error(`⚠️  .mcp.json non écrit : ${e.message}`); }
  try { hooksFile = ARGS.hooks ? writeHooks() : null; } catch (e) { console.error(`⚠️  hooks non écrits : ${e.message}`); }
  try {
    publicUrl = ARGS.tunnel ? await startTunnel(ARGS.tunnel === true ? 'cloudflared' : ARGS.tunnel) : null;
  } catch (e) { console.error(`⚠️  tunnel : ${e.message}`); }
  if (ARGS.tunnel && !publicUrl) console.error('⚠️  Tunnel non établi — accès LAN uniquement.');

  const ips = lanIPs();
  const lanUrl = ips.length ? `http://${ips[0]}:${PORT}` : `http://<ip-du-pc>:${PORT}`;
  const localUrl = `http://127.0.0.1:${PORT}`;
  const sep = '─'.repeat(64);

  console.log(`\n${sep}`);
  console.log('🛰  claude-comm est prêt');
  console.log(sep);
  console.log(`\n📱 DASHBOARD (téléphone / navigateur)`);
  console.log(`   Même WiFi : ${lanUrl}`);
  if (publicUrl) console.log(`   Extérieur : ${publicUrl}`);
  console.log(`   → saisis le code d'appairage à 6 chiffres affiché ci-dessus.`);
  console.log(`\n💻 SESSIONS CLAUDE (un terminal chacune, dans ${PROJECT})`);
  SESSIONS.forEach((name) => {
    console.log(`   CLAUDE_COMM_NAME=${name} CLAUDE_COMM_CHANNEL=${CHANNEL} \\`);
    console.log(`   CLAUDE_COMM_RELAY=${localUrl} CLAUDE_COMM_TOKEN=${SECRET} claude`);
  });
  console.log(`   (autre machine : remplace ${localUrl} par ${publicUrl || lanUrl})`);
  console.log(`\n🧑 HUMAIN (CLI)`);
  console.log(`   export CLAUDE_COMM_RELAY=${localUrl} CLAUDE_COMM_TOKEN=${SECRET} CLAUDE_COMM_CHANNEL=${CHANNEL}`);
  console.log(`   node ${path.join(ROOT, 'server.js')} status | questions | answer Qx "..." | standup 30`);
  if (mcpFile) {
    console.log(`\n📄 Écrit : ${mcpFile}${hooksFile ? ` + ${hooksFile} (hooks)` : ''}`);
    if (!hooksFile) console.log(`   (relance avec --hooks pour les notifications en direct + détection compaction)`);
  }
  console.log(reused
    ? `\nRelais réutilisé (pour tout arrêter : pkill -f relay.js). Jeton complet : ${SECRET}`
    : `\nCtrl+C pour tout arrêter. Jeton complet : ${SECRET}`);
  console.log(sep);
})();
