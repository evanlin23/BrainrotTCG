import { test, expect, type Locator, type Page } from '@playwright/test';
import { monitor } from './support';

/**
 * The Settings sound slider stays readable at enlarged text (#618): at 360x640 and 390x844, with the
 * root text at 16 px and at 32 px (200%), the label, description, range and current value all sit
 * inside the panel without overlapping, at 0, 50 and 100%, and the range still answers a pointer and
 * the keyboard. Sizes are emulated viewports; 200% text is emulated by doubling the root font size
 * the rem tokens use. Geometry is read from the layout before anything is clicked, because the
 * automatic scroll before a click would not reveal a control that is clipped sideways.
 */

const SETTINGS_KEY = 'brainrot-settings-v1';
const PHONES = [
  { name: '360x640', width: 360, height: 640 },
  { name: '390x844', width: 390, height: 844 },
];
const ZOOMS = [
  { name: 'default text', percent: 100, rootPx: 16 },
  { name: '200% text', percent: 200, rootPx: 32 },
];
const VALUES = [
  { percent: 0, text: 'Off' },
  { percent: 50, text: '50%' },
  { percent: 100, text: '100%' },
];

/** Opens Settings directly with the effects volume stored as `volume`, at the given root text size. */
async function openSettings(page: Page, baseURL: string, volume: number, zoomPercent: number) {
  const errors = await monitor(page, baseURL);
  const origin = new URL(baseURL).origin;
  // After monitor's fixture, so this player's sound starts where the case says.
  await page.addInitScript(({ key, volume, origin }) => {
    if (window.location.origin !== origin) return;
    try { localStorage.setItem(key, JSON.stringify({ effectsVolume: volume })); } catch { /* storage blocked */ }
  }, { key: SETTINGS_KEY, volume, origin });
  await page.goto('./#/settings');
  const main = page.getByRole('main', { name: 'Settings', exact: true });
  const slider = main.getByRole('slider', { name: 'Sound effects', exact: true });
  await expect(slider).toBeAttached();
  if (zoomPercent !== 100) await page.addStyleTag({ content: `html { font-size: ${zoomPercent}% !important; }` });
  await page.evaluate(() => document.fonts.ready);
  return { errors, slider };
}

interface Box { left: number; right: number; top: number; bottom: number }

/** Where the sound row's parts sit right now, in viewport pixels, without scrolling anything. */
function rowLayout(slider: Locator) {
  return slider.evaluate((input) => {
    const box = (el: Element | null): Box => {
      const r = el!.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const row = input.closest('.settings-row')!;
    const value = row.querySelector<HTMLElement>('.settings-value')!;
    return {
      viewport: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      rootPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
      panel: box(input.closest('.settings-panel')),
      row: box(row),
      label: box(row.querySelector('.settings-label')),
      desc: box(row.querySelector('.settings-desc')),
      group: box(row.querySelector('.settings-slider')),
      range: box(input),
      value: box(value),
      valueText: value.textContent,
      valueClipped: value.scrollWidth > value.clientWidth,
    };
  });
}

const overlaps = (a: Box, b: Box) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const within = (inner: Box, outer: Box) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5;

/** Every part of the row is readable and usable: whole inside the panel and screen, and none on another. */
async function expectReadable(slider: Locator, label: string, expectedText: string) {
  const l = await rowLayout(slider);
  expect(l.valueText, `${label}: the value shown`).toBe(expectedText);
  expect(l.pageWidth, `${label}: the page does not scroll sideways`).toBeLessThanOrEqual(l.viewport);
  expect(l.panel.left, `${label}: the panel starts on screen`).toBeGreaterThanOrEqual(0);
  expect(l.panel.right, `${label}: the panel ends on screen`).toBeLessThanOrEqual(l.viewport);
  for (const [name, part] of Object.entries({ label: l.label, desc: l.desc, group: l.group, range: l.range, value: l.value })) {
    expect(part.right - part.left, `${label}: the ${name} has width`).toBeGreaterThan(0);
    expect(within(part, l.panel), `${label}: the ${name} stays inside the panel`).toBe(true);
    expect(part.right, `${label}: the ${name} stays on screen`).toBeLessThanOrEqual(l.viewport);
  }
  expect(l.value.right - l.value.left, `${label}: the whole value is drawn`).toBeGreaterThan(20);
  expect(l.valueClipped, `${label}: the value is not cut off by its own box`).toBe(false);
  expect(l.range.right - l.range.left, `${label}: the range is wide enough to use`).toBeGreaterThanOrEqual(88);
  expect(overlaps(l.range, l.value), `${label}: the range clears the value`).toBe(false);
  for (const [name, text] of Object.entries({ label: l.label, desc: l.desc })) {
    expect(overlaps(text, l.range), `${label}: the ${name} clears the range`).toBe(false);
    expect(overlaps(text, l.value), `${label}: the ${name} clears the value`).toBe(false);
  }
  return l;
}

const storedVolume = (page: Page) => page.evaluate((key) => {
  try { return (JSON.parse(localStorage.getItem(key) ?? 'null') as { effectsVolume?: number } | null)?.effectsVolume; } catch { return undefined; }
}, SETTINGS_KEY);

for (const phone of PHONES) {
  for (const zoom of ZOOMS) {
    for (const start of VALUES) {
      test(`the sound slider fits ${phone.name} at ${zoom.name}, from ${start.text}, and still adjusts (#618)`, async ({ page, baseURL }, testInfo) => {
        test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
        await page.setViewportSize({ width: phone.width, height: phone.height });
        const { errors, slider } = await openSettings(page, baseURL!, start.percent / 100, zoom.percent);
        const where = `${phone.name}, ${zoom.name}`;

        // Read before touching anything: a click would scroll the row into view and could hide a clip.
        const first = await expectReadable(slider, `${where}, ${start.text}`, start.text);
        expect(first.rootPx, `${where}: the root text size`).toBe(zoom.rootPx);
        await expect(slider).toHaveValue(String(start.percent));

        // Pointer: the far ends and the middle of the range's track.
        await slider.scrollIntoViewIfNeeded();
        const track = (await slider.boundingBox())!;
        for (const [fraction, expected] of [[0.5, VALUES[1]], [0, VALUES[0]], [1, VALUES[2]]] as const) {
          // The ends are a pixel in, off the rounded border-box edge; the middle is exact.
          const x = fraction === 0 ? 1 : fraction === 1 ? track.width - 1 : track.width / 2;
          await slider.click({ position: { x, y: track.height / 2 } });
          await expect(slider, `${where}: pointer to ${expected.text}`).toHaveValue(String(expected.percent));
          await expect(slider).toHaveAttribute('aria-valuetext', expected.text);
          await expectReadable(slider, `${where}, pointer at ${expected.text}`, expected.text);
          await expect.poll(() => storedVolume(page), { message: `${where}: ${expected.text} is saved` }).toBe(expected.percent / 100);
        }

        // Keyboard: the ends, then one 5% step down and back up.
        await slider.focus();
        const keys: Array<[string, string, number]> = [['Home', 'Off', 0], ['End', '100%', 100], ['ArrowLeft', '95%', 95], ['ArrowRight', '100%', 100]];
        for (const [key, text, percent] of keys) {
          await page.keyboard.press(key);
          await expect(slider, `${where}: ${key}`).toHaveValue(String(percent));
          await expect(slider).toHaveAttribute('aria-valuetext', text);
          await expectReadable(slider, `${where}, ${key} at ${text}`, text);
          await expect.poll(() => storedVolume(page), { message: `${where}: ${text} is saved` }).toBe(percent / 100);
        }
        expect(errors).toEqual([]);
      });
    }
  }
}

test('the sound slider keeps its one-line row on a desktop window (#618)', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'The desktop counterpart of the phone checks above.');
  await page.setViewportSize({ width: 1280, height: 800 });
  const { errors, slider } = await openSettings(page, baseURL!, 0.5, 100);
  const l = await expectReadable(slider, 'desktop', '50%');
  // Text on the left, range and value on the right, all on one line, the range at its 8.5rem width.
  expect(l.group.left, 'the slider sits beside the text').toBeGreaterThanOrEqual(l.label.right);
  expect(l.group.top, 'the slider is on the text line').toBeLessThan(l.desc.bottom);
  expect(l.range.right - l.range.left, 'the range keeps its width').toBeCloseTo(8.5 * l.rootPx, 0);
  await slider.focus();
  await page.keyboard.press('End');
  await expect(slider).toHaveValue('100');
  await expectReadable(slider, 'desktop at 100%', '100%');
  expect(errors).toEqual([]);
});
