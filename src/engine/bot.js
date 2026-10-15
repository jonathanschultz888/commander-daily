/**
 * Bot policy. One policy serves both jobs:
 *   - playing out the opening turns of the daily (both decks, so the human drops
 *     into a live board state), and
 *   - playing the opponent's deck for the rest of the game.
 *
 * `prototype` (from the deck definition) sets the temperament:
 *   aggro    — curve out and attack every profitable attack
 *   midrange — trade, keep a board, develop then swing
 *   control  — hold interaction, block well, win late
 *   combo    — dig for its combo pieces, protect them, go off
 */
import { cardScript } from './scripts.js';
import { characteristics, isCreature, isLand, hasKeyword } from './cards.js';
import { chooseTarget, targetRequirements } from './targeting.js';
import { permValue, findPermanent, specMatches, SPECS, legalTargets } from './ops.js';

const isRemoval = (card) => /destroy target|exile target|deals? \d+ damage to (?:any|target|each)/i.test(card.oracle_text || '');
const isBoardWipe = (card) => /destroy all creatures|deals? \d+ damage to each creature|each creature gets -/i.test(card.oracle_text || '');
const isRamp = (card) => /search your library for .*(land|basic)/i.test(card.oracle_text || '') || /add \{/.test(card.oracle_text || '') && card.types.includes('Artifact');
const isDraw = (card) => /draw (?:a|two|three|four|x|\d+) cards?/i.test(card.oracle_text || '');
const isCounter = (card) => /counter target spell/i.test(card.oracle_text || '');
const isTutor = (card) => /search your library/i.test(card.oracle_text || '');
const isTokenMaker = (card) => /create .*tokens?/i.test(card.oracle_text || '');
const isPump = (card) => /gets? \+\d+\/\+\d+|creatures you control get/i.test(card.oracle_text || '');
const isEquipment = (card) => card.subtypes.includes('Equipment');

export function makeBot(prototype = 'midrange') {
  return {
    prototype,
    /** Rank a card for casting right now. Higher = cast sooner. */
    score(card, game, pid) {
      const pl = game.players[pid];
      const cmdr = game.commanderOf(pid);
      let v = 0;
      const isCommanderCard = card.isCommander;
      const threat = (card.power ? parseInt(card.power, 10) || 0 : 0);
      const oppPressure = game.creaturesControlledBy(game.other(pid)).reduce((a, c) => a + characteristics(game, c).power, 0);
      const myLands = game.landsControlledBy(pid).length;

      if (isLand(card)) return 1000; // always develop
      if (isBoardWipe(card)) {
        const myBoard = game.creaturesControlledBy(pid).length;
        const theirBoard = game.creaturesControlledBy(game.other(pid)).length;
        return theirBoard >= 3 && theirBoard > myBoard ? 92 : -20;
      }
      if (isRemoval(card)) {
        const bigThreat = game.battlefield.some((p) => p.controller !== pid && characteristics(game, p).isCreature && (characteristics(game, p).power >= 4 || p.isCommander));
        if (!bigThreat) return this.prototype === 'control' ? 20 : 8;
        return this.prototype === 'control' ? 88 : 74;
      }
      if (isCounter(card)) return this.prototype === 'control' ? 30 : 12; // held for responses
      if (isRamp(card)) return myLands < 7 ? 80 : 30;
      if (isDraw(card)) return pl.zones.hand.length < 6 ? 66 : 40;
      if (isTutor(card)) {
        const wantCombo = this.prototype === 'combo';
        const comboInDeck = game._comboRegistry?.some((c) => !c.firedThisGame);
        return wantCombo && comboInDeck ? 85 : 55;
      }
      if (isTokenMaker(card)) return 70 + (game.battlefield.filter((p) => p.controller === pid && p.isToken).length >= 4 ? 15 : 0);
      if (isPump(card)) {
        const attackers = game.creaturesControlledBy(pid).filter((c) => !c.summoningSick).length;
        return attackers >= 3 ? 90 : 15;
      }
      if (isEquipment(card)) return game.creaturesControlledBy(pid).length ? 64 : 20;
      if (card.types.includes('Creature')) {
        let s = 50 + threat * 2 + (card.cmc <= 4 ? 8 : 0);
        if (this.prototype === 'aggro') s += 12;
        if (this.prototype === 'control') s -= 6;
        // curve preference: don't dump the hand on turn 2
        if (card.cmc > myLands + 1) s -= 25;
        s += (game.battlefield.filter((p) => p.controller === pid).length < 3 ? 12 : 0);
        return s;
      }
      if (card.types.includes('Enchantment') || card.types.includes('Artifact')) return 58;
      if (card.types.includes('Planeswalker')) return 78;
      if (isCommanderCard) return 72;
      return 30;
    },

    /** Choose the best action available right now, or null to pass. */
    chooseAction(game, pid) {
      const actions = game.legalActions(pid).filter((a) => a.type !== 'activate');
      if (!actions.length) return null;
      const scored = [];
      for (const a of actions) {
        const card = findCardInZones(game, pid, a.iid);
        if (!card) continue;
        let score = this.score(card, game, pid);
        if (isCreature(card) && game.creaturesControlledBy(game.other(pid)).length > game.creaturesControlledBy(pid).length + 2 && !hasKeyword(game, card, 'Haste')) score -= 5;
        // During the opening (pre-human) the bot should also develop the board
        scored.push({ action: a, score, card });
      }
      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (!best || best.score < 8) return null;
      return best;
    },

    /** Attach targets to a chosen action. */
    withTargets(game, pid, action, card) {
      const script = cardScript(card);
      const specs = targetRequirements(script);
      if (!specs.length) return { ...action, targets: [] };
      const targets = [];
      for (const spec of specs) {
        const mode = isRemoval(card) ? 'removal' : action.type === 'activate' ? 'value' : 'value';
        const t = chooseTarget(game, { source: card, controller: pid }, spec, { mode });
        if (t === null && !spec.upTo) return null;
        if (t !== null) targets.push(t);
      }
      return { ...action, targets };
    },

    /** Declare attackers: everything that connects profitably, plus commander when safe. */
    declareAttackers(game, pid) {
      const opponents = game.players.filter((p) => p.id !== pid);
      const defenders = game.battlefield.filter((p) => p.controller !== pid && characteristics(game, p).isCreature && !p.tapped);
      const attackers = [];
      for (const c of game.creaturesControlledBy(pid)) {
        if (c.tapped || (c.summoningSick && !hasKeyword(game, c, 'Haste'))) continue;
        if (hasKeyword(game, c, 'Defender')) continue;
        const ch = characteristics(game, c);
        if (ch.power <= 0) continue;
        // Evasive or unblocked-able: always attack. Otherwise attack if it wins the trade or the board is clear.
        const evasive = ch.keywords.has('Flying') || ch.keywords.has('Menace') || hasKeyword(game, c, 'Unblockable');
        const challengers = defenders.filter((d) => canBlock(game, d, c));
        const bestBlocker = challengers.sort((a, b) => characteristics(game, b).toughness - characteristics(game, a).toughness)[0];
        if (!challengers.length || evasive || this.prototype === 'aggro') { attackers.push(c); continue; }
        const bt = characteristics(game, bestBlocker);
        const winsTrade = ch.power >= bt.toughness && ch.toughness > bt.power;
        const trades = ch.power >= bt.toughness && bt.power >= ch.toughness;
        const isCommander = c.isCommander;
        if (winsTrade || (trades && this.prototype !== 'control')) attackers.push(c);
        else if (isCommander && bt.power < ch.toughness && game.players[game.other(pid)].life <= 15) attackers.push(c);
      }
      return attackers.map((c) => c.iid);
    },

    /** Blocking: block the biggest unblocked attacker if the trade favours us. */
    declareBlocks(game, pid, attackers) {
      const pairs = [];
      const available = game.creaturesControlledBy(pid).filter((c) => !c.tapped);
      const used = new Set();
      const sorted = attackers
        .map((iid) => game.battlefield.find((p) => p.iid === iid))
        .filter(Boolean)
        .sort((a, b) => (characteristics(game, b).power + (b.isCommander ? 5 : 0)) - (characteristics(game, a).power + (a.isCommander ? 5 : 0)));
      const myLife = game.players[pid].life;
      for (const atk of sorted) {
        const atkCh = characteristics(game, atk);
        const lethal = atkCh.power >= myLife;
        const blockers = available.filter((b) => !used.has(b.iid) && canBlock(game, b, atk));
        if (!blockers.length) continue;
        // Prefer a blocker that survives; otherwise chump only if the damage matters
        const scored = blockers.map((b) => {
          const bch = characteristics(game, b);
          const kills = bch.power >= atkCh.toughness;
          const survives = bch.toughness > atkCh.power || (atkCh.keywords.has('Deathtouch') === false && bch.toughness >= atkCh.power);
          let s = 0;
          if (kills) s += 6;
          if (survives) s += 5;
          if (atk.isCommander) s += 3;
          if (lethal) s += 10;
          s -= bch.power;
          return { b, s };
        }).sort((a, b) => b.s - a.s);
        const best = scored[0];
        if (this.prototype === 'control' ? best.s >= 0 : best.s >= 3 || lethal) {
          pairs.push({ blocker: best.b.iid, attacker: atk.iid });
          used.add(best.b.iid);
        }
      }
      return pairs;
    },

    /** Which cards to keep when forced to discard. */
    worstCard(game, pid, hand) {
      const scored = hand.map((c) => ({ c, s: this.score(c, game, pid) + (isLand(c) ? 40 : 0) }));
      scored.sort((a, b) => a.s - b.s);
      return scored[0]?.c || hand[0];
    },
  };
}

export function canBlock(game, blocker, attacker) {
  const bch = characteristics(game, blocker);
  const ach = characteristics(game, attacker);
  if (!bch.isCreature || bch.keywords.has('CantBlock')) return false;
  if (hasKeyword(game, blocker, 'Defender')) return true;
  if (ach.keywords.has('Flying') && !bch.keywords.has('Flying') && !bch.keywords.has('Reach')) return false;
  if (hasKeyword(game, attacker, 'Unblockable') || attacker.card.oracle_text?.match(/can't be blocked/i)) return false;
  if (hasKeyword(game, blocker, 'Unblockable')) return false;
  // protection / menace are handled simply
  if (blocker.protection?.has('everything')) return false;
  return true;
}

function findCardInZones(game, pid, iid) {
  const pl = game.players[pid];
  for (const key of ['hand', 'command', 'graveyard', 'library', 'exile']) {
    const c = pl.zones[key].find((x) => x.iid === iid);
    if (c) return c;
  }
  return game.battlefield.find((p) => p.iid === iid) || null;
}

export const PROTOTYPE_LABEL = {
  aggro: 'Aggro', midrange: 'Midrange', control: 'Control', combo: 'Combo',
};
