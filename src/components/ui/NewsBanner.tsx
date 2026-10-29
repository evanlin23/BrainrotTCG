import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { dismissNewsId, getLatestUnreadNews, loadNews, type NewsItem } from '../../game/news';
import '../../styles/News.css';

export interface NewsBannerProps {
  /** Optional fixture items (e.g. for testing or preloaded state). */
  items?: NewsItem[];
  /** Callback fired after an announcement is dismissed. */
  onDismiss?: (id: string) => void;
}

const NewsBanner = ({ items, onDismiss }: NewsBannerProps) => {
  const [loadedNews, setLoadedNews] = useState<NewsItem | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (items) return;
    let cancelled = false;
    void loadNews().then((loaded) => {
      if (!cancelled) setLoadedNews(getLatestUnreadNews(loaded));
    });
    return () => {
      cancelled = true;
    };
  }, [items]);

  const news = items ? getLatestUnreadNews(items) : loadedNews;

  const handleDismiss = useCallback(() => {
    if (!news) return;
    dismissNewsId(news.id);
    setDismissed(true);
    onDismiss?.(news.id);
  }, [news, onDismiss]);

  if (dismissed || !news) return null;

  const tag = news.tag ?? (news.category === 'changelog' ? 'Changelog' : 'News');

  return (
    <aside className="news-banner" role="region" aria-label="Announcement" title={`${news.title}: ${news.summary}`}>
      <div className="news-banner-content">
        <span className="news-banner-tag">{tag}</span>
        <span className="news-banner-text">
          <strong className="news-banner-title">{news.title}</strong>
          <span className="news-banner-sep" aria-hidden="true"> · </span>
          <span className="news-banner-summary">{news.summary}</span>
        </span>
        {news.link && (
          <a href={news.link.url} className="news-banner-link" target="_blank" rel="noopener noreferrer">
            {news.link.text}
          </a>
        )}
      </div>
      <button
        type="button"
        className="news-banner-dismiss"
        aria-label="Dismiss announcement"
        onClick={handleDismiss}
      >
        <X aria-hidden="true" className="news-banner-dismiss-icon" />
      </button>
    </aside>
  );
};

export default NewsBanner;
