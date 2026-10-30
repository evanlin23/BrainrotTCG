import { NOT_QUALIFYING_LEAD, RANKINGS_HELP } from './rankingsRule';

interface NotQualifyingNoteProps {
  lead?: string;
  onOpenHelp?: () => void;
}

/**
 * The sentence that says why a pull has no Submit (NOT_QUALIFYING's or NOT_BEATING_FLOOR's words), with "How Rankings work" a
 * button that goes to that section of the Rankings page. Without somewhere to go it is plain text.
 */
const NotQualifyingNote = ({ lead = NOT_QUALIFYING_LEAD, onOpenHelp }: NotQualifyingNoteProps) => (
  <>
    {lead}
    {onOpenHelp ? (
      <button type="button" className="link-btn link-btn--inline" onClick={onOpenHelp}>
        {RANKINGS_HELP}
      </button>
    ) : (
      RANKINGS_HELP
    )}
    .
  </>
);

export default NotQualifyingNote;
