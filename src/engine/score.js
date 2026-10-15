/**
 * Points engine.
 *
 * Everything a player is rewarded for is decided here, from events the engine
 * already emits — never from the client. Each award is a short human-readable
 * label ("Great combo!", "Clean removal") so the side panel can tick up in play.
 *
 * Categories:
 *   Interaction  — removing threats, countering real spells, trading up in combat
 *   Protection   — saving your own permanents / not losing your commander
 *   Combo        — pulling off a registered combo line (from scripts.js)
 *   Efficiency   — settled at game end: how fast you closed (win) or how long you
 *                  survived against a deck that was ahead (loss)
 *   Discipline   — small awards for curve, land drops, holding up interaction
 */
import { characteristics, hasKeyword } from './cards.js';

const value = (game, perm) => characteristics(game, perm).power + characteristics(game, perm).toughness
  + (perm.isCommander ? 4 : 0) + perm.attachments.length * 2;

export function attachScoring(game) {
  game._listeners.push((ev) => {
    const me = game.humanId;
    try { scoreEvent(game, ev); } catch { /* scoring must never break a game */ }
  });
}

function scoreEvent(game, ev) {
  const me = game.humanId;
  const opp = game.other(me);

  switch (ev.type) {
    case 'spellCountered': {
      const controller = ev.controller;
      if (controller === me) return;
      const cmc = ev.cmc || 0;
      if (controller === opp && cmc >= 3) {
        game.awardPoints(me, 4 + Math.min(3, cmc - 3), `Answer! Countered ${ev.name}`, { kind: 'interaction' });
      }
      if (controller === me) {
        game.awardPoints(opp, 0, '', { kind: 'noop' });
      }
      return;
    }

    case 'dies': {
      const card = game.players[ev.controller]?.zones.graveyard.find((c) => c.iid === ev.card)
        || game.players.flatMap((p) => p.zones.graveyard).find((c) => c.iid === ev.card);
      if (!card) return;
      const name = card.name;
      if (ev.controller === opp) {
        const cmc = card.cmc || 0;
        if (cmc >= 4) game.awardPoints(me, 3, `Clean removal — ${name} dies`, { kind: 'interaction' });
      }
      if (ev.controller === me && card.isCommander) {
        game.awardPoints(me, -1, `${name} died — rebuild`, { kind: 'setback' });
      }
      return;
    }

    case 'damage': {
      // combat trades in your favour
      if (!ev.isPlayer && ev.source) {
        const src = game.battlefield.find((p) => p.iid === ev.source);
        if (src && src.controller === me) {
          game._combatDamageThisTurn = (game._combatDamageThisTurn || 0) + ev.amount;
        }
      }
      if (ev.isPlayer && ev.source) {
        const src = game.battlefield.find((p) => p.iid === ev.source);
        if (src && src.controller === me) {
          game._faceDamageThisTurn = (game._faceDamageThisTurn || 0) + ev.amount;
          // One combat-damage award per turn, and only for a genuinely big swing.
          if (!game._awardedFaceDamage) game._awardedFaceDamage = new Set();
          game._faceDamageThisTurn = game._faceDamageThisTurn || 0;
          const key = `turn:${game.turn}`;
          if (!game._awardedFaceDamage.has(key) && game._faceDamageThisTurn >= 6) {
            game._awardedFaceDamage.add(key);
            game.awardPoints(me, 2, `Punched through for ${game._faceDamageThisTurn}`, { kind: 'combat' });
          }
        }
      }
      return;
    }

    case 'preventedDestroy': {
      const perm = game.battlefield.find((p) => p.iid === ev.target);
      if (perm && perm.controller === me) game.awardPoints(me, 3, `Saved your ${perm.name}!`, { kind: 'protection' });
      return;
    }

    case 'preventedDamage': {
      return;
    }

    case 'spellCast': {
      // holding up interaction: casting a counterspell on the opponent's turn
      if (ev.controller === me && game.activePlayer === opp) {
        const card = game.players[me].zones.graveyard.find((c) => c.iid === ev.card)
          || game.stack.find((s) => s.card?.iid === ev.card)?.card;
        if (card && (card.types.includes('Instant') || card.types.includes('Flash'))) {
          game.awardPoints(me, 1, `Instant-speed play on their turn`, { kind: 'discipline' });
        }
      }
      return;
    }

    case 'combo': {
      // combo points come from fireCombo itself; nothing extra here
      return;
    }

    default: return;
  }
}

/**
 * End-of-game settlement.
 *
 * A win is scored on speed: beating the bracket's expected length is worth more.
 * A loss is scored on how close you came — surviving past the expected length
 * against a deck that was ahead still earns points, so losing isn't worthless.
 */
export function settlePoints(game) {
  const me = game.humanId;
  const opp = game.other(me);
  if (!game.scores) game.scores = game.players.map(() => ({ total: 0, lines: [] }));
  const bracket = Math.max(game.players[0].deck.bracket, game.players[1].deck.bracket);
  const expectedTurns = { 1: 9, 2: 8, 3: 6, 4: 4, 5: 4 }[bracket] || 6;
  const myTurns = game.turnNumberFor?.[me] || Math.ceil(game.turn / 2);
  const won = game.result?.humanWon;

  if (won) {
    const speed = Math.max(0, expectedTurns - myTurns + 1) * 2;
    game.awardPoints(me, 10 + speed, `Victory in ${myTurns} of your turns`, { kind: 'result' });
    if (game.result.info.reason?.includes('commander damage')) game.awardPoints(me, 5, 'Commander damage kill', { kind: 'result' });
    if (game.players[me].life >= 30) game.awardPoints(me, 3, 'Won without taking much damage', { kind: 'result' });
  } else {
    const survived = Math.max(0, myTurns - expectedTurns + 3);
    game.awardPoints(me, 2 + survived, `Lost, but lasted ${myTurns} turns`, { kind: 'result' });
    const oppLife = game.players[opp].life;
    if (oppLife <= 12) game.awardPoints(me, 4, `So close — opponent finished on ${oppLife} life`, { kind: 'result' });
    const dealt = 40 - game.players[opp].life;
    if (dealt >= 20) game.awardPoints(me, 3, `Dealt ${dealt} damage`, { kind: 'result' });
  }
  // interaction bonus tally
  const interaction = game.scores[me].lines.filter((l) => l.kind === 'interaction').length;
  if (interaction >= 5) game.awardPoints(me, 3, `Kept the pressure on all game`, { kind: 'result' });
  // combo bonus
  const combos = game.comboHistory.filter((c) => c.player === me).length;
  if (combos >= 2) game.awardPoints(me, 5, `Pulled off ${combos} combos`, { kind: 'result' });

  game.scores[me].lines = game.scores[me].lines.filter((l) => !l.noop && l.label);
  game.scores[opp].lines = (game.scores[opp].lines || []).filter((l) => !l.noop && l.label);
  return game.scores;
}

/** Flatten a score sheet for the leaderboard payload. */
export function scoreSummary(game) {
  const me = game.humanId;
  const lines = (game.scores?.[me]?.lines || []).filter((l) => l.label);
  return {
    total: game.scores?.[me]?.total || 0,
    lines: lines.map((l) => ({ label: l.label, points: l.points, turn: l.turn, kind: l.kind })),
    combos: game.comboHistory.filter((c) => c.player === me).length,
    turns: game.turnNumberFor?.[me] || 0,
    won: !!game.result?.humanWon,
    reason: game.result?.info?.reason || '',
  };
}
