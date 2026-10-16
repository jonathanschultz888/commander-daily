/**
 * Turning a card's script back into English.
 *
 * The engine already knows exactly what it will do with every card in the pool —
 * `scripts.js` holds the hand-written behaviour, `compiler.js` derives the rest
 * from the oracle text — but none of that was visible to a player who just watched
 * something surprising happen. This module reads a script and says, in the plainest
 * words it can manage, what the engine will do: which choices it will ask for, what
 * each ability and trigger does, which restrictions it applies, and — the point of
 * the whole exercise — what it is *not* going to do.
 *
 * It is deliberately honest. A gap is reported as a gap.
 */

const OP_WORDS = {
  draw: (s) => `Draw ${n(s.n)} card${s.n === 1 ? '' : 's'}${s.who === 'opponent' ? ' (opponent draws)' : ''}`,
  damage: (s) => `Deal ${n(s.n)} damage to ${targetWord(s)}`,
  damageAll: (s) => `Deal ${n(s.n)} damage to every ${describeFilter(s.filter)}`,
  gainLife: (s) => `Gain ${n(s.n)} life`,
  loseLife: (s) => `Lose ${n(s.n)} life`,
  drain: (s) => `Each opponent loses ${n(s.n)} life and you gain that much`,
  destroy: (s) => `Destroy ${targetWord(s)}`,
  destroyAll: (s) => `Destroy every ${describeFilter(s.filter)}`,
  exile: (s) => `Exile ${targetWord(s)}`,
  sacrifice: (s) => `Sacrifice ${n(s.n)} ${describeFilter(s.filter)}`,
  bounce: (s) => `Return ${targetWord(s)} to its owner's hand`,
  bounceAll: (s) => `Return every ${describeFilter(s.filter)} to hand`,
  pump: (s) => `${cap(targetWord(s))} gets ${sign(s.power)}/${sign(s.toughness)}${s.duration === 'permanent' ? '' : ' until end of turn'}`,
  pumpAll: (s) => `Every ${describeFilter(s.filter)} gets ${sign(s.power)}/${sign(s.toughness)}${s.duration === 'permanent' ? '' : ' until end of turn'}`,
  grantAll: (s) => `Every ${describeFilter(s.filter)} gains ${(s.keywords || []).map((k) => k.toLowerCase()).join(', ')} until end of turn`,
  setPT: (s) => `${cap(targetWord(s))} becomes ${s.power}/${s.toughness}`,
  scry: (s) => `Scry ${n(s.n)}`,
  surveil: (s) => `Surveil ${n(s.n)}`,
  gainControl: (s) => `You gain control of ${targetWord(s)}`,
  shuffleIntoLibrary: () => 'Shuffle it into its owner\'s library',
  returnFromGraveyard: () => 'Return it from your graveyard to your hand',
  noop: () => null,
  counter: (s) => `Put ${n(s.n)} ${s.counterType || '+1/+1'} counter${s.n === 1 ? '' : 's'} on ${targetWord(s)}${s.duration === 'eot' ? ' (until end of turn)' : ''}`,
  counterAll: (s) => `Put ${n(s.n)} ${s.counterType || '+1/+1'} counters on every ${describeFilter(s.filter)}`,
  animate: (s) => `${cap(targetWord(s))} becomes a ${s.power}/${s.toughness} ${(s.subtypes || []).join(' ') || 'creature'}${(s.keywords || []).length ? ` with ${s.keywords.join(', ').toLowerCase()}` : ''} until end of turn`,
  token: (s) => `Create ${n(s.n)} ${s.token?.name || 'token'}${(s.token?.power != null) ? ` (${s.token.power}/${s.token.toughness})` : ''}`,
  addMana: (s) => `Add ${'{{{c}}}'.replace('{c}', s.color)}${n(s.n) > 1 ? ` ×${n(s.n)}` : ''}`,
  addManaAny: () => 'Add one mana of any colour',
  grant: (s) => `${cap(targetWord(s))} gains ${(s.keywords || []).join(', ').toLowerCase()} until end of turn`,
  tap: (s) => `Tap ${targetWord(s)}`,
  untap: (s) => `Untap ${targetWord(s)}`,
  tapAll: (s) => `Tap every ${describeFilter(s.filter)}`,
  mill: (s) => `Put the top ${n(s.n)} cards of your library into your graveyard`,
  scryLike: (s) => `Look at the top ${n(s.n)} card${s.n === 1 ? '' : 's'} of your library and put them back`,
  searchBasicToField: (s) => 'Search your library for a basic land and put it onto the battlefield',
  searchBasics: (s) => `Search your library for ${n(s.n)} basic land${s.n === 1 ? '' : 's'} and put ${s.n === 1 ? 'it' : 'them'} onto the battlefield`,
  searchLibrary: (s) => 'Search your library for a card',
  reanimate: (s) => `Return ${describeFilter(s.filter)} from your graveyard to the battlefield`,
  counterSpell: (s) => 'Counter target spell',
  preventDamage: (s) => `Prevent the next ${n(s.n)} damage`,
  regenerate: (s) => `Regenerate ${targetWord(s)}`,
  fight: (s) => `${cap(targetWord(s))} fights`,
  discard: (s) => `Discard ${n(s.n)} card${s.n === 1 ? '' : 's'}`,
  shuffle: () => 'Shuffle your library',
  extraTurn: () => 'Take an extra turn',
  combatDamageSelf: () => 'Deal damage equal to its power',
};

const n = (v) => (v === 'x' || v === 'X' ? 'X' : Number.isFinite(Number(v)) ? Number(v) : (v ?? 1));
const sign = (v) => `${v >= 0 ? '+' : ''}${v}`;
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function targetWord(s) {
  if (s.target === 'self') return 'this card';
  if (s.target === 'chosen' || s.target == null) {
    const f = s.filter || s.spec || {};
    return `target ${describeFilter(typeof f === 'string' ? { kind: f } : f)}`;
  }
  return s.target;
}

function describeFilter(f) {
  f = f?.filter || f || {};
  const bits = [];
  if (f.creature) bits.push('creature');
  if (f.land) bits.push('land');
  if (f.artifact) bits.push('artifact');
  if (f.enchantment) bits.push('enchantment');
  if (f.nonland) bits.push('nonland permanent');
  if (f.artifactOrEnchantment) bits.push('artifact or enchantment');
  if (f.artifactOrCreature) bits.push('artifact or creature');
  if (!bits.length) bits.push('permanent');
  const who = f.controller === 'you' ? 'you control' : f.controller === 'opponent' ? 'an opponent controls' : '';
  return `${bits.join(' or ')}${who ? ` ${who}` : ''}`;
}

/** One step, in words. Unknown ops are named rather than skipped. */
export function stepWords(step) {
  if (!step) return null;
  if (typeof step === 'function') return 'Does something written by hand for this card.';
  if (typeof step === 'string') return step;
  const fn = OP_WORDS[step.op];
  if (fn) return fn(step);
  if (step.op === 'sequence' || step.op === 'steps') return (step.steps || []).map(stepWords).filter(Boolean).join('; ');
  // An op the dictionary above does not know is still described as best it can be —
  // but it is also reported as a gap, because "what the engine cannot read" is the
  // single most useful thing this screen can tell a player.
  return `${String(step.op).replace(/([A-Z])/g, ' $1').toLowerCase().replace(/_/g, ' ')}${step.n ? ` ×${step.n}` : ''}`;
}

const STATIC_WORDS = {
  ptBonus: 'A power/toughness bonus that is always on',
  keywordGrant: 'A keyword it grants continuously',
  costReduction: 'A cost reduction',
  damageBonus: 'Extra damage from your sources',
  cantAttack: 'A restriction: it cannot attack',
  cantBlock: 'A restriction: it cannot block',
  mustAttack: 'A requirement: it attacks every combat if able',
  cantBeBlocked: 'It cannot be blocked',
  cantBeCountered: 'Spells cannot be countered',
  tokenDoubler: 'It doubles the tokens you create',
  counterDoubler: 'It doubles the counters you place',
  protection: 'Protection from something',
  playFromGraveyard: 'It lets you play cards from a graveyard',
  extraLandDrop: 'It lets you play an extra land each turn',
  untapAll: 'It untaps your permanents each turn',
  lord: 'It pumps creatures of its kind',
};

const EVENT_WORDS = {
  permanentEntered: 'another permanent enters the battlefield',
  permanentDied: 'a permanent dies',
  counters: 'a counter is put on a permanent',
  damage: 'damage is dealt',
  selfDamaged: 'this is dealt damage',
  youSacrificed: 'you sacrifice a permanent',
  spellCast: 'a spell is cast',
  attack: 'this attacks',
  block: 'this blocks',
  upkeep: 'your upkeep begins',
  endStep: 'your end step begins',
  draw: 'you draw a card',
  tap: 'this becomes tapped',
  sourceDamageToCreature: 'this deals damage to a creature',
};

/**
 * What will the engine do with this card?
 *
 * `script` is what `cardScript()` returns: the merged hand-written script and
 * compiled steps, plus `unsupported` (clauses the compiler could not read) and
 * `oracle`. The result is data, not prose, so both the API and the UI can format it.
 */
export function explainCard(card, script, { status = 'unknown', targetSpec = null, legalNow = null } = {}) {
  const text = String(card?.oracle_text || '');
  const abilities = [];
  for (const ab of script?.abilities || []) {
    const what = (ab.steps || []).map(stepWords).filter(Boolean).join('; ') || ab.label || 'Activate';
    const cost = [];
    if (ab.costs?.tap) cost.push('{T}');
    if (ab.costs?.mana) {
      const m = ab.costs.mana;
      const coloured = m.colors ? Object.entries(m.colors).map(([c, k]) => `{${c}}`.repeat(k)).join('') : '';
      cost.push(`${m.generic ? `{${m.generic}}` : ''}${coloured}` || 'mana');
    }
    if (ab.costs?.sacrificeCreature) cost.push(ab.costs.sacrificeCreature === 'another' ? 'sacrifice another creature' : 'sacrifice a creature');
    if (ab.costs?.sacrificeSelf) cost.push('sacrifice this');
    if (ab.costs?.counters) cost.push(Object.entries(ab.costs.counters).map(([k, v]) => `remove ${v} ${k} counter`).join(', '));
    abilities.push({ cost: cost.join(', '), what, label: ab.label || null });
  }
  for (const tr of script?.triggers || []) {
    const what = (tr.steps || []).map(stepWords).filter(Boolean).join('; ');
    abilities.push({ when: EVENT_WORDS[tr.event] || tr.event, what });
  }
  const spell = (script?.steps || []).map(stepWords).filter(Boolean);

  const keywords = card?.keywords || script?.keywords || [];
  // Statics only ever apply from the battlefield, so a sorcery that says "creatures
  // you control get +3/+3" (Overrun) has no static at all — the compiler records the
  // pattern, the game never applies it, and listing it under "always on" would be a
  // lie told to the player by the very screen that exists to be honest.
  const permanentCard = /\b(Creature|Artifact|Enchantment|Planeswalker|Land|Battle)\b/.test(card?.type_line || '');
  const statics = permanentCard
    ? (script?.statics || []).map((s) => s.text || STATIC_WORDS[s.kind] || s.kind || 'a continuous effect')
    : [];
  const mana = (script?.mana || []).map((m) => `Add ${m.amount} mana${m.colors?.length ? ` (${m.colors.join('/')})` : ''}`);

  // anything the dictionary above could not put into words is a gap, too
  const unknown = [];
  const scan = (steps) => {
    for (const st of steps || []) {
      if (!st || typeof st !== 'object') continue;
      if (st.op && !OP_WORDS[st.op]) unknown.push(st.op);
      if (st.steps) scan(st.steps);
    }
  };
  scan(script?.steps);
  for (const ab of script?.abilities || []) scan(ab.steps);
  for (const tr of script?.triggers || []) scan(tr.steps);

  return {
    name: card?.name || '(unknown)',
    type_line: card?.type_line || '',
    mana_cost: card?.mana_cost || '',
    power: card?.power ?? null, toughness: card?.toughness ?? null,
    text,
    status,
    keywords,
    spell,
    abilities,
    statics,
    mana,
    gaps: [...new Set([...(script?.unsupported || []).map(String),
      ...unknown.map((u) => `the "${String(u).replace(/([A-Z])/g, ' $1').toLowerCase()}" step (named, not yet explained in words)`)])],
    asksFor: targetSpec ? `You choose ${describeSpecText(targetSpec)} when you play it.` : null,
    legalNow,
  };
}

export function describeSpecText(spec) {
  if (!spec) return 'something';
  if (spec.kind === 'spell') return spec.filter?.creature ? 'a creature spell' : spec.filter?.noncreature ? 'a noncreature spell' : 'a spell on the stack';
  if (spec.kind === 'player') return 'a player';
  if (spec.kind === 'anyTarget') return 'any target (a creature, a player, or a planeswalker)';
  const f = spec.filter || {};
  if (f.land && f.controller === 'you') return 'a land you control';
  if (f.land) return 'a land';
  if (f.creature && f.controller === 'you') return 'a creature you control';
  if (f.creature && f.controller === 'opponent') return 'a creature an opponent controls';
  if (f.creature) return 'a creature';
  if (f.artifact) return 'an artifact';
  if (f.enchantment) return 'an enchantment';
  if (f.nonland) return 'a nonland permanent';
  return 'a permanent';
}
