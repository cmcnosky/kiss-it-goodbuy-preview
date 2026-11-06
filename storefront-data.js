(function attachKIGBData(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KIGBData = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createKIGBData(root) {
  'use strict';

  const PAGE_SIZE = 250;
  const COLLECTION_DIRECTORY_PAGE_SIZE = 100;
  const MAX_PAGES = 100;
  const HANDLE = /^[a-z0-9][a-z0-9-]{0,254}$/;
  const SORT_KEYS = new Set(['BEST_SELLING', 'RELEVANCE']);

  class StorefrontDataError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = 'StorefrontDataError';
      this.code = code;
      if (details !== undefined) this.details = details;
    }
  }

  function commerce(options = {}) {
    const api = options.commerce || root.KIGBCommerce;
    if (!api || typeof api.fetchGraphQL !== 'function') {
      throw new StorefrontDataError(
        'COMMERCE_MODULE_REQUIRED',
        'KIGBCommerce must load before the live storefront data module.'
      );
    }
    return api;
  }

  function requestOptions(options) {
    const copy = { ...options };
    delete copy.commerce;
    delete copy.concurrency;
    copy.requestKind = 'read';
    return copy;
  }

  function cleanHandle(handle, kind = 'collection') {
    const value = typeof handle === 'string' ? handle.trim() : '';
    if (!HANDLE.test(value)) {
      throw new StorefrontDataError('INVALID_HANDLE', `The ${kind} handle is invalid.`);
    }
    return value;
  }

  function pageInfo(connection, label) {
    const info = connection?.pageInfo;
    if (!info || typeof info.hasNextPage !== 'boolean') {
      throw new StorefrontDataError('INVALID_PAGE_INFO', `Shopify returned invalid pagination for ${label}.`);
    }
    return info;
  }

  function checkPage({ nodes, info, after, seenCursors, seenIds, label, limit }) {
    if (!Array.isArray(nodes)) {
      throw new StorefrontDataError('INVALID_PAGE', `Shopify returned an invalid ${label} page.`);
    }
    if (nodes.length > limit) {
      throw new StorefrontDataError('PAGE_LIMIT_EXCEEDED', `Shopify returned too many ${label} records.`);
    }
    for (const node of nodes) {
      if (!node || typeof node.id !== 'string' || !node.id) {
        throw new StorefrontDataError('INVALID_RECORD', `Shopify returned an invalid ${label} record.`);
      }
      if (seenIds.has(node.id)) {
        throw new StorefrontDataError('PAGINATION_DUPLICATE', `Shopify repeated a ${label} record across pages.`, {
          id: node.id
        });
      }
      seenIds.add(node.id);
    }
    if (info.hasNextPage) {
      if (!nodes.length) {
        throw new StorefrontDataError('PAGINATION_STALLED', `Shopify reported more ${label} records after an empty page.`);
      }
      if (typeof info.endCursor !== 'string' || !info.endCursor || info.endCursor === after || seenCursors.has(info.endCursor)) {
        throw new StorefrontDataError('PAGINATION_LOOP', `Shopify repeated the ${label} cursor.`);
      }
      seenCursors.add(info.endCursor);
    }
  }

  const COLLECTION_DIRECTORY_QUERY = `
    query CollectionDirectory($first: Int!, $after: String) {
      collections(first: $first, after: $after, sortKey: TITLE) {
        nodes { id handle title }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  async function getCollections(options = {}) {
    const api = commerce(options);
    const all = [];
    const seenIds = new Set();
    const seenCursors = new Set();
    let after = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await api.fetchGraphQL(
        COLLECTION_DIRECTORY_QUERY,
        { first: COLLECTION_DIRECTORY_PAGE_SIZE, after },
        requestOptions(options)
      );
      const connection = data.collections;
      const info = pageInfo(connection, 'collections');
      const nodes = connection?.nodes;
      checkPage({ nodes, info, after, seenCursors, seenIds, label: 'collection', limit: COLLECTION_DIRECTORY_PAGE_SIZE });
      for (const node of nodes) {
        if (!HANDLE.test(node.handle || '') || typeof node.title !== 'string') {
          throw new StorefrontDataError('INVALID_RECORD', 'Shopify returned invalid collection metadata.');
        }
        all.push({ id: node.id, handle: node.handle, title: node.title });
      }
      if (!info.hasNextPage) return all;
      after = info.endCursor;
    }
    throw new StorefrontDataError('PAGINATION_LIMIT', 'Collection pagination exceeded the safety limit.');
  }

  const COLLECTION_MEMBERSHIP_QUERY = `
    query CollectionMembership($handle: String!, $first: Int!, $after: String) {
      collection(handle: $handle) {
        id
        handle
        title
        products(first: $first, after: $after) {
          nodes { id }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;

  async function getCollection(handle, options = {}) {
    const clean = cleanHandle(handle);
    const api = commerce(options);
    const productIds = [];
    const seenIds = new Set();
    const seenCursors = new Set();
    let metadata = null;
    let after = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await api.fetchGraphQL(
        COLLECTION_MEMBERSHIP_QUERY,
        { handle: clean, first: PAGE_SIZE, after },
        requestOptions(options)
      );
      const collection = data.collection;
      if (!collection) {
        throw new StorefrontDataError('COLLECTION_NOT_FOUND', 'This collection is no longer in the live store.', {
          handle: clean
        });
      }
      if (!metadata) {
        metadata = { id: collection.id, handle: collection.handle, title: collection.title };
      } else if (metadata.id !== collection.id || metadata.handle !== collection.handle) {
        throw new StorefrontDataError('COLLECTION_CHANGED', 'The collection changed while Shopify was paging it.');
      }
      const connection = collection.products;
      const info = pageInfo(connection, `collection ${clean}`);
      const nodes = connection?.nodes;
      checkPage({ nodes, info, after, seenCursors, seenIds, label: `product in ${clean}`, limit: PAGE_SIZE });
      productIds.push(...nodes.map((node) => node.id));
      if (!info.hasNextPage) return { ...metadata, productIds };
      after = info.endCursor;
    }
    throw new StorefrontDataError('PAGINATION_LIMIT', `Collection ${clean} exceeded the pagination safety limit.`);
  }

  async function mapConcurrent(items, limit, worker) {
    const output = new Array(items.length);
    let nextIndex = 0;
    async function run() {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        output[index] = await worker(items[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return output;
  }

  async function getAllMemberships(options = {}) {
    const directory = await getCollections(options);
    const requested = Number(options.concurrency ?? 4);
    const concurrency = Number.isInteger(requested) ? Math.min(8, Math.max(1, requested)) : 4;
    const collections = await mapConcurrent(
      directory,
      concurrency,
      (entry) => getCollection(entry.handle, options)
    );
    return { collections };
  }

  const PRODUCT_ORDER_QUERY = `
    query ProductOrder($first: Int!, $after: String, $sortKey: ProductSortKeys!, $query: String) {
      products(first: $first, after: $after, sortKey: $sortKey, query: $query) {
        nodes { id }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  async function getProductOrder(sortKey = 'BEST_SELLING', query = '', options = {}) {
    const key = typeof sortKey === 'string' ? sortKey.trim().toUpperCase() : '';
    if (!SORT_KEYS.has(key)) {
      throw new StorefrontDataError('INVALID_SORT_KEY', 'Live product order supports BEST_SELLING or RELEVANCE.');
    }
    const search = typeof query === 'string' ? query.trim() : '';
    if (key === 'RELEVANCE' && !search) {
      throw new StorefrontDataError('RELEVANCE_QUERY_REQUIRED', 'Relevance sorting requires a search query.');
    }
    const api = commerce(options);
    const productIds = [];
    const seenIds = new Set();
    const seenCursors = new Set();
    let after = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await api.fetchGraphQL(
        PRODUCT_ORDER_QUERY,
        { first: PAGE_SIZE, after, sortKey: key, query: search || null },
        requestOptions(options)
      );
      const connection = data.products;
      const info = pageInfo(connection, 'product order');
      const nodes = connection?.nodes;
      checkPage({ nodes, info, after, seenCursors, seenIds, label: 'ordered product', limit: PAGE_SIZE });
      productIds.push(...nodes.map((node) => node.id));
      if (!info.hasNextPage) return { sortKey: key, query: search, productIds };
      after = info.endCursor;
    }
    throw new StorefrontDataError('PAGINATION_LIMIT', 'Product order pagination exceeded the safety limit.');
  }

  async function getPickup(handle, variantId, options = {}) {
    const clean = cleanHandle(handle, 'product');
    const api = commerce(options);
    if (typeof api.fetchProduct !== 'function' || typeof api.toVariantGid !== 'function') {
      throw new StorefrontDataError('COMMERCE_PRODUCT_API_REQUIRED', 'KIGBCommerce product helpers are unavailable.');
    }
    const gid = api.toVariantGid(variantId);
    const product = await api.fetchProduct(clean, requestOptions(options));
    const variants = product.variants?.nodes;
    if (!Array.isArray(variants)) {
      throw new StorefrontDataError('INVALID_PRODUCT', 'Shopify returned invalid variant information.');
    }
    const variant = variants.find((entry) => entry.id === gid);
    if (!variant) {
      throw new StorefrontDataError('VARIANT_NOT_FOUND', 'This option is no longer available for the item.', {
        handle: clean,
        variantId: gid
      });
    }
    const locations = Array.isArray(variant.storeAvailability?.nodes)
      ? variant.storeAvailability.nodes.map((entry) => ({
          available: entry.available === true,
          pickUpTime: typeof entry.pickUpTime === 'string' ? entry.pickUpTime : '',
          location: entry.location || null
        }))
      : [];
    return {
      productId: product.id,
      productHandle: product.handle,
      productTitle: product.title,
      variantId: variant.id,
      variantTitle: variant.title === 'Default Title' ? '' : variant.title,
      availableForSale: variant.availableForSale === true,
      pickupLocations: locations
    };
  }

  return Object.freeze({
    StorefrontDataError,
    getCollections,
    getCollection,
    getAllMemberships,
    getProductOrder,
    getPickup
  });
});
