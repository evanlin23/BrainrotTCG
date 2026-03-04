import { CardWithMeta } from '../cards/Card';
import PackCardViewer from '../ui/PackCardViewer';
import BrainrotValuePanel from '../ui/BrainrotValuePanel';
import '../../styles/BestPackPage.css';

interface Stats {
    highestPackValue?: number;
    highestPackFlexValue?: number;
    highestPackBaseValue?: number;
    highestPackMultiplier?: number;
    highestPackHandName?: string;
    highestPackCards?: CardWithMeta[];
}

interface BestPackPageProps {
    stats: Stats;
    onClose: () => void;
}

const BestPackPage = ({ stats, onClose }: BestPackPageProps) => {
    // Gracefully fallback to legacy stats if the user hasn't gotten a new best pack yet
    const displayValue = stats.highestPackFlexValue || stats.highestPackValue || 0;
    const displayBase = stats.highestPackBaseValue || stats.highestPackValue || 0;
    const displayMulti = stats.highestPackMultiplier || 1;
    const displayHand = stats.highestPackHandName || "No Matches";
    const hasLegacyStats = !stats.highestPackFlexValue && stats.highestPackValue;

    return (
        <div className="best-pack-page">
            <div className="best-pack-header">
                <h2>Personal Best Pack</h2>
                <p>Your luckiest pull so far</p>
                <button className="best-pack-close-btn" onClick={onClose}>&times;</button>
            </div>

            <div className="best-pack-content">
                {displayValue > 0 && stats.highestPackCards ? (
                    hasLegacyStats ? (
                        // Legacy stats - show custom panel since we don't have accurate multiplier info
                        <>
                            <BrainrotValuePanel
                                baseValue={displayBase}
                                multiplier={displayMulti}
                                handName={displayHand}
                                flexValue={displayValue}
                            />
                            <PackCardViewer
                                cards={stats.highestPackCards}
                                displayMode="carousel"
                                showValue={false}
                            />
                        </>
                    ) : (
                        <PackCardViewer
                            cards={stats.highestPackCards}
                            displayMode="carousel"
                        />
                    )
                ) : (
                    <div className="best-pack-empty">
                        <p>You haven't opened any packs yet!</p>
                        <p>Open some packs to record your personal best.</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default BestPackPage;
