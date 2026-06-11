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

    DIAG.info = { port, secret, lanIp: lanIp(), publicUrl: null };
    DIAG.started = true;

    if (cfg.expose) {
      try {
        step('ouverture du tunnel…');
        const localtunnel = require('localtunnel');
        const tunnel = await localtunnel({ port, local_host: '127.0.0.1' });
        DIAG.info.publicUrl = tunnel.url;
        step(`tunnel : ${tunnel.url}`);
        tunnel.on('close', () => { if (DIAG.info) DIAG.info.publicUrl = null; });
      } catch (e) { fail(`tunnel : ${e.message}`); }
    }
    return DIAG.info;
  })();
  try { return await starting; }
  catch (e) { starting = null; fail(`startRelay : ${e.message}`); throw e; }
}

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
