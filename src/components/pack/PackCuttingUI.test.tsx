import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SETS } from '../../content/sets';
import PackCuttingUI from './PackCuttingUI';

const render = (xs: number[], { pressing = false, nudging = false } = {}) =>
  renderToStaticMarkup(
    <PackCuttingUI
      packRef={createRef<HTMLDivElement>()}
      packDesign="pack.png"
      set={SETS[0]}
      error={null}
      isCutting={xs.length > 1}
      pressing={pressing}
      nudging={nudging}
      isPackCut={false}
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
