/**
 * Uploaded-deck verification.
 *
 * An uploaded deck may only join the shared rotation when it is *completely*
 * playable — for everyone, on every device, with no simplified fallback. That is
 * a higher bar than "it loaded", so this module runs the deck through the same
 * gauntlet the hand-built seed decks pass:
 *
 *   1. it parses into 100 cards with a legal commander
 *   2. every card is known to the engine (no unresolved names)
 *   3. singleton, except basics
 *   4. colour identity fits the commander
 *   5. the declared/derived bracket's official rules hold
 *      (Game Changers, mass land denial, extra turns, 2-card combos)
 *   6. every card is FULLY automated by the engine — hand-scripted, or compiled
 *      with zero unparsed oracle clauses. A card the engine can only half-play
 *      would silently misbehave in someone else's game, so it blocks the deck
 *      and is reported by name with the exact phrase that isn't supported yet.
 *
 * The result is a report that explains itself either way, so a rejection tells
 * the uploader exactly which cards stand between them and the rotation.
 */
import { oracle, profileDeck, normalizeDeck, GAME_CHANGERS, isMassLandDenial, isExtraTurn, COMBO_REGISTRY } from '../decks/index.js';
import { cardScript, HAND_SCRIPTS } from '../engine/scripts.js';
import { buildImportedDeck } from './importDeck.js';

/** How completely the engine automates one card. Mirrors scripts/coverage.mjs. */
export function automationOf(card) {
  const script = cardScript(card);
  const hand = !!HAND_SCRIPTS[(card.name || '').toLowerCase()];
  const behaviours = (script.mana.length ? 1 : 0) + script.abilities.length + script.triggers.length
    + script.statics.length + (script.steps?.length ? 1 : 0) + (script.onEnter ? 1 : 0)
    + (script.onDeath ? 1 : 0) + (script.tokenDoubler ? 1 : 0) + (script.entersTapped ? 1 : 0)
    + (script.extraLandDrops ? 1 : 0);
  const supported = !script.unsupported.length;
  const status = supported ? (hand ? 'scripted' : behaviours ? 'compiled' : 'vanilla')
    : (behaviours || script.unsupported.length < 2 ? 'partial' : 'unhandled');
  return { status, hand, behaviours, unsupported: script.unsupported, fullyAutomated: supported };
}

const COLOUR_BASIC = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };

/** Basics a deck can fall back on, so it always normalises to exactly 100. */
function ensureBasics(deck, commanderCard) {
  const basics = { ...deck.basics };
  if (Object.values(basics).reduce((a, b) => a + b, 0) > 0) return basics;
  const identity = commanderCard.color_identity || [];
  const names = [...new Set(identity.map((c) => COLOUR_BASIC[c]).filter(Boolean))];
  const chosen = names.length === 1 ? names[0] : (names[0] || 'Plains');
  basics[chosen] = 1; // normalizeDeck tops this up to reach 100
  return basics;
}

/**
 * @returns {{ ok: boolean, deck?: object, report: object }}
 *   `deck` is a fully normalised, playable deck (only when ok).
 *   `report` always explains what was checked and what failed.
 */
export function verifyDeck(decklistText, opts = {}) {
  const checks = [];
  const add = (id, label, ok, detail = '') => checks.push({ id, label, ok, detail });

  let imported;
  try {
    // `name` is the public option; the parser calls it `deckName`.
    imported = buildImportedDeck(decklistText, { ...opts, deckName: opts.deckName || opts.name });
  } catch (e) {
    add('parse', 'Decklist parses', false, e.message);
    return { ok: false, report: { checks, blockers: [], warnings: [], fatal: e.message } };
  }

  const { deck, summary, warnings } = imported;
  const commanderCard = oracle[deck.commander.toLowerCase()];
  add('parse', 'Decklist parses', true, `${deck.name} — ${deck.commander}`);

  // --- size -----------------------------------------------------------------
  const sizeOk = summary.total === 100;
  add('size', 'Exactly 100 cards (commander + 99)', sizeOk,
    sizeOk ? '100' : `${summary.total} cards — the engine and the rules need exactly 100`);

  // --- unresolved names -----------------------------------------------------
  const unresolvedOk = !summary.unresolved?.length;
  add('known', 'Every card is known to the engine', unresolvedOk,
    unresolvedOk ? '' : `not in the local card data: ${summary.unresolved.join(', ')}`);

  // --- singleton ------------------------------------------------------------
  const duplicates = [];
  const seen = new Map();
  for (const n of deck.spells.concat(deck.lands)) {
    const k = n.toLowerCase();
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const basicNames = new Set(Object.keys(deck.basics).map((n) => n.toLowerCase()));
  for (const [k, count] of seen) if (count > 1 && !basicNames.has(k)) duplicates.push(`${oracle[k]?.name || k} ×${count}`);
  const singletonOk = duplicates.length === 0;
  add('singleton', 'Singleton (one copy of each card, basics excepted)', singletonOk,
    singletonOk ? '' : `repeated: ${duplicates.join(', ')}`);

  // --- colour identity ------------------------------------------------------
  const colourOk = !summary.offColour?.length;
  add('identity', 'Colour identity matches the commander', colourOk,
    colourOk ? '' : `off-colour: ${summary.offColour.join(', ')}`);

  // --- bracket rules --------------------------------------------------------
  const profile = profileDeck(deck);
  const bracketOk = profile.violations.length === 0;
  add('bracket', `Bracket ${deck.bracket} rules hold`, bracketOk,
    bracketOk ? `${profile.gameChangers.length} Game Changer(s), ${profile.combos.length} combo(s)`
      : profile.violations.join('; '));

  // --- full automation ------------------------------------------------------
  const names = [...new Set([deck.commander, ...deck.spells, ...deck.lands])];
  const perCard = [];
  const blockers = [];
  const counts = { scripted: 0, compiled: 0, vanilla: 0, partial: 0, unhandled: 0 };
  for (const name of names) {
    const card = oracle[name.toLowerCase()];
    if (!card) continue;
    const a = automationOf(card);
    counts[a.status] = (counts[a.status] || 0) + 1;
    perCard.push({ name: card.name, status: a.status, unsupported: a.unsupported });
    if (!a.fullyAutomated) blockers.push({ name: card.name, status: a.status, unsupported: a.unsupported });
  }
  const automated = counts.scripted + counts.compiled + counts.vanilla;
  const automationOk = blockers.length === 0;
  add('automation', 'Every card is fully scripted for all players', automationOk,
    automationOk
      ? `${automated}/${names.length} cards fully automated (${counts.scripted} scripted, ${counts.compiled} compiled, ${counts.vanilla} vanilla)`
      : `${blockers.length} card(s) the engine cannot play completely: ${blockers.map((b) => b.name).join(', ')}`);

  const report = {
    checks,
    blockers,
    warnings: warnings || [],
    bracket: deck.bracket,
    commander: deck.commander,
    name: deck.name,
    total: summary.total,
    perCard,
    coverage: { counts, automated, total: names.length, pct: names.length ? Math.round((automated / names.length) * 100) : 0 },
  };

  if (!checks.every((c) => c.ok)) {
    // The only thing standing in the way may be individual cards the engine
    // can't play completely. Offer a repair: same colour identity, same card
    // type where possible, closest mana value, and never a card that would break
    // the bracket or duplicate the list. Every swap is reported.
    const failed = checks.filter((c) => !c.ok);
    if (opts.repair !== false && failed.length === 1 && failed[0].id === 'automation') {
      const attempt = repairDeck({ ...deck, basics: ensureBasics(deck, commanderCard) }, report);
      if (!attempt.fatal && attempt.substitutions.length) {
        const retry = verifyDeck(deckToText(attempt.deck), { ...opts, repair: false, name: deck.name, bracket: deck.bracket });
        retry.report.substitutions = attempt.substitutions;
        retry.report.originalCoverage = report.coverage;
        retry.report.autoRepaired = true;
        if (retry.ok) return retry;
        // If the repair still fails, report the repaired attempt — it is the more
        // useful failure to look at, and it says what the swaps were.
        retry.report.repairFailed = true;
        return retry;
      }
      if (attempt.fatal) report.fatal = attempt.fatal;
    }
    return { ok: false, report };
  }

  // Everything passed — materialise the exact object the engine plays with.
  const full = normalizeDeck({ ...deck, basics: ensureBasics(deck, commanderCard) });
  return { ok: true, deck: full, report };
}

/** Render a deck back to a plain text list (used to re-verify a repaired deck). */
export function deckToText(deck) {
  const lines = [`1 ${deck.commander}`, '', '// spells'];
  for (const n of deck.spells) lines.push(`1 ${n}`);
  lines.push('', '// lands');
  for (const n of deck.lands) lines.push(`1 ${n}`);
  for (const [name, count] of Object.entries(deck.basics || {})) if (count) lines.push(`${count} ${name}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Auto-repair: swap the cards the engine can't play completely        */
/* ------------------------------------------------------------------ */

let automatedPool = null;

/** Every card in the engine's pool that is fully automated, with its metadata. */
function fullyAutomatedCards() {
  if (automatedPool) return automatedPool;
  automatedPool = [];
  for (const card of Object.values(oracle)) {
    if (!card?.name) continue;
    const a = automationOf(card);
    if (a.fullyAutomated) automatedPool.push({ card, status: a.status });
  }
  return automatedPool;
}

const primaryType = (card) => (card.types || []).find((t) => ['Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Planeswalker', 'Land'].includes(t)) || 'other';

/**
 * Replace cards that aren't fully automated with fully-automated cards that fit
 * the same deck: same colour identity, same primary card type where possible,
 * closest mana value, and never one that would break the bracket's rules or
 * duplicate a card already in the list.
 *
 * This keeps the rotation's bar at "plays completely, for everyone" while still
 * giving a real-world decklist somewhere to go. Every swap is reported, so the
 * uploader sees exactly what changed and why.
 */
export function repairDeck(deck, report, { limit = 20 } = {}) {
  const commanderCard = oracle[deck.commander.toLowerCase()];
  const identity = new Set(commanderCard?.color_identity || []);
  const inDeck = new Set([deck.commander, ...deck.spells, ...deck.lands].map((n) => n.toLowerCase()));
  const pool = fullyAutomatedCards();
  const substitutions = [];

  const comboNames = new Set(COMBO_REGISTRY.flatMap((c) => c.cards));
  const deckNames = new Set([deck.commander, ...deck.spells, ...deck.lands].map((n) => n.toLowerCase()));
  const bracketSafe = (card) => {
    const b = deck.bracket;
    const name = card.name.toLowerCase();
    if (b <= 3 && GAME_CHANGERS.has(name)) return false;
    if (b <= 3 && isMassLandDenial(card)) return false;
    if (b <= 2 && isExtraTurn(card)) return false;
    // adding one half of a 2-card combo to a deck that already has the other half
    if (b <= 2) {
      for (const combo of COMBO_REGISTRY) {
        if (!combo.cards.includes(name)) continue;
        if (combo.cards.some((x) => x !== name && deckNames.has(x))) return false;
      }
    }
    return true;
  };
  const basics = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];

  const fits = (candidate, wantedType) => {
    const c = candidate.card;
    if (inDeck.has(c.name.toLowerCase())) return false;
    if ((c.color_identity || []).some((col) => !identity.has(col))) return false;
    if (candidate.status === 'vanilla' && wantedType !== primaryType(c)) return false; // vanilla is filler; keep it on-type
    if (basics.includes(c.name)) return false;
    if (!bracketSafe(c)) return false;
    return true;
  };

  const replacements = [];
  for (const blocker of report.blockers.slice(0, limit)) {
    const out = oracle[blocker.name.toLowerCase()];
    if (!out) continue;
    if (blocker.name.toLowerCase() === deck.commander.toLowerCase()) {
      // The whole deck is built around the commander; it cannot be swapped out.
      return { deck, substitutions, fatal: `${blocker.name} is the commander and is not fully scripted — that deck cannot be repaired automatically.` };
    }
    const wantedType = primaryType(out);
    const cmc = out.cmc || 0;
    const candidates = pool
      .filter((c) => fits(c, wantedType) && typeof c.card.cmc === 'number')
      .sort((a, b) => {
        const ta = primaryType(a.card) === wantedType ? 0 : 1;
        const tb = primaryType(b.card) === wantedType ? 0 : 1;
        if (ta !== tb) return ta - tb;
        const da = Math.abs((a.card.cmc || 0) - cmc);
        const db = Math.abs((b.card.cmc || 0) - cmc);
        if (da !== db) return da - db;
        return a.card.name.localeCompare(b.card.name);
      });
    const pick = candidates[0];
    if (!pick) continue;
    replacements.push({ out: out.name, in: pick.card.name, reason: blocker.unsupported[0] || blocker.status });
    inDeck.add(pick.card.name.toLowerCase());
    substitutions.push({ out: out.name, in: pick.card.name, reason: blocker.unsupported[0] || blocker.status, status: blocker.status });
  }

  if (!substitutions.length) return { deck, substitutions, fatal: null };
  const swap = new Map(substitutions.map((s) => [s.out.toLowerCase(), s.in]));
  const spells = deck.spells.map((n) => swap.get(n.toLowerCase()) || n);
  const lands = deck.lands.map((n) => swap.get(n.toLowerCase()) || n);
  return { deck: { ...deck, spells, lands }, substitutions, fatal: null };
}

/**
 * Stable identity for a submitted list. Keyed on the contents, not the clock, so
 * re-uploading the same 100 cards updates one rotation slot instead of padding
 * the pool with near-duplicates (which would also let a day pair a deck with
 * itself).
 */
export function listFingerprint(fullDeck) {
  const list = [
    String(fullDeck.commander || '').toLowerCase(),
    ...[...(fullDeck.spells || [])].map((n) => n.toLowerCase()).sort(),
    ...[...(fullDeck.lands || [])].map((n) => n.toLowerCase()).sort(),
    ...Object.entries(fullDeck.basics || {}).sort().map(([k, v]) => `${k.toLowerCase()}x${v}`),
  ].join('|');
  // FNV-1a, 32-bit — plenty for a roster of a few hundred decks.
  let h = 0x811c9dc5;
  for (let i = 0; i < list.length; i++) {
    h ^= list.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The shape stored in the shared rotation (small, JSON-safe, no card objects). */
export function communityRecord(fullDeck, report, { id, addedBy = 'anonymous' } = {}) {
  return {
    id: id || `community-${fullDeck.commander.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}-${listFingerprint(fullDeck)}`,
    name: fullDeck.name,
    commander: fullDeck.commander,
    bracket: fullDeck.bracket,
    theme: fullDeck.theme || '#6b7280',
    themeName: fullDeck.themeName || 'Community',
    prototype: fullDeck.prototype || 'midrange',
    blurb: `Uploaded by the community and verified: ${report.coverage.automated}/${report.coverage.total} cards fully scripted.`,
    spells: fullDeck.spells,
    lands: fullDeck.lands,
    basics: fullDeck.basics,
    imported: true,
    verified: true,
    addedBy,
    addedAt: new Date().toISOString(),
    coverage: report.coverage,
  };
}

/**
 * Rebuild a stored community record into a playable deck. Stored decks are plain
 * lists (no card objects), so they are re-normalised on the way out — which also
 * means a card that later loses support cannot silently stay in the rotation.
 */
export function deckFromRecord(record) {
  const full = normalizeDeck({
    id: record.id,
    name: record.name,
    bracket: record.bracket,
    theme: record.theme,
    themeName: record.themeName,
    commander: record.commander,
    prototype: record.prototype,
    blurb: record.blurb,
    spells: record.spells,
    lands: record.lands,
    basics: record.basics,
    imported: true,
  });
  full.community = true;
  full.verified = true;
  full.addedBy = record.addedBy;
  return full;
}
