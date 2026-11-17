import { expect, test } from '@playwright/test';

async function signIn(page) {
  await page.goto('/studio.html');
  await page.locator('[name="username"]').fill('Chelsea');
  await page.locator('[name="password"]').fill('Chelsea');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('button', { name: /Words & contact/ }).click();
  await expect(page.locator('#studio-content-form')).toBeVisible();
}

async function signInToDesign(page) {
  await page.goto('/studio.html');
  await page.locator('[name="username"]').fill('Chelsea');
  await page.locator('[name="password"]').fill('Chelsea');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.locator('.design-panel')).toBeVisible();
}

test('palette choices identify the current saved palette after selection and reload', async ({ page }) => {
  await page.goto('/studio.html');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await signInToDesign(page);

  const original = page.locator('[data-preset="original"]');
  const collected = page.locator('[data-preset="collected"]');
  await expect(original).toHaveAttribute('aria-pressed', 'true');
  await expect(original).toContainText('Current palette');
  await expect(collected).toHaveAttribute('aria-pressed', 'false');

  await collected.click();
  await expect(collected).toHaveAttribute('aria-pressed', 'true');
  await expect(collected).toContainText('Current palette');
  await expect(original).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.studio-message')).toContainText('Collected color palette applied.');

  await page.reload();
  await expect(collected).toHaveAttribute('aria-pressed', 'true');
  await expect(collected).toContainText('Current palette');

  await page.locator('[data-studio-tab="versions"]').click();
  await page.locator('#studio-version-form [name="name"]').fill('Collected palette checkpoint');
  await page.locator('#studio-version-form button[type="submit"]').click();
  await page.locator('[data-studio-tab="design"]').click();
  await page.locator('[data-preset="twilight"]').click();
  await page.locator('[data-studio-tab="versions"]').click();
  await page.locator('[data-restore-version]').click();
  await page.locator('[data-studio-tab="design"]').click();
  await expect(collected).toHaveAttribute('aria-pressed', 'true');
  await expect(collected).toContainText('Current palette');

  const coral = page.locator('[name="coral"][data-design-field]');
  await coral.fill('#c95747');
  await coral.press('Tab');
  await expect(page.locator('[data-preset][aria-pressed="true"]')).toHaveCount(0);
});

test('two owner tabs merge unrelated content and offer explicit same-field choices', async ({ context, page }) => {
  await page.goto('/studio.html');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await signIn(page);

  const other = await context.newPage();
  await signIn(other);

  // A newer save after the comparison appears must require another explicit choice.
  await page.locator('[name="heroTitle"]').fill('My headline in the first tab');
  await other.locator('[name="heroTitle"]').fill('Newer headline from the other tab');
  await other.getByRole('button', { name: 'Save these words' }).click();
  await page.getByRole('button', { name: 'Save these words' }).click();
  const conflict = page.locator('[data-content-conflict]');
  await expect(conflict).toBeVisible();
  await expect(conflict.locator('[data-conflict-saved]')).toHaveText('Newer headline from the other tab');

  await other.locator('[name="heroTitle"]').fill('Newest headline after the comparison');
  await other.getByRole('button', { name: 'Save these words' }).click();
  await expect(conflict.locator('[data-conflict-saved]')).toHaveText('Newer headline from the other tab');
  await conflict.getByRole('button', { name: 'Keep my entry' }).click();
  await expect(conflict).toBeVisible();
  await expect(conflict.locator('[data-conflict-mine]')).toHaveText('My headline in the first tab');
  await expect(conflict.locator('[data-conflict-saved]')).toHaveText('Newest headline after the comparison');
  await conflict.getByRole('button', { name: 'Keep my entry' }).click();
  await expect(conflict).toBeHidden();

  // Two simultaneous field conflicts resolve in sequence while another edit survives.
  await other.reload();
  await other.getByRole('button', { name: /Words & contact/ }).click();
  await page.locator('[name="heroTitle"]').fill('My final headline');
  await page.locator('[name="heroAccent"]').fill('My emphasized line.');
  await page.locator('[name="heroIntro"]').fill('Keep this other unsaved introduction.');
  await other.locator('[name="heroTitle"]').fill('Other tab final headline');
  await other.locator('[name="heroAccent"]').fill('Other tab emphasized line.');
  await other.getByRole('button', { name: 'Save these words' }).click();
  await page.getByRole('button', { name: 'Save these words' }).click();

  await expect(conflict).toBeVisible();
  await expect(conflict.locator('[data-conflict-title]')).toContainText('Opening line');
  await page.locator('[name="email"]').fill('not-an-email');
  await conflict.getByRole('button', { name: 'Keep my entry' }).click();
  await expect(conflict.locator('[data-conflict-title]')).toContainText('Opening line');
  await page.locator('[name="email"]').fill('info@kissitgoodbuy.net');
  await conflict.getByRole('button', { name: 'Keep my entry' }).click();
  await expect(conflict).toBeVisible();
  await expect(conflict.locator('[data-conflict-title]')).toContainText('Emphasized line');
  await conflict.getByRole('button', { name: 'Use newer saved value' }).click();
  await expect(conflict).toBeHidden();
  await expect(page.locator('[name="heroTitle"]')).toHaveValue('My final headline');
  await expect(page.locator('[name="heroAccent"]')).toHaveValue('Other tab emphasized line.');

  await other.reload();
  await other.getByRole('button', { name: /Words & contact/ }).click();
  await expect(other.locator('[name="heroTitle"]')).toHaveValue('My final headline');
  await expect(other.locator('[name="heroIntro"]')).toHaveValue('Keep this other unsaved introduction.');
  await expect(other.locator('[name="heroAccent"]')).toHaveValue('Other tab emphasized line.');
});
