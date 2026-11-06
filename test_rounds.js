/**
 * Tests for lib/rounds.js — the round archive.
 *
 * The archive is what makes the grade card honest: it keeps every settled round
 * we have ever seen, so the hit-rate is computed off hundreds of rounds instead
 * of the ten the API happens to expose. If this ledger gets a round wrong the
 * published percentages are wrong, so the invariants are pinned down here:
 *
 *   1. ingest() is idempotent — the same settlement seen twice adds one row.
 *   2. classify() bands match the game's own rule (0 / 1-39 / 40+).
 *   3. hitRate() counts every band and reports the true sample size.
 *   4. The file survives a reload (persistence, not just in-memory).
 *   5. A settlement with an unparseable block count is skipped, not counted as
 *      zero — silently reading a malformed value as "nap" would quietly skew
 *      the very statistics this exists to make truthful.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "squeek-rounds-"));
process.env.SQUEER_ROUNDS = path.join(TMP, "rounds.json");

const rounds = require("./lib/rounds");

let pass = 0;
const ok = (name, fn) => {
  try {
    fn();
    console.log("  PASS  " + name);
    pass++;
  } catch (e) {
    console.log("  FAIL  " + name + "\n        " + e.message);
    process.exitCode = 1;
  }
};

console.log("rounds.js");

/* --- 1. classify matches the on-chain rule --- */
ok("classify: 0 is nap, 1-39 jog, 40+ zoomies", () => {
  assert.strictEqual(rounds.classify(0), "nap");
  assert.strictEqual(rounds.classify(1), "jog");
  assert.strictEqual(rounds.classify(39), "jog");
  assert.strictEqual(rounds.classify(40), "zoomies");
  assert.strictEqual(rounds.classify(999), "zoomies");
});

/* --- 2. ingest is idempotent --- */
ok("ingest: the same settlement twice yields one row", () => {
  rounds.reset();
  rounds.ingest([
    { settledThroughRound: "358", completedBlockCount: "48" },
    { settledThroughRound: "357", completedBlockCount: "2" },
  ]);
  rounds.ingest([
    { settledThroughRound: "358", completedBlockCount: "48" },
    { settledThroughRound: "357", completedBlockCount: "2" },
  ]);
  const s = rounds.stats();
  assert.strictEqual(s.total, 2, "expected 2 rows, got " + s.total);
});

/* --- 3. a changed value for a known round is corrected, not duplicated --- */
ok("ingest: a re-reported round updates in place", () => {
  rounds.reset();
  rounds.ingest([{ settledThroughRound: "358", completedBlockCount: "48" }]);
  rounds.ingest([{ settledThroughRound: "358", completedBlockCount: "50" }]);
  const s = rounds.stats();
  assert.strictEqual(s.total, 1, "expected 1 row, got " + s.total);
  assert.strictEqual(rounds.hitRate().counts.zoomies, 1);
});

/* --- 4. bad input is skipped, never read as zero --- */
ok("ingest: unparseable block count is skipped, not counted as nap", () => {
  rounds.reset();
  rounds.ingest([
    { settledThroughRound: "358", completedBlockCount: "48" },
    { settledThroughRound: "357", completedBlockCount: "--" },
    { settledThroughRound: "356", completedBlockCount: null },
    { settledThroughRound: "355", completedBlockCount: "" },
    { settledThroughRound: "354", completedBlockCount: undefined },
    { settledThroughRound: "", completedBlockCount: "12" },
  ]);
  const s = rounds.stats();
  assert.strictEqual(s.total, 1, "expected only the valid row, got " + s.total);
  assert.strictEqual(rounds.hitRate().counts.nap, 0, "a bad value became a nap");
});

/* --- 4b. the trap this caught: Number(null) === 0 and 0 is a valid reading --- */
ok("classify: null/blank is null, while a real 0 is still nap", () => {
  assert.strictEqual(rounds.classify(null), null, "null must not be nap");
  assert.strictEqual(rounds.classify(""), null, "blank must not be nap");
  assert.strictEqual(rounds.classify(undefined), null, "undefined must not be nap");
  assert.strictEqual(rounds.classify("--"), null);
  assert.strictEqual(rounds.classify(0), "nap", "a genuine zero IS a nap");
  assert.strictEqual(rounds.classify("0"), "nap", "a genuine '0' IS a nap");
  assert.strictEqual(rounds.classify(2), "jog");
  assert.strictEqual(rounds.classify("48"), "zoomies");
});

/* --- 5. hitRate reports the true sample size and shares --- */
ok("hitRate: counts every band and sums to the sample", () => {
  rounds.reset();
  rounds.ingest([
    { settledThroughRound: "358", completedBlockCount: "48" },
    { settledThroughRound: "357", completedBlockCount: "2" },
    { settledThroughRound: "356", completedBlockCount: "50" },
    { settledThroughRound: "355", completedBlockCount: "33" },
    { settledThroughRound: "354", completedBlockCount: "0" },
    { settledThroughRound: "353", completedBlockCount: "26" },
  ]);
  const h = rounds.hitRate();
  assert.strictEqual(h.sample, 6, "sample=" + h.sample);
  assert.strictEqual(h.counts.zoomies, 2);
  assert.strictEqual(h.counts.jog, 3);
  assert.strictEqual(h.counts.nap, 1);
  assert.strictEqual(h.counts.zoomies + h.counts.jog + h.counts.nap, h.sample);
});

/* --- 6. new rounds are ordered newest-first and capped --- */
ok("all(): newest round first", () => {
  rounds.reset();
  rounds.ingest([
    { settledThroughRound: "350", completedBlockCount: "10" },
    { settledThroughRound: "358", completedBlockCount: "20" },
    { settledThroughRound: "354", completedBlockCount: "30" },
  ]);
  const ids = rounds.all().map((r) => r.round);
  assert.deepStrictEqual(ids, [358, 354, 350], "got " + ids.join(","));
});

/* --- 7. it actually persists --- */
ok("persists to disk and reloads", () => {
  rounds.reset();
  rounds.ingest([{ settledThroughRound: "358", completedBlockCount: "48" }]);
  const raw = JSON.parse(fs.readFileSync(process.env.SQUEER_ROUNDS, "utf8"));
  assert.ok(Array.isArray(raw.rounds), "no rounds array on disk");
  assert.strictEqual(raw.rounds.length, 1);
  assert.strictEqual(raw.rounds[0].blocks, 48);
  assert.strictEqual(raw.rounds[0].band, "zoomies");
});

/* --- 8. seeded history loads and merges --- */
ok("seed: an existing file is loaded on first read", () => {
  rounds.reset();
  fs.writeFileSync(
    process.env.SQUEER_ROUNDS,
    JSON.stringify({
      rounds: [
        { round: 340, blocks: 0, band: "nap" },
        { round: 341, blocks: 12, band: "jog" },
      ],
    })
  );
  rounds.reload();
  const s = rounds.stats();
  assert.strictEqual(s.total, 2, "expected 2 seeded rows, got " + s.total);
  assert.strictEqual(rounds.hitRate().counts.nap, 1);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log("\n" + pass + "/9 passed");
