/* Génère app/icon.png (512×512) sans aucune dépendance : encodeur PNG
 * minimal (zlib + CRC) dessinant le logo claude-comm (deux nœuds reliés). */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;
const px = Buffer.alloc(S * S * 4);

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

const BG = [13, 17, 23], BLUE = [88, 166, 255], GREEN = [63, 185, 80], FG = [230, 237, 243];

// fond avec coins arrondis
const RAD = 96;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const cx = x < RAD ? RAD : x >= S - RAD ? S - RAD - 1 : x;
    const cy = y < RAD ? RAD : y >= S - RAD ? S - RAD - 1 : y;
    const inside = (x - cx) ** 2 + (y - cy) ** 2 <= RAD * RAD;
    if (inside) set(x, y, ...BG);
  }
}

function ring(cx, cy, radius, width, color) {
  for (let y = cy - radius - width; y <= cy + radius + width; y++) {
    for (let x = cx - radius - width; x <= cx + radius + width; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (Math.abs(d - radius) <= width / 2) set(x, y, ...color);
    }
  }
}

function disc(cx, cy, radius, color) {
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) set(x, y, ...color);
    }
  }
}

function line(x1, y1, x2, y2, width, color) {
  const steps = Math.hypot(x2 - x1, y2 - y1) * 2;
  for (let t = 0; t <= steps; t++) {
    const x = x1 + ((x2 - x1) * t) / steps;
    const y = y1 + ((y2 - y1) * t) / steps;
    disc(Math.round(x), Math.round(y), width / 2, color);
  }
}

ring(176, 208, 68, 24, BLUE);
ring(352, 304, 68, 24, GREEN);
line(232, 240, 296, 272, 22, FG);
disc(176, 208, 20, BLUE);
disc(352, 304, 20, GREEN);

// encodage PNG
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;  // profondeur
ihdr[9] = 6;  // RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filtre none
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log(`icon.png généré (${png.length} octets)`);
