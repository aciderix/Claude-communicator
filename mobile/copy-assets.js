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

const ROOT = path.join(__dirname, '..');
const WWW = path.join(__dirname, 'www');
const NODEDIR = path.join(WWW, 'nodejs');

fs.mkdirSync(WWW, { recursive: true });
fs.rmSync(NODEDIR, { recursive: true, force: true });
fs.mkdirSync(NODEDIR, { recursive: true });

// dashboard + icône
fs.copyFileSync(path.join(ROOT, 'public', 'dashboard.html'), path.join(WWW, 'dashboard.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'icon.svg'), path.join(WWW, 'icon.svg'));

// projet node embarqué
for (const f of fs.readdirSync(path.join(__dirname, 'nodejs-src'))) {
  fs.copyFileSync(path.join(__dirname, 'nodejs-src', f), path.join(NODEDIR, f));
}
fs.copyFileSync(path.join(ROOT, 'relay.js'), path.join(NODEDIR, 'relay.js'));
fs.cpSync(path.join(ROOT, 'lib'), path.join(NODEDIR, 'lib'), { recursive: true });
fs.cpSync(path.join(ROOT, 'public'), path.join(NODEDIR, 'public'), { recursive: true });

console.log('assets mobiles assemblés dans mobile/www/');
console.log('⚠️  pense à : cd mobile/www/nodejs && npm install --omit=dev (localtunnel)');
