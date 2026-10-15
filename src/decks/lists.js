/**
 * Seed deck pool — 10 real Commander decks, two per official Commander Bracket.
 *
 * Lists are authored as: 1 commander + N spells + M non-basic lands + basics.
 * `normalizeDeck()` (src/decks/index.js) tops up the basic lands so every deck is
 * exactly 100 cards, the way a real decklist is built.
 *
 * Every name is validated against live Scryfall oracle data by scripts/fetch-oracle.mjs:
 *   - card exists (typo detection)
 *   - card is Commander-legal (bans like Dockside Extortionist are caught)
 *   - card's colour identity fits the commander's
 *   - Game Changer count is legal for the bracket (B1/B2: 0, B3: <=3, B4/B5: any)
 *
 * `theme` is the accent colour the UI adopts when this deck is the bot opponent.
 * `prototype` is the bot's plan: aggro | midrange | control | combo
 */

// --- shared, engine-simple staples (reused across decks to keep the oracle pool tight) ---
const G_MANA = ['Birds of Paradise', 'Llanowar Elves', 'Elvish Mystic', 'Sakura-Tribe Elder',
  'Wood Elves', 'Farhaven Elf', 'Farseek', 'Cultivate', 'Kodama\'s Reach', 'Rampant Growth',
  'Nature\'s Lore', 'Three Visits', 'Explosive Vegetation'];
const G_VALUE = ['Elvish Visionary', 'Reclamation Sage', 'Harmonize', 'Return of the Wildspeaker', 'Beast Whisperer'];
const B_REMOVAL = ['Doom Blade', 'Murder', 'Hero\'s Downfall', 'Read the Bones', 'Sign in Blood',
  'Phyrexian Arena', 'Gray Merchant of Asphodel', 'Noxious Gearhulk', 'Crypt Ghast', 'Geth\'s Verdict',
  'Plaguecrafter', 'Vampire Nighthawk'];
const W_REMOVAL = ['Swords to Plowshares', 'Path to Exile', 'Generous Gift', 'Disenchant', 'Return to Dust',
  'Condemn', 'Pacifism', 'Banisher Priest', 'Fiend Hunter', 'Wrath of God', 'Day of Judgment'];
const W_TOKENS = ['Blade Splicer', 'Cloudgoat Ranger', 'Spectral Procession', 'Mentor of the Meek',
  'Requiem Angel', 'Captain of the Watch', 'Sun Titan'];
const R_BURN = ['Lightning Bolt', 'Shock', 'Lightning Strike', 'Incinerate', 'Magma Jet', 'Abrade',
  'Chaos Warp', 'Vandalblast', 'Faithless Looting', 'Tormenting Voice', 'Cathartic Reunion', 'Pyroclasm'];
const R_GOBLINS = ['Goblin Rabblemaster', 'Dragon Fodder', 'Krenko\'s Command', 'Impact Tremors',
  'Hordeling Outburst', 'Beetleback Chief', 'Siege-Gang Commander'];
const ARTIFACT_MANA = ['Sol Ring', 'Arcane Signet', 'Mind Stone', 'Fellwar Stone', 'Solemn Simulacrum',
  'Skullclamp', 'Thought Vessel', 'Wayfarer\'s Bauble', 'Hedron Archive', 'Worn Powerstone'];
const U_DRAW = ['Ponder', 'Preordain', 'Divination', 'Concentrate', 'Mana Leak', 'Essence Scatter',
  'Counterspell', 'Negate', 'Arcane Denial', 'Unsummon', 'Opt'];

export const SEED_DECKS = [
  /* ================= BRACKET 1 — Exhibition (theme first, zero Game Changers) ================= */
  {
    id: 'squirrel-swarm',
    name: 'Squirrel Swarm',
    bracket: 1,
    theme: '#2f6b3a',
    themeName: 'Deep Forest',
    commander: 'Chatterfang, Squirrel General',
    prototype: 'midrange',
    blurb: 'Every token becomes a Squirrel. Every Squirrel becomes a problem.',
    spells: [
      'Squirrel Sovereign', 'Nut Collector', 'Deranged Hermit', 'Deep Forest Hermit',
      'Squirrel Nest', 'Scurry Oak', 'Mazirek, Kraul Death Priest', 'Creakwood Liege',
      'Poison-Tip Archer', 'Blood Artist', 'Zulaport Cutthroat', 'Viscera Seer',
      'Pitiless Plunderer', 'Woe Strider', 'Ashnod\'s Altar', 'Skullclamp',
      'Beastmaster Ascension', 'Parallel Lives', 'Doubling Season', 'Second Harvest',
      'Overwhelming Stampede', 'Beast Within', 'Putrefy', 'Assassin\'s Trophy', 'Deathsprout',
      'Grave Pact', 'Dictate of Erebos', 'Moldervine Reclamation', 'Triumph of the Hordes',
      'Craterhoof Behemoth', 'Golgari Signet', 'Overrun',
      ...G_MANA.slice(0, 9), ...G_VALUE.slice(0, 3), ...B_REMOVAL.slice(0, 8), ...ARTIFACT_MANA.slice(2, 6),
    ],
    lands: ['Command Tower', 'Overgrown Tomb', 'Woodland Cemetery', 'Llanowar Wastes',
      'Temple of Malady', 'Necroblossom Snarl', 'Bojuka Bog'],
    basics: { Forest: 18, Swamp: 14 },
  },
  {
    id: 'sea-monsters',
    name: 'The Deep End',
    bracket: 1,
    theme: '#12628f',
    themeName: 'Abyssal Blue',
    commander: 'Arixmethes, Slumbering Isle',
    prototype: 'control',
    blurb: 'A sleeping island wakes up angry, and it brought friends.',
    spells: [
      'Slinn Voda, the Rising Deep', 'Whelming Wave', 'Quest for Ula\'s Temple',
      'Lorthos, the Tidemaker', 'Tromokratis', 'Shipbreaker Kraken', 'Breaching Leviathan',
      'Stormtide Leviathan', 'Inkwell Leviathan', 'Kederekt Leviathan', 'Spawning Kraken',
      'Aesi, Tyrant of Gyre Strait', 'Tatyova, Benthic Druid', 'Rashmi, Eternities Crafter',
      'Simic Sky Swallower', 'Mystic Snake', 'Bident of Thassa', 'Coiling Oracle',
      'Prime Speaker Zegana', 'Arbor Elf', 'Tireless Tracker', 'Kiora\'s Follower',
      'Chromatic Lantern', 'Simic Signet', 'Reality Shift', 'Explosive Vegetation',
      'Circuitous Route', 'Naturalize', 'Krosan Grip', 'Growth Spiral', 'Explore', 'Urban Evolution',
      ...G_MANA.slice(0, 8), ...G_VALUE.slice(0, 2), ...U_DRAW,
    ],
    lands: ['Command Tower', 'Breeding Pool', 'Hinterland Harbor', 'Yavimaya Coast',
      'Temple of Mystery', 'Simic Growth Chamber', 'Thornwood Falls'],
    basics: { Forest: 18, Island: 17 },
  },

  /* ================= BRACKET 2 — Core (unoptimized, still zero Game Changers) ================= */
  {
    id: 'kemba-equipment',
    name: 'Kemba\'s Pride',
    bracket: 2,
    theme: '#c9a227',
    themeName: 'Sunlit Steel',
    commander: 'Kemba, Kha Regent',
    prototype: 'aggro',
    blurb: 'Suit up the cat. Then suit up the cats the cat made.',
    spells: [
      'Leonin Shikari', 'Puresteel Paladin', 'Stoneforge Mystic', 'Ajani\'s Pridemate',
      'Leonin Warleader', 'Regal Caracal', 'Leonin Skyhunter', 'Brimaz, King of Oreskos',
      'White Sun\'s Zenith', 'Sacred Cat', 'Adorned Pouncer', 'Skyhunter Skirmisher',
      "Kemba's Skyguard", 'Jazal Goldmane', 'Herald\'s Horn', 'Heirloom Blade',
      'Sword of Vengeance', 'Loxodon Warhammer', 'Bonesplitter', 'Open the Armory',
      'Cathars\' Crusade', 'Honor of the Pure', 'Spear of Heliod', 'Intangible Virtue',
      'Secure the Wastes', 'Anointed Procession', 'Pearl Medallion', 'Marble Diamond',
      'Auriok Steelshaper', 'Stonehewer Giant', 'True Conviction', 'Serra Angel',
      'Glorious Anthem', 'Cathar\'s Companion',
      ...W_REMOVAL, ...W_TOKENS, ...ARTIFACT_MANA.slice(0, 5),
    ],
    lands: ['Command Tower', 'Nykthos, Shrine to Nyx', 'Emeria, the Sky Ruin'],
    basics: { Plains: 38 },
  },
  {
    id: 'torbran-burn',
    name: 'Everything Burns',
    bracket: 2,
    theme: '#a8341f',
    themeName: 'Ember Red',
    commander: 'Torbran, Thane of Red Fell',
    prototype: 'aggro',
    blurb: 'Every point of damage is three points of damage now.',
    spells: [
      'Guttersnipe', 'Firebrand Archer', 'Thermo-Alchemist', 'Electrostatic Field',
      'Kessig Flamebreather', 'Young Pyromancer', 'Banefire', 'Comet Storm',
      'Chandra\'s Ignition', 'Blasphemous Act', 'Reverberate', 'Dualcaster Mage',
      'Pyromancer\'s Goggles', 'Gratuitous Violence', 'Furnace of Rath', 'Mana Geyser',
      'Fire Diamond', 'Ruby Medallion', 'Fanatic of Mogis', 'Anger of the Gods',
      'Rummaging Goblin', 'Goblin Chieftain', 'Goblin Warchief', 'Reckless Bushwhacker',
      'Lightning Mauler', 'Chandra\'s Spitfire', 'Hellrider', 'Thunderbreak Regent',
      'Dictate of the Twin Gods', 'Storm\'s Wrath', 'Chain Reaction', 'Rolling Earthquake',
      'Fireball', 'Purphoros, God of the Forge', 'Caged Sun', 'Gauntlet of Power',
      'Neheb, the Eternal', 'Fire Servant', 'Meteor Golem', 'Shattering Spree',
      ...R_BURN.slice(0, 6), ...R_GOBLINS, ...ARTIFACT_MANA.slice(0, 3),
    ],
    lands: ['Valakut, the Molten Pinnacle', 'Nykthos, Shrine to Nyx', 'Myriad Landscape'],
    basics: { Mountain: 37 },
  },

  /* ================= BRACKET 3 — Upgraded (<=3 Game Changers, real synergy) ================= */
  {
    id: 'teysa-aristocrats',
    name: 'Death Is a Resource',
    bracket: 3,
    theme: '#6b5b95',
    themeName: 'Funeral Violet',
    commander: 'Teysa Karlov',
    prototype: 'midrange',
    blurb: 'Nothing dies once. Everything dies twice, and you get paid for it.',
    spells: [
      'Blood Artist', 'Zulaport Cutthroat', 'Cruel Celebrant', 'Elenda, the Dusk Rose',
      'Pitiless Plunderer', 'Pawn of Ulamog', 'Sifter of Skulls', 'Grave Pact',
      'Dictate of Erebos', 'Butcher of Malakir', 'Viscera Seer', 'Carrion Feeder',
      'Yahenni, Undying Partisan', 'Ashnod\'s Altar', 'Phyrexian Altar', 'Smothering Tithe',
      'Anointed Procession', 'Divine Visitation', 'Demonic Tutor', 'Anguished Unmaking',
      'Despark', 'Toxic Deluge', 'Living Death', 'Midnight Reaper', 'Grim Haruspex',
      'Orzhov Signet', 'Commander\'s Sphere', 'Mortify', 'Utter End', 'Grave Titan',
      'Wurmcoil Engine', 'Sanguine Bond', 'Divinity of Pride',
      ...B_REMOVAL, ...W_REMOVAL.slice(0, 7), ...ARTIFACT_MANA.slice(0, 5),
    ],
    lands: ['Command Tower', 'Godless Shrine', 'Isolated Chapel', 'Caves of Koilos',
      'Temple of Silence', 'Bojuka Bog', 'Shambling Vent'],
    basics: { Swamp: 19, Plains: 16 },
  },
  {
    id: 'omnath-landfall',
    name: 'The Land Reaches Back',
    bracket: 3,
    theme: '#b5551e',
    themeName: 'Molten Roots',
    commander: 'Omnath, Locus of Rage',
    prototype: 'midrange',
    blurb: 'Play a land, get a 5/5. Play eight lands a turn, get eight.',
    spells: [
      'Lotus Cobra', 'Tireless Provisioner', 'Tireless Tracker', 'Azusa, Lost but Seeking',
      'Exploration', 'Oracle of Mul Daya', 'Wayward Swordtooth', 'Dryad of the Ilysian Grove',
      'Ramunap Excavator', 'Crucible of Worlds', 'Scapeshift', 'Roiling Regrowth', 'Harrow',
      'Decimate', 'Zuran Orb', 'Perilous Forays', 'Greater Good', 'Elemental Bond',
      'Where Ancients Tread', 'Warstorm Surge', 'Rampaging Baloths', 'Avenger of Zendikar',
      'Craterhoof Behemoth', 'Acidic Slime', 'Terastodon', 'Boundless Realms',
      'Traverse the Outlands', 'Living Twister', 'Titania, Protector of Argoth',
      'Mina and Denn, Wildborn', 'Skarrg Guildmage', 'Dragonlair Spider', 'Fires of Yavimaya',
      'Overrun', 'Harmonize', 'Return of the Wildspeaker',
      ...G_MANA.slice(0, 10), ...G_VALUE.slice(0, 2), ...ARTIFACT_MANA.slice(0, 4),
    ],
    lands: ['Command Tower', 'Stomping Ground', 'Rootbound Crag', 'Karplusan Forest',
      'Temple of Abandon', 'Raging Ravine', 'Kessig Wolf Run', 'Ancient Tomb'],
    basics: { Forest: 20, Mountain: 14 },
  },

  /* ================= BRACKET 4 — Optimized (no Game Changer cap, real interaction) ================= */
  {
    id: 'yuriko-tempo',
    name: 'Ninjutsu Tempo',
    bracket: 4,
    theme: '#1f3b73',
    themeName: 'Midnight Ninja',
    commander: 'Yuriko, the Tiger\'s Shadow',
    prototype: 'control',
    blurb: 'Cheat Yuriko in, flip a huge spell, drain the table for free.',
    spells: [
      'Ninja of the Deep Hours', 'Fallen Shinobi', 'Ingenious Infiltrator', 'Moonblade Shinobi',
      'Throat Slitter', 'Okiba-Gang Shinobi', 'Ornithopter', 'Memnite', 'Baleful Strix',
      'Brainstorm', 'Counterspell', 'Force of Will', 'Fierce Guardianship', 'Mana Drain',
      'Cyclonic Rift', 'Toxic Deluge', 'Snuff Out', 'Dismember', 'Temporal Trespass',
      'Treasure Cruise', 'Dig Through Time', 'Scroll Rack', 'Sensei\'s Divining Top',
      'Dimir Signet', 'Talisman of Dominance', 'Vampiric Tutor', 'Demonic Tutor',
      'Treasure Mage', 'Trinket Mage', 'Spellseeker', 'Notion Thief', 'Nightveil Specter',
      'Higure, the Still Wind', 'Ink-Eyes, Servant of Oni', 'Silent-Blade Oni',
      'Dokuchi Silencer', 'Mistblade Shinobi', 'Walker of Secret Ways', 'Bident of Thassa',
      'Reconnaissance Mission', 'Mystic Remora', 'Night\'s Whisper',
      ...B_REMOVAL, ...U_DRAW.slice(0, 6), ...ARTIFACT_MANA.slice(0, 3),
    ],
    lands: ['Command Tower', 'Watery Grave', 'Drowned Catacomb', 'Underground River',
      'Temple of Deceit', 'Bojuka Bog', 'Creeping Tar Pit'],
    basics: { Island: 18, Swamp: 15 },
  },
  {
    id: 'winota-aggro',
    name: 'No Humans Allowed',
    bracket: 4,
    theme: '#8f2d3b',
    themeName: 'War Banner',
    commander: 'Winota, Joiner of Forces',
    prototype: 'aggro',
    blurb: 'Winota cheats a Human into play, which cheats another one in. Repeat.',
    spells: [
      'Krenko, Tin Street Kingpin', 'Legion Warboss', 'Hanweir Garrison', 'Hero of Bladehold',
      'Brimaz, King of Oreskos', 'Raise the Alarm', 'Assemble the Legion', 'Young Pyromancer',
      'Goblin Bombardment', 'Anointed Procession', 'Cathars\' Crusade', 'Boros Signet',
      'Talisman of Conviction', 'Aurelia, the Warleader', 'Combat Celebrant', 'Hellrider',
      'Recruiter of the Guard', 'Ranger of Eos', 'Revoke Existence', 'Boros Reckoner',
      'Legion Loyalist', 'Tajic, Blade of the Legion', 'Skyknight Legionnaire',
      'Firemane Avenger', 'Stoneforge Mystic', 'Sword of Vengeance', 'Loxodon Warhammer',
      'Marshal\'s Anthem', 'Glorious Anthem', 'Blasphemous Act',
      ...R_GOBLINS, ...W_REMOVAL.slice(0, 9), ...W_TOKENS.slice(0, 4), ...ARTIFACT_MANA.slice(0, 4),
    ],
    lands: ['Command Tower', 'Sacred Foundry', 'Clifftop Retreat', 'Battlefield Forge',
      'Temple of Triumph', 'Slayers\' Stronghold', 'Needle Spires'],
    basics: { Plains: 19, Mountain: 17 },
  },

  /* ================= BRACKET 5 — cEDH (metagamed, fast, combo-first) ================= */
  {
    id: 'kess-storm',
    name: 'Storm Logic',
    bracket: 5,
    theme: '#4a1f5c',
    themeName: 'Grixis Storm',
    commander: 'Kess, Dissident Mage',
    prototype: 'combo',
    blurb: 'Cast everything twice, draw your deck, win at instant speed.',
    spells: [
      'Ad Nauseam', 'Underworld Breach', 'Lion\'s Eye Diamond', 'Mana Vault', 'Grim Monolith',
      'Chrome Mox', 'Mox Diamond', 'Demonic Tutor', 'Vampiric Tutor', 'Mystical Tutor',
      'Imperial Seal', 'Thassa\'s Oracle', 'Dark Ritual', 'Cabal Ritual', 'Mana Drain',
      'Gitaxian Probe', 'Force of Will', 'Fierce Guardianship', 'Pact of Negation',
      'Tainted Pact', 'Demonic Consultation', 'Necropotence', 'Bolas\'s Citadel', 'Doomsday',
      'Dimir Signet', 'Rakdos Signet', 'Izzet Signet', 'Lotus Petal', 'Sensei\'s Divining Top',
      'Windfall', 'Wheel of Fortune', 'Jeska\'s Will', 'Gamble', 'Brain Freeze',
      'Tendrils of Agony', 'Dark Confidant', 'Notion Thief', 'Mystic Remora', 'Rhystic Study',
      'Cyclonic Rift', 'Toxic Deluge', 'Snuff Out', 'Dismember', 'Treasure Cruise',
      'Dig Through Time', 'Talisman of Dominance', 'Talisman of Indulgence', 'Talisman of Creativity',
      'Imperial Recruiter', 'Spellseeker', 'Dark Petition', 'Night\'s Whisper', 'Sign in Blood',
      'Ponder', 'Preordain', 'Brainstorm', 'Fellwar Stone', 'Mind Stone', 'Sol Ring', 'Arcane Signet',
    ],
    lands: ['Command Tower', 'Underground Sea', 'Volcanic Island', 'Badlands', 'Watery Grave',
      'Steam Vents', 'Blood Crypt', 'City of Brass', 'Mana Confluence', 'Reflecting Pool'],
    basics: { Island: 8, Swamp: 5, Mountain: 4 },
  },
  {
    id: 'godo-helm',
    name: 'One Combat Is Enough',
    bracket: 5,
    theme: '#7a2d10',
    themeName: 'Warforge',
    commander: 'Godo, Bandit Warlord',
    prototype: 'combo',
    blurb: 'Godo fetches Helm of the Host. Helm makes more Godos. Math happens.',
    spells: [
      'Helm of the Host', 'Sword of Fire and Ice', 'Umezawa\'s Jitte', 'Lightning Greaves',
      'Swiftfoot Boots', 'Thousand-Year Elixir', 'Mana Vault', 'Grim Monolith', 'Chrome Mox',
      'Mox Diamond', 'Lion\'s Eye Diamond', 'Blood Moon', 'Magus of the Moon', 'Gamble',
      'Jeska\'s Will', 'Deflecting Swat', 'Pyroblast', 'Red Elemental Blast', 'Chaos Warp',
      'Abrade', 'Vandalblast', 'Goblin Welder', 'Goblin Engineer', 'Kiki-Jiki, Mirror Breaker',
      'Zealous Conscripts', 'Aggravated Assault', 'Sword of Feast and Famine', 'Ruby Medallion',
      'Fire Diamond', 'Sensei\'s Divining Top', 'Scroll Rack', 'Imperial Recruiter',
      'Ragavan, Nimble Pilferer', 'Treasonous Ogre', 'Goblin Matron', 'Goblin Recruiter',
      'Goblin Chieftain', 'Goblin Warchief', 'Krenko, Mob Boss', 'Purphoros, God of the Forge',
      'Impact Tremors', 'Goblin Bombardment', 'Caged Sun', 'Gauntlet of Might', 'Mox Amber',
      'Lotus Petal', 'Simian Spirit Guide', 'Mox Opal', 'Bloodforged Battle-Axe', 'Fireshrieker',
      'Sword of Light and Shadow', 'Basilisk Collar', 'Expedition Map', 'Embercleave',
      'Andúril, Flame of the West', 'Sol Ring', 'Mind Stone', 'Skullclamp', 'Wayfarer\'s Bauble',
      'Hedron Archive',
    ],
    lands: ['Ancient Tomb', 'Nykthos, Shrine to Nyx', 'Kher Keep', 'Great Furnace', 'Darksteel Citadel'],
    basics: { Mountain: 30 },
  },
];

export const deckCardNames = (d) => [d.commander, ...d.spells, ...d.lands];

export const BASIC_NAMES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];

export const ALL_CARD_NAMES = () => [
  ...new Set([...SEED_DECKS.flatMap(deckCardNames), ...BASIC_NAMES, ...SEED_DECKS.flatMap((d) => Object.keys(d.basics))]),
];
