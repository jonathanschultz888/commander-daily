/**
 * Card behaviour registry.
 *
 * Precedence per card:
 *   1. HAND_SCRIPTS  — hand-written for commanders, combo pieces, ramp/fixing and
 *                      anything whose oracle text the compiler can't express
 *   2. COMPILED      — parseClause/parseTriggered/parseActivated/parseStatic output
 *
 * Every card ends up with a uniform script shape:
 *   { mana: [...], abilities: [...], triggers: [...], statics: [...],
 *     entersTapped, onResolve, steps, unsupported: [...] }
 *
 * `unsupported` is how the engine stays honest: a card that only partially parses
 * still plays (its parsable parts work) and is reported by scripts/coverage.mjs.
 */
import { parseClause, parseTriggered, parseActivated, parseStatic, inferKeywords } from './compiler.js';
import { SPECS, tokenDef, runEffects, pump as opPump, grantKeyword as opGrantKeyword, createTokens, loseLife, permValue, destroy, damage } from './ops.js';
import { oracle } from '../decks/index.js';
import { characteristics, isCreature, isLand, hasKeyword, withTypes } from './cards.js';

const cache = new Map();

/* ------------------------------------------------------------------ */
/* Hand-written scripts                                                */
/* ------------------------------------------------------------------ */

const A = (g, id) => g.players[id];

export const COMBO_REGISTRY = [
  {
    name: 'Godo + Helm of the Host',
    cards: ['Godo, Bandit Warlord', 'Helm of the Host'],
    description: 'Helm copies Godo on each extra combat step — unbounded attacks.',
    points: 12,
    check: (g, pid) => {
      const godo = g.battlefield.find((p) => p.controller === pid && p.name === 'Godo, Bandit Warlord');
      const helm = g.battlefield.find((p) => p.controller === pid && p.name === 'Helm of the Host' && p.attachedTo);
      return !!(godo && helm && g.turnNumberFor?.[pid] >= 3);
    },
  },
  {
    name: 'Kiki-Jiki + Zealous Conscripts',
    cards: ['Kiki-Jiki, Mirror Breaker', 'Zealous Conscripts'],
    description: 'Copy Conscripts, untap Kiki-Jiki, repeat for infinite hasty 3/3s.',
    points: 12,
    check: (g, pid) => {
      const kiki = g.battlefield.find((p) => p.controller === pid && p.name === 'Kiki-Jiki, Mirror Breaker' && !p.tapped);
      const cons = g.battlefield.find((p) => p.controller === pid && p.name === 'Zealous Conscripts');
      return !!(kiki && cons);
    },
  },
  {
    name: "Thassa's Oracle + Demonic Consultation",
    cards: ["Thassa's Oracle", 'Demonic Consultation'],
    description: 'Exile the library, then win on an empty library.',
    points: 15,
    check: (g, pid) => {
      const o = g.battlefield.find((p) => p.controller === pid && p.name === "Thassa's Oracle");
      return !!o && A(g, pid).zones.library.length <= 3;
    },
  },
  {
    name: "Underworld Breach + Lion's Eye Diamond",
    cards: ['Underworld Breach', "Lion's Eye Diamond"],
    description: 'Breach + LED loops spells out of the graveyard.',
    points: 10,
    check: (g, pid) => {
      const b = g.battlefield.find((p) => p.controller === pid && p.name === 'Underworld Breach');
      const led = g.battlefield.find((p) => p.controller === pid && p.name === "Lion's Eye Diamond");
      const gy = A(g, pid).zones.graveyard.length;
      return !!(b && led && gy >= 6);
    },
  },
  {
    name: 'Sanguine Bond + lifelink',
    cards: ['Sanguine Bond', 'Wurmcoil Engine'],
    description: 'Every point of lifelink becomes a point of drain.',
    points: 6,
    check: (g, pid) => g.battlefield.some((p) => p.controller === pid && p.name === 'Sanguine Bond')
      && g.battlefield.some((p) => p.controller === pid && hasKeyword(g, p, 'Lifelink')),
  },
  {
    name: 'Doubling Season + token explosion',
    cards: ['Doubling Season'],
    description: 'Tokens and counters doubled — then doubled again by Parallel Lives.',
    points: 7,
    check: (g, pid) => {
      const ds = g.battlefield.find((p) => p.controller === pid && p.name === 'Doubling Season');
      const tokens = g.battlefield.filter((p) => p.controller === pid && p.isToken).length;
      return !!ds && tokens >= 6;
    },
  },
];

/** Small helpers used by hand scripts. */
const land = (g, pid, name) => g.players[pid].zones.library.find((c) => c.name === name);
const searchBasicToField = (n = 1, tapped = true) => ({
  op: 'searchBasics', n, type: null, destination: 'battlefield', tapped,
});
const anyColorMana = (n = 1) => ({ op: 'addMana', color: 'C', n, anyColor: true });

export const HAND_SCRIPTS = {
  /* ---------------- mana rocks & lands ---------------- */
  'sol ring': { mana: [{ colors: ['C'], amount: 2 }] },
  'arcane signet': { mana: [{ colors: ['ANY'], amount: 1 }] },
  'mind stone': {
    mana: [{ colors: ['C'], amount: 1 }],
    abilities: [{ costs: { tap: true }, producesMana: false, steps: [{ op: 'draw', n: 1 }], sacrificeSelf: true, label: '{1}, {T}, Sacrifice: draw a card', costsMana: { generic: 1 } }],
  },
  'fellwar stone': { mana: [{ colors: [{ anyOfOpponentLands: true }], amount: 1, dynamic: true }] },
  'thought vessel': { mana: [{ colors: ['C'], amount: 1 }] },
  'command tower': { mana: [{ colors: ['ANY'], amount: 1 }] },
  'city of brass': { mana: [{ colors: ['ANY'], amount: 1, cost: { life: 1 } }] },
  'mana confluence': { mana: [{ colors: ['ANY'], amount: 1, cost: { life: 1 } }] },
  'reflecting pool': { mana: [{ colors: ['ANY'], amount: 1 }] },
  'golgari signet': { mana: [{ colors: ['B', 'G'], amount: 1 }] },
  'simic signet': { mana: [{ colors: ['G', 'U'], amount: 1 }] },
  'dimir signet': { mana: [{ colors: ['U', 'B'], amount: 1 }] },
  'rakdos signet': { mana: [{ colors: ['B', 'R'], amount: 1 }] },
  'izzet signet': { mana: [{ colors: ['U', 'R'], amount: 1 }] },
  'orzhov signet': { mana: [{ colors: ['W', 'B'], amount: 1 }] },
  'boros signet': { mana: [{ colors: ['R', 'W'], amount: 1 }] },
  'overgrown tomb': { entersTapped: (g, that) => !that?._shockPaid ? false : false, shock: { colors: ['B', 'G'] } },
  'watery grave': { shock: { colors: ['U', 'B'] } },
  'breeding pool': { shock: { colors: ['G', 'U'] } },
  'stomping ground': { shock: { colors: ['R', 'G'] } },
  'sacred foundry': { shock: { colors: ['R', 'W'] } },
  'steam vents': { shock: { colors: ['U', 'R'] } },
  'blood crypt': { shock: { colors: ['B', 'R'] } },
  'godless shrine': { shock: { colors: ['W', 'B'] } },
  'underground sea': { mana: [{ colors: ['U', 'B'], amount: 1 }] },
  'volcanic island': { mana: [{ colors: ['U', 'R'], amount: 1 }] },
  'badlands': { mana: [{ colors: ['B', 'R'], amount: 1 }] },
  'woodland cemetery': { mana: [{ colors: ['B', 'G'], amount: 1 }], entersTapped: (g, perm) => g.battlefield.filter((p) => p.controller === perm.controller && isLand(p)).length < 3 },
  'drowned catacomb': { mana: [{ colors: ['U', 'B'], amount: 1 }], entersTapped: (g, perm) => g.battlefield.filter((p) => p.controller === perm.controller && isLand(p)).length < 3 },
  'hinterland harbor': { mana: [{ colors: ['G', 'U'], amount: 1 }], entersTapped: (g, perm) => g.battlefield.filter((p) => p.controller === perm.controller && isLand(p)).length < 3 },
  'rootbound crag': { mana: [{ colors: ['R', 'G'], amount: 1 }], entersTapped: (g, perm) => g.battlefield.filter((p) => p.controller === perm.controller && isLand(p)).length < 3 },
  'clifftop retreat': { mana: [{ colors: ['R', 'W'], amount: 1 }], entersTapped: (g, perm) => g.battlefield.filter((p) => p.controller === perm.controller && isLand(p)).length < 3 },
  'isolated chapel': { mana: [{ colors: ['W', 'B'], amount: 1 }], entersTapped: (g, perm) => g.battlefield.filter((p) => p.controller === perm.controller && isLand(p)).length < 3 },
  'llanowar wastes': { mana: [{ colors: ['B', 'G'], amount: 1 }] },
  'yavimaya coast': { mana: [{ colors: ['G', 'U'], amount: 1 }] },
  'karplusan forest': { mana: [{ colors: ['R', 'G'], amount: 1 }] },
  'battlefield forge': { mana: [{ colors: ['R', 'W'], amount: 1 }] },
  'caves of koilos': { mana: [{ colors: ['W', 'B'], amount: 1 }] },
  'underground river': { mana: [{ colors: ['U', 'B'], amount: 1 }] },
  'temple of malady': { entersTapped: true, scry: 1 },
  'temple of mystery': { entersTapped: true, scry: 1 },
  'temple of deceit': { entersTapped: true, scry: 1 },
  'temple of abandon': { entersTapped: true, scry: 1 },
  'temple of triumph': { entersTapped: true, scry: 1 },
  'temple of silence': { entersTapped: true, scry: 1 },
  'necroblossom snarl': { entersTapped: true, scry: 1 },
  'simic growth chamber': { entersTapped: true, bounceLand: true },
  'thornwood falls': { entersTapped: true },
  'bojuka bog': { entersTapped: true, onEnter: (g, perm) => { for (const pl of g.players) if (pl.id !== perm.controller) { for (const c of [...pl.zones.graveyard]) { pl.zones.graveyard.splice(pl.zones.graveyard.indexOf(c), 1); c.zone = 'exile'; pl.zones.exile.push(c); } } } },
  // Nykthos: {T} for {C}; the devotion ability is folded in as an extra any-colour source
  'nykthos, shrine to nyx': {
    mana: [{ colors: ['C'], amount: 1 }],
    abilities: [{
      costs: { tap: true, mana: { generic: 2 } },
      isMana: true,
      manaColors: (g, perm) => {
        const devotion = g.battlefield.filter((p) => p.controller === perm.controller)
          .reduce((a, p) => a + ((p.card.mana_cost || '').match(/\{[WUBRG]\}/g)?.length || 0), 0);
        return devotion > 0 ? ['C'] : ['C'];
      },
      label: '{2}, {T}: add mana equal to your devotion',
    }],
  },
  'ancient tomb': { mana: [{ colors: ['C'], amount: 2, cost: { life: 2 } }] },
  'myriad landscape': { entersTapped: true, abilities: [{ costs: { tap: true, mana: { generic: 2 } }, steps: [searchBasicToField(2, true)], label: '{2}, {T}, Sacrifice: search two basics' }] },
  'emeria, the sky ruin': { entersTapped: true, mana: [{ colors: ['W'], amount: 1 }] },
  'valakut, the molten pinnacle': { entersTapped: true, mana: [{ colors: ['R'], amount: 1 }] },
  'kher keep': { mana: [{ colors: ['C'], amount: 1 }], abilities: [{ costs: { tap: true, mana: { generic: 1 } }, steps: [{ op: 'token', token: tokenDef('Kobold token', 'Token Creature — Kobold', 0, 1, { colors: ['R'] }), n: 1 }], label: 'Create a 0/1 Kobold' }] },
  'great furnace': { mana: [{ colors: ['R'], amount: 1 }] },
  'darksteel citadel': { mana: [{ colors: ['C'], amount: 1 }] },
  'creeping tar pit': { entersTapped: true, mana: [{ colors: ['U', 'B'], amount: 1 }] },
  'raging ravine': { entersTapped: true, mana: [{ colors: ['R', 'G'], amount: 1 }] },
  'kessig wolf run': { mana: [{ colors: ['C'], amount: 1 }], abilities: [{ costs: { tap: true, mana: { generic: 1, colors: { R: 1 } } }, target: 'creature', steps: [{ op: 'pump', target: 'chosen', power: 1, toughness: 0 }, { op: 'grant', target: 'chosen', keywords: ['Trample'] }], label: '{X}{R}{G}, {T}: pump and trample' }] },
  'shambling vent': { entersTapped: true, mana: [{ colors: ['W', 'B'], amount: 1 }] },
  'slayers\' stronghold': { mana: [{ colors: ['C'], amount: 1 }], abilities: [{ costs: { tap: true, mana: { generic: 2, colors: { R: 1 } } }, target: 'creatureYouControl', steps: [{ op: 'pump', target: 'chosen', power: 1, toughness: 0 }, { op: 'grant', target: 'chosen', keywords: ['Haste'] }], label: 'Pump + haste' }] },
  'needle spires': { entersTapped: true, mana: [{ colors: ['R', 'W'], amount: 1 }] },

  /* ---------------- ramp ---------------- */
  'llanowar elves': { mana: [{ colors: ['G'], amount: 1, tap: true }] },
  'elvish mystic': { mana: [{ colors: ['G'], amount: 1, tap: true }] },
  'birds of paradise': { mana: [{ colors: ['ANY'], amount: 1, tap: true, flying: true }] },
  'arbor elf': { mana: [{ colors: ['G'], amount: 1, tap: true, condition: (g, p) => g.landsControlledBy(p.controller).some((l) => l.subtypes.includes('Forest')) }] },
  'sakura-tribe elder': { abilities: [{ costs: { sacrificeSelf: true }, steps: [searchBasicToField(1, true)], label: 'Sacrifice: search a basic land' }] },
  'wood elves': { onEnter: (g, ctx) => runSteps(g, ctx, [searchBasicToField(1, false)]) },
  'farhaven elf': { onEnter: (g, ctx) => runSteps(g, ctx, [searchBasicToField(1, true)]) },
  'cultivate': { steps: [
    { op: 'searchBasics', n: 1, destination: 'battlefield', tapped: true },
    { op: 'searchBasics', n: 1, destination: 'hand' },
  ] },
  'kodama\'s reach': { steps: [
    { op: 'searchBasics', n: 1, destination: 'battlefield', tapped: true },
    { op: 'searchBasics', n: 1, destination: 'hand' },
  ] },
  'rampant growth': { steps: [searchBasicToField(1, true)] },
  'nature\'s lore': { steps: [{ op: 'search', n: 1, filter: { type: 'Land', subtype: 'Forest' }, destination: 'battlefield', tapped: false }] },
  'three visits': { steps: [{ op: 'search', n: 1, filter: { type: 'Land', subtype: 'Forest' }, destination: 'battlefield', tapped: false }] },
  'farseek': { steps: [{ op: 'search', n: 1, filter: { land: true, notBasic: true }, destination: 'battlefield', tapped: true }] },
  'explosive vegetation': { steps: [searchBasicToField(1, true), searchBasicToField(1, true)] },
  'circuitous route': { steps: [searchBasicToField(1, true), searchBasicToField(1, true)] },
  'boundless realms': { steps: [{ op: 'searchBasics', n: 6, destination: 'battlefield', tapped: true }] },
  'traverse the outlands': { steps: [{ op: 'searchBasics', n: 10, destination: 'battlefield', tapped: true }] },
  'growth spiral': { steps: [{ op: 'searchBasics', n: 1, destination: 'battlefield', tapped: true }, { op: 'draw', n: 1 }] },
  'explore': { steps: [{ op: 'searchBasics', n: 1, destination: 'battlefield', tapped: true }, { op: 'draw', n: 1 }] },
  'roiling regrowth': { steps: [searchBasicToField(2, true)] },
  'harrow': { steps: [searchBasicToField(2, true)] },

  /* ---------------- draw & selection ---------------- */
  'brainstorm': { steps: [{ op: 'draw', n: 3 }, { op: 'noop', note: 'put two back — simplified' }] },
  'ponder': { steps: [{ op: 'scryLike', n: 3 }, { op: 'draw', n: 1 }] },
  'preordain': { steps: [{ op: 'scryLike', n: 2 }, { op: 'draw', n: 1 }] },
  'opt': { steps: [{ op: 'scryLike', n: 1 }, { op: 'draw', n: 1 }] },
  'gitaxian probe': { steps: [{ op: 'draw', n: 1 }] },
  'divination': { steps: [{ op: 'draw', n: 2 }] },
  'concentrate': { steps: [{ op: 'draw', n: 3 }] },
  'deep analysis': { steps: [{ op: 'draw', n: 2 }] },
  'harmonize': { steps: [{ op: 'draw', n: 3 }] },
  'night\'s whisper': { steps: [{ op: 'loseLife', n: 2 }, { op: 'draw', n: 2 }] },
  'sign in blood': { steps: [{ op: 'loseLife', n: 2 }, { op: 'draw', n: 2 }] },
  'read the bones': { steps: [{ op: 'scryLike', n: 2 }, { op: 'loseLife', n: 2 }, { op: 'draw', n: 2 }] },
  'treasure cruise': { steps: [{ op: 'draw', n: 3 }] },
  'dig through time': { steps: [{ op: 'scryLike', n: 2 }, { op: 'draw', n: 2 }] },
  'faithless looting': { steps: [{ op: 'draw', n: 2 }, { op: 'discard', n: 2 }] },
  'tormenting voice': { steps: [{ op: 'discard', n: 1 }, { op: 'draw', n: 2 }] },
  'cathartic reunion': { steps: [{ op: 'discard', n: 2 }, { op: 'draw', n: 2 }] },
  'windfall': { steps: [{ op: 'discardEach', n: 7 }, { op: 'draw', anyHandSize: true }] },
  'wheel of fortune': { steps: [{ op: 'discardEach', n: 7 }, { op: 'draw', anyHandSize: true }] },
  'sensei\'s divining top': { abilities: [{ costs: { tap: true }, steps: [{ op: 'scryLike', n: 3 }], label: '{T}: look at the top three' }, { costs: { mana: { generic: 1 } }, steps: [{ op: 'draw', n: 1 }], label: '{1}: draw, put Top on top' }] },

  /* ---------------- removal & interaction ---------------- */
  'swords to plowshares': { steps: [{ op: 'exile', target: 'chosen', spec: 'creature' }, { op: 'gainLife', n: 2 }] },
  'path to exile': { steps: [{ op: 'exile', target: 'chosen', spec: 'creature' }, { op: 'searchBasics', n: 1, destination: 'battlefield', tapped: true, who: 'opponent' }] },
  'generous gift': { steps: [{ op: 'destroy', target: 'chosen', spec: 'permanent' }, { op: 'token', who: 'opponent', token: tokenDef('Elephant token', 'Token Creature — Elephant', 3, 3, { colors: ['G'] }), n: 1 }] },
  'beast within': { steps: [{ op: 'destroy', target: 'chosen', spec: 'permanent' }, { op: 'token', who: 'opponent', token: tokenDef('Beast token', 'Token Creature — Beast', 3, 3, { colors: ['G'] }), n: 1 }] },
  'chaos warp': { steps: [{ op: 'bounce', target: 'chosen', spec: 'permanent' }, { op: 'lookTop', destination: 'battlefield' }] },
  'putrefy': { steps: [{ op: 'destroy', target: 'chosen', spec: 'artifactOrEnchantment' }] },
  'mortify': { steps: [{ op: 'destroy', target: 'chosen', spec: 'artifactOrEnchantment' }] },
  'anguished unmaking': { steps: [{ op: 'exile', target: 'chosen', spec: 'nonlandPermanent' }, { op: 'loseLife', n: 3 }] },
  'despark': { steps: [{ op: 'exile', target: 'chosen', spec: { kind: 'permanent', filter: { nonland: true, manaValueMax: 5 } } }] },
  'assassin\'s trophy': { steps: [{ op: 'destroy', target: 'chosen', spec: 'permanent' }, { op: 'searchBasics', n: 1, destination: 'battlefield', tapped: true, who: 'opponent' }] },
  'abrupt decay': { steps: [{ op: 'destroy', target: 'chosen', spec: { kind: 'permanent', filter: { nonland: true, manaValueMax: 3 } } }] },
  'putrefy_': {},
  'utter end': { steps: [{ op: 'exile', target: 'chosen', spec: 'nonlandPermanent' }] },
  'hero\'s downfall': { steps: [{ op: 'destroy', target: 'chosen', spec: 'creatureOrPlaneswalker' }] },
  'murder': { steps: [{ op: 'destroy', target: 'chosen', spec: 'creature' }] },
  'doom blade': { steps: [{ op: 'destroy', target: 'chosen', spec: { kind: 'permanent', filter: { creature: true, predicate: (g, p) => !(p.card.colors || []).includes('B') } } }] },
  'snuff out': { steps: [{ op: 'destroy', target: 'chosen', spec: { kind: 'permanent', filter: { creature: true, predicate: (g, p) => !(p.card.colors || []).includes('B') } } }] },
  'dismember': { steps: [{ op: 'pump', target: 'chosen', spec: 'creature', power: -5, toughness: -5 }] },
  'go for the throat': { steps: [{ op: 'destroy', target: 'chosen', spec: 'creature' }] },
  'swords_to_plowshares': {},
  'disenchant': { steps: [{ op: 'destroy', target: 'chosen', spec: 'artifactOrEnchantment' }] },
  'return to dust': { steps: [{ op: 'exile', target: 'chosen', spec: 'artifactOrEnchantment' }] },
  'revoke existence': { steps: [{ op: 'exile', target: 'chosen', spec: 'artifactOrEnchantment' }] },
  'abrade': { steps: [{ op: 'damage', target: 'chosen', spec: 'creature', n: 3 }] },
  'vandalblast': { steps: [{ op: 'destroyAll', filter: { kind: 'permanent', filter: { artifact: true, controller: 'opp' } } }] },
  'shattering spree': { steps: [{ op: 'destroyAll', filter: { kind: 'permanent', filter: { artifact: true, controller: 'opp' } } }] },
  'naturalize': { steps: [{ op: 'destroy', target: 'chosen', spec: 'artifactOrEnchantment' }] },
  'krosan grip': { steps: [{ op: 'destroy', target: 'chosen', spec: 'artifactOrEnchantment' }] },
  'reality shift': { steps: [{ op: 'exile', target: 'chosen', spec: 'creature' }, { op: 'lookTop', destination: 'battlefield', who: 'opponent' }] },
  'counterspell': { counterTarget: true, steps: [{ op: 'counterSpell', filter: {} }] },
  'negate': { steps: [{ op: 'counterSpell', filter: {} }] },
  'mana leak': { steps: [{ op: 'counterSpell', filter: {}, unlessPay: 3 }] },
  'essence scatter': { steps: [{ op: 'counterSpell', filter: { permanent: true } }] },
  'arcane denial': { steps: [{ op: 'counterSpell', filter: {} }, { op: 'draw', who: 'opponent', n: 1 }] },
  'force of will': { steps: [{ op: 'counterSpell', filter: {} }], altCostLife: 1 },
  'fierce guardianship': { steps: [{ op: 'counterSpell', filter: {} }] },
  'pact of negation': { steps: [{ op: 'counterSpell', filter: {} }] },
  'mana drain': { steps: [{ op: 'counterSpell', filter: {} }] },
  'unsummon': { steps: [{ op: 'bounce', target: 'chosen', spec: 'creature' }] },
  'cyclonic rift': { steps: [{ op: 'bounceAll', filter: { kind: 'permanent', filter: { nonland: true, controller: 'opp' } } }] },
  'toxic deluge': { steps: [{ op: 'loseLife', n: 3 }, { op: 'damageAll', n: 3, filter: { kind: 'permanent', filter: { creature: true } } }] },
  'blasphemous act': { steps: [{ op: 'damageAll', n: 13, filter: { kind: 'permanent', filter: { creature: true } } }] },
  'wrath of god': { steps: [{ op: 'destroyAll', filter: { kind: 'permanent', filter: { creature: true } } }] },
  'day of judgment': { steps: [{ op: 'destroyAll', filter: { kind: 'permanent', filter: { creature: true } } }] },
  'chain reaction': { steps: [{ op: 'damageAll', n: 5, filter: { kind: 'permanent', filter: { creature: true } } }] },
  'storm\'s wrath': { steps: [{ op: 'damageAll', n: 4, filter: { kind: 'permanent', filter: { creature: true } } }] },
  'rolling earthquake': { steps: [{ op: 'damageAll', n: 3, filter: { kind: 'permanent', filter: { creature: true } } }, { op: 'loseLife', n: 3 }] },
  'pyroclasm': { steps: [{ op: 'damageAll', n: 2, filter: { kind: 'permanent', filter: { creature: true } } }] },
  'anger of the gods': { steps: [{ op: 'damageAll', n: 3, filter: { kind: 'permanent', filter: { creature: true } } }] },
  'fireball': { steps: [{ op: 'damage', target: 'chosen', spec: 'anyTarget', n: 'X' }], xSpell: true },
  'banefire': { steps: [{ op: 'damage', target: 'chosen', spec: 'anyTarget', n: 'X' }], xSpell: true },
  'comet storm': { steps: [{ op: 'damage', target: 'chosen', spec: 'anyTarget', n: 'X' }, { op: 'damage', eachOpponent: true, n: 'X' }], xSpell: true },
  'lightning bolt': { steps: [{ op: 'damage', target: 'chosen', spec: 'anyTarget', n: 3 }] },
  'shock': { steps: [{ op: 'damage', target: 'chosen', spec: 'anyTarget', n: 2 }] },
  'lightning strike': { steps: [{ op: 'damage', target: 'chosen', spec: 'anyTarget', n: 3 }] },
  'incinerate': { steps: [{ op: 'damage', target: 'chosen', spec: 'anyTarget', n: 3 }] },
  'magma jet': { steps: [{ op: 'damage', target: 'chosen', spec: 'anyTarget', n: 2 }, { op: 'scryLike', n: 2 }] },
  'geth\'s verdict': { steps: [{ op: 'sacrifice', n: 1, filter: { creature: true }, who: 'opponent' }, { op: 'loseLife', who: 'opponent', n: 1 }] },
  'plaguecrafter': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'sacrifice', n: 1, filter: { creature: true }, who: 'each' }]) },
  'chandra\'s ignition': { steps: [{ op: 'damageAll', n: 5, filter: { kind: 'permanent', filter: { creature: true } } }] },
  'banisher priest': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'exile', target: 'chosen', spec: 'creatureOpponentControls' }]) },
  'fiend hunter': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'exile', target: 'chosen', spec: 'creatureOpponentControls' }]) },
  'necropotence': { abilities: [{ costs: { life: 1 }, steps: [{ op: 'lookTop', destination: 'hand' }], label: 'Pay 1 life: exile the top card, put it into your hand' }] },

  /* ---------------- creatures with ETB value ---------------- */
  'elvish visionary': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'draw', n: 1 }]) },
  'reclamation sage': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'destroy', target: 'chosen', spec: 'artifactOrEnchantment' }]) },
  'acidic slime': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'destroy', target: 'chosen', spec: { kind: 'permanent', filter: { anyOf: [{ land: true }, { artifact: true }, { enchantment: true }] } } }]) },
  'noxious gearhulk': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'destroy', target: 'chosen', spec: 'creatureOpponentControls' }, { op: 'gainLife', n: 3 }]) },
  // "When this creature enters, you may destroy up to three target noncreature
  // permanents. For each permanent put into a graveyard this way, its controller
  // creates a 3/3 green Elephant creature token." The old script destroyed an
  // opponent artifact and nothing else — no lands, no enchantments, no Elephants —
  // while still reporting as fully automated.
  'terastodon': {
    onEnter: (g, ctx) => {
      const me = ctx.controller;
      const candidates = g.battlefield
        .filter((p) => p.controller !== me && !characteristics(g, p).isCreature)
        .sort((a, b) => permValue(g, b) - permValue(g, a))
        .slice(0, 3);
      for (const perm of candidates) {
        const controller = perm.controller;
        destroy(g, perm, ctx);
        // CR 603.2c "for each permanent put into a graveyard this way": only a
        // permanent that actually died pays out, and the CONTROLLER of it — not
        // Terastodon's controller — gets the Elephant.
        const died = g.players[controller].zones.graveyard.some((c) => c.iid === perm.iid);
        if (!died) continue;
        createTokens(g, controller, tokenDef('Elephant token', 'Token Creature — Elephant', 3, 3, { colors: ['G'] }), 1, ctx);
        g.log(`${g.players[controller].name} creates a 3/3 Elephant for ${perm.name}`);
      }
    },
  },
  'grave titan': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'token', token: tokenDef('Zombie token', 'Token Creature — Zombie', 2, 2, { colors: ['B'] }), n: 2 }]) },
  'prime speaker zegana': {},
  'solemn simulacrum': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'searchBasics', n: 1, destination: 'battlefield', tapped: true }, { op: 'draw', n: 1 }]) },
  'coiling oracle': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'draw', n: 1 }]) },
  'baleful strix': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'draw', n: 1 }]) },
  'trinket mage': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'search', n: 1, filter: { type: 'Artifact', manaValueMax: 1 } }]) },
  'treasure mage': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'search', n: 1, filter: { type: 'Artifact', manaValueMax: 6 } }]) },
  'spellseeker': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'search', n: 1, filter: { type: 'Instant' } }]) },
  'imperial recruiter': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'search', n: 1, filter: { type: 'Creature', powerMax: 2 } }]) },
  'recruiter of the guard': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'search', n: 1, filter: { type: 'Creature', toughnessMax: 2 } }]) },
  'ranger of eos': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'search', n: 2, filter: { type: 'Creature', manaValueMax: 1 } }]) },
  'goblin matron': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'search', n: 1, filter: { type: 'Creature', subtype: 'Goblin' } }]) },
  'eternal witness': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'reanimate', filter: { creature: false, predicate: (g2, c) => c.types.includes('Sorcery') || c.types.includes('Instant') } }]) },
  'stoneforge mystic': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'search', n: 1, filter: { type: 'Artifact', subtype: 'Equipment' } }]) },

  /* ---------------- token makers & anthems ---------------- */
  'squirrel nest': { abilities: [{ costs: { tap: true }, steps: [{ op: 'token', token: tokenDef('Squirrel token', 'Token Creature — Squirrel', 1, 1, { colors: ['G'] }), n: 1 }], label: 'Create a Squirrel', attachToLand: true }] },
  'chatterfang, squirrel general': {
    static: [{ kind: 'tokenModifier', modifier: 'squirrel' }],
    abilities: [{
      costs: { tap: true, mana: { generic: 2, colors: { B: 1 } } },
      steps: [{ op: 'token', token: tokenDef('Squirrel token', 'Token Creature — Squirrel', 1, 1, { colors: ['G'] }), n: 2 }],
      label: 'Create two Squirrels',
    }],
    tokenReplacement: (g, perm, def) => (def.subtypes.includes('Squirrel') ? def : tokenDef('Squirrel token', 'Token Creature — Squirrel', 1, 1, { colors: ['G'] })),
  },
  'craterhoof behemoth': {
    onEnter: (g, ctx) => {
      const n = g.creaturesControlledBy(ctx.controller).length;
      for (const c of g.creaturesControlledBy(ctx.controller)) { opPump(g, c, n, n, ctx); opGrantKeyword(g, c, ['Trample'], ctx); }
    },
  },
  'overwhelming stampede': { steps: [{ op: 'pumpAll', filter: { kind: 'permanent', filter: { creature: true, controller: 'you' } }, power: 4, toughness: 4 }, { op: 'grant', target: 'eachYouControl', keywords: ['Trample'] }] },
  'overrun': { steps: [{ op: 'pumpAll', filter: { kind: 'permanent', filter: { creature: true, controller: 'you' } }, power: 3, toughness: 3 }, { op: 'grantAll', filter: { kind: 'permanent', filter: { creature: true, controller: 'you' } }, keywords: ['Trample'] }] },
  'triumph of the hordes': { steps: [{ op: 'pumpAll', filter: { kind: 'permanent', filter: { creature: true, controller: 'you' } }, power: 1, toughness: 1 }, { op: 'grantAll', filter: { kind: 'permanent', filter: { creature: true, controller: 'you' } }, keywords: ['Infect', 'Trample'] }] },
  'second harvest': { steps: [{ op: 'tokenCopyAll' }] },
  'return of the wildspeaker': { steps: [{ op: 'draw', n: 4 }, { op: 'pumpAll', filter: { kind: 'permanent', filter: { creature: true, controller: 'you', predicate: (g, p) => !characteristics(g, p).isCreature === false && !p.subtypes.includes('Human') } }, power: 3, toughness: 3 }] },
  // Beastmaster Ascension: "Whenever a creature you control attacks, you may put a
  // quest counter on this enchantment. As long as it has seven or more, creatures
  // you control get +5/+5." The static half was here all along and a `questCounters`
  // flag hinted at the rest — but nothing ever read that flag, so the counters never
  // arrived and the payoff was unreachable.
  'beastmaster ascension': {
    statics: [{ kind: 'ptBonus', appliesTo: { creature: true, controller: 'you' }, power: 5, toughness: 5, condition: (g, perm) => (perm.counters.quest || 0) >= 7 }],
    triggers: [{
      event: 'creatureAttacks',
      match: (g, self, ev) => ev.controller === self.controller,
      steps: [{ op: 'counter', target: 'self', counterType: 'quest', n: 1 }],
    }],
  },
  // "Whenever a creature you control dies, you gain 1 life and draw a card." The
  // clause parser read the first half and dropped the draw.
  'moldervine reclamation': {
    triggers: [{
      event: 'permanentDies',
      match: (g, self, ev) => ev.controller === self.controller,
      steps: [{ op: 'gainLife', n: 1 }, { op: 'draw', n: 1 }],
    }],
  },
  // "Whenever this creature is dealt damage, it deals that much damage to any target."
  // "That much" needs the number the trigger fired with, which now rides along on
  // the trigger's context. The engine points it at the best target for its
  // controller: their biggest creature, else their face — never back at itself,
  // which would loop.
  'boros reckoner': {
    triggers: [{
      event: 'selfDamaged',
      match: (g, self, ev) => ev.card === self.iid || ev.perm === self.iid,
      steps: [(g, ctx) => {
        const n = ctx.event?.amount || 0;
        if (!n || !ctx.source) return;
        const me = ctx.source.controller;
        const theirs = g.battlefield.filter((p) => p.controller !== me && characteristics(g, p).isCreature);
        const target = theirs.sort((a, b) => permValue(g, b) - permValue(g, a))[0] || g.other(me);
        g.log(`${ctx.source.name} throws ${n} damage back`);
        damage(g, target, n, { source: ctx.source });
      }],
    }],
  },
  'parallel lives': { tokenDoubler: true },
  'doubling season': { tokenDoubler: true, counterDoubler: true },
  'anointed procession': { tokenDoubler: true, filter: (def) => def.types?.includes('Creature') || /\bCreature\b/.test(def.type_line || '') },
  'cathars\' crusade': {
    triggers: [{
      event: 'permanentEntered',
      match: (g, self, ev) => g.battlefield.find((p) => p.iid === ev.card)?.controller === self.controller
        && isCreature(g.battlefield.find((p) => p.iid === ev.card) || {}),
      steps: [{ op: 'counterAll', counterType: '+1/+1', n: 1, filter: { kind: 'permanent', filter: { creature: true, controller: 'you' } } }],
    }],
  },
  'ivy lane denizen': {
    triggers: [{
      event: 'permanentEntered',
      match: (g, self, ev) => { const p = g.battlefield.find((x) => x.iid === ev.card); return p && p.controller === self.controller && p.subtypes.includes('Squirrel'); },
      steps: [{ op: 'counter', target: 'self', counterType: '+1/+1', n: 1 }],
    }],
  },
  'scurry oak': {
    triggers: [{
      event: 'counters',
      match: (g, self, ev) => ev.target === self.iid && ev.counterType === '+1/+1',
      steps: [{ op: 'token', token: tokenDef('Squirrel token', 'Token Creature — Squirrel', 1, 1, { colors: ['G'] }), n: 1 }],
    }],
  },
  'pitiless plunderer': {
    triggers: [{ event: 'permanentDied', match: (g, self, ev) => ev.controller === self.controller, steps: [{ op: 'token', token: tokenDef('Treasure', 'Token Artifact — Treasure', null, null, { oracle_text: '{T}, Sacrifice: add one mana of any color.' }), n: 1 }] }],
  },
  'pawns of ulamog': {},
  'pawn of ulamog': {
    triggers: [{ event: 'permanentDied', match: (g, self, ev) => ev.controller === self.controller, steps: [{ op: 'token', token: tokenDef('Eldrazi Spawn token', 'Token Creature — Eldrazi Spawn', 0, 1, { colors: ['C'], oracle_text: 'Sacrifice: add {C}.' }), n: 1 }] }],
  },
  'poison-tip archer': {
    triggers: [
      { event: 'permanentDied', match: (g, self, ev) => ev.controller === self.controller, steps: [{ op: 'loseLife', who: 'opponent', n: 1 }, { op: 'gainLife', n: 1 }] },
    ],
  },
  'blood artist': {
    triggers: [{ event: 'permanentDied', match: (g, self) => true, steps: [{ op: 'loseLife', who: 'opponent', n: 1 }, { op: 'gainLife', n: 1 }] }],
  },
  'zulaport cutthroat': {
    triggers: [{ event: 'permanentDied', match: (g, self, ev) => ev.controller === self.controller, steps: [{ op: 'loseLife', who: 'opponent', n: 1 }, { op: 'gainLife', n: 1 }] }],
  },
  'cruel celebrant': {
    triggers: [{ event: 'permanentDied', match: (g, self) => true, steps: [{ op: 'loseLife', who: 'opponent', n: 1 }, { op: 'gainLife', n: 1 }] }],
  },
  'midnight reaper': {
    triggers: [{ event: 'permanentDied', match: (g, self, ev) => ev.controller === self.controller && ev.card !== self.iid, steps: [{ op: 'loseLife', n: 1 }, { op: 'draw', n: 1 }] }],
  },
  'grim haruspex': {
    triggers: [{ event: 'permanentDied', match: (g, self, ev) => ev.controller === self.controller, steps: [{ op: 'draw', n: 1 }, { op: 'loseLife', n: 1 }] }],
  },
  'grave pact': {
    statics: [{ kind: 'sacOnDeath', appliesTo: { controller: 'opp' } }],
    triggers: [{ event: 'permanentDied', match: (g, self, ev) => ev.controller === self.controller, steps: [{ op: 'sacrifice', who: 'opponent', n: 1, filter: { creature: true } }] }],
  },
  'dictate of erebos': {
    triggers: [{ event: 'permanentDied', match: (g, self, ev) => ev.controller === self.controller, steps: [{ op: 'sacrifice', who: 'opponent', n: 1, filter: { creature: true } }] }],
  },
  'butcher of malakir': {
    triggers: [{ event: 'permanentDied', match: (g, self, ev) => ev.controller === self.controller, steps: [{ op: 'sacrifice', who: 'opponent', n: 1, filter: { creature: true } }] }],
  },
  'elenda, the dusk rose': {
    triggers: [{ event: 'permanentDied', match: (g, self, ev) => ev.controller === self.controller, steps: [{ op: 'counter', target: 'self', counterType: '+1/+1', n: 1 }] }],
  },
  'teysa karlov': {
    static: [{ kind: 'deathTriggerDoubler' }],
    // "another non-Spirit creature you control dies" — without the Spirit check a
    // Spirit token dying re-triggers this, and with any repeatable sacrifice
    // outlet (Grave Pact, a free outlet) that is an infinite loop the engine can
    // never finish.
    triggers: [{
      event: 'permanentDied',
      match: (g, self, ev) => {
        if (ev.controller !== self.controller || ev.card === self.iid) return false;
        const died = diedCardFor(g, ev);
        return !(died && (died.subtypes || []).includes('Spirit'));
      },
      steps: [{ op: 'token', token: tokenDef('Spirit token', 'Token Creature — Spirit', 1, 1, { colors: ['W'], keywords: ['Flying'] }), n: 1 }],
    }],
  },
  // "Whenever you gain life, target opponent loses that much life." It used to
  // always drain exactly 1, whatever the gain was.
  'sanguine bond': {
    triggers: [{
      event: 'youGainLife',
      match: (g, self, ev) => ev.player === self.controller,
      steps: [(g, ctx) => {
        const n = ctx.event?.amount || 0;
        if (n > 0 && ctx.source) loseLife(g, g.other(ctx.source.controller), n, ctx);
      }],
    }],
  },
  'wurmcoil engine': {
    onDeath: (g, ctx) => runSteps(g, ctx, [
      { op: 'token', token: tokenDef('Wurm token', 'Token Creature — Wurm', 3, 3, { colors: ['C'], keywords: ['Deathtouch'] }), n: 1 },
      { op: 'token', token: tokenDef('Wurm token', 'Token Creature — Wurm', 3, 3, { colors: ['C'], keywords: ['Lifelink'] }), n: 1 },
    ]),
  },
  'avenger of zendikar': {
    onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'token', token: tokenDef('Plant token', 'Token Creature — Plant', 0, 1, { colors: ['G'] }), n: g.landsControlledBy(ctx.controller).length }]),
  },
  'rampaging baloths': {
    triggers: [{ event: 'landfall', match: (g, self, ev) => ev.player === self.controller, steps: [{ op: 'token', token: tokenDef('Beast token', 'Token Creature — Beast', 4, 4, { colors: ['G'] }), n: 1 }] }],
  },
  'tireless provisioner': { triggers: [{ event: 'landfall', match: (g, self, ev) => ev.player === self.controller, steps: [{ op: 'token', token: tokenDef('Treasure', 'Token Artifact — Treasure', null, null, {}), n: 1 }] }] },
  'lotus cobra': { triggers: [{ event: 'landfall', match: (g, self, ev) => ev.player === self.controller, steps: [{ op: 'addMana', color: 'C', n: 1, anyColor: true }] }] },
  'tireless tracker': { triggers: [{ event: 'landfall', match: (g, self, ev) => ev.player === self.controller, steps: [{ op: 'token', token: tokenDef('Clue', 'Token Artifact — Clue', null, null, { oracle_text: '{2}, Sacrifice: draw a card.' }), n: 1 }] }] },
  'tatyova, benthic druid': { triggers: [{ event: 'landfall', match: (g, self, ev) => ev.player === self.controller, steps: [{ op: 'gainLife', n: 1 }, { op: 'draw', n: 1 }] }] },
  'aesi, tyrant of gyre strait': { triggers: [{ event: 'landfall', match: (g, self, ev) => ev.player === self.controller, steps: [{ op: 'draw', n: 1 }] }], extraLandDrops: () => 1 },
  'azusa, lost but seeking': { extraLandDrops: () => 2 },
  'exploration': { extraLandDrops: () => 1 },
  'oracle of mul daya': { extraLandDrops: () => 1, topCardPlayable: true },
  'wayward swordtooth': { extraLandDrops: () => 1 },
  'dryad of the ilysian grove': { extraLandDrops: () => 1, manaFixer: true },
  'ramunap excavator': { replayLands: true },
  'crucible of worlds': { replayLands: true },
  'mina and denn, wildborn': { extraLandDrops: () => 1 },
  'omnath, locus of rage': {
    triggers: [
      { event: 'landfall', match: (g, self, ev) => ev.player === self.controller, steps: [{ op: 'token', token: tokenDef('Elemental token', 'Token Creature — Elemental', 5, 5, { colors: ['R', 'G'] }), n: 1 }] },
      { event: 'permanentDied', match: (g, self, ev) => { const p = g.battlefield.find((x) => x.iid === ev.card); return false; }, steps: [] },
    ],
    onOtherDies: (g, ev) => runSteps(g, { controller: ev.controller, source: null, targets: [] }, [{ op: 'damage', target: 'chosen', spec: 'anyTarget', n: 3 }]),
  },

  /* ---------------- combat & pump ---------------- */
  'gratuitous violence': { damageMultiplier: 2 },
  'furnace of rath': { damageMultiplier: 2 },
  'dictate of the twin gods': { damageMultiplier: 2 },
  'torbran, thane of red fell': { damageAddend: 2, filter: (g, src, tgt) => src?.controller !== tgt },
  'fire servant': { damageMultiplier: 2 },
  'impact tremors': { triggers: [{ event: 'permanentEntered', match: (g, self, ev) => { const p = g.battlefield.find((x) => x.iid === ev.card); return p && p.controller === self.controller && characteristics(g, p).isCreature; }, steps: [{ op: 'damage', who: 'opponent', n: 1 }] }] },
  'purphoros, god of the forge': { triggers: [{ event: 'permanentEntered', match: (g, self, ev) => { const p = g.battlefield.find((x) => x.iid === ev.card); return p && p.controller === self.controller && characteristics(g, p).isCreature; }, steps: [{ op: 'damage', eachOpponent: true, n: 2 }] }] },
  'warstorm surge': { triggers: [{ event: 'permanentEntered', match: (g, self, ev) => { const p = g.battlefield.find((x) => x.iid === ev.card); return p && p.controller === self.controller && characteristics(g, p).isCreature; }, steps: [{ op: 'damage', target: 'chosen', spec: 'anyTarget', n: 3 }] }] },
  'where ancients tread': { triggers: [{ event: 'permanentEntered', match: (g, self, ev) => { const p = g.battlefield.find((x) => x.iid === ev.card); return p && p.controller === self.controller && characteristics(g, p).isCreature && characteristics(g, p).power >= 5; }, steps: [{ op: 'damage', target: 'chosen', spec: 'anyTarget', n: 5 }] }] },
  'elemental bond': { triggers: [{ event: 'permanentEntered', match: (g, self, ev) => { const p = g.battlefield.find((x) => x.iid === ev.card); return p && p.controller === self.controller && characteristics(g, p).power >= 3; }, steps: [{ op: 'draw', n: 1 }] }] },
  'beast whisperer': { triggers: [{ event: 'spellCast', match: (g, self, ev) => ev.controller === self.controller && (ev.types || []).includes('Creature'), steps: [{ op: 'draw', n: 1 }] }] },
  'guttersnipe': { triggers: [{ event: 'spellCast', match: (g, self, ev) => ev.controller === self.controller && !(ev.types || []).includes('Creature'), steps: [{ op: 'damage', eachOpponent: true, n: 4 }] }] },
  'firebrand archer': { triggers: [{ event: 'spellCast', match: (g, self, ev) => ev.controller === self.controller && !(ev.types || []).includes('Creature'), steps: [{ op: 'damage', who: 'opponent', n: 1 }] }] },
  'thermo-alchemist': { triggers: [{ event: 'spellCast', match: (g, self, ev) => ev.controller === self.controller && !(ev.types || []).includes('Creature'), steps: [{ op: 'damage', who: 'opponent', n: 1 }] }] },
  'electrostatic field': { triggers: [{ event: 'spellCast', match: (g, self, ev) => ev.controller === self.controller && !(ev.types || []).includes('Creature'), steps: [{ op: 'damage', who: 'opponent', n: 1 }] }] },
  'kessig flamebreather': { triggers: [{ event: 'spellCast', match: (g, self, ev) => ev.controller === self.controller && !(ev.types || []).includes('Creature'), steps: [{ op: 'damage', who: 'opponent', n: 1 }] }] },
  'young pyromancer': { triggers: [{ event: 'spellCast', match: (g, self, ev) => ev.controller === self.controller && !(ev.types || []).includes('Creature'), steps: [{ op: 'token', token: tokenDef('Elemental token', 'Token Creature — Elemental', 1, 1, { colors: ['R'] }), n: 1 }] }] },
  'krenko, tin street kingpin': { triggers: [{ event: 'attacks', match: (g, self, ev) => ev.card === self.iid, steps: [{ op: 'token', token: tokenDef('Goblin token', 'Token Creature — Goblin', 1, 1, { colors: ['R'] }), n: 1 }] }] },
  'goblin rabblemaster': {
    triggers: [
      { event: 'beginCombat', match: (g, self, ev) => ev.player === self.controller && g.activePlayer === self.controller, steps: [{ op: 'token', token: tokenDef('Goblin token', 'Token Creature — Goblin', 1, 1, { colors: ['R'] }), n: 1 }] },
      { event: 'attacks', match: (g, self, ev) => ev.card === self.iid || true, steps: [] },
    ],
  },
  'hellrider': { triggers: [{ event: 'attacks', match: (g, self, ev) => g.battlefield.find((p) => p.iid === ev.card)?.controller === self.controller, steps: [{ op: 'damage', who: 'opponent', n: 1 }] }] },
  'impact_tremors': {},
  'goblin bombardment': { abilities: [{ costs: { sacrificeCreature: true }, steps: [{ op: 'damage', target: 'chosen', spec: 'anyTarget', n: 1 }], label: 'Sacrifice a creature: 1 damage' }] },
  'ashnod\'s altar': { abilities: [{ costs: { sacrificeCreature: true }, steps: [{ op: 'addMana', color: 'C', n: 2 }], label: 'Sacrifice a creature: add {C}{C}', isMana: true }] },
  'phyrexian altar': { abilities: [{ costs: { sacrificeCreature: true }, steps: [{ op: 'addMana', color: 'C', n: 1 }], label: 'Sacrifice a creature: add one mana of any color', isMana: true }] },
  'viscera seer': { abilities: [{ costs: { sacrificeCreature: true }, steps: [{ op: 'scryLike', n: 1 }], label: 'Sacrifice a creature: scry 1' }] },
  'carrion feeder': { abilities: [{ costs: { sacrificeCreature: true }, steps: [{ op: 'counter', target: 'self', counterType: '+1/+1', n: 1 }], label: 'Sacrifice a creature: +1/+1 counter' }] },
  // Yahenni: the sac outlet was written here, the death trigger somewhere else —
  // and a duplicated key means only the last one is a script at all, so the trigger
  // silently did nothing. Both halves now live in one entry.
  'yahenni, undying partisan': {
    // "Sacrifice ANOTHER creature" — Yahenni cannot eat itself (CR 601.2h).
    abilities: [{ costs: { sacrificeCreature: 'another' }, steps: [{ op: 'counter', target: 'self', counterType: '+1/+1', n: 1 }, { op: 'grant', target: 'self', keywords: ['Indestructible'] }], label: 'Sacrifice another creature: +1/+1 and indestructible' }],
    triggers: [{
      event: 'permanentDies',
      match: (g, self, ev) => ev.controller === g.other(self.controller),
      steps: [{ op: 'counter', target: 'self', counterType: '+1/+1', n: 1 }],
    }],
  },
  'woe strider': { abilities: [{ costs: { sacrificeCreature: true }, steps: [{ op: 'scryLike', n: 1 }], label: 'Sacrifice a creature: scry 1' }] },
  'skullclamp': { static: [{ kind: 'equip', bonus: { power: 1, toughness: -1 }, drawOnDeath: 2 }], abilities: [{ equip: 1, costs: { mana: { generic: 1 } }, label: 'Equip {1}', timing: 'sorcery' }] },
  'sword of vengeance': { static: [{ kind: 'equipGrant', keywords: ['First strike', 'Vigilance', 'Trample'], bonus: { power: 2, toughness: 1 } }], abilities: [{ equip: 3, costs: { mana: { generic: 3 } }, label: 'Equip {3}', timing: 'sorcery' }] },
  'loxodon warhammer': { static: [{ kind: 'equipGrant', keywords: ['Trample', 'Lifelink'], bonus: { power: 3, toughness: 0 } }], abilities: [{ equip: 3, costs: { mana: { generic: 3 } }, label: 'Equip {3}', timing: 'sorcery' }] },
  'bonesplitter': { static: [{ kind: 'equipGrant', bonus: { power: 2, toughness: 0 } }], abilities: [{ equip: 1, costs: { mana: { generic: 1 } }, label: 'Equip {1}', timing: 'sorcery' }] },
  'heirloom blade': { static: [{ kind: 'equipGrant', bonus: { power: 3, toughness: 1 } }], abilities: [{ equip: 3, costs: { mana: { generic: 3 } }, label: 'Equip {3}', timing: 'sorcery' }] },
  'lightning greaves': { statics: [{ kind: 'keywordGrant', appliesTo: { source: true }, keywords: ['Haste', 'Shroud'] }, { kind: 'equipGrant', keywords: ['Haste', 'Shroud'] }], abilities: [{ equip: 0, costs: {}, label: 'Equip {0}', timing: 'sorcery' }] },
  'swiftfoot boots': { statics: [{ kind: 'equipGrant', keywords: ['Haste', 'Hexproof'] }], abilities: [{ equip: 2, costs: { mana: { generic: 2 } }, label: 'Equip {2}', timing: 'sorcery' }] },
  'sword of fire and ice': { statics: [{ kind: 'equipGrant', bonus: { power: 2, toughness: 2 }, protection: ['R', 'U'] }], abilities: [{ equip: 2, costs: { mana: { generic: 2 } }, label: 'Equip {2}', timing: 'sorcery' }] },
  'sword of feast and famine': { statics: [{ kind: 'equipGrant', bonus: { power: 2, toughness: 2 }, protection: ['B', 'G'] }], abilities: [{ equip: 2, costs: { mana: { generic: 2 } }, label: 'Equip {2}', timing: 'sorcery' }] },
  'sword of light and shadow': { statics: [{ kind: 'equipGrant', bonus: { power: 2, toughness: 2 }, protection: ['W', 'B'] }], abilities: [{ equip: 2, costs: { mana: { generic: 2 } }, label: 'Equip {2}', timing: 'sorcery' }] },
  // Umezawa's Jitte. The charge counters themselves were never given out (nothing
  // emitted the event the trigger waited for) and the cost was written as
  // `removeCounters`, which no part of the engine understood. The three "choose one"
  // modes are three abilities, so the player picks the mode by picking the chip
  // instead of the engine silently implementing one of them.
  'umezawa\'s jitte': {
    statics: [{ kind: 'equipGrant', bonus: { power: 0, toughness: 0 } }],
    triggers: [{
      event: 'dealsDamage',
      match: (g, self, ev) => ev.source === self.iid || (self.attachedTo && ev.source === self.attachedTo.iid),
      steps: [{ op: 'counter', target: 'self', counterType: 'charge', n: 2 }],
    }],
    abilities: [
      { equip: 2, costs: { mana: { generic: 2 } }, label: 'Equip {2}', timing: 'sorcery' },
      { costs: { counters: { charge: 1 } }, condition: (g, perm) => !!perm.attachedTo, steps: [(g, ctx) => { const host = ctx.source?.attachedTo; if (host) opPump(g, host, 2, 2, ctx, 'eot'); }], label: 'Remove a charge counter: equipped creature gets +2/+2' },
      { costs: { counters: { charge: 1 } }, target: 'creature', steps: [{ op: 'pump', target: 'chosen', power: -1, toughness: -1 }], label: 'Remove a charge counter: target creature gets -1/-1' },
      { costs: { counters: { charge: 1 } }, steps: [{ op: 'gainLife', n: 2 }], label: 'Remove a charge counter: you gain 2 life' },
    ],
  },
  'fireshrieker': { statics: [{ kind: 'equipGrant', keywords: ['Double strike'] }], abilities: [{ equip: 2, costs: { mana: { generic: 2 } }, label: 'Equip {2}', timing: 'sorcery' }] },
  'basilisk collar': { statics: [{ kind: 'equipGrant', keywords: ['Deathtouch', 'Lifelink'] }], abilities: [{ equip: 1, costs: { mana: { generic: 1 } }, label: 'Equip {1}', timing: 'sorcery' }] },
  'embercleave': { statics: [{ kind: 'equipGrant', bonus: { power: 2, toughness: 2 }, keywords: ['Trample', 'Double strike'] }], abilities: [{ equip: 3, costs: { mana: { generic: 3 } }, label: 'Equip {3}', timing: 'sorcery' }] },
  'bloodforged battle-axe': { statics: [{ kind: 'equipGrant', bonus: { power: 2, toughness: 1 } }], abilities: [{ equip: 2, costs: { mana: { generic: 2 } }, label: 'Equip {2}', timing: 'sorcery' }] },
  'andúril, flame of the west': { statics: [{ kind: 'equipGrant', bonus: { power: 3, toughness: 1 } }], abilities: [{ equip: 2, costs: { mana: { generic: 2 } }, label: 'Equip {2}', timing: 'sorcery' }] },
  'helm of the host': {
    statics: [{ kind: 'equipGrant', bonus: { power: 0, toughness: 0 } }],
    triggers: [{
      event: 'beginCombat',
      match: (g, self, ev) => ev.player === self.controller && self.attachedTo?.name === 'Godo, Bandit Warlord',
      steps: [{ op: 'copyPermanent', target: 'equipped' }],
    }],
    abilities: [{ equip: 5, costs: { mana: { generic: 5 } }, label: 'Equip {5}', timing: 'sorcery' }],
  },

  'arixmethes, slumbering isle': {
    // Enters with five slumber counters; not a creature until they're gone.
    onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'noop' }]),
    entersWithCounters: { slumber: 5 },
    mana: [{
      colors: ['G', 'U'], amount: 1, tap: true, removesSlumber: true,
    }],
    statics: [{ kind: 'notACreatureWhileCounters', counter: 'slumber' }],
    extraLandDrops: () => 0,
    wake: (g, perm) => {
      if ((perm.counters.slumber || 0) === 0) {
        perm.setBase = { power: 12, toughness: 12 };
        perm.types = [...new Set([...perm.types, 'Creature'])];
        g.recomputeStatics();
      }
    },
  },

  /* ---------------- commanders ---------------- */
  'chatterfang, squirrel general (token line)': {},
  'kemba, kha regent': {
    triggers: [{
      event: 'upkeepStart',
      match: (g, self, ev) => ev.player === self.controller && ev.phase !== 'x',
      steps: [{ op: 'token', token: tokenDef('Cat token', 'Token Creature — Cat', 2, 2, { colors: ['W'] }), n: 1 }],
    }],
    extraTokensPerEquipment: true,
  },
  'winota, joiner of forces': {
    triggers: [{
      event: 'attacks',
      match: (g, self, ev) => { const atk = g.battlefield.find((p) => p.iid === ev.card); return atk && atk.controller === self.controller && !atk.subtypes.includes('Human'); },
      steps: [{ op: 'search', n: 1, filter: { type: 'Creature', subtype: 'Human' }, destination: 'battlefield' }],
    }],
  },
  'yuriko, the tiger\'s shadow': {
    triggers: [{
      event: 'combatDamageToPlayer',
      match: (g, self, ev) => ev.source === self.iid,
      steps: [{ op: 'damage', eachOpponent: true, n: 3 }],
    }],
    ninjutsu: { cost: { generic: 3, colors: { U: 1, B: 1 } } },
  },
  'godo, bandit warlord': {
    onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'search', n: 1, filter: { type: 'Artifact', subtype: 'Equipment' }, destination: 'hand' }]),
    extraCombat: true,
  },
  'kess, dissident mage': { flashbackFromGraveyard: true },
  'omnath, locus of rage (commander)': {},
  'teysa karlov (commander)': {},
  'torbran, thane of red fell (commander)': {},
  'kemba, kha regent (commander)': {},

  /* ---------------- misc value ---------------- */
  'crypt ghast': { mana: [{ colors: ['B'], amount: 2, cost: { life: 1 }, extract: true }] },
  'gray merchant of asphodel': {
    onEnter: (g, ctx) => {
      const devotion = g.battlefield.filter((p) => p.controller === ctx.controller)
        .reduce((a, p) => a + (p.card.mana_cost || '').match(/\{B\}/g)?.length || 0, 0);
      runSteps(g, ctx, [{ op: 'damage', eachOpponent: true, n: Math.max(1, devotion) }, { op: 'gainLife', n: Math.max(1, devotion) }]);
    },
  },
  'gray_merchant': {},
  'nettle sentinel': {},
  'stonehewer giant': { abilities: [{ costs: { tap: true, mana: { generic: 2 } }, steps: [{ op: 'search', n: 1, filter: { type: 'Artifact', subtype: 'Equipment' }, destination: 'battlefield' }], label: 'Search an Equipment onto the battlefield' }] },
  'auriok steelshaper': { statics: [{ kind: 'costReducer', cardType: 'artifact', amount: 1 }] },
  'puresteel paladin': { triggers: [{ event: 'permanentEntered', match: (g, self, ev) => { const p = g.battlefield.find((x) => x.iid === ev.card); return p && p.controller === self.controller && p.subtypes.includes('Equipment'); }, steps: [{ op: 'draw', n: 1 }] }] },
  'leonin shikari': { equipAnyTime: true },
  'stoneforge_mystic': {},
  'dark confidant': { triggers: [{ event: 'upkeepStart', match: (g, self, ev) => ev.player === self.controller, steps: [{ op: 'loseLife', n: 3 }, { op: 'draw', n: 1 }] }] },
  'notion thief': { replacement: 'notionThief' },
  'rhystic study': { triggers: [{ event: 'spellCast', match: (g, self, ev) => ev.controller !== self.controller, steps: [{ op: 'draw', n: 1 }] }] },
  'mystic remora': { triggers: [{ event: 'spellCast', match: (g, self, ev) => ev.controller !== self.controller, steps: [{ op: 'draw', n: 1 }] }] },
  'smothering tithe': { triggers: [{ event: 'draw', match: (g, self, ev) => ev.player !== self.controller, steps: [{ op: 'token', token: tokenDef('Treasure', 'Token Artifact — Treasure', null, null, {}), n: 1 }] }] },
  'goblin welder': { abilities: [{ costs: { tap: true }, steps: [{ op: 'reanimate', filter: { artifact: true } }], label: '{T}: return an artifact from your graveyard' }] },
  'goblin engineer': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'search', n: 1, filter: { type: 'Artifact' } }]) },
  'kiki-jiki, mirror breaker': { abilities: [{ costs: { tap: true }, steps: [{ op: 'copyPermanent', target: 'chosen' }], label: '{T}: copy target nonlegendary creature you control' }] },
  'zealous conscripts': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'noop', note: 'steal target permanent (simplified to a tap-down)' }]) },
  'treasonous ogre': { mana: [{ colors: ['R'], amount: 3, cost: { life: 6 } }] },
  'ragavan, nimble pilferer': { triggers: [{ event: 'combatDamageToPlayer', match: (g, self, ev) => ev.source === self.iid, steps: [{ op: 'token', token: tokenDef('Treasure', 'Token Artifact — Treasure', null, null, {}), n: 1 }] }] },
  'blood moon': { statics: [{ kind: 'moon', appliesTo: { land: true, controller: 'opp' } }] },
  'magus of the moon': { statics: [{ kind: 'moon', appliesTo: { land: true, controller: 'opp' } }] },
  'rest in peace': {},
  'living death': { steps: [{ op: 'destroyAll', filter: { kind: 'permanent', filter: { creature: true } } }, { op: 'reanimate', filter: { creature: true } }] },
  'scapeshift': { steps: [{ op: 'searchBasics', n: 4, destination: 'battlefield', tapped: true }] },
  'zuran orb': { abilities: [{ costs: { sacrificeLand: true }, steps: [{ op: 'gainLife', n: 2 }], label: 'Sacrifice a land: gain 2 life' }] },
  'perilous forays': { abilities: [{ costs: { mana: { generic: 1 }, sacrificeCreature: true }, steps: [{ op: 'searchBasics', n: 1, destination: 'battlefield', tapped: true }], label: 'Sacrifice a creature: search a basic' }] },
  'greater good': { abilities: [{ costs: { sacrificeCreature: true }, steps: [{ op: 'draw', n: 3 }, { op: 'discard', n: 3 }], label: 'Sacrifice a creature: draw 3' }] },
  'zuran_orb': {},
  'titania, protector of argoth': { triggers: [{ event: 'youSacrificed', match: (g, self, ev) => ev.player === self.controller && g.players[self.controller].zones.graveyard.some((c) => false), steps: [{ op: 'token', token: tokenDef('Elemental token', 'Token Creature — Elemental', 5, 3, { colors: ['G'] }), n: 1 }] }] },
  'mirrorpool': {},
  'sylvan library': { triggers: [{ event: 'drawStep', match: (g, self, ev) => ev.player === self.controller, steps: [{ op: 'draw', n: 2 }] }] },

  /* ---------------- counterspells / interaction payoffs ---------------- */
  'deflecting swat': { steps: [{ op: 'noop', note: 'redirect target (simplified: spell fizzles)' }] },
  'pyroblast': { steps: [{ op: 'counterSpell', filter: {} }] },
  'red elemental blast': { steps: [{ op: 'counterSpell', filter: {} }] },
  'temporal trespass': { steps: [{ op: 'extraTurn' }] },
  'aggravated assault': { abilities: [{ costs: { mana: { generic: 3, colors: { R: 2 } } }, steps: [{ op: 'extraTurn' }], label: '{3}{R}{R}: extra combat phase' }] },
  'combat celebrant': { triggers: [{ event: 'attacks', match: (g, self, ev) => ev.card === self.iid, steps: [{ op: 'noop', note: 'exert for an extra combat (simplified)' }] }] },
  'aurelia, the warleader': { triggers: [{ event: 'attacks', match: (g, self, ev) => ev.card === self.iid, steps: [{ op: 'noop', note: 'extra combat step (simplified into a pump)' }, { op: 'pumpAll', filter: { kind: 'permanent', filter: { creature: true, controller: 'you' } }, power: 1, toughness: 1 }] }] },
  'hero of bladehold': { triggers: [{ event: 'attacks', match: (g, self, ev) => ev.card === self.iid, steps: [{ op: 'token', token: tokenDef('Soldier token', 'Token Creature — Soldier', 1, 1, { colors: ['W'] }), n: 2 }] }] },
  'hanweir garrison': { triggers: [{ event: 'attacks', match: (g, self, ev) => ev.card === self.iid, steps: [{ op: 'token', token: tokenDef('Human token', 'Token Creature — Human', 1, 1, { colors: ['R'] }), n: 2 }] }] },
  'legion warboss': { triggers: [{ event: 'beginCombat', match: (g, self, ev) => ev.player === self.controller, steps: [{ op: 'token', token: tokenDef('Goblin token', 'Token Creature — Goblin', 1, 1, { colors: ['R'] }), n: 1 }] }] },
  'brimaz, king of oreskos': { triggers: [{ event: 'attacks', match: (g, self, ev) => ev.card === self.iid, steps: [{ op: 'token', token: tokenDef('Cat token', 'Token Creature — Cat', 1, 1, { colors: ['W'] }), n: 1 }] }] },
  'legion loyalist': {},
  'krenko, mob boss': { abilities: [{ costs: { tap: true }, steps: [{ op: 'token', token: tokenDef('Goblin token', 'Token Creature — Goblin', 1, 1, { colors: ['R'] }), n: 3 }], label: '{T}: create Goblins equal to your Goblins' }] },
  'siege-gang commander': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'token', token: tokenDef('Goblin token', 'Token Creature — Goblin', 1, 1, { colors: ['R'] }), n: 3 }]), abilities: [{ costs: { sacrificeCreature: true }, steps: [{ op: 'damage', target: 'chosen', spec: 'anyTarget', n: 2 }], label: 'Sacrifice a Goblin: 2 damage' }] },
  'beetleback chief': { onEnter: (g, ctx) => runSteps(g, ctx, [{ op: 'token', token: tokenDef('Goblin token', 'Token Creature — Goblin', 1, 1, { colors: ['R'] }), n: 2 }]) },
  'dragon fodder': { steps: [{ op: 'token', token: tokenDef('Goblin token', 'Token Creature — Goblin', 1, 1, { colors: ['R'] }), n: 2 }] },
  'krenko\'s command': { steps: [{ op: 'token', token: tokenDef('Goblin token', 'Token Creature — Goblin', 1, 1, { colors: ['R'] }), n: 2 }] },
  'hordeling outburst': { steps: [{ op: 'token', token: tokenDef('Goblin token', 'Token Creature — Goblin', 1, 1, { colors: ['R'] }), n: 3 }] },
  'raise the alarm': { steps: [{ op: 'token', token: tokenDef('Soldier token', 'Token Creature — Soldier', 1, 1, { colors: ['W'] }), n: 2 }] },
  'spectral procession': { steps: [{ op: 'token', token: tokenDef('Spirit token', 'Token Creature — Spirit', 1, 1, { colors: ['W'], keywords: ['Flying'] }), n: 3 }] },
  'secure the wastes': { steps: [{ op: 'token', token: tokenDef('Warrior token', 'Token Creature — Warrior', 1, 1, { colors: ['W'] }), n: 3 }], xSpell: true },
  'white sun\'s zenith': { steps: [{ op: 'token', token: tokenDef('Cat token', 'Token Creature — Cat', 2, 2, { colors: ['W'] }), n: 3 }], xSpell: true },
  'nyxborn': {},
  'assemble the legion': { triggers: [{ event: 'upkeepStart', match: (g, self, ev) => ev.player === self.controller, steps: [{ op: 'token', token: tokenDef('Soldier token', 'Token Creature — Soldier', 1, 1, { colors: ['R', 'W'], keywords: ['Haste'] }), n: 2 }] }] },
  'mantle of the ancients': {},
};

/* ------------------------------------------------------------------ */
/* Compilation pipeline                                                */
/* ------------------------------------------------------------------ */

export function buildScript(card) {
  const key = (card.name || '').toLowerCase();
  if (cache.has(key)) return cache.get(key);

  // A script describes the CARD, so it must be derived from canonical card data
  // — never from whichever object happened to ask first. Callers pass deck
  // instances, permanents (with mutated types/keywords/attachments) and plain
  // oracle records, so the first cache miss decided the script for the whole
  // process: a script built from a bare oracle record had no `types`, which
  // silently dropped the intrinsic basic-land mana ability (CR 305.6) and left
  // whole decks uncastable whenever something scanned the pool before the game
  // started. Tokens (no oracle entry) fall back to the object passed in.
  const data = withTypes(oracle[key] || card);
  const hand = HAND_SCRIPTS[key] || {};
  const text = data.oracle_text || '';
  const cmdr = (data.type_line || '').includes('Creature');
  const script = {
    ...hand,                       // tokenDoubler, damageMultiplier, extraLandDrops, scry, ...
    name: data.name || card.name,
    oracle: text,                  // the card's own rules text (targeting reads "Enchant ..." from it)
    typeLine: data.type_line || '',
    isAura: /\bAura\b/.test(data.type_line || ''),
    // "Enchanted land has \"{T}: ...\"" — the ability belongs to the enchanted
    // permanent, not to the Aura (CR 303.4 applies continuous effects to the host).
    grantsAbilitiesToHost: /Enchanted [a-z]+ has "/i.test(text),
    mana: [...(hand.mana || [])],
    abilities: [...(hand.abilities || []), ...(hand.abilities ? [] : parseActivated(text, data))],
    triggers: [...(hand.triggers || [])],
    statics: [...(hand.statics || []), ...(hand.static || [])],
    steps: hand.steps || null,
    onResolve: hand.onResolve || null,
    onEnter: hand.onEnter || null,
    onDeath: hand.onDeath || null,
    entersTapped: hand.entersTapped ?? false,
    unsupported: [],
    keywords: inferKeywords(data),
  };

  // compiler fills the gaps for anything not hand-written
  if (!script.steps && !script.onResolve && (data.types || []).some((t) => ['Instant', 'Sorcery'].includes(t))) {
    const parsed = parseClause(text, {});
    script.steps = parsed.steps;
    script.unsupported.push(...parsed.unparsed);
  }
  if (!script.onEnter) {
    const etb = parseTriggered(text).find((t) => t.event === 'etb' && !t.filter?.other);
    if (etb) {
      script.onEnter = (g, ctx) => runSteps(g, ctx, etb.steps);
      script.unsupported.push(...(etb.unparsed || []));
    }
  }
  if (!script.onDeath) {
    const dies = parseTriggered(text).find((t) => t.event === 'dies');
    if (dies) {
      script.onDeath = (g, ctx) => runSteps(g, ctx, dies.steps);
      script.unsupported.push(...(dies.unparsed || []));
    }
  }
  if (!script.triggers.length) {
    for (const t of parseTriggered(text)) {
      if (t.event === 'etb' || t.event === 'dies') continue;
      script.triggers.push({
        event: t.event,
        match: genericTriggerMatch(t),
        steps: t.steps,
        raw: t.raw,
      });
      script.unsupported.push(...(t.unparsed || []));
    }
  }
  if (!script.abilities.length && !hand.abilities) {
    const acts = parseActivated(text, data);
    for (const a of acts) if (!a.producesMana) script.abilities.push(a);
  }
  script.statics.push(...parseStatic(text, data));

  // CR 305.6: a land with a basic land type has the intrinsic mana ability of that type
  if ((data.types || []).includes('Land') && !script.mana.length) {
    const basicColors = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
    const colors = [...new Set((data.subtypes || []).map((st) => basicColors[st]).filter(Boolean))];
    if (colors.length) script.mana.push({ colors, amount: 1 });
  }

  // numeric damage modifiers
  if (!hand.damageMultiplier && /(?:double|twice) (?:all|the) damage|deals double damage/i.test(text)) {
    script.damageMultiplier = 2;
  }
  // A hand-written script is authoritative for the behaviours it declares, and any
  // intentional simplification must be declared explicitly via `simplified` so the
  // coverage report stays honest.
  if (Object.keys(HAND_SCRIPTS).includes(key)) {
    const declared = hand.simplified || [];
    script.unsupported = script.unsupported.filter((phrase) => declared.includes(phrase));
    script.simplified = declared;
  }
  script.unsupported = [...new Set(script.unsupported)].filter((s) => s.length > 2);
  cache.set(key, script);
  return script;
}

function genericTriggerMatch(t) {
  const f = t.filter || {};
  return (g, self, ev) => {
    if (f.self) {
      if (t.event === 'attacks' && ev.card !== self.iid) return false;
      if (t.event === 'etb' && ev.card !== self.iid) return false;
      if (t.event === 'dies' && ev.card !== self.iid) return false;
    }
    if (t.event === 'upkeep') return ev.player === self.controller;
    if (t.event === 'endStep') return ev.player === self.controller || !f.self;
    if (t.event === 'landfall') return ev.player === self.controller;
    if (t.event === 'spellCast') {
      if (ev.controller !== self.controller) return false;
      if (f.type && !(ev.types || []).includes(f.type)) return false;
      if (f.noncreature && (ev.types || []).includes('Creature')) return false;
      return true;
    }
    if (t.event === 'attacks') {
      const atk = g.battlefield.find((p) => p.iid === ev.card);
      return !!atk && atk.controller === self.controller;
    }
    // "Whenever a creature you control attacks": one trigger per attacker, and
    // only for the controller's own creatures (Beastmaster Ascension).
    if (t.event === 'creatureAttacks') {
      const atk = g.battlefield.find((p) => p.iid === ev.card);
      return !!atk && atk.controller === self.controller;
    }
    // "Whenever this creature is dealt damage" (Boros Reckoner): the event names
    // the permanent that was hurt, so only its own source matches.
    if (t.event === 'selfDamaged') return ev.card === self.iid || ev.perm === self.iid;
    // "Whenever this creature deals damage": the equipped creature counts, since
    // the equipment's trigger belongs to whatever it is attached to.
    if (t.event === 'dealsDamage') {
      const src = g.battlefield.find((p) => p.iid === ev.source);
      if (!src) return false;
      if (src.iid === self.iid) return true;
      return (self.attachments || []).some((a) => a.iid === src.iid)
        || (src.attachments || []).some((a) => a.iid === self.iid);
    }
    if (t.event === 'permanentDies' || t.event === 'permanentEntered') {
      const p = g.battlefield.find((x) => x.iid === (ev.card || ev.iid)) || g.players.flatMap((pl) => pl.zones.graveyard).find((c) => c.iid === ev.card);
      if (f.other && p?.iid === self.iid) return false;
      if (p && p.controller === self.controller) return true;
      return !f.other;
    }
    return true;
  };
}

export function cardScript(card) { return buildScript(card); }

/** Trigger specs for a permanent, including hand scripts + compiled. */
export function triggerSpecsFor(perm) {
  const script = cardScript(perm);
  const specs = [];
  for (const t of script.triggers) specs.push(t);
  // equip / static bonuses are applied by the static layer, not here
  return specs.filter((t) => t && t.event);
}

/** Continuous effects contributed by a permanent. */
/**
 * Abilities an Aura grants to what it enchants. An Aura with
 * "Enchanted land has \"{T}: ...\"" has no activated ability of its own — the
 * enchanted land does, and tapping it is what pays the cost.
 */
export function grantedAbilitiesFor(host, game) {
  const out = [];
  for (const att of host.attachments || []) {
    if (att.zone !== 'battlefield') continue;
    const script = cardScript(att);
    if (!script.grantsAbilitiesToHost) continue;
    (script.abilities || []).forEach((ability, index) => out.push({ perm: host, ability, index, grantedBy: att }));
  }
  return out;
}

/**
 * The card that just died, for a trigger that has to inspect it. `permanentDied`
 * carries an iid, and by trigger time the permanent is in a graveyard — so this
 * looks it up by id across the zones rather than trusting the event payload.
 */
export function diedCardFor(game, ev) {
  if (!ev || !ev.card) return null;
  for (const pl of game.players) {
    for (const zone of ['graveyard', 'battlefield', 'exile']) {
      const found = (pl.zones[zone] || []).find((c) => c.iid === ev.card);
      if (found) return found;
    }
  }
  return null;
}

export function staticModsFor(perm, game) {
  const script = cardScript(perm);
  const mods = [];
  // An Aura's continuous effects apply to the creature it enchants, so for an
  // Aura "self" means its host (CR 303.4). An unattached Aura contributes
  // nothing at all -- and a state-based action puts it into the graveyard.
  const isAura = !!script.isAura || (perm.subtypes || []).includes('Aura');
  const subject = isAura ? perm.attachedTo : perm;
  for (const s of script.statics || []) {
    if (s.kind === 'ptBonus') {
      const applies = (target) => {
        if (s.appliesTo.self) return !!subject && target.iid === subject.iid;
        if (target.iid === perm.iid && !s.includeSelf) return false;
        if (s.appliesTo.controller === 'you' && target.controller !== perm.controller) return false;
        const ch = characteristics(game, target);
        if (s.appliesTo.creature && !ch.isCreature) return false;
        if (s.appliesTo.subtype && !target.subtypes.includes(s.appliesTo.subtype)) return false;
        if (s.condition && !s.condition(game, perm, target)) return false;
        return true;
      };
      mods.push({ kind: 'ptBonus', applies, power: s.power, toughness: s.toughness, source: perm });
    } else if (s.kind === 'keywordGrant') {
      const applies = (target) => {
        if (s.appliesTo.self) return !!subject && target.iid === subject.iid;
        if (s.appliesTo.controller === 'you' && target.controller !== perm.controller) return false;
        const ch = characteristics(game, target);
        if (s.appliesTo.creature && !ch.isCreature) return false;
        if (s.appliesTo.subtype && !target.subtypes.includes(s.appliesTo.subtype)) return false;
        return true;
      };
      mods.push({ kind: 'keywordGrant', applies, keywords: s.keywords, source: perm });
    } else if (s.kind === 'costReducer') {
      mods.push({ kind: 'costReducer', cardType: s.cardType, amount: s.amount, source: perm });
    } else if (s.kind === 'moon') {
      // Blood Moon: nonbasic lands are Mountains
      mods.push({ kind: 'addTypes', applies: (t) => isLand(t) && t.iid !== perm.iid, addTypes: ['Mountain'], source: perm, bloodMoon: true });
    } else if (s.kind === 'cannotAttack' || s.kind === 'cannotBlock' || s.kind === 'unblockable') {
      // Attacking and blocking restrictions become keywords, so the one place
      // that decides combat legality (canBlock, the attacker filter) is the one
      // place that has to know about them.
      const keywords = s.kind === 'unblockable' ? ['Unblockable']
        : s.kind === 'cannotAttack' ? ['CantAttack'] : ['CantBlock'];
      mods.push({
        kind: 'keywordGrant',
        applies: (target) => !!subject && target.iid === subject.iid,
        keywords,
        source: perm,
        restriction: true,
      });
    } else if (s.kind === 'sacOnDeath' || s.kind === 'deathTriggerDoubler') {
      mods.push({ kind: s.kind, applies: () => true, source: perm });
    }
  }
  // Equipment bonuses flow to the equipped creature
  if (perm.subtypes.includes('Equipment') && perm.attachedTo) {
    for (const s of script.statics || []) {
      if (s.kind === 'equipGrant') {
        const host = perm.attachedTo;
        if (s.bonus) mods.push({ kind: 'ptBonus', applies: (t) => t.iid === host.iid, power: s.bonus.power || 0, toughness: s.bonus.toughness || 0, source: perm });
        if (s.keywords) mods.push({ kind: 'keywordGrant', applies: (t) => t.iid === host.iid, keywords: s.keywords, source: perm });
      }
    }
    // token doublers / multipliers declared on the equipment itself
  }
  if (script.tokenDoubler) mods.push({ kind: 'tokenDoubler', source: perm });
  if (script.damageMultiplier) mods.push({ kind: 'damageMultiplier', amount: script.damageMultiplier, source: perm });
  if (script.damageAddend) mods.push({ kind: 'damageAddend', amount: script.damageAddend, source: perm });
  return mods;
}

/* ------------------------------------------------------------------ */
/* Small helper so hand scripts can run step lists                     */
/* ------------------------------------------------------------------ */

export function runSteps(g, ctx, steps) {
  runEffects(g, ctx, steps);
}

export { SPECS, opPump, opGrantKeyword };
