// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecordBook from './RecordBook';
import PullRow from './PullRow';
import type { RecordBook as Records } from '../../game/personalRecords';

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const EMPTY: Records = { bestPackBySet: [], mostHolos: null, mostPacksInADay: null, longestDroughtBroken: null };
const AT = new Date(2026, 9, 12, 12).getTime();

const render = (book: Records, cardsPending = false) => act(() => root.render(<RecordBook book={book} cardsPending={cardsPending} />));

/** Each record as "label | value | detail". */
const rows = () =>
  [...container.querySelectorAll('.record-book-item')].map((item) =>
    [item.querySelector('dt')!.textContent, item.querySelector('.record-book-value')!.textContent, item.querySelector('.record-book-detail')!.textContent].join(' | '),
  );

describe('RecordBook (#1287)', () => {
  it('is a labelled section with a one-line empty state when no pack counts yet', () => {
    render(EMPTY);
    const section = container.querySelector('section')!;
    const heading = section.querySelector('h2')!;
    expect(heading.textContent).toBe('Personal records');
    expect(section.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(section.querySelector('dl')).toBeNull();
    expect(section.textContent).toContain('No records yet.');
  });

  it('shows each record set with what it beat, and the value to beat where none is set yet', () => {
    render({
      bestPackBySet: [
        { setId: 'right-now', value: 9_800_000, previous: 4_515_000, at: AT },
        { setId: 'genesis', value: 1_020, previous: null, at: AT },
        { setId: 'gone-set', value: 50, previous: 40, at: AT },
      ],
      mostHolos: { value: 3, previous: 2, at: AT },
      mostPacksInADay: { value: 1, previous: null, at: AT },
      longestDroughtBroken: { value: 212, previous: 150, at: AT },
    });
    const day = new Date(AT).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    expect(rows()).toEqual([
      `Most holos in a pack | 3 holos | previous 2 holos · ${day}`,
      'Most packs in a day | Not set yet | Beat 1 pack to set it',
      `Longest Brainrot drought broken | 212 packs | previous 150 packs · ${day}`,
      `Summer of Slop | 9,800,000 | previous 4,515,000 · ${day}`,
      'Genesis | Not set yet | Beat 1,020 to set it',
      // A set this build no longer has keeps its id.
      `gone-set | 50 | previous 40 · ${day}`,
    ]);
    // Headings go h2, then h3 for the per-set list.
    expect([...container.querySelectorAll('h2, h3')].map((h) => `${h.tagName}:${h.textContent}`)).toEqual(['H2:Personal records', 'H3:Best pack by set']);
  });

  it('says none yet for a record with nothing to count, and leaves out an empty set list', () => {
    render({ ...EMPTY, mostPacksInADay: { value: 2, previous: null, at: AT } });
    expect(rows()).toEqual([
      "Most holos in a pack | None yet | No pack's cards are saved here yet",
      'Most packs in a day | Not set yet | Beat 2 packs to set it',
      'Longest Brainrot drought broken | None yet | No Brainrot has ended a drought yet',
    ]);
    expect(container.querySelector('h3')).toBeNull();
  });

  it('holds the card-read records at Counting… while saved packs load', () => {
    render(EMPTY, true);
    expect(container.textContent).not.toContain('No records yet');
    expect(rows().filter((row) => row.includes('Counting…'))).toEqual([
      'Most holos in a pack | Counting… | Reading your saved packs',
      'Longest Brainrot drought broken | Counting… | Reading your saved packs',
    ]);
  });
});

describe('PullRow medal (#1287)', () => {
  const row = (medal?: 'best' | 'set-best') =>
    act(() =>
      root.render(
        <ul>
          <PullRow cards={null} set={undefined} setId="genesis" hand="Pair" score={900} meta="now" worthy={false} medal={medal} onClick={() => {}} />
        </ul>,
      ),
    );

  it('keeps a solid medal for an all-time best and an outlined one for a set best, each named for screen readers', () => {
    row('best');
    expect(container.querySelector('.pull-row-medal--best')!.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('button')!.textContent).toContain(', a new best when opened');
    row('set-best');
    expect(container.querySelector('.pull-row-medal')).not.toBeNull();
    expect(container.querySelector('.pull-row-medal--best')).toBeNull();
    expect(container.querySelector('button')!.textContent).toContain(', a best in its set when opened');
    row();
    expect(container.querySelector('.pull-row-medal')).toBeNull();
  });
});
