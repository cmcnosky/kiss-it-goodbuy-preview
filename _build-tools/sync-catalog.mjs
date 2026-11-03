#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const Catalog = require(path.join(projectRoot, 'dist/catalog-normalize.js'));
const DEFAULT_BASE_URL = 'https://kissitgoodbuy.net';
const PAGE_LIMIT = 250;
const MAX_PAGES = 100;

function parseArguments(argv) {
  const values = { baseUrl: DEFAULT_BASE_URL, out: path.join(projectRoot, 'dist/inventory.json') };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--self-test') values.selfTest = true;
    else if (argument === '--base-url') values.baseUrl = argv[++index];
    else if (argument === '--out') values.out = path.resolve(argv[++index]);
    else if (argument === '--recorded-at') values.recordedAt = argv[++index];
    else if (argument === '--research-dir') values.researchDir = path.resolve(argv[++index]);
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  values.baseUrl = String(values.baseUrl || '').replace(/\/+$/, '');
  const parsedBase = new URL(values.baseUrl);
  if (parsedBase.protocol !== 'https:') throw new Error('--base-url must use HTTPS.');
  values.researchDir ||= path.join(projectRoot, 'research');
  if (values.recordedAt && Number.isNaN(Date.parse(values.recordedAt))) throw new Error('--recorded-at must be an ISO-compatible date.');
  return values;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeAtomic(target, contents) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}`);
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, target);
}

function selectedHeaders(headers) {
  const names = ['content-type', 'etag', 'last-modified', 'access-control-allow-origin', 'powered-by'];
  return Object.fromEntries(names.map(name => [name, headers.get(name)]).filter(([, value]) => value != null));
}

async function fetchJson(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Kiss-It-Good-Buy-catalog-sync/1.0' },
        signal: controller.signal
      });
      const rawBody = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
      let payload;
      try { payload = JSON.parse(rawBody); } catch { throw new Error(`Invalid JSON from ${url}`); }
      return {
        url,
        status: response.status,
        headers: selectedHeaders(response.headers),
        sha256: sha256(rawBody),
        payload
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 750));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function fetchPages(baseUrl, pathname, key) {
  const records = [];
  const pages = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const joiner = pathname.includes('?') ? '&' : '?';
    const response = await fetchJson(`${baseUrl}${pathname}${joiner}limit=${PAGE_LIMIT}&page=${page}`);
    const pageRecords = response.payload?.[key];
    if (!Array.isArray(pageRecords)) throw new Error(`${response.url} did not return a ${key} array.`);
    pages.push(response);
    if (!pageRecords.length) return { records, pages };
    records.push(...pageRecords);
  }
  throw new Error(`${pathname} exceeded the ${MAX_PAGES}-page safety limit.`);
}

function assertUnique(records, field, label) {
  const seen = new Set();
  for (const record of records) {
    const value = String(record?.[field] ?? '');
    if (!value) throw new Error(`${label} has a record without ${field}.`);
    if (seen.has(value)) throw new Error(`${label} contains duplicate ${field}: ${value}`);
    seen.add(value);
  }
}

function normalizeCollectionImage(image) {
  if (!image?.src) return null;
  const src = String(image.src).replace(/^http:\/\//, 'https://').replace(/^\/\//, 'https://');
  if (!src.startsWith('https://')) return null;
  return {
    src,
    alt: image.alt == null ? null : String(image.alt),
    width: Number.isFinite(Number(image.width)) ? Number(image.width) : null,
    height: Number.isFinite(Number(image.height)) ? Number(image.height) : null
  };
}

function runSelfTest() {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  check(Catalog.moneyToCents('1,299.20') === 129920, 'moneyToCents preserves cents');
  const unsafe = '<p class="x">Keep <strong onclick="x">this</strong></p><script>alert(1)</script><img src=x onerror=x>';
  const safe = Catalog.sanitizeSourceHtml(unsafe);
  check(safe === '<p>Keep <strong>this</strong></p>', 'HTML sanitizer strips attributes, unsafe tags, and blocked content');
  check(Catalog.plainHtmlText('<p>A &amp; B</p><p>C</p>') === 'A & B\nC', 'plain HTML conversion');
  check(Catalog.extractDimensions('Table 21"Hx50"Wx30"D')?.labelStatus === 'labeled', 'labeled dimensions');
  check(Catalog.extractDimensions('Chair 35x33x41')?.labelStatus === 'unlabeled', 'unlabeled dimensions stay unlabeled');
  const giftCard = Catalog.normalizeProduct({
    id: 1,
    title: 'Exact Gift Card Title',
    handle: 'gift-card',
    body_html: '<p>Store gift card</p>',
    variants: [
      { id: 11, title: '$25', price: '25.00', available: true, position: 1, option1: '$25' },
      { id: 12, title: '$100', price: '100.00', available: true, position: 2, option1: '$100' }
    ],
    options: [{ name: 'Denominations', position: 1, values: ['$25', '$100'] }],
    images: []
  });
  check(giftCard.title === 'Exact Gift Card Title', 'exact source title is preserved');
  check(giftCard.minPrice === 25 && giftCard.maxPrice === 100 && giftCard.variants.length === 2, 'multi-variant price range');
  if (failures.length) throw new Error(`Self-test failed:\n- ${failures.join('\n- ')}`);
  process.stdout.write('Catalog self-test passed (7 checks).\n');
}

async function main() {
  const config = parseArguments(process.argv.slice(2));
  if (config.selfTest) return runSelfTest();
  const fetchedAt = config.recordedAt ? new Date(config.recordedAt).toISOString() : new Date().toISOString();
  const dateStamp = fetchedAt.slice(0, 10);

  const productSource = await fetchPages(config.baseUrl, '/products.json', 'products');
  const collectionSource = await fetchPages(config.baseUrl, '/collections.json', 'collections');
  const rawProducts = productSource.records;
  const rawCollections = collectionSource.records;
  if (!rawProducts.length) throw new Error('The public catalog returned zero products; existing output was left unchanged.');
  assertUnique(rawProducts, 'id', 'Products');
  assertUnique(rawProducts, 'handle', 'Products');
  assertUnique(rawCollections, 'id', 'Collections');
  assertUnique(rawCollections, 'handle', 'Collections');
  for (const record of [...rawProducts, ...rawCollections]) {
    if (!Number.isSafeInteger(Number(record.id))) throw new Error(`Shopify id ${record.id} is outside JavaScript's safe integer range.`);
  }

  const productIds = new Set(rawProducts.map(product => String(product.id)));
  const variantIds = new Set();
  for (const product of rawProducts) {
    if (!Array.isArray(product.variants) || !product.variants.length) throw new Error(`${product.handle} has no variants.`);
    for (const variant of product.variants) {
      const id = String(variant.id ?? '');
      if (!id || !Number.isSafeInteger(Number(variant.id)) || variantIds.has(id)) throw new Error(`Missing, unsafe, or duplicate variant id ${id || '(blank)'}.`);
      variantIds.add(id);
    }
  }

  const memberships = {};
  const membershipEvidence = [];
  const normalizedCollections = [];
  for (const collection of rawCollections) {
    const source = await fetchPages(config.baseUrl, `/collections/${encodeURIComponent(collection.handle)}/products.json`, 'products');
    const collectionIds = source.records.map(product => Number(product.id));
    const unknownIds = collectionIds.filter(id => !productIds.has(String(id)));
    if (unknownIds.length) {
      throw new Error(`Collection ${collection.handle} returned product ids absent from products.json (${unknownIds.join(', ')}); rerun for a consistent snapshot.`);
    }
    for (const id of collectionIds) (memberships[String(id)] ||= []).push(collection.handle);
    normalizedCollections.push({
      id: String(collection.id),
      handle: String(collection.handle),
      title: String(collection.title),
      description: Catalog.plainHtmlText(collection.description || ''),
      publishedAt: collection.published_at || null,
      updatedAt: collection.updated_at || null,
      image: normalizeCollectionImage(collection.image),
      declaredProductCount: Number.isFinite(Number(collection.products_count)) ? Number(collection.products_count) : null,
      productIds: collectionIds.map(String)
    });
    membershipEvidence.push({
      collection: { id: collection.id, handle: collection.handle, title: collection.title, declaredProductCount: collection.products_count },
      pages: source.pages
    });
  }

  const products = Catalog.normalizeProducts(rawProducts, { memberships });
  assertUnique(products, 'id', 'Normalized products');
  assertUnique(products, 'handle', 'Normalized products');
  for (const product of products) {
    if (product.images.some(image => !image.src.startsWith('https://'))) throw new Error(`${product.handle} has a non-HTTPS image.`);
    if (product.variants.some(variant => !/^\d+$/.test(variant.id) || variant.priceCents == null)) throw new Error(`${product.handle} has an invalid normalized variant.`);
  }

  const discrepancies = normalizedCollections
    .filter(collection => collection.declaredProductCount !== null && collection.declaredProductCount !== collection.productIds.length)
    .map(collection => ({ handle: collection.handle, declared: collection.declaredProductCount, returned: collection.productIds.length }));
  const source = {
    baseUrl: config.baseUrl,
    productsEndpoint: `${config.baseUrl}/products.json`,
    collectionsEndpoint: `${config.baseUrl}/collections.json`,
    fetchedAt,
    productCount: products.length,
    variantCount: products.reduce((total, product) => total + product.variants.length, 0),
    availableProductCount: products.filter(product => product.available).length,
    unavailableProductCount: products.filter(product => !product.available).length,
    collectionCount: normalizedCollections.length,
    collectionMembershipCount: normalizedCollections.reduce((total, collection) => total + collection.productIds.length, 0),
    collectionCountDiscrepancies: discrepancies,
    productPageHashes: productSource.pages.map(page => ({ url: page.url, sha256: page.sha256, etag: page.headers.etag || null })),
    collectionPageHashes: collectionSource.pages.map(page => ({ url: page.url, sha256: page.sha256, etag: page.headers.etag || null }))
  };
  const inventory = { schemaVersion: 1, fetchedAt, source, collections: normalizedCollections, products };

  const rawEvidence = {
    schemaVersion: 1,
    fetchedAt,
    note: 'Unmodified parsed payloads and hashes of the exact response bytes from the public Shopify JSON endpoints.',
    products: productSource.pages,
    collections: collectionSource.pages
  };
  const membershipSnapshot = {
    schemaVersion: 1,
    fetchedAt,
    note: 'Unmodified parsed collection-product payloads. Repetition is intentional so collection membership remains auditable.',
    collections: membershipEvidence
  };
  const summary = {
    schemaVersion: 1,
    fetchedAt,
    source,
    checks: {
      uniqueProductIds: products.length,
      uniqueProductHandles: products.length,
      uniqueVariantIds: variantIds.size,
      productsWithItemNumber: products.filter(product => product.itemNumber).length,
      productsWithoutItemNumber: products.filter(product => !product.itemNumber).map(product => product.handle),
      productsWithDimensionsFromTitle: products.filter(product => product.dimensionsRaw).length,
      productsWithoutImages: products.filter(product => !product.images.length).map(product => product.handle),
      productsWithMultipleVariants: products.filter(product => product.variants.length > 1).map(product => product.handle),
      allNormalizedImagesUseHttps: products.every(product => product.images.every(image => image.src.startsWith('https://'))),
      allProductsHavePurchasableVariantRecords: products.every(product => product.variants.length > 0)
    },
    dimensionRule: 'dimensionsRaw preserves an exact substring from the merchant title. labelStatus reports whether source axes are labeled; unlabeled axes are never assigned width, depth, or height.',
    availabilityRule: 'Availability is true when any public Shopify variant was available at fetchedAt. The live store remains authoritative after that instant.',
    collectionRule: 'productIds reflect products actually returned by each collection endpoint. declaredProductCount is retained separately because Shopify collection metadata can be stale.'
  };

  const inventoryJson = stableJson(inventory);
  await Promise.all([
    writeAtomic(config.out, inventoryJson),
    writeAtomic(path.join(config.researchDir, `full-catalog-raw-${dateStamp}.json`), stableJson(rawEvidence)),
    writeAtomic(path.join(config.researchDir, `full-catalog-memberships-${dateStamp}.json`), stableJson(membershipSnapshot)),
    writeAtomic(path.join(config.researchDir, `full-catalog-summary-${dateStamp}.json`), stableJson(summary))
  ]);
  process.stdout.write(`${JSON.stringify({
    output: config.out,
    inventorySha256: sha256(inventoryJson),
    fetchedAt,
    products: source.productCount,
    variants: source.variantCount,
    collections: source.collectionCount,
    collectionCountDiscrepancies: discrepancies
  }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
