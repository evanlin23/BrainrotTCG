import { NOT_QUALIFYING_LEAD, RANKINGS_HELP } from './rankingsRule';

/**
 * The sentence that says why a pull has no Submit (NOT_QUALIFYING's words), with "How Rankings work" a
 * button that goes to that section of the Rankings page. Without somewhere to go it is plain text.
 */
const NotQualifyingNote = ({ onOpenHelp }: { onOpenHelp?: () => void }) => (
  <>
    {NOT_QUALIFYING_LEAD}
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
