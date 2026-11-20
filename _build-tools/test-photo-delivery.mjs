import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const sourceRoot = fs.existsSync(path.join(root, 'photo-delivery.js')) ? root : path.join(root, 'dist');
const source = fs.readFileSync(path.join(sourceRoot, 'photo-delivery.js'), 'utf8');
const toneCss = fs.readFileSync(path.join(sourceRoot, 'photo-tones.css'), 'utf8');
const filterDefinitions = fs.readFileSync(path.join(sourceRoot, 'assets', 'catalog-photo-light.svg'), 'utf8');
const completedFailureAttributes = new Map([['srcset', 'retired 480w'], ['sizes', '100vw']]);
const completedFailure = {
  complete: true,
  naturalWidth: 0,
  dataset: { photoOriginal: 'https://cdn.shopify.com/s/files/1/0289/5239/5911/files/already-failed.jpg?v=1' },
  removeAttribute(name) { completedFailureAttributes.delete(name); },
  set src(value) { completedFailureAttributes.set('src', value); }
};
const context = {
  URL,
  KIGBPhotoTones: { profile: sourceUrl => sourceUrl.includes('dark-photo') ? 'lift' : '' },
  listeners: {},
  addEventListener(name, listener, capture) { this.listeners[name] = { listener, capture }; },
  document: { readyState: 'loading', querySelectorAll() { return [completedFailure]; } },
  KIGBPhotoSharpness: { photos: {
    'files/dark-photo.jpg?123': [
      [360, 270, 'assets/catalog-clarity/example-360.jpg'],
      [1000, 750, 'assets/catalog-clarity/example-1000.jpg']
    ]
  }}
};
context.window = context;
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context);
const Photos = context.KIGBPhotos;
context.listeners.DOMContentLoaded.listener();
assert.equal(
  completedFailureAttributes.get('src'),
  completedFailure.dataset.photoOriginal,
  'a derivative that failed before the deferred script starts is recovered after parsing'
);

const shopify = {
  src: 'https://cdn.shopify.com/s/files/1/0289/5239/5911/files/dark-photo.jpg?v=123',
  width: 1000,
  height: 750
};
assert.equal(
  Photos.url(shopify.src, 1600, shopify.width),
  'https://cdn.shopify.com/s/files/1/0289/5239/5911/files/dark-photo.jpg?v=123&width=1000',
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
assert.match(markup, /src="assets\/catalog-clarity\/example-1000\.jpg"/);
assert.match(markup, /srcset="assets\/catalog-clarity\/example-360\.jpg 360w, assets\/catalog-clarity\/example-1000\.jpg 1000w"/);
assert.match(markup, /sizes="\(max-width: 600px\) 90vw, 420px"/);
assert.match(markup, /alt="Chair &amp; ottoman"/);
assert.match(markup, /data-photo-tone="lift"/);
assert.match(markup, /data-photo-original="https:\/\/cdn\.shopify\.com\/s\/files\/1\/0289\/5239\/5911\/files\/dark-photo\.jpg\?v=123"/);

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
assert.match(attributes.get('srcset'), /360w.*1000w/);
assert.equal(attributes.get('sizes'), '95vw');
assert.equal(attributes.get('alt'), 'Closer view');
assert.equal(element.dataset.photoTone, undefined, 'the enlarged original view is never visually toned');
const original = Photos.image(shopify, { alt: 'Original', original: true, tone: false });
assert.match(original, new RegExp(`src="${shopify.src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
assert.doesNotMatch(original, /srcset=|data-photo-tone=|[?&amp;]width=/, 'the original-view control receives the exact merchant file');
assert.deepEqual(
  { ...Photos.share(shopify) },
  { src: 'assets/catalog-clarity/example-1000.jpg', width: 1000, height: 750, type: 'image/jpeg' },
  'sharing receives the largest sharpened JPEG and its actual dimensions'
);

assert.equal(context.listeners.error.capture, true, 'the derivative fallback listens in the capture phase');
const fallbackAttributes = new Map([['srcset', 'bad 480w'], ['sizes', '100vw']]);
const fallbackImage = {
  dataset: { photoOriginal: shopify.src },
  removeAttribute(name) { fallbackAttributes.delete(name); },
  set src(value) { fallbackAttributes.set('src', value); }
};
context.listeners.error.listener({ target: fallbackImage });
assert.equal(fallbackAttributes.get('src'), shopify.src, 'a retired derivative falls back to the exact merchant source');
assert.equal(fallbackAttributes.has('srcset'), false);
assert.equal(fallbackAttributes.has('sizes'), false);
assert.equal(fallbackImage.dataset.photoFallback, 'true');
fallbackAttributes.set('src', 'unchanged');
context.listeners.error.listener({ target: fallbackImage });
assert.equal(fallbackAttributes.get('src'), 'unchanged', 'the fallback cannot loop after the merchant source fails');
assert.deepEqual(
  { ...Photos.share({ src: 'https://example.com/photo.png', width: 800, height: 600 }) },
  { src: 'https://example.com/photo.png', width: 800, height: 600, type: 'image/png' },
  'unknown images retain the exact supplied source for sharing'
);

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
