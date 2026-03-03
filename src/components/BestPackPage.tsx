import { CardWithMeta } from './Card';
import '../styles/BestPackPage.css';
import '../styles/PackOpener.css'; // For the fan-out summary carousel styles

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

    return (
        <div className="best-pack-page">
            <div className="best-pack-header">
                <h2>Personal Best Pack</h2>
                <p>Your luckiest pull so far</p>
                <button className="best-pack-close-btn" onClick={onClose}>&times;</button>
            </div>

            <div className="best-pack-content">
                {displayValue > 0 && stats.highestPackCards ? (
                    <>
                        <div className="best-pack-value" style={{ marginBottom: '1rem', padding: '1rem' }}>
                            <span className="value-label" style={{ fontSize: '0.8rem', opacity: 0.8 }}>calculation</span>
                            <div style={{ fontSize: '1.2rem', marginBottom: '0.5rem', color: '#ffb347' }}>
                                {displayBase.toLocaleString()} Buhcoins &times; {displayMulti}x multiplier ({displayHand})
                            </div>
                            <span className="value-number" style={{ fontSize: '2rem' }}>= {displayValue.toLocaleString()} Brainrot value!</span>
                        </div>

                        <div className="summary-carousel" style={{ marginTop: '2rem' }}>
                            {stats.highestPackCards.map((card, index) => {
                                const totalCards = stats.highestPackCards!.length;
                                const offset = (index - (totalCards - 1) / 2);
                                const classes = [
                                    'summary-card',
                                    card.rarity.toLowerCase(),
                                    card.isHolo ? 'holo' : ''
                                ].filter(Boolean).join(' ');

                                return (
                                    <div key={index} className={classes} style={{ '--offset': offset } as React.CSSProperties}>
                                        <img src={card.image} alt={card.name} />
                                    </div>
                                );
                            })}
                        </div>
                    </>
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
