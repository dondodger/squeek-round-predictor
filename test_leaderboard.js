/*
 * test_leaderboard.js — the board must name players, not count them.
 *
 * The old /api/points/leaderboard returned stats(): totals with no names. A
 * newcomer opening it saw a scoreboard with the players filed off. These tests
 * pin the three properties that make it a ranking rather than a counter:
 *
 *   1. every player appears, ranked, with a name attached
 *   2. the order is deterministic and meaningful (points first)
 *   3. the limit is a limit — a huge ?limit cannot inflate the work
 *
 * Imports the real module. Mirrors nothing by hand: if lib/points.js changes
 * shape, these break, which is the point.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

/* Same guard rail as the other tests: a scratch ledger, never the live one. */
const SCRATCH = path.join(os.tmpdir(), `squeek-lb-${process.pid}.json`);
process.env.SQUEER_POINTS = SCRATCH;
process.env.SQUEER_TEST = "1";

fs.writeFileSync(
  SCRATCH,
  JSON.stringify({
    players: {
      // 30 points, 60% — should top the table
      "0xaaaa000000000000000000000000000000000001": {
        points: 30, calls: 10, scored: 5, hits: 3, streak: 0, bestStreak: 2,
        lastSeen: "2026-11-07T00:00:00.000Z", byCall: { nap: 5, jog: 5, zoomies: 0 },
      },
      // same 30 points, lower accuracy, more calls
      "0xbbbb000000000000000000000000000000000002": {
        points: 30, calls: 20, scored: 10, hits: 4, streak: 0, bestStreak: 1,
        lastSeen: "2026-11-07T00:00:00.000Z", byCall: { nap: 7, jog: 7, zoomies: 6 },
      },
      // never scored — must still get a row, at the bottom
      "0xcccc000000000000000000000000000000000003": {
        points: 0, calls: 1, scored: 0, hits: 0, streak: 0, bestStreak: 0,
        lastSeen: "2026-11-07T00:00:00.000Z", byCall: { nap: 0, jog: 1, zoomies: 0 },
      },
    },
    updatedAt: "2026-11-07T00:00:00.000Z",
  }),
  "utf8",
);

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
  }
}

const points = require("./lib/points");

console.log("leaderboard — names, not counts");

check("exports leaderboard()", () => {
  assert.strictEqual(typeof points.leaderboard, "function");
});

check("every player gets a ranked row", () => {
  const out = points.leaderboard();
  assert.strictEqual(out.players, 3, "player count");
  assert.strictEqual(out.leaderboard.length, 3, "row per player");
  assert.deepStrictEqual(
    out.leaderboard.map((r) => r.rank),
    [1, 2, 3],
    "ranks are 1..n in order",
  );
});

check("each row names the player (this is what was missing)", () => {
  const out = points.leaderboard();
  for (const row of out.leaderboard) {
    assert.ok(
      /^0x[a-fA-F0-9]{40}$/.test(row.address),
      `row ${row.rank} has an address, got ${row.address}`,
    );
  }
});

check("ranked by points, high to low", () => {
  const out = points.leaderboard();
  const pts = out.leaderboard.map((r) => r.points);
  assert.deepStrictEqual(pts, [...pts].sort((a, b) => b - a), "descending points");
  assert.strictEqual(out.leaderboard[0].points, 30, "leader has 30");
});

check("equal points break on accuracy, not call order", () => {
  const out = points.leaderboard();
  const [first, second] = out.leaderboard;
  assert.strictEqual(first.points, second.points, "precondition: same points");
  assert.ok(
    first.accuracy > second.accuracy,
    `higher accuracy ranks first: ${first.accuracy} vs ${second.accuracy}`,
  );
});

check("a zero-score player still appears, last", () => {
  const out = points.leaderboard();
  const last = out.leaderboard[out.leaderboard.length - 1];
  assert.strictEqual(last.points, 0, "last place has 0 points");
  assert.strictEqual(last.rank, 3, "and is ranked last");
});

check("accuracy is a real percentage, not a raw ratio", () => {
  const out = points.leaderboard();
  const leader = out.leaderboard[0];
  assert.strictEqual(leader.accuracy, 60, "3 hits of 5 scored = 60%");
});

check("limit truncates rows but not the player count", () => {
  const out = points.leaderboard({ limit: 2 });
  assert.strictEqual(out.shown, 2, "two rows shown");
  assert.strictEqual(out.players, 3, "player count unaffected by limit");
  assert.strictEqual(out.leaderboard.length, 2, "array honours limit");
});

check("an absurd limit cannot inflate the work", () => {
  const out = points.leaderboard({ limit: 1e9 });
  assert.strictEqual(out.shown, 3, "still only the real players");
  assert.ok(out.leaderboard.length <= 3, "no padded rows");
});

check("a negative limit degrades to none, not a crash", () => {
  const out = points.leaderboard({ limit: -5 });
  assert.strictEqual(out.leaderboard.length, 0, "empty, not thrown");
  assert.strictEqual(out.players, 3, "count still reported");
});

check("the ranking is stable across repeated reads", () => {
  const a = points.leaderboard().leaderboard.map((r) => r.address);
  const b = points.leaderboard().leaderboard.map((r) => r.address);
  assert.deepStrictEqual(a, b, "same order every time");
});

console.log(`\n${pass}/${pass + fail} passed`);
try {
  fs.unlinkSync(SCRATCH);
} catch (_) {}
if (fail) process.exit(1);
