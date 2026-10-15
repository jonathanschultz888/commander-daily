/**
 * Card parsing, permanent instances, and the layer system (CR 613).
 *
 * Rules implemented here:
 *  - Card type parsing incl. supertypes/subtypes, P/T including * and 1+*
 *  - Characteristics vs. copiable values (tokens, copies)
 *  - Layer system for P/T (613.1: 6 ability-adding, 7a set base, 7b set, 7c modify, 7d switch)
 *  - Counters (+1/+1 and -1/-1 annihilate as a state-based action, CR 704.5q)
 *  - Keyword abilities, granted keywords, and keyword loss
 */

export const BASIC_LANDS = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];

const parseTypes = (typeLine) => {
  const [left, right] = typeLine.split(/—|–/).map((s) => (s || '').trim());
  const words = left.split(/\s+/);
  const supertypes = words.filter((w) => ['Basic', 'Legendary', 'Snow', 'World', 'Kindred', 'Tribal', 'Ongoing'].includes(w));
  const types = words.filter((w) => !supertypes.includes(w));
  const subtypes = right ? right.split(/\s+/) : [];
  return { supertypes, types, subtypes };
};

const parseManaCost = (cost = '') => {
  const out = { generic: 0, colors: {}, x: 0, life: 0, snow: 0, hybrid: [] };
  const symbols = cost.match(/\{[^}]+\}/g) || [];
  for (const raw of symbols) {
    const s = raw.slice(1, -1).toUpperCase();
    if (s === 'X') { out.x++; continue; }
    if (/^\d+$/.test(s)) { out.generic += parseInt(s, 10); continue; }
    if (s === 'S') { out.snow++; out.generic += 1; continue; }
    if (s.includes('/')) {
      const [a, b] = s.split('/');
      // {2/W} is payable with 2 generic mana; {W/U} needs one of the two colours
      if (/^\d+$/.test(a)) { out.generic += parseInt(a, 10); continue; }
      if (a === 'P' || b === 'P') { out.colors[b === 'P' ? a : b] = (out.colors[b === 'P' ? a : b] || 0); out.life += 2; continue; }
      out.hybrid.push([a, b]);
      continue;
    }
    if (['W', 'U', 'B', 'R', 'G', 'C'].includes(s)) {
      if (s === 'C') { out.generic += 1; continue; }
      out.colors[s] = (out.colors[s] || 0) + 1;
      continue;
    }
    out.generic += 1;
  }
  return out;
};

/** CR 208.2: P/T may be a number, *, or 1+*. */
export function parsePt(value, ctx = {}) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const v = String(value);
  if (v === '*') return ctx.star ?? 0;
  const plusStar = v.match(/^(\d+)\s*\+\s*\*$/);
  if (plusStar) return parseInt(plusStar[1], 10) + (ctx.star ?? 0);
  const starPlus = v.match(/^\*\s*\+\s*(\d+)$/);
  if (starPlus) return (ctx.star ?? 0) + parseInt(starPlus[1], 10);
  const neg = v.match(/^-(\d+)$/);
  if (neg) return -parseInt(neg[1], 10);
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Give a card record its parsed type fields.
 *
 * Instances and tokens already carry supertypes/types/subtypes; bare oracle
 * records and deck-list entries only carry `type_line`. Every consumer that
 * reads `.types` (intrinsic basic-land mana, creature checks, static abilitity
 * filters) must therefore normalise first — otherwise behaviour depends on
 * which kind of object happened to be passed in.
 */
export const withTypes = (card) => (card.types && card.subtypes
  ? card
  : { ...card, ...parseTypes(card.type_line || '') });

export function makeCardInstance(card, { owner, controller, zone, isCommander = false, iid }) {
  const { supertypes, types, subtypes } = parseTypes(card.type_line || '');
  return {
    iid,
    name: card.name,
    card,                     // oracle data
    owner, controller, zone,
    types, supertypes, subtypes,
    manaCost: card.mana_cost || '',
    cmc: card.cmc || 0,
    parsedCost: parseManaCost(card.mana_cost || ''),
    basePower: card.power ?? null,
    baseToughness: card.toughness ?? null,
    tapped: false,
    summoningSick: true,
    damage: 0,
    counters: {},             // { '+1/+1': n, '-1/-1': n, charge: n, ... }
    attachedTo: null,
    attachments: [],          // equipment/auras attached to this permanent
    isToken: false,
    isCopy: false,
    isCommander,
    castFromCommandZone: 0,
    keywords: new Set(card.keywords || []),
    // continuous-effect bookkeeping
    tempPumps: [],            // { power, toughness, untilEndOfTurn, source }
    staticMods: [],           // { power, toughness, setBase?, source, condition }
    setBase: null,            // { power, toughness } from layer 7a
    setPT: null,              // from layer 7b
    switchPT: false,          // layer 7d
    keywordGrants: [],        // { keywords:[], source, untilEndOfTurn }
    keywordLoss: [],          // { keywords:[], source }
    protection: new Set(),
    damagePrevention: [],
    controller_at_turn_start: null,
    enteredThisTurn: true,
    attackedThisTurn: false,
    dealtDamageThisTurn: 0,
    isFaceDown: false,
    isTransformed: false,
    loyalty: card.loyalty ? parseInt(card.loyalty, 10) : null,
    _staticCache: null,
  };
}

export function makeTokenInstance(tokenDef, { owner, controller, iid }) {
  const card = {
    name: tokenDef.name,
    mana_cost: '',
    cmc: 0,
    type_line: tokenDef.type_line || tokenDef.typeLine,
    oracle_text: tokenDef.oracle_text || '',
    colors: tokenDef.colors || [],
    color_identity: tokenDef.colors || [],
    keywords: tokenDef.keywords || [],
    power: tokenDef.power ?? null,
    toughness: tokenDef.toughness ?? null,
    image: null,
    legal_commander: 'legal',
  };
  const inst = makeCardInstance(card, { owner, controller, zone: 'battlefield', iid });
  inst.isToken = true;
  inst.summoningSick = false;
  return inst;
}

export const isLand = (c) => c.types.includes('Land');
export const isCreature = (c) => c.types.includes('Creature');
export const isArtifact = (c) => c.types.includes('Artifact');
export const isEnchantment = (c) => c.types.includes('Enchantment');
export const isPlaneswalker = (c) => c.types.includes('Planeswalker');
export const isInstant = (c) => c.types.includes('Instant');
export const isSorcery = (c) => c.types.includes('Sorcery');
export const isPermanent = (c) =>
  isCreature(c) || isArtifact(c) || isEnchantment(c) || isPlaneswalker(c) || isLand(c) || c.types.includes('Battle');
export const isBasicLand = (c) => isLand(c) && c.supertypes.includes('Basic');
export const isLegendary = (c) => c.supertypes.includes('Legendary');

/* ------------------------------------------------------------------ */
/* Layer system (CR 613.1) — evaluated in order, with a static-mod cache */
/* ------------------------------------------------------------------ */

export function countersPower(perm) {
  return (perm.counters['+1/+1'] || 0) - (perm.counters['-1/-1'] || 0);
}

/** Layer 6: continuous abilities that add keywords. */
export function effectiveKeywords(game, perm) {
  const set = new Set(perm.keywords);
  for (const g of perm.keywordGrants) {
    if (g.expired) continue;
    g.keywords.forEach((k) => set.add(k));
  }
  // Auras/equipment grant their host keywords too
  for (const att of perm.attachments) {
    for (const g of att.keywordGrants) {
      if (!g.expired) g.keywords.forEach((k) => set.add(k));
    }
    (att.card.keywords || []).forEach((k) => set.add(k));
  }
  // Anthems / lords that grant keywords grant them via game-level statics
  for (const mod of gameStaticMods(game)) {
    if (mod.keywords && (typeof mod.applies !== 'function' || mod.applies(perm))) mod.keywords.forEach((k) => set.add(k));
  }
  for (const l of perm.keywordLoss) if (!l.expired) l.keywords.forEach((k) => set.delete(k));
  if (perm.tapped && set.has('Vigilance')) { /* vigilance does not expire when tapped */ }
  return set;
}

export function hasKeyword(game, perm, kw) {
  return effectiveKeywords(game, perm).has(kw);
}

function gameStaticMods(game) {
  return game._staticMods || [];
}

/**
 * Compute a permanent's current characteristics through the layers.
 * Returns { power, toughness, keywords, types, subtypes }.
 */
/**
 * CR 613.8a: when working out a characteristic would require the answer you are
 * already computing, the effect uses the value from before it started to apply.
 * Concretely: a lord's "creatures you control get +1/+1" has to ask whether the
 * target is a creature, and asking about the lord itself re-enters this function.
 * Without a guard that is infinite recursion (and a 500 for whoever hit it), so
 * a re-entrant call gets the unmodified base characteristics.
 */
const IN_PROGRESS = new WeakMap();

function baseCharacteristics(perm) {
  const ctx = { star: 0 };
  return {
    power: parsePt(perm.basePower ?? 0, ctx),
    toughness: parsePt(perm.baseToughness ?? 0, ctx),
    keywords: new Set(perm.keywords || []),
    types: [...perm.types],
    subtypes: [...perm.subtypes],
    isCreature: perm.types.includes('Creature') || perm.types.includes('Vehicle'),
  };
}

export function characteristics(game, perm) {
  let inProgress = IN_PROGRESS.get(game);
  if (!inProgress) { inProgress = new Set(); IN_PROGRESS.set(game, inProgress); }
  if (inProgress.has(perm.iid)) return baseCharacteristics(perm);
  inProgress.add(perm.iid);
  try {
    return computeCharacteristics(game, perm);
  } finally {
    inProgress.delete(perm.iid);
  }
}

function computeCharacteristics(game, perm) {
  const ctx = {
    star: starValue(game, perm),
  };
  let baseP = parsePt(perm.basePower ?? 0, ctx);
  let baseT = parsePt(perm.baseToughness ?? 0, ctx);
  let types = [...perm.types];
  let subtypes = [...perm.subtypes];
  let keywords = new Set(perm.keywords);

  // Layer 4: type-changing effects
  const mods = gameStaticMods(game);
  const applies = (m) => (typeof m.applies === 'function' ? m.applies(perm) : true);
  for (const m of mods) {
    if (!applies(m)) continue;
    if (m.addTypes) types = [...new Set([...types, ...m.addTypes])];
    if (m.addSubtypes) subtypes = [...new Set([...subtypes, ...m.addSubtypes])];
    if (m.removeTypes) types = types.filter((t) => !m.removeTypes.includes(t));
  }
  // Layer 5-6: colour/ability changes (keyword grants handled in effectiveKeywords)
  for (const m of mods) {
    if (!applies(m)) continue;
    if (m.keywords) m.keywords.forEach((k) => keywords.add(k));
  }

  // Layer 7a: effects that set base P/T ("becomes a 5/5")
  if (perm.setBase) { baseP = perm.setBase.power; baseT = perm.setBase.toughness; }
  for (const m of mods) if (applies(m) && m.setBase) { baseP = m.setBase.power; baseT = m.setBase.toughness; }

  // Layer 7b: effects that set P/T to a specific value
  let power = baseP, toughness = baseT;
  if (perm.setPT) { power = perm.setPT.power; toughness = perm.setPT.toughness; }
  for (const m of mods) if (applies(m) && m.setPT) { power = m.setPT.power; toughness = m.setPT.toughness; }

  // Layer 7c: counters and modification effects
  for (const m of mods) if (applies(m)) { power += m.power || 0; toughness += m.toughness || 0; }
  for (const att of perm.attachments) {
    if (att.tempPumps.length || att.staticMods.length) {
      for (const p of att.tempPumps) { if (!p.expired) { power += p.power; toughness += p.toughness; } }
      for (const p of att.staticMods) { power += p.power || 0; toughness += p.toughness || 0; }
    }
  }
  for (const p of perm.tempPumps) if (!p.expired) { power += p.power; toughness += p.toughness; }
  for (const p of perm.staticMods) { power += p.power || 0; toughness += p.toughness || 0; }
  const c = countersPower(perm);
  power += c; toughness += c;
  for (const m of mods) if (applies(m) && m.counters) {
    const n = m.counters['+1/+1'] || 0;
    power += n; toughness += n;
  }

  // Layer 7d: switching
  if (perm.switchPT) [power, toughness] = [toughness, power];

  return {
    power: Math.max(-999, power),
    toughness: Math.max(-999, toughness),
    keywords: effectiveKeywords(game, perm),
    types, subtypes,
    isCreature: types.includes('Creature') || types.includes('Vehicle'),
  };
}

/** CR 208.2: * values. We support the common cases. */
function starValue(game, perm) {
  const t = (perm.card.oracle_text || '').toLowerCase();
  if (/\*\/\*|its power and toughness|number of .* you control/.test(t)) {
    const own = countType(game, perm, /\bsquirrels?\b/) ? 'Squirrel'
      : /\bgoblins?\b/.test(t) ? 'Goblin'
      : /\belves?\b/.test(t) ? 'Elf'
      : /\bcats?\b/.test(t) ? 'Cat'
      : /\bslivers?\b/.test(t) ? 'Sliver' : null;
    if (own) return game.battlefield.filter((p) => p.controller === perm.controller && p.subtypes.includes(own)).length;
  }
  return 0;
}

const countType = () => true;

export function power(game, perm) { return characteristics(game, perm).power; }
export function toughness(game, perm) { return characteristics(game, perm).toughness; }

/* ------------------------------------------------------------------ */
/* Mana cost helpers                                                   */
/* ------------------------------------------------------------------ */

export function manaValue(perm) { return perm.cmc || 0; }

/** Total coloured pips, used by the mana solver. */
export function colorRequirements(cost) {
  const req = { ...cost.colors };
  for (const [a, b] of cost.hybrid || []) { req[a] = (req[a] || 0) + 1; delete req[b]; }
  return req;
}
