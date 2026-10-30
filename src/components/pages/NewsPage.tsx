import { newsTag, parseNews, type NewsItem } from '../../game/news';
import shipped from '../../content/news.json';
import '../../styles/News.css';

interface NewsPageProps {
  /** Entries to show in place of the build's own (a fixture in tests). They are shown in the order given. */
  items?: readonly NewsItem[];
}

const FORMAT = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

/** "Oct 27, 2026" for an ISO date; whatever the entry says when it isn't one. */
const when = (date: string): string => {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : FORMAT.format(parsed);
};

/**
 * What's new (#/news): every announcement from src/content/news.json, newest first, with its date, tag,
 * title, full summary and link. It is a deferred page like the others, and needs no save: a first-time
 * visitor can follow a link to it. The news is part of this page's own chunk, so it is there once the
 * page is (a chunk that fails to load gets the page's Reload and Retry). Opening the page reads the
 * newest entry (useNewsToast), so it is not toasted afterwards.
 */
const NewsPage = ({ items = parseNews(shipped) }: NewsPageProps) => (
  <div className="news-page">
    {items.length === 0 ? (
      <p className="news-empty">Nothing new yet. Updates to the game show up here.</p>
    ) : (
      <ol className="news-list">
        {items.map((item) => (
          <li key={item.id} className="news-entry">
            <div className="news-entry-meta">
              <span className="news-entry-tag">{newsTag(item)}</span>
              <time dateTime={item.date}>{when(item.date)}</time>
            </div>
            <h2 className="news-entry-title">{item.title}</h2>
            <p className="news-entry-summary">{item.summary}</p>
            {item.link && (
              <a href={item.link.url} className="news-entry-link" target="_blank" rel="noopener noreferrer">
                {item.link.text}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </li>
        ))}
      </ol>
    )}
  </div>
);

export default NewsPage;
