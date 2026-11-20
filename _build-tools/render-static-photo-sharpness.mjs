#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { STATIC_PHOTO_JOBS } from './static-photo-jobs.mjs';

const root = path.resolve(import.meta.dirname, '..');
const asset = relative => path.join(root, 'assets', relative);

// libvips applies this to the luminance channel in LAB space. Flat-area restraint
// avoids turning JPEG grain, upholstery, or a painted surface into false detail.
const SHARPEN = Object.freeze({ sigma: 0.9, m1: 0.45, m2: 1.85, x1: 2.5, y2: 9, y3: 16 });

async function render(source, destination, width) {
  await access(source);
  const metadata = await sharp(source).metadata();
  assert.ok(metadata.width && metadata.height, `Could not read dimensions for ${source}`);
  assert.ok(width <= metadata.width, `Refusing to upscale ${source} from ${metadata.width}px to ${width}px`);

  const temporary = `${destination}.render-tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  await sharp(source, { failOn: 'warning' })
    .rotate()
    .resize({ width, withoutEnlargement: true, kernel: sharp.kernel.lanczos3 })
    .sharpen(SHARPEN)
    .webp({ quality: 94, effort: 6, smartSubsample: true })
    .toFile(temporary);

  const rendered = await sharp(temporary).metadata();
  assert.equal(rendered.width, width, `Unexpected width for ${destination}`);
  assert.equal(rendered.height, Math.round(metadata.height * width / metadata.width), `Unexpected height for ${destination}`);
  await rename(temporary, destination);
}

try {
  for (const job of STATIC_PHOTO_JOBS) {
    for (const [output, width] of job.outputs) {
      await render(asset(job.source), asset(output), width);
      process.stdout.write(`Rendered ${output} from ${job.source}\n`);
    }
  }
} catch (error) {
  for (const job of STATIC_PHOTO_JOBS) {
    for (const [output] of job.outputs) await rm(`${asset(output)}.render-tmp`, { force: true });
  }
  throw error;
}
