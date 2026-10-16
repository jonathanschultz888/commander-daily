/**
 * Player reports, and the corrections they turn into.
 *
 * A player can say "this card did not behave" from the card inspector. The report
 * is not taken on trust: it is answered by the engine's own picture of the card —
 * what the printed text demands, what the compiled script actually does, and
 * whether anything is missing between the two. Where the gap is one the engine
 * can close by itself (a spell whose text targets but which was never asked for a
 * target), the fix is derived mechanically, recorded, and used from then on, so
 * the next game is right rather than merely logged.
 *
 * This module deliberately has no imports: both the rules layer and the server
 * read from it, and a cycle here would be invisible until something shut down at
 * three in the morning.
 */

/** Card-name (lowercase) -> { targets: Spec[], note, at }. */
const overlay = new Map();
let reportCount = 0;

export function setCorrections(list) {
  overlay.clear();
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !c.name) continue;
    overlay.set(String(c.name).toLowerCase(), {
      targets: Array.isArray(c.targets) ? c.targets : [],
      note: c.note || '',
      at: c.at || null,
      reports: c.reports || 0,
    });
  }
  reportCount = overlay.size;
  return overlay.size;
}

export function correctionsFor(name) {
  if (!name) return null;
  return overlay.get(String(name).toLowerCase()) || null;
}

export function allCorrections() {
  return [...overlay.entries()].map(([name, c]) => ({ name, ...c }));
}

export function correctionCount() { return reportCount; }

/* ------------------------------------------------------------------ */
/* Reading a card's printed text                                       */
/* ------------------------------------------------------------------ */

/** The lines that describe what the spell itself does (not triggers, not reminder text). */
export function effectLines(oracleText) {
  return String(oracleText || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^(when|whenever|at the beginning of|as long as)/i.test(l))
    .filter((l) => !/^\(.*\)$/.test(l))
    .map((l) => l.replace(/\s*\([^)]*\)\s*$/, ''));
}

/**
 * What the printed text says the spell targets, as a target spec. Returns null
 * when the line targets nothing (or when the wording is beyond what this can
 * safely infer — an unrecognised clause is never guessed at).
 */
export function specFromText(line) {
  const lc = String(line || '').toLowerCase();
  const upTo = /\bup to (?:one|two|three|four|five|\d+)\b[^.]{0,24}\btarget/.test(lc);
  const wrap = (spec) => (spec ? (upTo ? { ...spec, upTo: true } : spec) : null);
  if (!/\btarget\b/.test(lc)) return null;
  if (/any target/.test(lc)) return wrap({ kind: 'permanent-or-player', filter: {} });
  if (/\btarget [a-z ]*spell\b/.test(lc)) {
    if (/noncreature spell/.test(lc)) return wrap({ kind: 'spell', filter: { noncreature: true } });
    if (/creature spell/.test(lc)) return wrap({ kind: 'spell', filter: { creature: true } });
    return wrap({ kind: 'spell', filter: {} });
  }
  if (/target player|target opponent/.test(lc)) return wrap({ kind: 'player', filter: {} });
  if (/target creature you control/.test(lc)) return wrap({ kind: 'permanent', filter: { creature: true, controller: 'you' } });
  if (/target creature an opponent controls/.test(lc)) return wrap({ kind: 'permanent', filter: { creature: true, controller: 'opp' } });
  if (/target (?:attacking|blocking|attacking or blocking) creature/.test(lc)) {
    return wrap({ kind: 'permanent', filter: { creature: true, attacking: /attacking/.test(lc) } });
  }
  if (/target creature/.test(lc)) return wrap({ kind: 'permanent', filter: { creature: true } });
  if (/target planeswalker/.test(lc)) return wrap({ kind: 'permanent', filter: { planeswalker: true } });
  if (/target (?:nonland )?permanent/.test(lc)) return wrap({ kind: 'permanent', filter: /nonland/.test(lc) ? { nonland: true } : {} });
  if (/target artifact or enchantment/.test(lc)) return wrap({ kind: 'permanent', filter: { artifactOrEnchantment: true } });
  if (/target artifact or creature/.test(lc)) return wrap({ kind: 'permanent', filter: { artifactOrCreature: true } });
  if (/target artifact/.test(lc)) return wrap({ kind: 'permanent', filter: { artifact: true } });
  if (/target enchantment/.test(lc)) return wrap({ kind: 'permanent', filter: { enchantment: true } });
  if (/target land/.test(lc)) return wrap({ kind: 'permanent', filter: { land: true } });
  return null;
}

/** The first target a card's own cast requires, read from its text. */
export function deriveTargetSpec(card) {
  for (const line of effectLines(card?.oracle_text)) {
    const spec = specFromText(line);
    if (spec) return spec;
  }
  return null;
}

/** "Enchant creature" -> the permanent an Aura has to be attached to. */
export function deriveEnchantSpec(card) {
  const text = String(card?.oracle_text || '');
  if (!/\bAura\b/.test(card?.type_line || '') && !/^Enchant /m.test(text)) return null;
  const m = text.match(/^Enchant ([^\n(]+)/m);
  if (!m) return { kind: 'permanent', filter: { creature: true } };
  return specFromText(`target ${m[1].trim()}`) || { kind: 'permanent', filter: {} };
}

/* ------------------------------------------------------------------ */
/* The check the server runs when a player reports a card              */
/* ------------------------------------------------------------------ */

const RESTRICTION_PATTERNS = [
  { re: /can'?t attack or block/i, kinds: ['cannotAttack', 'cannotBlock'] },
  { re: /can'?t block/i, kinds: ['cannotBlock'] },
  { re: /can'?t attack/i, kinds: ['cannotAttack'] },
  { re: /can'?t be blocked/i, kinds: ['unblockable'] },
];

/**
 * Compare what the card says with what the engine will actually do, and return
 * the findings plus any correction that can be derived from them.
 *
 * `probe` supplies the engine's own view of the card (script + computed target
 * requirements + automation status); it is passed in so this module stays free
 * of engine imports and the server can answer a report without a live game.
 */
export function analyseCard(card, probe, note = '') {
  const findings = [];
  const text = String(card?.oracle_text || '');
  const typeLine = String(card?.type_line || '');
  const isAura = /\bAura\b/.test(typeLine);
  const required = probe?.requiredTargets || [];
  const castRequired = probe?.castRequiredTargets || [];
  const automation = probe?.automation || 'unknown';

  if (text) findings.push({ ok: true, text: `The card is in the pool. Script status: ${automation}.` });

  // 1. Targets the printed text demands.
  const neededSpec = deriveTargetSpec(card);
  const enchantSpec = deriveEnchantSpec(card);
  if (enchantSpec && !isAura) {
    findings.push({ warn: true, text: 'Its text reads like an Aura\'s enchant line but the type line is not an Aura.' });
  }
  if (isAura) {
    findings.push(required.some((s) => s.filter?.creature || s.filter?.land || s.kind === 'permanent')
      ? { ok: true, text: 'It is an Aura, and the engine asks for something to enchant before letting it resolve.' }
      : { bad: true, text: 'It is an Aura, but the engine will not ask what it enchants.' });
  }
  if (neededSpec && !castRequired.length) {
    findings.push({
      bad: true,
      text: `Its text targets "${describeSpecText(neededSpec)}", but the engine does not ask for one — so the spell would resolve with no target. This is a gap that can be closed automatically.`,
    });
  } else if (neededSpec) {
    findings.push({ ok: true, text: `Its text targets ${describeSpecText(neededSpec)}, and the engine asks for it.` });
  }

  // 2. Restrictions the printed text states.
  const statics = probe?.statics || [];
  for (const { re, kinds } of RESTRICTION_PATTERNS) {
    if (!re.test(text)) continue;
    const has = kinds.every((k) => statics.some((s) => s.kind === k));
    findings.push(has
      ? { ok: true, text: `"${re.source}" is implemented — it is applied to the creature the card refers to.` }
      : { bad: true, text: `"${re.source}" is in the text but the engine does not apply it.` });
  }

  // 3. Known-unsupported wording: be straight about it.
  const unsupported = [];
  if (/choose new targets/i.test(text)) unsupported.push('choosing new targets for a copy');
  if (/you may cast .* without paying/i.test(text)) unsupported.push('alternative costs');
  if (/\bconspire\b|\breplicate\b|\boverload\b|\bconvoke\b|\bdelve\b/i.test(text)) unsupported.push('keyword costs beyond mana');
  if (unsupported.length) {
    findings.push({ warn: true, text: `Not modelled yet: ${unsupported.join(', ')}. The card still resolves, using the simplest reading of the rest of its text.` });
  }

  // 4. Aura attach behaviour.
  if (isAura && !/\bAura\b/.test(typeLine)) findings.push({ warn: true, text: 'Type line is missing the Aura subtype.' });

  const corrections = [];
  if (neededSpec && !castRequired.length && !isAura) {
    corrections.push({ kind: 'targets', targets: [neededSpec], note: `deriveTargetSpec(${card.name}) from the printed text` });
  }
  if (isAura && !castRequired.length) {
    corrections.push({ kind: 'targets', targets: [corrections.length ? null : (probe?.auraSpec || { kind: 'permanent', filter: { creature: true } })].filter(Boolean), note: 'Aura must be given something to enchant' });
  }

  const verdict = corrections.length
    ? 'Thanks — that was a real gap. A correction has been saved and is used from now on.'
    : findings.some((f) => f.bad)
      ? 'Thanks — the report is recorded. The engine disagrees with its own script on this one; it is queued for a hand-written fix rather than a guess.'
      : 'The engine already plays this card the way the printed text reads. The report is still recorded with your note.';

  return {
    name: card?.name || '(unknown card)',
    note: String(note || '').slice(0, 500),
    findings,
    corrections,
    verdict,
  };
}

function describeSpecText(spec) {
  if (!spec) return 'something';
  if (spec.kind === 'spell') return spec.filter?.creature ? 'a creature spell' : spec.filter?.noncreature ? 'a noncreature spell' : 'a spell';
  if (spec.kind === 'player') return 'a player';
  const f = spec.filter || {};
  if (f.land) return 'a land';
  if (f.creature) return 'a creature';
  if (f.nonland) return 'a nonland permanent';
  if (f.artifact) return 'an artifact';
  if (f.enchantment) return 'an enchantment';
  return 'a permanent';
}
