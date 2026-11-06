/**
 * Round archive — every settled round we have ever seen, kept locally.
 *
 * Why this exists: the chain API only exposes the last ten settlements and
 * archives the rest (204 settlements, 10 readable). A hit-rate computed off ten
 * rounds is a five-percent sample presented as a fact, which is worse than
 * saying nothing. So every time the site polls, we fold the settlements it can
 * see into this file. After a few days it holds hundreds of rounds and the
 * published percentages are real.
 *
 * It also makes the numbers OURS. If the API later hides settlements or changes
 * shape, the history we already collected keeps working.
 *
 * Storage: a flat JSON file, same convention as points.json — no database, no
 * dependencies, survives a restart.
 */
const fs = require("fs");
const path = require("path");

const DATA =
  process.env.SQUEER_ROUNDS || path.join(__dirname, "..", "rounds.json");

/* Keep the tail bounded. Rounds are ten minutes, so 5000 rounds is a bit over a
   month of history — far more than any published percentage needs, and small
   enough that the file stays trivial to read on every request. */
const MAX_ROWS = Number(process.env.SQUEER_ROUNDS_MAX) || 5000;

let state = { rounds: [] };
let byRound = new Map();
let loaded = false;

/**
 * Parse a round number from the API.
 *
 * Same trap as parseBlocks, and worth stating twice because it bit the tests:
 * Number("") is 0 and Number(null) is 0, and those both pass Number.isFinite —
 * so a blank round id would be filed as a real "round 0". Round ids start at 1,
 * so anything that is not a positive integer is rejected. Accepts any numeric
 * string (the API sends ids as strings).
 */
function parseRound(v) {
  if (typeof v === "number") {
    return Number.isFinite(v) && v > 0 ? Math.trunc(v) : null;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
  }
  return null;
}

/**
 * Parse a block count from the API.
 *
 * Returns null when the value does not represent a real count, and this is
 * deliberately STRICTER than Number(). Number(null) and Number("") are both 0,
 * and 0 is a valid reading (nap) — so a missing or blank field would be filed
 * as a real nap round and silently corrupt the statistics this module exists to
 * make honest. Only a genuine numeric value counts.
 */
function parseBlocks(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/* The game's own banding rule, identical to what the call is graded against:
   nothing moved, it jogged, or it beat the chain's 40-block target. */
function classify(blocks) {
  const b = typeof blocks === "number" ? blocks : parseBlocks(blocks);
  if (b === null) return null;
  if (b <= 0) return "nap";
  if (b >= 40) return "zoomies";
  return "jog";
}

function readFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA, "utf8"));
    const rows = Array.isArray(raw.rounds) ? raw.rounds : [];
    return rows
      .map((r) => ({
        round: Number(r.round),
        blocks: Number(r.blocks),
        band: r.band || classify(r.blocks),
      }))
      .filter((r) => Number.isFinite(r.round) && Number.isFinite(r.blocks));
  } catch {
    return [];
  }
}

function load(force) {
  if (loaded && !force) return;
  state.rounds = readFile();
  byRound = new Map(state.rounds.map((r) => [r.round, r]));
  loaded = true;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(DATA), { recursive: true });
    const tmp = DATA + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, rounds: state.rounds }));
    fs.renameSync(tmp, DATA);
  } catch (e) {
    /* A failing write must not take the page down: the stats simply stay at
       whatever was last durable. */
    console.error("rounds: could not persist —", e.message);
  }
}

/**
 * Fold settlements into the archive. Accepts the shape the chain API returns.
 * Returns how many rows were new or corrected.
 */
function ingest(settlements) {
  load();
  if (!Array.isArray(settlements)) return 0;
  let changed = 0;
  for (const s of settlements) {
    const round = parseRound(s && s.settledThroughRound);
    const blocks = parseBlocks(s && s.completedBlockCount);
    /* A settlement whose round id or block count will not parse is skipped
       outright. Number() would turn a blank field into 0 and file a bogus
       "round 0, nap" row — quietly corrupting the statistics this module exists
       to make honest. */
    if (round === null || blocks === null) continue;
    const band = classify(blocks);
    if (!band) continue;

    const prev = byRound.get(round);
    if (prev && prev.blocks === blocks) continue;
    const row = { round, blocks, band };
    if (prev) {
      prev.blocks = blocks;
      prev.band = band;
    } else {
      state.rounds.push(row);
      byRound.set(round, row);
    }
    changed++;
  }
  if (!changed) return 0;

  state.rounds.sort((a, b) => b.round - a.round);
  if (state.rounds.length > MAX_ROWS) {
    state.rounds = state.rounds.slice(0, MAX_ROWS);
    byRound = new Map(state.rounds.map((r) => [r.round, r]));
  }
  persist();
  return changed;
}

function all() {
  load();
  return state.rounds.slice();
}

function stats() {
  load();
  return { total: state.rounds.length };
}

/**
 * The honest hit-rate: how often each band actually fired across everything we
 * have collected, with the sample size attached so a caller can show it.
 */
function hitRate() {
  load();
  const counts = { nap: 0, jog: 0, zoomies: 0 };
  for (const r of state.rounds) counts[r.band]++;
  const sample = state.rounds.length;
  const share = (k) => (sample ? Math.round((counts[k] / sample) * 1000) / 10 : null);
  return {
    sample,
    counts,
    shares: {
      nap: share("nap"),
      jog: share("jog"),
      zoomies: share("zoomies"),
    },
    latestRound: sample ? state.rounds[0].round : null,
  };
}

/* Used by tests. */
function reset() {
  state = { rounds: [] };
  byRound = new Map();
  loaded = true;
  try {
    fs.unlinkSync(DATA);
  } catch {}
}
function reload() {
  loaded = false;
  load(true);
}

module.exports = { classify, parseRound, parseBlocks, ingest, all, stats, hitRate, reset, reload, MAX_ROWS };
