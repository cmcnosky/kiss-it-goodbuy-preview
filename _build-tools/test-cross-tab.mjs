import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

await import('../dist/commerce.js');

const root = path.resolve(import.meta.dirname, '..');
const app = fs.readFileSync(path.join(root, 'dist/app.js'), 'utf8');
const start = app.indexOf('// CROSS-TAB STATE START');
const end = app.indexOf('// CROSS-TAB STATE END');
assert.ok(start > 0 && end > start, 'cross-tab state helpers should remain a distinct testable block');
const source = app.slice(start, end);

function fixture(page = 'cart.html', practice = false) {
  const counts = [{ textContent: '' }, { textContent: '' }];
  const calls = { render: [], favorites: 0, catalog: 0, product: 0, home: 0 };
  const listeners = {};
  const localStorage = {};
  const context = {
    page,
    cartStorageKey: practice ? 'kigb-studio-cart-v1' : 'kigb-cart-v1',
    favoritesStorageKey: practice ? 'kigb-studio-favorites' : 'kigb-favorites',
    cartLines: [],
    saved: new Set(),
    localStorage,
    window: {
      KIGBCommerce: globalThis.KIGBCommerce,
      addEventListener(type, listener) { listeners[type] = listener; }
    },
    $$: (selector) => selector === '.cart-count' ? counts : [],
    updateCartCount: () => {
      for (const count of counts) count.textContent = context.cartLines.reduce((total, item) => total + item.quantity, 0);
    },
    renderCart: (options) => calls.render.push(options),
    updateFavorites: () => { calls.favorites += 1; },
    refreshCatalogResults: () => { calls.catalog += 1; },
    refreshProductMain: () => { calls.product += 1; },
    refreshHomeMain: () => { calls.home += 1; }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, counts, calls, listeners, localStorage };
}

const line = {
  variantId: '68162102526189',
  quantity: 2,
  productHandle: 'a-lamp',
  productTitle: 'A lamp',
  priceCents: 9900,
  currencyCode: 'USD'
};

{
  const state = fixture();
  state.listeners.storage({
    key: 'kigb-cart-v1',
    newValue: JSON.stringify([line]),
    storageArea: state.localStorage
  });
  assert.equal(state.context.cartLines.length, 1);
  assert.equal(state.context.cartLines[0].variantId, 'gid://shopify/ProductVariant/68162102526189');
  assert.equal(state.counts[0].textContent, 2);
  assert.equal(state.calls.render.length, 1);
  assert.equal(state.calls.render[0].save, false, 'a storage event must rerender without writing stale state back');

  state.listeners.storage({ key: 'kigb-cart-v1', newValue: '{bad json', storageArea: state.localStorage });
  assert.equal(state.context.cartLines.length, 1, 'malformed cross-tab data must not erase a valid bag');

  state.listeners.storage({ key: 'kigb-cart-v1', newValue: '[]', storageArea: {} });
  assert.equal(state.context.cartLines.length, 1, 'events from another storage area must be ignored');
}

{
  const state = fixture('collection.html');
  state.listeners.storage({
    key: 'kigb-cart-v1',
    newValue: JSON.stringify([line]),
    storageArea: state.localStorage
  });
  assert.equal(state.calls.catalog, 1, 'catalog cards should reflect bag changes made in another tab');
  assert.equal(state.calls.render.length, 0);

  state.listeners.storage({
    key: 'kigb-favorites',
    newValue: JSON.stringify(['first-piece', 123, 'second-piece']),
    storageArea: state.localStorage
  });
  assert.deepEqual([...state.context.saved], ['first-piece', 'second-piece']);
  assert.equal(state.calls.favorites, 1);

  state.listeners.storage({ key: null, newValue: null, storageArea: state.localStorage });
  assert.equal(state.context.cartLines.length, 0, 'clearing storage should clear the synchronized bag');
  assert.equal(state.context.saved.size, 0, 'clearing storage should clear synchronized favorites');
}

{
  const state = fixture('cart.html', true);
  state.listeners.storage({ key: 'kigb-cart-v1', newValue: JSON.stringify([line]), storageArea: state.localStorage });
  assert.equal(state.context.cartLines.length, 0, 'real-store bag events must not enter the practice bag');
  state.listeners.storage({ key: 'kigb-studio-cart-v1', newValue: JSON.stringify([line]), storageArea: state.localStorage });
  assert.equal(state.context.cartLines.length, 1, 'practice bags synchronize only with their own storage key');
}

assert.match(app, /function renderCart\(\{save=true\}=\{\}\).*if\(save\)persistCart\(\);else updateCartCount\(\)/,
  'storage-driven cart rendering must not write the synchronized value back');
assert.match(app, /p\.itemNumber\?'No\. '\+esc\(p\.itemNumber\):'Gift card'/,
  'merchant item numbers must be escaped before entering hero markup');

const shareStart = app.indexOf('// SHORTLIST SHARE START');
const shareEnd = app.indexOf('// SHORTLIST SHARE END');
assert.ok(shareStart > 0 && shareEnd > shareStart, 'shortlist sharing should remain a distinct testable block');
const shareSource = app.slice(shareStart, shareEnd);

function shareFixture(items) {
  const calls = { copied: [], fallbacks: [], messages: [] };
  const title = { textContent: '' };
  const trigger = { id: 'share-trigger' };
  const context = {
    URL,
    document: { baseURI: 'https://example.test/site/', activeElement: trigger },
    shortlistItems: () => items,
    shortlistInquiry: (value) => value.map((item) => `${item.itemNumber}:${item.title}`).join('\n'),
    copyLink: (value) => calls.copied.push(value),
    showCopyFallback: (value, receivedTrigger, receivedTitle, receivedMessage) => {
      calls.fallbacks.push({ value, trigger: receivedTrigger, title: receivedTitle, message: receivedMessage });
      title.textContent = receivedTitle;
      calls.messages.push(receivedMessage);
      return { querySelector: (selector) => selector === '#copy-fallback-title' ? title : null };
    },
    toast: (message) => calls.messages.push(message)
  };
  vm.createContext(context);
  vm.runInContext(shareSource, context);
  return { context, calls, title, trigger };
}

{
  const items = [
    { itemNumber: '101', referenceId: '1', title: 'Chair' },
    { itemNumber: '102', referenceId: '2', title: 'Lamp' }
  ];
  const state = shareFixture(items);
  assert.equal(vm.runInContext('shareShortlist()', state.context), true);
  assert.equal(state.calls.fallbacks.length, 0);
  assert.equal(state.calls.copied.length, 1);
  const shared = new URL(state.calls.copied[0]);
  assert.equal(shared.searchParams.get('items'), '101,102', 'a normal share link must preserve every shortlisted item');
}

{
  const items = Array.from({ length: 249 }, (_, index) => ({
    itemNumber: `ITEM-${String(index).padStart(6, '0')}`,
    referenceId: String(index),
    title: `Piece ${index}`
  }));
  const state = shareFixture(items);
  assert.equal(vm.runInContext('shareShortlist()', state.context), false);
  assert.equal(state.calls.copied.length, 0, 'an unreliable long URL must never be silently copied');
  assert.equal(state.calls.fallbacks.length, 1);
  assert.equal(state.calls.fallbacks[0].trigger, state.trigger);
  assert.match(state.calls.fallbacks[0].value, /ITEM-000000:Piece 0/);
  assert.match(state.calls.fallbacks[0].value, /ITEM-000248:Piece 248/,
    'the manual inquiry must retain the final item rather than truncate the list');
  assert.equal(state.title.textContent, 'Copy your complete shortlist inquiry');
  assert.match(state.calls.messages.at(-1), /too long for a reliable link/i);
}

console.log('cross-tab state: cart and shortlist synchronization tests passed');
