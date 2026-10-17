import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SETS } from '../../content/sets';
import PackCuttingUI from './PackCuttingUI';
import { REFUSAL_COPY, type PackRefusal } from './refusal';

const render = (xs: number[], { pressing = false, nudging = false, tapped = false, isPackCut = false, waiting = false, refusal = null as PackRefusal | null } = {}) =>
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
      tapped={tapped}
      isPackCut={isPackCut}
      waiting={waiting}
      cutPoints={xs.map((x) => ({ x, y: 19 }))}
      sparks={[]}
    />,
  );

/** The pack shell's classes. */
const shellClasses = (html: string) => (html.match(/class="(pack-shell [^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean);

describe('the tear line under a press', () => {
  it('lights up for a press on it before the swipe has a direction, in place of a nudge', () => {
    expect(shellClasses(render([], { pressing: true, nudging: true }))).toEqual(['pack-shell', 'is-pressed']);
    expect(shellClasses(render([], { nudging: true }))).toEqual(['pack-shell', 'is-nudged']);
    expect(shellClasses(render([]))).toEqual(['pack-shell']);
  });

  it('pulses the swipe hint after a tap on the seam, until the next press (#485)', () => {
    expect(shellClasses(render([], { tapped: true }))).toEqual(['pack-shell', 'is-tapped']);
    expect(shellClasses(render([], { tapped: true, pressing: true }))).toEqual(['pack-shell', 'is-pressed']);
    expect(shellClasses(render([20, 30], { tapped: true }))).toEqual(['pack-shell', 'is-cutting']);
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

  it('opens it with a real Open pack button, and the pack itself is only a gesture surface', () => {
    const html = render([]);
    expect(html).toMatch(/<button type="button" class="btn btn--secondary btn--sm pack-open-button quiet-focus">Open pack<\/button>/);
    // No fake button: nothing but a real button takes the role, a Tab stop or a name that opens the pack.
    expect(tags(html).filter((tag) => /role="button"|tabindex=/i.test(tag))).toEqual([]);
    expect(html).not.toMatch(/aria-label="Open a /);
    expect(shellClasses(html)).toEqual(['pack-shell']);
  });

  it('keeps the button while the pack is torn, done but still holding focus, and says it is opening', () => {
    const html = render([], { isPackCut: true });
    expect(html).toMatch(/<button type="button" class="[^"]*pack-open-button quiet-focus" aria-disabled="true">Opening…<\/button>/);
    expect(html).not.toContain('Open pack');
  });

  it('says something different on the slow-ticket pill than on the button, so it never reads Opening… twice', () => {
    const html = render([], { isPackCut: true, waiting: true });
    expect(html).toMatch(/<p class="pack-hint is-waiting" aria-hidden="true">Taking a moment…<\/p>/);
    expect(html.match(/Opening…/g)).toHaveLength(1);
  });

  it('shows the swipe hint only while there is a pack left to tear', () => {
    expect(render([])).toContain('swipe-hint-text');
    expect(render([20, 30])).toContain('swipe-hint-text');
    expect(render([], { nudging: true })).toMatch(/along the dotted line/);
    const torn = render([], { isPackCut: true });
    expect(torn).not.toContain('swipe-hint');
    expect(torn).not.toMatch(/Swipe across|Drag across|dotted line/);
  });

  it('says why a refused pack stayed sealed, with a button to try again, in place of Open pack', () => {
    for (const refusal of ['failed', 'blocked'] as const) {
      const html = render([], { refusal });
      expect(html).toContain(`<p class="pack-refusal-text">${REFUSAL_COPY[refusal].message.replace(/'/g, '&#x27;')}</p>`);
      expect(html).toMatch(new RegExp(`<button type="button" class="[^"]*pack-retry-button quiet-focus">${REFUSAL_COPY[refusal].action}</button>`));
      expect(html).not.toContain('pack-open-button');
    }
    expect(REFUSAL_COPY.failed.action).toBe('Try again');
  });
});
