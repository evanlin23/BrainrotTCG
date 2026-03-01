# Brainrot TCG

A meme-themed Trading Card Game pack opener built with React.

## Inspiration

We are professional brainrotters and so were inspired to create a trading card game for brainrot. 

## What it does

Open virtual card packs featuring internet meme characters. Each pack contains 5 cards with different rarities (Common, Rare, Epic, Legendary). Cards are revealed one at a time with animations, sound effects, and text-to-speech announcing each card name. Rare pulls trigger confetti celebrations.

## How we built it

- **React 19** with Vite for fast development
- **Framer Motion** for smooth card animations and transitions
- **ElevenLabs TTS** API for dynamic card name announcements
- **Canvas Confetti** for celebratory effects on rare pulls
- Auto-discovery system that scans `src/assets/` for card images

## Challenges we ran into

The generation of the cards was the most challenging part of the project. We had to generate a large number of cards and ensure that they were unique.

## Accomplishments that we're proud of

We are proud of the pack opening experience and the commentary. 

## What we learned

I learned a lot about brainrot and using elevenlabs text to speech. I also learned a lot about image generationg using nano banana.

## What's next for BrainrotTCG

We would love to expand the card selection to include more brainrot characters and packs.

---

## Features

- **Pack Opening Experience** - Open packs with smooth animations and confetti effects for rare pulls
- **Rarity System** - Common, Rare, Epic, and Legendary cards with weighted drop rates
- **Text-to-Speech** - Card names announced via ElevenLabs TTS on reveal
- **Auto Card Discovery** - Drop images in `src/assets/` and they're automatically added as cards

## Setup

```bash
npm install
npm run dev
```

## Adding Cards

1. Add an image to `src/assets/` (e.g., `mycard.png`)
2. Optionally add metadata in `src/data/cards.json`:

```json
{
  "mycard": {
    "name": "My Card Name",
    "rarity": "EPIC",
    "description": "Card description here.",
    "hp": 5000,
    "atk": 3000
  }
}
```

Cards without metadata get default stats.

## Tech Stack

- React 19
- Vite
- Framer Motion
- ElevenLabs TTS
- Canvas Confetti
