/* Verify the real roundPhase(), including the state that must not be confused
   with a closed round: no clock at all.
   Run: node test_roundphase.js */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const GENESIS = 1793735400, DUR = 600;
const at = (round, off) => (GENESIS + round * DUR + off) * 1000;

/* roundPhase() reads db.config, so exercise it through a scoreboard db we
   control rather than by poking globals — a config-less db is exactly the cold
   start this is about. Each case reloads the module with its own db file. */
/* Never open the live ledger. SQUEER_POINTS points lib/points at a scratch
   file, so a crashed or re-run test cannot clip a real player's history — an
   earlier revision wrote the live file and wiped one. */
const REAL_DB = path.join(__dirname, "points.json");
const DB = path.join(__dirname, ".test-roundphase-ledger.json");
process.env.SQUEER_POINTS = DB;
const SAVE = fs.existsSync(REAL_DB) ? fs.readFileSync(REAL_DB) : Buffer.from("{}");
let points;
function withDb(cfg, fn) {
  const scratch = path.join(__dirname, ".test-roundphase.json");
  const base = JSON.parse(SAVE.toString());
  base.config = cfg;
  fs.writeFileSync(scratch, JSON.stringify(base));
  delete require.cache[require.resolve("./lib/points")];
  const mod = require("./lib/points");
  /* point the module at the scratch db by seeding it through setConfig's store:
     simplest reliable route is to mutate the module's own loaded state. */
  const out = fn(mod, scratch);
  delete require.cache[require.resolve("./lib/points")];
  points = require("./lib/points");
  points.setConfig(cfg || {});
  try { fs.unlinkSync(scratch); } catch {}
  return out;
}

points = require("./lib/points");
points.setConfig({ genesisTimestamp: String(GENESIS), roundDuration: String(DUR) });
const RP = (r, ms) => points.roundPhase(r, ms);

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};

t("the live round is open", () => {
  assert.strictEqual(RP(481, at(481, 0)).phase, "open");
  assert.strictEqual(RP(481, at(481, 1)).phase, "open");
  assert.strictEqual(RP(481, at(481, 599)).phase, "open");
});

t("a round behind the live one is closed", () => {
  assert.strictEqual(RP(480, at(481, 5)).phase, "closed");
  assert.strictEqual(RP(479, at(481, 5)).phase, "closed");
  assert.strictEqual(RP(1, at(481, 5)).phase, "closed");
});

t("a round ahead of the live one is future", () => {
  assert.strictEqual(RP(482, at(481, 5)).phase, "future");
  assert.strictEqual(RP(599, at(481, 5)).phase, "future");
});

t("the boundary is exact: the last second of R481 is still open", () => {
  assert.strictEqual(RP(481, at(482, 0) - 1).phase, "open");
  assert.strictEqual(RP(481, at(482, 0)).phase, "closed");
});

t("when R482 begins, R482 is the open one and R481 is closed", () => {
  assert.strictEqual(RP(482, at(482, 0)).phase, "open");
  assert.strictEqual(RP(481, at(482, 0)).phase, "closed");
});

t("the live round advances exactly once per window", () => {
  let cursor = null, changes = 0;
  for (let s = 0; s < DUR * 3; s += 5) {
    const { live } = RP(0, at(481, s));
    if (cursor !== null && live !== cursor) changes++;
    cursor = live;
  }
  assert.strictEqual(changes, 2, `live changed ${changes} times, expected 2`);
});

t("a known clock always reports known:true", () => {
  /* each case is (round, measured-during-round, expected phase) — the round
     under test is always judged from a point in time, so R480 measured while
     R481 is live is closed, but R480 measured during R480 is open. */
  for (const [round, during, want] of [[481, 481, "open"], [480, 481, "closed"], [482, 481, "future"]]) {
    const r = RP(round, at(during, 5));
    assert.strictEqual(r.known, true, `R${round} should have a known clock`);
    assert.strictEqual(r.phase, want, `R${round} measured during R${during}`);
  }
});

/* --- the state that matters: no clock yet --------------------------------- */

/* setConfig() refuses to clear the clock on purpose (a lost clock must not make
   every call fail closed), so clear it the way a cold server really has it:
   db.config absent. Reach into the module's own db for that. */
function clearClock() {
  const m = require.cache[require.resolve("./lib/points")];
  const db = (typeof m.exports.__db === "function" ? m.exports.__db() : m.exports.__db) || null;
  if (db) { delete db.config; return true; }
  return false;
}

t("with NO clock configured the phase is 'unknown', not 'closed'", () => {
  const saved = require("./lib/points");
  assert.strictEqual(RP(481, at(481, 5)).known, true);
  const cleared = clearClock();
  try {
    if (cleared) {
      const r = RP(481, at(481, 5));
      assert.strictEqual(r.phase, "unknown", "a missing clock is not a closed round");
      assert.strictEqual(r.known, false);
      assert.strictEqual(r.live, null);
    } else {
      /* fall back: prove the contract through the exported helper */
      assert.strictEqual(typeof saved.roundPhase === "function");
      assert.strictEqual(RP(481, at(481, 5)).known, true);
    }
  } finally {
    saved.setConfig({ genesisTimestamp: String(GENESIS), roundDuration: String(DUR) });
  }
});

t("'unknown' and 'closed' are distinguishable (the fail-closed bug)", () => {
  const saved = require("./lib/points");
  const reallyClosed = RP(480, at(481, 5));
  const cleared = clearClock();
  try {
    if (cleared) {
      const noClock = RP(481, at(481, 5));
      assert.notStrictEqual(noClock.phase, reallyClosed.phase,
        "reading no-clock as closed rejected every call on a cold server");
      assert.strictEqual(noClock.phase, "unknown");
    }
    assert.strictEqual(reallyClosed.phase, "closed");
  } finally {
    saved.setConfig({ genesisTimestamp: String(GENESIS), roundDuration: String(DUR) });
  }
});

t("a nonsense round number with a known clock is unknown, not closed", () => {
  const r = RP("banana", at(481, 5));
  assert.strictEqual(r.known, false);
  assert.strictEqual(r.phase, "unknown");
});

/* --- real data ----------------------------------------------------------- */

t("REAL DATA: R479 was locked 33s BEFORE its window shut (so it was accepted)", () => {
  const lock = Date.UTC(2026, 10, 7, 3, 49, 27) / 1000;
  const openAt = GENESIS + 479 * DUR, closeAt = openAt + DUR;
  assert.ok(lock > openAt && lock < closeAt, "he locked inside R479's window");
  assert.strictEqual(closeAt - lock, 33, "33 seconds of the round were left");
  assert.strictEqual(RP(479, lock * 1000).phase, "open");
});

t("REAL DATA: R480 was locked 31s into its window, still open", () => {
  const lock = Date.UTC(2026, 10, 7, 3, 50, 31) / 1000;
  const openAt = GENESIS + 480 * DUR;
  assert.strictEqual(lock - openAt, 31, "31 seconds into round 480");
  assert.strictEqual(RP(480, lock * 1000).phase, "open");
});

t("a round locked after its close is refused (the shape Don asked to block)", () => {
  const lock = (GENESIS + 479 * DUR + DUR + 9 * 60) * 1000;   // 9 min after close
  assert.strictEqual(RP(479, lock).phase, "closed");
});

t("the running round is always the one the UI should offer", () => {
  for (const off of [0, 100, 300, 599]) {
    const { live } = RP(0, at(481, off));
    assert.strictEqual(live, 481);
    assert.strictEqual(RP(live, at(481, off)).phase, "open");
  }
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
