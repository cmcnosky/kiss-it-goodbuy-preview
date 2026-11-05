import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const app = fs.readFileSync(path.join(dist, 'app.js'), 'utf8');
const inventory = JSON.parse(fs.readFileSync(path.join(dist, 'inventory.json'), 'utf8'));
const commerce = fs.readFileSync(path.join(dist, 'commerce.js'), 'utf8');
const prefix = app.slice(0, app.indexOf('// BROWSER START'));
const product = inventory.products.find((entry) => entry.available && entry.variants.some((variant) => variant.available));
const variant = product.variants.find((entry) => entry.available);
const storedLine = {
  variantId: `gid://shopify/ProductVariant/${variant.id}`,
  quantity: 1,
  productHandle: product.handle,
  productTitle: product.title,
  variantTitle: variant.title,
  priceCents: variant.priceCents,
  compareAtPriceCents: variant.compareAtPriceCents,
  currencyCode: 'USD',
  imageUrl: product.images[0]?.src || '',
  onlineStoreUrl: product.productUrl,
  available: true
};

function bootStorage(values, throwingKeys = new Set(), productHandle = '') {
  const context = {
    location: new URL('https://example.test/collection.html'),
    URL,
    URLSearchParams,
    Intl,
    Date,
    KIGB_INVENTORY: inventory,
    KIGB_PRODUCT_HANDLE: productHandle || undefined,
    localStorage: {
      getItem(key) {
        if (throwingKeys.has(key)) throw new Error('storage unavailable');
        return Object.hasOwn(values, key) ? values[key] : null;
      }
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(`${commerce}\n${prefix}`, context);
  return (code) => vm.runInContext(code, context);
}

{
  const run = bootStorage({
    'kigb-recent': '{bad json',
    'kigb-favorites': JSON.stringify([product.handle]),
    'kigb-cart-v1': JSON.stringify([storedLine])
  });
  assert.equal(run(`saved.has(${JSON.stringify(product.handle)})`), true);
  assert.equal(run('cartLines.length'), 1, 'one malformed key must not hide a valid cart');
  assert.equal(run('storageWorks'), true, 'bad JSON is not a false storage-unavailable signal');
}

{
  const run = bootStorage({
    'kigb-recent': JSON.stringify([product.handle]),
    'kigb-favorites': '{bad json',
    'kigb-cart-v1': JSON.stringify([storedLine])
  });
  assert.equal(run('recent[0]'), product.handle);
  assert.equal(run('cartLines.length'), 1);
  assert.equal(run('saved.size'), 0, 'only the malformed favorites value falls back');
}

{
  const run = bootStorage({
    'kigb-favorites': JSON.stringify([product.handle]),
    'kigb-cart-v1': JSON.stringify([storedLine])
  }, new Set(['kigb-recent']));
  assert.equal(run(`saved.has(${JSON.stringify(product.handle)})`), true, 'later keys are attempted after an independent read failure');
  assert.equal(run('cartLines.length'), 1);
  assert.equal(run('storageWorks'), false, 'a real storage API failure is reported');
}

{
  const gift = inventory.products.find((entry) => /gift.?card/i.test(`${entry.sourceProductType || ''} ${entry.title}`));
  assert.ok(gift, 'catalog fixture includes the gift card used by the product-page regression');
  const run = bootStorage({}, new Set(), gift.handle);
  const markup = run('productPage()');
  const galleryAt = markup.indexOf('class="product-gallery"');
  const purchaseAt = markup.indexOf('class="product-purchase"');
  const descriptionAt = markup.indexOf('class="product-description"');
  assert.ok(galleryAt >= 0 && purchaseAt > galleryAt && descriptionAt > purchaseAt,
    'product markup orders gallery, purchase controls, then description for mobile reading order');
  assert.equal(run(`relatedProducts(PRODUCTS.find((entry) => entry.handle === ${JSON.stringify(gift.handle)}))`), '',
    'a product with no related items does not render an empty recommendations section');
  assert.doesNotMatch(markup, /You might also love/, 'gift card does not show an empty recommendations heading');
}

const interactionStart = app.indexOf('// INTERACTION STATE START');
const interactionEnd = app.indexOf('// INTERACTION STATE END');
assert.ok(interactionStart > 0 && interactionEnd > interactionStart);
const interactionSource = app.slice(interactionStart, interactionEnd);

function element(document, { id = '', tagName = 'BUTTON', dataset = {}, attributes = {}, selectionStart = null, selectionEnd = null } = {}) {
  const node = {
    id,
    tagName,
    dataset,
    className: '',
    classList: { add(name) { node.className = `${node.className} ${name}`.trim(); } },
    selectionStart,
    selectionEnd,
    getAttribute(name) { return attributes[name] ?? null; },
    focus() { document.activeElement = this; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  };
  return node;
}

function rootWith(nodes) {
  return {
    contains(node) { return nodes.includes(node); },
    querySelectorAll() { return nodes; }
  };
}

{
  const document = {
    body: {},
    activeElement: null,
    nodes: [],
    getElementById(id) { return this.nodes.find((node) => node.id === id) || null; },
    createElement(tag) { return element(this, { tagName: tag.toUpperCase() }); }
  };
  const context = { document, $$: (_selector, node) => node.querySelectorAll(), icon: () => '<svg></svg>' };
  vm.createContext(context);
  vm.runInContext(interactionSource, context);

  const oldSearch = element(document, { id: 'home-search', tagName: 'INPUT', selectionStart: 4, selectionEnd: 9 });
  document.activeElement = oldSearch;
  context.oldRoot = rootWith([oldSearch]);
  context.state = vm.runInContext('captureFocusState(oldRoot)', context);
  const newSearch = element(document, { id: 'home-search', tagName: 'INPUT' });
  document.nodes = [newSearch];
  context.newRoot = rootWith([newSearch]);
  assert.equal(vm.runInContext('restoreFocusState(state, newRoot)', context), true);
  assert.equal(document.activeElement, newSearch);
  assert.deepEqual([newSearch.selectionStart, newSearch.selectionEnd], [4, 9], 'search caret/selection is restored');

  const oldPlus = element(document, { dataset: { quantity: 'gid://shopify/ProductVariant/123', delta: '1' } });
  document.activeElement = oldPlus;
  context.oldRoot = rootWith([oldPlus]);
  context.state = vm.runInContext('captureFocusState(oldRoot)', context);
  const newMinus = element(document, { dataset: { quantity: 'gid://shopify/ProductVariant/123', delta: '-1' } });
  const newPlus = element(document, { dataset: { quantity: 'gid://shopify/ProductVariant/123', delta: '1' } });
  document.nodes = [newMinus, newPlus];
  context.newRoot = rootWith([newMinus, newPlus]);
  assert.equal(vm.runInContext('restoreFocusState(state, newRoot)', context), true);
  assert.equal(document.activeElement, newPlus, 'cart focus follows the same variant and action');

  const oldQuickAdd = element(document, { dataset: { quickAdd: product.handle } });
  document.activeElement = oldQuickAdd;
  context.oldRoot = rootWith([oldQuickAdd]);
  context.state = vm.runInContext('captureFocusState(oldRoot)', context);
  const refreshedBagLink = element(document, { tagName: 'A', dataset: { bagFor: product.handle } });
  document.nodes = [refreshedBagLink];
  context.newRoot = rootWith([refreshedBagLink]);
  assert.equal(vm.runInContext('restoreFocusState(state, newRoot)', context), true);
  assert.equal(document.activeElement, refreshedBagLink, 'an immediate refresh maps the add control to the same product’s bag link');

  const quickAdd = { dataset: { quickAdd: product.handle }, replaceWith(node) { this.replacement = node; } };
  context.quickAdd = quickAdd;
  const bagLink = vm.runInContext('showQuickAddConfirmation(quickAdd)', context);
  assert.equal(quickAdd.replacement, bagLink);
  assert.equal(bagLink.href, 'cart.html');
  assert.equal(bagLink.dataset.bagFor, product.handle);
  assert.match(bagLink.innerHTML, /view your bag/i);
  assert.equal(document.activeElement, bagLink, 'successful quick add becomes a focused, explicit bag action');

  const rerenderedBagLink = element(document, { tagName: 'A', dataset: { bagFor: product.handle } });
  context.newRoot = rootWith([rerenderedBagLink]);
  vm.runInContext('refreshQuickAddConfirmations(newRoot)', context);
  assert.match(rerenderedBagLink.innerHTML, /Added — view your bag/i, 'live rerender keeps the recent add confirmation');
  assert.match(rerenderedBagLink.className, /card-add-confirmation/);
}

const mergeStart = app.indexOf('function mergeCartCatalog');
const mergeEnd = app.indexOf('async function refreshInventory', mergeStart);
assert.ok(mergeStart > 0 && mergeEnd > mergeStart);
const mergeSource = app.slice(mergeStart, mergeEnd);
const baselineLine = {
  ...storedLine,
  variantId: 'gid://shopify/ProductVariant/123',
  productHandle: 'a-chair',
  productTitle: 'Saved title',
  priceCents: 10000,
  compareAtPriceCents: 15000,
  imageUrl: 'saved.jpg'
};
const liveProduct = {
  handle: 'a-chair',
  title: 'Current title',
  image: 'current.jpg',
  variants: [{ id: '123', available: true, priceCents: 12000, compareAtPriceCents: 16000 }]
};

function mergeContext(page) {
  const message = { textContent: '' };
  const context = {
    page,
    cartLines: [{ ...baselineLine }],
    PRODUCTS: [liveProduct],
    persistCart() {},
    $() { return message; },
    message
  };
  vm.createContext(context);
  vm.runInContext(mergeSource, context);
  return context;
}

{
  const context = mergeContext('product.html');
  assert.equal(vm.runInContext('mergeCartCatalog()', context), true);
  assert.equal(context.cartLines[0].priceCents, 10000, 'non-cart refresh keeps the shopper-visible price baseline');
  assert.equal(context.cartLines[0].compareAtPriceCents, 15000);
  assert.equal(context.cartLines[0].imageUrl, 'current.jpg', 'availability and presentation facts still refresh');
}

{
  const context = mergeContext('cart.html');
  context.changed = vm.runInContext('mergeCartCatalog()', context);
  assert.equal(context.cartLines[0].priceCents, 12000, 'the cart applies the current price for explicit review');
  assert.equal(context.cartLines[0].compareAtPriceCents, 16000);
  vm.runInContext('showCartPriceChange(changed)', context);
  assert.match(context.message.textContent, /Prices have changed/, 'the cart explains its updated subtotal');
}

assert.match(app, /function refreshHomeMain\(\).*home-search.*restoreFocusState/s);
assert.match(app, /function refreshProductMain\(\).*dialog\?\.open.*variant:.*quantity:.*photo:.*confirmation:.*restoreFocusState/s);
assert.match(app, /function renderCart\(\).*captureFocusState.*restoreFocusState/s);
assert.match(app, /function updateFavorites\(\).*captureFocusState.*restoreFocusState/s);
const quickAddPath = app.slice(app.indexOf("if(t.hasAttribute('data-quick-add'))"), app.indexOf("if(t.hasAttribute('data-checkout'))"));
assert.ok(quickAddPath.indexOf('addLine(') < quickAddPath.indexOf('persistCart()'));
assert.ok(quickAddPath.indexOf('persistCart()') < quickAddPath.indexOf('showQuickAddConfirmation(t)'),
  'the successful quick-add path converts the clicked control synchronously after persisting the cart');
assert.doesNotMatch(app, /queueMicrotask\(.*showQuickAddConfirmation/s,
  'quick-add confirmation must not depend on a capture-phase microtask race');

console.log('interaction resilience: storage, focus, quick add, live refresh, and cart price-baseline tests passed');
