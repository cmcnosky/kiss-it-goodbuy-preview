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

{
  const run = bootStorage({});
  assert.match(run(`page='collection.html';navItem('collection.html','Shop the finds')`), /aria-current="page"/);
  for (const sectionPage of ['product.html', 'cart.html', 'shortlist.html']) {
    assert.match(run(`page=${JSON.stringify(sectionPage)};navItem('collection.html','Shop the finds')`), /aria-current="location"/,
      `${sectionPage} must identify the Shop section as the current location`);
  }
  assert.doesNotMatch(run(`page='story.html';navItem('collection.html','Shop the finds')`), /aria-current/);
  assert.match(run(`page='collection.html';collection()`), /data-open-filters aria-haspopup="dialog" aria-controls="filter-dialog"/,
    'the filter disclosure identifies the dialog that it opens');
  const filtered = run(`catalogResults(filterState(new URLSearchParams('q=oak&min=100&budget=500')))`);
  assert.match(filtered, /aria-label="Remove search filter oak"/);
  assert.match(filtered, /aria-label="Remove minimum price filter 100"/);
  assert.match(filtered, /aria-label="Remove maximum price filter 500"/);
  const footer = run('footer()');
  assert.match(footer, /action="https:\/\/kissitgoodbuy\.net\/contact#newsletter-form-sections--20243435815149__footer"/,
    'the newsletter posts to the current official form anchor');
  assert.match(footer, /href="https:\/\/kissitgoodbuy\.net\/apps\/consignor"/,
    'the consignor portal uses the verified canonical URL without an avoidable redirect');
}

{
  const gift = inventory.products.find((entry) => /gift.?card/i.test(`${entry.sourceProductType || ''} ${entry.title}`));
  const run = bootStorage({ 'kigb-favorites': JSON.stringify([gift.handle]) });
  const markup = run('shortlistContent()');
  assert.match(markup, /Digital gift card · choose denomination/);
  assert.match(markup, /See gift-card terms in the original listing\./);
  assert.match(markup, /aria-label="Remove [^"]+ from my shortlist"/,
    'shortlist removal names the affected piece');
  const quoted = inventory.products.find((entry) => /["&]/.test(entry.title));
  assert.ok(quoted, 'catalog fixture includes a title that requires attribute escaping');
  const quotedRun = bootStorage({ 'kigb-favorites': JSON.stringify([quoted.handle]) });
  const escapedTitle = quotedRun(`esc(PRODUCTS.find(p=>p.handle===${JSON.stringify(quoted.handle)}).displayTitle)`);
  assert.ok(quotedRun('shortlistContent()').includes(`aria-label="Remove ${escapedTitle} from my shortlist"`),
    'piece-specific shortlist action remains safely escaped');
}

{
  const run = bootStorage({}, new Set(), product.handle);
  const markup = run('productPage()');
  assert.match(markup, /data-zoom[^>]+aria-haspopup="dialog" aria-controls="photo-dialog"/,
    'the photograph disclosure identifies the enlargement dialog');
  const escapedTitle = run(`esc(PRODUCTS.find(p=>p.handle===${JSON.stringify(product.handle)}).displayTitle)`);
  assert.ok(markup.includes(`data-save="${product.handle}" aria-pressed="false" aria-label="Save ${escapedTitle}"`),
    'the product-page shortlist control keeps its item-specific accessible name after a rerender');
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

{
  const copyStart = app.indexOf('let copyFallbackReturnFocus=');
  const copyEnd = app.indexOf('function updateStatus', copyStart);
  assert.ok(copyStart > 0 && copyEnd > copyStart);
  const textarea = {
    value: '',
    focus() { document.activeElement = this; },
    select() { this.selected = true; }
  };
  const title = { textContent: '' };
  let fallback = null;
  const document = {
    body: {
      append(node) {
        fallback = node;
        node.isConnected = true;
      }
    },
    activeElement: null,
    createElement() {
      return {
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        querySelector(selector) {
          if (selector === 'textarea') return textarea;
          if (selector === '#copy-fallback-title') return title;
          return null;
        },
        remove() { this.isConnected = false; fallback = null; }
      };
    }
  };
  const trigger = { isConnected: true, focus() { document.activeElement = this; } };
  const context = {
    document,
    navigator: { clipboard: { async writeText() { throw new Error('clipboard blocked'); } } },
    $: (selector) => selector === '#copy-link-fallback' ? fallback : null,
    focusElement(node) { node.focus(); return true; },
    toast() {}
  };
  vm.createContext(context);
  vm.runInContext(app.slice(copyStart, copyEnd), context);
  context.value = 'https://example.test/a-share-link';
  context.trigger = trigger;
  vm.runInContext('showCopyFallback(value,trigger)', context);
  assert.equal(fallback.attributes.role, 'region');
  assert.equal(fallback.attributes['aria-labelledby'], 'copy-fallback-title');
  assert.equal(title.textContent, 'Copy this text');
  assert.equal(textarea.value, context.value);
  assert.equal(textarea.selected, true);
  assert.equal(document.activeElement, textarea);
  vm.runInContext('dismissCopyFallback()', context);
  assert.equal(fallback, null);
  assert.equal(document.activeElement, trigger, 'dismissing the fallback restores the originating control');
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
assert.match(app, /function renderCart\([^)]*\).*captureFocusState.*restoreFocusState/s);
assert.match(app, /function updateFavorites\(\).*captureFocusState.*restoreFocusState/s);
const quickAddPath = app.slice(app.indexOf("if(t.hasAttribute('data-quick-add'))"), app.indexOf("if(t.hasAttribute('data-checkout'))"));
assert.ok(quickAddPath.indexOf('addLine(') < quickAddPath.indexOf('persistCart()'));
assert.ok(quickAddPath.indexOf('persistCart()') < quickAddPath.indexOf('showQuickAddConfirmation(t)'),
  'the successful quick-add path converts the clicked control synchronously after persisting the cart');
assert.doesNotMatch(app, /queueMicrotask\(.*showQuickAddConfirmation/s,
  'quick-add confirmation must not depend on a capture-phase microtask race');
assert.match(app, /emailReady\.setAttribute\('role','region'\).*aria-labelledby.*addEventListener\('submit',\(\)=>focusElement\(emailReady\)\)/s,
  'the prepared consignment draft is announced and focused after a valid submit');
assert.match(app, /function syncConditionNote\(\).*pageshow.*syncConditionNote/s,
  'restored consignment condition values must restore the matching warning');
assert.match(app, /data-dismiss-copy.*stopImmediatePropagation\(\).*dismissCopyFallback/s,
  'the clipboard recovery Done action must restore focus through the shared dismissal path');
assert.match(app, /Escape.*copy-link-fallback.*dismissCopyFallback/s,
  'the clipboard recovery panel must close with Escape');

console.log('interaction resilience: storage, focus, navigation, dialogs, share recovery, consignment, quick add, live refresh, and cart price-baseline tests passed');
