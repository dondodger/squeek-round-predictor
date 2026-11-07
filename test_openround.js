/* A call on a round the clock has not finished must stay pending, even when the
   chain has already published a settlement for it.
   Don hit this: he called zoomies with minutes left on the clock and it settled
   instantly — the chain had settled that very round because the wheel had
   already done enough work, and settle() graded against it on the spot.
   Run: node test_openround.js */
const assert = require("assert");
const path = require("path");
const fs = require("fs");

const GENESIS = 1793735400;
const DUR = 600;

/* mirror of the guard inside lib/points.js settle() */
function gradable(round, nowMs) {
  const nowRound = Math.floor((Math.floor(nowMs / 1000) - GENESIS) / DUR);
  return round < nowRound;
}

/* a fixed "now" for the assertions: inside round 481 */
const IN_R481 = (GENESIS + 481 * DUR + 200) * 1000;   // 200s into round 481
const IN_R482 = (GENESIS + 482 * DUR + 5) * 1000;     // 5s into round 482
const END_R481 = (GENESIS + 482 * DUR) * 1000;        // exactly the boundary

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};

t(`round 481 is NOT gradable while the clock is in round 481 (Don's case)`, () => {
  assert.strictEqual(gradable(481, IN_R481), false,
    "the chain may have settled 481 already, but its window is still open");
});

t("round 480 IS gradable while the clock is in round 481", () => {
  assert.strictEqual(gradable(480, IN_R481), true);
});

t("round 479 IS gradable while the clock is in round 481", () => {
  assert.strictEqual(gradable(479, IN_R481), true);
});

t("round 481 becomes gradable the moment round 482 starts", () => {
  assert.strictEqual(gradable(481, IN_R481), false);
  assert.strictEqual(gradable(481, END_R481), true);
});

t("round 482 is NOT gradable inside round 482", () => {
  assert.strictEqual(gradable(482, IN_R482), false);
});

t("a future round is never gradable", () => {
  assert.strictEqual(gradable(483, IN_R481), false);
  assert.strictEqual(gradable(500, IN_R481), false);
});

t("the boundary itself is exclusive: r == nowRound stays pending", () => {
  assert.strictEqual(gradable(481, IN_R481), false);
  assert.strictEqual(gradable(482, IN_R482), false);
});

t("every round strictly behind the clock is gradable", () => {
  for (let r = 470; r < 481; r++) {
    assert.strictEqual(gradable(r, IN_R481), true, `r${r} should be gradable`);
  }
});

/* integration: settle() must skip an open round even when handed a settlement
   for it, and must grade an older one from the same map. */
t("settle(): an open round with a settlement present stays pending", () => {
  /* use whatever ledger the runner handed us; only back it up if it is there,
     and put it back in a finally so a failure cannot leak state into later cases */
  const DB = process.env.SQUEER_POINTS || path.join(__dirname, ".test-openround-ledger.json");
  process.env.SQUEER_POINTS = DB;
  const bak = DB + ".test-openround";
  const had = fs.existsSync(DB);
  if (had) fs.copyFileSync(DB, bak);
  try {
    const points = require("./lib/points");
    points.setConfig({ genesisTimestamp: String(GENESIS), roundDuration: String(DUR) });
    const A = "0x9999999999999999999999999999999999999999";
    const p = points.player(A);
    /* pretend the clock is inside 481 by using the real now: the live round is
       whatever it is, so derive the open round and use it plus one behind it */
    const nowRound = Math.floor((Math.floor(Date.now() / 1000) - GENESIS) / DUR);
    p.rounds = {
      [String(nowRound)]: { choice: "zoomies", sig: null, at: new Date().toISOString() },
      [String(nowRound - 1)]: { choice: "zoomies", sig: null, at: new Date().toISOString() },
    };
    /* the chain has settled BOTH — the open one because the wheel worked fast */
    const m = { [nowRound]: 43, [nowRound - 1]: 43 };
    points.settle(p, m);
    assert.strictEqual(p.rounds[String(nowRound)].outcome, undefined,
      "the open round must stay pending");
    assert.strictEqual(p.rounds[String(nowRound - 1)].outcome, "zoomies",
      "the closed round must still be graded");
  } finally {
    /* only restore a ledger we actually backed up */
    if (had && fs.existsSync(bak)) { fs.copyFileSync(bak, DB); fs.unlinkSync(bak); }
  }
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
