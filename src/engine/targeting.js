/**
 * Targeting: which targets a scripted card needs, plus the decision heuristics
 * used by the bot (and by the engine when a trigger needs a target mid-resolution).
 *
 * The human supplies targets with the cast/activate action (the UI shows legal
 * targets and the player picks), which keeps the request/response loop to a single
 * round trip per action instead of parking the whole game mid-resolution.
 */
import { SPECS, specMatches, legalTargets } from './ops.js';
import { characteristics, isCreature, isLand, hasKeyword } from './cards.js';

/** Pull the required target specs out of a script's steps. */
export function requiredTargets(script) {
  const specs = [];
  const scan = (steps) => {
    for (const s of (steps || [])) {
      if (!s) continue;
      if (s.target === 'chosen' && s.spec) specs.push(normalizeSpec(s.spec));
      if (s.op === 'copyPermanent' && s.target === 'chosen') specs.push(normalizeSpec('creatureYouControlOther'));
      if (s.op === 'if') { scan(s.then); scan(s.otherwise); }
    }
  };
  scan(script?.steps);
  for (const ab of script?.abilities || []) {
    if (ab.target) {
      specs.push(normalizeSpec(ab.target === 'creature' ? (ab.mode === 'opp' ? 'creatureOpponentControls' : 'creature') : ab.target));
    }
    scan(ab.steps);
  }
  for (const t of script?.triggers || []) {
    if (t.target) specs.push(normalizeSpec(t.target));
  }
  if (script?.onEnter) specs.push(...specsFromFunction(script.onEnter));
  return specs;
}

/** Hand scripts declare targets implicitly via steps inside their closures, so we
 *  keep an explicit table for the ones that need a choice. */
const EXPLICIT_TARGETS = {
  'swords to plowshares': ['creatureOpponentControls'],
  'path to exile': ['creatureOpponentControls'],
  'generous gift': ['permanent'],
  'beast within': ['permanent'],
  'chaos warp': ['permanent'],
  'anguished unmaking': ['nonlandPermanent'],
  'utter end': ['nonlandPermanent'],
  'despark': ['nonlandPermanent'],
  'assassin\'s trophy': ['permanent'],
  'abrupt decay': ['nonlandPermanent'],
  'putrefy': ['artifactOrEnchantment'],
  'mortify': ['artifactOrEnchantment'],
  'disenchant': ['artifactOrEnchantment'],
  'return to dust': ['artifactOrEnchantment'],
  'revoke existence': ['artifactOrEnchantment'],
  'naturalize': ['artifactOrEnchantment'],
  'krosan grip': ['artifactOrEnchantment'],
  'reclamation sage': ['artifactOrEnchantment'],
  'hero\'s downfall': ['creatureOrPlaneswalker'],
  'murder': ['creature'],
  'doom blade': ['creature'],
  'go for the throat': ['creature'],
  'snuff out': ['creature'],
  'dismember': ['creature'],
  'reality shift': ['creature'],
  'unsummon': ['creature'],
  'banisher priest': ['creatureOpponentControls'],
  'fiend hunter': ['creatureOpponentControls'],
  'noxious gearhulk': ['creatureOpponentControls'],
  'acidic slime': ['nonlandPermanent'],
  'lightning bolt': ['anyTarget'],
  'shock': ['anyTarget'],
  'lightning strike': ['anyTarget'],
  'incinerate': ['anyTarget'],
  'magma jet': ['anyTarget'],
  'abrade': ['creature'],
  'comet storm': ['anyTarget'],
  'fireball': ['anyTarget'],
  'banefire': ['anyTarget'],
  'kiki-jiki, mirror breaker': ['creatureYouControlOther'],
  'zuran orb': [],
  'perilous forays': [],
  'greater good': [],
};

export function targetRequirements(script) {
  const explicit = EXPLICIT_TARGETS[script?.name?.toLowerCase()];
  const specs = explicit !== undefined ? explicit.map(normalizeSpec) : requiredTargets(script);
  return [...new Map(specs.map((s) => [JSON.stringify(s), s])).values()];
}

function normalizeSpec(spec) {
  if (!spec) return SPECS.anyTarget;
  if (typeof spec === 'string') return SPECS[spec] || { kind: 'permanent', filter: {} };
  if (spec.kind) return spec;
  return { kind: 'permanent', filter: spec };
}

function specsFromFunction() { return []; }

/** Bot / engine target choice. `mode` biases aggression vs. safety. */
export function chooseTarget(game, ctx, spec, { mode = 'value', preferred = null } = {}) {
  const options = legalTargets(game, ctx, spec).filter((x) => x !== null);
  if (!options.length) return null;
  if (preferred !== null && options.includes(preferred)) return preferred;

  const scored = options.map((id) => ({ id, score: scoreTarget(game, ctx, id, mode) }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].id;
}

export function scoreTarget(game, ctx, id, mode) {
  const me = ctx.controller;
  const isPlayer = typeof id === 'number';
  if (isPlayer) {
    if (id === me) return mode === 'selfHarm' ? 100 : 5;
    // face damage when lethal is available
    const pl = game.players[id];
    return pl.life <= 6 ? 90 : 25;
  }
  const perm = game.battlefield.find((p) => p.iid === id);
  if (!perm) return -100;
  const ch = characteristics(game, perm);
  const mine = perm.controller === me;
  let score = 0;
  // threats: big creatures, commanders, equipment hosts
  score += ch.power * 2 + ch.toughness;
  if (perm.isCommander) score += 12;
  if (perm.attachments.length) score += 4;
  if (perm.subtypes.includes('Equipment')) score += 6;
  if (perm.types.includes('Enchantment')) score += 3;
  if (ch.keywords.has('Flying')) score += 2;
  if (isLand(perm)) score -= 6;
  if (mode === 'value') score = mine ? -score * 0.6 : score;
  else if (mode === 'removal') score = mine ? -score : score;
  else if (mode === 'pump') score = mine ? score : -score;
  return score;
}

/** Cheap "is this card worth playing now" heuristic shared by bot + hints. */
export function creatureThreatValue(game, perm) {
  const ch = characteristics(game, perm);
  return ch.power + ch.toughness + (perm.attachments.length * 2) + (perm.isCommander ? 4 : 0);
}

export { legalTargets, specMatches };
