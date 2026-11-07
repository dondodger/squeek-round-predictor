"use strict";

/**
 * Reads the wheel's own telemetry so the UI can tell two very different states
 * apart:
 *
 *   - a call that is queued behind an unsettled round  -> pending, wait for it
 *   - a call whose round can never be graded           -> resting, do nothing
 *
 * The chain only writes a settlement when the physical wheel actually produced
 * blocks. If the wheel stops, rounds keep closing on the clock (600s each) but
 * nothing is ever graded. We watched 42 consecutive rounds close with zero SQK
 * minted while the odometer sat frozen at 11048 — the UI called every one of
 * those calls "pending" forever.
 *
 * The odometer is the tell: cumulativeWorkUnits only ever goes up while the
 * wheel turns. A frozen odometer plus a still wheel means no work is coming.
 */

const STALL_ROUNDS_DEFAULT = 3;

/** Parse a possibly-stringy numeric field, strictly. Missing stays missing. */
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Turn a /v1/status payload into a small, explicit verdict about the wheel.
 *
 * @param {object} status   parsed /v1/status body
 * @param {object} [prev]   previous reading, to detect a frozen odometer
 * @returns {{turning:boolean, rpm:number|null, odometer:number|null,
 *            distanceMm:number|null, coreStatus:string, provenance:string,
 *            freshness:string, stuck:boolean, reason:string|null}}
 */
function readWheel(status, prev) {
  const s = status || {};
  const m = s.measurement || {};

  const rpm = num(m.rpmMilli);
  const odometer = num(m.cumulativeWorkUnits);
  const distanceMm = num(m.distanceMm);
  const coreStatus = String(m.coreStatus || "").toUpperCase();
  const provenance = String(m.provenance || "");
  const freshness = String(m.freshness || "");

  /* The wheel is turning if the sensor says so. rpmMilli is thousandths of a
     revolution per minute, so >0 is real movement, not rounding noise. */
  const turning = (rpm !== null && rpm > 0) || coreStatus === "ACTIVE";

  /* A frozen odometer across two readings is the stronger signal: the sensor
     can report online while the wheel sits still. */
  let odometerFrozen = false;
  if (prev && odometer !== null) {
    const before = num(prev.odometer);
    if (before !== null && odometer === before) odometerFrozen = true;
  }

  const stuck = !turning && (odometerFrozen || coreStatus === "IDLE");

  let reason = null;
  if (stuck) {
    reason = odometerFrozen
      ? "the wheel has not turned since the last reading"
      : "the core reports IDLE";
  } else if (freshness && freshness !== "online") {
    reason = `sensor reports ${freshness}`;
  }

  return {
    turning,
    rpm,
    odometer,
    distanceMm,
    coreStatus: coreStatus || "UNKNOWN",
    provenance,
    freshness,
    stuck,
    reason,
  };
}

/**
 * Classify why a call has no outcome yet. This is the distinction the UI was
 * missing: "we are waiting" is not the same as "nothing is coming".
 *
 * There are three answers, not two, and the middle one matters:
 *
 *   pending  — the chain is producing; the round just has not sealed yet.
 *   stalled  — the wheel has stopped, but not for long enough to conclude
 *              anything. A single zero-work round is a real outcome (the chain
 *              produced one at round 499, and play resumed on the very next
 *              round), so a brief pause must not read as a dead wheel.
 *   resting  — stopped, and a run of zero-work rounds says this is not a pause.
 *              Nothing is coming, so there is nothing to score.
 *
 * Only `resting` is a confident judgement. Callers that gate play must test for
 * that state specifically and keep accepting calls in the other two — refusing
 * on `stalled` would close the game on an ordinary quiet round, and refusing on
 * a missing reading would close it every time the explorer hiccups.
 *
 * @param {object} args
 * @param {number|null} args.stalledRounds  rounds closed with zero work since
 * @param {object|null} args.wheel          result of readWheel()
 * @param {number} [args.threshold]         rounds of zero work before resting
 * @returns {{state:"pending"|"stalled"|"resting", label:string, detail:string}}
 */
function callState(args) {
  const a = args || {};
  const stalled = num(a.stalledRounds) ?? 0;
  const threshold = num(a.threshold) ?? STALL_ROUNDS_DEFAULT;
  const wheel = a.wheel || null;

  if (wheel && wheel.stuck && stalled >= threshold) {
    return {
      state: "resting",
      label: "wheel resting",
      detail:
        "The wheel is not turning, so no blocks are being produced. " +
        "There is nothing to score yet — this is not a queue.",
    };
  }

  /* Stopped, but the evidence is not in yet. Report the pause honestly without
     claiming the wheel is done — the earlier code returned `resting` here, which
     made one quiet round look identical to a dead chain. */
  if (wheel && wheel.stuck) {
    return {
      state: "stalled",
      label: "wheel stalled",
      detail:
        "The wheel has paused. Calls stay open while we wait to see whether " +
        "it turns again — a single quiet round is normal.",
    };
  }

  return {
    state: "pending",
    label: "pending",
    detail: "Waiting for the chain to seal this round. Rounds seal every 10 minutes.",
  };
}

/**
 * Count how many of the chain's recent rounds closed with zero blocks produced.
 * A round that minted nothing is a round the wheel spent asleep.
 */
function stalledRounds(settlements) {
  const rounds = (settlements && settlements.recentRounds) || [];
  let n = 0;
  for (const r of rounds) {
    const minted = num(r.sqkMintedBaseUnits);
    if (minted === 0) n++;
    else break;
  }
  return n;
}

module.exports = { readWheel, callState, stalledRounds, STALL_ROUNDS_DEFAULT };
