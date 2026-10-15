/**
 * Effect primitives + the effect executor.
 *
 * Every card script — hand-written in scripts.js or auto-compiled from oracle
 * text in compiler.js — compiles down to a list of steps that this module
 * executes against game state. Keeping effects as data (not closures) means a
 * scripted card is inspectable, testable, and reportable in the coverage tool.
 *
 * Targeting (CR 601.2c / 115) is expressed declaratively with `targetSpec`, so
 * the engine can validate legality, ask the human to pick, or let the bot pick.
 */
import {
  isCreature, isLand, isPermanent, isArtifact, isEnchantment, isPlaneswalker,
  characteristics, hasKeyword, makeTokenInstance, isBasicLand, countersPower,
} from './cards.js';

/* ------------------------------------------------------------------ */
/* Target specifications                                               */
/* ------------------------------------------------------------------ */

export const SPECS = {
  anyTarget: { kind: 'permanent-or-player', filter: {} },
  creature: { kind: 'permanent', filter: { creature: true } },
  creatureYouControl: { kind: 'permanent', filter: { creature: true, controller: 'you' } },
  creatureOpponentControls: { kind: 'permanent', filter: { creature: true, controller: 'opp' } },
  creatureOrPlaneswalker: { kind: 'permanent', filter: { creatureOrPlaneswalker: true } },
  artifactOrEnchantment: { kind: 'permanent', filter: { artifactOrEnchantment: true } },
  nonlandPermanent: { kind: 'permanent', filter: { nonland: true } },
  permanent: { kind: 'permanent', filter: {} },
  land: { kind: 'permanent', filter: { land: true } },
  player: { kind: 'player', filter: {} },
  opponent: { kind: 'player', filter: { notController: true } },
  spell: { kind: 'spell', filter: {} },
  creatureYouControlOther: { kind: 'permanent', filter: { creature: true, controller: 'you', other: true } },
};

export function specMatches(g, ctx, spec, entity) {
  const filt = spec.filter || {};
  const isPlayer = typeof entity === 'number';
  if (spec.kind === 'player' && !isPlayer) return false;
  if (spec.kind !== 'player' && isPlayer) return false;
  if (isPlayer) {
    const me = ctx?.controller ?? ctx?.source?.controller;
    if (filt.notController && entity === me) return false;
    if (filt.controller === 'opp' && entity === me) return false;
    return true;
  }
  // entity is a permanent
  const p = entity;
  if (!p || p.zone !== 'battlefield') return false;
  if (filt.other && ctx?.source && p.iid === ctx.source.iid) return false;
  const ch = characteristics(g, p);
  if (filt.creature && !ch.isCreature) return false;
  if (filt.nonland && isLand(p)) return false;
  if (filt.land && !isLand(p)) return false;
  if (filt.artifactOrEnchantment && !(isArtifact(p) || isEnchantment(p))) return false;
  if (filt.creatureOrPlaneswalker && !(ch.isCreature || isPlaneswalker(p))) return false;
  if (filt.artifact && !isArtifact(p)) return false;
  if (filt.enchantment && !isEnchantment(p)) return false;
  if (filt.planeswalker && !isPlaneswalker(p)) return false;
  if (filt.legendary && !p.supertypes.includes('Legendary')) return false;
  if (filt.token && !p.isToken) return false;
  if (filt.type && !p.types.includes(filt.type)) return false;
  if (filt.subtype && !p.subtypes.includes(filt.subtype)) return false;
  if (filt.manaValueMax !== undefined && p.cmc > filt.manaValueMax) return false;
  if (filt.powerMax !== undefined && ch.power > filt.powerMax) return false;
  if (filt.powerMin !== undefined && ch.power < filt.powerMin) return false;
  if (filt.toughnessMax !== undefined && ch.toughness > filt.toughnessMax) return false;
  if (filt.controller === 'you' && p.controller !== ctx.controller) return false;
  if (filt.controller === 'opp' && p.controller === ctx.controller) return false;
  if (filt.name && p.name !== filt.name) return false;
  if (filt.anyOf) return filt.anyOf.some((s) => specMatches(g, ctx, { kind: spec.kind, filter: s }, entity));
  if (filt.predicate && !filt.predicate(g, p, ctx)) return false;
  // protection (CR 702.16)
  if (p.protection && p.protection.size) {
    const src = ctx.source;
    if (src) {
      const srcColors = new Set(src.card.colors || []);
      for (const prot of p.protection) {
        if (prot === 'everything') return false;
        if (!['W', 'U', 'B', 'R', 'G'].includes(prot)) continue;
        if (srcColors.has(prot)) return false;
      }
    }
  }
  return true;
}

export function legalTargets(g, ctx, spec) {
  const out = [];
  if (spec.kind === 'permanent' || spec.kind === 'permanent-or-player') {
    out.push(...g.battlefield.filter((p) => specMatches(g, ctx, spec, p)).map((p) => p.iid));
  }
  if (spec.kind === 'player' || spec.kind === 'permanent-or-player') {
    out.push(...g.players.map((pl) => pl.id).filter((id) => specMatches(g, ctx, spec, id)));
  }
  if (spec.kind === 'spell') {
    out.push(...g.stack.filter((s) => s.kind === 'spell' && specMatches(g, ctx, spec, s)).map((s) => s.iid));
  }
  if (spec.kind === 'card' && spec.zone) {
    out.push(...(g.players[ctx.controller].zones[spec.zone] || []).map((c) => c.iid));
  }
  // "up to one" / optional targets
  if (spec.upTo && out.length) out.push(null);
  return out;
}

/* ------------------------------------------------------------------ */
/* Effect steps                                                        */
/* ------------------------------------------------------------------ */

const z = (g, p) => g.players[p].zones;

export function findPermanent(g, iid) {
  return g.battlefield.find((p) => p.iid === iid);
}
export function findCard(g, iid) {
  const perm = findPermanent(g, iid);
  if (perm) return perm;
  for (const p of g.players) {
    for (const key of ['hand', 'library', 'graveyard', 'exile', 'command']) {
      const found = (p.zones[key] || []).find((c) => c.iid === iid);
      if (found) return found;
    }
  }
  return null;
}

export function tokenDef(name, typeLine, power, toughness, extra = {}) {
  return { name, type_line: typeLine, power, toughness, colors: extra.colors || [], keywords: extra.keywords || [], oracle_text: extra.oracle_text || '' };
}

const TREASURE = () => tokenDef('Treasure', 'Token Artifact — Treasure', null, null, {
  oracle_text: '{T}, Sacrifice this token: Add one mana of any color.',
});

/* ------------------------------------------------------------------ */
/* Core primitives — each mutates game state and emits events          */
/* ------------------------------------------------------------------ */

export function draw(g, playerId, n, ctx = {}) {
  const pl = g.players[playerId];
  for (let i = 0; i < n; i++) {
    if (!pl.zones.library.length) { g.lose(playerId, 'drew from an empty library', { cause: 'library' }); return; }
    const card = pl.zones.library.shift();
    card.zone = 'hand';
    pl.zones.hand.push(card);
    g.emit({ type: 'draw', player: playerId, card: card.iid, amount: 1, ctx });
  }
}

export function mill(g, playerId, n, ctx = {}) {
  const pl = g.players[playerId];
  for (let i = 0; i < n && pl.zones.library.length; i++) {
    const card = pl.zones.library.shift();
    card.zone = 'graveyard';
    pl.zones.graveyard.push(card);
  }
  if (!pl.zones.library.length) g.lose(playerId, 'library empty', { cause: 'library' });
}

export function gainLife(g, playerId, n, ctx = {}) {
  const pl = g.players[playerId];
  pl.life += n;
  g.emit({ type: 'lifechange', player: playerId, amount: n, gain: true, ctx });
}

export function loseLife(g, playerId, n, ctx = {}) {
  const pl = g.players[playerId];
  pl.life -= n;
  g.emit({ type: 'lifechange', player: playerId, amount: -n, gain: false, ctx });
}

export function damage(g, targetRef, n, ctx = {}) {
  if (targetRef === null || targetRef === undefined) return;
  const source = ctx.source || null;
  if (n > 0 && source && !ctx.noModifiers) {
    let multiplier = 1, addend = 0;
    for (const mod of (g._staticMods || [])) {
      if (mod.source?.controller !== source.controller) continue;
      if (mod.kind === 'damageMultiplier') multiplier *= mod.amount;
      if (mod.kind === 'damageAddend' && mod.source.iid !== targetRef) addend += mod.amount;
    }
    n = n * multiplier + addend;
  }
  const srcName = source ? source.name : (ctx.sourceName || 'effect');
  if (typeof targetRef === 'number') {
    const pl = g.players[targetRef];
    if (!pl || pl.lost) return;
    // damage to a player from a source with lifelink gains life
    loseLife(g, targetRef, n, ctx);
    g.emit({ type: 'damage', target: targetRef, amount: n, source: source?.iid, isPlayer: true, srcName, ctx });
    if (source && isCreature(source) && hasKeyword(g, source, 'Lifelink')) gainLife(g, source.controller, n, ctx);
    g.checkStateBased();
    return;
  }
  const perm = typeof targetRef === 'object' ? targetRef : findPermanent(g, targetRef);
  if (!perm || perm.zone !== 'battlefield') return;
  if (isPlaneswalker(perm)) {
    const remaining = dealToPlaneswalker(g, perm, n, ctx);
    if (source && isCreature(source) && hasKeyword(g, source, 'Lifelink')) gainLife(g, source.controller, n, ctx);
    return remaining;
  }
  const deathtouch = source && isCreature(source) && hasKeyword(g, source, 'Deathtouch');
  const infect = source && hasKeyword(g, source, 'Infect');
  if (perm.damagePrevention?.length) {
    const prevent = perm.damagePrevention.reduce((a, b) => a + (b.amount < 0 ? n : Math.min(b.amount, n)), 0);
    n = Math.max(0, n - prevent);
    if (!n) return 0;
  }
  perm.damage += n;
  perm.dealtDamageThisTurn = (perm.dealtDamageThisTurn || 0) + n;
  if (deathtouch && isCreature(perm) && n > 0) perm._deathtouchDamage = true;
  g.emit({ type: 'damage', target: perm.iid, amount: n, source: source?.iid, srcName, ctx });
  if (source && isCreature(source) && hasKeyword(g, source, 'Lifelink')) gainLife(g, source.controller, n, ctx);
  if (source && isCreature(source) && hasKeyword(g, source, 'Infect')) {
    // infect: -1/-1 counters instead of damage
    perm.damage -= n;
    addCounters(g, perm, '-1/-1', n, ctx);
  }
  g.checkStateBased();
  // "whenever this deals damage to a creature" style triggers are emitted here
  if (source && !ctx.combat) g.emit({ type: 'sourceDamageToCreature', source: source.iid, target: perm.iid, amount: n, ctx });
  return n;
}

function dealToPlaneswalker(g, pw, n, ctx) {
  pw.counters.loyalty = (pw.counters.loyalty || pw.loyalty || 0) - n;
  g.emit({ type: 'damage', target: pw.iid, amount: n, source: ctx.source?.iid, srcName: ctx.source?.name, ctx });
  g.checkStateBased();
}

export function addCounters(g, perm, type, n, ctx = {}) {
  if (!perm) return;
  perm.counters[type] = (perm.counters[type] || 0) + n;
  if (type === 'loyalty' && perm.loyalty !== null && perm.counters.loyalty === undefined) perm.counters.loyalty = n;
  g.emit({ type: 'counters', target: perm.iid, counterType: type, amount: n, ctx });
}

export function destroy(g, perm, ctx = {}) {
  if (!perm) return false;
  if (perm.indestructible || hasKeyword(g, perm, 'Indestructible')) {
    g.emit({ type: 'preventedDestroy', target: perm.iid, ctx });
    return false;
  }
  // regeneration shields
  if (perm.regenShields > 0) {
    perm.regenShields--;
    perm.tapped = true;
    perm.damage = 0;
    g.emit({ type: 'regenerated', target: perm.iid, ctx });
    return false;
  }
  moveToGraveyard(g, perm, ctx);
  return true;
}

export function moveToGraveyard(g, perm, ctx = {}) {
  const owner = g.players[perm.owner];
  const from = perm.zone;
  removeFromBattlefield(g, perm);
  if (perm.isCommander) {
    // CR 903.9: a commander may go to the command zone instead
    perm.zone = 'command';
    owner.zones.command.push(perm);
    g.emit({ type: 'zoneChange', card: perm.iid, from, to: 'command', ctx });
  } else {
    perm.zone = 'graveyard';
    owner.zones.graveyard.push(perm);
    g.emit({ type: 'dies', card: perm.iid, controller: perm.controller, ctx });
    g.emit({ type: 'zoneChange', card: perm.iid, from, to: 'graveyard', ctx });
  }
}

export function exile(g, perm, ctx = {}) {
  if (!perm) return;
  const owner = g.players[perm.owner];
  const from = perm.zone;
  if (perm.zone === 'battlefield') removeFromBattlefield(g, perm);
  perm.zone = 'exile';
  owner.zones.exile.push(perm);
  g.emit({ type: 'zoneChange', card: perm.iid, from, to: 'exile', ctx });
}

export function sacrifice(g, perm, ctx = {}) {
  const controller = perm.controller;
  g.emit({ type: 'sacrifice', card: perm.iid, controller, ctx });
  moveToGraveyard(g, perm, ctx);
  // "whenever you sacrifice a permanent" triggers
  g.emit({ type: 'youSacrificed', player: controller, card: perm.iid, ctx });
}

export function bounce(g, perm, ctx = {}) {
  const owner = g.players[perm.owner];
  removeFromBattlefield(g, perm);
  if (perm.isCommander) {
    // CR 903.9: a commander that would go to its owner's hand may go to the
    // command zone instead. The engine takes that option automatically (as it
    // already does on death) — a commander stranded in hand or in a library
    // would lose its designation, and with it the player's colour identity.
    perm.zone = 'command';
    owner.zones.command.push(perm);
    g.emit({ type: 'zoneChange', card: perm.iid, from: 'battlefield', to: 'command', ctx });
    return;
  }
  perm.zone = 'hand';
  owner.zones.hand.push(perm);
  g.emit({ type: 'zoneChange', card: perm.iid, from: 'battlefield', to: 'hand', ctx });
}

export function removeFromBattlefield(g, perm) {
  const idx = g.battlefield.indexOf(perm);
  if (idx >= 0) g.battlefield.splice(idx, 1);
  // detach anything attached
  for (const att of perm.attachments) { att.attachedTo = null; }
  perm.attachments = [];
  if (perm.attachedTo) {
    const host = perm.attachedTo;
    host.attachments = host.attachments.filter((a) => a.iid !== perm.iid);
    perm.attachedTo = null;
  }
  perm.tapped = false;
  perm.damage = 0;
  perm.counters = {};
  perm.summoningSick = true;
  perm.tempPumps = [];
  perm.staticMods = [];
  perm.keywordGrants = [];
  perm.keywordLoss = [];
  perm.setBase = null; perm.setPT = null; perm.switchPT = false;
  perm.protection = new Set();
  perm.damagePrevention = [];
  perm.enteredThisTurn = false;
  perm.attackedThisTurn = false;
  g.recomputeStatics();
}

export function putPermanent(g, card, playerId, { tapped = false, asToken = false, targets = [] } = {}) {
  const inst = asToken
    ? makeTokenInstance(card, { owner: playerId, controller: playerId, iid: g.nextIid() })
    : card;
  inst.controller = playerId;
  inst.owner = inst.owner ?? playerId;
  inst.zone = 'battlefield';
  if (!asToken) {
    const script = g.scriptFor ? g.scriptFor(inst) : null;
    const entersTapped = script?.entersTapped;
    if (typeof entersTapped === 'function' ? entersTapped(g, inst) : entersTapped) tapped = true;
  }
  inst.tapped = tapped;
  inst.enteredThisTurn = true;
  inst.summoningSick = !(inst.keywords.has('Haste'));
  g.battlefield.push(inst);
  g.recomputeStatics();
  g.emit({ type: 'etb', card: inst.iid, controller: playerId, isToken: inst.isToken });
  if (!asToken && g.runEnterAbility) g.runEnterAbility(inst, playerId, targets);
  g.checkStateBased();
  return inst;
}

export function createTokens(g, playerId, def, n, ctx = {}) {
  // Token-doubling replacement effects (Parallel Lives, Anointed Procession, Doubling Season)
  let count = n;
  for (const mod of (g._staticMods || [])) {
    if (mod.kind === 'tokenDoubler' && mod.source?.controller === playerId) count *= 2;
  }
  // Chatterfang: any token you'd create becomes a Squirrel, plus that many extra Squirrels
  const squirrel = (g._staticMods || []).find((m) => m.kind === 'tokenModifier' && m.modifier === 'squirrel' && m.source?.controller === playerId);
  if (squirrel && !(def.subtypes || []).includes('Squirrel') && (def.type_line || '').includes('Creature')) {
    const extra = count;
    const squirrelDef = tokenDef('Squirrel token', 'Token Creature — Squirrel', 1, 1, { colors: ['G'] });
    const made = [];
    for (let i = 0; i < count; i++) made.push(putPermanent(g, squirrelDef, playerId, { asToken: true }));
    for (let i = 0; i < extra; i++) made.push(putPermanent(g, squirrelDef, playerId, { asToken: true }));
    g.emit({ type: 'tokenReplacement', player: playerId, count: count + extra });
    return made;
  }
  const made = [];
  for (let i = 0; i < count; i++) {
    made.push(putPermanent(g, def, playerId, { asToken: true }));
  }
  return made;
}

export function addMana(g, playerId, color, n, ctx = {}) {
  const pl = g.players[playerId];
  for (let i = 0; i < n; i++) pl.manaPool.push(color === 'any' ? 'C' : color);
  g.emit({ type: 'manaAdded', player: playerId, color, amount: n, ctx });
}

export function untap(g, perm) {
  if (!perm) return;
  perm.tapped = false;
  g.emit({ type: 'untapped', card: perm.iid });
}

export function tapPermanent(g, perm) {
  perm.tapped = true;
  g.emit({ type: 'tapped', card: perm.iid });
}

export function pump(g, perm, power, toughness, ctx = {}, duration = 'eot') {
  if (!perm) return;
  perm.tempPumps.push({ power, toughness, untilEndOfTurn: duration === 'eot', source: ctx.source?.iid || null, expired: false });
  g.emit({ type: 'pumped', target: perm.iid, power, toughness });
}

export function grantKeyword(g, perm, keywords, ctx = {}, duration = 'eot') {
  if (!perm) return;
  perm.keywordGrants.push({ keywords, source: ctx.source?.iid || null, untilEndOfTurn: duration === 'eot', expired: false });
  g.emit({ type: 'keywordGranted', target: perm.iid, keywords });
}

export function searchLibrary(g, playerId, spec, { destination = 'hand', tapped = false, shuffle = true, count = 1 } = {}, ctx = {}) {
  const pl = g.players[playerId];
  const found = [];
  for (let i = 0; i < count; i++) {
    const idx = pl.zones.library.findIndex((c) => spec(c));
    if (idx < 0) break;
    const [card] = pl.zones.library.splice(idx, 1);
    found.push(card);
    if (destination === 'battlefield') {
      putPermanent(g, card, playerId, { tapped });
    } else {
      card.zone = destination;
      pl.zones[destination].push(card);
    }
  }
  if (shuffle) shuffleLibrary(g, playerId);
  if (found.length) g.emit({ type: 'searched', player: playerId, cards: found.map((c) => c.iid), ctx });
  return found;
}

export function shuffleLibrary(g, playerId) {
  g.players[playerId].zones.library = g.rng.shuffle(g.players[playerId].zones.library);
}

export function discard(g, playerId, n, ctx = {}, chooser = null) {
  const pl = g.players[playerId];
  const chosen = [];
  for (let i = 0; i < n && pl.zones.hand.length; i++) {
    let card;
    if (chooser) card = chooser(pl.zones.hand, g, playerId);
    else card = pl.zones.hand[pl.zones.hand.length - 1]; // deterministic: last drawn
    const idx = pl.zones.hand.indexOf(card);
    if (idx < 0) break;
    pl.zones.hand.splice(idx, 1);
    card.zone = 'graveyard';
    pl.zones.graveyard.push(card);
    chosen.push(card);
    g.emit({ type: 'discard', player: playerId, card: card.iid, ctx });
  }
  return chosen;
}

export function returnFromGraveyard(g, playerId, spec, destination = 'battlefield', ctx = {}) {
  const pl = g.players[playerId];
  const idx = pl.zones.graveyard.findIndex(spec);
  if (idx < 0) return null;
  const [card] = pl.zones.graveyard.splice(idx, 1);
  if (destination === 'battlefield') return putPermanent(g, card, playerId, {});
  card.zone = destination;
  pl.zones[destination].push(card);
  return card;
}

/* ------------------------------------------------------------------ */
/* Executor                                                            */
/* ------------------------------------------------------------------ */

/**
 * Run a list of effect steps. `ctx` carries source/controller/targets/x.
 * Unknown ops are logged as unsupported rather than crashing the game.
 */
export function runEffects(g, ctx, steps) {
  if (!steps) return;
  const list = Array.isArray(steps) ? steps : [steps];
  for (const step of list) {
    if (!step) continue;
    if (typeof step === 'function') { step(g, ctx); continue; }
    runStep(g, ctx, step);
  }
}

function targetsOf(g, ctx, step) {
  if (step.target === undefined) return ctx.targets || [];
  if (step.target === 'self') return [ctx.source];
  if (step.target === 'chosen') return ctx.targets || [];
  if (step.target === 'source') return [ctx.source];
  if (step.target === 'controller') return [ctx.controller];
  if (step.target === 'eachOpponent') return g.players.filter((p) => p.id !== ctx.controller).map((p) => p.id);
  if (step.target === 'eachPlayer') return g.players.map((p) => p.id);
  if (typeof step.target === 'string') {
    const spec = SPECS[step.target];
    if (spec) return (ctx.targets || []).length ? ctx.targets : [];
    return [];
  }
  return [];
}

function allMatching(g, filterSpec, ctx) {
  if (!filterSpec) return [];
  if (typeof filterSpec === 'function') return g.battlefield.filter((p) => filterSpec(p, ctx));
  const spec = typeof filterSpec === 'string' ? { kind: 'permanent', filter: SPECS[filterSpec]?.filter || {} } : filterSpec;
  return g.battlefield.filter((p) => specMatches(g, ctx, spec, p));
}

function resolveNumber(v, ctx) {
  return v === 'X' ? (ctx.x || 0) : v;
}

function runStep(g, ctx, step) {
  const me = ctx.controller;
  if (step.n === 'X') step = { ...step, n: ctx.x || 0 };
  switch (step.op) {
    case 'noop': return;
    case 'draw': draw(g, step.who === 'opponent' ? otherPlayer(g, me) : step.who === 'each' ? me : (step.player ?? me), step.n || 1, ctx); return;
    case 'drawEach': for (const pl of g.players) draw(g, pl.id, step.n || 1, ctx); return;
    case 'damage': {
      const targets = targetsOf(g, ctx, step);
      for (const t of (targets.length ? targets : step.targets || [])) damage(g, t, step.n || 0, ctx);
      if (step.eachOpponent) for (const pl of g.players) if (pl.id !== me) damage(g, pl.id, step.n || 0, ctx);
      return;
    }
    case 'damageAll': {
      const perms = allMatching(g, step.filter, ctx).filter((p) => !step.excludeController || p.controller !== me);
      for (const p of perms) damage(g, p, step.n || 0, ctx);
      if (step.players) for (const pl of g.players) if (!step.excludeController || pl.id !== me) damage(g, pl.id, step.n || 0, ctx);
      return;
    }
    case 'destroy': for (const t of targetsOf(g, ctx, step)) destroy(g, findPermanent(g, t?.iid ?? t), ctx); return;
    case 'destroyAll': for (const p of allMatching(g, step.filter, ctx)) destroy(g, p, ctx); return;
    case 'exile': for (const t of targetsOf(g, ctx, step)) exile(g, findPermanent(g, t?.iid ?? t), ctx); return;
    case 'exileAll': for (const p of allMatching(g, step.filter, ctx)) exile(g, p, ctx); return;
    case 'sacrifice': {
      const who = step.who === 'each' ? null : (step.player ?? me);
      if (who === null) { for (const pl of g.players) sacrificeAll(g, pl.id, step.filter, step.n || 1, ctx); return; }
      sacrificeAll(g, who, step.filter, step.n || 1, ctx);
      return;
    }
    case 'sacrificeSelf': sacrifice(g, ctx.source, ctx); return;
    case 'bounce': for (const t of targetsOf(g, ctx, step)) bounce(g, findPermanent(g, t?.iid ?? t), ctx); return;
    case 'bounceAll': for (const p of allMatching(g, step.filter, ctx)) bounce(g, p, ctx); return;
    case 'gainLife': gainLife(g, step.who === 'opponent' ? otherPlayer(g, me) : me, step.n || 0, ctx); return;
    case 'loseLife': loseLife(g, step.who === 'opponent' ? otherPlayer(g, me) : me, step.n || 0, ctx); return;
    case 'counter': for (const t of targetsOf(g, ctx, step)) addCounters(g, findPermanent(g, t?.iid ?? t), step.counterType || '+1/+1', step.n || 1, ctx); return;
    case 'counterAll': for (const p of allMatching(g, step.filter, ctx)) addCounters(g, p, step.counterType || '+1/+1', step.n || 1, ctx); return;
    case 'token': {
      const defs = Array.isArray(step.token) ? step.token : [step.token];
      for (const d of defs) createTokens(g, step.who === 'opponent' ? otherPlayer(g, me) : me, d, step.n || 1, ctx);
      return;
    }
    case 'pump': for (const t of targetsOf(g, ctx, step)) pump(g, findPermanent(g, t?.iid ?? t), step.power || 0, step.toughness || 0, ctx, step.duration || 'eot'); return;
    case 'pumpAll': for (const p of allMatching(g, step.filter, ctx)) pump(g, p, step.power || 0, step.toughness || 0, ctx, step.duration || 'eot'); return;
    case 'grantAll': for (const p of allMatching(g, step.filter, ctx)) grantKeyword(g, p, step.keywords || [], ctx, step.duration || 'eot'); return;
    case 'tokenCopyAll': {
      const tokens = allMatching(g, step.filter || { kind: 'permanent', filter: { token: true, controller: 'you' } }, ctx);
      for (const t of tokens) createTokens(g, me, { name: t.name, type_line: t.card.type_line, power: t.basePower, toughness: t.baseToughness, colors: t.card.colors, keywords: [...t.keywords] }, 1, ctx);
      return;
    }
    case 'grant': for (const t of targetsOf(g, ctx, step)) grantKeyword(g, findPermanent(g, t?.iid ?? t), step.keywords || [], ctx, step.duration || 'eot'); return;
    case 'mill': mill(g, step.who === 'opponent' ? otherPlayer(g, me) : me, step.n || 1, ctx); return;
    case 'millEach': for (const pl of g.players) mill(g, pl.id, step.n || 1, ctx); return;
    case 'discard': discardTarget(g, ctx, step); return;
    case 'discardEach': for (const pl of g.players) discard(g, pl.id, step.n || 1, ctx); return;
    case 'addMana': addMana(g, me, step.color || 'C', step.n || 1, ctx); return;
    case 'untap': for (const t of targetsOf(g, ctx, step)) untap(g, findPermanent(g, t?.iid ?? t)); return;
    case 'untapAll': for (const p of allMatching(g, step.filter, ctx)) untap(g, p); return;
    case 'tap': for (const t of targetsOf(g, ctx, step)) tapPermanent(g, findPermanent(g, t?.iid ?? t)); return;
    case 'search': searchLibrary(g, me, buildSearchPredicate(step), step, ctx); return;
    case 'searchBasics': {
      for (let i = 0; i < (step.n || 1); i++) {
        searchLibrary(g, me, (c) => isBasicLand(c) && (step.type ? c.subtypes.includes(step.type) : true), { destination: step.destination || 'battlefield', tapped: step.tapped ?? true }, ctx);
      }
      return;
    }
    case 'shuffle': shuffleLibrary(g, me); return;
    case 'reanimate': {
      const card = returnFromGraveyard(g, step.who === 'opponent' ? otherPlayer(g, me) : me, (c) => specMatches(g, ctx, { kind: 'permanent', filter: step.filter || { creature: true } }, c), 'battlefield', ctx);
      if (card) g.emit({ type: 'reanimated', card: card.iid, ctx });
      return;
    }
    case 'regenerate': for (const t of targetsOf(g, ctx, step)) { const p = findPermanent(g, t?.iid ?? t); if (p) p.regenShields = (p.regenShields || 0) + 1; } return;
    case 'preventDamage': for (const t of targetsOf(g, ctx, step)) { const p = findPermanent(g, t?.iid ?? t); if (p) p.damagePrevention.push({ amount: step.n || 0, source: ctx.source?.iid, expired: false }); } return;
    case 'protection': for (const t of targetsOf(g, ctx, step)) { const p = findPermanent(g, t?.iid ?? t); if (p) step.protection?.forEach((x) => p.protection.add(x)); } return;
    case 'extraTurn': g.extraTurns.push(me); g.emit({ type: 'extraTurn', player: me, ctx }); return;
    case 'loseGame': g.lose(step.who === 'opponent' ? otherPlayer(g, me) : me, step.reason || 'effect', ctx); return;
    case 'winGame': g.win(step.who === 'opponent' ? otherPlayer(g, me) : me, step.reason || 'effect', ctx); return;
    case 'copyPermanent': copyPermanentStep(g, ctx, step); return;
    case 'counterSpell': {
      const spells = g.stack.filter((s) => s.kind === 'spell' && specMatches(g, ctx, { kind: 'spell', filter: step.filter || {} }, s));
      for (const s of spells) g.counterSpell(s, ctx);
      return;
    }
    case 'if': {
      const truthy = typeof step.condition === 'function' ? step.condition(g, ctx) : !!step.condition;
      runEffects(g, ctx, truthy ? step.then : step.otherwise);
      return;
    }
    case 'scryLike': {
      // Deterministic, low-friction library smoothing (Bot + human share this):
      // keep the best card on top, put the rest on the bottom.
      const pl = g.players[me];
      const look = pl.zones.library.slice(0, step.n || 1);
      if (look.length < 2) return;
      look.sort((a, b) => scoreCardForKeep(b, g) - scoreCardForKeep(a, g));
      pl.zones.library = [...look, ...pl.zones.library.slice(look.length)];
      return;
    }
    case 'lookTop': {
      const pl = g.players[me];
      const top = pl.zones.library.shift();
      if (!top) return;
      if (step.destination === 'battlefield') putPermanent(g, top, me, {});
      else if (step.destination === 'hand') { top.zone = 'hand'; pl.zones.hand.push(top); }
      else { top.zone = 'graveyard'; pl.zones.graveyard.push(top); }
      return;
    }
    case 'fireCombo': g.fireCombo(step.name, step.cards || [], ctx); return;
    default:
      g.unsupported.add(step.op);
      return;
  }
}

function otherPlayer(g, me) { return g.players.find((p) => p.id !== me)?.id ?? me; }

function sacrificeAll(g, playerId, filter, n, ctx) {
  const pl = g.players[playerId];
  const spec = typeof filter === 'function' ? filter : (p) => specMatches(g, { ...ctx, controller: playerId }, { kind: 'permanent', filter: filter || {} }, p);
  for (let i = 0; i < n; i++) {
    const candidates = g.battlefield.filter((p) => p.controller === playerId && spec(p));
    if (!candidates.length) return;
    // deterministic choice: weakest permanent
    candidates.sort((a, b) => permValue(g, a) - permValue(g, b));
    const pick = (playerId === g.humanId && g.requestChoice) ? (g.chooseFrom(candidates, 'sacrifice') || candidates[0]) : candidates[0];
    sacrifice(g, pick, ctx);
  }
}

export function permValue(g, p) {
  const ch = characteristics(g, p);
  let v = ch.isCreature ? ch.power + ch.toughness : 3;
  if (p.isCommander) v += 5;
  v += (p.counters['+1/+1'] || 0) * 2;
  v += p.attachments.length * 2;
  return v;
}

function discardTarget(g, ctx, step) {
  const who = step.who === 'opponent' ? otherPlayer(g, ctx.controller) : ctx.controller;
  const chooser = (hand, game, playerId) => {
    if (playerId === g.humanId && g.requestChoice) {
      const picked = g.chooseFrom(hand, 'discard');
      if (picked) return picked;
    }
    // deterministic bot choice: dump the least useful card
    return [...hand].sort((a, b) => scoreCardForKeep(a, g) - scoreCardForKeep(b, g))[0];
  };
  discard(g, who, step.n || 1, ctx, chooser);
}

function buildSearchPredicate(step) {
  const f = step.filter || {};
  return (c) => {
    if (f.basic) return isBasicLand(c);
    if (f.land) return isLand(c);
    if (f.creature) return c.types.includes('Creature');
    if (f.type) return c.types.includes(f.type);
    if (f.subtype) return c.subtypes.includes(f.subtype);
    if (f.name) return c.name.toLowerCase() === f.name.toLowerCase();
    if (f.manaValueMax !== undefined) return c.cmc <= f.manaValueMax;
    if (f.any) return true;
    return false;
  };
}

function copyPermanentStep(g, ctx, step) {
  const target = findPermanent(g, ctx.targets?.[0]?.iid ?? ctx.targets?.[0]);
  if (!target) return;
  const copy = { ...target, iid: g.nextIid(), isToken: true, isCopy: true, counters: { ...target.counters }, attachments: [], attachedTo: null, tempPumps: [], staticMods: [], keywordGrants: [], keywordLoss: [], protection: new Set(target.protection || []) };
  copy.controller = ctx.controller;
  copy.zone = 'battlefield';
  copy.enteredThisTurn = true;
  g.battlefield.push(copy);
  g.recomputeStatics();
  g.emit({ type: 'etb', card: copy.iid, controller: ctx.controller, isToken: true, isCopy: true });
  g.checkStateBased();
  return copy;
}

/** Heuristic used by the deterministic scry/discard helpers. */
export function scoreCardForKeep(card, g) {
  let v = 0;
  if (isLand(card)) v += 4;
  if (card.types.includes('Creature')) v += 3 + (card.cmc <= 4 ? 2 : 0);
  if (card.types.includes('Instant')) v += 3;
  if (card.types.includes('Sorcery')) v += 2;
  if (card.types.includes('Artifact') || card.types.includes('Enchantment')) v += 2;
  v += Math.min(card.cmc, 7);
  if (/destroy|exile|deals? \d+ damage|counter target/i.test(card.oracle_text || '')) v += 3;
  if (/draw (a|two|three|four|x) card/i.test(card.oracle_text || '')) v += 2;
  return v;
}

export { SPECS as TARGET_SPECS };
