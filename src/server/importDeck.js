/**
 * Deck import hook.
 *
 * WHY THIS IS A PASTE-AND-PARSE HOOK RATHER THAN A SCRAPER
 * -------------------------------------------------------
 * The brief asked for random decks pulled from moxfield.com/decks/public.
 * That is not buildable responsibly: Moxfield publishes no API (their FAQ says
 * the API is private), their endpoints reject non-browser clients, and their
 * terms prohibit automated requests. So the pool is curated instead, and this
 * module is the sanctioned doorway for real decks:
 *
 *   1. Paste a decklist (Moxfield/Archidekt/MTGO/Arena export) — works today.
 *   2. A permitted/partner API, or a provider that grants you access, can drop
 *      its response into `fromProviderDeck()` (see the bottom of this file).
 *
 * An imported deck gets the same treatment as a curated one: 100-card
 * normalisation, live Game Changers lookup, bracket profiling, and colour-
 * identity checks. Cards the engine only partially automates still play via the
 * compiler fallback and are reported in the coverage panel.
 */
import { oracle, GAME_CHANGERS, profileDeck } from '../decks/index.js';
import { BASIC_LANDS } from '../engine/cards.js';

const SECTION_RE = /^\s*(?:\/\/|#)?\s*(commander|commanders|deck|mainboard|main|sideboard|maybeboard|companion|tokens?)\s*:?\s*$/i;
const LINE_RE = /^\s*(\d+)\s*x?\s+(.+?)\s*(?:\([A-Z0-9]{2,6}\)\s*[\w-]*)?\s*$/i;
const COMMANDER_INLINE_RE = /^\s*(?:commander|commanders)\s*:\s*(.+)$/i;

/**
 * Parse a pasted decklist. Handles the common export shapes:
 *   "1 Sol Ring"            (Moxfield/Archidekt)
 *   "1x Sol Ring"           (MTGO)
 *   "1 Sol Ring (LTC) 283"  (Arena with set + collector number)
 *   "Commander: Chatterfang, Squirrel General"  /  "// Commander" sections
 */
export function parseDecklist(text, { deckName = 'Imported deck' } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const cards = [];
  const warnings = [];
  let section = 'deck';
  let commander = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^name\s*:/i.test(line)) {
      const nm = line.match(/^name\s*:\s*(.+)$/i);
      if (nm) deckName = nm[1].trim();
      continue;
    }
    const inline = line.match(COMMANDER_INLINE_RE);
    if (inline) { commander = inline[1].trim(); continue; }
    if (SECTION_RE.test(line)) {
      const m = line.replace(/^[\s/#]+/, '').replace(/:$/, '').toLowerCase();
      section = m.startsWith('command') ? 'commander' : m.startsWith('side') ? 'sideboard' : m.startsWith('maybe') ? 'maybeboard' : 'deck';
      continue;
    }
    const m = line.match(LINE_RE);
    if (!m) { warnings.push(`Could not read line: "${line}"`); continue; }
    const count = parseInt(m[1], 10);
    const name = m[2].replace(/\s*\/\/.*$/, '').trim();
    if (!name) continue;
    if (section === 'sideboard' || section === 'maybeboard') continue;
    for (let i = 0; i < count; i++) cards.push({ name, section });
  }

  if (!commander) {
    const flagged = cards.find((c) => c.section === 'commander');
    const candidate = flagged || cards.find((c) => /legendary/i.test(oracle[c.name.toLowerCase()]?.type_line || '') && !BASIC_LANDS.includes(c.name));
    if (candidate) commander = candidate.name;
  }
  if (!commander) warnings.push('No commander found — add a "Commander: <name>" line.');

  const spells = [];
  const nonbasicLands = [];
  const basics = {};
  for (const c of cards) {
    const key = c.name.toLowerCase();
    if (commander && c.name === commander) continue;
    const card = oracle[key];
    if (!card) { warnings.push(`Unknown card: ${c.name} (not in local oracle data)`); continue; }
    if (BASIC_LANDS.includes(card.name)) { basics[card.name] = (basics[card.name] || 0) + 1; continue; }
    if ((card.type_line || '').includes('Land')) { nonbasicLands.push(card.name); continue; }
    spells.push(card.name);
  }

  return { deckName, commander, spells, nonbasicLands, basics, warnings, unresolved: cards.filter((c) => !oracle[c.name.toLowerCase()]).map((c) => c.name) };
}

/** Profile + normalise an imported list into a deck the engine can play. */
export function buildImportedDeck(decklistText, opts = {}) {
  const parsed = parseDecklist(decklistText, opts);
  const warnings = [...parsed.warnings];
  if (!parsed.commander) throw new Error('An imported deck needs a commander.');
  const commanderCard = oracle[parsed.commander.toLowerCase()];
  if (!commanderCard) throw new Error(`Commander "${parsed.commander}" is not in the local card data.`);

  const deck = {
    id: opts.id || `import-${Math.random().toString(36).slice(2, 8)}`,
    name: parsed.deckName,
    bracket: opts.bracket ?? 4,
    theme: opts.theme || '#6b7280',
    themeName: opts.themeName || 'Imported',
    commander: commanderCard.name,
    prototype: opts.prototype || 'midrange',
    blurb: opts.blurb || 'Imported decklist.',
    spells: parsed.spells,
    lands: parsed.nonbasicLands,
    basics: parsed.basics,
    imported: true,
  };

  // Auto-bracket from the official rules when the caller doesn't specify one.
  const profile = profileDeck(deck);
  if (opts.bracket === undefined) {
    const gcs = profile.gameChangers.length;
    deck.bracket = gcs > 3 ? 5 : gcs > 0 ? 3 : (profile.combos.some((c) => c.kills) ? 4 : 2);
    warnings.push(`Bracket estimated as ${deck.bracket} from ${gcs} Game Changer(s) and ${profile.combos.length} detected combo(s).`);
  }

  // colour identity check against the commander
  const identity = new Set(commanderCard.color_identity || []);
  const offColour = [...deck.spells, ...deck.lands].filter((n) => {
    const card = oracle[n.toLowerCase()];
    return card && (card.color_identity || []).some((c) => !identity.has(c));
  });
  if (offColour.length) warnings.push(`Off-colour for ${deck.commander}: ${offColour.join(', ')}`);

  const total = 1 + deck.spells.length + deck.lands.length + Object.values(deck.basics).reduce((a, b) => a + b, 0);
  return {
    deck, warnings,
    summary: {
      total, spells: deck.spells.length, lands: deck.lands.length + Object.values(deck.basics).reduce((a, b) => a + b, 0),
      bracket: deck.bracket, gameChangers: profile.gameChangers, massLandDenial: profile.massLandDenial,
      extraTurns: profile.extraTurns, combos: profile.combos.map((c) => c.name),
      sizeWarning: total !== 100 ? `Deck is ${total} cards; the engine needs exactly 100 (it will pad basics).` : null,
      offColour,
      legalCommanders: GAME_CHANGERS.size,
    },
  };
}

/**
 * Adapter for a permitted provider (e.g. a partner API or a user's own export
 * endpoint). Map its JSON into this shape and everything downstream works.
 */
export function fromProviderDeck(providerJson) {
  const name = providerJson.name || 'Imported deck';
  const lines = [];
  const mainboard = providerJson.mainboard || providerJson.cards || [];
  for (const c of mainboard) lines.push(`${c.quantity || c.count || 1} ${c.name}`);
  const commanders = providerJson.commanders || providerJson.commander ? [providerJson.commander || providerJson.commanders].flat() : [];
  if (commanders.length) lines.unshift(`Commander: ${commanders[0].name || commanders[0]}`);
  return buildImportedDeck(lines.join('\n'), { id: providerJson.id, name });
}
