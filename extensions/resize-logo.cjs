const { Jimp } = require('jimp');
const path = require('path');
const fs = require('fs');

const sourcePath = 'C:\\Users\\Murillo\\.gemini\\antigravity\\brain\\55419641-a9d1-4a4a-946b-acfe7a2154a7\\price_tracker_logo_1782496850252.png';

const targets = [
  { dest: path.join(__dirname, 'chrome', 'icons', 'icon16.png'), size: 16 },
  { dest: path.join(__dirname, 'chrome', 'icons', 'icon48.png'), size: 48 },
  { dest: path.join(__dirname, 'chrome', 'icons', 'icon128.png'), size: 128 },
  { dest: path.join(__dirname, 'firefox', 'icons', 'icon16.png'), size: 16 },
  { dest: path.join(__dirname, 'firefox', 'icons', 'icon48.png'), size: 48 },
  { dest: path.join(__dirname, 'firefox', 'icons', 'icon128.png'), size: 128 },
  { dest: path.join(__dirname, '..', 'public', 'favicon.png'), size: 32 },
  { dest: path.join(__dirname, '..', 'public', 'logo.png'), size: 128 }
];

async function main() {
  console.log('Reading source image:', sourcePath);
  if (!fs.existsSync(sourcePath)) {
    console.error('Source image not found! Please check path.');
    process.exit(1);
  }

  try {
    const rawImage = await Jimp.read(sourcePath);
    const image = rawImage.autocrop();
    console.log(`Cropped source image from ${rawImage.width}x${rawImage.height} to ${image.width}x${image.height}`);
    for (const t of targets) {
      // Ensure target directory exists
      fs.mkdirSync(path.dirname(t.dest), { recursive: true });
      
      // Clone, resize and write
      const resized = image.clone().resize({ w: t.size, h: t.size });
      await resized.write(t.dest);
      console.log(`Successfully generated icon size ${t.size}x${t.size} at: ${t.dest}`);
    }
    console.log('All icons and favicon generated successfully.');
  } catch (err) {
    console.error('Error generating icons:', err.message);
    process.exit(1);
  }
}

main();
