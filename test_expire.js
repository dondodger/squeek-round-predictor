/* A call whose round has scrolled out of the API's settlement window must end
   as "expired", not stay pending forever. This is the bug Don hit: R372 and
   R417 sat pending for hours because recentSettlements only carries the last
   ~10 rounds, and the presence check ran before the age check.
   Run: node test_expire.js */
/* scratch ledger only — never the live one */
const path = require("path");
process.env.SQUEER_POINTS = process.env.SQUEER_POINTS || path.join(__dirname, ".test-expire-ledger.json");
const points = require("./lib/points");
/* the clock drives roundPhase(): without it every round reads "unknown" and
   nothing can be graded, which is a different failure from what this checks */
points.setConfig({ genesisTimestamp: String(1793735400), roundDuration: String(600) });

let pass = 0, fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log("  ok   " + name);
  } catch (e) {
    fail++;
    console.log("  FAIL " + name + "\n       " + e.message);
  }
};
const eq = (a, b, m) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || ""} got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
};

/* the real shape of recentSettlements when Don's calls went pending:
   the window jumped 358 -> 479, leaving 372 and 417 in the hole */
const WINDOW_WITH_HOLE = {
  351: 43, 352: 38, 353: 26, 354: 33, 355: 50, 356: 8, 357: 48, 358: 2,
  479: 45, 480: 43,
};

function player(rounds) {
  return {
    address: "0xt", points: 0, calls: 0, scored: 0, hits: 0, streak: 0,
    bestStreak: 0, byCall: { nap: 0, jog: 0, zoomies: 0 }, rounds,
    firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
  };
}

t("a round in the hole goes EXPIRED, not pending forever", () => {
  const p = player({ 372: { choice: "nap", sig: null }, 417: { choice: "nap", sig: null } });
  const n = points.settle(p, WINDOW_WITH_HOLE);
  eq(p.rounds["372"].outcome, "expired", "R372 outcome");
  eq(p.rounds["417"].outcome, "expired", "R417 outcome");
  eq(p.rounds["372"].award, 0, "expired awards nothing");
  eq(n, 2, "both graded");
});

t("expired does not count as a scored call or a miss", () => {
  const p = player({ 372: { choice: "nap", sig: null } });
  points.settle(p, WINDOW_WITH_HOLE);
  eq(p.scored, 0, "scored stays 0 — nothing was gradeable");
  eq(p.hits, 0, "no hit");
  eq(p.streak, 0, "streak untouched");
  eq(p.points, 0, "no points");
});

t("a round still INSIDE the window and present grades normally", () => {
  const p = player({ 480: { choice: "zoomies", sig: null } });
  points.settle(p, WINDOW_WITH_HOLE);
  eq(p.rounds["480"].outcome, "zoomies", "43 blocks >= 40 -> zoomies");
  eq(p.rounds["480"].award, 15, "zoomies pays 15");
  eq(p.points, 15, "points credited");
});

t("a recent round that is merely absent stays pending (may still settle)", () => {
  /* 479 is inside the window (tip 480, age 20) but we pretend the API has not
     published it yet — it must NOT be expired, it might arrive next poll */
  const noTip = { 460: 12 };
  const p = player({ 479: { choice: "jog", sig: null } });
  points.settle(p, noTip);
  eq(p.rounds["479"].outcome, undefined, "still pending, not expired");
});

t("boundary: exactly tip-20 is still gradeable, tip-21 is expired", () => {
  const p = player({
    460: { choice: "jog", sig: null },  // tip-20
    459: { choice: "jog", sig: null },  // tip-21
  });
  points.settle(p, { 480: 43, 479: 45, 478: 12 });
  eq(p.rounds["459"].outcome, "expired", "tip-21 expired");
  eq(p.rounds["460"].outcome, undefined, "tip-20 not expired (absent, may still come)");
});

t("already-graded records are never re-touched", () => {
  const p = player({ 400: { choice: "jog", sig: null, outcome: "jog", award: 10 } });
  p.points = 10; p.scored = 1; p.hits = 1;
  points.settle(p, WINDOW_WITH_HOLE);
  eq(p.rounds["400"].outcome, "jog", "outcome preserved");
  eq(p.points, 10, "points preserved");
});

t("an empty settlement map expires nothing (chain unreachable)", () => {
  const p = player({ 372: { choice: "nap", sig: null } });
  const n = points.settle(p, {});
  eq(p.rounds["372"].outcome, undefined, "no tip -> no expiry, stays pending");
  eq(n, 0, "nothing graded");
});

t("Don's real case end to end", () => {
  const p = player({
    372: { choice: "nap", sig: null },
    417: { choice: "nap", sig: null },
    479: { choice: "jog", sig: null },
    480: { choice: "jog", sig: null },
  });
  points.settle(p, WINDOW_WITH_HOLE);
  eq(p.rounds["372"].outcome, "expired", "R372");
  eq(p.rounds["417"].outcome, "expired", "R417");
  eq(p.rounds["479"].outcome, "zoomies", "R479 gradeable");
  eq(p.rounds["480"].outcome, "zoomies", "R480 gradeable");
  eq(p.rounds["479"].award, 0, "jog vs zoomies = miss");
  eq(p.scored, 2, "only the two gradeable rounds counted");
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
