import '../../styles/Sets.css';

interface ChangePackButtonProps {
  /** How many other packs the Packs sheet lists (packChoices.ts); the caller leaves the control out at 0. */
  count: number;
  onOpen: () => void;
}

/**
 * The landing's quiet pointer to the other packs (DESIGN.md "Flow", item 8): it leads the row under the sealed
 * pack (the Card guide's, PackMilestone.css places it), so it comes right after the pack in the keyboard order.
 * It opens the existing Packs sheet and switches nothing by itself.
 */
const ChangePackButton = ({ count, onOpen }: ChangePackButtonProps) => (
  <button type="button" className="change-pack btn btn--ghost" onClick={onOpen} aria-haspopup="dialog" aria-label={`Change pack, ${count} available`}>
    Change pack · {count} available
  </button>
);

export default ChangePackButton;
