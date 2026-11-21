#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const asset = name => path.join(root, 'assets', name);
const dataUri = (file, mime) => `data:${mime};base64,${readFileSync(file).toString('base64')}`;

// The 640 px delivery variants are comfortably larger than their 253 px card frames,
// while keeping the editable, self-contained SVG practical to archive and share.
const catAndChairs = dataUri(asset('editorial/eames-orange-chairs-enhanced-v1-640.webp'), 'image/webp');
const crystal = dataUri(asset('editorial/crystal-chandelier-hero-enhanced-v1-640.webp'), 'image/webp');
const originalLogo = dataUri(asset('original-logo.png'), 'image/png');
const svgPath = asset('social-preview-kiss-it-good-buy-v16.svg');
const pngPath = asset('social-preview-kiss-it-good-buy-v16.png');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title desc">
  <title id="title">Kiss It Good Buy Furniture Consignment</title>
  <desc id="desc">Kiss It Good Buy Furniture Consignment and its red lipstick kiss, flanked by orange chairs with the gallery cat and a crystal chandelier.</desc>
  <rect width="1200" height="630" fill="#e58a78"/>
  <image href="${catAndChairs}" x="0" y="0" width="650" height="630" preserveAspectRatio="xMinYMid slice"/>
  <image href="${crystal}" x="550" y="0" width="650" height="630" preserveAspectRatio="xMidYMid slice"/>
  <rect width="1200" height="18" fill="#edc56b"/>
  <rect y="612" width="1200" height="18" fill="#bfd9b7"/>

  <!-- The centered plaque stays inside a 630 px square crop while revealing the photography around it. -->
  <rect x="330" y="50" width="540" height="530" fill="#bfd9b7"/>
  <rect x="341" y="61" width="518" height="508" fill="#fff9ed" stroke="#e58a78" stroke-width="8"/>
  <rect x="360" y="80" width="480" height="470" fill="none" stroke="#2d2927" stroke-width="2"/>

  <!-- The kiss is cropped directly from the business's original raster artwork. -->
  <svg x="520" y="91" width="160" height="117" viewBox="170 94 260 195" overflow="hidden" aria-hidden="true">
    <image href="${originalLogo}" x="0" y="0" width="600" height="379"/>
  </svg>

  <text x="600" y="281" text-anchor="middle" fill="#2d2927" font-family="Georgia, 'Times New Roman', serif" font-size="70" font-weight="700" letter-spacing="-3">Kiss It</text>
  <text x="600" y="369" text-anchor="middle" fill="#2d2927" font-family="Georgia, 'Times New Roman', serif" font-size="86" font-weight="700" letter-spacing="-4">Good Buy</text>
  <line x1="405" y1="405" x2="795" y2="405" stroke="#e58a78" stroke-width="5"/>
  <text x="600" y="457" text-anchor="middle" fill="#2d2927" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="700" letter-spacing="1.7">FURNITURE CONSIGNMENT</text>
</svg>
`;

writeFileSync(svgPath, svg);
execFileSync('sips', ['-s', 'format', 'png', svgPath, '--out', pngPath], { stdio: 'ignore' });

const png = readFileSync(pngPath);
if (png.readUInt32BE(16) !== 1200 || png.readUInt32BE(20) !== 630) {
  throw new Error('Rendered social preview must be 1200x630.');
}
process.stdout.write(`Rendered ${path.relative(root, pngPath)} from its self-contained SVG source.\n`);
