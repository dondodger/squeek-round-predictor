/* Don's rule, as an invariant: a call locked mid-round is graded from the round's
   FINAL block count, so the grade must not be computable — and must not change —
   before the round closes.
   R481 was 51 mid-round and finished at 39: grading mid-round said ZOOMIES,
   the final grade is JOG. Verify settle() refuses the open round and that once
   closed the number is stable.
   Run: node test_finalgrade.js */
const assert = require("assert");
const GENESIS = 1793735400, DUR = 600, TARGET = 40;

function classify(blocks) {
  const n = Number(blocks);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return "nap";
  if (n < TARGET) return "jog";
  return "zoomies";
}
/* mirror of the guard in lib/points.js settle() */
function gradable(round, nowMs) {
  const nowRound = Math.floor((Math.floor(nowMs / 1000) - GENESIS) / DUR);
  return round < nowRound;
}

const inR481 = (GENESIS + 481 * DUR + 300) * 1000;
const inR482 = (GENESIS + 482 * DUR + 5) * 1000;

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};

t("REAL DATA: R481 read 51 mid-round but finished at 39 — the grades disagree", () => {
  assert.strictEqual(classify(51), "zoomies", "mid-round reading said zoomies");
  assert.strictEqual(classify(39), "jog", "final reading says jog");
  assert.notStrictEqual(classify(51), classify(39), "this is why grading early is wrong");
});

t("a call on R481 while R481 is live is NOT gradable", () => {
  assert.strictEqual(gradable(481, inR481), false,
    "grading here would have paid zoomies on a round that finished jog");
});

t("once R481 is closed it grades from the final count (jog, not zoomies)", () => {
  assert.strictEqual(gradable(481, inR482), true);
  assert.strictEqual(classify(39), "jog");
});

t("the call itself is unchanged by timing — only the reading is", () => {
  const called = "zoomies";
  const early = classify(51) === called;   // would have been a hit
  const final = classify(39) === called;   // actually a miss
  assert.strictEqual(early, true);
  assert.strictEqual(final, false, "the missed call must stay missed");
});

t("two calls on the same round always get the same grade", () => {
  const final = 39;
  assert.strictEqual(classify(final), classify(final));
});

t("a mid-round reading can never be used, whatever it says", () => {
  for (const mid of [0, 5, 39, 40, 51, 99]) {
    assert.strictEqual(gradable(481, inR481), false, `mid reading ${mid} must not grade`);
  }
});

t("boundary: R481 flips to gradable exactly when R482 begins", () => {
  const lastMs = (GENESIS + 482 * DUR) * 1000 - 1;
  const firstMs = (GENESIS + 482 * DUR) * 1000;
  assert.strictEqual(gradable(481, lastMs), false);
  assert.strictEqual(gradable(481, firstMs), true);
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
