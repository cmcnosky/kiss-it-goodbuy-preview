#!/usr/bin/env node

import assert from 'node:assert/strict';
import { evaluateReleaseGuard, enforceReleaseGuard, inventoryCounts } from './sync-catalog.mjs';
import { documentBaseUrl, localAssetUrls } from './check-live-release.mjs';

function inventory({
  fetchedAt = '2026-11-06T12:00:00.000Z',
  products = 100,
  variantsPerProduct = 1,
  collections = 10,
  membershipsPerProduct = 2
} = {}) {
  const records = Array.from({ length: products }, (_, index) => ({
    id: String(1000 + index),
    handle: `piece-${index}`,
    title: `Piece ${index}`,
    available: true,
    images: [],
    collections: [],
    variants: Array.from({ length: variantsPerProduct }, (__, variantIndex) => ({
      id: String(100000 + index * variantsPerProduct + variantIndex),
      priceCents: 10000 + index,
      available: true
    }))
  }));
  const collectionRecords = Array.from({ length: collections }, (_, collectionIndex) => ({
    id: String(2000 + collectionIndex),
    handle: `collection-${collectionIndex}`,
    productIds: records
      .filter((_, productIndex) => Array.from(
        { length: Math.min(membershipsPerProduct, collections) },
        (__, offset) => (productIndex + offset) % collections
      ).includes(collectionIndex))
      .map(product => product.id)
  }));
  for (const product of records) {
    product.collections = collectionRecords
      .filter(collection => collection.productIds.includes(product.id))
      .map(collection => collection.handle);
  }
  return {
    schemaVersion: 1,
    fetchedAt,
    products: records,
    collections: collectionRecords
  };
}

const baseline = inventory({ fetchedAt: '2026-11-06T10:00:00.000Z' });
const ordinary = inventory({ fetchedAt: '2026-11-06T11:00:00.000Z', products: 98 });
const ordinaryResult = enforceReleaseGuard(ordinary, baseline);
assert.deepEqual(ordinaryResult.violations, []);
assert.equal(ordinaryResult.current.products, 98);

const productCollapse = inventory({ fetchedAt: '2026-11-06T11:00:00.000Z', products: 20 });
assert.throws(() => enforceReleaseGuard(productCollapse, baseline), /products fell from 100 to 20/);

const variantBaseline = inventory({ fetchedAt: '2026-11-06T10:00:00.000Z', variantsPerProduct: 2 });
assert.throws(() => enforceReleaseGuard(ordinary, variantBaseline), /variants fell from 200 to 98/);

const membershipCollapse = inventory({
  fetchedAt: '2026-11-06T11:00:00.000Z',
  membershipsPerProduct: 1
});
assert.throws(() => enforceReleaseGuard(membershipCollapse, baseline), /memberships fell from 200 to 100/);

const collectionCollapse = inventory({ fetchedAt: '2026-11-06T11:00:00.000Z', collections: 3 });
assert.throws(() => enforceReleaseGuard(collectionCollapse, baseline), /collections fell from 10 to 3/);

const stale = inventory({ fetchedAt: '2026-11-06T09:59:59.000Z' });
assert.throws(() => enforceReleaseGuard(stale, baseline), /is not newer than baseline/);
assert.throws(
  () => enforceReleaseGuard(stale, baseline, { allowLargeChange: true }),
  /recency failures cannot be overridden/
);

const override = enforceReleaseGuard(productCollapse, baseline, { allowLargeChange: true });
assert.equal(override.overridden, true);
assert.ok(override.violations.length > 0);

const malformed = inventory();
malformed.collections[0].productIds.push('unknown-product');
assert.throws(() => inventoryCounts(malformed), /unknown product/);

const mismatchedMembership = inventory();
mismatchedMembership.products[0].collections = [];
assert.throws(() => inventoryCounts(mismatchedMembership), /disagree on membership/);

const singleCollectionCollapse = inventory({ fetchedAt: '2026-11-06T11:00:00.000Z' });
const affected = singleCollectionCollapse.collections[0];
const removedIds = new Set(affected.productIds.slice(0, Math.ceil(affected.productIds.length / 2)));
affected.productIds = affected.productIds.filter(id => !removedIds.has(id));
for (const product of singleCollectionCollapse.products) {
  if (removedIds.has(product.id)) product.collections = product.collections.filter(handle => handle !== affected.handle);
}
assert.throws(() => enforceReleaseGuard(singleCollectionCollapse, baseline), /collection collection-0 memberships fell/);

const invalidPrice = inventory();
invalidPrice.products[0].variants[0].priceCents = 10.5;
assert.throws(() => inventoryCounts(invalidPrice), /invalid price/);

const report = evaluateReleaseGuard(ordinary, baseline);
assert.equal(report.baseline.fetchedAtIso, '2026-11-06T10:00:00.000Z');
assert.equal(report.current.fetchedAtIso, '2026-11-06T11:00:00.000Z');

const siteBaseUrl = 'https://example.test/kiss-it-goodbuy-preview/';
const rootPageUrl = siteBaseUrl;
assert.equal(documentBaseUrl('<link href="style.css">', rootPageUrl, siteBaseUrl).href, rootPageUrl);
assert.deepEqual(
  localAssetUrls('<link href="style.css?v=1"><script src="app.js?v=2"></script>', rootPageUrl, siteBaseUrl).map(url => url.href),
  [`${siteBaseUrl}style.css?v=1`, `${siteBaseUrl}app.js?v=2`]
);

const productPageUrl = `${siteBaseUrl}products/example-piece/`;
const nestedAssets = localAssetUrls(
  '<base href="../../"><link href="style.css?v=1"><script src="app.js?v=2"></script>',
  productPageUrl,
  siteBaseUrl
);
assert.deepEqual(nestedAssets.map(url => url.href), [`${siteBaseUrl}style.css?v=1`, `${siteBaseUrl}app.js?v=2`]);
assert.throws(
  () => localAssetUrls('<base href="https://hostile.example/"><link href="style.css">', productPageUrl, siteBaseUrl),
  /document base outside the published site/
);
assert.throws(
  () => localAssetUrls('<base href="/"><link href="style.css">', productPageUrl, siteBaseUrl),
  /document base outside the published site/
);

console.log('Release guard checks passed: catalog integrity, explicit override logging, and document-base-aware asset resolution.');
