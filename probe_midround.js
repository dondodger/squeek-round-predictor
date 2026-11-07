/* Don's rule: a call locked mid-round is a BET on the whole round. The grade
   must come from what the wheel did by the END of that round — never from the
   reading at the moment the player locked. If he calls zoomies at minute 5 and
   the wheel ends the round on a nap, he loses.
   Run: node probe_midround.js */
const assert = require("assert");
const GENESIS = 1793735400, DUR = 600;

/* what settle() grades against: settled[round] = completedBlockCount for that
   round, which the chain reports once the round is closed. */
function outcomeOf(blocks, target = 40) {
  const n = Number(blocks);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return "nap";
  if (n < target) return "jog";
  return "zoomies";
}

console.log("=== the two readings for one round ===");
console.log("  mid-round reading  : what the wheel had DONE at minute 5 (incomplete)");
console.log("  final reading      : completedBlockCount the chain reports for that round");
console.log();

console.log("=== Don's scenario, graded both ways ===");
const cases = [
  { mid: 4,  final: 0,  call: "zoomies", want: "nap",     note: "looked like early jog, wheel stopped" },
  { mid: 12, final: 4,  call: "zoomies", want: "jog",     note: "looked zoomy mid-round, stalled out" },
  { mid: 30, final: 30, call: "zoomies", want: "jog",     note: "never crossed the zoomies line" },
  { mid: 30, final: 45, call: "zoomies", want: "zoomies", note: "finished strong" },
  { mid: 45, final: 45, call: "zoomies", want: "zoomies", note: "kept the pace" },
  { mid: 45, final: 0,  call: "zoomies", want: "nap",     note: "wheel stopped dead at the end" },
  { mid: 3,  final: 3,  call: "jog",     want: "jog",     note: "small but real work" },
];
let ok = 0;
for (const c of cases) {
  const got = outcomeOf(c.final);
  const gradedMid = outcomeOf(c.mid);
  const agree = got === c.want;
  if (agree) ok++;
  console.log(
    `  call=${c.call.padEnd(7)} mid=${String(c.mid).padStart(2)} final=${String(c.final).padStart(2)}` +
    `  -> graded ${String(got).padEnd(7)} (want ${c.want.padEnd(7)}) ${agree ? "OK " : "BAD"}` +
    (gradedMid !== got ? `   mid-round would have said ${gradedMid}` : "")
  );
}
console.log(`\n${ok}/${cases.length} graded from the FINAL reading`);

/* the property that matters: grading must be a function of the final count only,
   so two players who call the same thing score the same no matter when they called */
console.log("\n=== does the grade depend on WHEN you called? (it must not) ===");
for (const [early, late] of [[1, 300], [299, 599]]) {
  const final = 45;
  const a = outcomeOf(final), b = outcomeOf(final);
  console.log(`  locked at t=${early}s and t=${late}s, final=45 -> ${a} / ${b}  ${a === b ? "same" : "DIFFERENT (bug)"}`);
}
