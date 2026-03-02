import React from 'react';
import '../styles/HallOfFame.css';

// Import hall of fame images
import adiImage from '../assets/images/hall_of_fame/image.png';
import danielImage from '../assets/images/hall_of_fame/Screenshot_2026-03-01_at_10.00.18_AM.png';

const HALL_OF_FAME_ENTRIES = [
  {
    id: 1,
    name: 'Adi/frail_banana',
    description: '4 of a Kind',
    image: adiImage,
    date: 'March 1st, 2026'
  },
  {
    id: 2,
    name: 'Daniel/dandandoo',
    description: 'Full House',
    image: danielImage,
    date: 'March 1st, 2026'
  }
];

const HallOfFame = ({ onClose }) => {
  return (
    <div className="hall-of-fame-page">
      <div className="hall-of-fame-header">
        <h2>Hall of Fame</h2>
        <p>Legendary achievements recorded for all time</p>
        <button className="hall-of-fame-close-btn" onClick={onClose}>&times;</button>
      </div>

      <div className="hall-of-fame-grid">
        {HALL_OF_FAME_ENTRIES.map(entry => (
          <div key={entry.id} className="hall-of-fame-card">
            <div className="hall-of-fame-image">
              <img src={entry.image} alt={`${entry.name}'s achievement`} />
            </div>
            <div className="hall-of-fame-info">
              <div className="hall-of-fame-name">{entry.name}</div>
              <div className="hall-of-fame-achievement">{entry.description}</div>
              <div className="hall-of-fame-date">{entry.date}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default HallOfFame;
