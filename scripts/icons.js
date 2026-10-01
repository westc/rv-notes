// Draws the app icons (a white map pin on indigo) as PNGs, so no image editor
// or extra package is needed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BACKGROUND = [79, 70, 229]; // Tailwind indigo-600
const PIN = [255, 255, 255];

const icons = [
  { file: 'icon-32.png', size: 32, rounded: true, pinScale: 0.2 },
  { file: 'icon-192.png', size: 192, rounded: true, pinScale: 0.19 },
  { file: 'icon-512.png', size: 512, rounded: true, pinScale: 0.19 },
  // Maskable icons and Apple touch icons are cropped by the system, so they
  // fill the square and keep the pin inside the middle 80%.
  { file: 'maskable-512.png', size: 512, rounded: false, pinScale: 0.165 },
  { file: 'apple-touch-icon.png', size: 180, rounded: false, pinScale: 0.175 }
];

function pinTest(size, pinScale) {
  const r = pinScale * size;
  const d = 2.1 * r; // From the circle's middle to the tip.
  const cx = size / 2;
  const cy = size / 2 - (d - r) / 2;
  const cosT = r / d;
  const sinT = Math.sqrt(1 - cosT * cosT);
  const tip = [cx, cy + d];
  const left = [cx - r * sinT, cy + r * cosT];
  const right = [cx + r * sinT, cy + r * cosT];
  const hole = 0.42 * r;
  const side = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  return (x, y) => {
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < hole) return false;
    if (dist <= r) return true;
    const p = [x, y];
    const s1 = side(left, right, p), s2 = side(right, tip, p), s3 = side(tip, left, p);
    return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  };
}

function roundedTest(size) {
  const radius = 0.22 * size;
  return (x, y) => {
    const dx = Math.max(radius - x, x - (size - radius), 0);
    const dy = Math.max(radius - y, y - (size - radius), 0);
    return dx * dx + dy * dy <= radius * radius;
  };
}

function draw({ size, rounded, pinScale }) {
  const inPin = pinTest(size, pinScale);
  const inShape = rounded ? roundedTest(size) : () => true;
  const samples = 4;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let shape = 0, pin = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) / samples, py = y + (sy + 0.5) / samples;
          if (inShape(px, py)) {
            shape++;
            if (inPin(px, py)) pin++;
          }
        }
      }
      const i = (y * size + x) * 4;
      const t = shape ? pin / shape : 0;
      for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(BACKGROUND[c] * (1 - t) + PIN[c] * t);
      pixels[i + 3] = Math.round(255 * shape / (samples * samples));
    }
  }
  return encodePng(size, pixels);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // Bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

mkdirSync('icons', { recursive: true });
for (const icon of icons) writeFileSync(`icons/${icon.file}`, draw(icon));
console.log('Drew icons in icons/.');
