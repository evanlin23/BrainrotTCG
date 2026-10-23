import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SETS } from '../../content/sets';
import PackCuttingUI from './PackCuttingUI';
import { REFUSAL_COPY, type PackRefusal } from './refusal';

const render = (xs: number[], { pressing = false, nudging = false, fellShort = false, isPackCut = false, waiting = false, refusal = null as PackRefusal | null, cue = null as 'play' | 'still' | null } = {}) =>
  renderToStaticMarkup(
    <PackCuttingUI
      packRef={createRef<HTMLDivElement>()}
      packDesign="pack.png"
      set={SETS[0]}
      refusal={refusal}
      onOpen={() => {}}
      isCutting={xs.length > 1}
      pressing={pressing}
      nudging={nudging}
      fellShort={fellShort}
      isPackCut={isPackCut}
      waiting={waiting}
      cutPoints={xs.map((x) => ({ x, y: 19 }))}
      sparks={[]}
      cue={cue}
    />,
  );

/** The pack shell's classes. */
const shellClasses = (html: string) => (html.match(/class="(pack-shell [^"]*)"/)?.[1] ?? '').split(/\s+/).filter((name) => name && name !== 'quiet-focus');

describe('the opening cue', () => {
  it('draws a finger and a partial tear on the seam, marking the pack with how it plays', () => {
    for (const cue of ['play', 'still'] as const) {
      const html = render([], { cue });
      expect(html).toContain('class="open-cue"');
      expect(html).toContain('open-cue-tear');
      expect(html).toContain('open-cue-finger');
      expect(html).toContain(`data-open-cue="${cue}"`);
    }
  });

  it('is absent without one, and once the pack is torn', () => {
    expect(render([])).not.toContain('open-cue');
    const torn = render([], { cue: 'play', isPackCut: true });
    expect(torn).not.toContain('open-cue');
  });

  it('is never read: the pack\'s name is its label', () => {
    expect(render([], { cue: 'play' })).toMatch(/class="open-cue" aria-hidden="true"/);
  });
});

describe('the idle cue', () => {
  it('lifts the top strip on a sealed pack that sits untouched, with nothing else going on', () => {
    expect(shellClasses(render([]))).toEqual(['pack-shell', 'is-idle']);
  });

  it('waits for the new player\'s finger, and is there once it has retired or was never due', () => {
    expect(shellClasses(render([], { cue: 'play' }))).toEqual(['pack-shell']);
    expect(shellClasses(render([], { cue: 'still' }))).toEqual(['pack-shell']);
    expect(shellClasses(render([], { cue: null }))).toEqual(['pack-shell', 'is-idle']);
  });

  it('is down while the pack is pressed, being cut, torn, refused or showing a hint, and gone for good after the cut', () => {
    expect(shellClasses(render([], { pressing: true }))).not.toContain('is-idle');
    expect(shellClasses(render([20, 30]))).not.toContain('is-idle');
    expect(shellClasses(render([], { isPackCut: true }))).not.toContain('is-idle');
    expect(shellClasses(render([], { isPackCut: true, waiting: true }))).not.toContain('is-idle');
    expect(shellClasses(render([], { nudging: true }))).not.toContain('is-idle');
    expect(shellClasses(render([], { refusal: 'failed' }))).not.toContain('is-idle');
  });

  it('comes back after a short swipe, once the hint has gone', () => {
    expect(shellClasses(render([], { fellShort: true }))).toEqual(['pack-shell', 'is-short']);
    expect(shellClasses(render([], { fellShort: false }))).toEqual(['pack-shell', 'is-idle']);
  });
});

describe('the tear line under a press', () => {
  it('lights up for a press on it before the swipe has a direction, in place of a nudge', () => {
    expect(shellClasses(render([], { pressing: true, nudging: true }))).toEqual(['pack-shell', 'is-pressed']);
    expect(shellClasses(render([], { nudging: true }))).toEqual(['pack-shell', 'is-nudged']);
    expect(shellClasses(render([]))).toEqual(['pack-shell', 'is-idle']);
  });

  it('springs back and says to go farther after a swipe let go short, until the next press (#803)', () => {
    expect(shellClasses(render([], { fellShort: true }))).toEqual(['pack-shell', 'is-short']);
    expect(shellClasses(render([], { fellShort: true, pressing: true }))).toEqual(['pack-shell', 'is-pressed']);
    expect(shellClasses(render([20, 30], { fellShort: true }))).toEqual(['pack-shell', 'is-cutting']);
    const html = render([], { fellShort: true });
    expect(html).toMatch(/(Swipe farther, or tap the pack|Drag farther, or click the pack)</);
  });

  it('drops the short-swipe answer once a retry tears the pack', () => {
    const html = render([], { fellShort: true, isPackCut: true });
    expect(shellClasses(html)).toEqual(['pack-shell', 'is-cut']);
    expect(html).not.toContain('farther');
    expect(html).toContain('aria-label="Opening…"');
  });

  it('hands over to the cut once the swipe draws', () => {
    expect(shellClasses(render([20, 30], { pressing: true }))).toEqual(['pack-shell', 'is-cutting']);
  });
});

describe('the drawn cut', () => {
  it('is a foil seam that fades behind the finger', () => {
    const html = render([20, 30, 40, 50, 60]);
    const svg = html.match(/<svg[^>]*class="cut-line-svg"[^>]*>/)?.[0] ?? '';
    expect(svg).toContain('aria-hidden="true"');
    expect(html.match(/<stop /g)).toHaveLength(5);
    expect(html.match(/class="cut-line"/g)).toHaveLength(1);
    // Four stretches, oldest faintest, each a foil stroke under a white core.
    const stretches = [...html.matchAll(/<g opacity="([\d.]+)"><polyline class="cut-line-foil" stroke="url\(#pack-seam-foil\)" points="([^"]+)"><\/polyline><polyline class="cut-line-core" points="\2"><\/polyline><\/g>/g)];
    expect(stretches.map((match) => match[2])).toEqual(['20,19 30,19', '30,19 40,19', '40,19 50,19', '50,19 60,19']);
    expect(stretches.map((match) => Number(match[1]))).toEqual([...stretches.map((match) => Number(match[1]))].sort((a, b) => a - b));
    expect(Number(stretches[3][1])).toBe(1);
    expect(html).not.toMatch(/#6a0dad/i);
  });

  it('draws nothing until the cut has a length', () => {
    expect(render([40])).not.toContain('cut-line');
    expect(render([])).not.toContain('cut-line');
  });
});

describe('the controls under the pack (#312)', () => {
  /** Every element's opening tag, so attributes can be checked per element. */
  const tags = (html: string) => html.match(/<[a-z][^>]*>/g) ?? [];

  it('makes the pack itself the one control, named for its set', () => {
    const html = render([]);
    const shell = tags(html).find((tag) => tag.includes('data-pack-open'))!;
    expect(shell).toContain('role="button"');
    expect(shell).toContain('tabindex="0"');
    expect(shell).toContain(`aria-label="Open pack, ${SETS[0].name}"`);
    expect(shell).toContain('data-pack-open');
    expect(shell).not.toMatch(/aria-busy|aria-disabled/);
    // No second Open pack button, no era label on the wrapper, and one image that carries no name of its own.
    expect(html).not.toContain('<button');
    expect(html).not.toContain('pack-set-era');
    expect(html).not.toContain('Brainrot TCG booster pack wrapper');
    expect(tags(html).filter((tag) => /role="button"|tabindex=/i.test(tag))).toHaveLength(1);
  });

  it('says it is opening while the pack is torn and the ticket works, and takes no input', () => {
    const html = render([], { isPackCut: true });
    const shell = tags(html).find((tag) => tag.includes('data-pack-open'))!;
    expect(shell).toContain('aria-label="Opening…"');
    expect(shell).toContain('aria-busy="true"');
    expect(shell).toContain('aria-disabled="true"');
    expect(html).not.toContain('Open pack,');
  });

  it('says something different on the slow-ticket pill than on the pack, so it never reads Opening… twice', () => {
    const html = render([], { isPackCut: true, waiting: true });
    expect(html).toMatch(/<p class="pack-hint is-waiting" aria-hidden="true">Taking a moment…<\/p>/);
    expect(html.match(/Opening…/g)).toHaveLength(1);
  });

  it('shows the swipe hint only while there is a pack left to tear', () => {
    expect(render([])).toContain('swipe-hint-text');
    expect(render([20, 30])).toContain('swipe-hint-text');
    expect(render([], { nudging: true })).toMatch(/along the dotted line/);
    expect(render([])).toMatch(/(Swipe across to open|Drag across, or click)</);
    const torn = render([], { isPackCut: true });
    expect(torn).not.toContain('swipe-hint');
    expect(torn).not.toMatch(/Swipe across|Drag across|dotted line/);
  });

  it('says why a refused pack stayed sealed, with a button to try again', () => {
    for (const refusal of ['failed', 'blocked'] as const) {
      const html = render([], { refusal });
      expect(html).toContain(`<p class="pack-refusal-text">${REFUSAL_COPY[refusal].message.replace(/'/g, '&#x27;')}</p>`);
      expect(html).toMatch(new RegExp(`<button type="button" class="[^"]*pack-retry-button quiet-focus">${REFUSAL_COPY[refusal].action}</button>`));
    }
    expect(REFUSAL_COPY.failed.action).toBe('Try again');
  });
});
