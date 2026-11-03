import assert from 'node:assert/strict';

await import('../dist/commerce.js');
await import('../dist/storefront-data.js');
const D = globalThis.KIGBData;
const C = globalThis.KIGBCommerce;
assert.ok(D, 'KIGBData should attach to globalThis');

function directoryPage(after) {
  if (!after) {
    return {
      collections: {
        nodes: [
          { id: 'gid://shopify/Collection/1', handle: 'art', title: 'Art' },
          { id: 'gid://shopify/Collection/2', handle: 'seating', title: 'Seating' }
        ],
        pageInfo: { hasNextPage: true, endCursor: 'directory-2' }
      }
    };
  }
  return {
    collections: {
      nodes: [{ id: 'gid://shopify/Collection/3', handle: 'tables', title: 'Tables' }],
      pageInfo: { hasNextPage: false, endCursor: 'directory-3' }
    }
  };
}

function membership(handle, after) {
  const number = { art: 1, seating: 2, tables: 3 }[handle];
  const products = after
    ? [{ id: `gid://shopify/Product/${number}02` }]
    : [{ id: `gid://shopify/Product/${number}01` }];
  return {
    collection: {
      id: `gid://shopify/Collection/${number}`,
      handle,
      title: handle[0].toUpperCase() + handle.slice(1),
      products: {
        nodes: products,
        pageInfo: { hasNextPage: !after, endCursor: after ? `${handle}-done` : `${handle}-next` }
      }
    }
  };
}

let active = 0;
let maximumActive = 0;
const mockCommerce = {
  ...C,
  async fetchGraphQL(query, variables) {
    if (query.includes('CollectionDirectory')) return directoryPage(variables.after);
    if (query.includes('CollectionMembership')) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return membership(variables.handle, variables.after);
    }
    if (query.includes('ProductOrder')) {
      return variables.after
        ? { products: { nodes: [{ id: 'gid://shopify/Product/12' }], pageInfo: { hasNextPage: false, endCursor: 'order-done' } } }
        : { products: { nodes: [{ id: 'gid://shopify/Product/11' }], pageInfo: { hasNextPage: true, endCursor: 'order-next' } } };
    }
    throw new Error('Unexpected query');
  },
  async fetchProduct(handle) {
    return {
      id: 'gid://shopify/Product/11',
      handle,
      title: 'A chair',
      variants: {
        nodes: [{
          id: 'gid://shopify/ProductVariant/101',
          title: 'Default Title',
          availableForSale: true,
          storeAvailability: {
            nodes: [{
              available: true,
              pickUpTime: 'Usually ready in 4 hours',
              location: { name: '201 E. Franklin St.', address: { city: 'Grapevine' } }
            }]
          }
        }]
      }
    };
  }
};

const collections = await D.getCollections({ commerce: mockCommerce });
assert.deepEqual(collections.map((entry) => entry.handle), ['art', 'seating', 'tables']);

const art = await D.getCollection('art', { commerce: mockCommerce });
assert.deepEqual(art.productIds, ['gid://shopify/Product/101', 'gid://shopify/Product/102']);

const all = await D.getAllMemberships({ commerce: mockCommerce, concurrency: 2 });
assert.deepEqual(all.collections.map((entry) => entry.handle), ['art', 'seating', 'tables']);
assert.deepEqual(all.collections[2].productIds, ['gid://shopify/Product/301', 'gid://shopify/Product/302']);
assert.equal(maximumActive, 2, 'membership requests should honor bounded concurrency');

const best = await D.getProductOrder('BEST_SELLING', '', { commerce: mockCommerce });
assert.deepEqual(best, {
  sortKey: 'BEST_SELLING',
  query: '',
  productIds: ['gid://shopify/Product/11', 'gid://shopify/Product/12']
});
const relevant = await D.getProductOrder('RELEVANCE', 'chair', { commerce: mockCommerce });
assert.equal(relevant.sortKey, 'RELEVANCE');
assert.equal(relevant.query, 'chair');
await assert.rejects(
  D.getProductOrder('RELEVANCE', '', { commerce: mockCommerce }),
  (error) => error.code === 'RELEVANCE_QUERY_REQUIRED'
);

const pickup = await D.getPickup('a-chair', '101', { commerce: mockCommerce });
assert.equal(pickup.availableForSale, true);
assert.equal(pickup.variantTitle, '');
assert.equal(pickup.pickupLocations[0].pickUpTime, 'Usually ready in 4 hours');
await assert.rejects(
  D.getCollection('Not Valid', { commerce: mockCommerce }),
  (error) => error.code === 'INVALID_HANDLE'
);
await assert.rejects(
  D.getPickup('a-chair', '999', { commerce: mockCommerce }),
  (error) => error.code === 'VARIANT_NOT_FOUND'
);

let duplicateCall = 0;
const duplicateCommerce = {
  ...mockCommerce,
  async fetchGraphQL(query, variables) {
    if (!query.includes('CollectionMembership')) return mockCommerce.fetchGraphQL(query, variables);
    duplicateCall += 1;
    return {
      collection: {
        id: 'gid://shopify/Collection/1',
        handle: 'art',
        title: 'Art',
        products: {
          nodes: [{ id: 'gid://shopify/Product/1' }],
          pageInfo: duplicateCall === 1
            ? { hasNextPage: true, endCursor: 'next' }
            : { hasNextPage: false, endCursor: 'done' }
        }
      }
    };
  }
};
await assert.rejects(
  D.getCollection('art', { commerce: duplicateCommerce }),
  (error) => error.code === 'PAGINATION_DUPLICATE'
);

let loopCall = 0;
const loopCommerce = {
  ...mockCommerce,
  async fetchGraphQL() {
    loopCall += 1;
    return {
      collection: {
        id: 'gid://shopify/Collection/1',
        handle: 'art',
        title: 'Art',
        products: {
          nodes: [{ id: `gid://shopify/Product/${loopCall}` }],
          pageInfo: { hasNextPage: true, endCursor: 'same-cursor' }
        }
      }
    };
  }
};
await assert.rejects(
  D.getCollection('art', { commerce: loopCommerce }),
  (error) => error.code === 'PAGINATION_LOOP'
);

const missingCommerce = {
  ...mockCommerce,
  async fetchGraphQL() { return { collection: null }; }
};
await assert.rejects(
  D.getCollection('art', { commerce: missingCommerce }),
  (error) => error.code === 'COLLECTION_NOT_FOUND'
);

console.log('storefront data helpers: tests passed');
