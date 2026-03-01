import React, { useState } from 'react';
import './styles/index.css';
import PackOpener from './components/PackOpener';
import { INITIAL_CARDS } from './data/cards';

function App() {
  const [collection, setCollection] = useState([]);

  const handleCardsOpened = (newCards) => {
    setCollection(prev => [...prev, ...newCards]);
  };

  return (
    <div className="app-container">
      <header>
        <h1>Brainrot TCG</h1>
      </header>

      <main>
        <PackOpener onOpen={handleCardsOpened} cards={INITIAL_CARDS} />
      </main>

      <section className="collection-view">
        {/* Collection display will go here */}
      </section>
    </div>
  );
}

export default App;
