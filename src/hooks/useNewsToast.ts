import { useEffect, useState } from 'react';
import { getLatestUnreadNews, loadNews, markNewsRead, newsToast } from '../game/news';

interface NewsToastHost {
  /** A returning player is on the pack screen and not on the What's new page. */
  atRest: boolean;
  /** A pack is being torn, revealed or summarised: from the tear until it is put away. */
  packOpen: boolean;
  /** The What's new page is on screen. */
  viewing: boolean;
  /** Puts the news toast at the back of the toast queue (a no-op when it is already there). */
  announce: (toast: ReturnType<typeof newsToast>) => void;
  /** Takes the news toast out of the queue. */
  withdraw: () => void;
}

/**
 * The latest unread announcement, once, as a toast behind whatever is already waiting. It is asked for
 * only after a pack is put away in this visit (never on a page load or a route change), and while the pack
 * screen is at rest. A pack that starts again takes a toast that has not been shown back out of the queue,
 * so it never lands on that pack's summary ahead of the pack's own notices; it comes back after the next
 * put-away until it has been shown or opened. Opening the What's new page reads it (and takes a queued
 * toast back out), so the page's own visit is not followed by a toast for what it just showed.
 */
export const useNewsToast = ({ atRest, packOpen, viewing, announce, withdraw }: NewsToastHost) => {
  // Armed by a pack being put away (packOpen true to false), disarmed as the next one starts. Derived while
  // rendering, so no frame shows the toast between a pack starting and it being taken back.
  const [wasOpen, setWasOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  if (packOpen !== wasOpen) {
    setWasOpen(packOpen);
    setArmed(!packOpen);
  }
  const due = armed && atRest && !packOpen;

  useEffect(() => {
    if (packOpen) withdraw();
  }, [packOpen, withdraw]);

  useEffect(() => {
    if (!due) return;
    let live = true;
    void loadNews().then((items) => {
      const latest = live ? getLatestUnreadNews(items) : null;
      if (latest) announce(newsToast(latest));
    });
    return () => {
      live = false;
    };
  }, [due, announce]);

  useEffect(() => {
    if (!viewing) return;
    withdraw();
    // Read even if the page is left before the entries arrive: the player was shown the page. This writes
    // the same dismissal key for a first-time visitor with no save (docs/DESIGN.md, What's new).
    void loadNews().then(markNewsRead);
  }, [viewing, withdraw]);
};
