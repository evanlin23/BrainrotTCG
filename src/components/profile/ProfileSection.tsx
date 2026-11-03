import { useId, useState, type ReactNode, type RefObject } from 'react';
import { ChevronDown } from 'lucide-react';
import '../../styles/Profile.css';

interface ProfileSectionProps {
  title: string;
  children: ReactNode;
  id?: string;
  titleId?: string;
  titleRef?: RefObject<HTMLHeadingElement | null>;
  sectionRef?: RefObject<HTMLElement | null>;
  className?: string;
  note?: ReactNode;
  /** The note only helps while the section is closed (its body already says the same). */
  hideNoteWhenOpen?: boolean;
  /**
   * A save, trust or privacy notice inside needs to be seen: the section opens when this appears (a player can
   * close it again) and, while closed, its header says so in place of the note. Open, the body says it.
   */
  attention?: string | null;
  /** Show the attention note in the header only, leaving the section closed (another section already holds the alert). */
  headerOnly?: boolean;
  /** A new toast or navigation request opens the section again after it was closed. */
  openRequest?: number;
}

/** Independent native folds; contents stay mounted so background reads can settle while closed. */
export default function ProfileSection({ title, children, id, titleId, titleRef, sectionRef, className = '', note, hideNoteWhenOpen, attention, headerOnly, openRequest }: ProfileSectionProps) {
  const generatedId = useId();
  const headingId = titleId ?? generatedId;
  const [open, setOpen] = useState(openRequest !== undefined || (!!attention && !headerOnly));
  const [attended, setAttended] = useState(!!attention);
  if (!!attention !== attended) {
    setAttended(!!attention);
    if (attention && !headerOnly) setOpen(true);
  }
  const [seenRequest, setSeenRequest] = useState(openRequest);
  if (openRequest !== seenRequest) {
    setSeenRequest(openRequest);
    if (openRequest !== undefined) setOpen(true);
  }
  return (
    <section id={id} ref={sectionRef} className={`profile-fold ${className}`} aria-labelledby={headingId}>
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="profile-fold-toggle">
          <h2 id={headingId} ref={titleRef} tabIndex={-1}>{title}</h2>
          {attention ? (
            !open && <span className="profile-fold-note profile-fold-note--attention">{attention}</span>
          ) : (
            note && !(hideNoteWhenOpen && open) && <span className="profile-fold-note">{note}</span>
          )}
          <ChevronDown className="profile-fold-chevron" aria-hidden="true" />
        </summary>
        <div className="profile-fold-content">{children}</div>
      </details>
    </section>
  );
}
