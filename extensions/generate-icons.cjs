const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcVal = Buffer.alloc(4);
  crcVal.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBytes, data, crcVal]);
}

function generatePNG(size, r, g, b) {
  const rawRows = [];
  for (let y = 0; y < size; y++) {
    rawRows.push(0);
    for (let x = 0; x < size; x++) {
      const cx = x - size / 2 + 0.5;
      const cy = y - size / 2 + 0.5;
      const dist = Math.sqrt(cx * cx + cy * cy) / (size / 2);
      const alpha = Math.max(0, Math.min(1, 1 - dist * dist));
      const gradientR = Math.round(r * alpha + 10 * (1 - alpha));
      const gradientG = Math.round(g * alpha + 7 * (1 - alpha));
      const gradientB = Math.round(b * alpha + 18 * (1 - alpha));
      rawRows.push(gradientR, gradientG, gradientB, 255);
    }
  }

  const rawData = Buffer.from(rawRows);
  const compressed = zlib.deflateSync(rawData, { level: 9 });

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

const dirs = [
  path.join(__dirname, 'chrome', 'icons'),
  path.join(__dirname, 'firefox', 'icons')
];

const sizes = { 'icon16': 16, 'icon48': 48, 'icon128': 128 };

for (const dir of dirs) {
  for (const [name, size] of Object.entries(sizes)) {
    const png = generatePNG(size, 128, 90, 213);
    fs.writeFileSync(path.join(dir, `${name}.png`), png);
    console.log(`Generated ${dir}/${name}.png (${size}x${size})`);
  }
}

console.log('All icons generated.');
