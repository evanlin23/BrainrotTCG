import { useState } from 'react';
import { Info } from 'lucide-react';
import type { SetDefinition } from '../../engine';
import ScoringGuide from './ScoringGuide';
import '../../styles/Scoring.css';

interface CardGuideButtonProps {
  /** The set whose odds the guide shows. */
  set: SetDefinition;
  className?: string;
}

/** "Card guide": opens the scoring guide for a set. The sheet hands focus back to this button when it closes. */
const CardGuideButton = ({ set, className = 'card-guide-link' }: CardGuideButtonProps) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} aria-haspopup="dialog" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        <Info aria-hidden="true" /> Card guide
      </button>
      {open && <ScoringGuide set={set} onClose={() => setOpen(false)} />}
    </>
  );
};

export default CardGuideButton;
