/**
 * Oracle-text compiler.
 *
 * Turns real Scryfall oracle text into executable effect steps. It is deliberately
 * conservative: a phrase it cannot parse is recorded as `unparsed` rather than
 * guessed at, so coverage is measurable (scripts/coverage.mjs) and the UI can be
 * honest about which cards are fully automated.
 *
 * Hand-written scripts in scripts.js take precedence over compiled output for the
 * cards that matter most (the combo pieces, commanders, and anything unusual).
 */
import { tokenDef } from './ops.js';

const NUM = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20, x: 'X',
};

const num = (word, ctx) => {
  const key = String(word).toLowerCase();
  if (key === 'x') return ctx?.x ?? 0;
  if (NUM[key] !== undefined) return NUM[key] === 'X' ? (ctx?.x ?? 0) : NUM[key];
  const n = parseInt(key, 10);
  return Number.isNaN(n) ? 1 : n;
};

const COLORS = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
const BASIC_OF = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };

/** Common token stat lines. */
const TOKEN_TYPES = {
  squirrel: ['Squirrel', 1, 1, 'G'], cat: ['Cat', 2, 2, 'W'], soldier: ['Soldier', 1, 1, 'W'],
  goblin: ['Goblin', 1, 1, 'R'], spirit: ['Spirit', 1, 1, 'W'], zombie: ['Zombie', 2, 2, 'B'],
  beast: ['Beast', 3, 3, 'G'], elemental: ['Elemental', 5, 5, 'R'], treasure: ['Treasure', 0, 0, 'C'],
  clue: ['Clue', 0, 0, 'C'], dragon: ['Dragon', 4, 4, 'R'], warrior: ['Warrior', 1, 1, 'W'],
  knight: ['Knight', 2, 2, 'W'], citizen: ['Citizen', 1, 1, 'W'], saproling: ['Saproling', 1, 1, 'G'],
  wolf: ['Wolf', 2, 2, 'G'], human: ['Human', 1, 1, 'W'], ninja: ['Ninja', 1, 1, 'U'],
  plant: ['Plant', 0, 1, 'G'], horror: ['Horror', 2, 2, 'B'], vampire: ['Vampire', 2, 2, 'B'],
  angel: ['Angel', 4, 4, 'W'], demon: ['Demon', 5, 5, 'B'], food: ['Food', 0, 0, 'C'],
  kraken: ['Kraken', 9, 9, 'U'], ooze: ['Ooze', 1, 1, 'G'],
};

function tokenFromPhrase(text) {
  const m = text.match(/create[sd]?\s+((?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\d+)\s+)?(?:tapped\s+)?(\d+\/\d+|x\/x)\s+([a-z]+)\s*([a-z\s]*?)\s*(?:creature\s+)?tokens?/i);
  if (m) {
    const count = m[1] ? num(m[1].trim(), { x: 1 }) : 1;
    const [p, t] = m[2].toLowerCase().split('/').map(Number);
    const colorWord = (m[3] || '').toLowerCase();
    const color = COLORS[colorWord] || (m[4] && COLORS[m[4].match(/(white|blue|black|red|green)/i)?.[1]?.toLowerCase()]) || 'C';
    const subtype = (m[4] || m[3] || 'Creature').match(/([A-Z][a-z]+)/)?.[1] || 'Creature';
    return { def: tokenDef(`${subtype} token`, `Token Creature — ${m[3]}`, p, t, { colors: [color] }), count };
  }
  const named = text.match(/create[sd]?\s+((?:a|an|one|two|three|four|five|six|x|\d+)\s+)?(?:tapped\s+)?(Squirrel|Cat|Soldier|Goblin|Spirit|Zombie|Beast|Elemental|Treasure|Clue|Dragon|Warrior|Knight|Citizen|Saproling|Wolf|Human|Ninja|Plant|Vampire|Angel|Demon|Kraken|Food)\b/);
  if (named) {
    const raw = named[1] ? num(named[1].trim(), { x: 1 }) : 1;
    const count = typeof raw === 'number' ? raw : 1;
    const key = named[2].toLowerCase();
    const spec = TOKEN_TYPES[key];
    if (spec) {
      const [sub, p, t, color] = spec;
      if (sub === 'Treasure') return { def: tokenDef('Treasure', 'Token Artifact — Treasure', null, null, { oracle_text: '{T}, Sacrifice this token: Add one mana of any color.' }), count };
      if (sub === 'Clue') return { def: tokenDef('Clue', 'Token Artifact — Clue', null, null, { oracle_text: '{2}, Sacrifice this token: Draw a card.' }), count };
      if (sub === 'Food') return { def: tokenDef('Food', 'Token Artifact — Food', null, null, { oracle_text: '{2}, {T}, Sacrifice this token: You gain 3 life.' }), count };
      return { def: tokenDef(`${sub} token`, `Token Creature — ${sub}`, p, t, { colors: [color] }), count };
    }
  }
  return null;
}

/** Parse a single sentence/effect clause into steps. */
export function parseClause(text, opts = {}) {
  const out = [];
  const unparsed = [];
  const sentences = text.split(/(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    const s = sentence.replace(/^(you may|you)\s+/i, '');
    const low = s.toLowerCase();
    let m;

    // --- drawing ---
    if ((m = low.match(/^draw\s+((?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\d+))\s+cards?/))) {
      out.push({ op: 'draw', n: num(m[1], opts) }); continue;
    }
    if ((m = low.match(/^each player draws\s+((?:a|an|one|two|three|x|\d+))\s+cards?/))) {
      out.push({ op: 'drawEach', n: num(m[1], opts) }); continue;
    }
    if (/^you may draw/.test(low)) { out.push({ op: 'draw', n: 1 }); continue; }

    // --- damage ---
    if ((m = low.match(/deals?\s+((?:x|\d+|one|two|three|four|five|six|seven|eight|nine|ten))\s+damage\s+to\s+any target/))) {
      out.push({ op: 'damage', target: 'chosen', n: num(m[1], opts), spec: 'anyTarget' }); continue;
    }
    if ((m = low.match(/deals?\s+((?:x|\d+|one|two|three|four|five|six|seven|eight|nine|ten))\s+damage\s+to\s+(each opponent|target player|target opponent|that player)/))) {
      const t = m[2];
      out.push(t === 'each opponent'
        ? { op: 'damage', eachOpponent: true, n: num(m[1], opts) }
        : { op: 'damage', target: 'chosen', n: num(m[1], opts), spec: 'player' });
      continue;
    }
    if ((m = low.match(/deals?\s+((?:x|\d+|one|two|three|four|five|six|seven|eight|nine|ten))\s+damage\s+to\s+target (creature|permanent|artifact|enchantment|planeswalker|nonland permanent|creature or planeswalker)/))) {
      const map = { creature: 'creature', permanent: 'permanent', artifact: 'artifactOrEnchantment', enchantment: 'artifactOrEnchantment', planeswalker: 'creatureOrPlaneswalker', 'nonland permanent': 'nonlandPermanent', 'creature or planeswalker': 'creatureOrPlaneswalker' };
      out.push({ op: 'damage', target: 'chosen', n: num(m[1], opts), spec: map[m[2]] || 'creature' }); continue;
    }
    if ((m = low.match(/deals?\s+((?:x|\d+|one|two|three|four|five|six))\s+damage\s+to\s+each creature/))) {
      out.push({ op: 'damageAll', n: num(m[1], opts), filter: { kind: 'permanent', filter: { creature: true } } }); continue;
    }
    if ((m = low.match(/deals?\s+((?:x|\d+|one|two|three|four|five|six|seven|eight|nine|ten))\s+damage\s+to\s+(?:with\s+)?(?:flying\s+)?(?:all|each)\s+creatures?\s+you don'?t control/))) {
      out.push({ op: 'damageAll', n: num(m[1], opts), filter: { kind: 'permanent', filter: { creature: true, controller: 'opp' } } }); continue;
    }

    // --- life ---
    if ((m = low.match(/^(?:you\s+)?gain\s+((?:x|\d+|one|two|three|four|five|six|seven|eight|nine|ten))\s+life/))) {
      out.push({ op: 'gainLife', n: num(m[1], opts) }); continue;
    }
    if ((m = low.match(/each opponent loses\s+((?:x|\d+|one|two|three|four|five|six|seven|eight|nine|ten))\s+life/))) {
      out.push({ op: 'loseLife', who: 'opponent', n: num(m[1], opts) }); continue;
    }
    if ((m = low.match(/target player loses\s+((?:x|\d+|one|two|three))\s+life/))) {
      out.push({ op: 'loseLife', target: 'chosen', n: num(m[1], opts), spec: 'player' }); continue;
    }
    if ((m = low.match(/you lose\s+((?:x|\d+|one|two|three))\s+life/))) { out.push({ op: 'loseLife', n: num(m[1], opts) }); continue; }

    // --- removal ---
    if ((m = low.match(/^destroy target (creature|artifact|enchantment|permanent|nonland permanent|land|creature or planeswalker|artifact or enchantment|planeswalker)/))) {
      const map = { creature: 'creature', artifact: 'artifactOrEnchantment', enchantment: 'artifactOrEnchantment', permanent: 'permanent', 'nonland permanent': 'nonlandPermanent', land: 'land', 'creature or planeswalker': 'creatureOrPlaneswalker', 'artifact or enchantment': 'artifactOrEnchantment', planeswalker: 'creatureOrPlaneswalker' };
      out.push({ op: 'destroy', target: 'chosen', spec: map[m[1]] }); continue;
    }
    if (/^destroy all creatures/.test(low)) { out.push({ op: 'destroyAll', filter: { kind: 'permanent', filter: { creature: true } } }); continue; }
    if (/^destroy all (lands|permanents|artifacts|enchantments|nonland permanents)/.test(low)) {
      const t = low.match(/all (\w+)/)[1];
      const f = t === 'lands' ? { land: true } : t === 'artifacts' ? { artifact: true } : t === 'enchantments' ? { enchantment: true } : { nonland: true };
      out.push({ op: 'destroyAll', filter: { kind: 'permanent', filter: f } }); continue;
    }
    if ((m = low.match(/^exile target (creature|artifact|enchantment|permanent|nonland permanent|artifact or enchantment|creature or planeswalker)/))) {
      const map = { creature: 'creature', artifact: 'artifactOrEnchantment', enchantment: 'artifactOrEnchantment', permanent: 'permanent', 'nonland permanent': 'nonlandPermanent', 'artifact or enchantment': 'artifactOrEnchantment', 'creature or planeswalker': 'creatureOrPlaneswalker' };
      out.push({ op: 'exile', target: 'chosen', spec: map[m[1]] }); continue;
    }
    if (/^exile all creatures/.test(low)) { out.push({ op: 'exileAll', filter: { kind: 'permanent', filter: { creature: true } } }); continue; }

    // --- bounce ---
    if ((m = low.match(/^return (?:target|up to one target) (creature|permanent|nonland permanent|artifact|enchantment)\s+(?:to its owner'?s hand|to (?:its|their) owner'?s hand)/))) {
      out.push({ op: 'bounce', target: 'chosen', spec: m[1] === 'creature' ? 'creature' : 'nonlandPermanent' }); continue;
    }
    if (/^return all creatures to their owners'? hands/.test(low) || /return all creatures .* to (?:its|their) owner/.test(low)) {
      out.push({ op: 'bounceAll', filter: { kind: 'permanent', filter: { creature: true } } }); continue;
    }

    // --- counters ---
    if ((m = low.match(/put\s+((?:a|an|one|two|three|four|x|\d+))\s+\+1\/\+1 counters? on (target creature|each creature you control|~|it|target creature you control)/))) {
      const spec = m[2].includes('target') ? 'creature' : null;
      out.push({ op: 'counter', n: num(m[1], opts), counterType: '+1/+1', target: spec ? 'chosen' : 'self', spec });
      continue;
    }

    // --- pump ---
    if ((m = low.match(/(?:target creature|creatures you control|each creature you control|target creature you control)\s+gets?\s+\+((?:x|\d+))\/\+((?:x|\d+))/))) {
      const pw = num(m[1], opts), tg = num(m[2], opts);
      out.push({ op: 'pumpAll', filter: { kind: 'permanent', filter: { creature: true, controller: 'you' } }, power: pw, toughness: tg });
      continue;
    }
    if ((m = low.match(/^target creature gets \+((?:x|\d+))\/\+((?:x|\d+)) (?:and gains [^u]*)?until end of turn/))) {
      out.push({ op: 'pump', target: 'chosen', spec: 'creature', power: num(m[1], opts), toughness: num(m[2], opts) });
      continue;
    }

    // --- tokens ---
    if (/create|creates/.test(low)) {
      const t = tokenFromPhrase(s);
      if (t) { out.push({ op: 'token', token: t.def, n: t.count }); continue; }
    }

    // --- mana ---
    if ((m = low.match(/^add ((?:\{[wubrgc]\}|one mana of any color|{[wubrg]}{[wubrg]}|x mana of any one color|[a-z]+ mana)+)/))) {
      const syms = m[1].match(/\{[wubrgc]\}/gi);
      if (syms) { for (const sym of syms) out.push({ op: 'addMana', color: sym[1].toUpperCase(), n: 1 }); continue; }
      if (/any color|any one color/.test(m[1])) { out.push({ op: 'addMana', color: 'C', n: 1, anyColor: true }); continue; }
      const word = m[1].match(/(white|blue|black|red|green)/i);
      if (word) { out.push({ op: 'addMana', color: COLORS[word[1].toLowerCase()], n: 1 }); continue; }
    }

    // --- library ---
    if ((m = low.match(/^search your library for (?:a|up to (?:two|three|four)|one) (basic land|land|creature|artifact|enchantment|instant|sorcery|planeswalker|creature card)[^,]*,\s*(?:reveal it,?\s*)?(?:and )?put (?:it|them|that card) onto the battlefield/))) {
      const kind = m[1];
      out.push({ op: 'searchBasics', n: 1, type: kind === 'basic land' ? null : undefined, destination: 'battlefield', tapped: /tapped/.test(low) });
      continue;
    }
    if ((m = low.match(/^search your library for (?:a|up to (?:two|three)|one) (basic land|land|creature|artifact|enchantment|instant|sorcery|planeswalker|card)[^,]*,\s*(?:reveal it,?\s*)?put (?:it|that card) into your hand/))) {
      out.push({ op: 'search', n: 1, filter: { basic: m[1] === 'basic land', land: /land/.test(m[1]), any: m[1] === 'card' } });
      continue;
    }
    if (/^shuffle your library/.test(low)) { out.push({ op: 'shuffle' }); continue; }

    // --- mill / discard ---
    if ((m = low.match(/(?:target player|that player|each opponent) mills?\s+((?:x|\d+|one|two|three|four|five|six|seven|eight|nine|ten))/))) {
      out.push({ op: 'mill', who: /each opponent/.test(low) ? 'opponent' : 'opponent', n: num(m[1], opts) }); continue;
    }
    if ((m = low.match(/^mill\s+((?:x|\d+|one|two|three|four|five|six|seven|eight|nine|ten)) cards?/))) {
      out.push({ op: 'mill', n: num(m[1], opts) }); continue;
    }
    if ((m = low.match(/^(?:target player |each player )?discards?\s+((?:x|\d+|one|two|three|four|five|six|seven|eight|nine|ten|their hand|his or her hand))/))) {
      out.push(/each player/.test(low) ? { op: 'discardEach', n: 1 } : { op: 'discard', n: num(m[1], opts) || 1 });
      continue;
    }

    // --- tapping ---
    if ((m = low.match(/^tap target (creature|artifact|permanent|land)/))) { out.push({ op: 'tap', target: 'chosen', spec: m[1] === 'creature' ? 'creature' : 'permanent' }); continue; }
    if ((m = low.match(/^untap target (creature|artifact|permanent|land)/))) { out.push({ op: 'untap', target: 'chosen', spec: m[1] === 'creature' ? 'creature' : 'permanent' }); continue; }
    if (/^untap all creatures you control/.test(low)) { out.push({ op: 'untapAll', filter: { kind: 'permanent', filter: { creature: true, controller: 'you' } } }); continue; }
    if (/untap (?:each|all) (?:other )?(?:creature|permanent)s? you control/.test(low)) { out.push({ op: 'untapAll', filter: { kind: 'permanent', filter: { controller: 'you' } } }); continue; }

    // --- sacrifice ---
    if ((m = low.match(/^(?:each player|each opponent) sacrifices?\s+((?:a|an|one|two|three|x|\d+))?\s*(creature|permanent|artifact|enchantment|land)/))) {
      out.push({ op: 'sacrifice', who: 'each', n: num(m[1] || 'a', opts), filter: m[2] === 'creature' ? { creature: true } : {} });
      continue;
    }
    if ((m = low.match(/^sacrifice\s+((?:a|an|one|two|three|x|\d+))?\s*(creature|permanent|artifact|enchantment|land)/))) {
      out.push({ op: 'sacrifice', n: num(m[1] || 'a', opts), filter: m[2] === 'creature' ? { creature: true } : {} });
      continue;
    }

    // --- counterspells ---
    if (/^counter target spell/.test(low)) {
      const unless = low.match(/unless (?:its controller|that player) pays/) ? 3 : null;
      out.push({ op: 'counterSpell', filter: {}, unlessPay: unless });
      continue;
    }
    if (/^counter target (creature|artifact|enchantment|activated ability|noncreature)/.test(low)) {
      out.push({ op: 'counterSpell', filter: {} });
      continue;
    }

    // --- library manipulation ---
    if ((m = low.match(/^scry (\d+|a|one|two|three|four)/))) {
      out.push({ op: 'scryLike', n: num(m[1], opts) }); continue;
    }
    if (/^look at the top .* card of your library/.test(low)) {
      out.push({ op: 'scryLike', n: 1 }); continue;
    }
    if (/^you may put that card on the bottom|put the rest (?:of those cards )?on the bottom/.test(low)) continue;

    // --- keywords / misc ---
    if (/take an extra turn/.test(low)) { out.push({ op: 'extraTurn' }); continue; }
    if (/you win the game/.test(low)) { out.push({ op: 'winGame' }); continue; }
    if (/you lose the game/.test(low)) { out.push({ op: 'loseGame' }); continue; }
    if (/^(?:~|this creature|this permanent) gets? \+/.test(low)) continue; // static, handled by keyword/static parsing
    if (/^prevent (?:all|the next)/.test(low)) { out.push({ op: 'preventDamage', target: 'chosen', spec: 'creature', n: 99 }); continue; }

    // Nothing matched — record it so coverage is honest.
    unparsed.push(sentence);
  }
  return { steps: out, unparsed };
}

/* ------------------------------------------------------------------ */
/* Trigger detection                                                   */
/* ------------------------------------------------------------------ */

export function parseTriggered(text) {
  const triggers = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^(when|whenever|at the beginning of)\s+(.*?),\s+(.*)$/i);
    if (!m) continue;
    const [, when, cond, effect] = m;
    const lc = cond.toLowerCase();
    let event = null, filter = null;

    if (/enters the battlefield|enters\b/.test(lc)) {
      event = 'etb';
      filter = { self: !/other|another/.test(lc) };
    } else if (/dies|is put into .*graveyard from the battlefield/.test(lc)) {
      event = /^~|this creature|this permanent/.test(lc) || /^(when|whenever) (this|~)/.test(m[0].toLowerCase()) ? 'dies' : 'permanentDies';
      event = /another creature|a creature|one or more creatures|other creatures/.test(lc) ? 'permanentDies' : 'dies';
    } else if (/attacks/.test(lc)) {
      event = /one or more creatures|a creature you control attacks|creatures you control attack/.test(lc) ? 'creatureAttacks' : 'attacks';
      if (/alone/.test(lc)) filter = { alone: true };
    } else if (/blocks|becomes blocked/.test(lc)) event = /becomes blocked/.test(lc) ? 'becomesBlocked' : 'blocks';
    else if (/combat damage to a player/.test(lc)) event = 'combatDamageToPlayer';
    else if (/deals? (?:combat )?damage to a creature/.test(lc)) event = 'damageToCreature';
    else if (/deals? (?:combat )?damage/.test(lc)) event = 'dealsDamage';
    else if (/at the beginning of your upkeep|beginning of (?:each|your) upkeep/.test(lc)) event = /each upkeep/.test(lc) ? 'eachUpkeep' : 'upkeep';
    else if (/beginning of (?:the )?end step|beginning of your end step/.test(lc)) event = 'endStep';
    else if (/you cast/.test(lc)) {
      event = 'spellCast';
      if (/creature spell/.test(lc)) filter = { type: 'Creature' };
      else if (/instant or sorcery|noncreature/.test(lc)) filter = { noncreature: true };
      else if (/historic/.test(lc)) filter = { historic: true };
    } else if (/a land enters the battlefield|a land you control enters/.test(lc)) event = 'landfall';
    else if (/you sacrifice|sacrifice a/.test(lc)) event = 'youSacrificed';
    else if (/you draw a card|you draw one or more/.test(lc)) event = 'youDraw';
    else if (/another creature you control leaves the battlefield|a permanent you control leaves/.test(lc)) event = 'leavesBattlefield';
    else if (/you gain life/.test(lc)) event = 'youGainLife';
    else if (/you lose life/.test(lc)) event = 'youLoseLife';
    else if (/is dealt damage/.test(lc)) event = 'selfDamaged';
    else if (/^the beginning of combat/.test(m[2].toLowerCase())) event = 'beginCombat';

    if (!event) continue;
    const parsed = parseClause(effect, {});
    triggers.push({ event, filter, condition: cond, steps: parsed.steps, unparsed: parsed.unparsed, raw: line });
  }
  return triggers;
}

/* ------------------------------------------------------------------ */
/* Activated ability detection                                         */
/* ------------------------------------------------------------------ */

export function parseActivated(text, card) {
  const abilities = [];
  const lines = text.split('\n');
  for (const line of lines) {
    // {T}: effect  /  {2}, {T}: effect  /  {T}, Sacrifice ~: effect
    const m = line.match(/^((?:\{[^}]+\}|\{[^}]+\}, )+[^:]*?):\s*(.*)$/);
    if (!m) continue;
    const [, costPart, effect] = m;
    if (/^(when|whenever|at the beginning of)/i.test(line)) continue;
    const costs = {};
    let mana = '';
    const syms = costPart.match(/\{[^}]+\}/g) || [];
    for (const sym of syms) {
      const s = sym[1].toUpperCase();
      if (s === 'T') costs.tap = true;
      else if (s === 'Q') costs.untap = true;
      else if (s === 'X') costs.x = true;
      else if (/^\d+$/.test(s)) { costs.generic = (costs.generic || 0) + parseInt(s, 10); mana += sym; }
      else if (['W', 'U', 'B', 'R', 'G', 'C'].includes(s)) { costs.colors = costs.colors || {}; costs.colors[s] = (costs.colors[s] || 0) + 1; mana += sym; }
    }
    if (/sacrifice ~|sacrifice this/i.test(costPart)) costs.sacrificeSelf = true;
    if (/sacrifice a creature/i.test(costPart)) costs.sacrificeCreature = true;
    if (/discard/i.test(costPart)) costs.discard = 1;
    if (/\{X\}/i.test(costPart)) costs.x = true;

    const parsed = parseClause(effect.replace(/~|this creature|this permanent/gi, card.name), {});
    const producesMana = /add \{|add one mana|add (white|blue|black|red|green)/i.test(effect);
    let manaColors = null;
    if (producesMana) {
      const syms2 = effect.match(/\{[WUBRGC]\}/gi);
      if (syms2) manaColors = syms2.map((s) => s[1].toUpperCase());
      else if (/one mana of any color|any color/i.test(effect)) manaColors = ['ANY'];
      else { const w = effect.match(/(white|blue|black|red|green)/i); if (w) manaColors = [COLORS[w[1].toLowerCase()]]; }
    }
    abilities.push({
      kind: 'activated', costs, manaCostString: mana, producesMana, manaColors,
      steps: parsed.steps, unparsed: parsed.unparsed, raw: line,
      timing: /equip/i.test(costPart) ? 'sorcery' : null,
    });
  }
  return abilities;
}

/* ------------------------------------------------------------------ */
/* Static ability detection                                            */
/* ------------------------------------------------------------------ */

export function parseStatic(text, card) {
  const statics = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (/^(when|whenever|at the beginning of)/i.test(line)) continue;
    if (/^((?:\{[^}]+\}[^:]*?)):/.test(line)) continue; // activated
    const lc = line.toLowerCase();

    // Anthems: "creatures you control get +1/+1" / "Other X you control get +1/+1"
    let m = lc.match(/^(?:other |each other |all )?(creatures?|[a-z]+ creatures?|tokens?|squirrels?|goblins?|cats?|ninjas?|humans?|spirits?)\s+you control\s+(?:get|gets|have|has)\s+\+(\d+)\/\+(\d+)/);
    if (m) {
      const sub = m[1] === 'creatures' || m[1] === 'creature' ? null : m[1].replace(/s$/, '').replace(/^(\w)/, (c) => c.toUpperCase());
      statics.push({ kind: 'ptBonus', appliesTo: { creature: true, controller: 'you', subtype: sub, other: /^other/.test(lc) }, power: +m[2], toughness: +m[3] });
      continue;
    }
    // Colour-specific anthems: "White creatures you control get +1/+1"
    m = lc.match(/^(white|blue|black|red|green) creatures you control get \+(\d+)\/\+(\d+)/);
    if (m) {
      statics.push({ kind: 'ptBonus', appliesTo: { creature: true, controller: 'you', color: m[1] }, power: +m[2], toughness: +m[3] });
      continue;
    }
    // Keyword grants: "Other Goblins you control have haste" / "creatures you control have vigilance"
    m = lc.match(/^(?:other |each other )?(creatures?|[a-z]+ creatures?|squirrels?|goblins?|cats?|ninjas?|humans?|spirits?|artifacts?|equipment) you control (?:have|has|gets? and (?:have|has)) ([a-z, ]+)/);
    if (m && /(flying|trample|haste|vigilance|deathtouch|lifelink|first strike|double strike|menace|reach|hexproof|indestructible|ward|flash|protection|prowess|intimidate|fear|shroud|defender|infect|wither|undying|persist)/.test(m[2])) {
      const kws = m[2].split(/,| and /).map((s) => s.trim()).filter((s) => s.length > 2 && !/^(gets?|have|has|also)/.test(s));
      const keys = kws.map(titleCaseKeyword).filter(Boolean);
      const sub = /s$/.test(m[1]) && !/^creatures?$/.test(m[1]) ? titleCase(m[1].replace(/s$/, '')) : null;
      if (keys.length) statics.push({ kind: 'keywordGrant', appliesTo: { creature: !/^(artifacts?|equipment)$/.test(m[1]), controller: 'you', subtype: sub }, keywords: keys });
      continue;
    }
    // "X can't block" / "can't be blocked"
    if (/can'?t be blocked/.test(lc)) { statics.push({ kind: 'unblockable', appliesTo: { self: true } }); continue; }
    if (/can'?t attack or block|can'?t block/.test(lc)) { statics.push({ kind: 'cannotBlock', appliesTo: { self: true } }); continue; }
    // Cost reducers
    m = lc.match(/(creature|artifact|instant|sorcery|[a-z]+) spells? you cast cost \{(\d+)\} less/);
    if (m) { statics.push({ kind: 'costReducer', cardType: m[1], amount: +m[2] }); continue; }
    // Mana doublers / land effects handled by scripts where important
    if (/lands? you control.{0,20}(produce|add).{0,20}(an additional|additional)/.test(lc)) { statics.push({ kind: 'manaDoubler', appliesTo: { land: true, controller: 'you' } }); continue; }
    // Protection / hexproof for self
    if (/^(~|this creature|this permanent) (?:has|have) (hexproof|indestructible|shroud)/.test(lc)) {
      statics.push({ kind: 'keywordGrant', appliesTo: { self: true }, keywords: [titleCaseKeyword(lc.match(/(hexproof|indestructible|shroud)/)[1])] });
      continue;
    }
  }
  return statics;
}

const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
function titleCaseKeyword(word) {
  const map = {
    flying: 'Flying', trample: 'Trample', haste: 'Haste', vigilance: 'Vigilance',
    deathtouch: 'Deathtouch', lifelink: 'Lifelink', 'first strike': 'First strike',
    'double strike': 'Double strike', menace: 'Menace', reach: 'Reach', hexproof: 'Hexproof',
    indestructible: 'Indestructible', flash: 'Flash', prowess: 'Prowess', ward: 'Ward',
    shroud: 'Shroud', defender: 'Defender', infect: 'Infect', wither: 'Wither',
    undying: 'Undying', persist: 'Persist', 'second strike': 'First strike',
  };
  const key = word.trim().toLowerCase();
  if (map[key]) return map[key];
  for (const k of Object.keys(map)) if (key.includes(k)) return map[k];
  return null;
}

/** Best-effort recognition of which keywords Scryfall didn't tag but text implies. */
export function inferKeywords(card) {
  const text = card.oracle_text || '';
  // Accept an array, a Set, or junk (a Set that has been through JSON without
  // the packer arrives as {}). Never throw here — a crash on resume is far
  // worse than simply not inferring a keyword.
  const raw = card.keywords;
  const kws = new Set(raw && typeof raw[Symbol.iterator] === 'function' ? [...raw] : []);
  if (/^flying/i.test(text)) kws.add('Flying');
  if (/\btrample\b/i.test(text)) kws.add('Trample');
  if (/\bhaste\b/i.test(text)) kws.add('Haste');
  if (/\bvigilance\b/i.test(text)) kws.add('Vigilance');
  if (/\bdeathtouch\b/i.test(text)) kws.add('Deathtouch');
  if (/\blifelink\b/i.test(text)) kws.add('Lifelink');
  if (/first strike/i.test(text)) kws.add('First strike');
  if (/double strike/i.test(text)) kws.add('Double strike');
  if (/\bmenace\b/i.test(text)) kws.add('Menace');
  if (/\breach\b/i.test(text)) kws.add('Reach');
  if (/\bdefender\b/i.test(text)) kws.add('Defender');
  if (/\bflash\b/i.test(text)) kws.add('Flash');
  return [...kws];
}

export { BASIC_OF, COLORS };
