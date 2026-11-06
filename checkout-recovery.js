(function attachKIGBCheckoutRecovery(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KIGBCheckoutRecovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createKIGBCheckoutRecovery(root) {
  'use strict';

  const STORAGE_KEY = 'kigb-checkout-recovery-v1';
  const VERSION = 1;
  const MAX_TTL_MS = 15 * 60 * 1000;

  function commerce(options = {}) {
    return options.commerce || root.KIGBCommerce || null;
  }

  function storage(options = {}) {
    if (Object.prototype.hasOwnProperty.call(options, 'storage')) return options.storage;
    try {
      return root.sessionStorage || null;
    } catch {
      return null;
    }
  }

  function normalizedLines(lines, options = {}) {
    const api = commerce(options);
    if (!api || typeof api.normalizeCart !== 'function') return null;
    try {
      const cart = api.normalizeCart(lines, { strict: true });
      if (!cart.length) return null;
      return cart.slice().sort((left, right) => left.variantId.localeCompare(right.variantId));
    } catch {
      return null;
    }
  }

  function cartFingerprint(lines, options = {}) {
    const cart = normalizedLines(lines, options);
    if (!cart) return null;
    return 'v1|' + cart.map((line) => [
      line.variantId,
      line.quantity,
      line.priceCents === null ? '?' : line.priceCents,
      line.currencyCode || '',
      line.available ? 'available' : 'unavailable'
    ].map((value) => encodeURIComponent(String(value))).join(':')).join('|');
  }

  function clear(options = {}) {
    const target = storage(options);
    if (!target || typeof target.removeItem !== 'function') return false;
    try {
      target.removeItem(STORAGE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  function save(checkoutUrl, lines, options = {}) {
    const api = commerce(options);
    const target = storage(options);
    const fingerprint = cartFingerprint(lines, options);
    if (!api || typeof api.trustedCheckoutUrl !== 'function'
      || !api.trustedCheckoutUrl(checkoutUrl) || !fingerprint
      || !target || typeof target.setItem !== 'function') {
      clear(options);
      return null;
    }
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const requestedTtl = Number.isFinite(options.ttlMs) ? options.ttlMs : MAX_TTL_MS;
    const ttlMs = Math.min(MAX_TTL_MS, Math.max(1, requestedTtl));
    const record = {
      version: VERSION,
      checkoutUrl,
      fingerprint,
      createdAt: now,
      expiresAt: now + ttlMs
    };
    try {
      target.setItem(STORAGE_KEY, JSON.stringify(record));
      return Object.freeze({ ...record });
    } catch {
      clear(options);
      return null;
    }
  }

  function load(lines, options = {}) {
    const api = commerce(options);
    const target = storage(options);
    const fingerprint = cartFingerprint(lines, options);
    if (!api || typeof api.trustedCheckoutUrl !== 'function' || !fingerprint
      || !target || typeof target.getItem !== 'function') return null;
    let record;
    try {
      const raw = target.getItem(STORAGE_KEY);
      if (!raw) return null;
      record = JSON.parse(raw);
    } catch {
      clear(options);
      return null;
    }
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const valid = record?.version === VERSION
      && typeof record.checkoutUrl === 'string'
      && api.trustedCheckoutUrl(record.checkoutUrl)
      && record.fingerprint === fingerprint
      && Number.isFinite(record.createdAt)
      && Number.isFinite(record.expiresAt)
      && record.createdAt <= now
      && record.expiresAt > now
      && record.expiresAt - record.createdAt <= MAX_TTL_MS;
    if (!valid) {
      clear(options);
      return null;
    }
    return Object.freeze({ ...record });
  }

  return Object.freeze({
    STORAGE_KEY,
    MAX_TTL_MS,
    cartFingerprint,
    save,
    load,
    clear
  });
});
