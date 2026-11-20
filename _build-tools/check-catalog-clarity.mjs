import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { STATIC_PHOTO_JOBS } from './static-photo-jobs.mjs';

const dist = path.resolve(process.argv[2] || '.build/dist');
const inventory = JSON.parse(fs.readFileSync(path.join(dist, 'inventory.json'), 'utf8'));
const indexHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const canonicalHome = indexHtml.match(/<link rel="canonical" href="([^"]+)"/i)?.[1];
assert.ok(canonicalHome, 'index.html has no canonical public URL');
const publicBase = new URL(decodeHtml(canonicalHome));
const publicAssetRoot = new URL('assets/', publicBase).pathname;
const context = vm.createContext({ URL });
context.window = context;
for (const script of ['photo-sharpness.js', 'photo-delivery.js']) {
  vm.runInContext(fs.readFileSync(path.join(dist, script), 'utf8'), context);
}

const photos = context.KIGBPhotos;
const manifest = context.KIGBPhotoSharpness?.photos || {};
const IMAGE_EXTENSION = /\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#]|$)/i;
const RASTER_EXTENSION = /\.(?:avif|gif|jpe?g|png|webp)$/i;
const CATALOG_PATH = /^assets\/catalog-clarity\/[\w./-]+\.(?:webp|jpe?g)$/i;
const BRAND_PATH = /^assets\/(?:brand(?:-[\w.-]+)?|original-logo(?:-[\w.-]+)?)\.(?:gif|jpe?g|png|svg|webp)$/i;
const SHARE_PATH = /^assets\/(?:preview|social-preview)(?:-[\w.-]+)?\.(?:jpe?g|png|webp)$/i;
const PRODUCT_ROUTE = /^products\/([^/]+)\/index\.html$/;
const EXPECTED_ENTRY_ROUTES = new Set([
  'cart.html', 'collection.html', 'consign.html', 'index.html', 'planner.html', 'practice-checkout.html',
  'product.html', 'shortlist.html', 'story.html', 'studio.html', 'visit.html'
]);

const fileDetails = new Map();
const fileUses = new Map();
const categories = {
  catalog: new Set(),
  staticPhotograph: new Set(),
  brandArt: new Set(),
  shareArt: new Set(),
  otherArt: new Set()
};

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function localPath(value) {
  let source = decodeHtml(value).trim();
  if (!source || source.startsWith('data:') || source.startsWith('blob:') || source.startsWith('#')) return null;
  if (/^https?:/i.test(source)) {
    const parsed = new URL(source);
    assert.equal(parsed.origin, publicBase.origin, `external image does not belong to the generated site: ${source}`);
    assert.ok(parsed.pathname.startsWith(publicAssetRoot), `public image URL is outside the site asset root: ${source}`);
    source = `assets/${parsed.pathname.slice(publicAssetRoot.length)}`;
  }
  source = source.split(/[?#]/, 1)[0].replace(/^\.\//, '').replace(/^\//, '');
  assert.ok(source && !source.includes('\\'), `invalid local image path: ${value}`);
  assert.ok(!source.split('/').includes('..'), `image path escapes the public artifact: ${value}`);
  const normalized = path.posix.normalize(source);
  assert.equal(normalized, source, `image path is not normalized: ${value}`);
  return normalized;
}

function jpegDimensions(bytes, source) {
  assert.equal(bytes.readUInt16BE(0), 0xffd8, `${source}: invalid JPEG start marker`);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    assert.ok(offset + 2 <= bytes.length, `${source}: truncated JPEG marker`);
    const length = bytes.readUInt16BE(offset);
    assert.ok(length >= 2 && offset + length <= bytes.length, `${source}: invalid JPEG marker length`);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      assert.ok(length >= 7, `${source}: truncated JPEG dimensions`);
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3), format: 'jpeg' };
    }
    offset += length;
  }
  assert.fail(`${source}: JPEG dimensions were not found`);
}

function webpDimensions(bytes, source) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', `${source}: invalid WebP RIFF header`);
  assert.equal(bytes.toString('ascii', 8, 12), 'WEBP', `${source}: invalid WebP signature`);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    assert.ok(data + length <= bytes.length, `${source}: truncated WebP chunk`);
    if (type === 'VP8X') {
      assert.ok(length >= 10, `${source}: truncated VP8X header`);
      const width = 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16);
      const height = 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16);
      return { width, height, format: 'webp' };
    }
    if (type === 'VP8 ') {
      assert.ok(length >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a,
        `${source}: invalid VP8 frame header`);
      return {
        width: bytes.readUInt16LE(data + 6) & 0x3fff,
        height: bytes.readUInt16LE(data + 8) & 0x3fff,
        format: 'webp'
      };
    }
    if (type === 'VP8L') {
      assert.ok(length >= 5 && bytes[data] === 0x2f, `${source}: invalid VP8L frame header`);
      const bits = bytes.readUInt32LE(data + 1);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff), format: 'webp' };
    }
    offset = data + length + (length % 2);
  }
  assert.fail(`${source}: WebP dimensions were not found`);
}

function svgDimensions(bytes, source) {
  const text = bytes.toString('utf8');
  const tag = text.match(/<svg\b[^>]*>/i)?.[0];
  assert.ok(tag, `${source}: SVG root was not found`);
  const width = Number(tag.match(/\bwidth=["']([\d.]+)(?:px)?["']/i)?.[1]);
  const height = Number(tag.match(/\bheight=["']([\d.]+)(?:px)?["']/i)?.[1]);
  if (width > 0 && height > 0) return { width, height, format: 'svg' };
  const viewBox = tag.match(/\bviewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i);
  assert.ok(viewBox && Number(viewBox[1]) > 0 && Number(viewBox[2]) > 0, `${source}: SVG dimensions were not found`);
  return { width: Number(viewBox[1]), height: Number(viewBox[2]), format: 'svg' };
}

function encodedDimensions(bytes, source) {
  if (bytes.length >= 2 && bytes.readUInt16BE(0) === 0xffd8) return jpegDimensions(bytes, source);
  if (bytes.length >= 8 && bytes.toString('hex', 0, 8) === '89504e470d0a1a0a') {
    assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a', `${source}: invalid PNG signature`);
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), format: 'png' };
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return webpDimensions(bytes, source);
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) {
    assert.match(bytes.toString('ascii', 0, 6), /^GIF8[79]a$/, `${source}: invalid GIF signature`);
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), format: 'gif' };
  }
  if (path.extname(source).toLowerCase() === '.svg' || /<svg\b/i.test(bytes.toString('utf8', 0, Math.min(bytes.length, 1024)))) {
    return svgDimensions(bytes, source);
  }
  assert.fail(`${source}: image format is not covered by the clarity audit`);
}

function categoryFor(source) {
  if (CATALOG_PATH.test(source)) return 'catalog';
  if (BRAND_PATH.test(source)) return 'brandArt';
  if (SHARE_PATH.test(source)) return 'shareArt';
  if (RASTER_EXTENSION.test(source)) return 'staticPhotograph';
  return 'otherArt';
}

function inspectFile(sourceValue, use, expected = {}) {
  const source = localPath(sourceValue);
  assert.ok(source, `${use}: expected a local image, received ${sourceValue}`);
  assert.match(source, IMAGE_EXTENSION, `${use}: image reference has an unsupported extension`);
  const absolute = path.join(dist, source);
  const relative = path.relative(dist, absolute);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${use}: image path left the public artifact`);
  const stat = fs.lstatSync(absolute);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${use}: image is not a regular file: ${source}`);

  let detail = fileDetails.get(source);
  if (!detail) {
    const bytes = fs.readFileSync(absolute);
    const dimensions = encodedDimensions(bytes, source);
    assert.ok(dimensions.width > 0 && dimensions.height > 0, `${source}: invalid encoded dimensions`);
    detail = { ...dimensions, bytes: bytes.length, category: categoryFor(source) };
    fileDetails.set(source, detail);
    categories[detail.category].add(source);
  }
  if (expected.width != null) assert.equal(detail.width, Number(expected.width), `${use}: ${source} width does not match its descriptor`);
  if (expected.height != null) assert.equal(detail.height, Number(expected.height), `${use}: ${source} height does not match its descriptor`);
  if (!fileUses.has(source)) fileUses.set(source, new Set());
  fileUses.get(source).add(use);
  return { source, ...detail };
}

function reclassify(detail, category) {
  if (detail.category === category) return detail;
  const stored = fileDetails.get(detail.source);
  categories[stored.category].delete(detail.source);
  stored.category = category;
  categories[category].add(detail.source);
  return { ...detail, category };
}

function parseAttributes(tag) {
  const attributes = new Map();
  for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attributes.set(match[1].toLowerCase(), decodeHtml(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return attributes;
}

function parseSrcset(value, use) {
  const candidates = String(value || '').split(',').map(candidate => candidate.trim()).filter(Boolean).map(candidate => {
    const match = candidate.match(/^(\S+)\s+(\d+)w$/);
    assert.ok(match, `${use}: invalid srcset candidate: ${candidate}`);
    return { source: decodeHtml(match[1]), width: Number(match[2]) };
  });
  const widths = candidates.map(candidate => candidate.width);
  assert.deepEqual(widths, [...new Set(widths)].sort((left, right) => left - right), `${use}: srcset widths must be unique and ascending`);
  return candidates;
}

function walk(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(absolute));
    else result.push(absolute);
  }
  return result;
}

function staticPhotoManifest() {
  const candidateRoots = [
    path.resolve(dist, '..', '..'),
    path.resolve(import.meta.dirname, '..')
  ];
  const projectRoot = candidateRoots.find(candidate => fs.existsSync(path.join(candidate, 'assets')) && fs.existsSync(path.join(candidate, '_build-tools')));
  assert.ok(projectRoot, 'static-photo source tree is unavailable');
  assert.ok(Array.isArray(STATIC_PHOTO_JOBS) && STATIC_PHOTO_JOBS.length > 0, 'static-photo job manifest is empty');

  const outputs = new Map();
  for (const job of STATIC_PHOTO_JOBS) {
    const sourcePath = path.resolve(projectRoot, 'assets', job.source);
    const sourceBytes = fs.readFileSync(sourcePath);
    const native = encodedDimensions(sourceBytes, path.relative(projectRoot, sourcePath));
    for (const [output, widthValue] of job.outputs) {
      const width = Number(widthValue);
      assert.ok(width > 0 && width <= native.width, `${output}: renderer job exceeds its ${native.width}px source`);
      const publicPath = `assets/${output}`;
      assert.ok(!outputs.has(publicPath), `duplicate static-photo output: ${publicPath}`);
      const rendered = inspectFile(publicPath, `static-photo render manifest ${job.source}`);
      assert.equal(rendered.width, width, `${publicPath}: rendered width differs from the job manifest`);
      assert.equal(rendered.height, Math.round(native.height * width / native.width), `${publicPath}: rendered height differs from the native source ratio`);
      outputs.set(publicPath, { nativeWidth: native.width, nativeHeight: native.height, source: job.source, width, height: rendered.height });
    }
  }
  return outputs;
}

const staticPhotoOutputs = staticPhotoManifest();

const inventoryPhotos = new Map();
const inventoryPhotoKeys = new Set();
for (const product of inventory.products) {
  for (const [index, photo] of product.images.entries()) {
    assert.ok(photos.isShopifyImage(photo.src), `${product.handle} photo ${index + 1}: unsupported raw inventory host`);
    const key = photos.photoKey(photo.src);
    assert.ok(key, `${product.handle} photo ${index + 1}: Shopify image is outside the verified store path`);
    inventoryPhotoKeys.add(key);
    if (!inventoryPhotos.has(photo.src)) inventoryPhotos.set(photo.src, []);
    inventoryPhotos.get(photo.src).push({ product, photo, index });
  }
}

for (const [key, sources] of Object.entries(manifest)) {
  assert.ok(inventoryPhotoKeys.has(key), `photo-sharpness manifest contains an unlisted inventory key: ${key}`);
  assert.ok(Array.isArray(sources) && sources.length > 0, `${key}: empty sharpness manifest entry`);
  let previous = 0;
  for (const source of sources) {
    assert.ok(Array.isArray(source) && source.length === 3, `${key}: invalid sharpness manifest source`);
    const [width, height, filename] = source;
    assert.ok(Number(width) > previous && Number(height) > 0, `${key}: sharpness sources must have ascending positive dimensions`);
    inspectFile(filename, `sharpness manifest ${key}`, { width, height });
    previous = Number(width);
  }
}
assert.deepEqual(new Set(Object.keys(manifest)), inventoryPhotoKeys, 'the sharpness manifest must cover every and only current inventory photo');

const distinctInventoryPhotos = new Set();
let verifiedLargerSources = 0;
for (const product of inventory.products) {
  for (const photo of product.images) {
    if (distinctInventoryPhotos.has(photo.src)) continue;
    distinctInventoryPhotos.add(photo.src);
    const sharpened = photos.sharpenedSources(photo);
    assert.ok(sharpened.length > 0, `${photo.src}: no prepared photograph exists`);
    for (const source of sharpened) inspectFile(source.src, `prepared inventory photo ${photo.src}`, source);

    const display = photos.descriptor(photo, { width: 800, sizes: '100vw' });
    inspectFile(display.src, `inventory display ${photo.src}`);
    assert.ok(display.srcset, `${photo.src}: empty responsive sizes`);
    const candidates = parseSrcset(display.srcset, `inventory display ${photo.src}`);
    for (const candidate of candidates) inspectFile(candidate.source, `inventory srcset ${photo.src}`, { width: candidate.width });
    const displayWidth = Number(photos.displaySourceWidth?.(photo) ?? photo.width);
    assert.ok(Number.isFinite(displayWidth) && displayWidth > 0, `${photo.src}: display source width is unavailable`);
    assert.ok(Number(photo.width) > 0 && displayWidth >= Number(photo.width), `${photo.src}: verified display width is smaller than the listed source`);
    assert.ok(candidates.at(-1).width <= displayWidth, `${photo.src}: responsive source exceeds its verified display-source width`);
    if (displayWidth > Number(photo.width)) {
      verifiedLargerSources++;
      assert.ok(candidates.at(-1).width > Number(photo.width), `${photo.src}: larger verified source is not represented in the responsive set`);
    }

    const fullSize = photos.descriptor(photo, { fullSize: true });
    const largest = sharpened.at(-1);
    assert.equal(fullSize.src, largest.src, `${photo.src}: full viewer does not select the largest prepared photograph`);
    assert.equal(fullSize.srcset, '', `${photo.src}: full viewer must not negotiate down to a smaller candidate`);
    const fullDetail = inspectFile(fullSize.src, `full viewer ${photo.src}`);
    assert.ok(fullDetail.width <= displayWidth, `${photo.src}: full viewer enlarges beyond the verified display source`);

    const original = photos.descriptor(photo, { original: true, tone: false });
    assert.equal(original.src, photo.src, `${photo.src}: explicit original view is not the exact selected merchant file`);
    assert.equal(original.srcset, '', `${photo.src}: explicit original view must bypass responsive substitution`);
    assert.equal(original.tone, '', `${photo.src}: explicit original view must bypass tone treatment`);

    const share = photos.share(photo);
    assert.equal(share.src, largest.src, `${photo.src}: share image is not the largest prepared photograph`);
    inspectFile(share.src, `share image ${photo.src}`, { width: share.width, height: share.height });
    assert.equal(share.type, 'image/jpeg', `${photo.src}: inventory share image must be a JPEG`);
  }
}

const htmlFiles = walk(dist).filter(filename => filename.endsWith('.html'));
const htmlRoutes = new Set(htmlFiles.map(filename => path.relative(dist, filename).split(path.sep).join('/')));
const productRoutes = new Set([...htmlRoutes].filter(route => PRODUCT_ROUTE.test(route)));
for (const route of EXPECTED_ENTRY_ROUTES) assert.ok(htmlRoutes.has(route), `missing generated storefront route: ${route}`);
assert.equal([...htmlRoutes].filter(route => !route.includes('/')).length, EXPECTED_ENTRY_ROUTES.size, 'unexpected or missing top-level storefront route');
for (const product of inventory.products) {
  assert.ok(productRoutes.has(`products/${product.handle}/index.html`), `missing generated product route: ${product.handle}`);
}
assert.equal(productRoutes.size, inventory.products.length, 'generated product-route count does not match the inventory');

let imageTags = 0;
let srcsetCandidates = 0;
let originalReferences = 0;
let shareReferences = 0;
let archiveViewerReferences = 0;
const renderedStaticPhotos = new Set();

for (const filename of htmlFiles) {
  const route = path.relative(dist, filename).split(path.sep).join('/');
  const html = fs.readFileSync(filename, 'utf8');
  const routeMatch = route.match(PRODUCT_ROUTE);

  for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
    imageTags++;
    const attributes = parseAttributes(tag[0]);
    const sourceValue = attributes.get('src');
    assert.ok(sourceValue, `${route}: image is missing src`);
    assert.ok(!/^https?:/i.test(sourceValue), `${route}: raw external image bypasses local delivery: ${sourceValue}`);
    const source = inspectFile(sourceValue, `${route} img`);
    const original = attributes.get('data-photo-original');

    if (source.category === 'catalog') {
      assert.ok(original, `${route}: prepared catalog image has no exact-original fallback`);
    }
    if (original) {
      originalReferences++;
      assert.ok(inventoryPhotos.has(original), `${route}: data-photo-original is not a current inventory photograph: ${original}`);
      assert.ok(source.category === 'catalog', `${route}: an original merchant URL is attached to a non-catalog image`);
    }

    const candidates = attributes.has('srcset')
      ? parseSrcset(attributes.get('srcset'), `${route} ${source.source}`)
      : [];
    if (candidates.length) {
      assert.ok(attributes.get('sizes'), `${route}: responsive image is missing sizes: ${source.source}`);
      srcsetCandidates += candidates.length;
      for (const candidate of candidates) {
        assert.ok(!/^https?:/i.test(candidate.source), `${route}: external srcset candidate bypasses local delivery`);
        const detail = inspectFile(candidate.source, `${route} srcset`, { width: candidate.width });
        assert.equal(detail.category, source.category, `${route}: src and srcset mix image classifications`);
      }
    }

    if (source.category === 'staticPhotograph') {
      renderedStaticPhotos.add(source.source);
      const intrinsicWidth = Number(attributes.get('width'));
      const intrinsicHeight = Number(attributes.get('height'));
      assert.ok(intrinsicWidth > 0 && intrinsicHeight > 0, `${route}: static photograph lacks explicit layout dimensions: ${source.source}`);
      assert.ok(candidates.length >= 2, `${route}: static photograph has no prepared responsive source set: ${source.source}`);
      const available = [source, ...candidates.map(candidate => inspectFile(candidate.source, `${route} static srcset`, { width: candidate.width }))];
      for (const candidate of available) renderedStaticPhotos.add(candidate.source);
      const largest = available.sort((left, right) => left.width - right.width).at(-1);
      assert.equal(largest.width, intrinsicWidth, `${route}: static photograph layout width differs from its largest encoded source: ${source.source}`);
      const declaredRatio = intrinsicWidth / intrinsicHeight;
      const encodedRatio = largest.width / largest.height;
      assert.ok(Math.abs(declaredRatio - encodedRatio) / encodedRatio < 0.015,
        `${route}: static photograph layout ratio does not match its encoded pixels: ${source.source}`);
    }
  }

  for (const tag of html.matchAll(/<(?:link|meta)\b[^>]*>/gi)) {
    const attributes = parseAttributes(tag[0]);
    const value = attributes.get('href') || attributes.get('content');
    if (!value || !IMAGE_EXTENSION.test(value)) continue;
    let image = inspectFile(value, `${route} metadata`);
    if (/\bog:image\b|\btwitter:image\b/i.test(tag[0])) {
      shareReferences++;
      if (image.category === 'staticPhotograph') image = reclassify(image, 'shareArt');
      assert.ok(['catalog', 'shareArt'].includes(image.category), `${route}: social metadata uses an unclassified image`);
    }
  }

  for (const match of html.matchAll(/<a\b([^>]*)data-archive-photo([^>]*)>([\s\S]*?)<\/a>/gi)) {
    archiveViewerReferences++;
    const attributes = parseAttributes(`<a ${match[1]} data-archive-photo ${match[2]}>`);
    const href = attributes.get('href');
    assert.ok(href && !/^https?:/i.test(href), `${route}: archive viewer bypasses the local photograph set`);
    const full = inspectFile(href, `${route} archive viewer`);
    const imageTag = match[3].match(/<img\b[^>]*>/i)?.[0];
    assert.ok(imageTag, `${route}: archive viewer link does not contain a photograph`);
    const imageAttributes = parseAttributes(imageTag);
    const available = [inspectFile(imageAttributes.get('src'), `${route} archive viewer image`)];
    if (imageAttributes.get('srcset')) {
      for (const candidate of parseSrcset(imageAttributes.get('srcset'), `${route} archive viewer srcset`)) {
        available.push(inspectFile(candidate.source, `${route} archive viewer srcset`, { width: candidate.width }));
      }
    }
    const largest = available.sort((left, right) => left.width - right.width).at(-1);
    assert.equal(full.source, largest.source, `${route}: archive viewer does not open the largest prepared photograph`);
  }

  if (!routeMatch) continue;
  const handle = routeMatch[1];
  const product = inventory.products.find(entry => entry.handle === handle);
  assert.ok(product, `${route}: route has no inventory product`);
  const gallery = photos.gallery(product);
  if (!gallery.length) {
    assert.doesNotMatch(html, /id="main-product-image"/, `${route}: no-photo listing has a main product photograph`);
    continue;
  }

  const lead = gallery[0];
  const mainTag = html.match(/<img\b[^>]*\bid="main-product-image"[^>]*>/i)?.[0];
  assert.ok(mainTag, `${route}: missing main product photograph`);
  const mainAttributes = parseAttributes(mainTag);
  assert.equal(mainAttributes.get('data-photo-original'), lead.src, `${route}: main photo fallback is not the selected lead angle`);
  const expectedMain = photos.descriptor(lead, {
    width: 1000,
    widths: [480, 720, 960, 1200, 1400, 1800, 2100],
    sizes: '(max-width: 760px) 94vw, 58vw'
  });
  assert.equal(mainAttributes.get('src'), expectedMain.src, `${route}: main product photograph bypasses prepared delivery`);
  assert.equal(mainAttributes.get('srcset'), expectedMain.srcset, `${route}: main product responsive candidates differ from the delivery manifest`);

  const zoomTag = html.match(/<img\b[^>]*\bid="zoom-image"[^>]*>/i)?.[0];
  assert.ok(zoomTag, `${route}: missing full-size viewer image`);
  const zoomAttributes = parseAttributes(zoomTag);
  const expectedZoom = photos.descriptor(lead, { fullSize: true });
  assert.equal(zoomAttributes.get('src'), expectedZoom.src, `${route}: full-size viewer does not start with the largest prepared image`);
  assert.ok(!zoomAttributes.has('srcset'), `${route}: full-size viewer can be silently replaced by a smaller candidate`);
  assert.equal(zoomAttributes.get('data-photo-original'), lead.src, `${route}: full-size viewer lacks the selected-angle original fallback`);
  assert.match(html, /data-photo-open="sharp"[^>]*aria-controls="photo-dialog"/, `${route}: main image is not wired to the prepared viewer`);
  assert.doesNotMatch(html, /data-photo-open="original"/, `${route}: original merchant file is promoted outside the comparison viewer`);
  assert.match(html, /data-photo-version="original"[^>]*>View original photo<\/button>/, `${route}: viewer cannot switch explicitly to the merchant file`);

  const thumbnailBlock = html.match(/<div class="product-thumbnails"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '';
  const thumbnailOriginals = [...thumbnailBlock.matchAll(/data-photo-original="([^"]+)"/g)].map(match => decodeHtml(match[1]));
  assert.deepEqual(thumbnailOriginals, Array.from(gallery, image => image.src), `${route}: thumbnail angles do not map one-for-one to current inventory originals`);

  const shared = photos.share(lead);
  const shareTag = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
  assert.ok(shareTag && new URL(decodeHtml(shareTag)).pathname.endsWith('/' + shared.src), `${route}: product share image mismatch`);
  for (const dimension of ['width', 'height']) {
    assert.ok(html.includes(`<meta property="og:image:${dimension}" content="${shared[dimension]}">`), `${route}: product share ${dimension} mismatch`);
  }
}

for (const filename of walk(dist).filter(file => /\.(?:css|js)$/i.test(file))) {
  const route = path.relative(dist, filename).split(path.sep).join('/');
  const source = fs.readFileSync(filename, 'utf8');
  if (filename.endsWith('.css')) {
    const references = new Set([...source.matchAll(/url\(\s*["']?(assets\/[\w./-]+\.(?:avif|gif|jpe?g|png|svg|webp))/gi)].map(match => match[1]));
    for (const reference of references) inspectFile(reference, `${route} stylesheet`);
  }
  if (filename.endsWith('.js')) {
    for (const tag of source.matchAll(/<img\b[^>]*>/gi)) {
      if (/\bsrc\s*=\s*["']\$\{/i.test(tag[0])) {
        assert.match(tag[0], /\bsrcset\s*=/i, `${route}: dynamic static photograph has no responsive source set`);
      }
      assert.doesNotMatch(tag[0], /\bsrc\s*=\s*["']https?:/i, `${route}: template hard-codes an external image`);
      const attributes = parseAttributes(tag[0]);
      const src = attributes.get('src');
      if (src && !src.includes('${') && IMAGE_EXTENSION.test(src)) inspectFile(src, `${route} template image`);
      const srcset = attributes.get('srcset');
      if (srcset && !srcset.includes('${')) {
        for (const candidate of parseSrcset(srcset, `${route} template srcset`)) {
          inspectFile(candidate.source, `${route} template srcset`, { width: candidate.width });
        }
      }
    }
  }
}

assert.ok(htmlFiles.length > inventory.products.length, 'expected product routes plus storefront entry routes');
assert.ok(imageTags > 0 && srcsetCandidates > 0 && originalReferences > 0 && shareReferences > 0 && archiveViewerReferences > 0);
assert.ok(categories.catalog.size > 0 && categories.staticPhotograph.size > 0 && categories.brandArt.size > 0);
for (const source of renderedStaticPhotos) {
  assert.ok(staticPhotoOutputs.has(source), `rendered static photograph bypasses the no-enlargement render manifest: ${source}`);
}

const imageBytes = [...fileDetails.values()].reduce((sum, detail) => sum + detail.bytes, 0);
console.log(JSON.stringify({
  routes: htmlFiles.length,
  productRoutes: productRoutes.size,
  inventoryProducts: inventory.products.length,
  uniqueInventoryPhotos: distinctInventoryPhotos.size,
  verifiedLargerSources,
  preparedCatalogFiles: categories.catalog.size,
  staticPhotographs: renderedStaticPhotos.size,
  brandArt: categories.brandArt.size,
  shareArt: categories.shareArt.size,
  otherArt: categories.otherArt.size,
  imageTags,
  srcsetCandidates,
  exactOriginalReferences: originalReferences,
  archiveViewerReferences,
  socialImageReferences: shareReferences,
  checkedImageFiles: fileDetails.size,
  imageBytes
}));
