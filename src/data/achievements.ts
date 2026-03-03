export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
}

export const ACHIEVEMENTS: Achievement[] = [
  // Pack milestones
  { id: 'first_pack', name: 'Baby Steps', description: 'Open your first pack', icon: '📦' },
  { id: 'packs_10', name: 'Getting Started', description: 'Open 10 packs', icon: '📦' },
  { id: 'packs_41', name: 'Dedicated', description: 'Open 41 packs', icon: '📦' },
  { id: 'packs_67', name: 'Committed', description: 'Open 67 packs', icon: '📦' },
  { id: 'packs_100', name: 'Century', description: 'Open 100 packs', icon: '💯' },
  { id: 'packs_420', name: 'Blazing', description: 'Open 420 packs', icon: '🔥' },
  { id: 'packs_1000', name: 'No Life', description: 'Open 1000 packs', icon: '💀' },

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
  { id: 'five_rarities', name: 'Rainbow Pack', description: 'Get 5 different rarities in one pack', icon: '🌈' },
  { id: 'no_commons', name: 'Above Average', description: 'Open a pack with no Common cards', icon: '⬆️' },
  { id: 'all_commons_pack', name: 'Rock Bottom', description: 'Get 5 Common cards in one pack', icon: '🪨' },
  { id: 'two_pair', name: 'Two Pair', description: 'Get 2 different pairs in one pack', icon: '✌️' },
  { id: 'double_holo', name: 'Double Rainbow', description: 'Get 2 holo cards in one pack', icon: '🌟' },
  { id: 'triple_holo', name: 'Triple Threat', description: 'Get 3 holo cards in one pack', icon: '⭐' },
  { id: 'quad_holo', name: 'Quad Shimmer', description: 'Get 4 holo cards in one pack', icon: '🌠' },
  { id: 'all_holos', name: 'Jackpot', description: 'Get 5 holo cards in one pack', icon: '💫' },

  // Collection milestones
  { id: 'collect_5', name: 'Starter Collection', description: 'Collect 5 unique cards', icon: '📚' },
  { id: 'collect_10', name: 'Growing Collection', description: 'Collect 10 unique cards', icon: '📚' },
  { id: 'complete_collection', name: 'Completionist', description: 'Find every unique card', icon: '🏆' },

  // Holo collection
  { id: 'holo_collector', name: 'Holo Collector', description: 'Collect 5 different Holo cards', icon: '💎' },
  { id: 'holo_10', name: 'Sparkle Enthusiast', description: 'Collect 10 different Holo cards', icon: '💎' },
  { id: 'holo_common', name: 'Polished Stone', description: 'Find a holo Common card', icon: '⚪' },
  { id: 'holo_uncommon', name: 'Green Gleam', description: 'Find a holo Uncommon card', icon: '🟢' },
  { id: 'holo_rare', name: 'Blue Shimmer', description: 'Find a holo Rare card', icon: '🔵' },
  { id: 'holo_epic', name: 'Purple Gleam', description: 'Find a holo Epic card', icon: '🟣' },
  { id: 'holo_legendary', name: 'Golden Shine', description: 'Find a holo Legendary card', icon: '🌟' },
  { id: 'holo_brainrot', name: 'Maximum Drip', description: 'Find a holo Brainrot card', icon: '🧠' },
  { id: 'holo_complete', name: 'Shiny Hunter', description: 'Collect a holo version of every card', icon: '👑' },
  { id: 'total_holos_25', name: 'Shiny Collection', description: 'Own 25 total holo cards', icon: '✨' },
  { id: 'total_holos_100', name: 'Blinding', description: 'Own 100 total holo cards', icon: '🌟' },

  // Rarity completion
  { id: 'all_commons', name: 'Common Ground Complete', description: 'Collect every Common card', icon: '⚪' },
  { id: 'all_uncommons', name: 'Uncommon Collector', description: 'Collect every Uncommon card', icon: '🟢' },
  { id: 'all_rares', name: 'Rare Completionist', description: 'Collect every Rare card', icon: '🔵' },
  { id: 'all_epics', name: 'Epic Journey Complete', description: 'Collect every Epic card', icon: '🟣' },
  { id: 'all_legendaries', name: 'Legendary Status', description: 'Collect every Legendary card', icon: '🟠' },
  { id: 'all_brainrots', name: 'Full Brainrot', description: 'Collect every Brainrot card', icon: '🧠' },

  // Special
  { id: 'lucky_day', name: 'Lucky Day', description: 'Get 2+ Legendary or Brainrot cards in one pack', icon: '🍀' },

  // Duplicate milestones
  { id: 'dupes_10', name: 'Card Hoarder', description: 'Own 10 copies of a single card', icon: '📚' },
  { id: 'dupes_25', name: 'Obsessed', description: 'Own 25 copies of a single card', icon: '🤪' },
  { id: 'dupes_100', name: 'Why Though?', description: 'Own 100 copies of a single card', icon: '❓' },

  // Account value milestones
  { id: 'value_10k', name: 'Five Figures', description: 'Reach 10,000 total account value', icon: '💵' },
  { id: 'value_100k', name: 'Six Figures', description: 'Reach 100,000 total account value', icon: '💰' },
  { id: 'value_1m', name: 'Millionaire', description: 'Reach 1,000,000 total account value', icon: '🤑' },

  // Pack Value
  { id: 'pack_value_5', name: 'Struck Nothing', description: 'Open a pack with exactly 5 Brainrot value', icon: '🗑️' },
  { id: 'pack_value_50', name: 'Decent Pull', description: 'Open a pack with at least 50 Brainrot value', icon: '💰' },
  { id: 'pack_value_100', name: 'Big Money', description: 'Open a pack with at least 100 Brainrot value', icon: '💎' },
  { id: 'pack_value_500', name: 'Struck Gold', description: 'Open a pack with at least 500 Brainrot value', icon: '👑' },
  { id: 'pack_value_1000', name: 'Thousandaire', description: 'Open a pack with at least 1,000 Brainrot value', icon: '🍷' },
  { id: 'pack_value_2000', name: 'Two Grand', description: 'Open a pack with at least 2,000 Brainrot value', icon: '🍾' },
  { id: 'pack_value_3000', name: 'Three Grand', description: 'Open a pack with at least 3,000 Brainrot value', icon: '🏦' },
  { id: 'pack_value_4000', name: 'Four Grand', description: 'Open a pack with at least 4,000 Brainrot value', icon: '🏙️' },
  { id: 'pack_value_5000', name: 'Five Grand', description: 'Open a pack with at least 5,000 Brainrot value', icon: '🚀' },
  { id: 'pack_value_6000', name: 'Six Grand', description: 'Open a pack with at least 6,000 Brainrot value', icon: '🏎️' },
  { id: 'pack_value_7000', name: 'Seven Grand', description: 'Open a pack with at least 7,000 Brainrot value', icon: '🚁' },
  { id: 'pack_value_8000', name: 'Eight Grand', description: 'Open a pack with at least 8,000 Brainrot value', icon: '✈️' },
  { id: 'pack_value_9000', name: 'Nine Grand', description: 'Open a pack with at least 9,000 Brainrot value', icon: '🏰' },
  { id: 'pack_value_10000', name: 'Ten Grand', description: 'Open a pack with at least 10,000 Brainrot value', icon: '🌌' },
  { id: 'pack_value_max', name: 'Literally Impossible', description: 'Open a pack with 10,000,000 Brainrot value', icon: '🤯' },
];

export const getAchievementById = (id: string): Achievement | undefined => ACHIEVEMENTS.find(a => a.id === id);
