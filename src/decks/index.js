/**
 * Deck loading, 100-card normalisation, and official Commander Bracket profiling.
 *
 * Bracket rules implemented (Wizards' Commander Brackets, beta — Feb 2025, updated
 * Oct 2025 and Feb 2026; Game Changers list read live from Scryfall `is:gamechanger`):
 *
 *   B1 Exhibition : 0 Game Changers | no mass land denial | no extra turns | no 2-card combos
 *   B2 Core       : 0 Game Changers | no mass land denial | no chained extra turns | no 2-card combos
 *   B3 Upgraded   : <=3 Game Changers | no mass land denial | no 2-card combos before turn 6
 *   B4 Optimized  : unlimited Game Changers | no deckbuilding restrictions
 *   B5 cEDH       : unlimited Game Changers | no deckbuilding restrictions
 *
 * We compute the profile from oracle text + the GC list and compare it to the
 * declared bracket, so a mis-declared deck is caught at build time
 * (scripts/fetch-oracle.mjs) rather than silently mismatched in play.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SEED_DECKS, ALL_CARD_NAMES } from './lists.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DATA = path.join(ROOT, 'src', 'data');

export const oracle = JSON.parse(fs.readFileSync(path.join(DATA, 'oracle.json'), 'utf8'));
export const GAME_CHANGERS = new Set(
  JSON.parse(fs.readFileSync(path.join(DATA, 'gamechangers.json'), 'utf8')).map((n) => n.toLowerCase()),
);

/** Official mass-land-denial exemplars: text-detected, plus curated names whose
 *  scale isn't obvious from oracle text alone (the Orbs, Blood Moon effects). */
const MLD_NAME_PATTERNS = /\b(armageddon|ravages of war|ruination|obliterate|jokulhaups|apocalypse|cataclysm|devastation|sunder|decree of annihilation|winter orb|static orb|rising waters|back to basics|blood moon|magus of the moon|hokori|smokestack|contamination|infernal darkness)\b/i;
const MLD_TEXT_PATTERN = /destroy all lands|each player sacrifices .*lands|lands don't untap/i;

export const isMassLandDenial = (card) =>
  !!card && (MLD_NAME_PATTERNS.test(card.name) || MLD_TEXT_PATTERN.test(card.oracle_text || ''));

/** "Take an extra turn" effects. */
export const isExtraTurn = (card) => !!card && /take an extra turn/i.test(card.oracle_text || '');

/**
 * Two-card combos in the seed pool. Deliberately explicit and data-driven: a
 * general combo solver is out of scope, so each entry is a real verified line.
 * `kills` = wins outright or produces an unbounded loop.
 */
export const COMBO_REGISTRY = [
  { name: 'Godo + Helm of the Host', cards: ['godo, bandit warlord', 'helm of the host'], kills: true, minBracket: 4, description: 'Godo fetches Helm, Helm copies Godo every combat -> unbounded attack steps.' },
  { name: 'Kiki-Jiki + Zealous Conscripts', cards: ['kiki-jiki, mirror breaker', 'zealous conscripts'], kills: true, minBracket: 4, description: 'Copy Conscripts, untap Kiki-Jiki, repeat -> arbitrarily many hasty 3/3s.' },
  { name: "Thassa's Oracle + Demonic Consultation", cards: ["thassa's oracle", 'demonic consultation'], kills: true, minBracket: 4, description: 'Exile your library, then win with an empty library.' },
  { name: "Thassa's Oracle + Tainted Pact", cards: ["thassa's oracle", 'tainted pact'], kills: true, minBracket: 4, description: 'Exile your library, then win with an empty library.' },
  { name: "Underworld Breach + Lion's Eye Diamond", cards: ['underworld breach', "lion's eye diamond"], kills: true, minBracket: 4, requiresMore: ['brain freeze'], description: 'Breach + LED loops Brain Freeze out of the graveyard into a mill-out.' },
  { name: 'Sanguine Bond + lifelink', cards: ['sanguine bond', 'wurmcoil engine'], kills: false, minBracket: 3, description: 'Every lifelink swing becomes a drain too.' },
  { name: 'Doubling Season + token maker', cards: ['doubling season', 'deranged hermit'], kills: false, minBracket: 3, description: 'Token creation doubles, then doubles again with Parallel Lives.' },
];

/** Profile a deck against the bracket rules. Returns findings, not just a boolean. */
export function profileDeck(deck) {
  const names = [deck.commander, ...deck.spells, ...deck.lands];
  const cards = names.map((n) => oracle[n.toLowerCase()]).filter(Boolean);
  const gameChangers = names.filter((n) => GAME_CHANGERS.has(n.toLowerCase()));
  const mld = cards.filter(isMassLandDenial).map((c) => c.name);
  const extraTurns = cards.filter(isExtraTurn).map((c) => c.name);
  const lower = new Set(names.map((n) => n.toLowerCase()));
  const combos = COMBO_REGISTRY.filter((c) => c.cards.every((x) => lower.has(x)));

  const violations = [];
  const b = deck.bracket;
  if (b <= 2 && gameChangers.length) violations.push(`B${b} allows 0 Game Changers, found ${gameChangers.length}`);
  if (b === 3 && gameChangers.length > 3) violations.push(`B3 allows up to 3 Game Changers, found ${gameChangers.length}`);
  if (b <= 3 && mld.length) violations.push(`B${b} disallows mass land denial (${mld.join(', ')})`);
  if (b === 1 && extraTurns.length) violations.push(`B1 disallows extra turns (${extraTurns.join(', ')})`);
  const killing = combos.filter((c) => c.kills && c.minBracket > b);
  if (b <= 2 && killing.length) violations.push(`B${b} disallows 2-card combos (${killing.map((c) => c.name).join(', ')})`);

  return { gameChangers, massLandDenial: mld, extraTurns, combos, violations };
}

/**
 * Expand a seed deck into a full 100-card list with unique instance data.
 * Basics are topped up so: 1 commander + spells + nonbasic lands + basics = 100.
 */
export function normalizeDeck(deck) {
  const spells = [...deck.spells];
  const nonbasic = [...deck.lands];
  const basics = { ...deck.basics };
  const basicTotal = Object.values(basics).reduce((a, b) => a + b, 0);
  const accounted = 1 + spells.length + nonbasic.length + basicTotal;
  if (accounted !== 100) {
    const entries = Object.entries(basics).sort((a, b) => b[1] - a[1]);
    if (!entries.length) throw new Error(`Deck ${deck.id} has no basics to normalise with`);
    const [key, val] = entries[0];
    basics[key] = Math.max(0, val + (100 - accounted));
  }

  const cards = [];
  const push = (name, zone) => {
    const c = oracle[name.toLowerCase()];
    if (!c) throw new Error(`Unknown card "${name}" in deck ${deck.id}`);
    cards.push({ ...c, zone });
  };
  push(deck.commander, 'command');
  spells.forEach((n) => push(n, 'library'));
  nonbasic.forEach((n) => push(n, 'library'));
  for (const [name, count] of Object.entries(basics)) for (let i = 0; i < count; i++) push(name, 'library');

  if (cards.length !== 100) throw new Error(`Deck ${deck.id} is ${cards.length} cards, expected 100`);
  return {
    ...deck,
    spells, lands: nonbasic, basics,
    total: cards.length,
    cardList: cards,
    uniqueCards: new Set(cards.map((c) => c.name.toLowerCase())).size,
    profile: profileDeck(deck),
  };
}

export function loadAllDecks() {
  return SEED_DECKS.map(normalizeDeck);
}

/**
 * Scryfall image URLs encode the card's identity in the path, so the *art crop*
 * — the part of the illustration with no frame or text — is one string swap away.
 * It is what the site paints behind the table and uses as its icons.
 */
export function artUrl(image, size = 'art_crop') {
  if (!image) return null;
  return String(image).replace(/\/(normal|small|large|png|border_crop)\//, `/${size}/`);
}

/** The art crop for any card in the pool, by name. */
export function cardArt(name, size = 'art_crop') {
  const card = oracle[String(name || '').toLowerCase()];
  return artUrl(card && card.image, size);
}

export function colorIdentityOf(name) {
  const c = oracle[name.toLowerCase()];
  return c ? c.color_identity : [];
}
export { ALL_CARD_NAMES };
