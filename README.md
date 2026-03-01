# Brainrot TCG

A meme-themed Trading Card Game pack opener built with React.

## Inspiration

We are professional brainrotters and so were inspired to create a trading card game for brainrot. 

## What it does

Open virtual card packs featuring internet meme characters by tearing them open! Drag across the dotted line to rip the pack, then reveal 5 cards one at a time. Cards come in four rarities (Common, Rare, Epic, Legendary) with weighted drop rates. Each reveal includes animations, sound effects, and 3D tilt interactions. Epic and Legendary pulls trigger confetti celebrations. Your collection is saved locally so you can track every card you've found.

## How we built it

- **React 19** with Vite for fast development
- **Framer Motion** for smooth card animations and transitions
- **Canvas Confetti** for celebratory effects on rare pulls
- **Custom audio system** with sound effects for tearing, flipping, and reveals
- **Local Storage** for persistent collection tracking

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

- **Interactive Pack Tearing** - Drag across the tear line to open packs with sparks and sound effects
- **Pack Opening Experience** - Cards revealed with smooth animations and confetti effects for rare pulls
- **Animated Title** - Wave animation with each character floating independently
- **Responsive Cards** - Cards scale dynamically to fit between the title and viewport bottom
- **Collection Browser** - Track your found cards with counts and rarity-colored borders
- **Rarity System** - Common, Rare, Epic, and Legendary cards with weighted drop rates
- **Sound Effects** - Background music, card flips, and randomized reveal sounds
- **3D Card Tilt** - Cards tilt based on mouse position for an interactive feel

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
- Canvas Confetti
- Local Storage (collection persistence)
