/* Point d'entrée du Node embarqué dans l'app mobile (nodejs-mobile).
 *
 * Démarre le relais claude-comm DANS le téléphone. Deux canaux de
 * contrôle, pour être insensible aux aléas du plugin :
 *
 *  1. le bridge natif de capacitor-nodejs (s'il fonctionne) ;
 *  2. un mini serveur HTTP local de contrôle/diagnostic sur 127.0.0.1:8788
 *     (GET /diag, POST /start, GET /status) — le WebView et ce process
 *     vivent sur le même appareil, HTTP suffit toujours.
 *
 * Chaque étape et chaque erreur sont consignées dans /diag : plus aucun
 * échec silencieux possible.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const DIAG = { steps: [], errors: [], bridge: false, started: false, info: null };
const step = (s) => { DIAG.steps.push(`${new Date().toISOString()} ${s}`); };
const fail = (s) => { DIAG.errors.push(`${new Date().toISOString()} ${s}`); };

// --- canal 2 : contrôle/diagnostic HTTP (toujours disponible) ---------------

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', ...CORS });
  res.end(body);
}

const ctl = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method === 'GET' && req.url === '/diag') return send(res, 200, DIAG);
  if (req.method === 'GET' && req.url === '/status') {
    return send(res, 200, { started: DIAG.started, info: DIAG.info });
  }
  if (req.method === 'POST' && req.url === '/start') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try { send(res, 200, await startRelay(JSON.parse(body || '{}'))); }
      catch (e) { send(res, 500, { error: String(e.message || e) }); }
    });
    return;
  }
  send(res, 404, { error: 'route inconnue' });
});
ctl.listen(8788, '127.0.0.1', () => step('serveur de contrôle prêt sur 127.0.0.1:8788'));
ctl.on('error', (e) => fail(`serveur de contrôle : ${e.message}`));

// --- relais -------------------------------------------------------------------

function dataDir() {
  // DATADIR est fourni par le plugin ; sinon repli sur homedir/tmp
  const base = process.env.DATADIR || (os.homedir && os.homedir()) || os.tmpdir();
  const d = path.join(base, 'claude-comm');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function lanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

function loadSecret(dir) {
  const file = path.join(dir, 'secret.txt');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s) return s;
  } catch { /* première fois */ }
  const s = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

// Sous-domaine FIXE persisté (comme le jeton) → URL publique STABLE qui ne
// change plus jamais entre redémarrages : on configure agents et connecteur
// claude.ai une seule fois. Forme : claude-comm-<8 hex> (collision quasi nulle).
function loadSubdomain(dir) {
  const file = path.join(dir, 'subdomain.txt');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s) return s;
  } catch { /* première fois */ }
  const s = 'claude-comm-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(file, s);
  return s;
}

let starting = null;

async function startRelay(cfg) {
  cfg = cfg || {};
  if (DIAG.started) return DIAG.info;
  if (starting) return starting;
  starting = (async () => {
    step('startRelay demandé');
    const dir = dataDir();
    const secret = loadSecret(dir);
    const port = Number(cfg.port) || 8787;

    // relay.js lit process.argv au chargement : on les pose puis on l'importe.
    process.argv = ['node', 'relay.js',
      '--host', '0.0.0.0', '--port', String(port),
      '--secret', secret, '--data', path.join(dir, 'relay-data'),
      '--pair'];
    require('./relay.js');
    step(`relais démarré sur ${port}`);

    const subdomain = loadSubdomain(dir);
    DIAG.info = { port, secret, subdomain, lanIp: lanIp(), publicUrl: null };
    DIAG.started = true;

    if (cfg.expose) {
      await openTunnel(port, subdomain);
    }
    return DIAG.info;
  })();
  try { return await starting; }
  catch (e) { starting = null; fail(`startRelay : ${e.message}`); throw e; }
}

// Tunnel public AUTO-CICATRISANT (constaté en test réel : le tunnel meurt
// parfois en pleine utilisation et ne revenait jamais) :
//  - localtunnel maintenu en boucle : à la mort du tunnel, reconnexion avec
//    le MÊME sous-domaine → l'URL publique reste stable pour les agents et
//    le connecteur claude.ai ;
//  - tunnelmole en secours si localtunnel ne s'établit pas.
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_r, rej) => setTimeout(() => rej(new Error(`${label} : délai dépassé (${ms / 1000}s)`)), ms)),
]);

async function openTunnel(port, subdomain) {
  // première connexion sur le sous-domaine FIXE → URL stable. Si pris (rare,
  // collision improbable), repli sur sous-domaine aléatoire pour ne pas
  // bloquer ; ensuite la maintenance continue en arrière-plan.
  const first = await connectTunnel(port, subdomain) || await connectTunnel(port, null);
  if (first) {
    maintainTunnel(port, first.subdomain, first.tunnel); // pas de await : boucle de fond
    return;
  }
  // secours unique : tunnelmole
  step('repli sur tunnelmole…');
  try {
    const { tunnelmole } = await import('tunnelmole');
    const url = await withTimeout(tunnelmole({ port }), 30000, 'tunnelmole');
    DIAG.info.publicUrl = String(url).replace(/^http:/, 'https:');
    DIAG.info.tunnelProvider = 'tunnelmole';
    step(`tunnel tunnelmole : ${DIAG.info.publicUrl}`);
  } catch (e) { fail(`tunnelmole : ${e.message}`); }
}

async function connectTunnel(port, subdomain) {
  try {
    const localtunnel = require('localtunnel');
    const opts = { port, local_host: '127.0.0.1' };
    if (subdomain) opts.subdomain = subdomain;
    const tunnel = await withTimeout(localtunnel(opts), 30000, 'localtunnel');
    DIAG.info.publicUrl = tunnel.url;
    DIAG.info.tunnelProvider = 'localtunnel';
    step(`tunnel : ${tunnel.url}`);
    let sub = subdomain;
    try { sub = new (require('url').URL)(tunnel.url).hostname.split('.')[0]; } catch { /* garde l'ancien */ }
    return { tunnel, subdomain: sub };
  } catch (e) {
    fail(`localtunnel${subdomain ? ` (${subdomain})` : ''} : ${e.message}`);
    return null;
  }
}

async function maintainTunnel(port, subdomain, tunnel) {
  for (;;) {
    // attend la mort du tunnel courant
    await new Promise((resolve) => {
      tunnel.on('close', resolve);
      tunnel.on('error', resolve);
    });
    if (DIAG.info) DIAG.info.publicUrl = null;
    fail('tunnel fermé — reconnexion automatique…');
    // reconnexion (même sous-domaine si possible → URL stable)
    for (;;) {
      await sleep(5000);
      const next = await connectTunnel(port, subdomain) || await connectTunnel(port, null);
      if (next) { tunnel = next.tunnel; subdomain = next.subdomain; break; }
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- canal 1 : bridge natif (optionnel) ----------------------------------------

try {
  const { channel } = require('bridge');
  DIAG.bridge = true;
  step('bridge natif chargé');
  channel.addListener('start', async (cfg) => {
    try { channel.send('started', await startRelay(cfg)); }
    catch (e) { channel.send('error', String(e.message || e)); }
  });
  channel.addListener('status', () => {
    channel.send(DIAG.started ? 'started' : 'stopped', DIAG.info || {});
  });
  channel.send('node-ready', {});
} catch (e) {
  fail(`bridge indisponible : ${e.message} (le canal HTTP prend le relais)`);
}

process.on('uncaughtException', (e) => fail(`uncaught : ${e.message}`));
process.on('unhandledRejection', (e) => fail(`unhandled : ${(e && e.message) || e}`));
