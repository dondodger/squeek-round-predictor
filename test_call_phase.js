#!/usr/bin/env node
/**
 * Every call must report its own round's real state, computed at read time.
 *
 * Don's report, third time of asking: rounds that are long finished still read
 * as pending/waiting, and a call he makes now reads waiting forever. The cause
 * was in lib/points.js publicView():
 *
 *   .map(([r, v]) => ({ round: Number(r), ...v }))
 *
 * It returned the stored record verbatim. phase / waiting / over were written
 * into the record ONCE (by an earlier revision) and then read back stale
 * forever, so `over` was permanently false and nothing ever left "waiting".
 *
 * This test reads the real module and asserts the derived fields come from the
 * clock. If someone goes back to returning `...v` alone, this fails.
 *
 * Run: node test_call_phase.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

process.env.SQUEER_POINTS = process.env.SQUEER_POINTS || path.join(__dirname, ".test-callphase-ledger.json");

const ROOT = __dirname;
const SRC = fs.readFileSync(path.join(ROOT, "lib", "points.js"), "utf8");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};

const GENESIS = 1793735400, DUR = 600;

/* ---- static: the shape of the fix must be in the source ---------------- */
t("publicView derives phase from the clock, not from the stored record", () => {
  assert.ok(/const slot = roundPhase\(round\);/.test(SRC),
    "publicView does not call roundPhase()");
  assert.ok(/phase,/.test(SRC), "phase is not emitted");
});

t("a round older than live is 'closed' => over true, waiting false", () => {
  const view = SRC.slice(SRC.indexOf("function publicView"));
  assert.ok(/over: phase === "closed"/.test(view),
    "over is not 'the window closed'");
  assert.ok(/waiting: !v\.outcome && phase === "open"/.test(view),
    "waiting is not 'my own round is the live one'");
});

t("there is a helper for time remaining", () => {
  assert.ok(/function secondsLeftInRound\(/.test(SRC), "no secondsLeftInRound()");
});

/* ---- behavioural: load the real module and drive it with a fixed clock -- */
const Module = require("module");
const fresh = () => {
  delete require.cache[require.resolve("./lib/points")];
  return require("./lib/points");
};

t("REAL CASE: a finished round is over, a running round is waiting", () => {
  const points = fresh();
  points.setConfig({ genesisTimestamp: String(GENESIS), roundDuration: String(DUR) });

  const p = points.player("0x1111111111111111111111111111111111111111");
  /* fake the ledger: one call in the live round, one in each of two past
     rounds, one of which is ungraded (the chain has not carried it) */
  const nowSec = Math.floor(Date.now() / 1000);
  const live = Math.floor((nowSec - GENESIS) / DUR);
  p.rounds = {
    [String(live)]:     { choice: "jog",     sig: null, at: new Date().toISOString() },
    [String(live - 1)]: { choice: "jog",     sig: null, at: new Date().toISOString(), outcome: "jog" },
    [String(live - 2)]: { choice: "zoomies", sig: null, at: new Date().toISOString() },
    "372":              { choice: "nap",     sig: null, at: new Date().toISOString(), outcome: "expired" },
  };

  const v = points.publicView(p);
  const by = (r) => v.recent.find((x) => x.round === r);

  const running = by(live);
  assert.strictEqual(running.phase, "open", "live round must be open");
  assert.strictEqual(running.waiting, true, "a call in the live round is waiting");
  assert.strictEqual(running.over, false, "the live round is not over");
  assert.ok(typeof running.endsIn === "number" && running.endsIn > 0,
    "the live round must report seconds remaining");

  const pastGraded = by(live - 1);
  assert.strictEqual(pastGraded.over, true, "a finished round is over");
  assert.strictEqual(pastGraded.waiting, false, "a finished round is not waiting");
  assert.strictEqual(pastGraded.endsIn, null, "only the live round has time left");

  const pastUngraded = by(live - 2);
  assert.strictEqual(pastUngraded.over, true, "a finished round is over even if ungraded");
  assert.strictEqual(pastUngraded.waiting, false,
    "an ungraded call in a finished round is NOT waiting — it is awaiting the grade");

  const ancient = by(372);
  assert.strictEqual(ancient.over, true, "R372 is over");
  assert.strictEqual(ancient.waiting, false, "R372 must never read as waiting");
});

t("no call is ever left without a phase", () => {
  const points = fresh();
  points.setConfig({ genesisTimestamp: String(GENESIS), roundDuration: String(DUR) });
  const p = points.player("0x2222222222222222222222222222222222222222");
  const nowSec = Math.floor(Date.now() / 1000);
  const live = Math.floor((nowSec - GENESIS) / DUR);
  p.rounds = {
    [String(live)]: { choice: "nap", sig: null, at: new Date().toISOString() },
    [String(live - 5)]: { choice: "nap", sig: null, at: new Date().toISOString() },
  };
  for (const row of points.publicView(p).recent) {
    assert.ok(["open", "closed", "future", "unknown"].includes(row.phase),
      `round ${row.round} has phase ${JSON.stringify(row.phase)}`);
  }
});

t("REGRESSION: stored-but-stale fields cannot win", () => {
  const points = fresh();
  points.setConfig({ genesisTimestamp: String(GENESIS), roundDuration: String(DUR) });
  const p = points.player("0x3333333333333333333333333333333333333333");
  const nowSec = Math.floor(Date.now() / 1000);
  const live = Math.floor((nowSec - GENESIS) / DUR);
  /* poison the record with the exact stale values the old code wrote */
  p.rounds = {
    [String(live - 3)]: {
      choice: "jog", sig: null, at: new Date().toISOString(), outcome: "jog",
      phase: "open", waiting: true, over: false,        // <- wrong on purpose
    },
  };
  const row = points.publicView(p).recent[0];
  assert.strictEqual(row.over, true, "the clock must override a stale 'over: false'");
  assert.strictEqual(row.waiting, false, "the clock must override a stale 'waiting: true'");
  assert.strictEqual(row.phase, "closed", "the clock must override a stale 'phase: open'");
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
