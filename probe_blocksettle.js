/* Once a round is closed, is its completedBlockCount FINAL, or does the chain
   keep revising it? Don's rule needs the number to be frozen at round end —
   if it drifts after, a call graded at minute 10 could disagree with the same
   call graded at minute 20.
   Samples the same settled round repeatedly and watches for drift.
   Run: node probe_blocksettle.js */
const ROUNDS = Number(process.argv[2] || 6);
const EVERY = Number(process.argv[3] || 20) * 1000;

const GENESIS = 1793735400, DUR = 600;
const snap = async () => {
  const j = await (await fetch("https://api.squeekchain.com/v1/settlements")).json();
  const m = {};
  for (const s of j.recentSettlements || []) {
    m[Number(s.settledThroughRound)] = Number(s.completedBlockCount);
  }
  return m;
};

(async () => {
  console.log("=== watching settled rounds for revision ===");
  console.log("(if a round's block count changes after it settles, grading is not stable)\n");
  const seen = new Map();   // round -> [values...]
  let prev = null;

  for (let i = 0; i < ROUNDS; i++) {
    const m = await snap();
    const now = Math.floor(Date.now() / 1000);
    const cur = Math.floor((now - GENESIS) / DUR);
    for (const [r, b] of Object.entries(m)) {
      if (!seen.has(r)) seen.set(r, []);
      seen.get(r).push(b);
    }
    if (prev) {
      const changed = Object.keys(m).filter((r) => prev[r] !== undefined && prev[r] !== m[r]);
      console.log(`  t+${i * (EVERY / 1000)}s  live=round ${cur}  settled=${Object.keys(m).slice(0, 4).join(",")}  ${changed.length ? "*** CHANGED: " + changed.map((r) => `R${r} ${prev[r]}->${m[r]}`).join(", ") : "no change"}`);
    } else {
      console.log(`  t+0s   live=round ${cur}  settled=${Object.keys(m).slice(0, 4).join(",")}`);
    }
    prev = m;
    if (i < ROUNDS - 1) await new Promise((r) => setTimeout(r, EVERY));
  }

  console.log("\n=== verdict per round ===");
  for (const [r, vals] of [...seen.entries()].sort((a, b) => Number(b[0]) - Number(a[0]))) {
    const uniq = [...new Set(vals)];
    console.log(`  R${r}: saw ${vals.length}x  values=${uniq.join(", ")}  ${uniq.length > 1 ? "*** DRIFTS ***" : "stable"}`);
  }
})();
