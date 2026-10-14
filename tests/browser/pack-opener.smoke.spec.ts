import { test, expect, Page } from '@playwright/test';

const STORAGE_KEYS = {
  STATS: 'brainrot-stats-v1',
  COLLECTION: 'brainrot-found-collection-v1',
  HISTORY: 'brainrot-history-v1',
};

/**
 * Configure page to capture unexpected JS errors and block external network requests.
 */
async function setupPageSafetyAndMonitoring(page: Page) {
  const uncaughtErrors: Error[] = [];
  const consoleErrors: string[] = [];

  page.on('pageerror', (err) => {
    uncaughtErrors.push(err);
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Filter out intentionally blocked external network failures or audio load issues if any
      if (!text.includes('net::ERR_FAILED') && !text.includes('Failed to load resource')) {
        consoleErrors.push(text);
      }
    }
  });

  // Prevent external network traffic (relays, GitHub API, social sites)
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (
      url.startsWith('http://localhost:') ||
      url.startsWith('http://127.0.0.1:') ||
      url.startsWith('data:') ||
      url.startsWith('blob:')
    ) {
      route.continue();
    } else {
      // Abort external request to prevent relay/GitHub/social writes
      route.abort();
    }
  });

  return { uncaughtErrors, consoleErrors };
}

/**
 * Open a pack manually by tearing along the tear line using pointer drag or keyboard.
 */
async function openPackManually(page: Page) {
  const packShell = page.locator('.pack-shell');
  await expect(packShell).toBeVisible({ timeout: 10000 });

  const box = await packShell.boundingBox();
  expect(box).not.toBeNull();

  if (box) {
    // Tear line is located at ~19% of pack height
    const startX = box.x + box.width * 0.1;
    const endX = box.x + box.width * 0.9;
    const tearY = box.y + box.height * 0.19;

    await page.mouse.move(startX, tearY);
    await page.mouse.down();
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      const currentX = startX + ((endX - startX) * i) / steps;
      await page.mouse.move(currentX, tearY);
    }
    await page.mouse.up();
  }

  // If the tear didn't trigger via mouse drag, press Space on the pack shell
  const isCut = await page.locator('.pack-shell.is-cut, .card-reveal-area').count();
  if (isCut === 0) {
    await packShell.focus();
    await page.keyboard.press('Space');
  }
}

/**
 * Reveal all cards until the pack summary is displayed.
 */
async function finishReveal(page: Page) {
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 10000 });

  const skipBtn = page.locator('button.reveal-skip');
  const summary = page.locator('.pack-summary');

  const startTime = Date.now();
  const maxTimeout = 20000;

  while (Date.now() - startTime < maxTimeout) {
    if (await summary.isVisible()) {
      break;
    }

    if (await skipBtn.isVisible() && await skipBtn.isEnabled()) {
      await skipBtn.click();
    } else {
      const activeCard = page.locator('.reveal-card, .active-card-container');
      if (await activeCard.isVisible()) {
        await activeCard.click({ force: true });
      } else {
        await page.keyboard.press('Space');
      }
    }

    await page.waitForTimeout(300);
  }

  await expect(summary).toBeVisible({ timeout: 10000 });
}

test.describe('Pack Opener Chromium Smoke Test', () => {
  test('opens one pack manually, finishes reveal, and retains recorded result after reload', async ({ page }) => {
    const { uncaughtErrors, consoleErrors } = await setupPageSafetyAndMonitoring(page);

    // 1. Load application at configured base path
    await page.goto('./');

    // Verify main app logo
    await expect(page.locator('.app-logo')).toBeVisible();

    // 2. Open pack manually
    await openPackManually(page);

    // 3. Complete card reveal
    await finishReveal(page);

    // 4. Assert summary displays expected results
    const summaryTitle = page.locator('.summary-title');
    await expect(summaryTitle).toBeVisible();
    const handText = await summaryTitle.textContent();
    expect(handText && handText.trim().length > 0).toBeTruthy();

    const cardItems = page.locator('.summary-cards li');
    await expect(cardItems).toHaveCount(5);

    // 5. Assert progress is recorded in localStorage (packsOpened === 1)
    const statsBeforeReload = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    }, STORAGE_KEYS.STATS);

    expect(statsBeforeReload).not.toBeNull();
    expect(statsBeforeReload.packsOpened).toBe(1);

    const collectionBeforeReload = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    }, STORAGE_KEYS.COLLECTION);

    expect(collectionBeforeReload).not.toBeNull();
    expect(Object.keys(collectionBeforeReload).length).toBeGreaterThan(0);

    // 6. Reload page and assert persistence
    await page.reload();
    await expect(page.locator('.app-logo')).toBeVisible();

    // Assert localStorage survived reload
    const statsAfterReload = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    }, STORAGE_KEYS.STATS);

    expect(statsAfterReload).not.toBeNull();
    expect(statsAfterReload.packsOpened).toBe(1);

    // Assert UI reflects recorded progress (open Profile modal)
    const profileBtn = page.locator('.app-nav-item:has-text("Profile")');
    await expect(profileBtn).toBeVisible();
    await profileBtn.click();

    const profileSheet = page.locator('.sheet:has-text("Profile")');
    await expect(profileSheet).toBeVisible();

    // Inside profile sheet, history or summary section reflects 1 pack opened
    await expect(profileSheet).toContainText('All packs · 1');

    // Close Profile sheet
    const closeBtn = profileSheet.locator('button[aria-label="Close"], button.sheet-close');
    await closeBtn.click();
    await expect(profileSheet).not.toBeVisible();

    // Open Collection sheet and check found cards
    const collectionBtn = page.locator('.app-nav-item:has-text("Collection")');
    await expect(collectionBtn).toBeVisible();
    await collectionBtn.click();

    const collectionSheet = page.locator('.sheet:has-text("Collection")');
    await expect(collectionSheet).toBeVisible();

    // Verify collection sheet displays found cards
    const collectionSet = collectionSheet.locator('.collection-set');
    await expect(collectionSet.first()).toBeVisible();

    // Close Collection sheet
    const closeCollectionBtn = collectionSheet.locator('button[aria-label="Close"], button.sheet-close');
    await closeCollectionBtn.click();

    // 7. Verify no uncaught application errors occurred during the test
    expect(uncaughtErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
