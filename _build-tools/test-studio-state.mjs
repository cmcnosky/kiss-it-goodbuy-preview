import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

class MemoryStorage {
  constructor() {
    this.values = new Map();
    this.failRead = false;
    this.failWrite = false;
  }
  getItem(key) {
    if (this.failRead) throw new Error('storage read blocked');
    return this.values.has(key) ? this.values.get(key) : null;
  }
  setItem(key, value) {
    if (this.failWrite) throw new Error('storage write blocked');
    this.values.set(key, String(value));
  }
  removeItem(key) {
    if (this.failWrite) throw new Error('storage write blocked');
    this.values.delete(key);
  }
}

const storage = new MemoryStorage();
const listeners = new Map();
const dispatched = [];
let networkCalls = 0;
globalThis.localStorage = storage;
globalThis.addEventListener = (type, listener) => listeners.set(type, listener);
globalThis.dispatchEvent = (event) => { dispatched.push(event); return true; };
globalThis.CustomEvent = class CustomEvent {
  constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
};
globalThis.fetch = async () => {
  networkCalls += 1;
  throw new Error('Studio state must never use the network.');
};

const require = createRequire(import.meta.url);
const Studio = require('../dist/studio-state.js');
assert.ok(Studio, 'KIGBStudioState loads');
assert.equal(Studio.STORAGE_KEY, 'kigb-owner-studio-v1');
assert.equal(Studio.read().active, false);
assert.equal(Studio.read().draft.design.coral, '#e58a78');
assert.equal(Studio.getStatus().persisted, true);
assert.equal(storage.getItem(Studio.STORAGE_KEY), null, 'loading the helper does not write visitor storage');

const defaults = Studio.defaults();
defaults.design.coral = '#000000';
assert.equal(Studio.defaults().design.coral, '#e58a78', 'defaults returns a defensive copy');

let subscriberCalls = 0;
const unsubscribe = Studio.subscribe((_state, status, reason) => {
  subscriberCalls += 1;
  assert.equal(typeof status.persisted, 'boolean');
  assert.equal(typeof reason, 'string');
});

Studio.updateDraft({ design: { coral: '#d65f52', productColumns: 4 } });
Studio.updateDraft({ content: { heroTitle: 'Collected for real rooms' } });
assert.equal(Studio.read().draft.design.coral, '#d65f52');
assert.equal(Studio.read().draft.design.productColumns, 4);
assert.equal(Studio.read().draft.content.heroTitle, 'Collected for real rooms');
assert.equal(Studio.getStatus().canUndo, true);
Studio.undo();
assert.equal(Studio.read().draft.content.heroTitle, Studio.defaults().content.heroTitle);
assert.equal(Studio.read().draft.design.coral, '#d65f52');
Studio.redo();
assert.equal(Studio.read().draft.content.heroTitle, 'Collected for real rooms');

Studio.setActive(true);
assert.equal(Studio.read().active, true);
Studio.updateDraft({
  products: {
    'existing-lamp': {
      title: 'Chelsea’s lamp edit',
      priceCents: 12500,
      available: true,
      dimensionsRaw: '24 in W × 24 in D × 58 in H',
      imageUrl: 'https://cdn.example.test/lamp.jpg',
      hidden: false
    }
  }
});
Studio.updateDraft({ products: { 'existing-lamp': { available: false, title: null } } });
assert.equal(Studio.read().draft.products['existing-lamp'].available, false);
assert.equal('title' in Studio.read().draft.products['existing-lamp'], false);

const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
Studio.updateDraft({
  customProducts: [{
    id: '9000000000001',
    handle: 'studio-one-of-a-kind-lamp',
    title: 'One-of-a-kind lamp',
    priceCents: 22500,
    available: true,
    dimensionsRaw: '18 in W × 18 in D × 31 in H',
    imageUrl: onePixelPng,
    category: 'Lighting'
  }]
});
assert.equal(Studio.read().draft.customProducts.length, 1);

function unchangedAfterFailure(action, expectedCode) {
  const before = Studio.read();
  assert.throws(action, (error) => error.code === expectedCode);
  assert.deepEqual(Studio.read(), before, 'invalid input must not mutate state or revision');
}

unchangedAfterFailure(
  () => Studio.updateDraft({ design: { coral: 'red' } }),
  'INVALID_COLOR'
);
unchangedAfterFailure(
  () => Studio.updateDraft({ products: { 'existing-lamp': { imageUrl: 'javascript:alert(1)' } } }),
  'UNSAFE_URL'
);
unchangedAfterFailure(
  () => Studio.updateDraft({ products: { 'existing-lamp': { surprise: true } } }),
  'UNKNOWN_FIELD'
);
unchangedAfterFailure(
  () => Studio.updateDraft({ customProducts: [{
    id: '9000000000002',
    handle: 'not-studio-prefixed',
    title: 'Unsafe collision',
    priceCents: 100,
    available: true,
    dimensionsRaw: '',
    imageUrl: '',
    category: ''
  }] }),
  'INVALID_HANDLE'
);
unchangedAfterFailure(
  () => Studio.updateDraft({ customProducts: [{
    id: '9000000000002',
    handle: 'studio-svg',
    title: 'SVG image',
    priceCents: 100,
    available: true,
    dimensionsRaw: '',
    imageUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    category: ''
  }] }),
  'UNSAFE_URL'
);

for (let index = 0; index < 12; index += 1) Studio.saveVersion(`Version ${index + 1}`);
assert.equal(Studio.read().versions.length, 10, 'named-version history is bounded');
const versionToRestore = Studio.read().versions[0];
Studio.updateDraft({ content: { heroAccent: 'A temporary edit.' } });
Studio.restoreVersion(versionToRestore.id);
assert.equal(Studio.read().draft.content.heroAccent, versionToRestore.draft.content.heroAccent);
Studio.deleteVersion(versionToRestore.id);
assert.equal(Studio.read().versions.some((entry) => entry.id === versionToRestore.id), false);

const backup = Studio.exportBackup();
assert.ok(backup.length < Studio.MAX_STATE_BYTES);
const parsedBackup = JSON.parse(backup);
assert.equal(parsedBackup.kind, 'kiss-it-goodbuy-owner-studio');

const beforeInvalidImport = Studio.read();
const unknownBackup = JSON.parse(backup);
unknownBackup.studio.draft.design.unexpected = true;
assert.throws(
  () => Studio.importBackup(JSON.stringify(unknownBackup)),
  (error) => error.code === 'UNKNOWN_FIELD'
);
assert.deepEqual(Studio.read(), beforeInvalidImport, 'invalid import preserves state and revision');

const prototypeBackup = JSON.parse(backup);
prototypeBackup.studio.draft.products = JSON.parse('{"__proto__":{"hidden":true}}');
assert.throws(
  () => Studio.importBackup(JSON.stringify(prototypeBackup)),
  (error) => error.code === 'UNSAFE_KEY'
);
assert.deepEqual(Studio.read(), beforeInvalidImport, 'prototype-key import is atomic');
assert.throws(
  () => Studio.importBackup('x'.repeat(Studio.MAX_STATE_BYTES + 1)),
  (error) => error.code === 'STATE_TOO_LARGE'
);
assert.deepEqual(Studio.read(), beforeInvalidImport, 'oversize import is atomic');

Studio.updateDraft({ content: { heroTitle: 'Changed after backup' } });
Studio.importBackup(backup);
assert.equal(Studio.read().draft.content.heroTitle, parsedBackup.studio.draft.content.heroTitle);

const orderItem = {
  variantId: 'gid://shopify/ProductVariant/68162102526189',
  productHandle: 'existing-lamp',
  productTitle: 'Chelsea’s lamp edit',
  quantity: 2,
  priceCents: 12500,
  currencyCode: 'USD',
  imageUrl: 'assets/products/lamp.jpg'
};
const order = Studio.createOrder([orderItem]);
assert.equal(order.status, 'placed');
assert.equal(order.totalCents, 25000);
assert.equal(Studio.read().orders.at(-1).id, order.id);
const ready = Studio.updateOrderStatus(order.id, 'ready_for_pickup');
assert.equal(ready.status, 'ready_for_pickup');

const practiceMessage = Studio.createMessage({
  kind: 'consignment',
  title: 'Practice consignment inquiry',
  body: 'Sample owner-workflow request. Nothing was sent.'
});
assert.equal(practiceMessage.status, 'new');
assert.equal(Studio.read().messages.at(-1).id, practiceMessage.id);
const reviewedMessage = Studio.updateMessageStatus(practiceMessage.id, 'reviewed');
assert.equal(reviewedMessage.status, 'reviewed');

const duplicateIdBackup = JSON.parse(Studio.exportBackup());
duplicateIdBackup.studio.orders.push(structuredClone(duplicateIdBackup.studio.orders[0]));
unchangedAfterFailure(
  () => Studio.importBackup(JSON.stringify(duplicateIdBackup)),
  'DUPLICATE_ID'
);
const duplicateMessageBackup = JSON.parse(Studio.exportBackup());
duplicateMessageBackup.studio.messages.push(structuredClone(duplicateMessageBackup.studio.messages[0]));
unchangedAfterFailure(
  () => Studio.importBackup(JSON.stringify(duplicateMessageBackup)),
  'DUPLICATE_ID'
);

unchangedAfterFailure(
  () => Studio.createOrder([{ ...orderItem, quantity: 251 }]),
  'INVALID_NUMBER'
);
unchangedAfterFailure(
  () => Studio.createOrder([{ ...orderItem, customerEmail: 'nobody@example.test' }]),
  'UNKNOWN_FIELD'
);
unchangedAfterFailure(
  () => Studio.createOrder([{ ...orderItem, currencyCode: 'EUR' }]),
  'INVALID_CURRENCY'
);
unchangedAfterFailure(
  () => Studio.createMessage({
    kind: 'newsletter',
    title: 'Unexpected field',
    body: 'Local sample',
    recipient: 'real@example.test'
  }),
  'UNKNOWN_FIELD'
);
assert.equal(networkCalls, 0, 'studio edits and practice orders never use fetch');

Studio.clearOrders();
Studio.clearMessages();
assert.equal(Studio.read().orders.length, 0);
assert.equal(Studio.read().messages.length, 0);
Studio.updateDraft({ content: { heroTitle: 'Reset me' } });
Studio.resetDraft();
assert.deepEqual(Studio.read().draft, Studio.defaults());
Studio.undo();
assert.equal(Studio.read().draft.content.heroTitle, 'Reset me', 'reset remains undoable');

const storageListener = listeners.get('storage');
assert.equal(typeof storageListener, 'function');
const external = JSON.parse(storage.getItem(Studio.STORAGE_KEY));
external.revision = Studio.read().revision + 1;
external.updatedAt += 1000;
external.writerId = 'writer_external_clean';
external.draft.content.heroTitle = 'Edit from another tab';
storage.values.set(Studio.STORAGE_KEY, JSON.stringify(external));
storageListener({ key: Studio.STORAGE_KEY, storageArea: storage, newValue: JSON.stringify(external) });
assert.equal(Studio.read().draft.content.heroTitle, 'Edit from another tab');
assert.equal(Studio.getStatus().conflict, false);

storage.failWrite = true;
const fallbackOrder = Studio.createOrder([{ ...orderItem, quantity: 1 }]);
assert.equal(fallbackOrder.totalCents, 12500);
assert.equal(Studio.getStatus().persisted, false);
assert.equal(Studio.getStatus().error, 'STORAGE_UNAVAILABLE');
assert.equal(Studio.read().orders.at(-1).id, fallbackOrder.id, 'failed persistence keeps an in-memory working copy');

storage.failWrite = false;
const conflicting = JSON.parse(storage.getItem(Studio.STORAGE_KEY));
conflicting.revision = Studio.read().revision + 1;
conflicting.updatedAt += 2000;
conflicting.writerId = 'writer_external_conflict';
conflicting.draft.content.heroTitle = 'Do not overwrite the local fallback';
storage.values.set(Studio.STORAGE_KEY, JSON.stringify(conflicting));
storageListener({ key: Studio.STORAGE_KEY, storageArea: storage, newValue: JSON.stringify(conflicting) });
assert.equal(Studio.getStatus().conflict, true);
assert.equal(Studio.getStatus().error, 'STATE_CONFLICT');
assert.notEqual(Studio.read().draft.content.heroTitle, 'Do not overwrite the local fallback');

assert.ok(subscriberCalls > 0);
assert.ok(dispatched.every((event) => event.type === 'kigb-studio-change'));
assert.ok(dispatched.every((event) => !('state' in event.detail)), 'browser events expose status only');
unsubscribe();

console.log('owner studio state, validation, history, backup, conflict, and practice-order checks passed');
