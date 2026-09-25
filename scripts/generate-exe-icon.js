// Render the editable SVG into a multi-resolution Windows icon.
// Run when assets/sshterm-icon.svg changes; the committed .ico is used by builds.
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('../tests/puppeteer_test');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'assets', 'sshterm-icon.svg');
const ICO = path.join(ROOT, 'assets', 'sshterm.ico');
const PREVIEW = path.join(ROOT, 'dist', 'sshterm-icon.png');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function packIcon(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2); // ICO image type
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4); // color planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(image => image.png)]);
}

async function main() {
  const svg = fs.readFileSync(SVG, 'utf8');
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><style>
      html, body { margin: 0; width: 100%; height: 100%; background: transparent; }
      svg { display: block; width: 100vw; height: 100vh; }
    </style>${svg}`);
    const images = [];
    for (const size of SIZES) {
      await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
      const png = Buffer.from(await page.screenshot({ type: 'png', omitBackground: true }));
      images.push({ size, png });
      if (size === 256) {
        fs.mkdirSync(path.dirname(PREVIEW), { recursive: true });
        fs.writeFileSync(PREVIEW, png);
      }
    }
    fs.writeFileSync(ICO, packIcon(images));
    console.log(`Generated ${ICO} (${images.length} sizes)`);
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
