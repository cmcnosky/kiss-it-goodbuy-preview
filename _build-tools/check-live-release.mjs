#!/usr/bin/env node

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BASE_URL = 'https://cmcnosky.github.io/kiss-it-goodbuy-preview/';
const DEFAULT_MAX_AGE_HOURS = 48;

function parseArguments(argv) {
  const options = { baseUrl: DEFAULT_BASE_URL, maxAgeHours: DEFAULT_MAX_AGE_HOURS, attempts: 6 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--base-url') options.baseUrl = argv[++index];
    else if (argument === '--expected-inventory-sha256') options.expectedInventorySha256 = argv[++index];
    else if (argument === '--max-age-hours') options.maxAgeHours = Number(argv[++index]);
    else if (argument === '--attempts') options.attempts = Number(argv[++index]);
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  const parsed = new URL(options.baseUrl);
  if (parsed.protocol !== 'https:') throw new Error('--base-url must use HTTPS.');
  options.baseUrl = parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`;
  if (!Number.isFinite(options.maxAgeHours) || options.maxAgeHours <= 0) throw new Error('--max-age-hours must be positive.');
  if (!Number.isInteger(options.attempts) || options.attempts < 1 || options.attempts > 12) throw new Error('--attempts must be an integer from 1 to 12.');
  if (options.expectedInventorySha256 && !/^[a-f0-9]{64}$/i.test(options.expectedInventorySha256)) {
    throw new Error('--expected-inventory-sha256 must be a full SHA-256 digest.');
  }
  return options;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchBytes(url, { accept = '*/*', timeoutMs = 20000, method = 'GET', body, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      method,
      body,
      headers: { Accept: accept, 'User-Agent': 'Kiss-It-Good-Buy-release-check/1.0', ...headers },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') || '',
      finalUrl: response.url,
      status: response.status
    };
  } finally {
    clearTimeout(timer);
  }
}

function htmlMetadata(html) {
  const meta = name => html.match(new RegExp(`<meta (?:property|name)="${name}" content="([^"]+)"`))?.[1] || '';
  return {
    canonical: html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] || '',
    ogUrl: meta('og:url'),
    ogImage: meta('og:image'),
    ogSecureImage: meta('og:image:secure_url'),
    twitterImage: meta('twitter:image')
  };
}

function validateHtml(html, url) {
  if (!/^<!doctype html>/i.test(html)) throw new Error(`${url} is missing its HTML doctype.`);
  const headings = html.match(/<h1[\s>]/g) || [];
  if (headings.length !== 1) throw new Error(`${url} has ${headings.length} H1 elements; expected one.`);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) throw new Error(`${url} repeats element id ${[...new Set(duplicates)].join(', ')}.`);
}

function pngSize(bytes) {
  if (bytes.length < 24 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('Social preview is not a PNG.');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function documentBaseUrl(html, pageUrl, siteBaseUrl) {
  const baseHref = html.match(/<base\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1/i)?.[2];
  const documentBase = new URL(baseHref || pageUrl, pageUrl);
  const siteBase = new URL(siteBaseUrl);
  if (documentBase.origin !== siteBase.origin || !documentBase.pathname.startsWith(siteBase.pathname)) {
    throw new Error(`${pageUrl} declares a document base outside the published site: ${documentBase.href}`);
  }
  return documentBase;
}

function localAssetUrls(html, pageUrl, siteBaseUrl) {
  const documentBase = documentBaseUrl(html, pageUrl, siteBaseUrl);
  return [...html.matchAll(/(?:src|href)\s*=\s*(["'])([^"'#]+)\1/gi)]
    .map(match => new URL(match[2], documentBase))
    .filter(url => url.origin === new URL(siteBaseUrl).origin && /\.(?:css|js)$/.test(url.pathname));
}

async function runChecks(options) {
  const report = { baseUrl: options.baseUrl, checkedAt: new Date().toISOString(), pages: [], assets: [] };
  const inventoryUrl = new URL('inventory.json', options.baseUrl);
  if (options.expectedInventorySha256) inventoryUrl.searchParams.set('release-check', options.expectedInventorySha256.slice(0, 16));
  const inventoryResponse = await fetchBytes(inventoryUrl.href, { accept: 'application/json' });
  const inventoryHash = sha256(inventoryResponse.bytes);
  if (options.expectedInventorySha256 && inventoryHash !== options.expectedInventorySha256.toLowerCase()) {
    throw new Error(`Published inventory hash ${inventoryHash} does not match deployed artifact ${options.expectedInventorySha256.toLowerCase()}.`);
  }
  let inventory;
  try { inventory = JSON.parse(inventoryResponse.bytes.toString('utf8')); }
  catch { throw new Error('Published inventory.json is not valid JSON.'); }
  if (!Array.isArray(inventory.products) || !inventory.products.length || !Array.isArray(inventory.collections)) {
    throw new Error('Published inventory is missing its products or collections.');
  }
  const fetchedAt = Date.parse(inventory.fetchedAt);
  if (!Number.isFinite(fetchedAt)) throw new Error('Published inventory has an invalid fetchedAt timestamp.');
  const ageHours = (Date.now() - fetchedAt) / 3_600_000;
  if (ageHours < -1 || ageHours > options.maxAgeHours) {
    throw new Error(`Published inventory age is ${ageHours.toFixed(1)} hours; expected no more than ${options.maxAgeHours}.`);
  }
  const variants = inventory.products.reduce((total, product) => total + (Array.isArray(product.variants) ? product.variants.length : 0), 0);
  if (inventory.source?.productCount !== inventory.products.length || inventory.source?.variantCount !== variants) {
    throw new Error('Published inventory counts do not reconcile with source metadata.');
  }
  report.inventory = { sha256: inventoryHash, fetchedAt: inventory.fetchedAt, ageHours, products: inventory.products.length, variants, collections: inventory.collections.length };

  const firstProduct = inventory.products.find(product => product?.handle);
  const paths = ['', 'collection.html', 'planner.html', 'studio.html', 'practice-checkout.html', 'visit.html', 'shortlist.html', 'cart.html', `products/${encodeURIComponent(firstProduct.handle)}/`];
  let rootHtml = '';
  const pageHtml = [];
  for (const pagePath of paths) {
    const url = new URL(pagePath, options.baseUrl).href;
    const response = await fetchBytes(url, { accept: 'text/html' });
    if (!/^text\/html\b/i.test(response.contentType)) throw new Error(`${url} returned ${response.contentType || 'no content type'}, expected HTML.`);
    const html = response.bytes.toString('utf8');
    validateHtml(html, url);
    if (!pagePath) rootHtml = html;
    pageHtml.push({ html, url });
    report.pages.push({ url, bytes: response.bytes.length });
  }

  const metadata = htmlMetadata(rootHtml);
  if (metadata.canonical !== options.baseUrl || metadata.ogUrl !== options.baseUrl) throw new Error('Homepage canonical and Open Graph URLs do not match the permanent sharing address.');
  if (!metadata.ogImage || metadata.ogImage !== metadata.ogSecureImage || metadata.ogImage !== metadata.twitterImage) {
    throw new Error('Homepage social preview metadata is incomplete or inconsistent.');
  }
  const preview = await fetchBytes(metadata.ogImage, { accept: 'image/png' });
  if (!/^image\/png\b/i.test(preview.contentType)) throw new Error(`Social preview returned ${preview.contentType || 'no content type'}, expected PNG.`);
  const previewSize = pngSize(preview.bytes);
  if (previewSize.width !== 1200 || previewSize.height !== 630) throw new Error(`Social preview is ${previewSize.width}x${previewSize.height}, expected 1200x630.`);
  report.socialPreview = { url: metadata.ogImage, sha256: sha256(preview.bytes), ...previewSize };

  const localAssets = pageHtml.flatMap(page => localAssetUrls(page.html, page.url, options.baseUrl));
  const loadedAssets = new Map();
  for (const url of [...new Map(localAssets.map(asset => [asset.href, asset])).values()]) {
    const response = await fetchBytes(url.href);
    const extension = url.pathname.split('.').pop();
    const expected = extension === 'css' ? 'text/css' : /(?:javascript|ecmascript)/;
    const typeOk = typeof expected === 'string' ? response.contentType.startsWith(expected) : expected.test(response.contentType);
    if (!typeOk) throw new Error(`${url.href} returned unexpected content type ${response.contentType || '(missing)'}.`);
    loadedAssets.set(path.basename(url.pathname), response.bytes);
    report.assets.push({ url: url.href, bytes: response.bytes.length, sha256: sha256(response.bytes) });
  }
  for (const required of [
    'app.js',
    'commerce.js',
    'checkout-recovery.js',
    'planner.js',
    'studio-state.js',
    'studio-runtime.js',
    'studio.js',
    'style.css',
    'planner.css',
    'studio-runtime.css',
    'studio.css'
  ]) {
    if (!report.assets.some(asset => new URL(asset.url).pathname.endsWith(`/${required}`))) throw new Error(`Published pages do not load required asset ${required}.`);
  }

  const shopifyRead = await fetchBytes('https://kissitgoodbuy.net/products.json?limit=1', { accept: 'application/json' });
  let shopifyPayload;
  try { shopifyPayload = JSON.parse(shopifyRead.bytes.toString('utf8')); }
  catch { throw new Error('Shopify public catalog read returned invalid JSON.'); }
  if (!Array.isArray(shopifyPayload.products) || !shopifyPayload.products.length) throw new Error('Shopify public catalog read returned no products.');
  report.shopifyRead = { status: shopifyRead.status, productsReturned: shopifyPayload.products.length };

  const commerceSource = loadedAssets.get('commerce.js')?.toString('utf8') || '';
  const commerceEndpoint = commerceSource.match(/const API_ENDPOINT = ['"](https:\/\/kissitgoodbuy\.net\/api\/[^'"]+\/graphql\.json)['"]/)?.[1];
  if (!commerceEndpoint) throw new Error('Published commerce.js does not expose the expected read-only Shopify API endpoint.');
  const variant = firstProduct.variants?.[0];
  if (!variant?.id) throw new Error('Published catalog has no representative variant for the commerce dependency check.');
  const variantId = `gid://shopify/ProductVariant/${variant.id}`;
  const commerceQuery = `query ReleaseCartDependency($id: ID!) {
    node(id: $id) {
      ... on ProductVariant {
        id
        availableForSale
        price { amount currencyCode }
        quantityRule { minimum maximum increment }
        product { handle }
      }
    }
  }`;
  const commerceRead = await fetchBytes(commerceEndpoint, {
    accept: 'application/json',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: commerceQuery, variables: { id: variantId } })
  });
  let commercePayload;
  try { commercePayload = JSON.parse(commerceRead.bytes.toString('utf8')); }
  catch { throw new Error('Shopify commerce dependency read returned invalid JSON.'); }
  if (commercePayload.errors?.length) {
    throw new Error(`Shopify commerce dependency read failed: ${commercePayload.errors.map(error => error.message).filter(Boolean).join(' ')}`);
  }
  const remoteVariant = commercePayload.data?.node;
  if (remoteVariant?.id !== variantId || remoteVariant.product?.handle !== firstProduct.handle
    || remoteVariant.price?.currencyCode !== 'USD' || !/^\d+(?:\.\d+)?$/.test(String(remoteVariant.price?.amount || ''))
    || !Number.isInteger(remoteVariant.quantityRule?.minimum) || !Number.isInteger(remoteVariant.quantityRule?.increment)) {
    throw new Error('Shopify commerce dependency read did not return the expected variant, price, and quantity fields.');
  }
  report.shopifyCartDependencyRead = {
    status: commerceRead.status,
    endpoint: commerceEndpoint,
    variantId,
    productHandle: remoteVariant.product.handle,
    currencyCode: remoteVariant.price.currencyCode,
    minimum: remoteVariant.quantityRule.minimum,
    increment: remoteVariant.quantityRule.increment
  };
  return report;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  let lastError;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      const report = await runChecks(options);
      report.attempt = attempt;
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    } catch (error) {
      lastError = error;
      process.stderr.write(`Live release check attempt ${attempt}/${options.attempts} failed: ${error.message}\n`);
      if (attempt < options.attempts) await sleep(5000);
    }
  }
  throw lastError;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });

export { documentBaseUrl, htmlMetadata, localAssetUrls, parseArguments, pngSize, runChecks, validateHtml };
