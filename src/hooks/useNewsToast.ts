import { useEffect } from 'react';
import { getLatestUnreadNews, loadNews, markNewsRead, newsToast } from '../game/news';

interface NewsToastHost {
  /** The pack screen is at rest: a returning player, no pack being torn or revealed, and not on the What's new page. */
  due: boolean;
  /** The What's new page is on screen. */
  viewing: boolean;
  /** Puts the news toast at the back of the toast queue (a no-op when it is already there). */
  announce: (toast: ReturnType<typeof newsToast>) => void;
  /** Takes the news toast out of the queue. */
  withdraw: () => void;
}

/**
 * The latest unread announcement, once, as a toast behind whatever is already waiting. It is asked for
 * when the pack screen is at rest, so never during a tear or reveal, and again after each pack is put
 * away until it has been shown or opened. Opening the What's new page reads it (and takes a queued toast
 * back out), so the page's own visit is not followed by a toast for what it just showed.
 */
export const useNewsToast = ({ due, viewing, announce, withdraw }: NewsToastHost) => {
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
    // Read even if the page is left before the entries arrive: the player was shown the page.
    void loadNews().then(markNewsRead);
  }, [viewing, withdraw]);
};
