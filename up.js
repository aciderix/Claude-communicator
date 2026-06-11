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
  const file = path.join(PROJECT, '.mcp.json');
  let json = {};
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* absent */ }
  const entry = { command: 'node', args: [path.join(ROOT, 'server.js')] };
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
      if (process.platform !== 'linux') {
        console.error('⚠️  cloudflared introuvable. Installe-le (brew install cloudflared / https://github.com/cloudflare/cloudflared/releases) et relance. Tunnel ignoré.');
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
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 30000);
    let buf = '';
    child.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
  });
}

// --- 2. relais ----------------------------------------------------------------

const children = [];

function shutdown() {
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* déjà mort */ } }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
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
  if (!ready) { console.error('❌ Le relais ne démarre pas (port déjà pris ?).'); shutdown(); }

  const mcpFile = writeMcpJson();
  const hooksFile = ARGS.hooks ? writeHooks() : null;
  const publicUrl = ARGS.tunnel ? await startTunnel(ARGS.tunnel === true ? 'cloudflared' : ARGS.tunnel) : null;
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
  console.log(`\n📄 Écrit : ${mcpFile}${hooksFile ? ` + ${hooksFile} (hooks)` : ''}`);
  if (!hooksFile) console.log(`   (relance avec --hooks pour les notifications en direct + détection compaction)`);
  console.log(`\nCtrl+C pour tout arrêter. Jeton complet : ${SECRET}`);
  console.log(sep);
})();
