/* End-to-end proof against the LIVE server: lock a call on the round the clock
   is currently in, and confirm the server keeps it PENDING instead of grading
   it on the spot. This is the exact sequence Don hit.
   Run: node probe_pending_live.js */
const GENESIS = 1793735400, DUR = 600;
const API = "https://squeekround.my.id/api/points";

(async () => {
  const core = await (await fetch("https://api.squeekchain.com/v1/core")).json();
  const g = Number(core.configuration.genesisTimestamp);
  const d = Number(core.configuration.roundDuration);

  const now = Math.floor(Date.now() / 1000);
  const curRound = Math.floor((now - g) / d);
  const endsIn = (g + (curRound + 1) * d) - now;

  console.log("=== where the clock is ===");
  console.log(`  current round : ${curRound}`);
  console.log(`  ends in       : ${Math.floor(endsIn / 60)}m ${endsIn % 60}s`);
  console.log();

  /* is the chain already publishing a settlement for the LIVE round? */
  const setl = await (await fetch("https://api.squeekchain.com/v1/settlements")).json();
  const rounds = (setl.recentSettlements || []).map((s) => Number(s.settledThroughRound));
  const openSettled = rounds.includes(curRound);
  console.log("=== the trap ===");
  console.log(`  settled rounds published : ${rounds.slice(0, 6).join(", ")}`);
  console.log(`  is the LIVE round (${curRound}) already settled by the chain? ${openSettled ? "YES  <-- old code graded instantly here" : "no"}`);
  console.log();

  /* server-side: what does settle() decide for this round right now? */
  const points = require("./lib/points");
  const A = "0x8888888888888888888888888888888888888888";
  const p = points.player(A);
  p.rounds[String(curRound)] = { choice: "zoomies", sig: null, at: new Date().toISOString() };
  p.rounds[String(curRound - 1)] = { choice: "zoomies", sig: null, at: new Date().toISOString() };
  const map = { [curRound]: 43, [curRound - 1]: 43 };   // chain says both did 43
  points.settle(p, map);

  console.log("=== after settle() with the chain claiming both rounds are done ===");
  for (const r of [curRound, curRound - 1]) {
    const rec = p.rounds[String(r)];
    const verdict = rec.outcome ? rec.outcome : "still pending";
    console.log(`  R${r}: ${verdict}${r === curRound ? "   <-- must stay pending, round is still open" : "   <-- must be graded, round is behind the clock"}`);
  }
})();
