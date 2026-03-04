import { motion } from 'framer-motion';
import PackCardViewer from '../ui/PackCardViewer';
import type { CardWithMeta } from '../cards/Card';

const Motion = motion;

interface PackSummaryUIProps {
  openedCards: CardWithMeta[];
  onClose: () => void;
}

const PackSummaryUI = ({ openedCards, onClose }: PackSummaryUIProps) => {
  return (
    <Motion.div
      className="pack-summary"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
    >
      <h2 className="summary-title">Pack Summary</h2>
      <PackCardViewer cards={openedCards} displayMode="carousel" />
      <button className="summary-close-btn" onClick={onClose}>
        Open Another Pack
      </button>
    </Motion.div>
  );
};

export default PackSummaryUI;
