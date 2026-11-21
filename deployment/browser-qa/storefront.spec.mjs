import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const buildRoot = path.resolve(process.env.KIGB_BROWSER_QA_ROOT || path.resolve(here, '../../.build/dist'));
const proofRoot = process.env.KIGB_PROOF_DIR ? path.resolve(process.env.KIGB_PROOF_DIR) : null;
const inventory = JSON.parse(readFileSync(path.join(buildRoot, 'inventory.json'), 'utf8'));
const firstProduct = inventory.products.find(product => product?.handle);
const studioProduct = inventory.products.find(product => product?.handle && product?.itemNumber && product.available && !/gift.?card/i.test(`${product.title} ${product.sourceProductType || ''}`));
const pages = [
  ['home', '/index.html'],
  ['catalog', '/collection.html'],
  ['story', '/story.html'],
  ['consignment', '/consign.html'],
  ['planner', '/planner.html'],
  ['owner studio', '/studio.html'],
  ['practice checkout', '/practice-checkout.html'],
  ['visit', '/visit.html'],
  ['shortlist', '/shortlist.html'],
  ['bag', '/cart.html'],
  ['generic product', '/product.html'],
  ['product', `/products/${encodeURIComponent(firstProduct.handle)}/`]
];
const viewports = [
  ['phone', { width: 320, height: 812 }],
  ['wide phone', { width: 390, height: 844 }],
  ['tablet', { width: 768, height: 900 }],
  ['desktop', { width: 1440, height: 1000 }]
];

test.beforeEach(async ({ page }) => {
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
  await page.route('https://cdn.shopify.com/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: pixel }));
  await page.route('https://kissitgoodbuy.net/products.json**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ products: [] })
  }));
  await page.route('https://kissitgoodbuy.net/api/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ errors: [{ message: 'Live data unavailable in the offline release fixture.' }] })
  }));
});

async function auditPage(page) {
  return page.evaluate(() => {
    const issues = [];
    if (document.querySelectorAll('h1').length !== 1) issues.push('expected exactly one H1');
    if (document.documentElement.scrollWidth > window.innerWidth + 1) {
      issues.push(`document overflow: ${document.documentElement.scrollWidth}px at ${window.innerWidth}px`);
    }
    const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    if (duplicates.length) issues.push(`duplicate IDs: ${duplicates.join(', ')}`);
    const brokenLocalImages = [...document.images].filter(image => {
      const url = new URL(image.currentSrc || image.src, location.href);
      return url.origin === location.origin && image.complete && image.naturalWidth === 0;
    });
    if (brokenLocalImages.length) issues.push(`broken local images: ${brokenLocalImages.map(image => image.getAttribute('src')).join(', ')}`);
    if (!document.querySelector('.site-header, .studio-site-header') || !document.querySelector('main')) issues.push('missing header or main landmark');
    const brand = document.querySelector('.site-header .wordmark img, .studio-site-header img');
    const brandBox = brand?.getBoundingClientRect();
    if (!brand || brand.alt !== 'Kiss It Good Buy — Furniture Consignment' || brand.naturalWidth < 1000 || brand.naturalHeight < 400 || brandBox.width < 80 || brandBox.height < 30) {
      issues.push('missing, unreadable, or altered header brand artwork');
    }
    return issues;
  });
}

async function photoViewerGeometry(image) {
  await image.evaluate(element => element.decode());
  return image.evaluate(element => {
    const stage = element.closest('.photo-dialog-stage');
    const box = element.getBoundingClientRect();
    const stageStyle = stage ? getComputedStyle(stage) : null;
    const elementStyle = getComputedStyle(element);
    const availableWidth = stage
      ? stage.clientWidth - parseFloat(stageStyle.paddingLeft) - parseFloat(stageStyle.paddingRight)
      : box.width;
    const availableHeight = stage
      ? stage.clientHeight - parseFloat(stageStyle.paddingTop) - parseFloat(stageStyle.paddingBottom)
      : box.height;
    const containScale = element.naturalWidth && element.naturalHeight
      ? Math.min(box.width / element.naturalWidth, box.height / element.naturalHeight)
      : 0;
    const contained = elementStyle.objectFit === 'contain';
    const drawnWidth = contained ? element.naturalWidth * containScale : box.width;
    const drawnHeight = contained ? element.naturalHeight * containScale : box.height;
    return {
      src: element.currentSrc,
      tone: element.dataset.photoTone || '',
      filter: elementStyle.filter,
      naturalWidth: element.naturalWidth,
      naturalHeight: element.naturalHeight,
      boxWidth: box.width,
      boxHeight: box.height,
      drawnWidth,
      drawnHeight,
      availableWidth,
      availableHeight,
      objectFit: elementStyle.objectFit,
      devicePixelRatio,
      scrollWidth: stage?.scrollWidth || 0,
      scrollHeight: stage?.scrollHeight || 0,
      clientWidth: stage?.clientWidth || 0,
      clientHeight: stage?.clientHeight || 0
    };
  });
}

function expectFittedPhoto(geometry, context) {
  expect(geometry.objectFit, `${context} uses contained Fit geometry`).toBe('contain');
  expect(geometry.naturalWidth, `${context} decoded width`).toBeGreaterThan(0);
  expect(geometry.naturalHeight, `${context} decoded height`).toBeGreaterThan(0);
  expect(geometry.boxWidth, `${context} stays inside the available width`).toBeLessThanOrEqual(geometry.availableWidth + 3);
  expect(geometry.boxHeight, `${context} stays inside the available height`).toBeLessThanOrEqual(geometry.availableHeight + 3);
  expect(
    Math.min(Math.abs(geometry.drawnWidth - geometry.availableWidth), Math.abs(geometry.drawnHeight - geometry.availableHeight)),
    `${context} fitted photograph reaches one canvas edge`
  ).toBeLessThanOrEqual(3);
  expect(
    Math.abs((geometry.drawnWidth / geometry.drawnHeight) - (geometry.naturalWidth / geometry.naturalHeight)),
    `${context} preserves the photograph aspect ratio`
  ).toBeLessThanOrEqual(0.01);
  expect(geometry.scrollWidth, `${context} does not require horizontal scrolling`).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.scrollHeight, `${context} does not require vertical scrolling`).toBeLessThanOrEqual(geometry.clientHeight + 1);
}

function watchMerchantDataRequests(page) {
  const requests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.hostname === 'kissitgoodbuy.net' && (url.pathname.startsWith('/api/') || url.pathname === '/products.json')) {
      requests.push(`${request.method()} ${url.pathname}`);
    }
  });
  return requests;
}

async function setStudioDesignField(page, name, value) {
  const field = page.locator(`[name="${name}"][data-design-field]`);
  await field.fill(value);
  await field.press('Tab');
  await expect(page.locator(`[name="${name}"][data-design-field]`)).toHaveValue(value);
}

async function signInToStudio(page) {
  const form = page.locator('#studio-login-form');
  await expect(form).toBeVisible();
  await form.locator('[name="username"]').fill('Chelsea');
  await form.locator('[name="password"]').fill('Chelsea');
  await form.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.locator('.studio-tabs')).toBeVisible();
  await expect(form).toHaveCount(0);
}

async function captureProof(page, name) {
  if (!proofRoot) return;
  mkdirSync(proofRoot, { recursive: true });
  await page.evaluate(async () => {
    const previous = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, 0);
    for (const image of document.images) image.loading = 'eager';
    await Promise.all([...document.images].map(image => image.decode?.().catch(() => undefined)));
    await document.fonts?.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.scrollTo(0, 0);
    document.documentElement.style.scrollBehavior = previous;
  });
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(0);
  await page.screenshot({ path: path.join(proofRoot, name), fullPage: true, animations: 'disabled' });
}

for (const [viewportName, viewport] of viewports) {
  for (const [pageName, route] of pages) {
    test(`${pageName} is structurally sound at ${viewportName}`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', error => errors.push(`page error: ${error.message}`));
      page.on('console', message => { if (message.type() === 'error') errors.push(`console error: ${message.text()}`); });
      await page.setViewportSize(viewport);
      const response = await page.goto(route, { waitUntil: 'load' });
      expect(response?.ok(), `${route} must return a successful response`).toBeTruthy();
      await page.waitForTimeout(400);
      await expect(page.locator('h1')).toBeVisible();
      expect(await auditPage(page)).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

test('captures the default storefront proof when a proof directory is requested', async ({ page }) => {
  test.skip(!proofRoot, 'Proof capture is opt-in for local release review.');
  await page.unroute('https://cdn.shopify.com/**');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/index.html', { waitUntil: 'load' });
  await captureProof(page, 'default-storefront-desktop.png');
});

test('mobile menu opens, closes with Escape, and restores focus', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto('/index.html', { waitUntil: 'load' });
  const menu = page.locator('[data-menu]');
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#main-nav')).toHaveClass(/open/);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeFocused();
});

test('public storefront keeps Studio promotion private and exposes only a plain Log in path', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const route of ['/index.html', '/collection.html', '/visit.html']) {
    await page.goto(route, { waitUntil: 'load' });
    await expect(page.locator('.studio-entry')).toHaveCount(0);
    await expect(page.locator('.owner-preview-bar')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Owner Studio');
  }

  if (proofRoot) {
    await page.unroute('https://cdn.shopify.com/**');
    const devtools = await page.context().newCDPSession(page);
    await devtools.send('Network.clearBrowserCache');
    await devtools.detach();
  }
  await page.goto('/index.html', { waitUntil: 'load' });
  const accountMenu = page.locator('details.account-menu');
  await expect(accountMenu).toBeVisible();
  await accountMenu.locator('summary[aria-label="Open account menu"]').click();
  await expect(accountMenu).toHaveAttribute('open', '');
  const accountOptions = accountMenu.locator('.account-menu-panel[aria-label="Account options"]');
  await expect(accountOptions).toBeVisible();
  await expect(accountOptions.getByRole('link', { name: 'Customer account ↗', exact: true })).toHaveAttribute('href', 'https://kissitgoodbuy.net/account');
  await expect(accountOptions.getByRole('link', { name: 'Consignor account ↗', exact: true })).toHaveAttribute('href', 'https://kissitgoodbuy.net/apps/consignor');
  const desktopLogin = accountOptions.getByRole('link', { name: 'Log in', exact: true });
  await expect(desktopLogin).toHaveAttribute('href', 'studio.html');
  await captureProof(page, 'public-login-menu-desktop.png');
  if (proofRoot) await page.screenshot({ path: path.join(proofRoot, 'public-login-menu-desktop-viewport.png'), animations: 'disabled' });
  await desktopLogin.click();
  await expect(page).toHaveURL(/\/studio\.html$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Log in.' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Chelsea');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/index.html', { waitUntil: 'load' });
  await expect(page.locator('details.account-menu')).toBeHidden();
  await page.locator('[data-menu]').click();
  const mobileNav = page.locator('#main-nav');
  await expect(mobileNav).toHaveClass(/open/);
  const mobileAccounts = mobileNav.locator('.mobile-inventory');
  await expect(mobileAccounts).toHaveCount(2);
  await expect(mobileAccounts.nth(0)).toHaveAttribute('href', 'https://kissitgoodbuy.net/account');
  await expect(mobileAccounts.nth(1)).toHaveAttribute('href', 'https://kissitgoodbuy.net/apps/consignor');
  const mobileLogin = mobileNav.locator('.mobile-login');
  await expect(mobileLogin).toHaveText('Log in');
  await expect(mobileLogin).toHaveAttribute('href', 'studio.html');
  await captureProof(page, 'public-login-menu-mobile.png');
  if (proofRoot) await page.screenshot({ path: path.join(proofRoot, 'public-login-menu-mobile-viewport.png'), animations: 'disabled' });
  await mobileLogin.click();
  await expect(page).toHaveURL(/\/studio\.html$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Log in.' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Chelsea');
});

test('credentials entered before deferred startup survive initialization and pageshow', async ({ page }) => {
  let releaseStartup;
  const startupGate = new Promise(resolve => { releaseStartup = resolve; });
  await page.route('**/studio.js*', async route => {
    await startupGate;
    await route.continue();
  });
  try {
    await page.goto('/studio.html', { waitUntil: 'commit' });
    await page.locator('#studio-username').fill('Chelsea');
    await page.locator('#studio-password').fill('Chelsea');
  } finally {
    releaseStartup();
  }
  await page.waitForLoadState('load');
  await expect(page.locator('#studio-username')).toHaveValue('Chelsea');
  await expect(page.locator('#studio-password')).toHaveValue('Chelsea');
  await page.evaluate(() => dispatchEvent(new Event('pageshow')));
  await expect(page.locator('#studio-username')).toHaveValue('Chelsea');
  await expect(page.locator('#studio-password')).toHaveValue('Chelsea');
  await page.locator('#studio-login-form').getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.locator('.studio-tabs')).toBeVisible();
});

test('a nonempty but truncated live catalog retains the saved inventory and offers retry', async ({ page }) => {
  await page.route('https://kissitgoodbuy.net/products.json**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({products:[{id:9911223344,handle:'incomplete-live-response',title:'Incomplete response fixture',product_type:'Furniture',vendor:'Fixture',tags:[],images:[],options:[],variants:[{id:9911223355,title:'Default Title',price:'10.00',available:true}]}]})
  }));
  await page.goto('/collection.html', { waitUntil: 'load' });
  await expect(page.locator('[data-retry-inventory]').first()).toBeVisible();
  await expect(page.locator('#catalog-results')).toContainText(`of ${inventory.products.length}`);
  await expect(page.locator('#catalog-results')).not.toContainText('Incomplete response fixture');
  await expect(page.locator('[data-live-status]').first()).not.toContainText('Inventory checked');
});

test('the product pickup planner stays available after product refresh', async ({ page }) => {
  await page.goto(`/products/${encodeURIComponent(studioProduct.handle)}/`, { waitUntil: 'load' });
  const planner = page.locator('.planner-link');
  await expect(planner).toBeVisible();
  const originalHref = await planner.getAttribute('href');
  await page.evaluate(() => refreshProductMain());
  await expect(planner).toBeVisible();
  await expect(planner).toHaveAttribute('href', originalHref);
  await planner.click();
  await expect(page).toHaveURL(/planner\.html\?items=/);
  await expect(page.locator('h1')).toBeVisible();
});

test('layout audit detects representative broken CSS, image, and markup', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/index.html', { waitUntil: 'load' });
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = 'body{width:200vw!important}';
    document.head.append(style);
    const duplicate = document.createElement('div');
    duplicate.id = document.querySelector('[id]').id;
    document.body.append(duplicate);
    const broken = new Image();
    broken.src = 'assets/definitely-missing-release-check.png';
    document.body.append(broken);
  });
  await page.waitForTimeout(100);
  const issues = await auditPage(page);
  expect(issues.some(issue => issue.startsWith('document overflow'))).toBeTruthy();
  expect(issues.some(issue => issue.startsWith('duplicate IDs'))).toBeTruthy();
  expect(issues.some(issue => issue.startsWith('broken local images'))).toBeTruthy();
});

test('a missing prepared angle falls back to its own store photograph', async ({ page }) => {
  const product = inventory.products.find(entry => entry.handle && entry.images?.length >= 2);
  const root = '/products/' + product.handle + '/';
  const photo = readFileSync(path.join(buildRoot, 'assets/editorial/facebook-geometric-front-chest.jpg'));
  await page.route('https://cdn.shopify.com/**', route => route.fulfill({ contentType: 'image/jpeg', body: photo }));
  await page.route('**/assets/catalog-clarity/**', route => route.abort());
  await page.goto(root);
  const main = page.locator('#main-product-image');
  await expect(main).toHaveAttribute('data-photo-fallback', 'true');
  const lead = await main.getAttribute('data-photo-original');
  await expect(main).toHaveAttribute('src', lead);
  await expect(main).not.toHaveAttribute('srcset', /./);
  await page.locator('[data-photo="1"]').click();
  await expect.poll(async () => (await main.getAttribute('src')) !== lead && (await main.getAttribute('src')) === (await main.getAttribute('data-photo-original'))).toBe(true);
  await expect(main).toHaveAttribute('data-photo-fallback', 'true');
  await expect.poll(() => main.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  const fallback = await main.evaluate(image => image.currentSrc);
  await page.getByRole('button', { name: 'Enlarge photo', exact: true }).click();
  const zoom = page.locator('#zoom-image');
  await expect(zoom).toHaveAttribute('data-photo-fallback', 'true');
  await zoom.evaluate(image => image.decode());
  expect(await zoom.evaluate(image => image.currentSrc)).toBe(fallback);
});

test('one photo file follows a shopper from the shelf through the viewer, shortlist, planner and bag', async ({ page }) => {
  const product = inventory.products.find(entry => entry.handle && entry.itemNumber && entry.images?.length > 1 && entry.images[0].width > 500);
  expect(product).toBeTruthy();
  await page.goto(`/products/${product.handle}/`, { waitUntil: 'load' });
  const productHeading = (await page.locator('h1').innerText()).trim();

  const main = page.locator('#main-product-image');
  async function displayedPhoto(locator) {
    await expect(locator).toHaveAttribute('data-photo-original', /./);
    await locator.scrollIntoViewIfNeeded();
    await locator.evaluate(image => image.decode());
    const details = await locator.evaluate(image => ({
      actual: image.currentSrc,
      expected: new URL(window.KIGBPhotos.sharpenedSources(image.dataset.photoOriginal).at(-1).src, document.baseURI).href,
      srcset: image.getAttribute('srcset'),
      sizes: image.getAttribute('sizes'),
      tone: image.dataset.photoTone || ''
    }));
    expect(details.actual).toBe(details.expected);
    expect(details.srcset).toBeNull();
    expect(details.sizes).toBeNull();
    return details;
  }
  const lead = await displayedPhoto(page.locator('[data-photo="0"] img'));
  expect(await displayedPhoto(main)).toEqual(lead);

  await page.locator('.main-product-image').click();
  const dialog = page.locator('#photo-dialog');
  const zoom = page.locator('#zoom-image');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-photo-view', 'sharp');
  await expect(page.locator('#photo-dialog-label')).toHaveText(productHeading);
  await expect(zoom).toHaveAttribute('src', /assets\/catalog-clarity\/[a-f0-9]+\.jpg/);
  await expect(zoom).not.toHaveAttribute('srcset', /./);
  await expect(zoom).toHaveAttribute('data-photo-view', 'sharp');
  expect(await displayedPhoto(zoom)).toEqual(lead);
  const fitted = await photoViewerGeometry(zoom);
  expectFittedPhoto(fitted, 'product viewer Fit mode');
  const sizeControl = page.locator('[data-photo-size]');
  await expect(sizeControl).toHaveAccessibleName('View at 100%');
  await sizeControl.click();
  await expect(sizeControl).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.photo-dialog-stage')).toHaveClass(/is-actual-size/);
  await expect(sizeControl).toHaveText('Fit to window');
  expect(await displayedPhoto(zoom)).toEqual(lead);
  const native = await photoViewerGeometry(zoom);
  expect(Math.abs(native.boxWidth * native.devicePixelRatio - native.naturalWidth),
    '100% keeps one source pixel per device pixel').toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.main-product-image')).toBeFocused();

  const enlarge = page.getByRole('button', { name: 'Enlarge photo', exact: true });
  await expect(enlarge).toBeVisible();
  await enlarge.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-photo-view', 'sharp');
  const storePhoto = dialog.getByRole('button', { name: 'View store photo', exact: true });
  await storePhoto.click();
  await expect(dialog).toHaveAttribute('data-photo-view', 'original');
  await expect(page.locator('#photo-dialog-label')).toHaveText(productHeading);
  await expect(zoom).toHaveAttribute('src', product.images[0].src);
  await expect(zoom).not.toHaveAttribute('srcset', /./);
  await expect(zoom).not.toHaveAttribute('data-photo-tone', /./);
  await dialog.getByRole('button', { name: 'Back to gallery photo', exact: true }).click();
  await expect(dialog).toHaveAttribute('data-photo-view', 'sharp');
  await expect(page.locator('#photo-dialog-label')).toHaveText(productHeading);
  await expect(zoom).toHaveAttribute('src', /assets\/catalog-clarity\/[a-f0-9]+\.jpg/);
  await dialog.getByRole('button', { name: 'Close photograph' }).click();
  await expect(enlarge).toBeFocused();

  await page.locator('[data-photo="1"]').click();
  await expect(main).toHaveAttribute('alt', /\S/);
  const second = await displayedPhoto(page.locator('[data-photo="1"] img'));
  expect(await displayedPhoto(main)).toEqual(second);
  await enlarge.click();
  expect(await displayedPhoto(zoom)).toEqual(second);
  await dialog.getByRole('button', { name: 'View store photo', exact: true }).click();
  await expect(zoom).toHaveAttribute('src', product.images[1].src);
  await page.keyboard.press('Escape');

  const singlePhotoProduct = inventory.products.find(entry => entry.handle && entry.images?.length === 1);
  expect(singlePhotoProduct, 'fixture needs a single-photo listing').toBeTruthy();
  await page.goto(`/products/${singlePhotoProduct.handle}/`, { waitUntil: 'load' });
  const singleEnlarge = page.getByRole('button', { name: 'Enlarge photo', exact: true });
  await expect(singleEnlarge).toBeVisible();
  await singleEnlarge.click();
  await page.getByRole('button', { name: 'View store photo', exact: true }).click();
  await expect(page.locator('#zoom-image')).toHaveAttribute('src', singlePhotoProduct.images[0].src);
  await page.keyboard.press('Escape');

  await page.goto('/collection.html', { waitUntil: 'load' });
  const catalogPhoto = page.locator('.product-photo img[data-photo-original]').first();
  const card = await displayedPhoto(catalogPhoto);
  await catalogPhoto.click();
  expect(await displayedPhoto(page.locator('#main-product-image'))).toEqual(card);

  await page.goto(`/shortlist.html?items=${encodeURIComponent(product.itemNumber)}`, { waitUntil: 'load' });
  expect(await displayedPhoto(page.locator('.compare-table img'))).toEqual(lead);

  await page.goto(`/planner.html?items=${encodeURIComponent(product.itemNumber)}`, { waitUntil: 'load' });
  expect(await displayedPhoto(page.locator('.planner-piece-photo img'))).toEqual(lead);

  const cartProduct = inventory.products.find(entry => entry.handle && entry.images?.length && entry.available && entry.variants?.some(variant => variant.available));
  expect(cartProduct, 'fixture needs an available photographed product').toBeTruthy();
  const cartVariant = cartProduct.variants.find(variant => variant.available);
  await page.evaluate(({ selectedProduct, selectedVariant }) => {
    localStorage.setItem('kigb-cart-v1', JSON.stringify([{
      variantId: `gid://shopify/ProductVariant/${selectedVariant.id}`,
      quantity: 1,
      productHandle: selectedProduct.handle,
      productTitle: selectedProduct.title,
      variantTitle: selectedVariant.title === 'Default Title' ? '' : selectedVariant.title,
      priceCents: selectedVariant.priceCents,
      compareAtPriceCents: selectedVariant.compareAtPriceCents,
      currencyCode: 'USD',
      imageUrl: selectedProduct.images[0].src,
      onlineStoreUrl: selectedProduct.productUrl,
      available: true
    }]));
  }, { selectedProduct: cartProduct, selectedVariant: cartVariant });
  await page.goto('/cart.html', { waitUntil: 'load' });
  const bag = await displayedPhoto(page.locator('.cart-line img'));
  await page.goto(`/products/${cartProduct.handle}/`);
  expect(await displayedPhoto(page.locator('#main-product-image'))).toEqual(bag);
});

test('shopper photo language stays neutral in served copy, alternatives, controls and both viewer modes', async ({ page }) => {
  const product = inventory.products.find(entry => entry.handle && entry.images?.length);
  expect(product, 'fixture needs a photographed product').toBeTruthy();
  const processCopy = /\b(?:sharpened detail|original file|view original photo|view sharpened detail|enlarge sharpened photograph|full-size source|restored (?:archive|gallery|close-up|photo|photograph|image)|(?:photo|photograph|image) (?:was )?(?:sharpened|enhanced|restored))\b/i;

  async function expectNeutralPhotoLanguage(context) {
    const values = await page.locator([
      'img[alt]',
      '[data-photo-open]',
      '[data-photo-version]',
      '[data-archive-photo]',
      '[data-photo-size]',
      '[data-photo-zoom]',
      '#photo-dialog-label',
      '#archive-photo-title',
      '.gallery-print-image > span',
      'figcaption'
    ].join(',')).evaluateAll(elements => elements.flatMap(element => [
      ['text', element.textContent],
      ['alt', element.getAttribute('alt')],
      ['aria-label', element.getAttribute('aria-label')],
      ['title', element.getAttribute('title')]
    ].filter(([, value]) => value && value.trim()).map(([field, value]) => ({
      field,
      value: value.replace(/\s+/g, ' ').trim()
    }))));
    const offenders = values.filter(entry => processCopy.test(entry.value));
    expect(offenders, `${context} must not expose internal photograph-processing language`).toEqual([]);
  }

  for (const pathname of ['/index.html', '/story.html']) {
    await page.goto(pathname, { waitUntil: 'load' });
    await expectNeutralPhotoLanguage(pathname);
  }

  await page.goto('/index.html', { waitUntil: 'load' });
  const archiveLink = page.locator('[data-archive-photo]').first();
  const archiveAlt = await archiveLink.locator('img').getAttribute('alt');
  await archiveLink.click();
  const archiveDialog = page.locator('dialog.photo-dialog[open]');
  await expect(archiveDialog).toBeVisible();
  await expect(archiveDialog.locator('#archive-photo-title')).toHaveText(archiveAlt);
  await expectNeutralPhotoLanguage('open archive viewer');
  await archiveDialog.locator('[data-close]').click();

  await page.goto(`/products/${product.handle}/`, { waitUntil: 'load' });
  const title = (await page.locator('h1').innerText()).trim();
  const mainOpener = page.locator('.main-product-image');
  await expect(mainOpener).toHaveAttribute('aria-label', `Enlarge photograph of ${title}`);
  await expectNeutralPhotoLanguage('product page');
  await mainOpener.click();

  const dialog = page.locator('#photo-dialog');
  const heading = dialog.locator('#photo-dialog-label');
  await expect(dialog).toBeVisible();
  await expect(heading).toHaveText(title);
  const viewStorePhoto = dialog.getByRole('button', { name: 'View store photo', exact: true });
  await expect(viewStorePhoto).toBeVisible();
  await expectNeutralPhotoLanguage('gallery-photo viewer mode');

  await viewStorePhoto.click();
  await expect(dialog).toHaveAttribute('data-photo-view', 'original');
  await expect(heading).toHaveText(title);
  const backToGalleryPhoto = dialog.getByRole('button', { name: 'Back to gallery photo', exact: true });
  await expect(backToGalleryPhoto).toBeVisible();
  await expectNeutralPhotoLanguage('store-photo viewer mode');

  await backToGalleryPhoto.click();
  await expect(dialog).toHaveAttribute('data-photo-view', 'sharp');
  await expect(heading).toHaveText(title);
  await expect(dialog.getByRole('button', { name: 'View store photo', exact: true })).toBeVisible();
});

test('small merchant photos keep their native width when shoppers switch angles', async ({ page }) => {
  const candidates = inventory.products.flatMap(product => product.images.map(image => ({ product, image })));
  const small = candidates.filter(({ product, image }) => image.width > 0 && image.width < 450 && product.images.length > 1)
    .sort((a, b) => a.image.width - b.image.width)[0];
  test.skip(!small, 'The current catalog has no small photograph in a multi-photo listing.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/products/' + small.product.handle + '/');
  const angle = await page.evaluate(src => {
    const thumbnails = [...document.querySelectorAll('[data-photo]')];
    return thumbnails.find(button => button.querySelector('img')?.dataset.photoOriginal === src)?.dataset.photo;
  }, small.image.src);
  expect(angle).toBeDefined();
  await page.locator(`[data-photo="${angle}"]`).click();
  const main = page.locator('#main-product-image');
  await main.evaluate(image => image.decode());
  const dimensions = await main.evaluate(element => ({
    native: parseFloat(element.style.getPropertyValue('--photo-native-width')),
    displayed: element.getBoundingClientRect().width,
    frame: element.parentElement.getBoundingClientRect().width
  }));
  expect(dimensions.native).toBeGreaterThan(0);
  expect(dimensions.displayed).toBeLessThanOrEqual(dimensions.native + 1);
  expect(dimensions.displayed).toBeLessThanOrEqual(dimensions.frame + 1);
});

test.describe('High-density photograph display', () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 849, height: 850 } });
  test('Fit fills the viewer while 100% preserves native pixel inspection', async ({ page }) => {
    const entry = inventory.products.find(product => product.images?.some(image => image.width > 0 && image.width < 480));
    test.skip(!entry, 'This catalog has no photograph below 480 supplied pixels.');
    const small = entry.images.find(image => image.width > 0 && image.width < 480);
    await page.goto('/products/' + entry.handle + '/');
    const thumbnail = page.locator('[data-photo] img');
    const index = await thumbnail.evaluateAll((images, source) =>
      images.findIndex(image => image.dataset.photoOriginal === source), small.src);
    expect(index).toBeGreaterThanOrEqual(0);
    const selected = thumbnail.nth(index);
    await selected.click();
    const file = await selected.evaluate(image => image.decode().then(() => image.currentSrc));
    await page.locator('.main-product-image').click();
    const zoom = page.locator('#zoom-image');
    await zoom.evaluate(image => image.decode());
    const fit = await photoViewerGeometry(zoom);
    expect(fit.src).toBe(file);
    expectFittedPhoto(fit, 'high-density small-photo Fit mode');
    expect(
      fit.drawnWidth * fit.devicePixelRatio > fit.naturalWidth + 1 ||
      fit.drawnHeight * fit.devicePixelRatio > fit.naturalHeight + 1,
      'Fit may use the available canvas even when that enlarges a source-limited photograph'
    ).toBe(true);
    await page.getByRole('button', { name: 'View at 100%' }).click();
    const actual = await photoViewerGeometry(zoom);
    expect(actual.src).toBe(file);
    expect(actual.tone).toBe(fit.tone);
    expect(actual.filter).toBe(fit.filter);
    expect(Math.abs(actual.boxWidth * actual.devicePixelRatio - actual.naturalWidth)).toBeLessThanOrEqual(1);
    expect(Math.abs(actual.boxHeight * actual.devicePixelRatio - actual.naturalHeight)).toBeLessThanOrEqual(1);
  });
});

test('clicked product and archive photographs enlarge at mobile and desktop sizes with reversible inspection modes', async ({ page }) => {
  const product = inventory.products.find(entry => {
    const photo = entry.images?.[0];
    return entry.handle && photo?.width >= 700 && photo?.height >= 700 && photo.height / photo.width > 0.9 && photo.height / photo.width < 1.1;
  });
  expect(product, 'fixture needs a nearly square photographed product').toBeTruthy();

  function expectSamePhoto(actual, expected, context) {
    expect(actual.src, `${context} keeps the exact photograph file`).toBe(expected.src);
    expect(actual.naturalWidth, `${context} keeps the same encoded width`).toBe(expected.naturalWidth);
    expect(actual.naturalHeight, `${context} keeps the same encoded height`).toBe(expected.naturalHeight);
    expect(actual.tone, `${context} keeps the same tone metadata`).toBe(expected.tone);
    expect(actual.filter, `${context} keeps the same rendered tone`).toBe(expected.filter);
  }

  async function exerciseViewer({ dialog, image, opener, context }) {
    const stage = dialog.locator('.photo-dialog-stage');
    const zoomControl = dialog.locator('[data-photo-zoom]');
    const sizeControl = dialog.locator('[data-photo-size]');
    await expect(dialog).toBeVisible();
    await expect(stage).toHaveAttribute('data-scale', 'fit');
    await expect(zoomControl).toHaveText('Zoom in');
    await expect(zoomControl).toHaveAttribute('aria-pressed', 'false');
    await expect(sizeControl).toHaveText('View at 100%');
    await expect(sizeControl).toHaveAttribute('aria-pressed', 'false');

    const fit = await photoViewerGeometry(image);
    expectFittedPhoto(fit, `${context} Fit mode`);
    expectSamePhoto(fit, opener, `${context} Fit mode`);
    expect(
      fit.drawnWidth * fit.drawnHeight,
      `${context} click produces a materially larger visible photograph`
    ).toBeGreaterThan(opener.drawnWidth * opener.drawnHeight * 1.05);

    await image.click({ position: { x: Math.max(1, fit.boxWidth / 2), y: Math.max(1, fit.boxHeight / 2) } });
    await expect(stage).toHaveAttribute('data-scale', 'zoom');
    await expect(zoomControl).toHaveText('Zoom out');
    await expect(zoomControl).toHaveAttribute('aria-pressed', 'true');
    await expect(sizeControl).toHaveAttribute('aria-pressed', 'false');
    const imageZoom = await photoViewerGeometry(image);
    expectSamePhoto(imageZoom, fit, `${context} image-click zoom`);
    expect(Math.abs(imageZoom.boxWidth - fit.boxWidth * 2), `${context} image-click zoom doubles fitted width`).toBeLessThanOrEqual(3);
    expect(Math.abs(imageZoom.boxHeight - fit.boxHeight * 2), `${context} image-click zoom doubles fitted height`).toBeLessThanOrEqual(3);
    expect(
      imageZoom.scrollWidth > imageZoom.clientWidth + 1 || imageZoom.scrollHeight > imageZoom.clientHeight + 1,
      `${context} 2x view exposes pannable detail`
    ).toBe(true);

    await zoomControl.click();
    await expect(stage).toHaveAttribute('data-scale', 'fit');
    const fitAgain = await photoViewerGeometry(image);
    expectSamePhoto(fitAgain, fit, `${context} restored Fit mode`);
    expect(Math.abs(fitAgain.boxWidth - fit.boxWidth), `${context} Zoom out restores fitted width`).toBeLessThanOrEqual(2);
    expect(Math.abs(fitAgain.boxHeight - fit.boxHeight), `${context} Zoom out restores fitted height`).toBeLessThanOrEqual(2);

    await sizeControl.click();
    await expect(stage).toHaveAttribute('data-scale', 'native');
    await expect(stage).toHaveClass(/is-actual-size/);
    await expect(sizeControl).toHaveText('Fit to window');
    await expect(sizeControl).toHaveAttribute('aria-pressed', 'true');
    await expect(zoomControl).toHaveAttribute('aria-pressed', 'false');
    const native = await photoViewerGeometry(image);
    expectSamePhoto(native, fit, `${context} 100% mode`);
    expect(Math.abs(native.boxWidth * native.devicePixelRatio - native.naturalWidth),
      `${context} 100% maps source pixels horizontally`).toBeLessThanOrEqual(1);
    expect(Math.abs(native.boxHeight * native.devicePixelRatio - native.naturalHeight),
      `${context} 100% maps source pixels vertically`).toBeLessThanOrEqual(1);

    await zoomControl.click();
    await expect(stage).toHaveAttribute('data-scale', 'zoom');
    await expect(stage).not.toHaveClass(/is-actual-size/);
    await expect(zoomControl).toHaveAttribute('aria-pressed', 'true');
    await expect(sizeControl).toHaveAttribute('aria-pressed', 'false');
    await expect(sizeControl).toHaveText('View at 100%');
    const zoomFromNative = await photoViewerGeometry(image);
    expectSamePhoto(zoomFromNative, fit, `${context} Zoom from 100% mode`);
    expect(Math.abs(zoomFromNative.boxWidth - Math.max(fit.boxWidth, native.boxWidth) * 2),
      `${context} Zoom from 100% doubles the larger inspection width`).toBeLessThanOrEqual(3);
    expect(zoomFromNative.boxWidth, `${context} Zoom in never shrinks a 100% view`).toBeGreaterThan(native.boxWidth);

    await page.keyboard.press('-');
    await expect(stage).toHaveAttribute('data-scale', 'fit');
    await expect(zoomControl).toHaveText('Zoom in');
    await page.keyboard.press('Shift+=');
    await expect(stage).toHaveAttribute('data-scale', 'zoom');
    await expect(zoomControl).toHaveText('Zoom out');
    await page.keyboard.press('0');
    await expect(stage).toHaveAttribute('data-scale', 'fit');
    await page.keyboard.press('=');
    await expect(stage).toHaveAttribute('data-scale', 'zoom');
    const keyboardZoom = await photoViewerGeometry(image);
    expectSamePhoto(keyboardZoom, fit, `${context} keyboard zoom`);
    expect(Math.abs(keyboardZoom.boxWidth - fit.boxWidth * 2), `${context} keyboard Zoom uses 2x Fit width`).toBeLessThanOrEqual(3);

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  }

  for (const [name, viewport] of [['mobile', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 1000 }]]) {
    await test.step(`${name} product viewer`, async () => {
      await page.setViewportSize(viewport);
      await page.goto(`/products/${product.handle}/`, { waitUntil: 'load' });
      const openerButton = page.locator('.main-product-image');
      const openerImage = page.locator('#main-product-image');
      const opener = await photoViewerGeometry(openerImage);
      await openerButton.click();
      await exerciseViewer({
        dialog: page.locator('#photo-dialog'),
        image: page.locator('#zoom-image'),
        opener,
        context: `${name} product viewer`
      });
      await expect(openerButton).toBeFocused();
    });

    await test.step(`${name} archive viewer`, async () => {
      await page.goto('/index.html', { waitUntil: 'load' });
      const openerLink = page.locator('[data-archive-photo]').first();
      await openerLink.scrollIntoViewIfNeeded();
      const opener = await photoViewerGeometry(openerLink.locator('img'));
      await openerLink.click();
      const dialog = page.locator('dialog.photo-dialog[open]');
      await exerciseViewer({
        dialog,
        image: dialog.locator('.photo-dialog-stage img'),
        opener,
        context: `${name} archive viewer`
      });
      await expect(openerLink).toBeFocused();
    });
  }
});

test('all eleven gallery archive thumbnails and enlargements use the same largest local file', async ({ page }) => {
  const largestFiles = new Map([
    ['crystal-chandelier-prisms.webp', [1448, 1086]],
    ['murano-overview-v2-1280.webp', [1280, 1280]],
    ['murano-fluted-cup-v2-640.webp', [640, 639]],
    ['murano-glass-branches-v2-640.webp', [640, 640]],
    ['smiroldo-drummer-v2-789.webp', [789, 789]],
    ['orange-chairs-and-gallery-cat.webp', [1254, 1254]],
    ['lane-park-chest-v2-798.webp', [798, 798]],
    ['gallery-showroom-v2-1135.webp', [1135, 596]],
  ]);
  const seenLargestFiles = new Set();
  for (const [pathname, expectedCount] of [['/index.html', 7], ['/story.html', 4]]) {
    await page.goto(pathname, { waitUntil: 'load' });
    const links = page.locator('[data-archive-photo]');
    await expect(links).toHaveCount(expectedCount);
    for (let index = 0; index < expectedCount; index += 1) {
      const link = links.nth(index);
      const href = await link.getAttribute('href');
      const expected = new URL(href, page.url()).href;
      const fileName = decodeURIComponent(new URL(expected).pathname.split('/').pop());
      const expectedDimensions = largestFiles.get(fileName);
      expect(expectedDimensions, `${fileName} is the reviewed largest archive file`).toBeDefined();
      seenLargestFiles.add(fileName);
      const sourceImage = link.locator('img');
      const expectedTone = await sourceImage.getAttribute('data-photo-tone');
      const expectedFilter = await sourceImage.evaluate(element => getComputedStyle(element).filter);
      await link.scrollIntoViewIfNeeded();
      await sourceImage.evaluate(element => element.decode());
      const thumbnail = await sourceImage.evaluate(element => {
        const box = element.getBoundingClientRect();
        return {
          src: element.src,
          currentSrc: element.currentSrc,
          srcset: element.getAttribute('srcset'),
          naturalWidth: element.naturalWidth,
          naturalHeight: element.naturalHeight,
          renderedWidth: box.width,
          renderedHeight: box.height,
          devicePixelRatio,
        };
      });
      expect(thumbnail.src).toBe(expected);
      expect(thumbnail.currentSrc).toBe(expected);
      expect(thumbnail.srcset).toBeNull();
      expect([thumbnail.naturalWidth, thumbnail.naturalHeight]).toEqual(expectedDimensions);
      expect(thumbnail.naturalWidth).toBeGreaterThanOrEqual(thumbnail.renderedWidth * thumbnail.devicePixelRatio - 1);
      expect(thumbnail.naturalHeight).toBeGreaterThanOrEqual(thumbnail.renderedHeight * thumbnail.devicePixelRatio - 1);
      await link.click();
      const dialog = page.locator('dialog.photo-dialog[open]');
      const image = dialog.locator('.photo-dialog-stage img');
      await expect(dialog).toBeVisible();
      const details = await photoViewerGeometry(image);
      expect(details.src).toBe(expected);
      expect(details.src).toBe(thumbnail.currentSrc);
      expectFittedPhoto(details, `${fileName} archive Fit mode`);
      expect(await image.getAttribute('data-photo-tone')).toBe(expectedTone);
      expect(await image.evaluate(element => getComputedStyle(element).filter)).toBe(expectedFilter);
      const sizeControl = dialog.locator('[data-photo-size]');
      await sizeControl.click();
      await expect(sizeControl).toHaveAttribute('aria-pressed', 'true');
      await expect(dialog.locator('.photo-dialog-stage')).toHaveClass(/is-actual-size/);
      const native = await photoViewerGeometry(image);
      expect(Math.abs(native.boxWidth * native.devicePixelRatio - native.naturalWidth),
        '100% maps each source pixel to one display pixel horizontally').toBeLessThanOrEqual(1);
      expect(Math.abs(native.boxHeight * native.devicePixelRatio - native.naturalHeight),
        '100% maps each source pixel to one display pixel vertically').toBeLessThanOrEqual(1);
      expect(native.src).toBe(details.src);
      expect(native.tone).toBe(details.tone);
      expect(native.filter).toBe(details.filter);
      expect(await image.getAttribute('data-photo-tone')).toBe(expectedTone);
      expect(await image.evaluate(element => getComputedStyle(element).filter)).toBe(expectedFilter);

      if (index % 2 === 0) await page.keyboard.press('Escape');
      else await dialog.locator('[data-close]').click();
      await expect(dialog).toHaveCount(0);
      await expect(link).toBeFocused();
    }
  }
  expect(seenLargestFiles).toEqual(new Set(largestFiles.keys()));
});

test('the Murano study preserves square contained photographs when the neighboring chapter grows', async ({ page }) => {
  for (const width of [834, 1100]) {
    await page.setViewportSize({ width, height: 1050 });
    await page.goto('/index.html', { waitUntil: 'load' });
    const study = page.locator('.murano-study');
    const print = study.locator('.murano-print');
    const photographs = print.locator(':scope > [data-archive-photo] img, .murano-details [data-archive-photo] img');
    await expect(photographs).toHaveCount(3);
    await study.scrollIntoViewIfNeeded();
    await photographs.evaluateAll(images => Promise.all(images.map(image => image.decode())));
    expect(await photographs.evaluateAll(images => images.map(image => image.dataset.photoTone || '')))
      .toEqual(['', '', 'midtones']);
    const before = await print.boundingBox();
    await page.locator('.light-chapter .chapter-shop').evaluate(element => { element.style.minHeight = '1800px'; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await print.boundingBox();
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
    const details = await photographs.evaluateAll(images => images.map(image => {
      const box = image.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        objectFit: getComputedStyle(image).objectFit,
      };
    }));
    for (const image of details) {
      expect(image.naturalWidth).toBeGreaterThan(0);
      expect(image.naturalHeight).toBeGreaterThan(0);
      expect(Math.abs(image.width - image.height)).toBeLessThanOrEqual(1);
      expect(image.objectFit).toBe('contain');
    }
  }
});

test('saved catalog remains usable when the live inventory read is unavailable', async ({ page }) => {
  await page.unroute('https://kissitgoodbuy.net/products.json**');
  await page.route('https://kissitgoodbuy.net/products.json**', route => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Expected release-test outage.' })
  }));
  await page.goto('/collection.html', { waitUntil: 'load' });
  await expect(page.locator('[data-live-status]').first()).toContainText('Live update unavailable');
  await expect(page.locator('.product').first()).toBeVisible();
});

test('fit plan persists in the tab and prints the entered measurements and notes', async ({ page }) => {
  await page.goto('/planner.html', { waitUntil: 'load' });
  await page.locator('#fit-plan-form [name="roomWidth"]').fill('144');
  await page.locator('#fit-plan-form [name="roomDepth"]').fill('168');
  await page.locator('#fit-plan-form [name="doorWidth"]').fill('34.5');
  await page.locator('#fit-plan-form [name="doorHeight"]').fill('80');
  await page.locator('#fit-plan-form [name="notes"]').fill('Tight left turn after the entry; call before pickup.');
  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('#fit-plan-form [name="roomWidth"]')).toHaveValue('144');
  await expect(page.locator('#fit-plan-form [name="doorWidth"]')).toHaveValue('34.5');
  await expect(page.locator('#fit-plan-form [name="notes"]')).toHaveValue('Tight left turn after the entry; call before pickup.');

  await page.emulateMedia({ media: 'print' });
  const summary = page.locator('#planner-print-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('144');
  await expect(summary).toContainText('34.5');
  await expect(summary).toContainText('Tight left turn after the entry; call before pickup.');
  await expect(page.locator('.planner-workspace')).toBeHidden();
  await expect(page.locator('.site-header')).toBeHidden();
  await expect(page.locator('[data-print-plan]')).toBeHidden();
});

test('mocked checkout stores a trusted recovery link and a cart change invalidates it', async ({ page }) => {
  const product = inventory.products.find(entry => entry.available && entry.variants?.some(variant => variant.available));
  const variant = product.variants.find(entry => entry.available);
  const variantId = `gid://shopify/ProductVariant/${variant.id}`;
  const line = {
    variantId, quantity: 1, productHandle: product.handle, productTitle: product.title,
    variantTitle: variant.title === 'Default Title' ? '' : variant.title,
    priceCents: variant.priceCents, compareAtPriceCents: variant.compareAtPriceCents,
    currencyCode: 'USD', imageUrl: product.images[0]?.src || '',
    onlineStoreUrl: product.productUrl, available: true
  };
  await page.addInitScript(value => localStorage.setItem('kigb-cart-v1', JSON.stringify([value])), line);
  await page.unroute('https://kissitgoodbuy.net/api/**');
  let mutationCount = 0;
  await page.route('https://kissitgoodbuy.net/api/**', async route => {
    const request = JSON.parse(route.request().postData() || '{}');
    if (String(request.query).includes('query ValidateCart')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { nodes: [{
        id: variantId, title: variant.title, availableForSale: true,
        quantityRule: { minimum: 1, maximum: 250, increment: 1 },
        price: { amount: (variant.priceCents / 100).toFixed(2), currencyCode: 'USD' },
        compareAtPrice: variant.compareAtPriceCents == null ? null : { amount: (variant.compareAtPriceCents / 100).toFixed(2), currencyCode: 'USD' },
        product: { handle: product.handle, title: product.title, onlineStoreUrl: product.productUrl, featuredImage: product.images[0] ? { url: product.images[0].src } : null }
      }] } }) });
      return;
    }
    if (String(request.query).includes('mutation CreateCheckout')) {
      mutationCount += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { cartCreate: {
        cart: {
          checkoutUrl: 'https://kissitgoodbuy.net/cart/c/browser-release-check',
          lines: { nodes: [{ id: 'gid://shopify/CartLine/1', quantity: 1, merchandise: { id: variantId, availableForSale: true } }] },
          cost: { subtotalAmount: { amount: (variant.priceCents / 100).toFixed(2), currencyCode: 'USD' }, totalAmount: { amount: (variant.priceCents / 100).toFixed(2), currencyCode: 'USD' } }
        }, userErrors: [], warnings: []
      } } }) });
      return;
    }
    await route.fulfill({ status: 500, body: 'Unexpected operation' });
  });
  await page.route('https://kissitgoodbuy.net/cart/c/**', route => route.abort('blockedbyclient'));

  await page.goto('/cart.html', { waitUntil: 'load' });
  const checkoutRequest = page.waitForRequest('https://kissitgoodbuy.net/cart/c/**');
  await page.locator('[data-checkout]').click({ noWaitAfter: true });
  await checkoutRequest;
  expect(mutationCount).toBe(1);

  await page.goto('/cart.html', { waitUntil: 'load' });
  const recoveryLink = page.getByRole('link', { name: 'Open secure Shopify checkout' });
  await expect(recoveryLink).toHaveAttribute('href', 'https://kissitgoodbuy.net/cart/c/browser-release-check');
  await page.locator('[data-quantity][data-delta="1"]').click();
  await expect(recoveryLink).toHaveCount(0);
});

test('Owner Studio convenience sign-in is exact, session-scoped, and signs out without losing the draft', async ({ page }) => {
  const loginRequests = [];
  page.on('request', request => {
    if (['fetch', 'xhr'].includes(request.resourceType())) loginRequests.push(`${request.method()} ${request.url()}`);
  });
  await page.goto('/studio.html', { waitUntil: 'load' });
  const form = page.locator('#studio-login-form');
  await expect(form).toBeVisible();
  await expect(page.locator('.studio-tabs')).toHaveCount(0);

  if (proofRoot) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await captureProof(page, 'owner-studio-login-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await captureProof(page, 'owner-studio-login-mobile.png');
    await page.setViewportSize({ width: 1440, height: 1000 });
  }

  loginRequests.length = 0;
  await form.locator('[name="username"]').fill('Chelsea');
  await form.locator('[name="password"]').fill('chelsea');
  await form.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.locator('#studio-login-error')).toBeVisible();
  expect((await page.locator('#studio-login-error').innerText()).trim().length).toBeGreaterThan(0);
  await expect(page.locator('.studio-tabs')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('kigb-owner-studio-session-v1'))).toBeNull();
  expect(loginRequests).toEqual([]);

  await signInToStudio(page);
  expect(await page.evaluate(() => sessionStorage.getItem('kigb-owner-studio-session-v1'))).toBe('Chelsea');
  await setStudioDesignField(page, 'coral', '#b15a4a');
  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('.studio-tabs')).toBeVisible();
  await expect(page.locator('[name="coral"][data-design-field]')).toHaveValue('#b15a4a');

  await Promise.all([
    page.waitForURL('**/index.html'),
    page.locator('[data-preview-store]').click()
  ]);
  await page.getByRole('link', { name: 'Edit in Owner Studio →', exact: true }).click();
  await expect(page.locator('.studio-tabs')).toBeVisible();
  await page.locator('[data-studio-signout]').click();
  await expect(form).toBeVisible();
  await expect(page.locator('.studio-tabs')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('kigb-owner-studio-session-v1'))).toBeNull();
  expect(await page.evaluate(() => window.KIGBStudioState.read().active)).toBe(false);

  await page.goto('/index.html', { waitUntil: 'load' });
  await page.goBack({ waitUntil: 'load' });
  await expect(page).toHaveURL(/\/studio\.html$/);
  await expect(form).toBeVisible();
  await expect(page.locator('.studio-tabs')).toHaveCount(0);

  await signInToStudio(page);
  await expect(page.locator('[name="coral"][data-design-field]')).toHaveValue('#b15a4a');
});

test('Owner Studio commits a field blur before the directly clicked preview action', async ({ page }) => {
  await page.goto('/studio.html', { waitUntil: 'load' });
  await signInToStudio(page);

  const coralPicker = page.locator('[data-color-picker="coral"]');
  await expect(coralPicker).toHaveValue('#df7d69');
  await page.locator('[name="coral"][data-design-field]').fill('#b24d3e');
  await page.locator('[name="coral"][data-design-field]').press('Tab');
  await expect(coralPicker).toHaveValue('#b24d3e');
  await page.locator('[name="coral"][data-design-field]').fill('#b34e3f');
  await Promise.all([
    page.waitForURL('**/index.html'),
    page.locator('[data-preview-store]').click()
  ]);

  await expect(page.locator('.owner-preview-bar')).toContainText('Your practice storefront');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--coral').trim())).toBe('#b34e3f');
  await page.reload({ waitUntil: 'load' });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--coral').trim())).toBe('#b34e3f');
});

test('Owner Studio protects unsaved words before tab changes or preview', async ({ page }) => {
  await page.goto('/studio.html', { waitUntil: 'load' });
  await signInToStudio(page);
  await page.locator('[data-studio-tab="content"]').click();
  await page.locator('#studio-content-form [name="heroTitle"]').fill('Words preserved on preview');
  await page.locator('#studio-content-form [name="heroAccent"]').fill('without a lost draft.');

  await page.locator('[data-preview-store]').click();
  await expect(page).toHaveURL(/\/studio\.html\?tab=content$/);
  await expect(page.locator('.studio-message.error')).toContainText(/Save.*before/i);
  await expect(page.locator('#studio-content-form [name="heroTitle"]')).toHaveValue('Words preserved on preview');
  await expect(page.locator('#studio-content-form [name="heroAccent"]')).toHaveValue('without a lost draft.');

  await page.locator('[data-studio-tab="design"]').click();
  await expect(page.locator('[data-studio-tab="content"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.studio-message.error')).toContainText(/Save.*before/i);
  await expect(page.locator('#studio-content-form [name="heroTitle"]')).toHaveValue('Words preserved on preview');

  await page.locator('[data-discard-edits]').click();
  await expect(page.locator('#studio-confirm-dialog')).toBeVisible();
  await page.locator('[data-confirm-accept]').click();
  await expect(page.locator('#studio-content-form [name="heroTitle"]')).not.toHaveValue('Words preserved on preview');
  await page.locator('[data-studio-tab="design"]').click();
  await expect(page.locator('[data-studio-tab="design"]')).toHaveAttribute('aria-current', 'page');
});

test('Owner Studio keeps a product form intact after a rejected photo URL and saves the correction', async ({ page }) => {
  expect(studioProduct, 'fixture needs an available non-gift product with an item number').toBeTruthy();
  await page.goto('/studio.html', { waitUntil: 'load' });
  await signInToStudio(page);
  await page.locator('[data-studio-tab="inventory"]').click();
  await page.locator('#studio-product-search').fill(studioProduct.itemNumber);
  await page.waitForTimeout(250);
  let editor = page.locator(`[data-product-handle="${studioProduct.handle}"]`);
  await editor.locator('summary').click();
  await editor.locator('[name="title"]').fill('Recovered product edit');
  await editor.locator('[name="price"]').fill('321.09');
  await editor.locator('[name="imageUrl"]').fill('javascript:alert(1)');
  await editor.locator('button[type="submit"]').click();

  await expect(page.locator('.studio-message.error')).toBeVisible();
  await expect(editor).toHaveAttribute('open', '');
  await expect(editor.locator('[name="title"]')).toHaveValue('Recovered product edit');
  await expect(editor.locator('[name="price"]')).toHaveValue('321.09');
  await expect(editor.locator('[name="imageUrl"]')).toHaveValue('javascript:alert(1)');

  await editor.locator('[name="imageUrl"]').fill('assets/brand-original.png');
  await editor.locator('button[type="submit"]').click();
  await expect(page.locator('.studio-message')).toContainText('Practice listing saved.');
  await page.reload({ waitUntil: 'load' });
  await page.locator('#studio-product-search').fill(studioProduct.itemNumber);
  await page.waitForTimeout(250);
  editor = page.locator(`[data-product-handle="${studioProduct.handle}"]`);
  await editor.locator('summary').click();
  await expect(editor.locator('[name="title"]')).toHaveValue('Recovered product edit');
  await expect(editor.locator('[name="price"]')).toHaveValue('321.09');
  await expect(editor.locator('[name="imageUrl"]')).toHaveValue('assets/brand-original.png');
});

test('Owner Studio keeps a selected custom photo through blocked navigation and native validation', async ({ page }) => {
  await page.goto('/studio.html', { waitUntil: 'load' });
  await signInToStudio(page);
  await page.locator('[data-studio-tab="inventory"]').click();
  const form = page.locator('#studio-custom-product-form');
  await form.locator('[name="title"]').fill('Photo selection recovery');
  await form.locator('[name="price"]').fill('-1');
  await form.locator('[name="imageFile"]').setInputFiles({
    name: 'selected-photo.jpg',
    mimeType: 'image/jpeg',
    buffer: readFileSync(path.join(buildRoot, 'assets/editorial/facebook-geometric-front-chest.jpg'))
  });

  await page.locator('[data-studio-tab="design"]').click();
  await expect(page.locator('[data-studio-tab="inventory"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.studio-message.error')).toContainText(/Save.*before/i);
  await expect(form.locator('[name="title"]')).toHaveValue('Photo selection recovery');
  expect(await form.locator('[name="imageFile"]').evaluate(input => input.files?.[0]?.name)).toBe('selected-photo.jpg');

  await form.locator('button[type="submit"]').click();
  await expect(form.locator('[name="price"]')).toBeFocused();
  expect(await form.locator('[name="imageFile"]').evaluate(input => input.files?.[0]?.name)).toBe('selected-photo.jpg');
  await form.locator('[name="price"]').fill('125');
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('.studio-custom-product')).toContainText('Photo selection recovery');
});

test('Owner Studio design, words, and inventory edits persist into the private preview without merchant requests', async ({ page }) => {
  expect(studioProduct, 'fixture needs an available non-gift product with an item number').toBeTruthy();
  const merchantRequests = watchMerchantDataRequests(page);
  await page.goto('/studio.html', { waitUntil: 'load' });
  await signInToStudio(page);
  await page.evaluate(() => localStorage.setItem('kigb-cart-v1', '"real-cart-sentinel"'));

  await setStudioDesignField(page, 'coral', '#c95747');
  await page.locator('[name="headingFont"][data-design-field]').selectOption('Optima');
  await page.locator('[name="bodyFont"][data-design-field]').selectOption('Arial');
  await page.locator('[name="density"][data-design-field]').selectOption('spacious');
  await page.locator('[name="heroLayout"][data-design-field]').selectOption('split');
  await page.locator('[name="productColumns"][data-design-field]').selectOption('2');
  await page.locator('[name="imageFit"][data-design-field]').selectOption('cover');
  await page.locator('[data-studio-tab="content"]').click();
  await page.locator('#studio-content-form [name="heroTitle"]').fill('Collected for real rooms');
  await page.locator('#studio-content-form [name="heroAccent"]').fill('and unmistakably yours.');
  await page.locator('#studio-content-form [name="heroIntro"]').fill('Furniture, art, and the unexpected — thoughtfully collected in Grapevine.');
  await page.locator('#studio-content-form [name="phone"]').fill('214-555-0176');
  await page.locator('#studio-content-form [name="email"]').fill('studio.qa@example.test');
  await page.locator('#studio-content-form [name="address"]').fill('123 Gallery Lane');
  await page.locator('#studio-content-form [name="city"]').fill('Grapevine, TX 76051');
  await page.locator('#studio-content-form button[type="submit"]').click();

  await page.locator('[data-studio-tab="inventory"]').click();
  await page.locator('#studio-product-search').fill(studioProduct.itemNumber);
  await page.waitForTimeout(250);
  const editor = page.locator(`[data-product-handle="${studioProduct.handle}"]`);
  await expect(editor).toBeVisible();
  await editor.locator('summary').click();
  await editor.locator('[name="title"]').fill('Browser QA · collected find');
  await editor.locator('[name="price"]').fill('432.10');
  await editor.locator('[name="available"]').selectOption('false');
  await editor.locator('[name="dimensionsRaw"]').fill('41 W × 22 D × 33 H');
  await editor.locator('[name="imageUrl"]').fill('assets/brand-original.png');
  await editor.locator('button[type="submit"]').click();

  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('.studio-tabs')).toBeVisible();
  await page.locator('[data-studio-tab="design"]').click();
  await expect(page.locator('[name="coral"][data-design-field]')).toHaveValue('#c95747');
  await expect(page.locator('[name="headingFont"][data-design-field]')).toHaveValue('Optima');
  await expect(page.locator('[name="bodyFont"][data-design-field]')).toHaveValue('Arial');
  await expect(page.locator('[name="density"][data-design-field]')).toHaveValue('spacious');
  await expect(page.locator('[name="heroLayout"][data-design-field]')).toHaveValue('split');
  await expect(page.locator('[name="productColumns"][data-design-field]')).toHaveValue('2');
  await expect(page.locator('[name="imageFit"][data-design-field]')).toHaveValue('cover');
  await page.locator('[data-studio-tab="content"]').click();
  await expect(page.locator('#studio-content-form [name="phone"]')).toHaveValue('214-555-0176');
  await expect(page.locator('#studio-content-form [name="email"]')).toHaveValue('studio.qa@example.test');

  if (proofRoot) {
    await page.unroute('https://cdn.shopify.com/**');
    const devtools = await page.context().newCDPSession(page);
    await devtools.send('Network.clearBrowserCache');
    await devtools.detach();
    await page.reload({ waitUntil: 'load' });
    await page.locator('[data-studio-tab="design"]').click();
    await expect.poll(() => page.locator('.studio-preview-products img').evaluateAll(images => images.length === 3 && images.every(image => image.complete && image.naturalWidth > 1))).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await captureProof(page, 'owner-studio-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await captureProof(page, 'owner-studio-mobile.png');
    await page.setViewportSize({ width: 1440, height: 1000 });
  }

  await Promise.all([
    page.waitForURL('**/index.html'),
    page.locator('[data-preview-store]').click()
  ]);
  await expect(page.locator('.owner-preview-bar')).toContainText('Your practice storefront');
  await expect(page.locator('#welcome-title')).toContainText('Collected for real rooms');
  await expect(page.locator('#welcome-title')).toContainText('and unmistakably yours.');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--coral').trim())).toBe('#c95747');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--studio-columns').trim())).toBe('2');
  await expect(page.locator('html')).toHaveAttribute('data-studio-hero', 'split');
  await expect(page.locator('html')).toHaveAttribute('data-studio-density', 'spacious');
  await expect(page.locator('html')).toHaveAttribute('data-studio-image', 'cover');
  await expect(page.locator('a[href="tel:+12145550176"]').first()).toBeVisible();
  await expect(page.locator('a[href^="mailto:studio.qa%40example.test"]').first()).toBeVisible();
  await expect(page.locator('body')).toContainText('123 Gallery Lane');

  await page.goto('/collection.html?q=Browser%20QA', { waitUntil: 'load' });
  const card = page.locator('.product', { has: page.locator('.product-title', { hasText: 'Browser QA · collected find' }) });
  await expect(card).toHaveCount(1);
  await expect(card.locator('.price')).toContainText('$432.10');
  await expect(card.locator('.stock-label')).toContainText('Sold out');
  await expect(card.locator('.card-dimensions')).toContainText('41 W × 22 D × 33 H');
  await expect(card.locator('.product-photo img')).toHaveAttribute('src', 'assets/brand-original.png');
  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('.owner-preview-bar')).toContainText('Your practice storefront');
  await expect(page.locator('.product-title', { hasText: 'Browser QA · collected find' })).toBeVisible();

  await page.goto('/studio.html?tab=inventory', { waitUntil: 'load' });
  await page.locator('#studio-product-search').fill(studioProduct.itemNumber);
  await page.waitForTimeout(250);
  const reloadedEditor = page.locator(`[data-product-handle="${studioProduct.handle}"]`);
  await reloadedEditor.locator('summary').click();
  await reloadedEditor.locator('[name="hidden"]').check();
  await reloadedEditor.locator('button[type="submit"]').click();
  await Promise.all([
    page.waitForURL('**/index.html'),
    page.locator('[data-preview-store]').click()
  ]);
  await page.goto('/collection.html?q=Browser%20QA', { waitUntil: 'load' });
  await expect(page.locator('.product-title', { hasText: 'Browser QA · collected find' })).toHaveCount(0);
  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('.product-title', { hasText: 'Browser QA · collected find' })).toHaveCount(0);

  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('kigb-owner-studio-v1')));
  expect(persisted.active).toBe(true);
  expect(persisted.draft.design.coral).toBe('#c95747');
  expect(persisted.draft.content.heroTitle).toBe('Collected for real rooms');
  expect(persisted.draft.content.phone).toBe('214-555-0176');
  expect(persisted.draft.products[studioProduct.handle].title).toBe('Browser QA · collected find');
  expect(persisted.draft.products[studioProduct.handle].priceCents).toBe(43210);
  expect(persisted.draft.products[studioProduct.handle].available).toBe(false);
  expect(persisted.draft.products[studioProduct.handle].hidden).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('kigb-cart-v1'))).toBe('"real-cart-sentinel"');
  expect(merchantRequests).toEqual([]);
});

test('Owner Studio supports undo, named restore points, and atomic backup import', async ({ page }) => {
  await page.goto('/studio.html', { waitUntil: 'load' });
  await signInToStudio(page);
  await page.locator('[data-preset="collected"]').click();
  await expect(page.locator('[name="coral"][data-design-field]')).toHaveValue('#de755f');

  await page.locator('[data-studio-tab="versions"]').click();
  await page.locator('#studio-version-form [name="name"]').fill('Browser QA saved palette');
  await page.locator('#studio-version-form button[type="submit"]').click();
  await expect(page.locator('.studio-version-list')).toContainText('Browser QA saved palette');
  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('.studio-version-list')).toContainText('Browser QA saved palette');

  await page.locator('[data-studio-tab="design"]').click();
  await setStudioDesignField(page, 'coral', '#b84b3d');
  await page.locator('[data-studio-tab="versions"]').click();
  await page.locator('[data-undo]').click();
  await page.locator('[data-studio-tab="design"]').click();
  await expect(page.locator('[name="coral"][data-design-field]')).toHaveValue('#de755f');
  await page.locator('[data-studio-tab="versions"]').click();
  await page.locator('[data-redo]').click();
  await page.locator('[data-studio-tab="design"]').click();
  await expect(page.locator('[name="coral"][data-design-field]')).toHaveValue('#b84b3d');

  await page.locator('[data-studio-tab="versions"]').click();
  await page.locator('[data-restore-version]').click();
  await page.reload({ waitUntil: 'load' });
  await page.locator('[data-studio-tab="design"]').click();
  await expect(page.locator('[name="coral"][data-design-field]')).toHaveValue('#de755f');
  await page.locator('[data-studio-tab="versions"]').click();

  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-export-studio]').click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  const backup = JSON.parse(readFileSync(downloadPath, 'utf8'));
  expect(backup.kind).toBe('kiss-it-goodbuy-owner-studio');
  expect(backup.studio.versions.some(version => version.name === 'Browser QA saved palette')).toBe(true);

  backup.studio.draft.content.heroTitle = 'Imported browser QA headline';
  await page.locator('[data-import-studio]').setInputFiles({
    name: 'owner-studio-valid.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup))
  });
  await expect(page.locator('#studio-confirm-dialog')).toBeVisible();
  await page.locator('[data-confirm-accept]').click();
  await expect(page.locator('.studio-message')).toContainText('Backup imported and checked.');
  await page.locator('[data-studio-tab="content"]').click();
  await expect(page.locator('#studio-content-form [name="heroTitle"]')).toHaveValue('Imported browser QA headline');
  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('#studio-content-form [name="heroTitle"]')).toHaveValue('Imported browser QA headline');

  await page.locator('[data-studio-tab="versions"]').click();
  const beforeInvalidImport = await page.evaluate(() => localStorage.getItem('kigb-owner-studio-v1'));
  backup.studio.draft.design.unexpected = true;
  await page.locator('[data-import-studio]').setInputFiles({
    name: 'owner-studio-invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup))
  });
  await expect(page.locator('#studio-confirm-dialog')).toBeVisible();
  await page.locator('[data-confirm-accept]').click();
  await expect(page.locator('.studio-message.error')).toContainText('unknown field');
  expect(await page.evaluate(() => localStorage.getItem('kigb-owner-studio-v1'))).toBe(beforeInvalidImport);
});

test('practice checkout creates and updates only a local Studio order', async ({ page }) => {
  expect(studioProduct, 'fixture needs an available non-gift product with an item number').toBeTruthy();
  const merchantRequests = watchMerchantDataRequests(page);
  await page.goto('/studio.html', { waitUntil: 'load' });
  await signInToStudio(page);
  await page.evaluate(() => localStorage.setItem('kigb-cart-v1', '"real-cart-sentinel"'));
  await Promise.all([
    page.waitForURL('**/index.html'),
    page.locator('[data-preview-store]').click()
  ]);

  await page.goto(`/products/${encodeURIComponent(studioProduct.handle)}/`, { waitUntil: 'load' });
  await page.locator('#add-button').click();
  await expect(page.locator('#add-confirmation')).toBeVisible();
  await page.goto('/cart.html', { waitUntil: 'load' });
  await expect(page.locator('[data-checkout]')).toContainText('Practice checkout');
  await Promise.all([
    page.waitForURL('**/practice-checkout.html'),
    page.locator('[data-checkout]').click()
  ]);
  await page.locator('#practice-acknowledge').check();
  await page.getByRole('button', { name: 'Place practice order →' }).click();
  await expect(page.locator('.practice-complete')).toContainText('No payment, reservation, customer message, or real order was created.');
  await expect(page.locator('#main')).toBeFocused();
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(0);
  const successClearance = await page.evaluate(() => {
    const heading = document.querySelector('.practice-complete h1')?.getBoundingClientRect();
    const header = document.querySelector('.site-header')?.getBoundingClientRect();
    return heading && header ? heading.top - header.bottom : -1;
  });
  expect(successClearance).toBeGreaterThanOrEqual(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(0);
  await captureProof(page, 'practice-order-success.png');

  await page.locator('.practice-complete a[href="studio.html?tab=orders"]').click();
  await expect(page.locator('.studio-order')).toContainText(studioProduct.title);
  const status = page.locator('[data-order-status]').first();
  await status.selectOption('ready_for_pickup');
  await expect(page.locator('[data-order-status]').first()).toHaveValue('ready_for_pickup');
  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('[data-order-status]').first()).toHaveValue('ready_for_pickup');

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('kigb-owner-studio-v1')));
  expect(stored.orders).toHaveLength(1);
  expect(stored.orders[0].status).toBe('ready_for_pickup');
  expect(stored.orders[0].items[0].productHandle).toBe(studioProduct.handle);
  expect(await page.evaluate(() => localStorage.getItem('kigb-studio-cart-v1'))).toBe('[]');
  expect(await page.evaluate(() => localStorage.getItem('kigb-cart-v1'))).toBe('"real-cart-sentinel"');
  expect(merchantRequests).toEqual([]);
});

test('a stale normal-store tab cannot submit after Owner Studio is activated elsewhere', async ({ context, page }) => {
  const contactRequests = [];
  await context.route('https://kissitgoodbuy.net/contact**', route => {
    contactRequests.push(`${route.request().method()} ${route.request().url()}`);
    return route.abort('blockedbyclient');
  });
  await page.goto('/index.html', { waitUntil: 'load' });
  await page.locator('.newsletter-form [name="contact[email]"]').fill('practice-only@example.test');

  const ownerTab = await context.newPage();
  await ownerTab.goto('/studio.html', { waitUntil: 'load' });
  await signInToStudio(ownerTab);
  await Promise.all([
    ownerTab.waitForURL('**/index.html'),
    ownerTab.locator('[data-preview-store]').click()
  ]);
  await expect.poll(() => page.evaluate(() => window.KIGBStudioState.read().active)).toBe(true);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load' }),
    page.locator('.newsletter-form button[type="submit"]').click()
  ]);
  await expect(page.locator('.owner-preview-bar')).toContainText('Your practice storefront');
  expect(contactRequests).toEqual([]);
  await ownerTab.close();
});

test('practice newsletter and consignment activity stay local and support follow-up status', async ({ context, page }) => {
  const contactRequests = [];
  await context.route('https://kissitgoodbuy.net/contact**', route => {
    contactRequests.push(`${route.request().method()} ${route.request().url()}`);
    return route.abort('blockedbyclient');
  });
  const merchantRequests = watchMerchantDataRequests(page);
  await page.goto('/studio.html', { waitUntil: 'load' });
  await signInToStudio(page);
  await Promise.all([
    page.waitForURL('**/index.html'),
    page.locator('[data-preview-store]').click()
  ]);

  // Rehearse on a slow reload: the HTML form is visible before the preview scripts.
  let resumeStartup;
  const waiting = new Promise(resolve => { resumeStartup = resolve; });
  await page.route('**/app.js*', async route => {
    await waiting;
    await route.continue();
  });
  await page.reload({ waitUntil: 'commit' });
  const subscribe = page.locator('.newsletter-form button[type="submit"]');
  const email = page.locator('#newsletter-email');
  try {
    await email.fill('practice-only@example.test');
    await expect(subscribe).toBeDisabled();
    await email.press('Enter');
  } finally { resumeStartup(); }
  await page.waitForLoadState('load');
  await expect(email).toHaveValue('practice-only@example.test');
  await expect(subscribe).toBeEnabled();
  expect(contactRequests).toEqual([]);
  await subscribe.click();
  await expect(page.locator('#toast')).toContainText('Practice signup recorded in Owner Studio');
  expect(contactRequests).toEqual([]);

  await page.goto('/consign.html', { waitUntil: 'load' });
  const localUrl = page.url();
  await page.locator('#your-name').fill('Practice Owner');
  await page.locator('#item-category').selectOption({ label: 'Lighting' });
  await page.locator('#item-description').fill('A sample brass floor lamp');
  await page.locator('#item-condition').selectOption({ label: 'Very good — minor visible wear' });
  await page.locator('#item-notes').fill('A small practice-only scuff is noted near the base.');
  await page.locator('#consignment-form button[type="submit"]').click();
  const draft = page.locator('#email-ready');
  await expect(draft).toBeFocused();
  await page.locator('#item-notes').fill('Two small marks on the base.');
  await expect(draft).toBeHidden();
  await page.getByRole('button', { name: 'Update email draft' }).click();
  await expect(page.locator('#email-body')).toHaveValue(/Two small marks/);
  await expect(page.locator('#email-launch')).toHaveAttribute('href', /Two%20small%20marks/);
  await expect(draft).toBeFocused();
  await page.locator('[data-practice-inquiry]').click();
  await expect(page.locator('[data-practice-inquiry]')).toBeDisabled();
  await page.getByRole('button', { name: 'Update email draft' }).click();
  await expect(page.locator('[data-practice-inquiry]')).toBeDisabled();
  await expect(page.locator('#toast')).toContainText('Practice inquiry recorded in Owner Studio');
  expect(page.url()).toBe(localUrl);
  expect(contactRequests).toEqual([]);

  await page.goto('/studio.html?tab=activity', { waitUntil: 'load' });
  await expect(page.locator('.studio-activity-card')).toHaveCount(2);
  await expect(page.locator('.studio-message-list')).toContainText('Practice newsletter signup');
  await expect(page.locator('.studio-message-list')).toContainText('Practice consignment inquiry');
  await page.locator('[data-message-status]').first().selectOption('reviewed');
  await expect(page.locator('[data-message-status]').first()).toHaveValue('reviewed');
  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('[data-message-status]').first()).toHaveValue('reviewed');

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('kigb-owner-studio-v1')));
  expect(stored.messages).toHaveLength(2);
  expect(stored.messages.some(message => message.status === 'reviewed')).toBe(true);
  expect(contactRequests).toEqual([]);
  expect(merchantRequests).toEqual([]);
});

test('Owner Studio resizes a large phone-style photo into a bounded local sample item', async ({ page }) => {
  await page.goto('/studio.html', { waitUntil: 'load' });
  await signInToStudio(page);
  await page.locator('[data-studio-tab="inventory"]').click();
  const form = page.locator('#studio-custom-product-form');
  await form.locator('[name="title"]').fill('Browser QA photo sample');
  await form.locator('[name="price"]').fill('275');
  await form.locator('[name="category"]').fill('Lighting');
  await form.locator('[name="dimensionsRaw"]').fill('18 W × 18 D × 31 H');

  const generated = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1400;
    canvas.height = 1000;
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(canvas.width, canvas.height);
    let random = 0x51f15e;
    for (let index = 0; index < pixels.data.length; index += 4) {
      random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
      pixels.data[index] = random & 255;
      pixels.data[index + 1] = (random >>> 8) & 255;
      pixels.data[index + 2] = (random >>> 16) & 255;
      pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.96));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    return { base64: btoa(binary), type: blob.type, size: blob.size };
  });
  expect(generated.size).toBeGreaterThan(150 * 1024);
  await form.locator('[name="imageFile"]').setInputFiles({
    name: 'phone-photo.jpg',
    mimeType: generated.type,
    buffer: Buffer.from(generated.base64, 'base64')
  });
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('.studio-message')).toContainText('Sample piece added to the practice inventory.');
  await expect(page.locator('.studio-custom-product')).toContainText('Browser QA photo sample');

  const customProduct = await page.evaluate(() => window.KIGBStudioState.read().draft.customProducts.at(-1));
  expect(customProduct.imageUrl).toMatch(/^data:image\/(webp|jpeg);base64,/);
  expect(Buffer.from(customProduct.imageUrl.split(',')[1], 'base64').length).toBeLessThanOrEqual(150 * 1024);
});

test('Owner Studio does not claim a sample photo was saved when browser persistence is blocked', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function guardedSetItem(key, value) {
      if (key === 'kigb-owner-studio-v1') throw new DOMException('Storage blocked', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await page.goto('/studio.html', { waitUntil: 'load' });
  await signInToStudio(page);
  await page.locator('[data-studio-tab="inventory"]').click();
  const form = page.locator('#studio-custom-product-form');
  await form.locator('[name="title"]').fill('Unsaved photo sample');
  await form.locator('[name="price"]').fill('125');
  await form.locator('[name="imageFile"]').setInputFiles({
    name: 'sample.jpg',
    mimeType: 'image/jpeg',
    buffer: readFileSync(path.join(buildRoot, 'assets/editorial/facebook-geometric-front-chest.jpg'))
  });
  await form.locator('button[type="submit"]').click();

  await expect(page.locator('.studio-message.error')).toContainText('kept for this visit only');
  await expect(page.locator('.studio-message')).not.toContainText('saved');
  await expect(page.locator('.studio-custom-product')).toContainText('Unsaved photo sample');
  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('.studio-custom-list')).not.toContainText('Unsaved photo sample');
});

test('Owner Studio warns when sign-out cannot persist the end of preview mode', async ({ page }) => {
  await page.goto('/studio.html', { waitUntil: 'load' });
  await signInToStudio(page);
  await Promise.all([
    page.waitForURL('**/index.html'),
    page.locator('[data-preview-store]').click()
  ]);
  await page.getByRole('link', { name: 'Edit in Owner Studio →', exact: true }).click();
  await expect(page.locator('.studio-tabs')).toBeVisible();
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function guardedSetItem(key, value) {
      if (key === 'kigb-owner-studio-v1') throw new DOMException('Storage blocked', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });

  await page.locator('[data-studio-signout]').click();
  await expect(page.locator('#studio-login-form')).toBeVisible();
  await expect(page.locator('#studio-login-error')).toContainText('Browser storage could not save the end of preview mode');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kigb-owner-studio-v1')).active)).toBe(true);
});

test('Owner Studio stays in place when browser storage cannot persist preview mode', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function guardedSetItem(key, value) {
      if (key === 'kigb-owner-studio-v1') throw new DOMException('Storage blocked', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await page.goto('/studio.html', { waitUntil: 'load' });
  await signInToStudio(page);
  await page.locator('[data-preview-store]').click();
  await expect(page).toHaveURL(/\/studio\.html$/);
  await expect(page.locator('.studio-message.error')).toContainText('cross-page preview cannot open reliably');
  await expect(page.locator('.studio-persistence')).toContainText('Browser storage is unavailable');
});


test('a consignment inquiry typed during startup stays in its form and off the URL', async ({ page }) => {
  let start;
  const boot = new Promise(resolve => { start = resolve; });
  await page.route('**/app.js*', async route => {
    await boot;
    await route.continue();
  });
  try {
    await page.goto('/consign.html', { waitUntil: 'commit' });
    await page.getByLabel('Your name').fill('Sample seller');
    await page.locator('#item-category').selectOption({ label: 'Seating' });
    await page.locator('#item-description').fill('Oak chair');
    await page.locator('#item-condition').selectOption({ index: 1 });
    await page.locator('#item-notes').fill('One mark on the back.');
    await expect(page.getByRole('button', { name: 'Prepare my email' })).toBeDisabled();
    await page.locator('#item-description').press('Enter');
    await expect(page).toHaveURL(/consign\.html$/);
  } finally {
    start();
  }
  await page.waitForLoadState('load');
  await expect(page.locator('#item-description')).toBeFocused();
  await page.getByRole('button', { name: 'Prepare my email' }).click();
  await expect(page.locator('#email-body')).toHaveValue(/Oak chair/);
  await expect(page.locator('#email-body')).toHaveValue(/One mark on the back/);
  await expect(page).toHaveURL(/consign\.html$/);
});
