/* Copie le relais (et ses ressources) dans app/relay/ pour l'embarquer
 * dans l'application : l'app est autonome une fois construite. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEST = path.join(__dirname, 'relay');
const WEB = path.join(ROOT, 'web');
const DIST = path.join(WEB, 'dist');

// Interface React (web/dist) — construite si absente ou si REBUILD_WEB=1.
// Sans elle, le relais embarqué retomberait sur l'ancien dashboard vanilla :
// l'app bureau doit servir la MÊME interface React que le mobile et le cloud.
if (!fs.existsSync(path.join(DIST, 'index.html')) || process.env.REBUILD_WEB === '1') {
  console.log('construction de l\'interface web (vite build)…');
  execSync('npm install --no-audit --no-fund', { cwd: WEB, stdio: 'inherit' });
  execSync('npm run build', { cwd: WEB, stdio: 'inherit' });
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'relay.js'), path.join(DEST, 'relay.js'));
fs.cpSync(path.join(ROOT, 'lib'), path.join(DEST, 'lib'), { recursive: true });
fs.cpSync(path.join(ROOT, 'public'), path.join(DEST, 'public'), { recursive: true });
// L'interface React, servie à la racine par relay.js (path web/dist relatif
// à relay.js → app/relay/web/dist une fois embarqué).
fs.cpSync(DIST, path.join(DEST, 'web', 'dist'), { recursive: true });
console.log('relais + interface React copiés dans app/relay/');
