/* Génère toutes les icônes des apps depuis appicon.png (512×512 RGBA) :
 *  - Android : mipmap-* ic_launcher / ic_launcher_round / ic_launcher_foreground
 *  - Desktop (Electron) : app/icon.png
 *  - Web : web/public/icon.png (PWA)
 * Décodeur/encodeur PNG + redimensionnement bilinéaire sans dépendance.
 * Limite assumée : PNG 8 bits RGBA non entrelacé (le format d'appicon.png).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'appicon.png');

// --- décodage ---------------------------------------------------------------

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('pas un PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('PNG entrelacé non géré');
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`format non géré (bitDepth=${bitDepth}, colorType=${colorType}) — exporter en RGBA 8 bits`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const px = Buffer.alloc(width * height * bpp);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: throw new Error(`filtre PNG inconnu : ${filter}`);
      }
      out[x] = v;
    }
    out.copy(px, y * stride);
    prev = out;
  }
  return { width, height, px };
}

// --- encodage ---------------------------------------------------------------

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

function encodePNG(width, height, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- redimensionnement bilinéaire (RGBA prémultiplié pour éviter les franges)

function resize(src, sw, sh, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const fy = ((y + 0.5) * sh) / dh - 0.5;
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = ((x + 0.5) * sw) / dw - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      let r = 0, g = 0, b = 0, a = 0;
      for (const [yy, wyy] of [[y0, 1 - wy], [y1, wy]]) {
        for (const [xx, wxx] of [[x0, 1 - wx], [x1, wx]]) {
          const w = wyy * wxx;
          const i = (yy * sw + xx) * 4;
          const al = src[i + 3] / 255;
          r += src[i] * al * w;
          g += src[i + 1] * al * w;
          b += src[i + 2] * al * w;
          a += src[i + 3] * w;
        }
      }
      const o = (y * dw + x) * 4;
      const al = a / 255 || 1;
      dst[o] = Math.round(Math.min(255, r / al));
      dst[o + 1] = Math.round(Math.min(255, g / al));
      dst[o + 2] = Math.round(Math.min(255, b / al));
      dst[o + 3] = Math.round(Math.min(255, a));
    }
  }
  return dst;
}

// icône posée au centre d'un canevas transparent (zone sûre adaptive icons)
function padded(src, sw, sh, canvas, scale) {
  const inner = Math.round(canvas * scale);
  const icon = resize(src, sw, sh, inner, inner);
  const dst = Buffer.alloc(canvas * canvas * 4);
  const off = Math.round((canvas - inner) / 2);
  for (let y = 0; y < inner; y++) {
    icon.copy(dst, ((y + off) * canvas + off) * 4, y * inner * 4, (y + 1) * inner * 4);
  }
  return dst;
}

// --- génération ----------------------------------------------------------------

const { width, height, px } = decodePNG(fs.readFileSync(SRC));
console.log(`source : ${width}×${height}`);

const RES = path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'res');
const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const FG = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

for (const [d, size] of Object.entries(DENSITIES)) {
  const dir = path.join(RES, `mipmap-${d}`);
  const img = encodePNG(size, size, resize(px, width, height, size, size));
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), img);
  fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), img);
  const fgSize = FG[d];
  fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'),
    encodePNG(fgSize, fgSize, padded(px, width, height, fgSize, 0.62)));
  console.log(`mipmap-${d} : ${size} + foreground ${fgSize}`);
}

// fond des icônes adaptatives : ardoise sombre du thème
fs.writeFileSync(path.join(RES, 'values', 'ic_launcher_background.xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0F172A</color>\n</resources>\n');
// l'ancien drawable vectoriel du template Capacitor masquerait la couleur
try { fs.unlinkSync(path.join(RES, 'drawable', 'ic_launcher_background.xml')); } catch { /* déjà absent */ }
try { fs.unlinkSync(path.join(RES, 'drawable-v24', 'ic_launcher_foreground.xml')); } catch { /* déjà absent */ }

// desktop (Electron)
fs.copyFileSync(SRC, path.join(ROOT, 'app', 'icon-src.png'));
console.log('app/icon-src.png (Electron)');

// web (PWA)
fs.copyFileSync(SRC, path.join(ROOT, 'web', 'public', 'icon.png'));
console.log('web/public/icon.png (PWA)');

console.log('✅ icônes générées');
