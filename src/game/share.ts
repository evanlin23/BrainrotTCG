import type { Rarity, PackScore } from '../engine';
import { REPO } from '../constants';

/** Each rarity's square and initial, so the row reads without colour (C U R E L B are all different). */
const RARITY_MARK: Record<Rarity, string> = {
  COMMON: '⬜C',
  UNCOMMON: '🟩U',
  RARE: '🟦R',
  EPIC: '🟪E',
  LEGENDARY: '🟧L',
  BRAINROT: '🟥B',
};

/** Wordle-style one-liner: rarity squares with initials, holo sparkles, hand and value. */
export const bragText = (cards: { rarity: Rarity; isHolo: boolean }[], score: PackScore, setName: string, url: string) =>
  [
    `🧠 Brainrot TCG · ${setName}`,
    cards.map((c) => RARITY_MARK[c.rarity] + (c.isHolo ? '✨' : '')).join(' '),
    `${score.hand.name}${score.hand.multiplier > 1 ? ` ×${score.hand.multiplier.toLocaleString('en-US')}` : ''} · 🧠 ${score.score.toLocaleString('en-US')} Brainrot Score`,
    `Verify it yourself: ${url}`,
  ].join('\n');

/** Pre-filled GitHub issue for the global Hall of Fame (the form lives in .github/ISSUE_TEMPLATE). */
export const hallOfFameSubmitUrl = (url: string, title: string) =>
  `https://github.com/${REPO}/issues/new?template=hall-of-fame.yml&title=${encodeURIComponent(`[Hall of Fame] ${title}`)}&pull=${encodeURIComponent(url)}`;

const SUBMITTED_KEY = 'brainrot-hof-submitted-v1';

/** Sent from this tab, so the label holds even when storage refuses the write below. */
const sentHere = new Set<string>();
/** Sends still waiting on a relay, by pull id: a second Submit joins the first instead of sending again. */
const sending = new Map<string, Promise<boolean>>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

/** Pulls this device has already sent to the Hall of Fame inbox. */
export const wasSubmitted = (id: string): boolean => {
  if (sentHere.has(id)) return true;
  try {
    return (JSON.parse(localStorage.getItem(SUBMITTED_KEY) ?? '[]') as string[]).includes(id);
  } catch {
    return false;
  }
};

/**
 * Where a pull's Hall of Fame send stands on this device, wherever on the page it was started (the
 * share sheet or the summary's line). A failed send goes back to idle: only the control that sent
 * it says it failed.
 */
export const submissionStatus = (id: string): 'idle' | 'sending' | 'sent' =>
  sending.has(id) ? 'sending' : wasSubmitted(id) ? 'sent' : 'idle';

/** Called whenever a send starts or settles; returns the unsubscribe. */
export const onSubmissionChange = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Send a qualifying pull to the Hall of Fame without a GitHub account: a signed note to public
 * Nostr relays, which a GitHub Action reads every 15 minutes (see src/game/nostrInbox.ts).
 * Resolves to true as soon as one relay accepts it (the other relays keep sending in the
 * background), or false once every relay has refused, failed or timed out. `score` (the pull's
 * Brainrot Score) lets the inbox skip a pull that can't make the list without re-deriving it.
 */
export const submitToHallOfFame = (proof: string, id: string, score?: number): Promise<boolean> => {
  const running = sending.get(id);
  if (running) return running;
  const send = publish(proof, id, score).finally(() => {
    sending.delete(id);
    changed();
  });
  sending.set(id, send);
  changed();
  return send;
};

const publish = async (proof: string, id: string, score?: number): Promise<boolean> => {
  const { hallOfFameEvent, publishUntilAccepted } = await import('./nostrInbox');
  const { accepted } = await publishUntilAccepted(hallOfFameEvent(proof, id, Date.now(), score));
  if (accepted) {
    sentHere.add(id);
    try {
      const list = JSON.parse(localStorage.getItem(SUBMITTED_KEY) ?? '[]') as string[];
      localStorage.setItem(SUBMITTED_KEY, JSON.stringify([...list.filter((x) => x !== id), id].slice(-200)));
    } catch {
      // sentHere keeps the label for this visit
    }
  }
  return accepted !== null;
};
