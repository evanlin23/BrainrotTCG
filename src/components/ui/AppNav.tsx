import { Globe, Layers, PackageOpen, UserRound, type LucideIcon } from 'lucide-react';
import type { Page } from '../../game/route';
import '../../styles/AppNav.css';

const ITEMS: { id: Page; label: string; Icon: LucideIcon }[] = [
  { id: 'open', label: 'Open', Icon: PackageOpen },
  { id: 'cards', label: 'Cards', Icon: Layers },
  { id: 'rankings', label: 'Rankings', Icon: Globe },
  { id: 'profile', label: 'Profile', Icon: UserRound },
];

interface AppNavProps {
  onOpen: (page: Page) => void;
  /** Pointing at, focusing or pressing a tab: a chance to start loading its page. */
  onPrefetch?: (page: Page) => void;
  /** The page on screen; `null` while a sheet is open over it, so no tab claims it. Settings is none of these. */
  active?: Page | null;
}

/** Bottom tab bar on phones, inline in the header on wide screens (see AppNav.css). */
const AppNav = ({ onOpen, onPrefetch, active = 'open' }: AppNavProps) => (
  <nav className="app-nav" aria-label="Main">
    <ul>
      {ITEMS.map(({ id, label, Icon }) => (
        <li key={id}>
          <button
            type="button"
            className="app-nav-item"
            aria-current={active === id ? 'page' : undefined}
            onPointerEnter={() => onPrefetch?.(id)}
            onFocus={() => onPrefetch?.(id)}
            onPointerDown={() => onPrefetch?.(id)}
            onClick={() => onOpen(id)}
          >
            <span className="app-nav-icon" aria-hidden="true">
              <Icon strokeWidth={2.2} />
            </span>
            <span className="app-nav-label">{label}</span>
          </button>
        </li>
      ))}
    </ul>
  </nav>
);

export default AppNav;
