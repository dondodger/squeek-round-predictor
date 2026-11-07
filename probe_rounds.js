/* Don: "I picked zoomies with 4+ minutes left, and it settled instantly."
   Hypothesis: the browser and the chain count ROUNDS from the same genesis but
   disagree on the boundaries, so the round the page shows (and signs) is not
   the round the chain settles. That would let a call land on an already-settled
   round and be graded the instant it arrives.
   Run: node probe_rounds.js */
const GENESIS = 1793735400;   // 2026-11-03T19:50:00Z
const DUR = 600;

const rnd = (ms) => Math.floor(ms / 1000 - GENESIS) / 0;   // placeholder

/* what the browser does (public/app.js currentRound) */
function browserRound(nowMs, cfg) {
  const now = Math.floor(nowMs / 1000);
  if (now < cfg.genesisTimestamp) return 0;
  return Math.floor((now - cfg.genesisTimestamp) / cfg.roundDuration);
}
/* what the chain does (round N covers [genesis + N*DUR, genesis + (N+1)*DUR)) */
function chainRound(nowMs) {
  return Math.floor((Math.floor(nowMs / 1000) - GENESIS) / DUR);
}

(async () => {
  const core = await (await fetch("https://api.squeekchain.com/v1/core")).json();
  const c = core.configuration;
  const setl = await (await fetch("https://api.squeekchain.com/v1/settlements")).json();
  const cfg = {
    genesisTimestamp: Number(c.genesisTimestamp),
    roundDuration: Number(c.roundDuration),
  };

  console.log("=== the config both sides use ===");
  console.log(`  genesisTimestamp: ${cfg.genesisTimestamp}`);
  console.log(`  roundDuration   : ${cfg.roundDuration}`);
  console.log();

  /* 1) do browser and chain agree on a plain wall-clock read? */
  console.log("=== browser vs chain round, sampled ===");
  const probes = [
    ["R479 boundary", Date.parse("2026-11-07T03:40:00Z")],
    ["Don's R479 call", Date.parse("2026-11-07T03:49:27.683Z")],
    ["R480 boundary", Date.parse("2026-11-07T03:50:00Z")],
    ["Don's R480 call", Date.parse("2026-11-07T03:50:31.598Z")],
    ["now", Date.now()],
  ];
  for (const [label, ms] of probes) {
    const b = browserRound(ms, cfg);
    const ch = chainRound(ms);
    console.log(`  ${label.padEnd(18)} browser=${b}  chain=${ch}  ${b === ch ? "agree" : "*** DISAGREE ***"}`);
  }
  console.log();

  /* 2) does the browser's config actually carry these fields? */
  console.log("=== does the page get genesisTimestamp/roundDuration? ===");
  console.log("  core.configuration keys:", Object.keys(c).join(", "));
  console.log();

  /* 3) the settlement timestamps vs the rounds they claim to settle */
  console.log("=== settlement timestamps vs their own round numbers ===");
  for (const s of (setl.recentSettlements || []).slice(0, 6)) {
    const r = Number(s.settledThroughRound);
    const endMs = (GENESIS + r * DUR) * 1000;
    const ts = Date.parse(s.blockTimestamp);
    const late = (ts - endMs) / 1000;
    console.log(`  R${r}: round ends ${new Date(endMs).toISOString()}  settled ${s.blockTimestamp}  (${late >= 0 ? "+" : ""}${late}s)`);
  }

  console.log(`
=== what this means ===
A round R runs from genesis+R*600 to genesis+(R+1)*600. If the page ever
labels a call with a round whose window has already closed — or the chain
settles a round before the page thinks it ended — then the moment the call
arrives it is already gradable, and the player sees it hit/miss instantly
instead of waiting out the round.
`);
})();
