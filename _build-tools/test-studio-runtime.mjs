import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls += 1;
  throw new Error('Owner Studio runtime must not use the network.');
};
globalThis.KIGBCatalog = {
  extractDimensions(value) {
    return value ? { raw: value, source: 'test' } : null;
  }
};

const require = createRequire(import.meta.url);
const Runtime = require('../dist/studio-runtime.js');
assert.ok(Runtime, 'KIGBStudioRuntime loads');

function variant(id, priceCents, available = true) {
  return {
    id,
    title: 'Default Title',
    price: priceCents / 100,
    priceCents,
    compareAtPrice: null,
    compareAtPriceCents: null,
    available,
    sku: `SKU-${id}`,
    position: 1
  };
}

const base = {
  fetchedAt: '2026-11-06T00:00:00.000Z',
  products: [
    {
      id: '1001',
      handle: 'gallery-lamp',
      title: 'Gallery lamp',
      sourceProductType: 'Lamp',
      price: 100,
      minPrice: 100,
      maxPrice: 100,
      compareAtPrice: 125,
      available: true,
      dimensionsRaw: '20 in H',
      dimensions: { raw: '20 in H' },
      images: [{ src: 'https://cdn.example.test/lamp.jpg', alt: 'Gallery lamp' }],
      variants: [variant('2001', 10000)],
      collections: ['new-items', 'lamps']
    },
    {
      id: '1002',
      handle: 'gallery-chair',
      title: 'Gallery chair',
      sourceProductType: 'Chair',
      price: 200,
      minPrice: 200,
      maxPrice: 200,
      compareAtPrice: null,
      available: true,
      dimensionsRaw: '30 in W',
      dimensions: { raw: '30 in W' },
      images: [{ src: 'assets/chair.jpg', alt: 'Gallery chair' }],
      variants: [variant('2002', 20000)],
      collections: ['new-items', 'seating']
    },
    {
      id: '1003',
      handle: 'gift-card',
      title: 'Kiss It Good Buy Gift Card',
      sourceProductType: 'Gift Card',
      price: 50,
      minPrice: 50,
      maxPrice: 50,
      compareAtPrice: null,
      available: true,
      dimensionsRaw: '',
      dimensions: null,
      images: [],
      variants: [variant('2003', 5000)],
      collections: ['new-items']
    }
  ],
  collections: [
    { handle: 'new-items', productIds: ['1001', '1002', '1003'] },
    { handle: 'lamps', productIds: ['1001'] },
    { handle: 'seating', productIds: ['1002'] }
  ]
};

const draft = {
  products: {
    'gallery-lamp': {
      title: 'Chelsea lamp edit',
      priceCents: 12500,
      available: false,
      dimensionsRaw: '22 in H',
      imageUrl: 'assets/studio-lamp.jpg'
    },
    'gallery-chair': { hidden: true },
    'gift-card': { priceCents: 1 }
  },
  customProducts: [{
    id: '9000000000001',
    handle: 'studio-sculptural-table',
    title: 'Sculptural table',
    priceCents: 34500,
    available: true,
    dimensionsRaw: '36 in W x 20 in D x 18 in H',
    imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    category: 'Tables'
  }]
};

const applied = Runtime.applyInventory(base, draft);
assert.notEqual(applied, base);
assert.equal(applied.products.length, 3, 'hidden base products are removed and custom products are added');
assert.deepEqual(base.products[0].variants[0], variant('2001', 10000), 'applying a draft does not mutate base variants');
assert.equal(base.products[0].title, 'Gallery lamp', 'applying a draft does not mutate base products');

const editedLamp = applied.products.find((product) => product.handle === 'gallery-lamp');
assert.equal(editedLamp.title, 'Chelsea lamp edit');
assert.equal(editedLamp.price, 125);
assert.equal(editedLamp.variants[0].priceCents, 12500);
assert.equal(editedLamp.available, false);
assert.equal(editedLamp.variants[0].available, false);
assert.equal(editedLamp.dimensions.raw, '22 in H');
assert.equal(editedLamp.images[0].src, 'assets/studio-lamp.jpg');

const giftCard = applied.products.find((product) => product.handle === 'gift-card');
assert.equal(giftCard.price, 50, 'practice overrides cannot rewrite gift-card denominations');
assert.equal(giftCard.variants[0].priceCents, 5000);

const custom = applied.products.find((product) => product.handle === 'studio-sculptural-table');
assert.ok(custom);
assert.match(custom.id, /^\d+$/);
assert.match(custom.variants[0].id, /^\d+$/);
assert.equal(custom.price, 345);
assert.equal(custom.variants[0].priceCents, 34500);
assert.equal(custom.vendor, 'Owner Studio');
assert.equal(custom._studioCustom, true);
assert.equal(custom.dimensions.raw, draft.customProducts[0].dimensionsRaw);
assert.ok(
  applied.collections.find((collection) => collection.handle === 'new-items').productIds.includes(custom.id),
  'custom products join the practice new-items collection'
);
assert.deepEqual(
  applied.collections.find((collection) => collection.handle === 'seating').productIds,
  [],
  'hidden product IDs are removed from collection membership'
);

const duplicate = Runtime.applyInventory(base, {
  products: {},
  customProducts: [{ ...draft.customProducts[0], handle: 'gallery-lamp' }]
});
assert.equal(duplicate.products.filter((product) => product.handle === 'gallery-lamp').length, 1);

assert.match(Runtime.toolbar(true), /Your practice storefront/);
assert.match(Runtime.toolbar(true), /data-exit-studio/);
assert.doesNotMatch(Runtime.toolbar(false), /data-exit-studio/);

const inactiveCheckout = Runtime.checkoutPage([], false);
assert.match(inactiveCheckout, /Open the Owner Studio/);
assert.doesNotMatch(inactiveCheckout, /practice-order-form/);

const emptyCheckout = Runtime.checkoutPage([], true);
assert.match(emptyCheckout, /practice bag is empty/i);
assert.doesNotMatch(emptyCheckout, /practice-order-form/);

const line = {
  variantId: 'gid://shopify/ProductVariant/2001',
  productHandle: 'gallery-lamp',
  productTitle: '<img src=x onerror=alert(1)>',
  quantity: 2,
  priceCents: 12500,
  currencyCode: 'USD',
  imageUrl: 'assets/studio-lamp.jpg',
  extraCartField: 'must not reach state'
};
const populatedCheckout = Runtime.checkoutPage([line], true);
assert.match(populatedCheckout, /practice-order-form/);
assert.match(populatedCheckout, /\$250\.00/);
assert.match(populatedCheckout, /&lt;img src=x onerror=alert\(1\)&gt;/);
assert.doesNotMatch(populatedCheckout, /<img src=x onerror=/);
assert.match(populatedCheckout, /No card details are needed or accepted/);

for (const invalidLine of [
  { ...line, available: false },
  { ...line, priceCents: null },
  { ...line, priceCents: -1 },
  { ...line, quantity: 0 },
  { ...line, quantity: 251 }
]) {
  const review = Runtime.checkoutPage([invalidLine], true);
  assert.match(review, /Review your practice bag/);
  assert.doesNotMatch(review, /practice-order-form/);
}
const tooManyLines = Runtime.checkoutPage(
  Array.from({ length: 51 }, (_, index) => ({ ...line, variantId: String(3000 + index) })),
  true
);
assert.match(tooManyLines, /50 different pieces/);
assert.doesNotMatch(tooManyLines, /practice-order-form/);

function practiceDom() {
  const button = { disabled: false };
  const message = {
    textContent: '',
    focused: false,
    focus() { this.focused = true; }
  };
  const form = {
    listener: null,
    addEventListener(type, listener) {
      assert.equal(type, 'submit');
      this.listener = listener;
    },
    querySelector(selector) {
      assert.equal(selector, 'button[type="submit"]');
      return button;
    }
  };
  const document = {
    querySelector(selector) {
      if (selector === '#practice-order-form') return form;
      if (selector === '#practice-order-message') return message;
      return null;
    }
  };
  return { button, message, form, document };
}

let dom = practiceDom();
globalThis.document = dom.document;
let createdItems;
let clearCalls = 0;
let rendered = '';
globalThis.KIGBStudioState = {
  createOrder(items) {
    createdItems = items;
    return { id: 'order_test123' };
  },
  getStatus() { return { persisted: true }; }
};
Runtime.mountPractice({
  getLines: () => [line],
  clearBag: () => { clearCalls += 1; },
  render: (markup) => { rendered = markup; },
  toast: () => {}
});
assert.equal(typeof dom.form.listener, 'function');
let prevented = false;
dom.form.listener({ target: dom.form, preventDefault() { prevented = true; } });
assert.equal(prevented, true);
assert.equal(dom.button.disabled, true);
assert.equal(clearCalls, 1);
assert.match(rendered, /Practice order recorded/);
assert.match(rendered, /No payment, reservation, customer message, or real order was created/);
assert.deepEqual(createdItems, [{
  variantId: line.variantId,
  productHandle: line.productHandle,
  productTitle: line.productTitle,
  quantity: line.quantity,
  priceCents: line.priceCents,
  currencyCode: line.currencyCode,
  imageUrl: line.imageUrl
}], 'only the exact local practice-order schema reaches the state layer');

dom = practiceDom();
globalThis.document = dom.document;
clearCalls = 0;
globalThis.KIGBStudioState = {
  createOrder() { throw new Error('Practice order rejected'); },
  getStatus() { return { persisted: true }; }
};
Runtime.mountPractice({
  getLines: () => [line],
  clearBag: () => { clearCalls += 1; },
  render: () => { throw new Error('failure must not render completion'); },
  toast: () => {}
});
dom.form.listener({ target: dom.form, preventDefault() {} });
assert.equal(dom.button.disabled, false, 'a rejected practice order can be retried');
assert.equal(clearCalls, 0, 'a rejected practice order leaves the bag intact');
assert.equal(dom.message.textContent, 'Practice order rejected');
assert.equal(dom.message.focused, true);

assert.equal(networkCalls, 0, 'inventory edits and practice checkout never use fetch');
console.log('owner studio runtime inventory and practice-checkout checks passed');
