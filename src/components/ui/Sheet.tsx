import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { SheetSettledContext } from './sheetEntry';
import '../../styles/Sheet.css';

export type SheetSize = 'sm' | 'md' | 'lg' | 'full';

interface SheetProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  size?: SheetSize;
  /** Shown under the title (counts, a short description). */
  subtitle?: ReactNode;
  /** Sticky actions at the bottom of the sheet. */
  footer?: ReactNode;
  /** No panel chrome: content floats on the backdrop (e.g. a single big card). */
  bare?: boolean;
  className?: string;
}

/** Sheets currently open, newest last: only the top one reacts to Escape and owns focus. */
const stack: string[] = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Every panel in the app: a bottom sheet on phones, a centred dialog on wide screens.
 * Closes with Escape, the close button or the backdrop; traps focus while open and gives it back
 * to whatever opened it; locks page scroll.
 */
const Sheet = ({ title, onClose, children, size = 'md', subtitle, footer, bare = false, className = '' }: SheetProps) => {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** A body that scrolls but has nothing to tab to (a guide, an empty list) is itself a tab stop. */
  const [bodyFocusable, setBodyFocusable] = useState(false);
  /** Replacing a loading placeholder that is already on screen: no second entrance. Fixed at mount. */
  const replacesPlaceholder = useContext(SheetSettledContext);
  const [settled] = useState(replacesPlaceholder);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    stack.push(id);
    document.body.classList.add('scroll-locked');
    // Focus the panel itself so screen readers announce the title, without jumping to a control.
    panelRef.current?.focus({ preventScroll: true });

    const onKey = (event: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      // With the panel itself focused (as it is on open), the keys that scroll a page scroll the body.
      const body = bodyRef.current;
      if (body && document.activeElement === panelRef.current) {
        const page = body.clientHeight * 0.9;
        const by: Record<string, number> = { ArrowDown: 40, ArrowUp: -40, PageDown: page, PageUp: -page, ' ': event.shiftKey ? -page : page };
        if (event.key in by) {
          event.preventDefault();
          body.scrollBy({ top: by[event.key] });
          return;
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          body.scrollTo({ top: event.key === 'Home' ? 0 : body.scrollHeight });
          return;
        }
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);

    return () => {
      document.removeEventListener('keydown', onKey, true);
      stack.splice(stack.indexOf(id), 1);
      if (stack.length === 0) document.body.classList.remove('scroll-locked');
      opener?.focus?.({ preventScroll: true });
    };
  }, [id]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const check = () => setBodyFocusable(body.scrollHeight > body.clientHeight + 1 && !body.querySelector(FOCUSABLE));
    check();
    const observer = new ResizeObserver(check);
    observer.observe(body);
    return () => observer.disconnect();
  }, [children]);

  const titleId = `${id}-title`;
  return createPortal(
    <div className={`sheet-root sheet-root--${size} ${bare ? 'sheet-root--bare' : ''} ${settled ? 'sheet-root--settled' : ''}`}>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className={`sheet ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="sheet-header">
          <div className="sheet-heading">
            <h2 id={titleId} className={bare ? 'sr-only' : 'sheet-title'}>
              {title}
            </h2>
            {subtitle && !bare && <p className="sheet-subtitle">{subtitle}</p>}
          </div>
          <button type="button" className="icon-btn sheet-close" onClick={onClose} aria-label="Close">
            <X strokeWidth={2.4} />
          </button>
        </div>
        <div ref={bodyRef} className="sheet-body" tabIndex={bodyFocusable ? 0 : undefined}>
          {/* A sheet opened from inside this one is new: it plays its own entrance. */}
          <SheetSettledContext value={false}>{children}</SheetSettledContext>
        </div>
        {footer && <footer className="sheet-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
};

export default Sheet;
