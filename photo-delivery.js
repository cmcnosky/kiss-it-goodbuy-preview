(function attachPhotoDelivery(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KIGBPhotos = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createPhotoDelivery(root) {
  'use strict';

  const DEFAULT_WIDTHS = [96, 160, 240, 320, 480, 640, 800, 1000, 1200, 1400, 1600, 1800, 2100];

  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  // Keep the recorded cover as a guard so the shop can replace or reorder its own photos.
  const pairCovers = new Map([
    ['15547463827693', ['52217734922477', '52217734988013']], // Juliana rattan chairs
    ['15453233512685', ['52049330012397', '52049330077933']], // Shiloh barrel chairs
    ['15424634519789', ['51187188596973', '51187188629741']], // Barclay Butera club chairs
    ['9129466626285', ['45174349529325', '45174349562093']]    // Decorated fronts of both flow-blue vases
  ]);

  function gallery(product) {
    const images = product?.images || [];
    const pair = pairCovers.get(String(product?.id));
    if (!pair || String(images[0]?.id) !== pair[0]) return images;
    const lead = images.find(image => String(image.id) === pair[1]);
    return lead ? [lead, ...images.filter(image => image !== lead)] : images;
  }

  function normalizedImage(image) {
    if (typeof image === 'string') return { src: image, width: null, height: null };
    return {
      src: String(image?.src || ''),
      width: Number.isFinite(Number(image?.width)) && Number(image.width) > 0 ? Math.round(Number(image.width)) : null,
      height: Number.isFinite(Number(image?.height)) && Number(image.height) > 0 ? Math.round(Number(image.height)) : null
    };
  }

  function isShopifyImage(source) {
    try {
      const url = new URL(source);
      return url.protocol === 'https:' && (url.hostname === 'cdn.shopify.com' || url.hostname.endsWith('.shopifycdn.com'));
    } catch {
      return false;
    }
  }

  function photoKey(source) {
    try {
      const parsed = new URL(source);
      const prefix = '/s/files/1/0289/5239/5911/';
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'cdn.shopify.com' || !parsed.pathname.startsWith(prefix)) return '';
      return parsed.pathname.slice(prefix.length) + '?' + (parsed.searchParams.get('v') || '');
    } catch {
      return '';
    }
  }

  function sharpenedSources(imageValue) {
    const image = normalizedImage(imageValue);
    const entry = root.KIGBPhotoSharpness?.photos?.[photoKey(image.src)];
    if (!Array.isArray(entry)) return [];
    return entry
      .filter(source => Array.isArray(source) && source.length === 3 && Number(source[0]) > 0 && Number(source[1]) > 0 && typeof source[2] === 'string')
      .map(source => ({ width: Number(source[0]), height: Number(source[1]), src: source[2] }))
      .sort((left, right) => left.width - right.width);
  }

  function url(source, requestedWidth, nativeWidth) {
    const src = String(source || '');
    if (!isShopifyImage(src)) return src;
    const asked = Math.max(1, Math.round(Number(requestedWidth) || 0));
    const cap = Number.isFinite(Number(nativeWidth)) && Number(nativeWidth) > 0 ? Math.round(Number(nativeWidth)) : null;
    const width = cap ? Math.min(asked, cap) : asked;
    const result = new URL(src);
    result.searchParams.set('width', String(width));
    return result.href;
  }

  function candidateWidths(image, requested = DEFAULT_WIDTHS) {
    const normalized = normalizedImage(image);
    if (!isShopifyImage(normalized.src)) return [];
    const values = [...requested].map(Number).filter(value => Number.isFinite(value) && value > 0);
    if (normalized.width) values.push(normalized.width);
    return [...new Set(values.map(value => Math.round(normalized.width ? Math.min(value, normalized.width) : value)))]
      .filter(Boolean)
      .sort((left, right) => left - right);
  }

  function srcset(image, requestedWidths = DEFAULT_WIDTHS) {
    const normalized = normalizedImage(image);
    return candidateWidths(normalized, requestedWidths)
      .map(width => `${url(normalized.src, width, normalized.width)} ${width}w`)
      .join(', ');
  }

  function descriptor(imageValue, options = {}) {
    const image = normalizedImage(imageValue);
    if (options.original) return { src: image.src, srcset: '', sizes: '', tone: '', originalSrc: '' };
    const widths = Array.isArray(options.widths) && options.widths.length ? options.widths : DEFAULT_WIDTHS;
    const desiredWidth = Number(options.sourceWidth || options.width || widths.at(-1) || image.width || 1200);
    const tone = options.tone === false ? '' : root.KIGBPhotoTones?.profile?.(image.src) || '';
    const sharpened = sharpenedSources(image);
    if (sharpened.length) {
      const selected = sharpened.find(source => source.width >= desiredWidth) || sharpened.at(-1);
      return {
        src: selected.src,
        srcset: sharpened.map(source => `${source.src} ${source.width}w`).join(', '),
        sizes: String(options.sizes || ''),
        tone,
        originalSrc: image.src
      };
    }
    const candidates = srcset(image, widths);
    return {
      src: url(image.src, desiredWidth, image.width),
      srcset: candidates,
      sizes: candidates ? String(options.sizes || '') : '',
      tone,
      originalSrc: ''
    };
  }

  function share(imageValue) {
    const image = normalizedImage(imageValue);
    const sharpened = sharpenedSources(image);
    if (sharpened.length) {
      const largest = sharpened.at(-1);
      return { src: largest.src, width: largest.width, height: largest.height, type: 'image/jpeg' };
    }
    let type = '';
    try {
      type = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[
        new URL(image.src).pathname.split('.').pop().toLowerCase()
      ] || '';
    } catch {}
    return { src: image.src, width: image.width, height: image.height, type };
  }

  function image(imageValue, options = {}) {
    const image = normalizedImage(imageValue);
    if (!image.src) return '';
    const source = descriptor(image, options);
    const attributes = [];
    attributes.push(`src="${escape(source.src)}"`);
    if (source.srcset) attributes.push(`srcset="${escape(source.srcset)}"`);
    if (source.sizes) attributes.push(`sizes="${escape(source.sizes)}"`);
    if (options.id) attributes.push(`id="${escape(options.id)}"`);
    if (options.className) attributes.push(`class="${escape(options.className)}"`);
    attributes.push(`alt="${escape(options.alt || '')}"`);
    if (options.width) attributes.push(`width="${Math.max(1, Math.round(Number(options.width)))}"`);
    if (options.height) attributes.push(`height="${Math.max(1, Math.round(Number(options.height)))}"`);
    if (options.loading) attributes.push(`loading="${options.loading === 'eager' ? 'eager' : 'lazy'}"`);
    if (options.fetchpriority === 'high' || options.fetchpriority === 'low') attributes.push(`fetchpriority="${options.fetchpriority}"`);
    if (options.decoding !== false) attributes.push('decoding="async"');
    if (source.tone) attributes.push(`data-photo-tone="${escape(source.tone)}"`);
    if (source.originalSrc) attributes.push(`data-photo-original="${escape(source.originalSrc)}"`);
    return `<img ${attributes.join(' ')}>`;
  }

  function apply(element, imageValue, options = {}) {
    if (!element) return false;
    const source = descriptor(imageValue, options);
    if (!source.src) return false;
    if (source.originalSrc) element.dataset.photoOriginal = source.originalSrc;
    else delete element.dataset.photoOriginal;
    delete element.dataset.photoFallback;
    if (source.tone) element.dataset.photoTone = source.tone;
    else delete element.dataset.photoTone;
    if (options.alt !== undefined) element.alt = String(options.alt);
    if (source.srcset) element.srcset = source.srcset;
    else element.removeAttribute('srcset');
    if (source.sizes) element.sizes = source.sizes;
    else element.removeAttribute('sizes');
    // Assign src last so an angle switch has its own original ready even if the
    // derivative fails immediately from an old page or an interrupted deploy.
    element.src = source.src;
    return true;
  }

  function installFallback() {
    if (typeof root.addEventListener !== 'function' || root.__kigbPhotoFallbackInstalled) return;
    root.__kigbPhotoFallbackInstalled = true;
    const restoreOriginal = element => {
      const original = element?.dataset?.photoOriginal;
      if (!original || element.dataset.photoFallback === 'true') return false;
      element.dataset.photoFallback = 'true';
      element.removeAttribute('srcset');
      element.removeAttribute('sizes');
      element.src = original;
      return true;
    };
    root.addEventListener('error', event => restoreOriginal(event?.target), true);
    const sweepCompletedFailures = () => {
      root.document?.querySelectorAll?.('img[data-photo-original]').forEach(element => {
        if (element.complete && element.naturalWidth === 0) restoreOriginal(element);
      });
    };
    if (root.document?.readyState === 'loading') {
      root.addEventListener('DOMContentLoaded', sweepCompletedFailures, { once: true });
    } else {
      sweepCompletedFailures();
    }
  }

  installFallback();
  return { DEFAULT_WIDTHS, gallery, normalizedImage, isShopifyImage, photoKey, sharpenedSources, url, candidateWidths, srcset, descriptor, share, image, apply, installFallback };
});
