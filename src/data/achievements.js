export const ACHIEVEMENTS = [
  // Pack milestones
  { id: 'first_pack', name: 'Baby Steps', description: 'Open your first pack', icon: '📦' },
  { id: 'packs_10', name: 'Getting Started', description: 'Open 10 packs', icon: '📦' },
  { id: 'packs_41', name: 'Dedicated', description: 'Open 41 packs', icon: '📦' },
  { id: 'packs_67', name: 'Committed', description: 'Open 67 packs', icon: '📦' },
  { id: 'packs_100', name: 'Century', description: 'Open 100 packs', icon: '💯' },
  { id: 'packs_420', name: 'Blazing', description: 'Open 420 packs', icon: '🔥' },

  // Rarity discoveries
  { id: 'first_common', name: 'Common Ground', description: 'Find your first Common card', icon: '⚪' },
  { id: 'first_uncommon', name: 'Uncommon Find', description: 'Find your first Uncommon card', icon: '🟢' },
  { id: 'first_rare', name: 'Rare Discovery', description: 'Find your first Rare card', icon: '🔵' },
  { id: 'first_epic', name: 'Epic Moment', description: 'Find your first Epic card', icon: '🟣' },
  { id: 'first_legendary', name: 'Legendary Pull', description: 'Find your first Legendary card', icon: '🟠' },
  { id: 'first_brainrot', name: 'Maximum Brainrot', description: 'Find your first Brainrot card', icon: '🌈' },
  { id: 'first_holo', name: 'Shiny!', description: 'Find your first Holo card', icon: '✨' },

  // Pack combos (in a single pack)
  { id: 'two_of_kind', name: '2 of a Kind', description: 'Get 2 of the same card in one pack', icon: '👯' },
  { id: 'three_of_kind', name: '3 of a Kind', description: 'Get 3 of the same card in one pack', icon: '🎲' },
  { id: 'four_of_kind', name: '4 of a Kind', description: 'Get 4 of the same card in one pack', icon: '🃏' },
  { id: 'five_of_kind', name: '5 of a Kind', description: 'Get 5 of the same card in one pack', icon: '🎰' },
  { id: 'full_house', name: 'Full House', description: 'Get 3+2 matching cards in one pack', icon: '🏠' },
  { id: 'all_same_rarity', name: 'Monochrome', description: 'Get 5 cards of the same rarity in one pack', icon: '🎨' },

  // Collection milestones
  { id: 'collect_5', name: 'Starter Collection', description: 'Collect 5 unique cards', icon: '📚' },
  { id: 'collect_10', name: 'Growing Collection', description: 'Collect 10 unique cards', icon: '📚' },
  { id: 'complete_collection', name: 'Completionist', description: 'Find every unique card', icon: '🏆' },
  { id: 'holo_collector', name: 'Holo Collector', description: 'Collect 5 different Holo cards', icon: '💎' },

  // Special
  { id: 'lucky_day', name: 'Lucky Day', description: 'Get 2+ Legendary or Brainrot cards in one pack', icon: '🍀' },
];

export const getAchievementById = (id) => ACHIEVEMENTS.find(a => a.id === id);
