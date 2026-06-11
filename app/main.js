/* claude-comm — application de bureau.
 *
 * Au premier lancement, un écran de configuration propose deux modes :
 *  - HÉBERGER ICI : ce PC devient le serveur. Le relais embarqué démarre
 *    automatiquement (secret persistant, état conservé, appairage mobile),
 *    avec exposition Internet optionnelle (tunnel intégré) pour y accéder
 *    depuis l'extérieur.
 *  - SE CONNECTER : à un relais existant (cloud, autre PC, téléphone).
 *
 * Ensuite : plus aucune manip, l'app s'ouvre directement sur le dashboard.
 * Le CLI, le mode cloud et Termux restent utilisables en parallèle :
 * l'application n'est qu'une porte d'entrée de plus vers le même relais.
 */
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, clipboard } = require('electron');
const { fork } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');
let relayProc = null;
let tunnel = null;
let mainWin = null;
let setupWin = null;
let runtime = { url: '', publicUrl: '', token: '', channel: 'default' };

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8')); } catch { return null; }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function lanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

// --- relais embarqué ---------------------------------------------------------

function startRelay(cfg) {
  return new Promise((resolve, reject) => {
    const args = [
      '--host', '0.0.0.0',
      '--port', String(cfg.port || 8787),
      '--secret', cfg.token,
      '--data', path.join(app.getPath('userData'), 'relay-data'),
      '--pair',
    ];
    relayProc = fork(path.join(__dirname, 'relay', 'relay.js'), args, { silent: true });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('le relais ne démarre pas (port occupé ?)')), 8000);
    relayProc.stderr.on('data', (d) => {
      buf += d;
      if (buf.includes("à l'écoute")) { clearTimeout(timer); resolve(); }
    });
    relayProc.on('exit', (code) => {
      relayProc = null;
      if (mainWin) {
        dialog.showErrorBox('claude-comm', `Le relais embarqué s'est arrêté (code ${code}).`);
      }
    });
  });
}

async function startTunnel(port) {
  const localtunnel = require('localtunnel');
  tunnel = await localtunnel({ port, local_host: '127.0.0.1' });
  tunnel.on('close', () => { tunnel = null; runtime.publicUrl = ''; });
  return tunnel.url;
}

async function pairCode() {
  try {
    const r = await fetch(`${runtime.url}/pair-code`, {
      headers: { authorization: `Bearer ${runtime.token}` },
      signal: AbortSignal.timeout(3000),
    });
    return (await r.json()).code || '(indisponible)';
  } catch { return '(indisponible)'; }
}

// --- fenêtres -----------------------------------------------------------------

function openSetup(prefill) {
  setupWin = new BrowserWindow({
    width: 560, height: 720, resizable: false,
    title: 'claude-comm — configuration',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  setupWin.removeMenu();
  setupWin.loadFile('setup.html', prefill ? { hash: encodeURIComponent(JSON.stringify(prefill)) } : undefined);
}

function openDashboard() {
  mainWin = new BrowserWindow({
    width: 1280, height: 860,
    title: 'claude-comm',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#0d1117',
  });
  // le dashboard se pré-remplit via le fragment #t=<jeton>&c=<canal>
  mainWin.loadURL(`${runtime.url}/#t=${encodeURIComponent(runtime.token)}&c=${encodeURIComponent(runtime.channel)}`);
  mainWin.on('closed', () => { mainWin = null; });
}

async function showConnectInfo() {
  const cfg = loadConfig() || {};
  const lines = [];
  if (cfg.mode === 'host') {
    const code = await pairCode();
    lines.push(`Même réseau (WiFi) : http://${lanIp()}:${cfg.port || 8787}`);
    if (runtime.publicUrl) lines.push(`Internet : ${runtime.publicUrl}`);
    lines.push(`Code d'appairage : ${code} (à saisir sur le téléphone)`);
    lines.push('', `Jeton complet : ${runtime.token}`);
    lines.push('', 'Sessions Claude (autre machine) :',
      `CLAUDE_COMM_RELAY=${runtime.publicUrl || `http://${lanIp()}:${cfg.port || 8787}`} CLAUDE_COMM_TOKEN=${runtime.token} claude`);
  } else {
    lines.push(`Relais : ${runtime.url}`, `Canal : ${runtime.channel}`, `Jeton : ${runtime.token}`);
  }
  const { response } = await dialog.showMessageBox(mainWin, {
    type: 'info',
    title: 'Connexion d\'autres appareils',
    message: 'Connecter un téléphone ou une session Claude',
    detail: lines.join('\n'),
    buttons: ['Copier le jeton', 'Fermer'],
  });
  if (response === 0) clipboard.writeText(runtime.token);
}

function buildMenu(cfg) {
  const template = [
    {
      label: 'claude-comm',
      submenu: [
        { label: 'Connexion d\'autres appareils…', click: showConnectInfo },
        { label: 'Paramètres…', click: () => { openSetup(cfg); } },
        { type: 'separator' },
        { role: 'reload', label: 'Recharger' },
        { role: 'toggleDevTools', label: 'Outils de développement' },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter' },
      ],
    },
    { role: 'editMenu', label: 'Édition' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- cycle de vie ---------------------------------------------------------------

async function boot() {
  const cfg = loadConfig();
  if (!cfg || !cfg.mode) { openSetup(null); return; }
  buildMenu(cfg);
  try {
    if (cfg.mode === 'host') {
      if (!cfg.token) { cfg.token = crypto.randomBytes(32).toString('base64url'); saveConfig(cfg); }
      runtime = {
        url: `http://127.0.0.1:${cfg.port || 8787}`,
        publicUrl: '', token: cfg.token, channel: cfg.channel || 'default',
      };
      await startRelay(cfg);
      if (cfg.expose) {
        try { runtime.publicUrl = await startTunnel(cfg.port || 8787); }
        catch (e) { dialog.showErrorBox('claude-comm', `Exposition Internet impossible : ${e.message}\nL'accès réseau local fonctionne.`); }
      }
    } else {
      runtime = {
        url: String(cfg.relayUrl || '').replace(/\/+$/, ''),
        publicUrl: '', token: cfg.token || '', channel: cfg.channel || 'default',
      };
    }
    openDashboard();
  } catch (e) {
    dialog.showErrorBox('claude-comm', `Démarrage impossible : ${e.message}`);
    openSetup(cfg);
  }
}

ipcMain.handle('setup-save', (_ev, cfg) => {
  const prev = loadConfig() || {};
  saveConfig({ ...prev, ...cfg });
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('setup-test', async (_ev, { url, token }) => {
  try {
    const r = await fetch(`${String(url).replace(/\/+$/, '')}/channels`, {
      headers: { authorization: `Bearer ${token}`, 'bypass-tunnel-reminder': '1' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 401) return { ok: false, error: 'jeton refusé' };
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

app.whenReady().then(boot);

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  try { if (tunnel) tunnel.close(); } catch { /* déjà fermé */ }
  try { if (relayProc) relayProc.kill('SIGTERM'); } catch { /* déjà mort */ }
});
