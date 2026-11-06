(function attachKIGBStudioState(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KIGBStudioState = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createKIGBStudioState(root) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'kigb-owner-studio-v1';
  const BACKUP_KIND = 'kiss-it-goodbuy-owner-studio';
  const MAX_STATE_BYTES = 4 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 150 * 1024;
  const MAX_EMBEDDED_IMAGES = 20;
  const MAX_UNDO = 25;
  const MAX_VERSIONS = 10;
  const MAX_PRODUCT_OVERRIDES = 250;
  const MAX_CUSTOM_PRODUCTS = 100;
  const MAX_ORDERS = 50;
  const MAX_MESSAGES = 25;
  const MAX_ORDER_ITEMS = 50;
  const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  const HANDLE = /^[a-z0-9][a-z0-9-]{0,254}$/;
  const CUSTOM_HANDLE = /^studio-[a-z0-9][a-z0-9-]{0,247}$/;
  const NUMERIC_ID = /^\d{1,30}$/;
  const VARIANT_ID = /^(?:\d{1,30}|gid:\/\/shopify\/ProductVariant\/\d{1,30})$/;
  const ID = /^[A-Za-z0-9_-]{6,80}$/;
  const HEX_COLOR = /^#[0-9a-f]{6}$/i;
  const ORDER_STATUSES = Object.freeze(['placed', 'confirmed', 'ready_for_pickup', 'completed', 'cancelled']);
  const MESSAGE_KINDS = Object.freeze(['newsletter', 'consignment']);
  const MESSAGE_STATUSES = Object.freeze(['new', 'reviewed', 'replied']);
  const subscribers = new Set();

  const DEFAULT_DRAFT = {
    design: {
      coral: '#e58a78',
      celadon: '#bfd9b7',
      ochre: '#edc56b',
      cream: '#fff9ed',
      ink: '#2d2927',
      frame: '#8f2f28',
      headingFont: 'Georgia',
      bodyFont: 'Grotesk',
      textScale: 1,
      borderWidth: 5,
      density: 'comfortable',
      heroLayout: 'gallery',
      productColumns: 3,
      imageFit: 'contain'
    },
    content: {
      heroTitle: 'A home with',
      heroAccent: 'something to say.',
      heroIntro: 'Furniture. Art. The unexpected.\nCome find what feels like you.',
      phone: '817-481-9754',
      email: 'info@kissitgoodbuy.net',
      address: '201 East Franklin Street',
      city: 'Grapevine, TX 76051'
    },
    products: {},
    customProducts: []
  };

  class StudioStateError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = 'StudioStateError';
      this.code = code;
      if (details !== undefined) this.details = details;
    }
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function plainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new StudioStateError('INVALID_STATE', `${label} must be an object.`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new StudioStateError('UNSAFE_OBJECT', `${label} must be a plain object.`);
    }
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new StudioStateError('UNSAFE_KEY', `${label} contains a forbidden key.`);
      }
    }
    return value;
  }

  function exactKeys(value, allowed, label, required = allowed) {
    const object = plainObject(value, label);
    const accepted = new Set(allowed);
    for (const key of Object.keys(object)) {
      if (!accepted.has(key)) throw new StudioStateError('UNKNOWN_FIELD', `${label} contains unknown field ${key}.`);
    }
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) {
        throw new StudioStateError('MISSING_FIELD', `${label} is missing ${key}.`);
      }
    }
    return object;
  }

  function string(value, label, maximum, { empty = false } = {}) {
    if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > maximum) {
      throw new StudioStateError('INVALID_TEXT', `${label} must be ${empty ? 'at most' : 'between 1 and'} ${maximum} characters.`);
    }
    return value;
  }

  function integer(value, label, minimum, maximum) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new StudioStateError('INVALID_NUMBER', `${label} must be a whole number from ${minimum} to ${maximum}.`);
    }
    return value;
  }

  function finiteNumber(value, label, minimum, maximum) {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new StudioStateError('INVALID_NUMBER', `${label} must be between ${minimum} and ${maximum}.`);
    }
    return value;
  }

  function boolean(value, label) {
    if (typeof value !== 'boolean') throw new StudioStateError('INVALID_BOOLEAN', `${label} must be true or false.`);
    return value;
  }

  function oneOf(value, choices, label) {
    if (!choices.includes(value)) throw new StudioStateError('INVALID_CHOICE', `${label} is not supported.`);
    return value;
  }

  function decodedBase64Bytes(value) {
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    return Math.floor(value.length * 3 / 4) - padding;
  }

  function safeImageUrl(value, label, { empty = true } = {}) {
    string(value, label, 300000, { empty });
    if (!value) return value;
    const data = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (data) {
      if (data[2].length % 4 !== 0 || decodedBase64Bytes(data[2]) > MAX_IMAGE_BYTES) {
        throw new StudioStateError('IMAGE_TOO_LARGE', `${label} must be a PNG, JPEG, or WebP no larger than 150 KB.`);
      }
      const signatureOk = data[1] === 'png'
        ? data[2].startsWith('iVBORw0KGgo')
        : data[1] === 'jpeg'
          ? data[2].startsWith('/9j/')
          : data[2].startsWith('UklGR');
      if (!signatureOk) throw new StudioStateError('INVALID_IMAGE', `${label} does not match its declared image type.`);
      return value;
    }
    if (/^assets\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes('..')) return value;
    if (value.length > 2048) throw new StudioStateError('UNSAFE_URL', `${label} is too long.`);
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new StudioStateError('UNSAFE_URL', `${label} must use HTTPS, a site asset, or a supported embedded image.`);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
      throw new StudioStateError('UNSAFE_URL', `${label} must use a credential-free HTTPS address.`);
    }
    return value;
  }

  function validateDesign(value) {
    const keys = ['coral', 'celadon', 'ochre', 'cream', 'ink', 'frame', 'headingFont', 'bodyFont',
      'textScale', 'borderWidth', 'density', 'heroLayout', 'productColumns', 'imageFit'];
    const design = exactKeys(value, keys, 'draft.design');
    for (const key of ['coral', 'celadon', 'ochre', 'cream', 'ink', 'frame']) {
      if (!HEX_COLOR.test(design[key])) throw new StudioStateError('INVALID_COLOR', `${key} must be a six-digit hex color.`);
    }
    oneOf(design.headingFont, ['Georgia', 'Optima', 'Grotesk'], 'headingFont');
    oneOf(design.bodyFont, ['Grotesk', 'Georgia', 'Arial'], 'bodyFont');
    finiteNumber(design.textScale, 'textScale', 0.8, 1.4);
    integer(design.borderWidth, 'borderWidth', 1, 10);
    oneOf(design.density, ['compact', 'comfortable', 'spacious'], 'density');
    oneOf(design.heroLayout, ['gallery', 'split', 'editorial'], 'heroLayout');
    integer(design.productColumns, 'productColumns', 2, 5);
    oneOf(design.imageFit, ['contain', 'cover'], 'imageFit');
    return design;
  }

  function validateContent(value) {
    const keys = ['heroTitle', 'heroAccent', 'heroIntro', 'phone', 'email', 'address', 'city'];
    const content = exactKeys(value, keys, 'draft.content');
    string(content.heroTitle, 'heroTitle', 100);
    string(content.heroAccent, 'heroAccent', 100);
    string(content.heroIntro, 'heroIntro', 400);
    string(content.phone, 'phone', 40);
    string(content.email, 'email', 160);
    string(content.address, 'address', 180);
    string(content.city, 'city', 120);
    return content;
  }

  function validateProductOverride(value, label) {
    const keys = ['title', 'priceCents', 'available', 'dimensionsRaw', 'imageUrl', 'hidden'];
    const item = exactKeys(value, keys, label, []);
    if (!Object.keys(item).length) throw new StudioStateError('EMPTY_OVERRIDE', `${label} cannot be empty.`);
    if ('title' in item) string(item.title, `${label}.title`, 160);
    if ('priceCents' in item) integer(item.priceCents, `${label}.priceCents`, 0, 1000000000);
    if ('available' in item) boolean(item.available, `${label}.available`);
    if ('dimensionsRaw' in item) string(item.dimensionsRaw, `${label}.dimensionsRaw`, 240, { empty: true });
    if ('imageUrl' in item) safeImageUrl(item.imageUrl, `${label}.imageUrl`);
    if ('hidden' in item) boolean(item.hidden, `${label}.hidden`);
    return item;
  }

  function validateCustomProduct(value, index) {
    const label = `draft.customProducts[${index}]`;
    const keys = ['id', 'handle', 'title', 'priceCents', 'available', 'dimensionsRaw', 'imageUrl', 'category'];
    const item = exactKeys(value, keys, label);
    if (!NUMERIC_ID.test(item.id)) throw new StudioStateError('INVALID_ID', `${label}.id must be a numeric string.`);
    if (!CUSTOM_HANDLE.test(item.handle)) throw new StudioStateError('INVALID_HANDLE', `${label}.handle must begin with studio-.`);
    string(item.title, `${label}.title`, 160);
    integer(item.priceCents, `${label}.priceCents`, 0, 1000000000);
    boolean(item.available, `${label}.available`);
    string(item.dimensionsRaw, `${label}.dimensionsRaw`, 240, { empty: true });
    safeImageUrl(item.imageUrl, `${label}.imageUrl`);
    string(item.category, `${label}.category`, 100, { empty: true });
    return item;
  }

  function validateDraft(value) {
    const draft = exactKeys(value, ['design', 'content', 'products', 'customProducts'], 'draft');
    validateDesign(draft.design);
    validateContent(draft.content);
    const products = plainObject(draft.products, 'draft.products');
    const handles = Object.keys(products);
    if (handles.length > MAX_PRODUCT_OVERRIDES) {
      throw new StudioStateError('TOO_MANY_PRODUCTS', `At most ${MAX_PRODUCT_OVERRIDES} inventory overrides are supported.`);
    }
    for (const handle of handles) {
      if (!HANDLE.test(handle)) throw new StudioStateError('INVALID_HANDLE', `Invalid product handle ${handle}.`);
      validateProductOverride(products[handle], `draft.products.${handle}`);
    }
    if (!Array.isArray(draft.customProducts) || draft.customProducts.length > MAX_CUSTOM_PRODUCTS) {
      throw new StudioStateError('TOO_MANY_PRODUCTS', `At most ${MAX_CUSTOM_PRODUCTS} custom products are supported.`);
    }
    const customHandles = new Set();
    const customIds = new Set();
    draft.customProducts.forEach((item, index) => {
      validateCustomProduct(item, index);
      if (customHandles.has(item.handle) || Object.prototype.hasOwnProperty.call(products, item.handle)) {
        throw new StudioStateError('DUPLICATE_HANDLE', `Duplicate product handle ${item.handle}.`);
      }
      if (customIds.has(item.id)) throw new StudioStateError('DUPLICATE_ID', `Duplicate custom-product ID ${item.id}.`);
      customHandles.add(item.handle);
      customIds.add(item.id);
    });
    const embeddedImages = [
      ...Object.values(products).map((item) => item.imageUrl),
      ...draft.customProducts.map((item) => item.imageUrl)
    ].filter((imageUrl) => typeof imageUrl === 'string' && imageUrl.startsWith('data:image/'));
    if (embeddedImages.length > MAX_EMBEDDED_IMAGES) {
      throw new StudioStateError('TOO_MANY_IMAGES', `At most ${MAX_EMBEDDED_IMAGES} embedded product photographs are supported.`);
    }
    return draft;
  }

  function validateVersion(value, index) {
    const label = `versions[${index}]`;
    const version = exactKeys(value, ['id', 'name', 'createdAt', 'draft'], label);
    if (!ID.test(version.id)) throw new StudioStateError('INVALID_ID', `${label}.id is invalid.`);
    string(version.name, `${label}.name`, 80);
    integer(version.createdAt, `${label}.createdAt`, 0, Number.MAX_SAFE_INTEGER);
    validateDraft(version.draft);
    return version;
  }

  function validateOrderItem(value, orderIndex, itemIndex) {
    const label = `orders[${orderIndex}].items[${itemIndex}]`;
    const item = exactKeys(value, [
      'variantId', 'productHandle', 'productTitle', 'quantity', 'priceCents', 'currencyCode', 'imageUrl'
    ], label);
    if (typeof item.variantId !== 'string' || !VARIANT_ID.test(item.variantId)) {
      throw new StudioStateError('INVALID_VARIANT_ID', `${label}.variantId is invalid.`);
    }
    if (!HANDLE.test(item.productHandle)) throw new StudioStateError('INVALID_HANDLE', `${label}.productHandle is invalid.`);
    string(item.productTitle, `${label}.productTitle`, 160);
    integer(item.quantity, `${label}.quantity`, 1, 250);
    integer(item.priceCents, `${label}.priceCents`, 0, 1000000000);
    if (item.currencyCode !== 'USD') throw new StudioStateError('INVALID_CURRENCY', `${label}.currencyCode must be USD.`);
    safeImageUrl(item.imageUrl, `${label}.imageUrl`);
    return item;
  }

  function validateOrder(value, index) {
    const label = `orders[${index}]`;
    const order = exactKeys(value, ['id', 'createdAt', 'updatedAt', 'status', 'items', 'totalCents'], label);
    if (!ID.test(order.id)) throw new StudioStateError('INVALID_ID', `${label}.id is invalid.`);
    integer(order.createdAt, `${label}.createdAt`, 0, Number.MAX_SAFE_INTEGER);
    integer(order.updatedAt, `${label}.updatedAt`, order.createdAt, Number.MAX_SAFE_INTEGER);
    oneOf(order.status, ORDER_STATUSES, `${label}.status`);
    if (!Array.isArray(order.items) || !order.items.length || order.items.length > MAX_ORDER_ITEMS) {
      throw new StudioStateError('INVALID_ORDER', `${label} must contain 1 to ${MAX_ORDER_ITEMS} items.`);
    }
    order.items.forEach((item, itemIndex) => validateOrderItem(item, index, itemIndex));
    const total = order.items.reduce((sum, item) => sum + item.quantity * item.priceCents, 0);
    if (!Number.isSafeInteger(total) || order.totalCents !== total) {
      throw new StudioStateError('INVALID_ORDER_TOTAL', `${label}.totalCents does not match its items.`);
    }
    return order;
  }

  function validateMessage(value, index) {
    const label = `messages[${index}]`;
    const message = exactKeys(value, ['id', 'createdAt', 'updatedAt', 'kind', 'title', 'body', 'status'], label);
    if (!ID.test(message.id)) throw new StudioStateError('INVALID_ID', `${label}.id is invalid.`);
    integer(message.createdAt, `${label}.createdAt`, 0, Number.MAX_SAFE_INTEGER);
    integer(message.updatedAt, `${label}.updatedAt`, message.createdAt, Number.MAX_SAFE_INTEGER);
    oneOf(message.kind, MESSAGE_KINDS, `${label}.kind`);
    string(message.title, `${label}.title`, 160);
    string(message.body, `${label}.body`, 4000);
    oneOf(message.status, MESSAGE_STATUSES, `${label}.status`);
    return message;
  }

  function uniqueIds(items, label) {
    const ids = new Set();
    for (const item of items) {
      if (ids.has(item.id)) throw new StudioStateError('DUPLICATE_ID', `${label} contains duplicate IDs.`);
      ids.add(item.id);
    }
  }

  function validateEnvelope(value) {
    const keys = ['schemaVersion', 'active', 'draft', 'versions', 'undo', 'redo', 'orders', 'messages',
      'revision', 'updatedAt', 'writerId'];
    const envelope = exactKeys(value, keys, 'studio state');
    if (envelope.schemaVersion !== SCHEMA_VERSION) throw new StudioStateError('UNSUPPORTED_SCHEMA', 'This studio data uses an unsupported schema.');
    boolean(envelope.active, 'active');
    validateDraft(envelope.draft);
    if (!Array.isArray(envelope.versions) || envelope.versions.length > MAX_VERSIONS) {
      throw new StudioStateError('TOO_MANY_VERSIONS', `At most ${MAX_VERSIONS} saved versions are supported.`);
    }
    envelope.versions.forEach(validateVersion);
    uniqueIds(envelope.versions, 'versions');
    if (!Array.isArray(envelope.undo) || envelope.undo.length > MAX_UNDO
      || !Array.isArray(envelope.redo) || envelope.redo.length > MAX_UNDO) {
      throw new StudioStateError('INVALID_HISTORY', 'Undo or redo history is invalid.');
    }
    envelope.undo.forEach(validateDraft);
    envelope.redo.forEach(validateDraft);
    if (!Array.isArray(envelope.orders) || envelope.orders.length > MAX_ORDERS) {
      throw new StudioStateError('TOO_MANY_ORDERS', `At most ${MAX_ORDERS} practice orders are supported.`);
    }
    envelope.orders.forEach(validateOrder);
    uniqueIds(envelope.orders, 'orders');
    if (!Array.isArray(envelope.messages) || envelope.messages.length > MAX_MESSAGES) {
      throw new StudioStateError('TOO_MANY_MESSAGES', `At most ${MAX_MESSAGES} practice messages are supported.`);
    }
    envelope.messages.forEach(validateMessage);
    uniqueIds(envelope.messages, 'messages');
    integer(envelope.revision, 'revision', 0, Number.MAX_SAFE_INTEGER);
    integer(envelope.updatedAt, 'updatedAt', 0, Number.MAX_SAFE_INTEGER);
    if (!ID.test(envelope.writerId)) throw new StudioStateError('INVALID_ID', 'writerId is invalid.');
    return envelope;
  }

  function byteLength(value) {
    if (typeof root.TextEncoder === 'function') return new root.TextEncoder().encode(value).length;
    return unescape(encodeURIComponent(value)).length;
  }

  function serialized(value) {
    const json = JSON.stringify(value);
    if (byteLength(json) > MAX_STATE_BYTES) {
      throw new StudioStateError('STATE_TOO_LARGE', 'The owner studio is too large. Remove images or older versions and try again.');
    }
    return json;
  }

  function storage() {
    try {
      return root.localStorage || null;
    } catch {
      return null;
    }
  }

  function makeId(prefix) {
    let random = '';
    try {
      random = root.crypto?.randomUUID?.().replaceAll('-', '') || '';
    } catch {}
    if (!random) random = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return `${prefix}_${random}`.slice(0, 80);
  }

  const writerId = makeId('writer');
  function freshState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      active: false,
      draft: clone(DEFAULT_DRAFT),
      versions: [],
      undo: [],
      redo: [],
      orders: [],
      messages: [],
      revision: 0,
      updatedAt: Date.now(),
      writerId
    };
  }

  const targetStorage = storage();
  const status = {
    storageAvailable: Boolean(targetStorage),
    persisted: Boolean(targetStorage),
    error: null,
    conflict: false
  };
  let dirtyFallback = false;
  let state = freshState();

  function parseStored(raw) {
    if (typeof raw !== 'string' || byteLength(raw) > MAX_STATE_BYTES) {
      throw new StudioStateError('STATE_TOO_LARGE', 'Stored studio data is invalid or too large.');
    }
    const value = JSON.parse(raw);
    validateEnvelope(value);
    serialized(value);
    return clone(value);
  }

  if (targetStorage) {
    try {
      const raw = targetStorage.getItem(STORAGE_KEY);
      if (raw) state = parseStored(raw);
    } catch {
      status.persisted = false;
      status.error = 'INVALID_STORED_STATE';
    }
  } else {
    status.persisted = false;
    status.error = 'STORAGE_UNAVAILABLE';
  }

  function read() {
    return clone(state);
  }

  function getStatus() {
    return Object.freeze({
      storageAvailable: status.storageAvailable,
      persisted: status.persisted,
      error: status.error,
      conflict: status.conflict,
      revision: state.revision,
      canUndo: state.undo.length > 0,
      canRedo: state.redo.length > 0,
      versions: state.versions.length,
      orders: state.orders.length,
      messages: state.messages.length
    });
  }

  function notify(reason) {
    const detail = Object.freeze({
      reason,
      revision: state.revision,
      persisted: status.persisted,
      conflict: status.conflict
    });
    for (const listener of subscribers) {
      try { listener(read(), getStatus(), reason); } catch {}
    }
    if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
      try { root.dispatchEvent(new root.CustomEvent('kigb-studio-change', { detail })); } catch {}
    }
  }

  function externalState() {
    if (!targetStorage) return null;
    try {
      const raw = targetStorage.getItem(STORAGE_KEY);
      return raw ? parseStored(raw) : null;
    } catch {
      return null;
    }
  }

  function ensureNoNewerExternal() {
    const external = externalState();
    if (!external || external.writerId === writerId) return;
    if (external.revision > state.revision
      || (dirtyFallback && external.revision === state.revision
        && external.writerId !== state.writerId
        && JSON.stringify(external) !== JSON.stringify(state))) {
      status.conflict = true;
      status.error = 'STATE_CONFLICT';
      notify('conflict');
      throw new StudioStateError('STATE_CONFLICT', 'A newer owner-studio change exists in another tab. Reload that version before editing.');
    }
  }

  function commit(next, reason) {
    ensureNoNewerExternal();
    validateEnvelope(next);
    const json = serialized(next);
    state = clone(next);
    if (!targetStorage) {
      status.persisted = false;
      status.error = 'STORAGE_UNAVAILABLE';
      dirtyFallback = true;
      notify(reason);
      return read();
    }
    try {
      targetStorage.setItem(STORAGE_KEY, json);
      status.persisted = true;
      status.error = null;
      status.conflict = false;
      dirtyFallback = false;
    } catch {
      status.persisted = false;
      status.error = 'STORAGE_UNAVAILABLE';
      dirtyFallback = true;
    }
    notify(reason);
    return read();
  }

  function nextState(changes) {
    return {
      ...state,
      ...changes,
      schemaVersion: SCHEMA_VERSION,
      revision: state.revision + 1,
      updatedAt: Date.now(),
      writerId
    };
  }

  function draftPatch(current, patch) {
    const input = exactKeys(patch, ['design', 'content', 'products', 'customProducts'], 'draft patch', []);
    const next = clone(current);
    if ('design' in input) {
      const allowed = Object.keys(DEFAULT_DRAFT.design);
      const change = exactKeys(input.design, allowed, 'draft patch.design', []);
      next.design = { ...next.design, ...clone(change) };
    }
    if ('content' in input) {
      const allowed = Object.keys(DEFAULT_DRAFT.content);
      const change = exactKeys(input.content, allowed, 'draft patch.content', []);
      next.content = { ...next.content, ...clone(change) };
    }
    if ('products' in input) {
      const changes = plainObject(input.products, 'draft patch.products');
      next.products = clone(next.products);
      for (const [handle, change] of Object.entries(changes)) {
        if (!HANDLE.test(handle)) throw new StudioStateError('INVALID_HANDLE', `Invalid product handle ${handle}.`);
        if (change === null) {
          delete next.products[handle];
          continue;
        }
        const patchKeys = ['title', 'priceCents', 'available', 'dimensionsRaw', 'imageUrl', 'hidden'];
        const fields = exactKeys(change, patchKeys, `draft patch.products.${handle}`, []);
        const merged = { ...(next.products[handle] || {}) };
        for (const [key, value] of Object.entries(fields)) {
          if (value === null) delete merged[key];
          else if (value === undefined) throw new StudioStateError('INVALID_STATE', `draft patch.products.${handle}.${key} is invalid.`);
          else merged[key] = value;
        }
        if (Object.keys(merged).length) next.products[handle] = merged;
        else delete next.products[handle];
      }
    }
    if ('customProducts' in input) {
      if (!Array.isArray(input.customProducts)) {
        throw new StudioStateError('INVALID_STATE', 'draft patch.customProducts must be an array.');
      }
      next.customProducts = clone(input.customProducts);
    }
    validateDraft(next);
    return next;
  }

  function updateDraft(patch) {
    const draft = draftPatch(state.draft, patch);
    if (JSON.stringify(draft) === JSON.stringify(state.draft)) return read();
    const undo = [...state.undo, clone(state.draft)].slice(-MAX_UNDO);
    return commit(nextState({ draft, undo, redo: [] }), 'draft');
  }

  function setActive(active) {
    boolean(active, 'active');
    if (state.active === active) return read();
    return commit(nextState({ active }), 'active');
  }

  function undo() {
    if (!state.undo.length) return read();
    const history = state.undo.slice();
    const draft = history.pop();
    const redo = [...state.redo, clone(state.draft)].slice(-MAX_UNDO);
    return commit(nextState({ draft, undo: history, redo }), 'undo');
  }

  function redo() {
    if (!state.redo.length) return read();
    const future = state.redo.slice();
    const draft = future.pop();
    const undoHistory = [...state.undo, clone(state.draft)].slice(-MAX_UNDO);
    return commit(nextState({ draft, undo: undoHistory, redo: future }), 'redo');
  }

  function saveVersion(name) {
    const clean = string(name, 'version name', 80).trim();
    const version = { id: makeId('version'), name: clean, createdAt: Date.now(), draft: clone(state.draft) };
    const versions = [...state.versions, version].slice(-MAX_VERSIONS);
    return commit(nextState({ versions }), 'version-saved');
  }

  function restoreVersion(id) {
    const version = state.versions.find((entry) => entry.id === id);
    if (!version) throw new StudioStateError('VERSION_NOT_FOUND', 'That saved version no longer exists.');
    const undoHistory = [...state.undo, clone(state.draft)].slice(-MAX_UNDO);
    return commit(nextState({ draft: clone(version.draft), undo: undoHistory, redo: [] }), 'version-restored');
  }

  function deleteVersion(id) {
    const versions = state.versions.filter((entry) => entry.id !== id);
    if (versions.length === state.versions.length) throw new StudioStateError('VERSION_NOT_FOUND', 'That saved version no longer exists.');
    return commit(nextState({ versions }), 'version-deleted');
  }

  function resetDraft() {
    const draft = clone(DEFAULT_DRAFT);
    if (JSON.stringify(draft) === JSON.stringify(state.draft)) return read();
    const undoHistory = [...state.undo, clone(state.draft)].slice(-MAX_UNDO);
    return commit(nextState({ draft, undo: undoHistory, redo: [] }), 'draft-reset');
  }

  function validateBackup(value) {
    const backup = exactKeys(value, ['kind', 'backupVersion', 'exportedAt', 'studio'], 'backup');
    if (backup.kind !== BACKUP_KIND || backup.backupVersion !== 1) {
      throw new StudioStateError('UNSUPPORTED_BACKUP', 'This is not a supported Kiss It Good Buy owner-studio backup.');
    }
    integer(backup.exportedAt, 'backup.exportedAt', 0, Number.MAX_SAFE_INTEGER);
    const studio = exactKeys(backup.studio, ['schemaVersion', 'active', 'draft', 'versions', 'orders', 'messages'], 'backup.studio');
    if (studio.schemaVersion !== SCHEMA_VERSION) throw new StudioStateError('UNSUPPORTED_SCHEMA', 'This backup uses an unsupported schema.');
    boolean(studio.active, 'backup.studio.active');
    validateDraft(studio.draft);
    if (!Array.isArray(studio.versions) || studio.versions.length > MAX_VERSIONS) throw new StudioStateError('TOO_MANY_VERSIONS', 'The backup has too many versions.');
    studio.versions.forEach(validateVersion);
    uniqueIds(studio.versions, 'backup.studio.versions');
    if (!Array.isArray(studio.orders) || studio.orders.length > MAX_ORDERS) throw new StudioStateError('TOO_MANY_ORDERS', 'The backup has too many practice orders.');
    studio.orders.forEach(validateOrder);
    uniqueIds(studio.orders, 'backup.studio.orders');
    if (!Array.isArray(studio.messages) || studio.messages.length > MAX_MESSAGES) throw new StudioStateError('TOO_MANY_MESSAGES', 'The backup has too many practice messages.');
    studio.messages.forEach(validateMessage);
    uniqueIds(studio.messages, 'backup.studio.messages');
    return backup;
  }

  function exportBackup() {
    const backup = {
      kind: BACKUP_KIND,
      backupVersion: 1,
      exportedAt: Date.now(),
      studio: {
        schemaVersion: SCHEMA_VERSION,
        active: state.active,
        draft: clone(state.draft),
        versions: clone(state.versions),
        orders: clone(state.orders),
        messages: clone(state.messages)
      }
    };
    validateBackup(backup);
    return serialized(backup);
  }

  function importBackup(json) {
    if (typeof json !== 'string') throw new StudioStateError('INVALID_BACKUP', 'Choose a JSON backup file to import.');
    if (byteLength(json) > MAX_STATE_BYTES) throw new StudioStateError('STATE_TOO_LARGE', 'The backup is larger than 4 MB.');
    let backup;
    try {
      backup = JSON.parse(json);
    } catch {
      throw new StudioStateError('INVALID_BACKUP', 'The backup is not valid JSON.');
    }
    validateBackup(backup);
    const undoHistory = [...state.undo, clone(state.draft)].slice(-MAX_UNDO);
    return commit(nextState({
      active: backup.studio.active,
      draft: clone(backup.studio.draft),
      versions: clone(backup.studio.versions),
      orders: clone(backup.studio.orders),
      messages: clone(backup.studio.messages),
      undo: undoHistory,
      redo: []
    }), 'backup-imported');
  }

  function normalizedOrderItems(items) {
    if (!Array.isArray(items) || !items.length || items.length > MAX_ORDER_ITEMS) {
      throw new StudioStateError('INVALID_ORDER', `A practice order must contain 1 to ${MAX_ORDER_ITEMS} items.`);
    }
    return items.map((item, index) => {
      const label = `practice order item ${index + 1}`;
      const keys = ['variantId', 'productHandle', 'productTitle', 'quantity', 'priceCents', 'currencyCode', 'imageUrl'];
      const input = exactKeys(item, keys, label);
      const normalized = {
        variantId: input.variantId,
        productHandle: input.productHandle,
        productTitle: input.productTitle,
        quantity: input.quantity,
        priceCents: input.priceCents,
        currencyCode: input.currencyCode,
        imageUrl: input.imageUrl
      };
      validateOrderItem(normalized, 0, index);
      return normalized;
    });
  }

  function createOrder(items) {
    const normalized = normalizedOrderItems(items);
    const now = Date.now();
    const totalCents = normalized.reduce((sum, item) => sum + item.quantity * item.priceCents, 0);
    if (!Number.isSafeInteger(totalCents)) throw new StudioStateError('INVALID_ORDER_TOTAL', 'Practice-order total is too large.');
    const order = {
      id: makeId('order'),
      createdAt: now,
      updatedAt: now,
      status: 'placed',
      items: normalized,
      totalCents
    };
    const orders = [...state.orders, order].slice(-MAX_ORDERS);
    commit(nextState({ orders }), 'order-created');
    return clone(order);
  }

  function updateOrderStatus(id, nextStatus) {
    oneOf(nextStatus, ORDER_STATUSES, 'order status');
    const index = state.orders.findIndex((order) => order.id === id);
    if (index < 0) throw new StudioStateError('ORDER_NOT_FOUND', 'That practice order no longer exists.');
    if (state.orders[index].status === nextStatus) return clone(state.orders[index]);
    const orders = clone(state.orders);
    orders[index] = { ...orders[index], status: nextStatus, updatedAt: Date.now() };
    commit(nextState({ orders }), 'order-status');
    return clone(orders[index]);
  }

  function clearOrders() {
    if (!state.orders.length) return read();
    return commit(nextState({ orders: [] }), 'orders-cleared');
  }

  function createMessage(value) {
    const input = exactKeys(value, ['kind', 'title', 'body'], 'practice message');
    oneOf(input.kind, MESSAGE_KINDS, 'practice message.kind');
    const title = string(input.title, 'practice message.title', 160).trim();
    const body = string(input.body, 'practice message.body', 4000);
    const now = Date.now();
    const message = {
      id: makeId('message'),
      createdAt: now,
      updatedAt: now,
      kind: input.kind,
      title,
      body,
      status: 'new'
    };
    const messages = [...state.messages, message].slice(-MAX_MESSAGES);
    commit(nextState({ messages }), 'message-created');
    return clone(message);
  }

  function updateMessageStatus(id, nextStatus) {
    oneOf(nextStatus, MESSAGE_STATUSES, 'message status');
    const index = state.messages.findIndex((message) => message.id === id);
    if (index < 0) throw new StudioStateError('MESSAGE_NOT_FOUND', 'That practice message no longer exists.');
    if (state.messages[index].status === nextStatus) return clone(state.messages[index]);
    const messages = clone(state.messages);
    messages[index] = { ...messages[index], status: nextStatus, updatedAt: Date.now() };
    commit(nextState({ messages }), 'message-status');
    return clone(messages[index]);
  }

  function clearMessages() {
    if (!state.messages.length) return read();
    return commit(nextState({ messages: [] }), 'messages-cleared');
  }

  function defaults() {
    return clone(DEFAULT_DRAFT);
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new StudioStateError('INVALID_LISTENER', 'A studio listener must be a function.');
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  }

  if (typeof root.addEventListener === 'function') {
    root.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY || (event.storageArea && event.storageArea !== targetStorage)) return;
      if (!event.newValue) {
        status.conflict = true;
        status.error = 'EXTERNAL_RESET';
        notify('conflict');
        return;
      }
      let incoming;
      try {
        incoming = parseStored(event.newValue);
      } catch {
        status.conflict = true;
        status.error = 'INVALID_EXTERNAL_STATE';
        notify('conflict');
        return;
      }
      if (dirtyFallback) {
        status.conflict = true;
        status.error = 'STATE_CONFLICT';
        notify('conflict');
        return;
      }
      if (incoming.revision > state.revision) {
        state = incoming;
        status.persisted = true;
        status.error = null;
        status.conflict = false;
        notify('external-update');
      } else if (incoming.revision === state.revision && incoming.writerId !== state.writerId
        && JSON.stringify(incoming) !== JSON.stringify(state)) {
        status.conflict = true;
        status.error = 'STATE_CONFLICT';
        notify('conflict');
      }
    });
  }

  return Object.freeze({
    SCHEMA_VERSION,
    STORAGE_KEY,
    ORDER_STATUSES,
    MESSAGE_KINDS,
    MESSAGE_STATUSES,
    MAX_STATE_BYTES,
    MAX_IMAGE_BYTES,
    MAX_EMBEDDED_IMAGES,
    StudioStateError,
    defaults,
    read,
    updateDraft,
    setActive,
    undo,
    redo,
    saveVersion,
    restoreVersion,
    deleteVersion,
    resetDraft,
    exportBackup,
    importBackup,
    createOrder,
    updateOrderStatus,
    clearOrders,
    createMessage,
    updateMessageStatus,
    clearMessages,
    getStatus,
    subscribe
  });
});
