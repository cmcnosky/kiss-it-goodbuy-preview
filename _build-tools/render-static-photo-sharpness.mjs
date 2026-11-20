#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const asset = relative => path.join(root, 'assets', relative);

// libvips applies this to the luminance channel in LAB space. Flat-area restraint
// avoids turning JPEG grain, upholstery, or a painted surface into false detail.
const SHARPEN = Object.freeze({ sigma: 0.9, m1: 0.45, m2: 1.85, x1: 2.5, y2: 9, y3: 16 });

const jobs = [
  {
    source: 'editorial/crystal-chandelier-hero-enhanced-v1.webp',
    outputs: [
      ['editorial/crystal-chandelier-hero-enhanced-v2-640.webp', 640],
      ['editorial/crystal-chandelier-hero-enhanced-v2-960.webp', 960],
      ['editorial/crystal-chandelier-hero-enhanced-v2.webp', 1448]
    ]
  },
  {
    source: 'editorial/eames-orange-chairs-enhanced-v1.webp',
    outputs: [
      ['editorial/eames-orange-chairs-enhanced-v2-640.webp', 640],
      ['editorial/eames-orange-chairs-enhanced-v2-960.webp', 960],
      ['editorial/eames-orange-chairs-enhanced-v2.webp', 1254]
    ]
  },
  {
    source: 'editorial/hidden-gem-murano-chandelier.jpg',
    allowDisplayResample: true,
    outputs: [['editorial/hidden-gem-murano-chandelier-sharp-v1.webp', 960]]
  },
  {
    source: 'editorial/facebook-colorful-drummer-art.jpg',
    allowDisplayResample: true,
    outputs: [['editorial/facebook-colorful-drummer-art-sharp-v1.webp', 960]]
  },
  {
    source: 'editorial/facebook-geometric-front-chest.jpg',
    allowDisplayResample: true,
    outputs: [['editorial/facebook-geometric-front-chest-sharp-v1.webp', 960]]
  },
  {
    source: 'showroom.jpg',
    outputs: [
      ['showroom-original-v2-768.webp', 768],
      ['showroom-original-v2.webp', 1135]
    ]
  }
];

async function render(source, destination, width, allowDisplayResample = false) {
  await access(source);
  const metadata = await sharp(source).metadata();
  assert.ok(metadata.width && metadata.height, `Could not read dimensions for ${source}`);
  assert.ok(allowDisplayResample || width <= metadata.width, `Refusing to upscale ${source} from ${metadata.width}px to ${width}px`);

  const temporary = `${destination}.render-tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  await sharp(source, { failOn: 'warning' })
    .rotate()
    .resize({ width, withoutEnlargement: !allowDisplayResample, kernel: sharp.kernel.lanczos3 })
    .sharpen(SHARPEN)
    .webp({ quality: 94, effort: 6, smartSubsample: true })
    .toFile(temporary);

  const rendered = await sharp(temporary).metadata();
  assert.equal(rendered.width, width, `Unexpected width for ${destination}`);
  assert.equal(rendered.height, Math.round(metadata.height * width / metadata.width), `Unexpected height for ${destination}`);
  await rename(temporary, destination);
}

try {
  for (const job of jobs) {
    for (const [output, width] of job.outputs) {
      await render(asset(job.source), asset(output), width, job.allowDisplayResample);
      process.stdout.write(`Rendered ${output} from ${job.source}\n`);
    }
  }
} catch (error) {
  for (const job of jobs) {
    for (const [output] of job.outputs) await rm(`${asset(output)}.render-tmp`, { force: true });
  }
  throw error;
}
