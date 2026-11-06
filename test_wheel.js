"use strict";

/**
 * Tests for lib/wheel.js — the module that tells "waiting" apart from
 * "nothing is coming". Real payloads are inlined: the frozen-wheel case is the
 * actual /v1/status reading we pulled on 2026-11-06 (odometer stuck at 11048,
 * 42 consecutive rounds minted zero).
 */

const assert = require("assert");
const wheel = require("./lib/wheel.js");

let pass = 0,
  fail = 0;

function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log("  PASS  " + name);
  } catch (e) {
    fail++;
    console.log("  FAIL  " + name);
    console.log("        " + e.message);
  }
}

/* ---- the real frozen reading, verbatim from the chain ---- */
const FROZEN = {
  measurement: {
    freshness: "online",
    counterEpoch: "c53e3951-4e69-4ad3-b59c-d122a064d15a",
    cumulativeWorkUnits: "11048",
    provenance: "hardware",
    coreStatus: "IDLE",
    rpmMilli: 0,
    speedMmPerSecond: 0,
    distanceMm: 0,
  },
};

/* ---- a wheel that is actually running ---- */
const RUNNING = {
  measurement: {
    freshness: "online",
    cumulativeWorkUnits: "11902",
    provenance: "hardware",
    coreStatus: "ACTIVE",
    rpmMilli: 42000,
    speedMmPerSecond: 380,
    distanceMm: 912340,
  },
};

ok("readWheel: a frozen wheel is reported as not turning", () => {
  const w = wheel.readWheel(FROZEN, { odometer: 11048 });
  assert.strictEqual(w.turning, false);
  assert.strictEqual(w.stuck, true);
  assert.strictEqual(w.odometer, 11048);
  assert.strictEqual(w.rpm, 0);
});

ok("readWheel: a running wheel is turning and not stuck", () => {
  const w = wheel.readWheel(RUNNING, { odometer: 11048 });
  assert.strictEqual(w.turning, true);
  assert.strictEqual(w.stuck, false);
});

ok("readWheel: string numbers are parsed, not string-compared", () => {
  const w = wheel.readWheel(FROZEN, { odometer: 11048 });
  assert.strictEqual(w.odometer, 11048);
  assert.strictEqual(typeof w.odometer, "number");
});

ok("readWheel: a moving odometer rescues an IDLE core", () => {
  /* coreStatus can lag a beat behind the sensor — trust the count going up. */
  const moved = {
    measurement: { ...FROZEN.measurement, cumulativeWorkUnits: "11049" },
  };
  const w = wheel.readWheel(moved, { odometer: 11048 });
  assert.strictEqual(w.stuck, true, "IDLE + still frozen odometer is stuck");
  const moving = {
    measurement: { ...FROZEN.measurement, cumulativeWorkUnits: "11049", rpmMilli: 12000 },
  };
  assert.strictEqual(wheel.readWheel(moving, { odometer: 11048 }).stuck, false);
});

ok("readWheel: missing measurement does not throw", () => {
  const w = wheel.readWheel({}, null);
  assert.strictEqual(w.turning, false);
  assert.strictEqual(w.odometer, null);
  assert.ok(/UNKNOWN/.test(w.coreStatus));
});

ok("stalledRounds: counts leading zero-mint rounds", () => {
  const s = {
    recentRounds: [
      { roundId: "417", sqkMintedBaseUnits: "0" },
      { roundId: "416", sqkMintedBaseUnits: "0" },
      { roundId: "415", sqkMintedBaseUnits: "0" },
      { roundId: "414", sqkMintedBaseUnits: "9000000000000000000" },
      { roundId: "413", sqkMintedBaseUnits: "0" },
    ],
  };
  assert.strictEqual(wheel.stalledRounds(s), 3);
});

ok("stalledRounds: a healthy chain returns zero", () => {
  const s = {
    recentRounds: [
      { roundId: "2", sqkMintedBaseUnits: "1000" },
      { roundId: "1", sqkMintedBaseUnits: "1000" },
    ],
  };
  assert.strictEqual(wheel.stalledRounds(s), 0);
});

ok("stalledRounds: real payload — all 42 rounds minted nothing", () => {
  const s = JSON.parse(JSON.stringify({ recentRounds: [] }));
  s.recentRounds = Array.from({ length: 42 }, (_, i) => ({
    roundId: String(376 + i),
    sqkMintedBaseUnits: "0",
  }));
  assert.strictEqual(wheel.stalledRounds(s), 42);
});

ok("stalledRounds: missing payload is zero, not a crash", () => {
  assert.strictEqual(wheel.stalledRounds(null), 0);
  assert.strictEqual(wheel.stalledRounds({}), 0);
});

ok("callState: a resting wheel is NOT called pending", () => {
  const w = wheel.readWheel(FROZEN, { odometer: 11048 });
  const st = wheel.callState({ wheel: w, stalledRounds: 42 });
  assert.strictEqual(st.state, "resting");
  assert.strictEqual(st.label, "wheel resting");
  assert.ok(!/pending/i.test(st.label), "must not say pending");
  assert.ok(/not a queue|nothing to score/i.test(st.detail), st.detail);
});

ok("callState: a turning wheel with a fresh round is pending", () => {
  const w = wheel.readWheel(RUNNING, { odometer: 11048 });
  const st = wheel.callState({ wheel: w, stalledRounds: 0 });
  assert.strictEqual(st.state, "pending");
  assert.ok(/10 minutes/i.test(st.detail), st.detail);
});

ok("callState: a wheel stuck for fewer rounds than the threshold still rests", () => {
  const w = wheel.readWheel(FROZEN, { odometer: 11048 });
  const st = wheel.callState({ wheel: w, stalledRounds: 0 });
  assert.strictEqual(st.state, "resting", "a stopped wheel never grades");
});

ok("callState: no wheel data falls back to pending rather than lying", () => {
  const st = wheel.callState({ wheel: null, stalledRounds: 0 });
  assert.strictEqual(st.state, "pending");
});

ok("callState: never returns the word 'pending' for a stuck wheel", () => {
  const w = wheel.readWheel(FROZEN, { odometer: 11048 });
  for (const n of [0, 1, 3, 10, 42, 999]) {
    const st = wheel.callState({ wheel: w, stalledRounds: n, threshold: 3 });
    assert.notStrictEqual(st.state, "pending", `stalledRounds=${n} leaked pending`);
    assert.ok(!/pending/i.test(st.label), `stalledRounds=${n} label leaked pending`);
  }
});

console.log("\n" + pass + "/" + (pass + fail) + " passed");
process.exit(fail ? 1 : 0);
