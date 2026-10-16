// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Sheet from './Sheet';

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const open = (bare: boolean) => {
  const onClose = vi.fn();
  act(() => root.render(
    <Sheet title="A card" onClose={onClose} bare={bare}>
      <div className="content"><button type="button">Share card</button></div>
    </Sheet>,
  ));
  const click = (selector: string) => act(() => document.querySelector<HTMLElement>(selector)!.click());
  return { onClose, click };
};

describe('closing a sheet from outside its content (#182)', () => {
  it('closes a bare sheet from its backdrop and from its own empty space, which is all a phone shows around the card', () => {
    const { onClose, click } = open(true);
    click('.sheet-backdrop');
    click('.sheet-body');
    click('.sheet');
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("keeps a bare sheet open for taps on its content and buttons, the card's included", () => {
    const { onClose, click } = open(true);
    click('.content');
    click('.content button');
    click('.sheet-heading');
    expect(onClose).not.toHaveBeenCalled();
    click('.sheet-close');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes a panel sheet only from its backdrop: its body is the panel's own surface", () => {
    const { onClose, click } = open(false);
    click('.sheet-body');
    click('.sheet');
    click('.content');
    expect(onClose).not.toHaveBeenCalled();
    click('.sheet-backdrop');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
