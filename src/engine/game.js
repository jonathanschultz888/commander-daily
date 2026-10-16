/**
 * The rules engine core.
 *
 * Turn structure (CR 500-514) with the steps this game needs, priority passing
 * (CR 117), the stack (CR 405), state-based actions (CR 704), combat (CR 506-511),
 * commander rules (CR 903) including tax, command-zone returns and 21 commander
 * damage, and mana payment with automatic land tapping.
 *
 * Interaction model: the engine runs forward until it needs a decision from the
 * human, then parks on `pending` and returns. The server persists that state, so
 * reloading resumes exactly where the run was (no re-rolling a bad opening).
 */
import {
  makeCardInstance, makeTokenInstance, isLand, isCreature, isPermanent, isInstant, isSorcery,
  characteristics, hasKeyword, isBasicLand, parsePt,
} from './cards.js';
import { makeRng, rngFromState } from './rng.js';
import { makeBot } from './bot.js';
import { cardScript, triggerSpecsFor, staticModsFor, grantedAbilitiesFor, COMBO_REGISTRY } from './scripts.js';
import { attachScoring, settlePoints } from './score.js';
import { targetRequirements, castTargetRequirements, chooseTarget } from './targeting.js';
import {
  runEffects, draw, damage, destroy, exile, sacrifice, putPermanent, createTokens, addMana,
  untap, tapPermanent, pump, grantKeyword, findPermanent, moveToGraveyard, shuffleLibrary,
  addCounters, loseLife, gainLife, permValue, SPECS, specMatches, legalTargets,
} from './ops.js';

export const STEPS = [
  { name: 'untap', active: true },
  { name: 'upkeep', priority: true },
  { name: 'draw', priority: true },
  { name: 'main1', priority: true, main: true },
  { name: 'beginCombat', priority: true },
  { name: 'declareAttackers', priority: true, combat: true },
  { name: 'declareBlockers', combat: true },
  { name: 'combatDamage', combat: true },
  { name: 'endOfCombat', priority: true },
  { name: 'main2', priority: true, main: true },
  { name: 'end', priority: true },
  { name: 'cleanup' },
];

export const HUMAN = 0;

/**
 * Rebuild a live game from a stored snapshot. Continuous-effect closures and
 * listeners are rebuilt rather than serialized, and the RNG resumes from its
 * counter, so a resumed run continues on exactly the same shuffle stream.
 */
/** Find the live instance of a card by iid across every zone (spells on the stack). */
function relinkCard(game, card) {
  if (!card || card.iid === undefined) return card;
  const zones = [game.battlefield, ...game.players.flatMap((p) => Object.values(p.zones))];
  for (const zone of zones) {
    const hit = zone.find((c) => c.iid === card.iid);
    if (hit) return hit;
  }
  return card;
}

/**
 * Rebuild a stack entry or pending trigger that was stored as identities:
 * resolve the source permanent by iid and pull the spec (with its functions)
 * out of the live card script at the same index. Targets become live permanents
 * again, so effects mutate the board instead of a stale duplicate.
 */
function rehydrateEntry(game, entry) {
  const src = entry.source
    || game.battlefield.find((p) => p.iid === entry.sourceIid)
    || game.players.flatMap((p) => Object.values(p.zones)).flat().find((c) => c.iid === entry.sourceIid)
    || null;
  const out = { ...entry, source: src };
  if (src && entry.specIndex !== null && entry.specIndex !== undefined) {
    const specs = entry.kind === 'trigger' ? triggerSpecsFor(src) : (cardScript(src)?.abilities || []);
    out.spec = specs[entry.specIndex] || entry.spec || null;
  }
  if (out.card) out.card = relinkCard(game, out.card);
  if (out.targets) {
    out.targets = out.targets.map((t) => {
      if (t === null || typeof t !== 'object') {
        const perm = typeof t !== 'undefined' ? findPermanent(game, t) : null;
        return perm || t;
      }
      return relinkCard(game, t);
    });
  }
  return out;
}

/** Can this permanent pay a `counters` cost, e.g. `{ counters: { charge: 1 } }`? */
function canPayCounters(perm, wanted) {
  return Object.entries(wanted).every(([type, n]) => (perm.counters?.[type] || 0) >= n);
}

/** Highest `t####` id in a state + 1, for games saved before the counter was stored. */
function deriveIidCounter(game) {
  const found = JSON.stringify(game).match(/"t(\d+)"/g) || [];
  return found.reduce((max, id) => Math.max(max, Number(id.slice(2, -1)) + 1), 1000);
}

/**
 * JSON cannot carry Set/Map, and a `Set` silently becomes `{}` — which used to
 * crash reviveGame() the moment a run was loaded from storage (i.e. after any
 * restart or redeploy) instead of from the live process. State is therefore
 * packed with tagged markers and unpacked on revive, so "resume after a
 * restart" and "resume in the same process" are the same code path.
 */
const PACK = '__cd';
const PACK_REPLACER = (k, v) => {
  if (typeof v === 'function') return undefined;
  if (v instanceof Set) return { [PACK]: 'Set', v: [...v] };
  if (v instanceof Map) return { [PACK]: 'Map', v: [...v] };
  return v;
};

/** Restore tagged values in place, leaving real Sets/Maps from a live game alone. */
function unpackDeep(v) {
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = unpackDeep(v[i]); return v; }
  if (v && typeof v === 'object') {
    if (v[PACK] === 'Set') return new Set(v.v);
    if (v[PACK] === 'Map') return new Map(v.v);
    for (const k of Object.keys(v)) v[k] = unpackDeep(v[k]);
  }
  return v;
}

/**
 * Snapshot a game into a JSON-safe plain object. Drops closures, keeps the RNG
 * counter (so shuffles continue instead of re-rolling), and trims the log and
 * animation feed so a long game stays small enough to store cheaply.
 */
export function packGame(game) {
  const asRef = (x) => (x && typeof x === 'object' && x.iid !== undefined ? x.iid : x);
  const state = {
    ...game,
    rngState: game.rng.state(),
    rng: undefined,
    _listeners: undefined,
    _staticMods: undefined,
    bot: undefined,
    chooseFrom: undefined,
    scriptFor: undefined,
    runEnterAbility: undefined,
    unsupported: [...(game.unsupported || [])],
    // Attachments are a two-way object graph (aura.attachedTo <-> host.attachments)
    // and each side holds the other, which JSON cannot express — and which used to
    // throw on save the moment anything was equipped or enchanted. The link is
    // stored as an id and rebuilt on revive, like the stack does.
    battlefield: game.battlefield.map((p) => ({
      ...p,
      attachedTo: null,
      attachedToIid: p.attachedTo ? p.attachedTo.iid : null,
      attachments: [],
      staticMods: [],
      _staticCache: null,
    })),
    events: (game.events || []).slice(-400).map((e) => ({
      type: e.type, card: e.card, controller: e.controller, player: e.player, target: e.target,
      amount: e.amount, name: e.name, cards: e.cards, turn: e.turn, source: e.source, label: e.label, points: e.points,
    })),
    logLines: (game.logLines || []).slice(-200),
    // The stack and the trigger queue hold live objects and closures, neither of
    // which survives JSON: a reference comes back as a stale duplicate and a
    // `check`/`effect`/handler function comes back missing (which is worse — the
    // effect silently does nothing). So they are stored as identities and
    // rebuilt from the card scripts on revive.
    stack: (game.stack || []).map((e) => ({
      kind: e.kind, iid: e.iid, controller: e.controller, x: e.x, isMana: e.isMana,
      mode: e.mode, zoneLeft: e.zoneLeft, isCommander: e.isCommander,
      card: e.card, sourceIid: asRef(e.source), specIndex: e.specIndex ?? null,
      targets: (e.targets || []).map(asRef),
    })),
    _pendingTriggers: (game._pendingTriggers || []).map((t) => ({
      sourceIid: asRef(t.source), specIndex: t.specIndex ?? null, event: t.event,
    })),
    // Combos are code, not state: keep only the bookkeeping.
    _comboRegistry: (game._comboRegistry || []).map((c) => ({ name: c.name, firedThisGame: !!c.firedThisGame })),
  };
  return JSON.parse(JSON.stringify(state, PACK_REPLACER));
}

export function reviveGame(state) {
  const game = { ...unpackDeep(typeof state === 'string' ? JSON.parse(state) : state) };
  Object.assign(game, gameMethods);
  game.stack = (state.stack || []).map((e) => rehydrateEntry(game, e));
  game.rng = rngFromState(state.rngState ?? state.rng);
  game._staticMods = [];
  game._listeners = [];
  game._pendingTriggers = (state._pendingTriggers || []).map((t) => {
    const src = t.source || game.battlefield.find((p) => p.iid === t.sourceIid) || null;
    const spec = t.spec || (src ? triggerSpecsFor(src)[t.specIndex] : null);
    return { source: src, sourceIid: t.sourceIid, spec, specIndex: t.specIndex, event: t.event };
  });
  game.unsupported = new Set(state.unsupported || []);
  game.scores = state.scores || game.players.map(() => ({ total: 0, lines: [] }));
  // Combos come from code (their `check` is a function and cannot be stored);
  // only "has this one fired yet" is state.
  const firedByName = new Map((state._comboRegistry || []).map((c) => [c.name, !!c.firedThisGame]));
  game._comboRegistry = COMBO_REGISTRY.map((c) => ({ ...c, firedThisGame: firedByName.get(c.name) || false }));
  game.attachScoring = undefined;
  if (typeof game._iidCounter !== 'number') game._iidCounter = deriveIidCounter(game);
  // Rebuild the attachment graph from the ids stored at pack time.
  for (const perm of game.battlefield) perm.attachments = [];
  for (const perm of game.battlefield) {
    const hostIid = perm.attachedToIid || state.battlefield?.find((x) => x.iid === perm.iid)?.attachedToIid;
    perm.attachedToIid = undefined;
    if (!hostIid) continue;
    const host = game.battlefield.find((p) => p.iid === hostIid);
    if (host) { perm.attachedTo = host; host.attachments.push(perm); }
  }
  attachScoring(game);
  game.recomputeStatics();
  game.bot = makeBot(game.players[1].deck.prototype);
  return game;
}

export function createGame({ decks, seed, humanDeckIndex = 0, options = {} }) {
  const rng = makeRng(seed);
  const game = {
    seed, rng, turn: 0, activePlayer: HUMAN, priority: HUMAN, phase: 'begin',
    stepIndex: 0, stack: [], battlefield: [], logLines: [], events: [], pending: null,
    status: 'setup', result: null, extraTurns: [], unsupported: new Set(),
    _staticMods: [], _triggers: [], _pendingTriggers: [], _passesInARow: 0, _listeners: [],
    humanId: HUMAN, botId: 1, banner: null, comboHistory: [], pendingPromises: [],
    ...options,
  };

  game.players = decks.map((deck, i) => {
    const owner = i;
    const zones = { library: [], hand: [], graveyard: [], exile: [], command: [], battlefield: [] };
    const cards = deck.cardList.map((card, idx) => makeCardInstance(card, {
      owner, controller: owner, zone: card.zone === 'command' ? 'command' : 'library',
      isCommander: card.zone === 'command', iid: `${i}-${idx}`,
    }));
    for (const c of cards) zones[c.zone].push(c);
    zones.library = rng.shuffle(zones.library);
    return {
      id: i, deck, zones, life: 40, manaPool: [], landsPlayedThisTurn: 0,
      commanderDamage: {}, isBot: i !== HUMAN, name: i === HUMAN ? 'You' : deck.name,
      lost: false, mulligans: 0, landDrops: 0, autoTapMana: 0,
    };
  });

  // iid counter for tokens/copies/stack entries. Kept on the game object (not in
  // a closure) so it survives being packed into storage and revived.
  game._iidCounter = 1000;

  Object.assign(game, gameMethods);

  // Opening hands, in seat order, with an automatic fair mulligan (deterministic,
  // identical for every player on the day's seed — 0 or 6+ lands is not a game).
  for (const pl of game.players) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const lands = pl.zones.library.slice(0, 7).filter(isLand).length;
      if (lands >= 1 && lands <= 5) break;
      pl.zones.library = [...pl.zones.library.slice(7), ...pl.zones.library.slice(0, 7)];
      pl.mulligans++;
    }
    for (let i = 0; i < 7; i++) {
      const c = pl.zones.library.shift();
      c.zone = 'hand';
      pl.zones.hand.push(c);
    }
  }

  game._comboRegistry = COMBO_REGISTRY.map((c) => ({ ...c, firedThisGame: false }));
  game.scores = game.players.map(() => ({ total: 0, lines: [] }));
  if (!options.noScoring) attachScoring(game);
  game.startingPlayer = HUMAN;
  game.runEnterAbility = game.runEnterAbility.bind(game);
  game.scriptFor = game.scriptFor.bind(game);
  game.chooseFrom = game.chooseFrom.bind(game);
  game.status = 'playing';
  game.checkStateBased();
  game.beginTurn(HUMAN, { firstTurn: true });
  return game;
}

const gameMethods = {
  /* ---------------- identity ---------------- */

  nextIid() { return `t${this._iidCounter++}`; },

  /* ---------------- events, triggers, statics ---------------- */

  emit(event) {
    event.turn = this.turn;
    event.cmc = event.cmc ?? (event.card ? (this.battlefield.find((p) => p.iid === event.card)?.cmc || 0) : 0);
    this.events.push(event);
    for (const listener of this._listeners || []) listener(event, this);
    this.logEvent(event);
    if (event.type === 'etb') this.triggerEvent({ type: 'permanentEntered', card: event.card, controller: event.controller });
    if (event.type === 'dies') {
      this.triggerEvent({ type: 'permanentDied', card: event.card, controller: event.controller });
      // The compiler's vocabulary calls this `permanentDies`; the engine calls it
      // `permanentDied`. Both names are emitted so a card written either way works
      // (Moldervine Reclamation and Yahenni were dead on this one-word mismatch).
      this.triggerEvent({ type: 'permanentDies', card: event.card, controller: event.controller });
      const card = this.players[event.controller]?.zones.graveyard.find((c) => c.iid === event.card);
      if (card) {
        const script = cardScript(card);
        if (script.onDeath) script.onDeath(this, { source: card, controller: event.controller, targets: [] });
      }
    }
    this.triggerEvent(event);
  },

  scriptFor(inst) { return cardScript(inst); },

  runEnterAbility(inst, playerId, targets = []) {
    const script = cardScript(inst);
    if (script.onEnter) script.onEnter(this, { source: inst, controller: playerId, targets });
    if (script.scry) {
      const pl = this.players[playerId];
      const look = pl.zones.library.slice(0, script.scry);
      look.sort((a, b) => b.cmc - a.cmc);
      pl.zones.library = [...look, ...pl.zones.library.slice(look.length)];
    }
  },

  chooseFrom() { return null; },
  triggerEvent(event) {
    const triggers = [];
    for (const perm of [...this.battlefield]) {
      const specs = triggerSpecsFor(perm);
      for (const [specIndex, t] of specs.entries()) {
        if (t.event !== event.type) continue;
        if (!t.match || t.match(this, perm, event)) triggers.push({ source: perm, sourceIid: perm.iid, spec: t, specIndex, event });
      }
    }
    if (triggers.length) {
      // CR 603.3b: APNAP order — active player's triggers first
      triggers.sort((a, b) => (a.source.controller === this.activePlayer ? -1 : 1));
      this._pendingTriggers.push(...triggers);
    }
  },
  flushTriggers() {
    const pending = this._pendingTriggers.splice(0);
    for (const t of pending) {
      // `source` is a live reference in-process, an iid after a revive.
      const src = (t.source && this.battlefield.includes(t.source))
        ? t.source
        : this.battlefield.find((p) => p.iid === (t.sourceIid ?? t.source));
      if (!src) continue; // source left before the trigger resolved
      const spec = t.spec || triggerSpecsFor(src)[t.specIndex];
      if (!spec) continue;
      this.stack.push({
        kind: 'trigger', source: src, sourceIid: src.iid, spec, specIndex: t.specIndex,
        controller: src.controller, iid: this.nextIid(),
        // The event that caused the trigger, so an effect that says "that much"
        // can read the number it was triggered with (CR 603.2c).
        eventPayload: t.event || null,
      });
    }
    return pending.length;
  },
  recomputeStatics() {
    this._staticMods = [];
    for (const perm of this.battlefield) {
      for (const mod of staticModsFor(perm, this)) this._staticMods.push({ ...mod, source: perm });
    }
  },
  staticModsForSource(iid) { return this._staticMods.filter((m) => m.source?.iid === iid); },

  /* ---------------- player helpers ---------------- */

  other(id) { return id === 0 ? 1 : 0; },
  controlledBy(id) { return this.battlefield.filter((p) => p.controller === id); },
  creaturesControlledBy(id) { return this.battlefield.filter((p) => p.controller === id && characteristics(this, p).isCreature); },
  landsControlledBy(id) { return this.battlefield.filter((p) => p.controller === id && isLand(p)); },
  /**
   * The player's commander, wherever it currently is. Identity is a property of
   * the commander designation, not of a zone: an effect that tucks it into a
   * library must not be able to change what the deck is allowed to play
   * (CR 903.4), or every coloured card in the deck stops working.
   */
  commanderOf(id) {
    const pl = this.players[id];
    return [...pl.zones.command, ...this.battlefield,
      ...pl.zones.hand, ...pl.zones.graveyard, ...pl.zones.exile, ...pl.zones.library]
      .find((c) => c.isCommander && c.owner === id) || null;
  },

  /* ---------------- turn structure ---------------- */

  beginTurn(playerId, { firstTurn = false } = {}) {
    this.turn++;
    let active = playerId;
    if (!firstTurn) {
      // extra turn queue (CR 500.7)
      const next = this.extraTurns.shift();
      if (next !== undefined) active = next;
    }
    this.activePlayer = active;
    this.turnNumberFor = this.turnNumberFor || {};
    this.turnNumberFor[active] = (this.turnNumberFor[active] || 0) + 1;
    const pl = this.players[this.activePlayer];
    pl.landsPlayedThisTurn = 0;
    pl.landDrops = pl.landDrops || 0;
    this.stepIndex = 0;
    this.enterStep();
  },

  enterStep() {
    const step = STEPS[this.stepIndex];
    this.step = step.name;
    const pl = this.players[this.activePlayer];

    if (step.name === 'untap') {
      // CR 502: untap all permanents the active player controls
      for (const p of this.controlledBy(this.activePlayer)) {
        untap(this, p);
        p.summoningSick = false;
        p.damage = 0;
        p.dealtDamageThisTurn = 0;
        p.attackedThisTurn = false;
      }
      this.recomputeStatics();
      this.stepIndex++;
      return this.enterStep();
    }
    if (step.name === 'draw') {
      if (!(this.turn === 1 && this.activePlayer === (this.startingPlayer ?? HUMAN))) {
        this.triggerEvent({ type: 'drawStep', player: this.activePlayer });
        draw(this, this.activePlayer, 1, { reason: 'draw step' });
      }
    }
    if (step.name === 'upkeep') this.triggerEvent({ type: 'upkeepStart', player: this.activePlayer });
    if (step.name === 'end') this.triggerEvent({ type: 'endStepStart', player: this.activePlayer });
    if (step.name === 'beginCombat') this.triggerEvent({ type: 'beginCombat', player: this.activePlayer });
    if (step.name === 'declareAttackers') { this.attackersDeclared = false; this.attackers = []; }
    if (step.name === 'declareBlockers') { this.blocksDeclared = false; this.blocks = []; }

    this.priority = this.activePlayer;
    this.priorityState = { passed: [] };
    this._passesInARow = 0;
    this.checkStateBased();
  },

  advanceStep() {
    // Empty mana pools at end of each step/phase (CR 500.4)
    for (const p of this.players) p.manaPool = [];
    // Fresh safety budget for the loop breaker (see driver.priorityWindow)
    this._stepResolutions = 0;
    this.clearEndOfTurnEffects();
    this.stepIndex++;
    if (this.stepIndex >= STEPS.length) return this.endTurn();
    this.enterStep();
    return { ok: true };
  },

  endTurn() {
    // CR 514.2: cleanup
    const pl = this.players[this.activePlayer];
    while (pl.zones.hand.length > 7) {
      const card = pl.zones.hand[pl.zones.hand.length - 1];
      pl.zones.hand.pop();
      card.zone = 'graveyard';
      pl.zones.graveyard.push(card);
      this.emit({ type: 'discard', player: pl.id, card: card.iid, cleanup: true });
    }
    for (const p of this.battlefield) { p.enteredThisTurn = false; p._deathtouchDamage = false; }
    this.turnState = null;
    if (this.checkGameEnd()) return { ok: true };
    this.beginTurn(this.other(this.activePlayer));
    return { ok: true };
  },

  clearEndOfTurnEffects() {
    for (const p of this.battlefield) {
      p.tempPumps = p.tempPumps.filter((x) => !x.untilEndOfTurn);
      p.keywordGrants = p.keywordGrants.filter((x) => !x.untilEndOfTurn);
      p.damagePrevention = p.damagePrevention.filter((x) => !x.expired && x.expires !== 'eot');
    }
    this._staticMods = this._staticMods.filter((m) => !m.untilEndOfTurn);
  },

  /* ---------------- stack & priority ---------------- */

  pushSpell(card, controller, { targets = [], x = 0, mode = null, source = null } = {}) {
    const entry = {
      kind: 'spell', card, controller, targets, x, mode, iid: this.nextIid(),
      isCommander: card.isCommander, zoneLeft: card.zone,
    };
    this.stack.push(entry);
    card.zone = 'stack';
    this.emit({ type: 'spellCast', card: card.iid, controller, name: card.name, cmc: card.cmc, types: card.types, isPermanent: isPermanent(card) && !isInstant(card) && !isSorcery(card) });
    return entry;
  },

  pushAbility(source, controller, spec, { targets = [], x = 0, isMana = false } = {}) {
    const specIndex = (cardScript(source)?.abilities || []).indexOf(spec);
    const entry = { kind: 'ability', source, sourceIid: source?.iid, spec, specIndex: specIndex >= 0 ? specIndex : null, controller, targets, x, iid: this.nextIid(), isMana };
    if (!isMana) {
      this.stack.push(entry);
      this.emit({ type: 'abilityActivated', card: source.iid, controller, ability: spec.raw || '' });
    }
    return entry;
  },

  resolveTop() {
    const entry = this.stack.pop();
    if (!entry) return;
    if (entry.kind === 'spell') this.resolveSpell(entry);
    else this.resolveAbility(entry);
    this.checkStateBased();
  },

  resolveSpell(entry) {
    const card = entry.card;
    // CR 608.2b: if all targets are illegal, the spell fizzles
    const targets = entry.targets.filter((t) => {
      if (typeof t === 'number') return true;                     // a player
      if (!t) return false;
      if (t.kind === 'spell') return this.stack.includes(t);      // a spell still on the stack
      return t.zone === 'battlefield';                            // a permanent still on the battlefield
    });
    const ctx = { source: card, controller: entry.controller, targets, x: entry.x, mode: entry.mode, spell: entry };
    const script = cardScript(card);
    const isPermanentSpell = isPermanent(card) && !isInstant(card) && !isSorcery(card);

    if (isPermanentSpell) {
      card.stackEntry = null;
      card.controller = entry.controller;
      putPermanent(this, card, entry.controller, { targets });
      // (putPermanent attaches an Aura to the permanent it was cast on, which is
      // also what keeps the state-based check from binning it on the way in.)
      this.comboCheck(entry.controller);
      this.emit({ type: 'spellResolved', card: card.iid, controller: entry.controller, name: card.name });
      return;
    }
    // Instant/sorcery: run effects, then to the graveyard
    if (script.onResolve) script.onResolve(this, ctx);
    else runEffects(this, ctx, script.steps || []);
    this.comboCheck(entry.controller);
    this.emit({ type: 'spellResolved', card: card.iid, controller: entry.controller, name: card.name });
    const owner = this.players[card.owner];
    if (card.zone === 'stack') {
      card.zone = 'graveyard';
      owner.zones.graveyard.push(card);
      // "whenever you cast" / storm-style counting already happened at cast time
    }
  },

  resolveAbility(entry) {
    const ctx = { source: entry.source, controller: entry.controller, targets: entry.targets, x: entry.x, ability: entry.spec, event: entry.eventPayload || null };
    if (entry.spec?.steps) runEffects(this, ctx, entry.spec.steps);
    else if (entry.spec?.effect) entry.spec.effect(this, ctx);
    this.comboCheck(entry.controller);
  },

  counterSpell(entry, ctx) {
    const idx = this.stack.indexOf(entry);
    if (idx < 0) return;
    this.stack.splice(idx, 1);
    const card = entry.card || entry.source;
    const owner = this.players[card?.owner ?? entry.controller];
    if (card && card.zone === 'stack') {
      card.zone = 'graveyard';
      owner.zones.graveyard.push(card);
    }
    this.emit({ type: 'spellCountered', card: card?.iid, name: card?.name, controller: entry.controller });
    this.checkStateBased();
  },

  /* ---------------- state-based actions (CR 704) ---------------- */

  checkStateBased() {
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 24) {
      changed = false;
      // lethal damage / zero toughness (CR 704.5f,g)
      for (const perm of [...this.battlefield]) {
        if (!isCreature(perm)) continue;
        const t = characteristics(this, perm).toughness;
        const lethal = perm.damage >= t || t <= 0 || perm._deathtouchDamage;
        if (lethal && !hasKeyword(this, perm, 'Indestructible')) {
          this.emit({ type: 'creatureDied', card: perm.iid, controller: perm.controller, reason: 'lethal damage' });
          moveToGraveyard(this, perm, { reason: 'state-based action' });
          changed = true;
        }
      }
      // an Aura with nothing to enchant (CR 704.5m)
      for (const perm of [...this.battlefield]) {
        const isAura = (perm.subtypes || []).includes('Aura') || cardScript(perm).isAura;
        if (!isAura) continue;
        const host = perm.attachedTo;
        if (host && this.battlefield.includes(host)) continue;
        perm.attachedTo = null;
        moveToGraveyard(this, perm, { reason: 'aura with no host' });
        changed = true;
      }
      // +1/+1 and -1/-1 counters annihilate (CR 704.5q)
      for (const perm of this.battlefield) {
        const plus = perm.counters['+1/+1'] || 0, minus = perm.counters['-1/-1'] || 0;
        if (plus && minus) {
          const n = Math.min(plus, minus);
          perm.counters['+1/+1'] = plus - n;
          perm.counters['-1/-1'] = minus - n;
          changed = true;
        }
      }
      // player life totals (CR 704.5a)
      for (const pl of this.players) if (pl.life <= 0 && !pl.lost) { this.lose(pl.id, 'life total reached 0'); changed = true; }
      // legend rule (CR 704.5j)
      const legendaries = {};
      for (const perm of this.battlefield) {
        if (!perm.supertypes.includes('Legendary')) continue;
        if (!perm.types.some((t) => ['Creature', 'Artifact', 'Enchantment', 'Planeswalker', 'Land'].includes(t))) continue;
        const key = `${perm.controller}:${perm.name}`;
        if (legendaries[key]) {
          const keep = legendaries[key];
          const drop = perm;
          const pl = this.players[drop.controller];
          // keep the one with more counters (player-friendly deterministic choice)
          const [a, b] = (drop.counters['+1/+1'] || 0) > (keep.counters['+1/+1'] || 0) ? [keep, drop] : [drop, keep];
          this.emit({ type: 'legendRule', card: a.iid, controller: a.controller });
          moveToGraveyard(this, a, { reason: 'legend rule' });
          legendaries[key] = b;
          changed = true;
        } else legendaries[key] = perm;
      }
      // planeswalker with 0 loyalty (CR 704.5i)
      for (const perm of [...this.battlefield]) {
        if (perm.types.includes('Planeswalker')) {
          const loy = perm.counters.loyalty ?? perm.loyalty ?? 0;
          if (loy <= 0) { this.emit({ type: 'planeswalkerDied', card: perm.iid }); moveToGraveyard(this, perm, {}); changed = true; }
        }
      }
      // auras/equipment attached to nothing (CR 704.5m,n)
      for (const perm of [...this.battlefield]) {
        if ((perm.subtypes.includes('Aura') || perm.subtypes.includes('Equipment')) && perm.attachedTo && !this.battlefield.includes(perm.attachedTo)) {
          if (perm.subtypes.includes('Aura')) { moveToGraveyard(this, perm, {}); changed = true; }
          else perm.attachedTo = null;
        }
      }
    }
    this.checkGameEnd();
  },

  /* ---------------- losing & winning ---------------- */

  lose(playerId, reason, ctx = {}) {
    const pl = this.players[playerId];
    if (pl.lost || this.status === 'over') return;
    pl.lost = true;
    const winner = this.other(playerId);
    this.finish(winner, { loser: playerId, reason });
  },
  win(playerId, reason) { this.finish(playerId, { reason }); },

  finish(winnerId, info) {
    if (this.status === 'over') return;
    this.status = 'over';
    this.result = {
      winner: winnerId,
      humanWon: winnerId === this.humanId,
      info,
      turns: this.turn,
      humanTurnNumber: this.turnNumberFor?.[this.humanId] || 0,
      playerLife: this.players.map((p) => p.life),
      commanderDamage: { ...this.players[this.humanId].commanderDamage },
    };
    try { settlePoints(this); } catch { /* scoring is best-effort */ }
    this.banner = info;
  },

  checkGameEnd() {
    if (this.status === 'over') return true;
    // commander damage (CR 903.10a): 21 from a single commander
    for (const pl of this.players) {
      for (const [src, amount] of Object.entries(pl.commanderDamage || {})) {
        if (amount >= 21) { this.finish(this.other(pl.id), { loser: pl.id, reason: `21 commander damage from ${src}` }); return true; }
      }
    }
    return this.status === 'over';
  },

  /* ---------------- mana ---------------- */

  /** All mana abilities available to a player right now. */
  manaSources(playerId) {
    const out = [];
    for (const perm of this.controlledBy(playerId)) {
      if (perm.tapped && !(perm.counters.charge > 0)) continue;
      const script = cardScript(perm);
      const abilities = [...(script.mana || [])];
      for (const ab of abilities) {
        if (ab.requiresUntapped !== false && perm.tapped) continue;
        if (ab.condition && !ab.condition(this, perm)) continue;
        out.push({ perm, ability: ab, colors: typeof ab.colors === 'function' ? ab.colors(this, perm) : ab.colors });
      }
    }
    return out;
  },

  /**
   * Pay a mana cost by auto-tapping the best available sources (CR 601.2g,h).
   * Preferred order: source that produces exactly the needed colour > dual/any >
   * colourless for generic. Never taps a land the player still needs for a
   * different coloured cost in the same payment.
   */
  payMana(playerId, cost, { allowManaPool = true } = {}) {
    const pl = this.players[playerId];
    const need = { ...(cost.colors || {}) };
    const hybrid = cost.hybrid || [];
    for (const [a] of hybrid) need[a] = (need[a] || 0) + 1;
    let generic = cost.generic || 0;
    let total = Object.values(need).reduce((a, b) => a + b, 0) + generic;

    // Spend floating mana first
    const pool = [...pl.manaPool];
    const spend = (color) => {
      const idx = pool.indexOf(color);
      if (idx >= 0) { pool.splice(idx, 1); return true; }
      const any = pool.indexOf('C');
      if (any >= 0 && color !== 'C') { pool.splice(any, 1); return true; }
      return false;
    };
    let poolUsed = 0;
    for (const c of Object.keys(need)) {
      while (need[c] > 0 && (pool.includes(c) || pool.includes('C'))) { spend(c); need[c]--; total--; poolUsed++; }
    }
    while (generic > 0 && pool.length) { const i = pool.length - 1; pl.manaPool.splice(i, 1); generic--; total--; poolUsed++; }
    if (poolUsed) pl.manaPool = pl.manaPool.filter((_, i) => i >= (pl.manaPool.length - pool.length));

    const sources = this.manaSources(playerId);
    const used = [];
    const channels = sources.map((s) => ({ ...s, colorOptions: Array.isArray(s.colors) ? s.colors : ['C'], tapped: false }));

    const pickFor = (color) => {
      const candidates = channels.filter((c) => !c.tapped && (c.colorOptions.includes(color) || c.colorOptions.includes('ANY')));
      if (!candidates.length) return null;
      // exact producers first (fewest options), then any-colour
      candidates.sort((a, b) => a.colorOptions.length - b.colorOptions.length);
      return candidates[0];
    };

    // Coloured requirements first (they're the constrained ones)
    for (const c of Object.keys(need)) {
      for (let i = 0; i < need[c]; i++) {
        const pick = pickFor(c);
        if (!pick) return { ok: false, reason: `no source for {${c}}` };
        pick.tapped = true;
        used.push({ perm: pick.perm, color: c });
        total--;
      }
    }
    // Generic: prefer sources that make only colourless or all colours
    while (total > 0) {
      const avail = channels.filter((c) => !c.tapped);
      if (!avail.length) return { ok: false, reason: 'not enough mana' };
      avail.sort((a, b) => {
        const scoreA = a.colorOptions.includes('ANY') ? 0 : a.colorOptions.length;
        const scoreB = b.colorOptions.includes('ANY') ? 0 : b.colorOptions.length;
        const prodA = a.ability.amount || 1, prodB = b.ability.amount || 1;
        return (scoreB - prodB) - (scoreA - prodA);
      });
      const pick = avail[0];
      const amount = pick.ability.amount || 1;
      pick.tapped = true;
      used.push({ perm: pick.perm, color: 'C' });
      total -= amount;
    }

    // Commit: tap the permanents and pay any costs
    for (const u of used) {
      const script = cardScript(u.perm);
      const ab = script.mana?.find((a) => (a.colors === u.color || true));
      if (ab?.tap !== false) {
        if (u.perm.tapped) continue;
        tapPermanent(this, u.perm);
      }
      if (ab?.cost?.life) loseLife(this, playerId, ab.cost.life, { reason: 'mana cost' });
      if (ab?.cost?.sacrificeSelf) sacrifice(this, u.perm, { reason: 'mana ability cost' });
      this.emit({ type: 'manaTapped', card: u.perm.iid, color: u.color });
    }
    this.log(`${this.players[playerId].name} taps ${used.map((u) => u.perm.name).join(', ')}`, { kind: 'mana' });
    return { ok: true, used };
  },

  canPayMana(playerId, cost) {
    const pl = this.players[playerId];
    const need = { ...(cost.colors || {}) };
    for (const [a] of cost.hybrid || []) need[a] = (need[a] || 0) + 1;
    let generic = cost.generic || 0;
    const sources = this.manaSources(playerId).map((s) => ({ colors: Array.isArray(s.colors) ? s.colors : ['C'], amount: s.ability.amount || 1 }));
    for (const c of Object.keys(need)) {
      for (let i = 0; i < need[c]; i++) {
        const idx = sources.findIndex((s) => s.colors.includes(c) || s.colors.includes('ANY'));
        if (idx < 0) return false;
        sources.splice(idx, 1);
      }
    }
    const totalAvailable = sources.reduce((a, s) => a + s.amount, 0) + pl.manaPool.length;
    return totalAvailable >= generic;
  },

  /* ---------------- casting ---------------- */

  /** Full legality check for casting a card (CR 601.2). Returns {ok, reason, cost}. */
  canCast(playerId, card, { asInstant = false } = {}) {
    const pl = this.players[playerId];
    if (pl.lost) return { ok: false, reason: 'game over' };
    const script = cardScript(card);
    const flash = isInstant(card) || script.flash || card.keywords.has('Flash') || hasKeyword(this, card, 'Flash');
    const mainPhase = ['main1', 'main2'].includes(this.step);
    const myTurn = this.activePlayer === playerId;
    const stackEmpty = this.stack.length === 0;
    if (!flash && !asInstant) {
      if (!myTurn || !mainPhase) return { ok: false, reason: 'sorcery timing: only your main phase' };
      if (!stackEmpty) return { ok: false, reason: 'sorcery timing: stack must be empty' };
    }
    // colour identity (CR 903.4)
    const commander = this.commanderOf(playerId);
    const identity = new Set(commander ? commander.card.color_identity : []);
    for (const c of card.card.color_identity || []) {
      if (!identity.has(c)) return { ok: false, reason: `{${c}} is outside your commander's colour identity` };
    }
    if (isLand(card)) {
      if (!myTurn || !mainPhase) return { ok: false, reason: 'lands are played in your main phase' };
      if (pl.landsPlayedThisTurn >= 1 + (this.extraLandDrops(playerId))) return { ok: false, reason: 'already played a land this turn' };
      return { ok: true, cost: null };
    }
    // commander tax (CR 903.8)
    let cost = { ...card.parsedCost, colors: { ...(card.parsedCost.colors || {}) }, hybrid: [...(card.parsedCost.hybrid || [])] };
    if (card.isCommander) {
      const zone = card.zone === 'command';
      if (zone) cost.generic += 2 * (card.castFromCommandZone || 0);
    }
    // cost reducers
    for (const mod of this._staticMods) {
      if (mod.kind !== 'costReducer' || mod.source.controller !== playerId) continue;
      if (mod.cardType === 'creature' && card.types.includes('Creature')) cost.generic = Math.max(0, cost.generic - mod.amount);
      else if (!card.types.includes('Creature') && mod.cardType !== 'creature' && card.types.includes(mod.cardType.charAt(0).toUpperCase() + mod.cardType.slice(1))) cost.generic = Math.max(0, cost.generic - mod.amount);
    }
    if (cost.x || card.parsedCost.x) cost.x = card.parsedCost.x || 1;
    if (!this.canPayMana(playerId, cost)) return { ok: false, reason: 'cannot pay the mana cost' };
    return { ok: true, cost, flash };
  },

  extraLandDrops(playerId) {
    let extra = 0;
    for (const perm of this.controlledBy(playerId)) {
      const script = cardScript(perm);
      if (script.extraLandDrops) extra += script.extraLandDrops(this, perm);
      for (const mod of this.staticModsForSource(perm.iid)) if (mod.kind === 'extraLandDrops') extra += mod.amount;
    }
    return extra;
  },

  /**
   * One representation for targets, whichever door they came through: a player
   * is a number, a permanent or spell is the object itself. The HTTP client
   * sends iids, the bot hands back what chooseTarget returned, and a script may
   * pass either — resolving them once here is what makes "the Aura attaches to
   * what it was cast on" work for every path (CR 601.2c, 303.4b).
   */
  canonicalTarget(t) {
    if (t === null || t === undefined) return null;
    if (typeof t === 'number') return t;
    if (typeof t === 'string') {
      const perm = this.battlefield.find((p) => p.iid === t);
      if (perm) return perm;
      const onStack = this.stack.find((e) => e.iid === t);
      if (onStack) return onStack;
      return findPermanent(this, t) || t;
    }
    return t;
  },

  cast(playerId, card, { targets = [], x = 0, mode = null, autoTarget = false } = {}) {
    const check = this.canCast(playerId, card);
    if (!check.ok) return { ok: false, reason: check.reason };
    targets = (targets || []).map((t) => this.canonicalTarget(t)).filter((t) => t !== null && t !== undefined);
    // A spell that requires targets cannot be cast without legal ones (CR 601.2c).
    // This is the guard that stops an Aura (or any targeted spell) from resolving
    // onto the battlefield attached to nothing.
    const reqs = isLand(card) ? [] : castTargetRequirements(cardScript(card));
    const required = reqs.filter((r) => !r.upTo);
    if (required.length) {
      const ctx = { source: card, controller: playerId };
      const chosen = targets || [];
      if (chosen.length < required.length) {
        return {
          ok: false, needsTargets: true,
          reason: reqs.length === 1 ? 'this spell needs a target' : `this spell needs ${reqs.length} targets`,
        };
      }
      for (let i = 0; i < required.length; i++) {
        const entity = chosen[i];
        if (entity === undefined || !specMatches(this, ctx, required[i], entity)) {
          return { ok: false, needsTargets: true, reason: 'that is not a legal target for this spell' };
        }
      }
    }
    if (isLand(card)) {
      const pl = this.players[playerId];
      const idx = pl.zones.hand.indexOf(card);
      if (idx < 0) return { ok: false, reason: 'not in hand' };
      pl.zones.hand.splice(idx, 1);
      putPermanent(this, card, playerId, {});
      pl.landsPlayedThisTurn++;
      pl.landDrops++;
      this.emit({ type: 'landPlayed', card: card.iid, controller: playerId });
      this.triggerEvent({ type: 'landfall', player: playerId, card: card.iid, controller: playerId });
      this.log(`${this.players[playerId].name} plays ${card.name}`);
      this.checkStateBased();
      return { ok: true };
    }
    const pay = this.payMana(playerId, check.cost);
    if (!pay.ok) return { ok: false, reason: pay.reason };
    const pl = this.players[playerId];
    const fromZone = card.zone;
    const idx = pl.zones[fromZone].indexOf(card);
    if (idx < 0) return { ok: false, reason: `card not in ${fromZone}` };
    pl.zones[fromZone].splice(idx, 1);
    if (fromZone === 'command') card.castFromCommandZone = (card.castFromCommandZone || 0) + 1;
    if (mode === 'kicked') card.kicked = true;
    const entry = this.pushSpell(card, playerId, { targets, x, mode });
    this.log(`${this.players[playerId].name} casts ${card.name}${x ? ` (X=${x})` : ''}`);
    this.triggerEvent({ type: 'spellCast', card: card.iid, controller: playerId, name: card.name, cmc: card.cmc, types: card.types });
    return { ok: true, entry };
  },

  /* ---------------- activated abilities ---------------- */

  activatableAbilities(playerId) {
    const out = [];
    for (const perm of this.controlledBy(playerId)) {
      // abilities granted to this permanent by an Aura enchanting it
      for (const grant of grantedAbilitiesFor(perm, this)) {
        const costs = grant.ability.costs || {};
        if (costs.tap && perm.tapped) continue;
        if (costs.mana && !this.canPayMana(playerId, costs.mana)) continue;
        if (grant.ability.condition && !grant.ability.condition(this, perm)) continue;
        out.push({ perm, ability: grant.ability, index: grant.index, grantedBy: grant.grantedBy });
      }
      const script = cardScript(perm);
      // an Aura whose abilities belong to its host must not also offer them itself
      if (script.grantsAbilitiesToHost && (perm.subtypes || []).includes('Aura')) continue;
      (script.abilities || []).forEach((ab, i) => {
        const costs = ab.costs || {};
        if (costs.tap && perm.tapped) return;
        if (costs.summoningSick && perm.summoningSick) return;
        if (costs.mana && !this.canPayMana(playerId, costs.mana)) return;
        if (costs.sacrificeSelf && perm.isCommander && false) return;
        // "Remove a charge counter from ~:" — an ability with nothing to remove
        // is not offered at all (Umezawa's Jitte).
        if (costs.counters && !canPayCounters(perm, costs.counters)) return;
        if (ab.timing === 'sorcery' && !(this.activePlayer === playerId && ['main1', 'main2'].includes(this.step) && this.stack.length === 0)) return;
        if (ab.condition && !ab.condition(this, perm)) return;
        // Equip needs a creature to attach to — but the test must be "is there a
        // creature to equip?", not "is the Equipment a creature?". Reading it the
        // wrong way round (and with `ab.equip` as the flag, so Equip {0} slipped
        // through) meant every Equipment with a non-zero equip cost — Jitte, the
        // Swords, Warhammer, Boots — could never be equipped at all.
        if (ab.equip !== undefined && !this.controlledBy(playerId).some((p) => isCreature(p))) return;
        out.push({ perm, ability: ab, index: i });
      });
    }
    return out;
  },

  activate(playerId, perm, ability, { targets = [], x = 0 } = {}) {
    targets = (targets || []).map((t) => this.canonicalTarget(t)).filter((t) => t !== null && t !== undefined);
    const costs = ability.costs || {};
    if (costs.tap) { if (perm.tapped) return { ok: false, reason: 'already tapped' }; tapPermanent(this, perm); }
    if (costs.mana) { const pay = this.payMana(playerId, costs.mana); if (!pay.ok) return { ok: false, reason: pay.reason }; }
    if (costs.sacrificeSelf) sacrifice(this, perm, { reason: 'activated ability cost' });
    if (costs.life) loseLife(this, playerId, costs.life, {});
    if (costs.counters) {
      if (!canPayCounters(perm, costs.counters)) return { ok: false, reason: 'not enough counters' };
      for (const [type, n] of Object.entries(costs.counters)) perm.counters[type] -= n;
    }
    if (costs.discard) {
      const pl = this.players[playerId];
      if (pl.zones.hand.length) {
        const card = pl.zones.hand[pl.zones.hand.length - 1];
        pl.zones.hand.pop(); card.zone = 'graveyard'; pl.zones.graveyard.push(card);
      }
    }
    if (ability.equip !== undefined) {
      const target = targets[0];
      const creature = typeof target === 'object' ? target : findPermanent(this, target);
      if (!creature || !isCreature(creature)) return { ok: false, reason: 'equip target must be a creature you control' };
      if (perm.attachedTo) {
        perm.attachedTo.attachments = perm.attachedTo.attachments.filter((a) => a.iid !== perm.iid);
      }
      perm.attachedTo = creature;
      creature.attachments.push(perm);
      this.emit({ type: 'equipped', card: perm.iid, target: creature.iid, name: perm.name });
      this.log(`${this.players[playerId].name} equips ${perm.name} to ${creature.name}`);
      this.recomputeStatics();
      this.checkStateBased();
      return { ok: true };
    }
    if (ability.isMana || ability.producesMana) {
      const ctx = { source: perm, controller: playerId, targets, x };
      if (ability.steps?.length) runEffects(this, ctx, ability.steps);
      const colors = typeof ability.manaColors === 'function' ? ability.manaColors(this, perm) : ability.manaColors;
      if (colors) for (const c of colors) pl_addMana(this, playerId, c, 1, ctx);
      else addMana(this, playerId, 'C', 1, ctx);
      return { ok: true };
    }
    const entry = this.pushAbility(perm, playerId, ability, { targets, x });
    return { ok: true, entry };
  },

  /** Everything the human could legally do right now — drives the UI + auto-pass. */
  legalActions(playerId) {
    const actions = [];
    if (this.status === 'over' || this.players[playerId].lost) return actions;
    const pl = this.players[playerId];
    const isMyMain = this.activePlayer === playerId && ['main1', 'main2'].includes(this.step) && this.stack.length === 0;

    // play a land
    if (isMyMain && pl.landsPlayedThisTurn < 1 + this.extraLandDrops(playerId)) {
      for (const c of pl.zones.hand) if (isLand(c)) actions.push({ type: 'playLand', iid: c.iid, name: c.name, label: `Play ${c.name}` });
    }
    // cast anything
    for (const c of [...pl.zones.hand, ...pl.zones.command]) {
      if (c.zone === 'command' && !c.isCommander) continue;
      if (isLand(c)) continue; // lands are played, not cast — already listed above
      const can = this.canCast(playerId, c);
      if (can.ok) {
        const action = { type: 'cast', iid: c.iid, name: c.name, label: `Cast ${c.name}`, mana: c.card.mana_cost || '', zone: c.zone, cmc: c.cmc };
        this.attachTargetInfo(action, c, playerId, (can.cost?.x ? { x: true } : null));
        // A spell that requires a target cannot be cast without one (CR 601.2c),
        // so never offer it: a button that cannot be completed is worse than no
        // button, both for the player and for a seat driven by the bot.
        // (an optional target — "up to one target creature" — never blocks a cast)
        if (action.targetSpec && !action.optional && !(action.legalTargets || []).length) continue;
        actions.push(action);
      }
    }
    // abilities
    for (const { perm, ability, index } of this.activatableAbilities(playerId)) {
      if (ability.isMana || ability.producesMana) continue; // mana abilities run automatically
      const act = { type: 'activate', iid: perm.iid, index, name: perm.name, label: `${perm.name} — ${ability.label || ability.raw || 'activate'}` };
      if (ability.target) {
        const spec = ability.target === 'creatureYouControl' ? { kind: 'permanent', filter: { creature: true, controller: 'you' } }
          : ability.target === 'creature' ? { kind: 'permanent', filter: { creature: true } }
          : { kind: 'permanent', filter: {} };
        if (!legalTargets(this, { source: perm, controller: playerId }, spec).filter((x) => x !== null).length) continue;
      }
      if (ability.equip !== undefined && !this.creaturesControlledBy(playerId).length) continue; // nothing to equip
      if (ability.equip !== undefined) {
        act.targetSpec = { kind: 'permanent', filter: { creature: true, controller: 'you' } };
        act.legalTargets = legalTargets(this, { source: perm, controller: playerId }, act.targetSpec).filter((x) => x !== null);
        act.label = `Equip ${perm.name}`;
      } else {
        this.attachTargetInfo(act, perm, playerId, null, { forCast: false });
      }
      actions.push(act);
    }
    return actions;
  },

  /** Attach the target spec + legal target ids so the client can offer choices. */
  attachTargetInfo(action, card, playerId, extra = null, { forCast = true } = {}) {
    const specs = forCast ? castTargetRequirements(cardScript(card)) : targetRequirements(cardScript(card));
    const spec = specs[0];
    if (!spec) return action;
    action.targetSpec = spec;
    action.legalTargets = legalTargets(this, { source: card, controller: playerId }, spec).filter((x) => x !== null);
    action.optional = !!spec.upTo;
    // suggestions: the same heuristic the bot uses, so the UI can hint beginners
    const suggest = chooseTarget(this, { source: card, controller: playerId }, spec, { mode: 'removal' });
    if (suggest !== null && suggest !== undefined) action.suggestedTarget = suggest;
    if (extra?.x) { action.needsX = true; action.maxX = Math.max(1, Math.min(6, this.manaSources(playerId).reduce((a, s2) => a + (s2.ability.amount || 1), 0) - (card.parsedCost?.generic || 0))); }
    return action;
  },

  /* ---------------- combo tracking ---------------- */

  comboCheck(playerId) {
    const scriptEngine = this._comboRegistry || [];
    for (const combo of scriptEngine) {
      if (combo.firedThisGame) continue;
      if (combo.check(this, playerId)) {
        combo.firedThisGame = true;
        this.fireCombo(combo.name, combo.cards || [], { playerId, description: combo.description, points: combo.points });
      }
    }
  },

  fireCombo(name, cards, ctx = {}) {
    const playerId = ctx.playerId ?? ctx.controller ?? this.activePlayer;
    this.comboHistory.push({ name, turn: this.turn, player: playerId });
    const perms = cards.map((c) => this.battlefield.find((p) => c && p.name.toLowerCase() === String(c).toLowerCase())).filter(Boolean);
    this.emit({ type: 'combo', name, player: playerId, cards: perms.map((p) => p.iid), description: ctx.description });
    this.awardPoints(playerId, ctx.points ?? 5, name === 'combo' ? name : `Great combo! ${name}`, { kind: 'combo' });
  },

  /* ---------------- points & log ---------------- */

  awardPoints(playerId, points, label, meta = {}) {
    if (!this.scores) this.scores = this.players.map(() => ({ total: 0, lines: [] }));
    const entry = { points, label, turn: this.turn, ...meta };
    this.scores[playerId].total += points;
    this.scores[playerId].lines.push(entry);
    this.emit({ type: 'points', player: playerId, points, label });
    this.log(`+${points} ${label}`, { kind: 'points', player: playerId });
  },

  log(text, meta = {}) { this.logLines.push({ text, turn: this.turn, ...meta }); },
  logEvent(event) {
    const nameOf = (iid) => {
      const c = this.battlefield.find((p) => p.iid === iid)
        || this.players.flatMap((p) => [...p.zones.hand, ...p.zones.graveyard, ...p.zones.exile, ...p.zones.command, ...p.zones.library]).find((c) => c.iid === iid);
      return c ? c.name : 'a card';
    };
    switch (event.type) {
      case 'etb': this.log(`${this.players[event.controller].name} puts ${nameOf(event.card)} onto the battlefield`); break;
      case 'dies': this.log(`${nameOf(event.card)} dies`, { player: event.controller }); break;
      case 'damage': this.log(`${event.srcName || 'Something'} deals ${event.amount} to ${event.isPlayer ? this.players[event.target].name : nameOf(event.target)}`); break;
      case 'lifechange': this.log(`${this.players[event.player].name} ${event.gain ? 'gains' : 'loses'} ${Math.abs(event.amount)} life`); break;
      case 'spellCountered': this.log(`${event.name || 'A spell'} is countered`); break;
      case 'extraTurn': this.log(`${this.players[event.player].name} takes an extra turn`); break;
      default: break;
    }
  },
};

function pl_addMana(g, playerId, color, n, ctx) {
  addMana(g, playerId, color === 'ANY' ? 'C' : color, n, ctx);
}
