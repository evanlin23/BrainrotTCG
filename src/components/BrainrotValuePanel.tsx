interface BrainrotValuePanelProps {
    baseValue: number;
    multiplier: number;
    handName: string;
    flexValue: number;
}

const BrainrotValuePanel = ({ baseValue, multiplier, handName, flexValue }: BrainrotValuePanelProps) => {
    return (
        <div className="summary-value" style={{ margin: '1rem 0', padding: '1rem 2rem', background: 'rgba(255, 215, 0, 0.1)', border: '2px solid #ffd700', borderRadius: '1rem' }}>
            <div style={{ marginBottom: '0.5rem', color: '#ffb347' }}>
                {baseValue.toLocaleString()} Buhcoins &times; {multiplier}x ({handName})
            </div>
            <span style={{ fontFamily: '"Rubik Glitch", system-ui', color: 'white', textShadow: '0 2px 4px rgba(0,0,0,0.5)' }}>
                = {flexValue.toLocaleString()} Brainrot value!
            </span>
        </div>
    );
};

export default BrainrotValuePanel;
