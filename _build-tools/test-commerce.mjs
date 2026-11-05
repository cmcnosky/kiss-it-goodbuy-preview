import assert from 'node:assert/strict';

await import('../dist/commerce.js');
const C = globalThis.KIGBCommerce;
assert.ok(C, 'KIGBCommerce should attach to globalThis');

const lamp = {
  variantId: '68162102526189',
  quantity: 1,
  productHandle: 'global-views-etched-cloud-accent-lamp-23-5h',
  productTitle: 'Global Views lamp',
  priceCents: 9900,
  currencyCode: 'USD',
  available: true
};
const chair = {
  variantId: 'gid://shopify/ProductVariant/50606537212141',
  quantity: 1,
  productTitle: 'Vintage chair',
  priceCents: 79920,
  currencyCode: 'USD'
};

assert.deepEqual(C.normalizeCart(null), []);
assert.throws(() => C.normalizeCart(null, { strict: true }), (error) => error.code === 'INVALID_CART');
assert.throws(() => C.toVariantGid(68162102526189), (error) => error.code === 'INVALID_VARIANT_ID');
assert.equal(C.toVariantGid('68162102526189'), 'gid://shopify/ProductVariant/68162102526189');
assert.equal(C.numericVariantId('gid://shopify/ProductVariant/68162102526189'), '68162102526189');

const merged = C.normalizeCart([lamp, { ...lamp, quantity: 2 }], { strict: true });
assert.equal(merged.length, 1);
assert.equal(merged[0].quantity, 3);

const base = C.normalizeCart([lamp], { strict: true });
const added = C.addLine(base, chair);
assert.equal(base.length, 1, 'addLine must not mutate its input');
assert.equal(added.length, 2);
assert.equal(C.updateLine(added, chair.variantId, 3)[1].quantity, 3);
assert.equal(C.updateLine(added, chair.variantId, 0).length, 1);
assert.throws(() => C.updateLine(added, '999', 2), (error) => error.code === 'CART_LINE_NOT_FOUND');

assert.deepEqual(C.cartSummary([lamp, chair]), {
  distinctItems: 2,
  itemCount: 2,
  subtotalCents: 89820,
  currencyCode: 'USD',
  priceComplete: true,
  hasUnavailable: false
});
const unknownPriceSummary = C.cartSummary([{ ...lamp, priceCents: null }]);
assert.equal(unknownPriceSummary.subtotalCents, null);
assert.equal(unknownPriceSummary.priceComplete, false);

assert.equal(
  C.buildCartReviewUrl([lamp, { ...chair, quantity: 2 }]),
  'https://kissitgoodbuy.net/buy/68162102526189:1,50606537212141:2?continue_to=/cart&ucp/version=2026-08-25'
);
assert.equal(C.trustedCheckoutUrl('https://kissitgoodbuy.net/cart/c/abc'), true);
assert.equal(C.trustedCheckoutUrl('https://kissitgoodbuy.myshopify.com/cart/c/abc'), true);
assert.equal(C.trustedCheckoutUrl('http://kissitgoodbuy.net/cart'), false);
assert.equal(C.trustedCheckoutUrl('https://kissitgoodbuy.net.example.com/cart'), false);
assert.equal(C.trustedCheckoutUrl('https://user:pass@kissitgoodbuy.net/cart'), false);
assert.equal(C.trustedCheckoutUrl('https://kissitgoodbuy.net:8443/cart'), false);

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; }
  };
}

function remoteVariant({ available = true, amount = '99.00', minimum = 1, maximum = null, increment = 1 } = {}) {
  return {
    id: 'gid://shopify/ProductVariant/68162102526189',
    title: 'Default Title',
    availableForSale: available,
    price: { amount, currencyCode: 'USD' },
    compareAtPrice: null,
    quantityRule: { minimum, maximum, increment },
    product: {
      handle: lamp.productHandle,
      title: lamp.productTitle,
      onlineStoreUrl: `https://kissitgoodbuy.net/products/${lamp.productHandle}`,
      featuredImage: { url: 'https://cdn.shopify.com/lamp.jpg', altText: null }
    }
  };
}

let validationCalls = 0;
const validFetch = async (_url, init) => {
  validationCalls += 1;
  const body = JSON.parse(init.body);
  assert.match(body.query, /query ValidateCart/);
  assert.equal(init.credentials, 'omit');
  assert.deepEqual(body.variables.ids, ['gid://shopify/ProductVariant/68162102526189']);
  return response({ data: { nodes: [remoteVariant()] } });
};
const validated = await C.validateCart([lamp], { fetchImpl: validFetch });
assert.equal(validationCalls, 1);
assert.equal(validated.lines[0].priceCents, 9900);
assert.deepEqual(validated.priceChanges, []);

await assert.rejects(
  C.validateCart([lamp], { fetchImpl: async () => response({ data: { nodes: [remoteVariant({ available: false })] } }) }),
  (error) => error.code === 'CART_VALIDATION_FAILED' && error.details.issues[0].code === 'UNAVAILABLE'
);
await assert.rejects(
  C.validateCart([{ ...lamp, quantity: 2 }], { fetchImpl: async () => response({ data: { nodes: [remoteVariant({ maximum: 1 })] } }) }),
  (error) => error.code === 'CART_VALIDATION_FAILED' && error.details.issues[0].code === 'QUANTITY_RULE'
);
await assert.rejects(
  C.validateCart([lamp], { fetchImpl: async () => response({ data: { nodes: [null] } }) }),
  (error) => error.code === 'CART_VALIDATION_FAILED'
    && error.details.currentLines[0].variantId === 'gid://shopify/ProductVariant/68162102526189'
    && error.details.currentLines[0].available === false
    && error.details.requestedLines.length === 1
);

let priceChangeCalls = 0;
await assert.rejects(
  C.createCheckout([lamp], {
    fetchImpl: async () => {
      priceChangeCalls += 1;
      return response({ data: { nodes: [remoteVariant({ amount: '109.00' })] } });
    }
  }),
  (error) => error.code === 'CART_PRICE_CHANGED' && error.details.currentLines[0].priceCents === 10900
);
assert.equal(priceChangeCalls, 1, 'price changes must stop before cartCreate');

let unknownPriceCalls = 0;
await assert.rejects(
  C.createCheckout([{ ...lamp, priceCents: null }], {
    fetchImpl: async () => {
      unknownPriceCalls += 1;
      return response({ data: { nodes: [remoteVariant()] } });
    }
  }),
  (error) => error.code === 'CART_PRICE_CHANGED'
    && error.details.priceChanges[0].fromCents === null
    && error.details.priceChanges[0].toCents === 9900
    && error.details.currentLines[0].priceCents === 9900
);
assert.equal(unknownPriceCalls, 1, 'an unknown saved price must stop before cartCreate');

let checkoutCalls = 0;
const checkoutFetch = async (_url, init) => {
  checkoutCalls += 1;
  const body = JSON.parse(init.body);
  if (checkoutCalls === 1) return response({ data: { nodes: [remoteVariant()] } });
  assert.match(body.query, /mutation CreateCheckout/);
  assert.deepEqual(body.variables.input, {
    lines: [{ merchandiseId: 'gid://shopify/ProductVariant/68162102526189', quantity: 1 }]
  });
  return response({
    data: {
      cartCreate: {
        cart: {
          checkoutUrl: 'https://kissitgoodbuy.net/cart/c/test',
          lines: {
            nodes: [{ id: 'line-1', quantity: 1, merchandise: { id: 'gid://shopify/ProductVariant/68162102526189', availableForSale: true } }]
          },
          cost: {
            subtotalAmount: { amount: '99.00', currencyCode: 'USD' },
            totalAmount: { amount: '99.00', currencyCode: 'USD' }
          }
        },
        userErrors: [],
        warnings: []
      }
    }
  });
};
const checkout = await C.createCheckout([lamp], { fetchImpl: checkoutFetch });
assert.equal(checkoutCalls, 2);
assert.equal(checkout.checkoutUrl, 'https://kissitgoodbuy.net/cart/c/test');

let mismatchCalls = 0;
await assert.rejects(
  C.createCheckout([lamp], {
    fetchImpl: async () => {
      mismatchCalls += 1;
      if (mismatchCalls === 1) return response({ data: { nodes: [remoteVariant()] } });
      return response({
        data: {
          cartCreate: {
            cart: {
              checkoutUrl: 'https://kissitgoodbuy.net/cart/c/test',
              lines: { nodes: [] },
              cost: null
            },
            userErrors: [],
            warnings: []
          }
        }
      });
    }
  }),
  (error) => error.code === 'CART_LINE_MISMATCH' && error.details.mismatches[0].created === 0
);

let warningCalls = 0;
await assert.rejects(
  C.createCheckout([lamp], {
    fetchImpl: async () => {
      warningCalls += 1;
      if (warningCalls === 1) return response({ data: { nodes: [remoteVariant()] } });
      return response({ data: { cartCreate: { cart: null, userErrors: [], warnings: [{ code: 'ITEM_UNAVAILABLE', message: 'Unavailable', target: '$.cart.lines[0]' }] } } });
    }
  }),
  (error) => error.code === 'CART_CREATE_WARNING' && error.details.warnings.length === 1
);

await assert.rejects(
  C.fetchGraphQL('query { shop { name } }', {}, { fetchImpl: async () => response({ errors: [{ message: 'Denied' }] }) }),
  (error) => error.code === 'STOREFRONT_GRAPHQL_ERROR'
);
await assert.rejects(
  C.fetchGraphQL('query { shop { name } }', {}, { fetchImpl: async () => response({}, 503) }),
  (error) => error.code === 'STOREFRONT_HTTP_ERROR'
);

console.log('commerce helpers: tests passed');
