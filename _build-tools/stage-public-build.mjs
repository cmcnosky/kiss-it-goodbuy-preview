#!/usr/bin/env node

import { copyFile, lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const publicRoot = path.resolve(process.cwd());
const buildRoot = path.join(publicRoot, '.build');
const outputRoot = path.join(buildRoot, 'dist');
const scriptOutput = path.join(buildRoot, 'scripts');
const toolRoot = path.join(publicRoot, '_build-tools');

const HTML_FILES = [
  'index.html',
  'collection.html',
  'story.html',
  'consign.html',
  'visit.html',
  'shortlist.html',
  'product.html',
  'cart.html'
];
const PUBLIC_DIRECTORIES = ['assets', 'products', 'licenses'];
const REQUIRED_ROOT_FILES = [
  'inventory.json',
  'app.js',
  'catalog-normalize.js',
  'catalog.js',
  'commerce.js',
  'inventory.js',
  'storefront-data.js',
  'style.css',
  'storefront.css',
  'integration.css'
];
const REQUIRED_TOOLS = [
  'render-pages.mjs',
  'stage-public-build.mjs',
  'sync-catalog.mjs',
  'test-commerce.mjs',
  'test-storefront-data.mjs'
];

function assertSafeBuildPath() {
  if (publicRoot === path.parse(publicRoot).root || path.dirname(buildRoot) !== publicRoot || path.basename(buildRoot) !== '.build') {
    throw new Error('Refusing to stage outside a repository-local .build directory.');
  }
}

async function requireRegularFile(source, label = path.relative(publicRoot, source)) {
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Required public file is missing: ${label}`);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Expected a regular public file: ${label}`);
}

async function requireDirectory(source, label = path.relative(publicRoot, source)) {
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Required public directory is missing: ${label}`);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Expected a real public directory: ${label}`);
}

async function copyPublicFile(relativeSource, relativeDestination = relativeSource) {
  const source = path.join(publicRoot, relativeSource);
  const destination = path.join(outputRoot, relativeDestination);
  await requireRegularFile(source, relativeSource);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function copyTree(source, destination, label) {
  await requireDirectory(source, label);
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const relative = `${label}/${entry.name}`;
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in the public artifact: ${relative}`);
    if (info.isDirectory()) await copyTree(from, to, relative);
    else if (info.isFile()) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
    } else {
      throw new Error(`Unsupported filesystem entry in public artifact: ${relative}`);
    }
  }
}

async function removeOldBuild() {
  try {
    const info = await lstat(buildRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Refusing to replace .build because it is not a real directory.');
    }
    await rm(buildRoot, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function validateInventory() {
  const source = path.join(publicRoot, 'inventory.json');
  await requireRegularFile(source, 'inventory.json');
  let inventory;
  try {
    inventory = JSON.parse(await readFile(source, 'utf8'));
  } catch (error) {
    throw new Error(`inventory.json is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(inventory.products) || inventory.products.length === 0) {
    throw new Error('inventory.json must contain at least one product.');
  }
  if (!Array.isArray(inventory.collections)) {
    throw new Error('inventory.json must contain a collections array.');
  }
  return inventory.products.length;
}

async function main() {
  assertSafeBuildPath();
  const productCount = await validateInventory();
  for (const file of [...HTML_FILES, ...REQUIRED_ROOT_FILES]) {
    await requireRegularFile(path.join(publicRoot, file), file);
  }
  for (const directory of PUBLIC_DIRECTORIES) {
    await requireDirectory(path.join(publicRoot, directory), directory);
  }
  await requireDirectory(toolRoot, '_build-tools');

  const toolEntries = (await readdir(toolRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => entry.name)
    .sort();
  for (const required of REQUIRED_TOOLS) {
    if (!toolEntries.includes(required)) throw new Error(`Required build tool is missing: _build-tools/${required}`);
  }

  const rootEntries = await readdir(publicRoot, { withFileTypes: true });
  const rootAssets = rootEntries
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.css')))
    .map((entry) => entry.name)
    .sort();

  await removeOldBuild();
  await mkdir(outputRoot, { recursive: true });
  await mkdir(scriptOutput, { recursive: true });
  await mkdir(path.join(buildRoot, 'research'), { recursive: true });

  for (const file of HTML_FILES) await copyPublicFile(file);
  for (const file of rootAssets) await copyPublicFile(file);
  await copyPublicFile('inventory.json');
  for (const directory of PUBLIC_DIRECTORIES) {
    await copyTree(path.join(publicRoot, directory), path.join(outputRoot, directory), directory);
  }

  try {
    await copyPublicFile('.nojekyll');
  } catch (error) {
    if (!String(error.message).includes('Required public file is missing: .nojekyll')) throw error;
  }

  for (const file of toolEntries) {
    const source = path.join(toolRoot, file);
    await requireRegularFile(source, `_build-tools/${file}`);
    await copyFile(source, path.join(scriptOutput, file));
  }

  process.stdout.write(
    `Staged ${HTML_FILES.length} HTML entry points, ${rootAssets.length} root assets, ${PUBLIC_DIRECTORIES.length} public directories, ${toolEntries.length} build tools, and inventory for ${productCount} products.\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
