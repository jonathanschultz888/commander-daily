/**
 * Pulls real oracle data for the seed pool from Scryfall and writes:
 *   src/data/oracle.json        - full card data keyed by lowercase name
 *   src/data/gamechangers.json  - the official Game Changers list (Scryfall is:gamechanger)
 *   src/data/validation.json    - per-deck legality report (bracket, GC count, illegal cards)
 *
 * Scryfall asks for <10 req/sec; we use ~1 req per 150ms.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { SEED_DECKS, ALL_CARD_NAMES } from '../src/decks/lists.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'src', 'data');
const UA = 'CommanderDaily/0.1 (personal fan project)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sf(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`Scryfall ${res.status} on ${url}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function fetchGameChangers() {
  const names = [];
  let url = 'https://api.scryfall.com/cards/search?q=is%3Agamechanger&order=name';
  while (url) {
    const page = await sf(url);
    names.push(...page.data.map((c) => c.name));
    url = page.has_more ? page.next_page : null;
    await sleep(150);
  }
  return names.sort();
}

async function fetchCollection(names) {
  const out = new Map();
  const missing = [];
  for (let i = 0; i < names.length; i += 70) {
    const chunk = names.slice(i, i + 70);
    const res = await sf('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      body: JSON.stringify({ identifiers: chunk.map((name) => ({ name })) }),
    });
    for (const c of res.data) out.set(c.name.toLowerCase(), c);
    for (const nf of res.not_found || []) missing.push(nf.name);
    await sleep(150);
  }
  return { cards: out, missing };
}

function slim(c) {
  return {
    name: c.name,
    mana_cost: c.mana_cost ?? (c.card_faces ? c.card_faces.map((f) => f.mana_cost).join(' // ') : ''),
    cmc: c.cmc ?? 0,
    type_line: c.type_line ?? (c.card_faces ? c.card_faces.map((f) => f.type_line).join(' // ') : ''),
    oracle_text: c.oracle_text ?? (c.card_faces ? c.card_faces.map((f) => f.oracle_text || '').join('\n//\n') : ''),
    colors: c.colors ?? [],
    color_identity: c.color_identity ?? [],
    keywords: c.keywords ?? [],
    power: c.power ?? null,
    toughness: c.toughness ?? null,
    loyalty: c.loyalty ?? null,
    layout: c.layout,
    set: c.set,
    released_at: c.released_at,
    image: c.image_uris?.normal || c.image_uris?.large
      || (c.card_faces && (c.card_faces[0].image_uris?.normal || c.card_faces[0].image_uris?.large)) || null,
    back_image: (c.card_faces && c.card_faces[1] && c.card_faces[1].image_uris?.normal) || null,
    legal_commander: c.legalities?.commander ?? 'not_legal',
  };
}

const main = async () => {
  await fs.mkdir(DATA, { recursive: true });
  console.log('Fetching Game Changers list...');
  const gcs = await fetchGameChangers();
  await fs.writeFile(path.join(DATA, 'gamechangers.json'), JSON.stringify(gcs, null, 2));
  console.log(`  ${gcs.length} Game Changers`);

  const names = ALL_CARD_NAMES();
  console.log(`Fetching ${names.length} unique cards from Scryfall...`);
  const { cards, missing } = await fetchCollection(names);
  console.log(`  resolved ${cards.size}, missing ${missing.length}`);

  const oracle = {};
  for (const [key, c] of cards) oracle[key] = slim(c);
  await fs.writeFile(path.join(DATA, 'oracle.json'), JSON.stringify(oracle, null, 1));

  // Now that data is on disk, profile the decks with the real bracket logic.
  const { loadAllDecks, GAME_CHANGERS } = await import('../src/decks/index.js?fresh=' + Date.now());
  const gcSet = GAME_CHANGERS;
  const report = { generated: new Date().toISOString(), gameChangers: gcs.length, globalMissing: missing, decks: [] };

  for (const deck of SEED_DECKS) {
    const all = [deck.commander, ...deck.spells, ...deck.lands];
    const ci = deck.commander ? cards.get(deck.commander.toLowerCase())?.color_identity ?? [] : [];
    const offColor = all.filter((n) => {
      const c = cards.get(n.toLowerCase());
      if (!c) return false;
      return !c.color_identity.every((x) => ci.includes(x));
    });
    const illegal = all.filter((n) => {
      const c = cards.get(n.toLowerCase());
      return c && ['banned', 'not_legal'].includes(c.legalities?.commander);
    });
    const unresolved = all.filter((n) => !cards.has(n.toLowerCase()));
    report.decks.push({
      id: deck.id, name: deck.name, bracket: deck.bracket,
      declaredCount: 1 + deck.spells.length + deck.lands.length + Object.values(deck.basics).reduce((a, b) => a + b, 0),
      gameChangers: all.filter((n) => gcSet.has(n.toLowerCase())),
      illegal, unresolved, offColor,
    });
  }

  // enriched with real bracket profiling + final card counts
  const decks = loadAllDecks();
  report.decks = report.decks.map((d) => {
    const full = decks.find((x) => x.id === d.id);
    return { ...d, cardCount: full.total, profile: full.profile, violations: full.profile.violations };
  });
  await fs.writeFile(path.join(DATA, 'validation.json'), JSON.stringify(report, null, 2));

  console.log('\n=== VALIDATION ===');
  let bad = 0;
  for (const d of report.decks) {
    const flags = [];
    if (d.cardCount !== 100) flags.push(`SIZE ${d.cardCount}/100`);
    if (d.gameChangers.length) flags.push(`GC(${d.gameChangers.length}) ${d.gameChangers.join(', ')}`);
    if (d.illegal.length) flags.push(`ILLEGAL: ${d.illegal.join(', ')}`);
    if (d.unresolved.length) flags.push(`UNRESOLVED: ${d.unresolved.join(', ')}`);
    if (d.offColor.length) flags.push(`OFF-COLOR: ${d.offColor.join(', ')}`);
    if (d.violations.length) flags.push(`BRACKET: ${d.violations.join(' ; ')}`);
    const fatal = d.cardCount !== 100 || d.illegal.length || d.unresolved.length || d.offColor.length || d.violations.length;
    if (fatal) bad++;
    console.log(`[B${d.bracket}] ${d.name.padEnd(24)} ${d.cardCount} cards  ${flags.length ? '\n      ' + flags.join('\n      ') : 'CLEAN'}${fatal ? '  <== FIX' : ''}`);
    if (d.profile.combos.length) console.log(`      combos: ${d.profile.combos.map((c) => c.name).join(', ')}`);
  }
  if (missing.length) console.log('\nUnresolved names (typos?):', missing.join(', '));
  console.log(bad ? `\n${bad} deck(s) need attention` : '\nAll decks clean.');
};

main().catch((e) => { console.error(e); process.exit(1); });
