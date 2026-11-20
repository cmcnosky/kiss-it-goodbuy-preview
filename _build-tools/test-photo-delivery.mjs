import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const sourceRoot = fs.existsSync(path.join(root, 'photo-delivery.js')) ? root : path.join(root, 'dist');
const source = fs.readFileSync(path.join(sourceRoot, 'photo-delivery.js'), 'utf8');
const toneCss = fs.readFileSync(path.join(sourceRoot, 'photo-tones.css'), 'utf8');
const filterDefinitions = fs.readFileSync(path.join(sourceRoot, 'assets', 'catalog-photo-light.svg'), 'utf8');
const context = {
  URL,
  KIGBPhotoTones: { profile: sourceUrl => sourceUrl.includes('dark-photo') ? 'lift' : '' }
};
context.window = context;
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context);
const Photos = context.KIGBPhotos;

const shopify = {
  src: 'https://cdn.shopify.com/s/files/1/2/dark-photo.jpg?v=123',
  width: 1000,
  height: 750
};
assert.equal(
  Photos.url(shopify.src, 1600, shopify.width),
  'https://cdn.shopify.com/s/files/1/2/dark-photo.jpg?v=123&width=1000',
  'a requested rendition never exceeds the supplied source width'
);
assert.deepEqual(
  [...Photos.candidateWidths(shopify, [240, 600, 1200, 1800])],
  [240, 600, 1000],
  'responsive candidates are deduplicated and capped at the native source'
);

const markup = Photos.image(shopify, {
  alt: 'Chair & ottoman',
  width: 700,
  height: 700,
  widths: [360, 720, 1440],
  sizes: '(max-width: 600px) 90vw, 420px',
  loading: 'lazy'
});
assert.match(markup, /src="[^"]+width=700"/);
assert.match(markup, /srcset="[^"]+&amp;width=360 360w, [^"]+&amp;width=720 720w, [^"]+&amp;width=1000 1000w"/);
assert.match(markup, /sizes="\(max-width: 600px\) 90vw, 420px"/);
assert.match(markup, /alt="Chair &amp; ottoman"/);
assert.match(markup, /data-photo-tone="lift"/);

const local = Photos.image('assets/products/chair.jpg', { alt: 'Chair', width: 400, height: 400 });
assert.match(local, /src="assets\/products\/chair\.jpg"/);
assert.doesNotMatch(local, /srcset=/, 'local artwork is delivered directly without invented renditions');
assert.match(local, /width="400"/, 'layout dimensions remain present for local artwork');

const data = 'data:image/jpeg;base64,AAAA';
assert.equal(Photos.url(data, 1000), data, 'browser-local sample photographs remain untouched');

const attributes = new Map();
const element = {
  dataset: {},
  set src(value) { attributes.set('src', value); },
  set srcset(value) { attributes.set('srcset', value); },
  set sizes(value) { attributes.set('sizes', value); },
  set alt(value) { attributes.set('alt', value); },
  removeAttribute(name) { attributes.delete(name); }
};
assert.equal(Photos.apply(element, shopify, { alt: 'Closer view', widths: [500, 1500], sizes: '95vw', tone: false }), true);
assert.match(attributes.get('srcset'), /500w.*1000w/);
assert.equal(attributes.get('sizes'), '95vw');
assert.equal(attributes.get('alt'), 'Closer view');
assert.equal(element.dataset.photoTone, undefined, 'the enlarged original view is never visually toned');
const original = Photos.image(shopify, { alt: 'Original', original: true, tone: false });
assert.match(original, new RegExp(`src="${shopify.src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
assert.doesNotMatch(original, /srcset=|data-photo-tone=|[?&amp;]width=/, 'the original-view control receives the exact merchant file');

const tones = ['shadow', 'midtones', 'highlights', 'contrast'];
for (const tone of tones) {
  const filterId = `kigb-photo-${tone}`;
  assert.ok(
    toneCss.includes(`img[data-photo-tone="${tone}"] { filter: url("#${filterId}"); }`),
    `${tone} photographs reference their scoped in-document filter`
  );
  assert.ok(filterDefinitions.includes(`id="${filterId}"`), `${filterId} exists in the embedded filter source`);
}

const renderedCandidates = [
  path.join(sourceRoot, 'index.html'),
  path.join(root, '.build', 'dist', 'index.html')
];
const renderedPath = renderedCandidates.find(candidate => {
  if (!fs.existsSync(candidate)) return false;
  return fs.readFileSync(candidate, 'utf8').includes('id="kigb-photo-shadow"');
});
if (renderedPath) {
  const renderedHtml = fs.readFileSync(renderedPath, 'utf8');
  for (const tone of tones) {
    assert.ok(renderedHtml.includes(`id="kigb-photo-${tone}"`), `rendered HTML embeds the ${tone} filter definition`);
  }
} else {
  const rendererPath = path.join(root, '_build-tools', 'render-pages.mjs');
  const renderer = fs.existsSync(rendererPath) ? fs.readFileSync(rendererPath, 'utf8') : '';
  assert.ok(
    renderer.includes("assets/catalog-photo-light.svg") && renderer.includes('${photoLight}'),
    'the renderer embeds the scoped photograph filters when a built page is not available'
  );
}

// A pair can lead with both chairs while the merchant remains in control of the cover.
const singleChair = {id: '52049330012397'};
const chairsTogether = {id: '52049330077933'};
const upholstery = {id: 'detail'};
const pair = {id: '15453233512685', images: [singleChair, upholstery, chairsTogether]};
assert.deepEqual(Array.from(Photos.gallery(pair)), [chairsTogether, singleChair, upholstery]);
assert.deepEqual(pair.images, [singleChair, upholstery, chairsTogether]);
const merchantUpdate = { ...pair, images: [upholstery, chairsTogether, singleChair] };
assert.equal(Photos.gallery(merchantUpdate), merchantUpdate.images);
const missingAngle = { ...pair, images: [singleChair] };
assert.equal(Photos.gallery(missingAngle), missingAngle.images);

console.log('photo delivery: native-size caps, responsive candidates, embedded grading filters, safe markup, and unfiltered zoom checks passed');
