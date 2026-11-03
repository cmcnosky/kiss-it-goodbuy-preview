(function attachKigbCatalog(root) {
  'use strict';

  const STORE_URL = 'https://kissitgoodbuy.net';
  const ALLOWED_TAGS = new Set(['p', 'br', 'ul', 'ol', 'li', 'b', 'strong', 'em', 'i']);
  const BLOCKED_CONTENT = /<(script|style|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

  function stringValue(value) {
    return value == null ? '' : String(value);
  }

  function shopifyId(value, label) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError(`${label} is outside JavaScript's safe integer range.`);
    const id = stringValue(value).trim();
    if (!/^\d+$/.test(id)) throw new TypeError(`${label} must be a decimal Shopify id.`);
    return id;
  }

  function sanitizeSourceHtml(html) {
    return stringValue(html)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(BLOCKED_CONTENT, '')
      .replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (tag, rawName) => {
        const name = rawName.toLowerCase();
        if (!ALLOWED_TAGS.has(name)) return '';
        if (name === 'br') return '<br>';
        return tag.startsWith('</') ? `</${name}>` : `<${name}>`;
      })
      .trim();
  }

  function decodeEntities(text) {
    const named = {
      amp: '&', apos: "'", copy: '©', gt: '>', hellip: '…', laquo: '«',
      ldquo: '“', lsquo: '‘', lt: '<', mdash: '—', middot: '·', nbsp: ' ',
      ndash: '–', quot: '"', raquo: '»', rdquo: '”', reg: '®', rsquo: '’',
      trade: '™'
    };
    return stringValue(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
      if (code[0] !== '#') return Object.prototype.hasOwnProperty.call(named, code.toLowerCase()) ? named[code.toLowerCase()] : entity;
      const numeric = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(numeric) || numeric < 0 || numeric > 0x10ffff) return entity;
      try { return String.fromCodePoint(numeric); } catch { return entity; }
    });
  }

  function plainHtmlText(html) {
    return decodeEntities(
      sanitizeSourceHtml(html)
        .replace(/<br>/gi, '\n')
        .replace(/<\/(?:p|li|ul|ol)>/gi, '\n')
        .replace(/<li>/gi, '• ')
        .replace(/<[^>]+>/g, '')
    )
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function extractLabeledValue(text, label) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = stringValue(text).match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:?\\s*(?:\\n\\s*)?([^\\n]+)`, 'i'));
    if (!match) return null;
    const value = match[1].trim().replace(/^=\s*/, '').trim();
    return value && !/^(?:Item Number|Item ID|Category|Brand)\s*:?$/i.test(value) ? value : null;
  }

  function extractDimensions(title) {
    const source = stringValue(title);
    const number = '(?:\\d+\\s+\\d+\\/\\d+|\\d+(?:\\.\\d+)?(?:\\/\\d+(?:\\.\\d+)?)?)';
    const label = '(?:Dia\\.?(?=$|[^A-Za-z]|[xX])|[WHDL](?=$|[^A-Za-z]|[xX]))';
    const token = `${number}\\s*(?:\"|″|'|in\\b)?\\s*${label}?`;
    const sequence = new RegExp(`\\b${token}(?:\\s*[xX×]\\s*${token}){1,3}`, 'gi');
    const slashSeries = new RegExp(`\\b${number}\\s*(?:\"|″)(?:\\s*\\/\\s*${number}\\s*(?:\"|″)){1,3}`, 'gi');
    const standalone = new RegExp(`\\b${number}(?:(?:\\s*(?:\"|″|')\\s*${label}?)|${label})`, 'gi');
    const candidates = [];
    for (const { pattern, slashDelimited } of [
      { pattern: sequence, slashDelimited: false },
      { pattern: slashSeries, slashDelimited: true },
      { pattern: standalone, slashDelimited: false }
    ]) {
      for (const match of source.matchAll(pattern)) {
        const raw = match[0].trim();
        const dimensionTokens = raw.split(slashDelimited ? /\s*\/\s*/ : /\s*[xX×]\s*/);
        const labeled = dimensionTokens.filter(part => /(?:Dia\.?|W|H|D|L)\s*$/i.test(part)).length;
        const quoted = dimensionTokens.filter(part => /[\"″]|\bin\b/i.test(part)).length;
        candidates.push({
          raw,
          index: match.index || 0,
          score: dimensionTokens.length * 20 + labeled * 8 + quoted * 3 + raw.length / 100,
          labelStatus: labeled === 0 ? 'unlabeled' : labeled === dimensionTokens.length ? 'labeled' : 'partially-labeled'
        });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score || b.index - a.index);
    const winner = candidates[0];
    return { raw: winner.raw, labelStatus: winner.labelStatus, source: 'title' };
  }

  function moneyToCents(value) {
    if (value == null || value === '') return null;
    const cleaned = stringValue(value).trim().replace(/^\$/, '').replace(/,/g, '');
    const exact = cleaned.match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (exact) return Number(exact[1]) * 100 + Number((exact[2] || '').padEnd(2, '0'));
    const numeric = Number(cleaned);
    return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric * 100) : null;
  }

  function centsToNumber(cents) {
    return cents == null ? null : cents / 100;
  }

  function httpsUrl(value) {
    const raw = stringValue(value).trim();
    if (!raw) return null;
    const candidate = raw.startsWith('//') ? `https:${raw}` : raw.startsWith('http://') ? `https://${raw.slice(7)}` : raw;
    if (/[\s"'<>`]/.test(candidate)) return null;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null;
      return parsed.href;
    } catch {
      return null;
    }
  }

  function normalizeImage(image, position) {
    if (!image) return null;
    if (typeof image === 'string') {
      const src = httpsUrl(image);
      return src ? { id: null, src, alt: null, width: null, height: null, position } : null;
    }
    const src = httpsUrl(image.src || image.url);
    if (!src) return null;
    return {
      id: image.id == null ? null : shopifyId(image.id, 'Image id'),
      src,
      alt: image.alt == null ? null : stringValue(image.alt),
      width: Number.isFinite(Number(image.width)) ? Number(image.width) : null,
      height: Number.isFinite(Number(image.height)) ? Number(image.height) : null,
      position: Number.isFinite(Number(image.position)) ? Number(image.position) : position
    };
  }

  function normalizeProduct(raw, options) {
    if (!raw || raw.id == null || !stringValue(raw.handle).trim() || !stringValue(raw.title).trim()) {
      throw new TypeError('Each product requires id, handle, and title.');
    }
    const productOptions = Array.isArray(raw.options) ? raw.options.map((option, index) => ({
      name: stringValue(option.name).trim() || `Option ${index + 1}`,
      position: Number.isFinite(Number(option.position)) ? Number(option.position) : index + 1,
      values: Array.isArray(option.values) ? option.values.map(stringValue) : []
    })) : [];
    const images = (Array.isArray(raw.images) ? raw.images : [])
      .map((image, index) => normalizeImage(image, index + 1))
      .filter(Boolean);
    const variants = (Array.isArray(raw.variants) ? raw.variants : []).map((variant, index) => {
      const priceCents = moneyToCents(variant.price);
      const compareAtPriceCents = moneyToCents(variant.compare_at_price ?? variant.compareAtPrice);
      const optionValues = [variant.option1, variant.option2, variant.option3];
      return {
        id: shopifyId(variant.id, `Variant id for ${raw.handle}`),
        title: stringValue(variant.title).trim() || 'Default Title',
        available: Boolean(variant.available),
        price: centsToNumber(priceCents),
        priceCents,
        compareAtPrice: centsToNumber(compareAtPriceCents),
        compareAtPriceCents,
        sku: stringValue(variant.sku).trim(),
        position: Number.isFinite(Number(variant.position)) ? Number(variant.position) : index + 1,
        options: productOptions.map((option, optionIndex) => ({ name: option.name, value: optionValues[optionIndex] == null ? null : stringValue(optionValues[optionIndex]) })),
        image: normalizeImage(variant.featured_image, null)
      };
    });
    if (!variants.length || variants.some(variant => !/^\d+$/.test(variant.id) || variant.priceCents == null)) {
      throw new TypeError(`Product ${raw.handle} must have variants with valid numeric ids and prices.`);
    }
    const availableVariants = variants.filter(variant => variant.available);
    const pricePool = availableVariants.length ? availableVariants : variants;
    const prices = pricePool.map(variant => variant.priceCents);
    const primary = pricePool.slice().sort((a, b) => a.priceCents - b.priceCents || a.position - b.position)[0];
    const bodyText = plainHtmlText(raw.body_html ?? raw.sourceHtml ?? '');
    const dimensions = extractDimensions(raw.title);
    const collectionHandles = Array.isArray(options?.collectionHandles) ? options.collectionHandles : [];
    return {
      id: shopifyId(raw.id, `Product id for ${raw.handle}`),
      title: stringValue(raw.title).trim(),
      handle: stringValue(raw.handle).trim(),
      productUrl: `${STORE_URL}/products/${encodeURIComponent(stringValue(raw.handle).trim())}`,
      description: bodyText,
      sourceHtml: sanitizeSourceHtml(raw.body_html ?? raw.sourceHtml ?? ''),
      sourceProductType: stringValue(raw.product_type ?? raw.sourceProductType).trim(),
      vendor: stringValue(raw.vendor).trim(),
      tags: Array.isArray(raw.tags) ? raw.tags.map(stringValue) : [],
      itemNumber: extractLabeledValue(bodyText, 'Item Number'),
      itemId: extractLabeledValue(bodyText, 'Item ID'),
      sourceCategory: extractLabeledValue(bodyText, 'Category'),
      dimensionsRaw: dimensions?.raw || null,
      dimensions,
      createdAt: raw.created_at ?? raw.createdAt ?? null,
      updatedAt: raw.updated_at ?? raw.updatedAt ?? null,
      publishedAt: raw.published_at ?? raw.publishedAt ?? null,
      available: availableVariants.length > 0,
      price: primary.price,
      minPrice: centsToNumber(Math.min(...prices)),
      maxPrice: centsToNumber(Math.max(...prices)),
      compareAtPrice: primary.compareAtPrice,
      variants,
      images,
      options: productOptions,
      collections: [...new Set(collectionHandles.map(stringValue).filter(Boolean))].sort()
    };
  }

  function normalizeProducts(rawProducts, options) {
    if (!Array.isArray(rawProducts)) throw new TypeError('normalizeProducts expects an array.');
    const memberships = options?.memberships || {};
    return rawProducts.map(raw => normalizeProduct(raw, { collectionHandles: memberships[String(raw.id)] || memberships[raw.id] || [] }));
  }

  const api = Object.freeze({
    STORE_URL,
    sanitizeSourceHtml,
    plainHtmlText,
    extractDimensions,
    moneyToCents,
    normalizeProduct,
    normalizeProducts
  });
  root.KIGBCatalog = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
