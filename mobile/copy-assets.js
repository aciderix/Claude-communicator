/* Assemble le dossier www/ de l'app mobile :
 *  - www/index.html        : écran natif de mise en route (déjà dans le repo)
 *  - www/dashboard.html    : le dashboard du projet (copié de public/)
 *  - www/nodejs/           : le relais embarqué (nodejs-src + relay.js + lib + public)
 * Le futur front (React...) n'a qu'à remplacer le contenu de www/ en
 * conservant www/nodejs/.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(__dirname, 'www');
const NODEDIR = path.join(WWW, 'nodejs');

fs.mkdirSync(WWW, { recursive: true });
fs.rmSync(NODEDIR, { recursive: true, force: true });
fs.mkdirSync(NODEDIR, { recursive: true });

// dashboard + icône
fs.copyFileSync(path.join(ROOT, 'public', 'dashboard.html'), path.join(WWW, 'dashboard.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'icon.svg'), path.join(WWW, 'icon.svg'));

// projet node embarqué (fichiers du niveau racine uniquement)
for (const f of fs.readdirSync(path.join(__dirname, 'nodejs-src'))) {
  const src = path.join(__dirname, 'nodejs-src', f);
  if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(NODEDIR, f));
}
fs.copyFileSync(path.join(ROOT, 'relay.js'), path.join(NODEDIR, 'relay.js'));
fs.cpSync(path.join(ROOT, 'lib'), path.join(NODEDIR, 'lib'), { recursive: true });
fs.cpSync(path.join(ROOT, 'public'), path.join(NODEDIR, 'public'), { recursive: true });

// dépendances du projet embarqué (localtunnel) — AVANT le bridge, car
// npm install supprime les paquets qu'il ne connaît pas
console.log('npm install du projet embarqué…');
execSync('npm install --omit=dev --no-audit --no-fund', { cwd: NODEDIR, stdio: 'inherit' });

// module bridge vendorisé (le plugin GitHub ne fournit pas le sien) :
// posé en DERNIER dans node_modules pour ne pas être balayé par npm
fs.cpSync(path.join(__dirname, 'nodejs-src', 'bridge'),
  path.join(NODEDIR, 'node_modules', 'bridge'), { recursive: true });

console.log('assets mobiles assemblés dans mobile/www/ (bridge inclus)');
