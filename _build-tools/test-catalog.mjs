#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDirectory, '..');
await import('../dist/catalog-normalize.js');
const Catalog = globalThis.KIGBCatalog;
assert.ok(Catalog, 'catalog-normalize.js must attach KIGBCatalog');

let assertions = 1;
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function deepEqual(actual, expected, message) { assertions += 1; assert.deepEqual(actual, expected, message); }
function throws(callback, expected, message) { assertions += 1; assert.throws(callback, expected, message); }

const hostileHtml = [
  '<p class="lead" onclick="steal()">Keep <strong data-x="1">this</strong>.</p>',
  '<script>alert(1)</script><style>body{display:none}</style>',
  '<iframe src="https://evil.example">frame text</iframe>',
  '<object>object text</object><embed src="x">',
  '<svg><script>alert(2)</script></svg><math><mi>x</mi></math>',
  '<img src=x onerror=steal()><marquee>Readable content</marquee>'
].join('');
const sanitized = Catalog.sanitizeSourceHtml(hostileHtml);
equal(sanitized, '<p>Keep <strong>this</strong>.</p>Readable content', 'only safe, attribute-free formatting survives');
ok(!/(?:script|style|iframe|object|embed|svg|math|img|onerror|onclick)/i.test(sanitized), 'active HTML is absent');
equal(Catalog.sanitizeSourceHtml('&lt;img src=x onerror=x&gt;'), '&lt;img src=x onerror=x&gt;', 'encoded markup remains encoded');
equal(Catalog.plainHtmlText('<p>A&nbsp;&amp;&nbsp;B</p><ul><li>One</li><li>Two</li></ul>'), 'A & B\n• One\n• Two', 'plain text preserves readable structure');
equal(Catalog.plainHtmlText('&lt;img src=x onerror=x&gt;'), '<img src=x onerror=x>', 'plain text may contain literal angle brackets and must be rendered as text');

const dimensions = [
  ['Table 21"Hx50"Wx30"D', '21"Hx50"Wx30"D', 'labeled'],
  ['Chair 35x33x41', '35x33x41', 'unlabeled'],
  ['Table 72"x42"x30"H', '72"x42"x30"H', 'partially-labeled'],
  ['Lamp 32.5" H', '32.5" H', 'labeled'],
  ['Round table 15" Dia.', '15" Dia.', 'labeled'],
  ['Snifters 5 1/8"H', '5 1/8"H', 'labeled'],
  ['Trio 2.5"/3"/4"', '2.5"/3"/4"', 'unlabeled'],
  ['Chandelier 50"Dx69/96"H', '50"Dx69/96"H', 'labeled'],
  ['Chandelier 32"Hx25\'W 60 Lbs.', '32"Hx25\'W', 'labeled'],
  ["Backdrop 8'W x 10'H", "8'W x 10'H", 'labeled'],
  ["Pair of benches, each 6' long", "6'", 'unlabeled'],
  ["Vintage 70's chair 44x22x62.5", '44x22x62.5', 'unlabeled'],
  ['Pendant 23.5H', '23.5H', 'labeled']
];
for (const [title, raw, labelStatus] of dimensions) {
  const result = Catalog.extractDimensions(title);
  equal(result?.raw, raw, `exact dimension substring: ${title}`);
  equal(result?.labelStatus, labelStatus, `dimension label status: ${title}`);
}
equal(Catalog.extractDimensions('SET/3 Walter Hagen chairs'), null, 'set count and following word do not become dimensions');
equal(Catalog.extractDimensions('Made in 2026, model 4055'), null, 'years and model numbers do not become dimensions');
equal(Catalog.extractDimensions("1880's Italian Rococo Revival table"), null, 'possessive year apostrophes are not feet');
equal(Catalog.extractDimensions("French Art Deco cabinet circa 1940's 67x"), null, 'possessive decade text and incomplete dimensions are not measurements');

function fixtureProduct(overrides = {}) {
  return {
    id: 15502426964205,
    title: 'Exact <Source> Lamp 23.5H',
    handle: 'exact-source-lamp',
    body_html: '<p>Exact lamp</p><b> Item Number: </b><br>6629-20<br><b> Item ID: </b><br>169794<br><b> Category: </b><br>Table Lamp',
    product_type: 'Table Lamp',
    vendor: 'Kiss It Good Buy',
    tags: ['Global Views'],
    variants: [{ id: 68162102526189, title: 'Default Title', option1: 'Default Title', sku: '169794', available: true, price: '99.00', compare_at_price: '149.00', position: 1 }],
    images: [
      { id: 51857056891117, src: 'javascript:alert(1)', position: 1 },
      { id: 51857056891118, src: '/relative.jpg', position: 2 },
      { id: 51857056891119, src: 'https://user:pass@evil.example/image.jpg', position: 3 },
      { id: 51857056891122, src: 'https://cdn.shopify.com/x.jpg\" onerror=\"steal()', position: 4 },
      { id: 51857056891120, src: '//cdn.shopify.com/good.jpg', width: 600, height: 500, position: 5 },
      { id: 51857056891121, src: 'http://cdn.shopify.com/upgraded.jpg', position: 6 }
    ],
    options: [{ name: 'Title', position: 1, values: ['Default Title'] }],
    ...overrides
  };
}

const fixture = Catalog.normalizeProduct(fixtureProduct(), { collectionHandles: ['lamps', 'new-items', 'lamps'] });
equal(fixture.id, '15502426964205', 'product id is a lossless decimal string');
equal(fixture.variants[0].id, '68162102526189', 'variant id is a lossless decimal string');
equal(fixture.title, 'Exact <Source> Lamp 23.5H', 'exact source title is retained for escaped text rendering');
equal(fixture.itemNumber, '6629-20', 'item number is extracted from source body');
equal(fixture.itemId, '169794', 'item id is extracted from source body');
equal(fixture.sourceCategory, 'Table Lamp', 'source category is extracted from source body');
equal(fixture.price, 99, 'primary price is represented in dollars');
equal(fixture.variants[0].priceCents, 9900, 'variant price has exact cents');
equal(fixture.variants[0].compareAtPriceCents, 14900, 'compare-at price has exact cents');
deepEqual(fixture.collections, ['lamps', 'new-items'], 'collection handles are unique and sorted');
deepEqual(fixture.images.map(image => image.src), ['https://cdn.shopify.com/good.jpg', 'https://cdn.shopify.com/upgraded.jpg'], 'unsafe image schemes, relative URLs, and credential URLs are rejected');
throws(() => Catalog.normalizeProduct(fixtureProduct({ id: Number.MAX_SAFE_INTEGER + 1 })), /safe integer range/, 'unsafe numeric product ids are rejected');
throws(() => Catalog.normalizeProduct(fixtureProduct({ variants: [{ id: Number.MAX_SAFE_INTEGER + 1, title: 'Bad', price: '1.00', available: true }] })), /safe integer range/, 'unsafe numeric variant ids are rejected');
throws(() => Catalog.normalizeProduct(fixtureProduct({ variants: [] })), /variants/, 'products without variants are rejected');

const inventory = JSON.parse(await readFile(path.join(projectRoot, 'dist/inventory.json'), 'utf8'));
const researchFiles = await readdir(path.join(projectRoot, 'research'));
const rawName = researchFiles.filter(name => /^full-catalog-raw-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1);
const membershipName = researchFiles.filter(name => /^full-catalog-memberships-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1);
ok(rawName && membershipName, 'dated raw catalog and membership evidence exist');
const rawEvidence = JSON.parse(await readFile(path.join(projectRoot, 'research', rawName), 'utf8'));
const membershipEvidence = JSON.parse(await readFile(path.join(projectRoot, 'research', membershipName), 'utf8'));
equal(rawEvidence.fetchedAt, inventory.fetchedAt, 'raw evidence and inventory share a snapshot timestamp');
equal(membershipEvidence.fetchedAt, inventory.fetchedAt, 'membership evidence and inventory share a snapshot timestamp');

const rawProducts = rawEvidence.products.flatMap(page => page.payload.products);
const rawCollections = rawEvidence.collections.flatMap(page => page.payload.collections);
equal(rawProducts.length, inventory.products.length, 'every raw product is normalized');
equal(rawCollections.length, inventory.collections.length, 'every raw collection is normalized');
equal(inventory.source.productCount, inventory.products.length, 'recorded product count reconciles');
equal(inventory.source.variantCount, inventory.products.reduce((sum, product) => sum + product.variants.length, 0), 'recorded variant count reconciles');

const normalizedById = new Map(inventory.products.map(product => [product.id, product]));
const allVariantIds = new Set();
for (const raw of rawProducts) {
  const normalized = normalizedById.get(String(raw.id));
  ok(normalized, `normalized product exists: ${raw.handle}`);
  equal(normalized.title, raw.title, `exact title: ${raw.handle}`);
  equal(normalized.handle, raw.handle, `exact handle: ${raw.handle}`);
  equal(normalized.variants.length, raw.variants.length, `variant count: ${raw.handle}`);
  equal(normalized.images.length, raw.images.filter(image => /^https?:\/\//.test(image.src || '')).length, `safe image count: ${raw.handle}`);
  ok(!/<\/?(?:script|style|iframe|object|embed|svg|math|img)\b/i.test(normalized.sourceHtml), `sanitized source HTML: ${raw.handle}`);
  ok(!/<[^>]+>/.test(normalized.description), `plain description contains no tags: ${raw.handle}`);
  for (let index = 0; index < raw.variants.length; index += 1) {
    const rawVariant = raw.variants[index];
    const variant = normalized.variants[index];
    equal(variant.id, String(rawVariant.id), `variant id: ${raw.handle}/${rawVariant.id}`);
    equal(variant.priceCents, Catalog.moneyToCents(rawVariant.price), `variant price: ${raw.handle}/${rawVariant.id}`);
    equal(variant.compareAtPriceCents, Catalog.moneyToCents(rawVariant.compare_at_price), `variant compare-at: ${raw.handle}/${rawVariant.id}`);
    equal(variant.available, Boolean(rawVariant.available), `variant availability: ${raw.handle}/${rawVariant.id}`);
    ok(!allVariantIds.has(variant.id), `variant id is globally unique: ${variant.id}`);
    allVariantIds.add(variant.id);
  }
  for (let index = 0; index < raw.images.length; index += 1) {
    const rawImage = raw.images[index];
    if (!/^https?:\/\//.test(rawImage.src || '')) continue;
    const image = normalized.images.find(candidate => candidate.id === String(rawImage.id));
    ok(image, `image id preserved: ${raw.handle}/${rawImage.id}`);
    equal(image.src, String(rawImage.src).replace(/^http:\/\//, 'https://'), `image URL preserved or HTTPS-upgraded: ${raw.handle}/${rawImage.id}`);
    equal(image.width, rawImage.width, `image width: ${raw.handle}/${rawImage.id}`);
    equal(image.height, rawImage.height, `image height: ${raw.handle}/${rawImage.id}`);
  }
}
equal(allVariantIds.size, inventory.source.variantCount, 'all normalized variant ids are unique');

const collectionByHandle = new Map(inventory.collections.map(collection => [collection.handle, collection]));
for (const evidence of membershipEvidence.collections) {
  const collection = collectionByHandle.get(evidence.collection.handle);
  ok(collection, `normalized collection exists: ${evidence.collection.handle}`);
  const returnedIds = evidence.pages.flatMap(page => page.payload.products).map(product => String(product.id));
  deepEqual(collection.productIds, returnedIds, `actual collection membership: ${evidence.collection.handle}`);
  for (const productId of returnedIds) ok(normalizedById.has(productId), `collection product is in catalog: ${evidence.collection.handle}/${productId}`);
}

console.log(`catalog normalization and snapshot: ${assertions} assertions passed (${inventory.products.length} products, ${allVariantIds.size} variants, ${inventory.collections.length} collections)`);
