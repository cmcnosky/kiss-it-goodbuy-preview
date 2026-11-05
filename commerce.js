(function attachKIGBCommerce(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KIGBCommerce = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createKIGBCommerce() {
  'use strict';

  const API_ENDPOINT = 'https://kissitgoodbuy.net/api/2026-10/graphql.json';
  const UCP_ENDPOINT = 'https://kissitgoodbuy.net/buy';
  const UCP_VERSION = '2026-08-25';
  const DEFAULT_TIMEOUT_MS = 12000;
  const VARIANT_GID_PREFIX = 'gid://shopify/ProductVariant/';
  const NUMERIC_ID = /^\d+$/;
  const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/;

  class CommerceError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = 'CommerceError';
      this.code = code;
      if (details !== undefined) this.details = details;
    }
  }

  function text(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
  }

  function toVariantGid(value) {
    if (typeof value !== 'string') {
      throw new CommerceError(
        'INVALID_VARIANT_ID',
        'Variant IDs must be strings so large Shopify IDs are not rounded.'
      );
    }
    const clean = value.trim();
    if (VARIANT_GID.test(clean)) return clean;
    if (NUMERIC_ID.test(clean)) return VARIANT_GID_PREFIX + clean;
    throw new CommerceError('INVALID_VARIANT_ID', 'The cart contains an invalid Shopify variant ID.');
  }

  function numericVariantId(value) {
    const gid = toVariantGid(value);
    return gid.match(VARIANT_GID)[1];
  }

  function quantity(value, allowZero = false) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < (allowZero ? 0 : 1) || number > 999) {
      throw new CommerceError('INVALID_QUANTITY', 'Quantity must be a whole number between 1 and 999.');
    }
    return number;
  }

  function priceCents(value, allowMissing = true) {
    if (value === null || value === undefined || value === '') {
      if (allowMissing) return null;
      throw new CommerceError('INVALID_PRICE', 'A current item price is required.');
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new CommerceError('INVALID_PRICE', 'Item prices must be non-negative whole cents.');
    }
    return number;
  }

  function amountToCents(amount) {
    const value = String(amount ?? '').trim();
    if (!/^\d+(?:\.\d+)?$/.test(value)) {
      throw new CommerceError('INVALID_REMOTE_PRICE', 'Shopify returned an invalid price.');
    }
    const [whole, fraction = ''] = value.split('.');
    if (fraction.length > 2 && /[^0]/.test(fraction.slice(2))) {
      throw new CommerceError('UNSUPPORTED_CURRENCY_PRECISION', 'The storefront returned a price with unsupported precision.');
    }
    const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
    if (!Number.isSafeInteger(cents)) {
      throw new CommerceError('INVALID_REMOTE_PRICE', 'The storefront returned a price outside the supported range.');
    }
    return cents;
  }

  function normalizeLine(line) {
    if (!line || typeof line !== 'object') {
      throw new CommerceError('INVALID_CART_LINE', 'Each cart line must be an object.');
    }
    return {
      variantId: toVariantGid(line.variantId || line.id),
      quantity: quantity(line.quantity),
      productHandle: text(line.productHandle || line.handle),
      productTitle: text(line.productTitle || line.title, 'Item'),
      variantTitle: text(line.variantTitle),
      priceCents: priceCents(line.priceCents),
      compareAtPriceCents: priceCents(line.compareAtPriceCents),
      currencyCode: text(line.currencyCode, 'USD').toUpperCase(),
      imageUrl: text(line.imageUrl || line.image),
      onlineStoreUrl: text(line.onlineStoreUrl),
      available: line.available !== false
    };
  }

  function normalizeCart(lines, options = {}) {
    const strict = options.strict === true;
    if (!Array.isArray(lines)) {
      if (strict) throw new CommerceError('INVALID_CART', 'The cart must be an array.');
      return [];
    }
    const merged = new Map();
    for (const candidate of lines) {
      try {
        const line = normalizeLine(candidate);
        const existing = merged.get(line.variantId);
        if (existing) {
          existing.quantity = quantity(existing.quantity + line.quantity);
          if (line.priceCents !== null) existing.priceCents = line.priceCents;
          if (line.compareAtPriceCents !== null) existing.compareAtPriceCents = line.compareAtPriceCents;
          existing.available = existing.available && line.available;
        } else {
          merged.set(line.variantId, line);
        }
      } catch (error) {
        if (strict) throw error;
      }
    }
    return Array.from(merged.values());
  }

  function addLine(lines, candidate) {
    return normalizeCart([...normalizeCart(lines, { strict: true }), normalizeLine(candidate)], { strict: true });
  }

  function updateLine(lines, variantId, nextQuantity) {
    const gid = toVariantGid(variantId);
    const next = quantity(nextQuantity, true);
    const current = normalizeCart(lines, { strict: true });
    if (next === 0) return current.filter((line) => line.variantId !== gid);
    let found = false;
    const updated = current.map((line) => {
      if (line.variantId !== gid) return line;
      found = true;
      return { ...line, quantity: next };
    });
    if (!found) throw new CommerceError('CART_LINE_NOT_FOUND', 'That item is no longer in the cart.');
    return updated;
  }

  function cartSummary(lines) {
    const cart = normalizeCart(lines, { strict: true });
    const currencies = new Set(cart.map((line) => line.currencyCode).filter(Boolean));
    const priceComplete = cart.every((line) => line.priceCents !== null);
    return {
      distinctItems: cart.length,
      itemCount: cart.reduce((sum, line) => sum + line.quantity, 0),
      subtotalCents: priceComplete
        ? cart.reduce((sum, line) => sum + line.priceCents * line.quantity, 0)
        : null,
      currencyCode: currencies.size === 1 ? Array.from(currencies)[0] : null,
      priceComplete,
      hasUnavailable: cart.some((line) => line.available === false)
    };
  }

  async function fetchGraphQL(query, variables = {}, options = {}) {
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetchImpl) throw new CommerceError('FETCH_UNAVAILABLE', 'This browser cannot connect to the store.');
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const parentSignal = options.signal;
    const abortFromParent = () => controller.abort(parentSignal.reason);
    if (parentSignal) {
      if (parentSignal.aborted) abortFromParent();
      else parentSignal.addEventListener('abort', abortFromParent, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error('Store request timed out.')), timeoutMs);
    try {
      const response = await fetchImpl(options.endpoint || API_ENDPOINT, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      });
      if (!response || !response.ok) {
        throw new CommerceError('STOREFRONT_HTTP_ERROR', `The store returned HTTP ${response?.status || 'error'}.`);
      }
      const payload = await response.json();
      if (Array.isArray(payload.errors) && payload.errors.length) {
        throw new CommerceError(
          'STOREFRONT_GRAPHQL_ERROR',
          payload.errors.map((item) => item.message).filter(Boolean).join(' ') || 'The store could not answer the request.',
          { errors: payload.errors }
        );
      }
      if (!payload.data) throw new CommerceError('STOREFRONT_EMPTY_RESPONSE', 'The store returned no data.');
      return payload.data;
    } catch (error) {
      if (error instanceof CommerceError) throw error;
      if (controller.signal.aborted) {
        throw new CommerceError('STOREFRONT_TIMEOUT', 'The store took too long to respond. Please try again.');
      }
      throw new CommerceError('STOREFRONT_NETWORK_ERROR', 'The store could not be reached. Please try again.', { cause: error });
    } finally {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', abortFromParent);
    }
  }

  const PRODUCT_QUERY = `
    query ProductForStorefront($handle: String!) {
      product(handle: $handle) {
        id
        handle
        title
        description
        descriptionHtml
        productType
        vendor
        tags
        updatedAt
        availableForSale
        onlineStoreUrl
        featuredImage { url altText width height }
        images(first: 20) { nodes { url altText width height } }
        variants(first: 20) {
          nodes {
            id
            title
            sku
            availableForSale
            price { amount currencyCode }
            compareAtPrice { amount currencyCode }
            selectedOptions { name value }
            quantityRule { minimum maximum increment }
            storeAvailability(first: 10) {
              nodes {
                available
                pickUpTime
                location { name address { address1 city provinceCode zip } }
              }
            }
          }
        }
      }
    }
  `;

  async function fetchProduct(handle, options = {}) {
    const clean = text(handle).trim();
    if (!/^[a-z0-9][a-z0-9-]{0,254}$/.test(clean)) {
      throw new CommerceError('INVALID_PRODUCT_HANDLE', 'The product address is invalid.');
    }
    const data = await fetchGraphQL(PRODUCT_QUERY, { handle: clean }, options);
    if (!data.product) throw new CommerceError('PRODUCT_NOT_FOUND', 'This item is no longer in the live catalog.');
    return data.product;
  }

  const VALIDATE_QUERY = `
    query ValidateCart($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          title
          availableForSale
          price { amount currencyCode }
          compareAtPrice { amount currencyCode }
          quantityRule { minimum maximum increment }
          product {
            handle
            title
            onlineStoreUrl
            featuredImage { url altText }
          }
        }
      }
    }
  `;

  function quantityRuleIssue(requested, rule = {}) {
    const minimum = Number.isInteger(rule.minimum) ? rule.minimum : 1;
    const maximum = Number.isInteger(rule.maximum) ? rule.maximum : null;
    const increment = Number.isInteger(rule.increment) && rule.increment > 0 ? rule.increment : 1;
    if (requested < minimum) return `The minimum quantity is ${minimum}.`;
    if (maximum !== null && requested > maximum) return `The maximum quantity is ${maximum}.`;
    if ((requested - minimum) % increment !== 0) return `Quantity must increase by ${increment} from ${minimum}.`;
    return null;
  }

  async function validateCart(lines, options = {}) {
    const requested = normalizeCart(lines, { strict: true });
    if (!requested.length) throw new CommerceError('EMPTY_CART', 'Your cart is empty.');
    if (requested.length > 250) throw new CommerceError('CART_TOO_LARGE', 'The cart has too many distinct items.');
    const data = await fetchGraphQL(VALIDATE_QUERY, { ids: requested.map((line) => line.variantId) }, options);
    const returned = Array.isArray(data.nodes) ? data.nodes : [];
    const byId = new Map(returned.filter(Boolean).map((variant) => [variant.id, variant]));
    const issues = [];
    const priceChanges = [];
    const currentLines = [];

    for (const line of requested) {
      const variant = byId.get(line.variantId);
      if (!variant) {
        issues.push({ variantId: line.variantId, code: 'MISSING', message: `${line.productTitle} is no longer in the catalog.` });
        currentLines.push({ ...line, available: false });
        continue;
      }
      if (!variant.availableForSale) {
        issues.push({ variantId: line.variantId, code: 'UNAVAILABLE', message: `${variant.product.title} is no longer available.` });
      }
      const ruleMessage = quantityRuleIssue(line.quantity, variant.quantityRule);
      if (ruleMessage) {
        issues.push({ variantId: line.variantId, code: 'QUANTITY_RULE', message: `${variant.product.title}: ${ruleMessage}` });
      }
      const currentPrice = amountToCents(variant.price.amount);
      const currencyCode = variant.price.currencyCode;
      if (line.priceCents === null || line.priceCents !== currentPrice || line.currencyCode !== currencyCode) {
        priceChanges.push({
          variantId: line.variantId,
          productTitle: variant.product.title,
          fromCents: line.priceCents,
          toCents: currentPrice,
          fromCurrency: line.currencyCode,
          toCurrency: currencyCode
        });
      }
      currentLines.push({
        variantId: variant.id,
        quantity: line.quantity,
        productHandle: variant.product.handle,
        productTitle: variant.product.title,
        variantTitle: variant.title === 'Default Title' ? '' : variant.title,
        priceCents: currentPrice,
        compareAtPriceCents: variant.compareAtPrice ? amountToCents(variant.compareAtPrice.amount) : null,
        currencyCode,
        imageUrl: variant.product.featuredImage?.url || line.imageUrl,
        onlineStoreUrl: variant.product.onlineStoreUrl || line.onlineStoreUrl,
        available: variant.availableForSale
      });
    }

    if (issues.length) {
      throw new CommerceError('CART_VALIDATION_FAILED', 'Some items need attention before checkout.', {
        issues,
        currentLines,
        priceChanges,
        requestedLines: requested
      });
    }
    return { lines: currentLines, priceChanges };
  }

  const CREATE_CART_MUTATION = `
    mutation CreateCheckout($input: CartInput!) {
      cartCreate(input: $input) {
        cart {
          checkoutUrl
          lines(first: 250) {
            nodes {
              id
              quantity
              merchandise { ... on ProductVariant { id availableForSale } }
            }
          }
          cost {
            subtotalAmount { amount currencyCode }
            totalAmount { amount currencyCode }
          }
        }
        userErrors { field message code }
        warnings { code message target }
      }
    }
  `;

  function trustedCheckoutUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return host === 'kissitgoodbuy.net'
      || host === 'www.kissitgoodbuy.net'
      || host === 'account.kissitgoodbuy.net'
      || host === 'kissitgoodbuy.myshopify.com';
  }

  function compareCreatedLines(requested, created) {
    const expected = new Map(requested.map((line) => [line.variantId, line.quantity]));
    const actual = new Map();
    for (const line of created || []) {
      const id = line?.merchandise?.id;
      if (!id) continue;
      actual.set(id, (actual.get(id) || 0) + Number(line.quantity || 0));
    }
    const mismatches = [];
    for (const [variantId, wanted] of expected) {
      const received = actual.get(variantId) || 0;
      if (received !== wanted) mismatches.push({ variantId, requested: wanted, created: received });
    }
    for (const [variantId, received] of actual) {
      if (!expected.has(variantId)) mismatches.push({ variantId, requested: 0, created: received });
    }
    return mismatches;
  }

  async function createCheckout(lines, options = {}) {
    const checked = await validateCart(lines, options);
    if (checked.priceChanges.length && options.acceptPriceChanges !== true) {
      throw new CommerceError('CART_PRICE_CHANGED', 'A price needs review. Review the live price before checkout.', {
        priceChanges: checked.priceChanges,
        currentLines: checked.lines
      });
    }
    const input = {
      lines: checked.lines.map((line) => ({ merchandiseId: line.variantId, quantity: line.quantity }))
    };
    const data = await fetchGraphQL(CREATE_CART_MUTATION, { input }, options);
    const result = data.cartCreate;
    if (!result) throw new CommerceError('CART_CREATE_FAILED', 'Shopify did not return a cart.');
    if (Array.isArray(result.userErrors) && result.userErrors.length) {
      throw new CommerceError('CART_CREATE_REJECTED', 'Shopify could not create this cart.', {
        userErrors: result.userErrors,
        currentLines: checked.lines
      });
    }
    if (Array.isArray(result.warnings) && result.warnings.length) {
      throw new CommerceError('CART_CREATE_WARNING', 'Shopify changed part of the cart. Review the items before continuing.', {
        warnings: result.warnings,
        currentLines: checked.lines,
        cart: result.cart || null
      });
    }
    if (!result.cart) throw new CommerceError('CART_CREATE_FAILED', 'Shopify did not create a cart.');
    const mismatches = compareCreatedLines(checked.lines, result.cart.lines?.nodes);
    if (mismatches.length) {
      throw new CommerceError('CART_LINE_MISMATCH', 'Shopify could not add every requested item and quantity.', {
        mismatches,
        currentLines: checked.lines,
        cart: result.cart
      });
    }
    if (!trustedCheckoutUrl(result.cart.checkoutUrl)) {
      throw new CommerceError('UNTRUSTED_CHECKOUT_URL', 'Shopify returned an unexpected checkout address.');
    }
    return {
      checkoutUrl: result.cart.checkoutUrl,
      cost: result.cart.cost,
      lines: checked.lines,
      priceChanges: checked.priceChanges
    };
  }

  function buildCartReviewUrl(lines) {
    const cart = normalizeCart(lines, { strict: true });
    if (!cart.length) throw new CommerceError('EMPTY_CART', 'Your cart is empty.');
    if (cart.length > 500) throw new CommerceError('CART_TOO_LARGE', 'The cart has too many distinct items.');
    const items = cart.map((line) => `${numericVariantId(line.variantId)}:${line.quantity}`).join(',');
    const url = `${UCP_ENDPOINT}/${items}?continue_to=/cart&ucp/version=${UCP_VERSION}`;
    if (url.length > 2048) throw new CommerceError('CART_LINK_TOO_LONG', 'The cart is too large for a fallback review link.');
    return url;
  }

  return Object.freeze({
    API_ENDPOINT,
    UCP_ENDPOINT,
    CommerceError,
    normalizeCart,
    addLine,
    updateLine,
    cartSummary,
    fetchGraphQL,
    fetchProduct,
    validateCart,
    createCheckout,
    buildCartReviewUrl,
    trustedCheckoutUrl,
    toVariantGid,
    numericVariantId
  });
});
