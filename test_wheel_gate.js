/**
 * Tests for the "wheel resting => closed for calls" gate.
 *
 * The rule being tested, stated once so the tests and the code cannot drift:
 *
 *   While the wheel is stuck and has been for at least STALL_ROUNDS_DEFAULT
 *   rounds, no call may be locked. The round is not a prediction — its outcome
 *   is already decided (zero work), so accepting a call would hand out points
 *   for a settled fact. This is the farming hole: watch the wheel die, call nap,
 *   collect.
 *
 *   A single stalled round is NOT enough to close the game. The chain produced a
 *   genuine one-round nap (round 499) and play resumed immediately after, so
 *   shutting the door on one quiet round would refuse real calls. The gate needs
 *   the sustained signal, which is what `stuck` plus a run of zero-work rounds
 *   describes.
 *
 *   `unknown` telemetry is not the same as a dead wheel: if the reading failed we
 *   must not refuse players, or an outage at the explorer would take the game
 *   down. Only a confident "stuck" closes the door.
 *
 * Run: node test_wheel_gate.js
 */

const assert = require("assert");
const wheel = require("./lib/wheel");

let pass = 0;
let fail = 0;

function t(name, fn) {
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

console.log("=== wheel gate: when may a call be locked? ===\n");

/* ---------------- the building block: callState() ---------------- */

t("a turning wheel leaves calls open", () => {
  const s = wheel.callState({ stalledRounds: 0, wheel: { stuck: false } });
  assert.strictEqual(s.state, "pending");
});

t("a stuck wheel below the threshold is a pause, not a rest", () => {
  // stuck for 1 round: a genuine nap. The state must say "paused", not "gone",
  // so callers keep the game open.
  const s = wheel.callState({ stalledRounds: 1, wheel: { stuck: true } });
  assert.strictEqual(s.state, "stalled");
});

t("a stuck wheel at the threshold is resting", () => {
  const s = wheel.callState({ stalledRounds: wheel.STALL_ROUNDS_DEFAULT, wheel: { stuck: true } });
  assert.strictEqual(s.state, "resting");
  assert.ok(s.label, "resting state must carry a label for the UI");
  assert.ok(s.detail, "resting state must explain itself to a player");
});

t("a stuck wheel well past the threshold is still resting", () => {
  const s = wheel.callState({ stalledRounds: 12, wheel: { stuck: true } });
  assert.strictEqual(s.state, "resting");
});

t("no wheel reading at all is NOT resting", () => {
  // telemetry gone: refuse? no. an outage must not close the game.
  const s = wheel.callState({ stalledRounds: 0, wheel: null });
  assert.strictEqual(s.state, "pending");
});

/* ---------------- the decision the server will make ---------------- */

/**
 * This mirrors what the submit handler will do. Kept here so the rule is
 * exercised without booting a server, and so both call sites read the same way.
 */
function mayLockCall({ stalledRounds, wheel: w, threshold }) {
  const s = wheel.callState({ stalledRounds, wheel: w, threshold });
  return s.state !== "resting";
}

t("gate: normal operation accepts calls", () => {
  assert.strictEqual(mayLockCall({ stalledRounds: 0, wheel: { stuck: false } }), true);
});

t("gate: one stalled round still accepts calls (the real round 499 case)", () => {
  assert.strictEqual(mayLockCall({ stalledRounds: 1, wheel: { stuck: true } }), true);
});

t("gate: two stalled rounds still accepts calls", () => {
  assert.strictEqual(mayLockCall({ stalledRounds: 2, wheel: { stuck: true } }), true);
});

t("gate: three stalled rounds refuses calls", () => {
  assert.strictEqual(mayLockCall({ stalledRounds: 3, wheel: { stuck: true } }), false);
});

t("gate: the live incident (12 stalled rounds) refuses calls", () => {
  assert.strictEqual(mayLockCall({ stalledRounds: 12, wheel: { stuck: true } }), false);
});

t("gate: explorer outage does not refuse calls", () => {
  assert.strictEqual(mayLockCall({ stalledRounds: 0, wheel: null }), true);
});

t("gate: stuck=false with many zero-work rounds still accepts", () => {
  // stalledRounds counts zero-work rounds, but if the wheel is turning again the
  // game is back on. Stuck is the authoritative half of the signal.
  assert.strictEqual(mayLockCall({ stalledRounds: 5, wheel: { stuck: false } }), true);
});

t("gate: a custom threshold is honoured", () => {
  assert.strictEqual(mayLockCall({ stalledRounds: 1, wheel: { stuck: true }, threshold: 1 }), false);
  assert.strictEqual(mayLockCall({ stalledRounds: 1, wheel: { stuck: true }, threshold: 2 }), true);
});

/* ---------------- stalledRounds() itself ---------------- */

t("stalledRounds counts the leading run of zero-mint rounds", () => {
  const n = wheel.stalledRounds({
    recentRounds: [
      { sqkMintedBaseUnits: 0 },
      { sqkMintedBaseUnits: 0 },
      { sqkMintedBaseUnits: "0" },
      { sqkMintedBaseUnits: 500 },
      { sqkMintedBaseUnits: 0 },
    ],
  });
  assert.strictEqual(n, 3, "must count only the leading run, then stop");
});

t("stalledRounds stops at the first round that minted", () => {
  const n = wheel.stalledRounds({
    recentRounds: [{ sqkMintedBaseUnits: 100 }, { sqkMintedBaseUnits: 0 }],
  });
  assert.strictEqual(n, 0);
});

t("stalledRounds copes with no data", () => {
  assert.strictEqual(wheel.stalledRounds(null), 0);
  assert.strictEqual(wheel.stalledRounds({}), 0);
  assert.strictEqual(wheel.stalledRounds({ recentRounds: [] }), 0);
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
