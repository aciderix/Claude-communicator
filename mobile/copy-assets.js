/* Assemble le dossier www/ de l'app mobile :
 *  - l'interface React (web/dist, construite si nécessaire) devient le
 *    webview de l'app — écran de connexion/hébergement et dashboard inclus ;
 *  - www/nodejs/ : le relais embarqué (nodejs-src + relay.js + lib + public)
 *    exécuté par le moteur Node natif (nodejs-mobile).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const WWW = path.join(__dirname, 'www');
const NODEDIR = path.join(WWW, 'nodejs');

// 1. interface React — construite si absente ou si demandé (REBUILD_WEB=1)
const DIST = path.join(WEB, 'dist');
if (!fs.existsSync(path.join(DIST, 'index.html')) || process.env.REBUILD_WEB === '1') {
  console.log('construction de l\'interface web (vite build)…');
  execSync('npm install --no-audit --no-fund', { cwd: WEB, stdio: 'inherit' });
  execSync('npm run build', { cwd: WEB, stdio: 'inherit' });
}

// 2. www/ = dist React (reconstruit intégralement)
fs.rmSync(WWW, { recursive: true, force: true });
fs.cpSync(DIST, WWW, { recursive: true });

// 3. projet node embarqué (fichiers du niveau racine uniquement)
fs.mkdirSync(NODEDIR, { recursive: true });
for (const f of fs.readdirSync(path.join(__dirname, 'nodejs-src'))) {
  const src = path.join(__dirname, 'nodejs-src', f);
  if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(NODEDIR, f));
}
fs.copyFileSync(path.join(ROOT, 'relay.js'), path.join(NODEDIR, 'relay.js'));
fs.cpSync(path.join(ROOT, 'lib'), path.join(NODEDIR, 'lib'), { recursive: true });
fs.cpSync(path.join(ROOT, 'public'), path.join(NODEDIR, 'public'), { recursive: true });
// le relais embarqué sert aussi l'interface React aux AUTRES appareils
fs.cpSync(DIST, path.join(NODEDIR, 'web', 'dist'), { recursive: true });

// 4. dépendances du projet embarqué (localtunnel) — AVANT le bridge, car
// npm install supprime les paquets qu'il ne connaît pas
console.log('npm install du projet embarqué…');
execSync('npm install --omit=dev --no-audit --no-fund', { cwd: NODEDIR, stdio: 'inherit' });

// 5. module bridge vendorisé (le plugin GitHub ne fournit pas le sien) :
// posé en DERNIER dans node_modules pour ne pas être balayé par npm
fs.cpSync(path.join(__dirname, 'nodejs-src', 'bridge'),
  path.join(NODEDIR, 'node_modules', 'bridge'), { recursive: true });

// 6. CRITIQUE : le bridge doit AUSSI aller dans les assets builtin_modules
// du plugin (son emplacement officiel, mis sur NODE_PATH par le code natif).
// Sans contenu réel dans ce dossier (son .gitkeep est exclu de l'APK par
// le filtre AAPT « .* »), assetManager.list() le voit vide, le plugin le
// copie comme un FICHIER → IOException → « Unable to copy the Node.js
// project from APK » et le moteur ne démarre jamais.
const PLUGIN_MODULES = path.join(__dirname, 'node_modules', 'capacitor-nodejs',
  'android', 'src', 'main', 'assets', 'builtin_modules');
if (fs.existsSync(path.dirname(PLUGIN_MODULES))) {
  fs.cpSync(path.join(__dirname, 'nodejs-src', 'bridge'),
    path.join(PLUGIN_MODULES, 'bridge'), { recursive: true });
  console.log('bridge installé dans les assets builtin_modules du plugin');
} else {
  console.error('⚠️  plugin capacitor-nodejs introuvable — lance npm install d\'abord');
  process.exit(1);
}

console.log('assets mobiles assemblés : interface React + relais embarqué');
