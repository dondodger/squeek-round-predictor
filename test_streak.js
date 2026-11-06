/**
 * Tests for the streak bonus curve in lib/points.js.
 *
 * The bonus used to be a flat +5 once you reached a streak of 3, which made a
 * streak of 9 worth exactly as much as a streak of 3 — the reward stopped
 * rewarding. It now climbs with the streak, so the tests pin the curve down and
 * make sure the early tax is not so steep that a first hit feels cheap.
 *
 * The bands, and why:
 *   1-2   nothing extra. A streak has to be earned before it pays.
 *   3-4   +5    modest, keeps the first reward reachable.
 *   5-6   +10
 *   7-8   +15
 *   9+    +25   a nine-round run is one in roughly 500 at even odds; it should
 *               feel like something.
 */
const assert = require("assert");

const points = require("./lib/points");

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

console.log("streak bonus");

ok("band 0-2 pays no bonus", () => {
  assert.strictEqual(points.streakBonus(0), 0);
  assert.strictEqual(points.streakBonus(1), 0);
  assert.strictEqual(points.streakBonus(2), 0);
});

ok("band 3-4 pays 5", () => {
  assert.strictEqual(points.streakBonus(3), 5);
  assert.strictEqual(points.streakBonus(4), 5);
});

ok("band 5-6 pays 10", () => {
  assert.strictEqual(points.streakBonus(5), 10);
  assert.strictEqual(points.streakBonus(6), 10);
});

ok("band 7-8 pays 15", () => {
  assert.strictEqual(points.streakBonus(7), 15);
  assert.strictEqual(points.streakBonus(8), 15);
});

ok("band 9+ pays 25 and keeps paying", () => {
  assert.strictEqual(points.streakBonus(9), 25);
  assert.strictEqual(points.streakBonus(10), 25);
  assert.strictEqual(points.streakBonus(50), 25);
});

ok("the curve never goes backwards", () => {
  let prev = -1;
  for (let s = 0; s <= 30; s++) {
    const b = points.streakBonus(s);
    assert.ok(b >= prev, `bonus dropped at streak ${s}: ${prev} -> ${b}`);
    prev = b;
  }
});

ok("rubbish input is treated as no streak, not a crash", () => {
  assert.strictEqual(points.streakBonus(null), 0);
  assert.strictEqual(points.streakBonus(undefined), 0);
  assert.strictEqual(points.streakBonus(-3), 0);
  assert.strictEqual(points.streakBonus("x"), 0);
  assert.strictEqual(points.streakBonus(NaN), 0);
});

/* --- the bonus is actually wired into settle(), not just defined --- */
ok("settle(): a 3rd consecutive hit pays 10 base + 5 bonus", () => {
  const p = {
    address: "0xabc",
    points: 0,
    calls: 0,
    scored: 0,
    hits: 0,
    streak: 2, // two hits already banked
    bestStreak: 2,
    byCall: { nap: 0, jog: 0, zoomies: 0 },
    rounds: { 900: { choice: "jog" } },
  };
  points.settle(p, { 900: 20 }); // jog again -> 3rd straight
  assert.strictEqual(p.rounds[900].outcome, "jog");
  assert.strictEqual(p.streak, 3);
  assert.strictEqual(p.rounds[900].award, 10 + 5, "award=" + p.rounds[900].award);
});

ok("settle(): a 5th consecutive hit pays 10 base + 10 bonus", () => {
  const p = {
    address: "0xabc",
    points: 0,
    calls: 0,
    scored: 0,
    hits: 0,
    streak: 4,
    bestStreak: 4,
    byCall: { nap: 0, jog: 0, zoomies: 0 },
    rounds: { 901: { choice: "jog" } },
  };
  points.settle(p, { 901: 20 });
  assert.strictEqual(p.streak, 5);
  assert.strictEqual(p.rounds[901].award, 20, "award=" + p.rounds[901].award);
});

ok("settle(): zoomies still pays its own higher base", () => {
  const p = {
    address: "0xabc",
    points: 0,
    calls: 0,
    scored: 0,
    hits: 0,
    streak: 0,
    bestStreak: 0,
    byCall: { nap: 0, jog: 0, zoomies: 0 },
    rounds: { 902: { choice: "zoomies" } },
  };
  points.settle(p, { 902: 48 });
  assert.strictEqual(p.rounds[902].award, 15, "award=" + p.rounds[902].award);
});

ok("settle(): a miss resets the streak and pays nothing", () => {
  const p = {
    address: "0xabc",
    points: 0,
    calls: 0,
    scored: 0,
    hits: 0,
    streak: 7,
    bestStreak: 7,
    byCall: { nap: 0, jog: 0, zoomies: 0 },
    rounds: { 903: { choice: "jog" } },
  };
  points.settle(p, { 903: 0 }); // nap
  assert.strictEqual(p.streak, 0);
  assert.strictEqual(p.rounds[903].award, 0);
  assert.strictEqual(p.bestStreak, 7, "best streak must survive a miss");
});

console.log("\n" + pass + "/11 passed");
