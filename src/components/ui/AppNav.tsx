import { Globe, Layers, PackageOpen, type LucideIcon } from 'lucide-react';
import '../../styles/AppNav.css';

export type NavTarget = 'open' | 'collection' | 'achievements' | 'hallOfFame' | 'profile' | 'settings' | 'player' | 'save';

const ITEMS: { id: NavTarget; label: string; Icon: LucideIcon }[] = [
  { id: 'open', label: 'Open packs', Icon: PackageOpen },
  { id: 'collection', label: 'My cards', Icon: Layers },
  { id: 'hallOfFame', label: 'Rankings', Icon: Globe },
];

interface AppNavProps {
  onOpen: (target: NavTarget) => void;
  /** The destination on screen; `null` while a sheet that is none of these is open, so no tab claims the page. */
  active?: 'open' | 'collection' | 'hallOfFame' | null;
}

/** Bottom tab bar on phones, inline in the header on wide screens (see AppNav.css). */
const AppNav = ({ onOpen, active = 'open' }: AppNavProps) => (
  <nav className="app-nav" aria-label="Main">
    <ul>
      {ITEMS.map(({ id, label, Icon }) => (
        <li key={id}>
          <button type="button" className="app-nav-item" aria-current={active === id ? 'page' : undefined} onClick={() => onOpen(id)}>
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
