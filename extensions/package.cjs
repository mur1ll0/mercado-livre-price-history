const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'public', 'extensions');
fs.mkdirSync(outDir, { recursive: true });

function zipDir(dirPath, outPath) {
  const cwd = path.dirname(dirPath);
  const folderName = path.basename(dirPath);

  try {
    if (process.platform === 'win32') {
      const absDir = path.resolve(dirPath);
      const absOut = path.resolve(outPath);
      execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${absDir}\\*' -DestinationPath '${absOut}' -Force"`, { stdio: 'inherit' });
    } else {
      execSync(`cd "${cwd}" && zip -r "${outPath}" "${folderName}"`, { stdio: 'inherit' });
    }
  } catch (e) {
    // On Vercel/Linux, if zip is not available, create a simple ZIP with the zlib module
    console.warn(`System zip failed, creating basic ZIPs...`);
    createBasicZip(dirPath, outPath);
  }
}

function createBasicZip(dirPath, outPath) {
  const zlib = require('zlib');
  const files = [];

  function walkDir(dir, base) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(base, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        walkDir(fullPath, base);
      } else {
        files.push({ path: relPath, data: fs.readFileSync(fullPath) });
      }
    }
  }

  walkDir(dirPath, dirPath);

  const centralDir = [];
  const fileData = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.path, 'utf8');
    const crc = crc32(file.data);
    const compressed = zlib.deflateRawSync(file.data);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(0, 10); // mod time
    localHeader.writeUInt32LE(0, 14); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(file.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);
    fileData.push(localHeader, compressed);

    centralDir.push({
      nameBuf, crc, compressedSize: compressed.length,
      uncompressedSize: file.data.length, offset
    });

    offset += localHeader.length + compressed.length;
  }

  let centralSize = 0;
  const centralBufs = [];
  for (const cd of centralDir) {
    const header = Buffer.alloc(46 + cd.nameBuf.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(0, 12);
    header.writeUInt32LE(cd.crc, 16);
    header.writeUInt32LE(cd.compressedSize, 20);
    header.writeUInt32LE(cd.uncompressedSize, 24);
    header.writeUInt16LE(cd.nameBuf.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt32LE(0, 36);
    header.writeUInt32LE(cd.offset, 42);
    cd.nameBuf.copy(header, 46);
    centralBufs.push(header);
    centralSize += header.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centralDir.length, 8);
  eocd.writeUInt16LE(centralDir.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const result = Buffer.concat([...fileData, ...centralBufs, eocd]);
  fs.writeFileSync(outPath, result);
}

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

zipDir(path.join(__dirname, 'chrome'), path.join(outDir, 'chrome.zip'));
console.log('Packaged: public/extensions/chrome.zip');

zipDir(path.join(__dirname, 'firefox'), path.join(outDir, 'firefox.zip'));
console.log('Packaged: public/extensions/firefox.zip');
