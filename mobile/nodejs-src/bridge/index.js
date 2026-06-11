/* Réimplémentation du module `bridge` de capacitor-nodejs.
 *
 * Le plugin (installé depuis GitHub) n'embarque pas son bridge runtime :
 * il n'est construit qu'à la publication npm, qui n'a jamais eu lieu.
 * Sans lui, require('bridge') plante, le signal "ready" n'est jamais émis
 * et NodeJS.whenReady() ne se résout jamais côté app.
 *
 * Protocole (reconstitué depuis android/src/main/cpp/bridge.cpp et
 * CapacitorNodeJS.java) :
 *  - binding natif : process._linkedBinding('nativeBridge')
 *      .registerChannel(nom, cb(nomCanal, message))
 *      .emit(nom, message)
 *  - enveloppe JSON : {"eventName": string, "eventMessage": "<args JSON[]>"}
 *  - canaux : EVENT_CHANNEL (événements applicatifs),
 *             APP_CHANNEL (cycle de vie ; envoyer "ready" résout whenReady)
 */
'use strict';

const { EventEmitter } = require('events');

const native = process._linkedBinding('nativeBridge');

function makeChannel(name) {
  const emitter = new EventEmitter();
  native.registerChannel(name, (_channelName, message) => {
    try {
      const data = JSON.parse(message);
      const args = data.eventMessage ? JSON.parse(data.eventMessage) : [];
      emitter.emit(data.eventName, ...args);
    } catch { /* message illisible : ignoré */ }
  });
  return {
    send: (eventName, ...args) => {
      native.emit(name, JSON.stringify({ eventName, eventMessage: JSON.stringify(args) }));
    },
    on: (ev, fn) => emitter.on(ev, fn),
    once: (ev, fn) => emitter.once(ev, fn),
    addListener: (ev, fn) => emitter.on(ev, fn),
    removeListener: (ev, fn) => emitter.removeListener(ev, fn),
    removeAllListeners: (ev) => emitter.removeAllListeners(ev),
  };
}

const channel = makeChannel('EVENT_CHANNEL');
const appChannel = makeChannel('APP_CHANNEL');

// Chemin de stockage de données fourni par le plugin via DATADIR
// (sandbox applicatif Android — seul emplacement inscriptible fiable).
function getDataPath() {
  return process.env.DATADIR || require('os').tmpdir();
}

// Signale au plugin que le projet Node a démarré : résout whenReady()
// côté Capacitor et autorise les send() de l'app.
appChannel.send('ready');

module.exports = { channel, getDataPath };
