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
  ['planner', '/planner.html'],
  ['owner studio', '/studio.html'],
  ['practice checkout', '/practice-checkout.html'],
  ['visit', '/visit.html'],
  ['shortlist', '/shortlist.html'],
  ['bag', '/cart.html'],
  ['product', `/products/${encodeURIComponent(firstProduct.handle)}/`]
];
const viewports = [
  ['phone', { width: 320, height: 812 }],
  ['wide phone', { width: 390, height: 844 }],
  ['desktop', { width: 1440, height: 1000 }]
];

test.beforeEach(async ({ page }) => {
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XhGbWQAAAABJRU5ErkJggg==', 'base64');
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
    return issues;
  });
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
  await expect(coralPicker).toHaveValue('#e58a78');
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

  await page.locator('.newsletter-form [name="contact[email]"]').fill('practice-only@example.test');
  await page.locator('.newsletter-form button[type="submit"]').click();
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
  await expect(page.locator('#email-ready')).toBeVisible();
  await page.locator('[data-practice-inquiry]').click();
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
  await expect(page.locator('.studio-message')).toContainText('resized browser-local copy');
  await expect(page.locator('.studio-custom-product')).toContainText('Browser QA photo sample');

  const customProduct = await page.evaluate(() => window.KIGBStudioState.read().draft.customProducts.at(-1));
  expect(customProduct.imageUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
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
