/* Copie le relais (et ses ressources) dans app/relay/ pour l'embarquer
 * dans l'application : l'app est autonome une fois construite. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEST = path.join(__dirname, 'relay');

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'relay.js'), path.join(DEST, 'relay.js'));
fs.cpSync(path.join(ROOT, 'lib'), path.join(DEST, 'lib'), { recursive: true });
fs.cpSync(path.join(ROOT, 'public'), path.join(DEST, 'public'), { recursive: true });
console.log('relais copié dans app/relay/');
