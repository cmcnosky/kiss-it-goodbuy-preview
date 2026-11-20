import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const dist = path.resolve(process.argv[2] || '.build/dist');
const inventory = JSON.parse(fs.readFileSync(path.join(dist, 'inventory.json'), 'utf8'));
const context = vm.createContext({ URL });
context.window = context;
for (const script of ['photo-sharpness.js', 'photo-delivery.js']) {
  vm.runInContext(fs.readFileSync(path.join(dist, script), 'utf8'), context);
}
const photos = context.KIGBPhotos;
const fileSizes = new Map();

function checkFile(src) {
  assert.match(src, /^assets\/catalog-clarity\/[\w./-]+\.(?:webp|jpe?g)$/i);
  assert.ok(!src.includes('..'), 'catalog photo paths must stay inside their directory');
  if (fileSizes.has(src)) return;
  const bytes = fs.readFileSync(path.join(dist, src));
  if (src.endsWith('.webp')) {
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', src);
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP', src);
  } else {
    assert.equal(bytes.readUInt16BE(0), 0xffd8, src);
    assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xffd9, src);
  }
  fileSizes.set(src, bytes.length);
}

const distinct = new Set();
let items = 0;
for (const product of inventory.products) {
  for (const photo of product.images) {
    if (!photos.isShopifyImage(photo.src) || distinct.has(photo.src)) continue;
    distinct.add(photo.src);
    const display = photos.descriptor(photo, {width: 800, sizes: '100vw'});
    checkFile(display.src);
    assert.ok(display.srcset, photo.src + ': empty responsive sizes');
    const widths = display.srcset.split(',').map(candidate => {
      const [, src, width] = candidate.trim().match(/^(\S+) (\d+)w$/) || [];
      assert.ok(src && width, 'invalid responsive candidate: ' + candidate);
      checkFile(src);
      return Number(width);
    });
    assert.deepEqual(widths, [...new Set(widths)].sort((a, b) => a - b));
    if (photo.width > 0) assert.ok(widths.at(-1) <= photo.width, 'source has been enlarged: ' + photo.src);
    const original = photos.descriptor(photo, {original: true});
    assert.equal(original.src, photo.src);
    assert.equal(original.srcset, '');
    const share = photos.share(photo);
    checkFile(share.src);
    assert.match(share.src, /\.jpe?g$/i);
    assert.equal(share.width, widths.at(-1));
    assert.ok(share.height > 0);
  }

  const lead = photos.gallery(product)[0];
  if (!lead || !photos.isShopifyImage(lead.src)) continue;
  const html = fs.readFileSync(path.join(dist, 'products', product.handle, 'index.html'), 'utf8');
  const shared = photos.share(lead);
  const tag = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
  assert.ok(tag && new URL(tag).pathname.endsWith('/' + shared.src), 'product share image mismatch: ' + product.handle);
  for (const dimension of ['width', 'height']) {
    assert.ok(html.includes('<meta property="og:image:' + dimension + '" content="' + shared[dimension] + '">'), 'product share dimensions: ' + product.handle);
  }
  const main = html.match(/<img\b[^>]*\bid="main-product-image"[^>]*>/)?.[0];
  assert.ok(main?.includes('src="assets/catalog-clarity/'), 'missing sharpened detail photo: ' + product.handle);
  items++;
}

assert.ok(items > 0 && distinct.size > 0 && fileSizes.size >= distinct.size);
const imageBytes = [...fileSizes.values()].reduce((sum, size) => sum + size, 0);
console.log(JSON.stringify({photographedListings: items, uniquePhotos: distinct.size, files: fileSizes.size, imageBytes}));
