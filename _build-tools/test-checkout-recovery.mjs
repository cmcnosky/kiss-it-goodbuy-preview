import assert from 'node:assert/strict';

await import('../dist/commerce.js');
await import('../dist/checkout-recovery.js');
const C = globalThis.KIGBCommerce;
const R = globalThis.KIGBCheckoutRecovery;
assert.ok(C && R, 'commerce and recovery helpers attach to globalThis');

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const storage = new MemoryStorage();
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
  variantId: '50606537212141',
  quantity: 2,
  productTitle: 'Vintage chair',
  priceCents: 79920,
  currencyCode: 'USD',
  available: true
};
const options = { storage, commerce: C, now: 1000, ttlMs: 2000 };
const checkoutUrl = 'https://kissitgoodbuy.net/cart/c/recovery-test';

const fingerprint = R.cartFingerprint([lamp, chair], { commerce: C });
assert.equal(
  fingerprint,
  R.cartFingerprint([chair, lamp], { commerce: C }),
  'line order does not change the normalized cart fingerprint'
);
assert.notEqual(fingerprint, R.cartFingerprint([{ ...lamp, quantity: 2 }, chair], { commerce: C }));
assert.notEqual(fingerprint, R.cartFingerprint([{ ...lamp, priceCents: 10000 }, chair], { commerce: C }));
assert.notEqual(fingerprint, R.cartFingerprint([{ ...lamp, available: false }, chair], { commerce: C }));
assert.equal(R.cartFingerprint([], { commerce: C }), null);

const saved = R.save(checkoutUrl, [lamp, chair], options);
assert.equal(saved.checkoutUrl, checkoutUrl);
assert.equal(saved.expiresAt, 3000);
assert.equal(R.load([lamp, chair], options).checkoutUrl, checkoutUrl);
assert.equal(R.load([chair, lamp], options).checkoutUrl, checkoutUrl);

assert.equal(
  R.load([{ ...lamp, quantity: 2 }, chair], options),
  null,
  'a changed quantity invalidates the recovery URL'
);
assert.equal(storage.getItem(R.STORAGE_KEY), null, 'a mismatched recovery record is removed');

R.save(checkoutUrl, [lamp, chair], options);
assert.equal(R.load([lamp, chair], { ...options, now: 2999 }).checkoutUrl, checkoutUrl);
assert.equal(R.load([lamp, chair], { ...options, now: 3000 }), null, 'an expired recovery URL is rejected');
assert.equal(storage.getItem(R.STORAGE_KEY), null, 'an expired recovery record is removed');

assert.equal(
  R.save('https://kissitgoodbuy.net.example.com/cart/c/unsafe', [lamp], options),
  null,
  'an untrusted checkout host is never stored'
);
assert.equal(storage.getItem(R.STORAGE_KEY), null);

storage.setItem(R.STORAGE_KEY, '{bad json');
assert.equal(R.load([lamp], options), null);
assert.equal(storage.getItem(R.STORAGE_KEY), null, 'malformed storage is removed');

storage.setItem(R.STORAGE_KEY, JSON.stringify({
  version: 1,
  checkoutUrl,
  fingerprint: R.cartFingerprint([lamp], { commerce: C }),
  createdAt: 1000,
  expiresAt: 1000 + R.MAX_TTL_MS + 1
}));
assert.equal(R.load([lamp], options), null, 'records exceeding the fixed lifetime are rejected');

const inaccessible = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
  removeItem() { throw new Error('blocked'); }
};
assert.equal(R.save(checkoutUrl, [lamp], { storage: inaccessible, commerce: C }), null);
assert.equal(R.load([lamp], { storage: inaccessible, commerce: C }), null);
assert.equal(R.clear({ storage: inaccessible }), false);

const cappedStorage = new MemoryStorage();
const capped = R.save(checkoutUrl, [lamp], {
  storage: cappedStorage,
  commerce: C,
  now: 5000,
  ttlMs: 24 * 60 * 60 * 1000
});
assert.equal(capped.expiresAt - capped.createdAt, R.MAX_TTL_MS, 'recovery lifetime is capped at 15 minutes');

assert.equal(R.clear({ storage: cappedStorage }), true);
assert.equal(cappedStorage.getItem(R.STORAGE_KEY), null);

console.log('checkout recovery helpers: tests passed');
