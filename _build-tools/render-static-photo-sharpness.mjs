#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { STATIC_PHOTO_JOBS } from './static-photo-jobs.mjs';

const root = path.resolve(import.meta.dirname, '..');
const asset = relative => path.join(root, 'assets', relative);

// Use the recorded luminance at two scales. Strong boundaries can take more
// detail recovery than a smooth wall, glass highlight, or compressed shadow.
async function restorePhoto(source, width) {
  const { data: rgb, info } = await sharp(source, { failOn: 'warning' })
    .rotate().resize({ width, withoutEnlargement: true, kernel: sharp.kernel.lanczos3 })
    .flatten({ background: '#fff' }).toColourspace('srgb').removeAlpha()
    .raw().toBuffer({ resolveWithObject: true });
  const luma = Buffer.alloc(info.width * info.height);
  for (let i = 0; i < luma.length; i++) {
    const k = i * 3;
    luma[i] = Math.round(0.2126 * rgb[k] + 0.7152 * rgb[k + 1] + 0.0722 * rgb[k + 2]);
  }
  const raw = { width: info.width, height: info.height, channels: 1 };
  const blurred = sigma => sharp(luma, { raw }).blur(sigma).greyscale().raw().toBuffer();
  const [fine, medium, broad] = await Promise.all([blurred(0.85), blurred(2.7), blurred(11)]);
  for (let i = 0; i < luma.length; i++) {
    const k = i * 3;
    const y = luma[i];
    const midDetail = fine[i] - medium[i];
    const texture = Math.min(1, Math.abs(midDetail) / 6);
    const fineGain = -0.08 + 1.9 * texture;
    const delta = Math.max(-23, Math.min(23,
      (y - fine[i]) * fineGain + midDetail * 1.1 + (medium[i] - broad[i]) * 0.3));
    // Use the same offset on all three channels, with a smooth shoulder near
    // black and white, so the lightness adjustment preserves color differences.
    const room = delta >= 0
      ? 255 - Math.max(rgb[k], rgb[k + 1], rgb[k + 2])
      : Math.min(rgb[k], rgb[k + 1], rgb[k + 2]);
    const offset = Math.round(Math.sign(delta) * Math.min(room, Math.abs(delta) * Math.min(1, room / 28)));
    for (let c = 0; c < 3; c++) rgb[k + c] += offset;
  }
  return sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } });
}

async function render(source, destination, width) {
  await access(source);
  const metadata = await sharp(source).metadata();
  assert.ok(metadata.width && metadata.height, `Could not read dimensions for ${source}`);
  assert.ok(width <= metadata.width, `Refusing to upscale ${source} from ${metadata.width}px to ${width}px`);

  const temporary = `${destination}.render-tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  const photograph = await restorePhoto(source, width);
  await photograph.webp({ quality: 97, effort: 6, smartSubsample: true })
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
