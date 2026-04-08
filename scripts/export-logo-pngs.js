/**
 * Exports logo.svg → logo.png / logo_dark.png / logo_light.png
 * at 4x resolution (4096 × 2176 px).
 *
 * Usage: node scripts/export-logo-pngs.js
 */

const sharp = require('sharp');
const fs    = require('fs');
const path  = require('path');

const SVG_PATH = path.join(__dirname, '../public/img/logo.svg');
const OUT_DIR  = path.join(__dirname, '../public/img');

const svgSrc = fs.readFileSync(SVG_PATH, 'utf8');

// Scale factor — 4× the 1024×544 viewBox = 4096×2176
const SCALE  = 4;
const W      = 1024 * SCALE;
const H      = 544  * SCALE;

// Wrap SVG in a coloured rect to produce background variants
function withBackground(color) {
  return svgSrc.replace(
    '<svg ',
    `<svg style="background:${color}" `
  );
}

async function exportPng(svgString, filename) {
  const outPath = path.join(OUT_DIR, filename);
  await sharp(Buffer.from(svgString))
    .resize(W, H)
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log(`✓ ${filename}  (${W}×${H}px)`);
}

(async () => {
  // logo.png — transparent background (original)
  await exportPng(svgSrc, 'logo.png');

  // logo_dark.png — navy background (#050B18)
  await exportPng(withBackground('#050B18'), 'logo_dark.png');

  // logo_light.png — white background
  await exportPng(withBackground('#ffffff'), 'logo_light.png');

  console.log('\nDone. Files written to .img/');
})();
