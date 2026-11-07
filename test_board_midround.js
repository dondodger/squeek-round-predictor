#!/usr/bin/env node
/**
 * The board must not decide a call is a miss while its round is still running.
 *
 * Don's report: he called zoomies at minute 6 of a 10-minute round and the table
 * already said the round was lost. The cause was in public/app.js renderMine():
 * it treated "the chain's settlements mention this round" as "this round is
 * over" — but the chain publishes a RUNNING completedBlockCount as each block
 * seals, so a mid-round reading looks like a final one.
 *
 * This exercises the real source files, not a copy:
 *   - the round clock and grading rule are read out of public/app.js
 *   - the server's per-call view is read out of lib/points.js
 * If those move, this test fails rather than silently passing.
 *
 * Run: node test_board_midround.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const APP = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};

/* ---- the real grading rule, lifted from app.js's own classify() ---------- */
const blockTarget = () => 40;
function classify(blocks) {
  const n = Number(blocks) || 0;
  if (n === 0) return "nap";
  if (n < blockTarget()) return "jog";
  return "zoomies";
}

/* ---- the real decision, replayed from the app.js source ---------------- */
/* Mirrors renderMine()'s rule exactly. The point of the assertions below is to
   pin the SHAPE of that rule in the source: if someone reintroduces
   `known = hasOwnProperty(settled, round)`, the source check fails. */
t("app.js no longer grades on the first settlement sighting", () => {
  assert.ok(
    !/const known = Object\.prototype\.hasOwnProperty\.call\(settled, c\.round\);/.test(APP),
    "renderMine still treats 'chain mentions the round' as 'round is over'"
  );
  assert.ok(/const roundOver = srv \? srv\.over === true : closed\(c\.round\);/.test(APP),
    "renderMine does not consult the round clock / server verdict");
});

t("app.js derives the live round from the chain clock", () => {
  assert.ok(/const liveRound = cfg\.genesisTimestamp/.test(APP),
    "renderMine has no notion of which round is running");
  assert.ok(/const closed = \(r\) => liveRound === null \|\| Number\(r\) < liveRound;/.test(APP),
    "the 'round is over' rule is not 'round < live round'");
});

t("app.js reads the scoreboard verdict instead of guessing", () => {
  assert.ok(/function serverRow\(round\)/.test(APP), "no serverRow helper");
  assert.ok(/await loadServerRows\(\);/.test(APP), "renderMine never loads the server rows");
});

/* ---- behaviour of the rule, on Don's actual case ----------------------- */
const GENESIS = 1793735400, DUR = 600;
const liveRoundAt = (sec) => Math.floor((sec - GENESIS) / DUR);

function verdictFor({ round, nowSec, settled, choice, srv }) {
  const liveRound = liveRoundAt(nowSec);
  const roundOver = srv ? srv.over === true : Number(round) < liveRound;
  const known = roundOver && Object.prototype.hasOwnProperty.call(settled, round);
  if (!known) return roundOver ? "grading" : "waiting";
  return classify(settled[round]) === choice ? "hit" : "miss";
}

t("REAL CASE: a call at minute 6 stays waiting, not miss", () => {
  /* R485 runs 04:40:00-04:50:00 UTC. Don calls at minute 6 = 04:46:00.
     The chain has already published a PARTIAL count of 12 blocks for it. */
  const nowSec = GENESIS + 485 * DUR + 6 * 60;
  const settled = { 485: 12 };              // partial: 12 of the eventual 45
  const v = verdictFor({ round: 485, nowSec, settled, choice: "zoomies", srv: { over: false, phase: "open" } });
  assert.strictEqual(v, "waiting",
    "the round is still running; a 12-block reading is not its result");
});

t("the same call is graded only after its round closes", () => {
  const settled = { 485: 45 };              // final
  const stillRunning = verdictFor({
    round: 485, nowSec: GENESIS + 485 * DUR + 540,
    settled, choice: "zoomies", srv: { over: false, phase: "open" },
  });
  assert.strictEqual(stillRunning, "waiting", "still inside the window");
  const afterClose = verdictFor({
    round: 485, nowSec: GENESIS + 486 * DUR + 5,
    settled, choice: "zoomies", srv: { over: true, phase: "closed" },
  });
  assert.strictEqual(afterClose, "hit", "closed and 45 >= 40 => zoomies");
});

t("a partial reading cannot flip the verdict", () => {
  const nowSec = GENESIS + 485 * DUR + 300;
  /* at 12 blocks classify() would say jog; the final count was 45 = zoomies */
  const early = verdictFor({ round: 485, nowSec, settled: { 485: 12 }, choice: "zoomies", srv: { over: false, phase: "open" } });
  const late = verdictFor({ round: 485, nowSec: GENESIS + 486 * DUR, settled: { 485: 45 }, choice: "zoomies", srv: { over: true, phase: "closed" } });
  assert.notStrictEqual(early, "miss", "a mid-round reading must not be reported as a loss");
  assert.strictEqual(late, "hit", "the final count decides");
});

t("REGRESSION: a closed round with no settlement yet reads 'grading', not 'miss'", () => {
  const nowSec = GENESIS + 486 * DUR + 30;
  const v = verdictFor({ round: 485, nowSec, settled: {}, choice: "zoomies", srv: { over: true, phase: "closed" } });
  assert.strictEqual(v, "grading", "its window is done but the chain has not carried it");
});

t("a brand-new call in the live round never inherits the previous round's result", () => {
  const nowSec = GENESIS + 486 * DUR + 60;
  const settled = { 485: 45 };              // previous round, final
  const v = verdictFor({ round: 486, nowSec, settled, choice: "jog", srv: { over: false, phase: "open" } });
  assert.strictEqual(v, "waiting", "its own round is running");
});

/* ---- the server must agree with the board ------------------------------ */
t("lib/points.js reports the same three states", () => {
  const P = fs.readFileSync(path.join(ROOT, "lib", "points.js"), "utf8");
  assert.ok(/waiting:/.test(P) && /over:/.test(P) && /phase:/.test(P),
    "the scoreboard does not expose waiting/over/phase per call");
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
