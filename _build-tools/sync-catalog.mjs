#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const Catalog = require(path.join(projectRoot, 'dist/catalog-normalize.js'));
const DEFAULT_BASE_URL = 'https://kissitgoodbuy.net';
const PAGE_LIMIT = 250;
const MAX_PAGES = 100;
const REQUEST_SPACING_MS = 200;
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const RETRYABLE_STATUS = new Set([429, 503]);
const DROP_LIMITS = Object.freeze({
  products: { ratio: 0.25, minimum: 10 },
  variants: { ratio: 0.25, minimum: 10 },
  collections: { ratio: 0.25, minimum: 3 },
  memberships: { ratio: 0.35, minimum: 20 }
});

let lastRequestStartedAt = 0;

function parseArguments(argv) {
  const values = { baseUrl: DEFAULT_BASE_URL, out: path.join(projectRoot, 'dist/inventory.json') };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--self-test') values.selfTest = true;
    else if (argument === '--base-url') values.baseUrl = argv[++index];
    else if (argument === '--out') values.out = path.resolve(argv[++index]);
    else if (argument === '--recorded-at') values.recordedAt = argv[++index];
    else if (argument === '--research-dir') values.researchDir = path.resolve(argv[++index]);
    else if (argument === '--baseline') values.baseline = path.resolve(argv[++index]);
    else if (argument === '--baseline-url') values.baselineUrl = argv[++index];
    else if (argument === '--allow-large-change') values.allowLargeChange = true;
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  values.baseUrl = String(values.baseUrl || '').replace(/\/+$/, '');
  const parsedBase = new URL(values.baseUrl);
  if (parsedBase.protocol !== 'https:') throw new Error('--base-url must use HTTPS.');
  if (values.baseline && values.baselineUrl) throw new Error('Use either --baseline or --baseline-url, not both.');
  if (values.baselineUrl) {
    const parsedBaseline = new URL(values.baselineUrl);
    if (parsedBaseline.protocol !== 'https:') throw new Error('--baseline-url must use HTTPS.');
    values.baselineUrl = parsedBaseline.href;
  }
  values.researchDir ||= path.join(projectRoot, 'research');
  if (values.recordedAt && Number.isNaN(Date.parse(values.recordedAt))) throw new Error('--recorded-at must be an ISO-compatible date.');
  return values;
}

function inventoryCounts(inventory, label = 'Catalog') {
  if (!inventory || inventory.schemaVersion !== 1 || !Array.isArray(inventory.products) || !Array.isArray(inventory.collections)) {
    throw new Error(`${label} is not a supported inventory snapshot.`);
  }
  if (!inventory.products.length) throw new Error(`${label} contains no products.`);
  const productIds = new Set();
  const handles = new Set();
  const variantIds = new Set();
  const productCollections = new Map();
  for (const product of inventory.products) {
    if (!product || typeof product.id !== 'string' || !product.id || productIds.has(product.id)) {
      throw new Error(`${label} contains a missing or duplicate product id.`);
    }
    if (typeof product.handle !== 'string' || !product.handle || handles.has(product.handle)) {
      throw new Error(`${label} contains a missing or duplicate product handle.`);
    }
    if (!Array.isArray(product.variants) || !product.variants.length) {
      throw new Error(`${label} product ${product.handle} has no variants.`);
    }
    if (typeof product.title !== 'string' || !product.title.trim()) {
      throw new Error(`${label} product ${product.handle} has no title.`);
    }
    if (typeof product.available !== 'boolean') {
      throw new Error(`${label} product ${product.handle} has invalid availability.`);
    }
    if (!Array.isArray(product.images)
      || product.images.some(image => !image || typeof image.src !== 'string' || !image.src.startsWith('https://'))) {
      throw new Error(`${label} product ${product.handle} has an invalid image list.`);
    }
    if (!Array.isArray(product.collections)) {
      throw new Error(`${label} product ${product.handle} has no collection-membership list.`);
    }
    const membershipsForProduct = new Set(product.collections);
    if (membershipsForProduct.size !== product.collections.length
      || [...membershipsForProduct].some(handle => typeof handle !== 'string' || !handle)) {
      throw new Error(`${label} product ${product.handle} has invalid or duplicate collection memberships.`);
    }
    productIds.add(product.id);
    handles.add(product.handle);
    productCollections.set(product.id, membershipsForProduct);
    for (const variant of product.variants) {
      if (!variant || typeof variant.id !== 'string' || !variant.id || variantIds.has(variant.id)) {
        throw new Error(`${label} contains a missing or duplicate variant id.`);
      }
      if (!Number.isSafeInteger(variant.priceCents) || variant.priceCents < 0) {
        throw new Error(`${label} variant ${variant.id} has an invalid price.`);
      }
      if (typeof variant.available !== 'boolean') {
        throw new Error(`${label} variant ${variant.id} has invalid availability.`);
      }
      variantIds.add(variant.id);
    }
  }
  const collectionHandles = new Set();
  const membershipPairs = new Set();
  const membershipByCollection = {};
  let memberships = 0;
  for (const collection of inventory.collections) {
    if (!collection || typeof collection.handle !== 'string' || !collection.handle || collectionHandles.has(collection.handle)) {
      throw new Error(`${label} contains a missing or duplicate collection handle.`);
    }
    if (!Array.isArray(collection.productIds)) throw new Error(`${label} collection ${collection.handle} has no membership list.`);
    const collectionProducts = new Set();
    for (const productId of collection.productIds) {
      if (!productIds.has(String(productId))) throw new Error(`${label} collection ${collection.handle} refers to an unknown product ${productId}.`);
      if (collectionProducts.has(String(productId))) throw new Error(`${label} collection ${collection.handle} repeats product ${productId}.`);
      collectionProducts.add(String(productId));
      membershipPairs.add(`${collection.handle}\0${String(productId)}`);
    }
    collectionHandles.add(collection.handle);
    membershipByCollection[collection.handle] = collectionProducts.size;
    memberships += collectionProducts.size;
  }
  for (const [productId, listedCollections] of productCollections) {
    for (const collectionHandle of listedCollections) {
      if (!collectionHandles.has(collectionHandle)) {
        throw new Error(`${label} product ${productId} refers to unknown collection ${collectionHandle}.`);
      }
      if (!membershipPairs.has(`${collectionHandle}\0${productId}`)) {
        throw new Error(`${label} product ${productId} and collection ${collectionHandle} disagree on membership.`);
      }
    }
  }
  for (const pair of membershipPairs) {
    const [collectionHandle, productId] = pair.split('\0');
    if (!productCollections.get(productId)?.has(collectionHandle)) {
      throw new Error(`${label} collection ${collectionHandle} and product ${productId} disagree on membership.`);
    }
  }
  const fetchedAt = Date.parse(inventory.fetchedAt);
  if (!Number.isFinite(fetchedAt)) throw new Error(`${label} has an invalid fetchedAt timestamp.`);
  if (inventory.source != null) {
    if (!inventory.source || typeof inventory.source !== 'object' || Array.isArray(inventory.source)) {
      throw new Error(`${label} has invalid source metadata.`);
    }
    const expectedCounts = {
      productCount: productIds.size,
      variantCount: variantIds.size,
      collectionCount: collectionHandles.size,
      collectionMembershipCount: memberships
    };
    for (const [field, expected] of Object.entries(expectedCounts)) {
      if (inventory.source[field] !== expected) {
        throw new Error(`${label} source ${field} does not match its records.`);
      }
    }
    if (Date.parse(inventory.source.fetchedAt) !== fetchedAt) {
      throw new Error(`${label} source fetchedAt does not match its snapshot timestamp.`);
    }
  }
  return {
    fetchedAt,
    fetchedAtIso: new Date(fetchedAt).toISOString(),
    products: productIds.size,
    variants: variantIds.size,
    collections: collectionHandles.size,
    memberships,
    membershipByCollection
  };
}

function dropViolation(name, current, baseline, limit = DROP_LIMITS[name]) {
  const lost = baseline - current;
  if (lost < limit.minimum || lost / baseline < limit.ratio) return null;
  return `${name} fell from ${baseline} to ${current} (${Math.round((lost / baseline) * 100)}% loss)`;
}

function evaluateReleaseGuard(currentInventory, baselineInventory) {
  const current = inventoryCounts(currentInventory, 'Refreshed catalog');
  const baseline = inventoryCounts(baselineInventory, 'Baseline catalog');
  const invariantViolations = [];
  const changeViolations = [];
  if (current.fetchedAt <= baseline.fetchedAt) {
    invariantViolations.push(`refreshed timestamp ${current.fetchedAtIso} is not newer than baseline ${baseline.fetchedAtIso}`);
  }
  for (const name of Object.keys(DROP_LIMITS)) {
    const violation = dropViolation(name, current[name], baseline[name]);
    if (violation) changeViolations.push(violation);
  }
  for (const [handle, baselineMemberships] of Object.entries(baseline.membershipByCollection)) {
    if (!Object.prototype.hasOwnProperty.call(current.membershipByCollection, handle)) {
      changeViolations.push(`collection ${handle} is missing from the refreshed catalog`);
      continue;
    }
    const currentMemberships = current.membershipByCollection[handle];
    const lost = baselineMemberships - currentMemberships;
    if (baselineMemberships >= 10 && lost >= 10 && lost / baselineMemberships >= 0.5) {
      changeViolations.push(`collection ${handle} memberships fell from ${baselineMemberships} to ${currentMemberships} (${Math.round((lost / baselineMemberships) * 100)}% loss)`);
    }
  }
  return { current, baseline, invariantViolations, changeViolations, violations: [...invariantViolations, ...changeViolations] };
}

function enforceReleaseGuard(currentInventory, baselineInventory, { allowLargeChange = false } = {}) {
  const result = evaluateReleaseGuard(currentInventory, baselineInventory);
  if (result.invariantViolations.length) {
    throw new Error(`Catalog release guard blocked publication:\n- ${result.invariantViolations.join('\n- ')}\nSchema, integrity, and recency failures cannot be overridden.`);
  }
  if (result.changeViolations.length && !allowLargeChange) {
    throw new Error(`Catalog release guard blocked publication:\n- ${result.changeViolations.join('\n- ')}\nReview the source change. For a verified legitimate removal, rerun manually with --allow-large-change.`);
  }
  return { ...result, overridden: Boolean(result.changeViolations.length && allowLargeChange) };
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
  const names = ['content-type', 'etag', 'last-modified', 'access-control-allow-origin', 'powered-by', 'retry-after'];
  return Object.fromEntries(names.map(name => [name, headers.get(name)]).filter(([, value]) => value != null));
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function retryAfterMilliseconds(value, now = Date.now()) {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(seconds * 1000));
  const date = Date.parse(text);
  if (Number.isNaN(date)) return null;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, date - now));
}

async function waitForRequestSlot() {
  const remaining = REQUEST_SPACING_MS - (Date.now() - lastRequestStartedAt);
  if (remaining > 0) await sleep(remaining);
  lastRequestStartedAt = Date.now();
}

class HttpResponseError extends Error {
  constructor(response, url) {
    super(`${response.status} ${response.statusText}: ${url}`);
    this.name = 'HttpResponseError';
    this.status = response.status;
    this.retryAfter = response.headers.get('retry-after');
  }
}

async function fetchJson(url, attempts = MAX_ATTEMPTS) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await waitForRequestSlot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Kiss-It-Good-Buy-catalog-sync/1.0' },
        signal: controller.signal
      });
      const rawBody = await response.text();
      if (!response.ok) throw new HttpResponseError(response, url);
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
      const retryableHttp = error instanceof HttpResponseError && RETRYABLE_STATUS.has(error.status);
      const retryableOther = !(error instanceof HttpResponseError);
      if (attempt >= attempts || (!retryableHttp && !retryableOther)) break;
      const exponential = Math.min(MAX_RETRY_DELAY_MS, RETRY_BASE_MS * (2 ** (attempt - 1)));
      const requested = retryAfterMilliseconds(error.retryAfter);
      await sleep(Math.max(exponential, requested ?? 0));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function fetchPages(baseUrl, pathname, key, options = {}) {
  const fetchPage = options.fetchJson || fetchJson;
  const records = [];
  const pages = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const joiner = pathname.includes('?') ? '&' : '?';
    const response = await fetchPage(`${baseUrl}${pathname}${joiner}limit=${PAGE_LIMIT}&page=${page}`);
    const pageRecords = response.payload?.[key];
    if (!Array.isArray(pageRecords)) throw new Error(`${response.url} did not return a ${key} array.`);
    pages.push(response);
    records.push(...pageRecords);
    if (pageRecords.length < PAGE_LIMIT) return { records, pages };
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

async function runSelfTest() {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  check(Catalog.moneyToCents('1,299.20') === 129920, 'moneyToCents preserves cents');
  const unsafe = '<p class="x">Keep <strong onclick="x">this</strong></p><script>alert(1)</script><img src=x onerror=x>';
  const safe = Catalog.sanitizeSourceHtml(unsafe);
  check(safe === '<p>Keep <strong>this</strong></p>', 'HTML sanitizer strips attributes, unsafe tags, and blocked content');
  check(Catalog.plainHtmlText('<p>A &amp; B</p><p>C</p>') === 'A & B\nC', 'plain HTML conversion');
  check(Catalog.extractDimensions('Table 21"Hx50"Wx30"D')?.labelStatus === 'labeled', 'labeled dimensions');
  check(Catalog.extractDimensions('Chair 35x33x41')?.labelStatus === 'unlabeled', 'unlabeled dimensions stay unlabeled');
  check(Catalog.extractDimensions("1880's Italian table") === null, 'possessive year apostrophes are not measurements');
  check(Catalog.extractDimensions("Backdrop 8'W x 10'H")?.raw === "8'W x 10'H", 'legitimate feet measurements are preserved');
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

  const shortPageCalls = [];
  const shortPage = await fetchPages('https://example.test', '/products.json', 'products', {
    fetchJson: async url => {
      shortPageCalls.push(url);
      return { url, payload: { products: [{ id: 1 }, { id: 2 }] } };
    }
  });
  check(shortPageCalls.length === 1 && shortPage.records.length === 2 && shortPage.pages.length === 1, 'a short page terminates pagination without an empty follow-up request');

  const fullPageCalls = [];
  const fullPage = await fetchPages('https://example.test', '/products.json', 'products', {
    fetchJson: async url => {
      fullPageCalls.push(url);
      return {
        url,
        payload: { products: fullPageCalls.length === 1 ? Array.from({ length: PAGE_LIMIT }, (_, index) => ({ id: index + 1 })) : [] }
      };
    }
  });
  check(fullPageCalls.length === 2 && fullPage.records.length === PAGE_LIMIT && fullPage.pages.length === 2, 'a full page continues until a short page confirms completion');
  check(retryAfterMilliseconds('2') === 2000 && retryAfterMilliseconds('not-a-date') === null, 'Retry-After seconds are parsed and invalid values are ignored');
  if (failures.length) throw new Error(`Self-test failed:\n- ${failures.join('\n- ')}`);
  process.stdout.write('Catalog self-test passed (12 checks).\n');
}

async function main() {
  const config = parseArguments(process.argv.slice(2));
  if (config.selfTest) return await runSelfTest();
  const fetchedAt = config.recordedAt ? new Date(config.recordedAt).toISOString() : new Date().toISOString();
  const dateStamp = fetchedAt.slice(0, 10);

  let baselineInventory = null;
  if (config.baselineUrl) {
    const response = await fetchJson(config.baselineUrl);
    baselineInventory = response.payload;
    inventoryCounts(baselineInventory, 'Published baseline catalog');
  }

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
  inventoryCounts(inventory, 'Refreshed catalog');

  let releaseGuard = null;
  if (config.baseline || baselineInventory) {
    let baseline = baselineInventory;
    try {
      if (!baseline) baseline = JSON.parse(await readFile(config.baseline, 'utf8'));
    } catch (error) {
      throw new Error(`Could not read baseline catalog ${config.baseline}: ${error.message}`);
    }
    releaseGuard = enforceReleaseGuard(inventory, baseline, { allowLargeChange: config.allowLargeChange });
    if (releaseGuard.overridden) {
      process.stderr.write(`CATALOG RELEASE GUARD OVERRIDE\n${releaseGuard.violations.map(item => `- ${item}`).join('\n')}\n`);
    }
  }

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
    collectionCountDiscrepancies: discrepancies,
    releaseGuard: releaseGuard && {
      baseline: releaseGuard.baseline,
      current: releaseGuard.current,
      overridden: releaseGuard.overridden,
      violations: releaseGuard.violations
    }
  }, null, 2)}\n`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

export { DROP_LIMITS, evaluateReleaseGuard, enforceReleaseGuard, inventoryCounts };
