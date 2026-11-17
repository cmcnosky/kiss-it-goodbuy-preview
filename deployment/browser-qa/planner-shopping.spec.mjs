import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const buildRoot = path.resolve(process.env.KIGB_BROWSER_QA_ROOT || path.resolve(here, '../../.build/dist'));
const inventory = JSON.parse(readFileSync(path.join(buildRoot, 'inventory.json'), 'utf8'));
const plannableProduct = inventory.products.find(product =>
  product?.available &&
  product?.itemNumber &&
  product?.variants?.length === 1 &&
  product.variants[0]?.available &&
  !/gift.?card/i.test(`${product.title || ''} ${product.sourceProductType || ''}`)
);

if (!plannableProduct) throw new Error('Browser fixture needs an available, single-variant furniture or decor product with an item number.');

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

test('shared shortlist keeps its piece through planner, bag, reload, and removal', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const itemNumber = encodeURIComponent(plannableProduct.itemNumber);
  const plannerUrl = `/planner.html?items=${itemNumber}`;

  await page.goto('/index.html', { waitUntil: 'load' });
  await page.evaluate(() => {
    localStorage.removeItem('kigb-favorites');
    localStorage.removeItem('kigb-cart-v1');
    sessionStorage.removeItem('kigb-fit-pickup-plan-v1');
    sessionStorage.removeItem('kigb-fit-pickup-confirmed-v1');
  });
  await page.goto(`/shortlist.html?items=${itemNumber}`, { waitUntil: 'load' });
  await expect(page.locator('.shortlist-tools')).toContainText('shared shortlist');
  await expect(page.locator('.saved-count')).toHaveText('0');
  const shortlistTitle = (await page.locator('.compare-table thead th').nth(1).locator('span').innerText()).trim();

  const planLink = page.getByRole('link', { name: /Plan fit & pickup/ });
  await expect(planLink).toHaveAttribute('href', `planner.html?items=${itemNumber}`);
  await planLink.click();
  await expect(page).toHaveURL(new RegExp(`planner\\.html\\?items=${itemNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  await expect(page.locator('.planner-piece h2')).toHaveText(shortlistTitle);

  await page.locator('input[name="doorWidth"]').fill('34');
  const add = page.locator('[data-planner-add]');
  await expect(add).toHaveCount(1);
  await add.click();

  const review = page.locator('[data-planner-bag-for]');
  await expect(review).toHaveText(/In your bag · review/);
  await expect(review).toBeFocused();
  await expect(page.locator('.cart-count')).toHaveText('1');
  await expect(page.locator('[data-planner-add]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);

  await review.click();
  await expect(page).toHaveURL(/cart\.html$/);
  await expect(page.locator('.cart-line')).toHaveCount(1);
  await expect(page.locator('.cart-line h2')).toHaveText(shortlistTitle);

  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('.cart-line')).toHaveCount(1);
  await expect(page.locator('.cart-line h2')).toHaveText(shortlistTitle);
  await expect(page.locator('.cart-count')).toHaveText('1');

  const returnToPlanner = page.getByRole('link', { name: /Plan fit & pickup/ });
  await expect(returnToPlanner).toHaveAttribute('href', `planner.html?items=${itemNumber}`);
  await returnToPlanner.click();
  await expect(page).toHaveURL(new RegExp(`planner\\.html\\?items=${itemNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  await expect(page.locator('.planner-piece h2')).toHaveText(shortlistTitle);
  await expect(page.locator('input[name="doorWidth"]')).toHaveValue('34');
  await expect(page.locator('[data-planner-bag-for]')).toHaveText(/In your bag · review/);

  await page.locator('[data-planner-bag-for]').click();
  await expect(page).toHaveURL(/cart\.html$/);
  await expect(page.locator('.cart-line h2')).toHaveText(shortlistTitle);

  await page.locator('[data-remove]').click();
  await expect(page.locator('.cart-line')).toHaveCount(0);
  await expect(page.locator('.cart-count')).toHaveText('0');

  await page.goto(plannerUrl, { waitUntil: 'load' });
  await expect(page.locator('.planner-piece h2')).toHaveText(shortlistTitle);
  await expect(page.locator('input[name="doorWidth"]')).toHaveValue('34');
  await expect(page.locator('[data-planner-add]')).toHaveCount(1);
  await expect(page.locator('[data-planner-bag-for]')).toHaveCount(0);
});
