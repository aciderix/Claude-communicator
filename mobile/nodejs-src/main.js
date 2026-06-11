/* Point d'entrée du Node embarqué dans l'app mobile (nodejs-mobile).
 *
 * Reçoit l'ordre "start" de la couche Capacitor et démarre le relais
 * claude-comm DANS le téléphone : le dashboard local s'y connecte via
 * 127.0.0.1, les autres appareils via l'IP WiFi du téléphone, et
 * l'extérieur via le tunnel optionnel. Le secret et l'état persistent
 * dans le répertoire de données de l'app.
 */
'use strict';

const { channel } = require('bridge');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let started = false;
let current = null; // { port, secret, lanIp, publicUrl }

function dataDir() {
  const base = os.homedir && os.homedir() ? os.homedir() : os.tmpdir();
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

channel.addListener('start', async (cfg) => {
  cfg = cfg || {};
  try {
    if (started) { channel.send('started', current); return; }
    const dir = dataDir();
    const secret = loadSecret(dir);
    const port = Number(cfg.port) || 8787;

    // relay.js lit process.argv au chargement : on les pose puis on l'importe.
    process.argv = ['node', 'relay.js',
      '--host', '0.0.0.0', '--port', String(port),
      '--secret', secret, '--data', path.join(dir, 'relay-data'),
      '--pair'];
    require('./relay.js');
    started = true;
    current = { port, secret, lanIp: lanIp(), publicUrl: null };

    if (cfg.expose) {
      try {
        const localtunnel = require('localtunnel');
        const tunnel = await localtunnel({ port, local_host: '127.0.0.1' });
        current.publicUrl = tunnel.url;
        tunnel.on('close', () => {
          if (current) current.publicUrl = null;
          channel.send('tunnel-closed', {});
        });
      } catch (e) {
        channel.send('log', `tunnel impossible : ${e.message}`);
      }
    }
    channel.send('started', current);
  } catch (e) {
    channel.send('error', String((e && e.message) || e));
  }
});

channel.addListener('status', () => {
  channel.send(started ? 'started' : 'stopped', current || {});
});

channel.send('node-ready', {});
