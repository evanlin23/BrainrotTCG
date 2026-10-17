import { test, expect } from '@playwright/test';
import { monitor } from './support';

// Editing the display name on Profile (#183). The desktop project is an emulated 1280x800 window and the
// mobile one is Playwright's emulated Pixel 5: Chromium emulation, not real devices, so a phone's own
// keyboard and touch behaviour still need a person with a phone. Nothing here is sent anywhere.

test.describe('Profile display name in emulated Chromium (not real devices)', () => {
  test('rename saves and is announced, Escape cancels, and a blank name keeps the old one', async ({ page, baseURL }) => {
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await page.goto('./#/profile');
    const profile = page.getByRole('main', { name: 'Profile', exact: true });
    const heading = profile.getByRole('heading', { name: 'Browser smoke fixture', exact: true });
    await expect(heading).toBeVisible();
    const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('brainrot-player-v1')!) as { name: string; secretKey: string });
    const edit = profile.getByRole('button', { name: 'Edit name', exact: true });
    const field = profile.getByRole('textbox', { name: 'Name shown on shared pulls', exact: true });
    const status = profile.getByRole('status');
    const sideScroll = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

    // Escape closes only the field: the page stays, focus returns to Edit name, nothing is written.
    await edit.click();
    await expect(field).toBeFocused();
    await field.fill('Discarded name');
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(profile).toBeVisible();
    await expect(edit).toBeFocused();
    await expect(heading).toBeVisible();
    expect((await stored()).name).toBe('Browser smoke fixture');

    // A blank name is refused with a reason, and the field stays open to fix it.
    await edit.click();
    await field.fill('   ');
    await profile.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(status).toHaveText("A name can't be blank, so your current name stays.");
    await expect(field).toBeVisible();
    expect((await stored()).name).toBe('Browser smoke fixture');

    // Enter saves, announces it, closes the field and keeps the same player.
    const before = (await stored()).secretKey;
    await field.fill('Renamed fixture');
    expect(await sideScroll()).toBe(false);
    await page.keyboard.press('Enter');
    await expect(status).toHaveText('Display name saved.');
    await expect(field).toHaveCount(0);
    await expect(profile.getByRole('heading', { name: 'Renamed fixture', exact: true })).toBeVisible();
    await expect(edit).toBeFocused();
    expect(await stored()).toMatchObject({ name: 'Renamed fixture', secretKey: before });

    // The new name survives a reload.
    await page.reload();
    await expect(page.getByRole('main', { name: 'Profile', exact: true }).getByRole('heading', { name: 'Renamed fixture', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
