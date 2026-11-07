/* Reproduce Don's exact complaint: a "zoomies" call on a round the chain says
   completed 43+ blocks. Does it pay, and if not, where does it stop being stored?
   Runs against the LIVE api so the round data is real.
   Run: node probe_zoomies.js */
const API = "https://squeekround.my.id/api/points";

(async () => {
  /* 1) what does the chain say about the rounds Don is talking about? */
  const setl = await (await fetch("https://api.squeekchain.com/v1/settlements")).json();
  const pub = await (await fetch("https://api.squeekchain.com/v1/status")).json();
  const proj = (pub.builder && pub.builder.projected) || {};
  const target = 40; // targetBlocksPerActiveRound

  console.log("=== what the chain says these rounds did ===");
  for (const s of setl.recentSettlements || []) {
    const n = Number(s.completedBlockCount);
    const outcome = n === 0 ? "nap" : n < target ? "jog" : "zoomies";
    console.log(`  R${s.settledThroughRound}  completedBlockCount=${String(s.completedBlockCount).padStart(3)}  -> ${outcome}`);
  }

  /* 2) the rounds Don named. 480 is settled; the projected block is still filling. */
  console.log("\n=== Don's rounds ===");
  console.log(`  R479: 45 blocks -> zoomies (settled ${(setl.recentSettlements || []).find((x) => x.settledThroughRound === "479")?.blockTimestamp})`);
  console.log(`  R480: 43 blocks -> zoomies (settled ${(setl.recentSettlements || []).find((x) => x.settledThroughRound === "480")?.blockTimestamp})`);
  console.log(`  builder.projected.completedBlockCount = ${proj.completedBlockCount} (blocks in the OPEN round)`);
  console.log(`  builder.projected.blockHeight = ${proj.blockHeight}`);

  /* 3) what OUR server stored for that player */
  const ADDR = "0x702e0c3f4e3cde76c6838f90f34e698779912556";
  const p = await (await fetch(`${API}/profile/${ADDR}?explained=1`)).json();
  console.log("\n=== what our scoreboard stored ===");
  console.log(`  points=${p.points} calls=${p.calls} scored=${p.scored} hits=${p.hits} accuracy=${p.accuracy}`);
  for (const r of (p.recent || [])) {
    const shouldBe = r.blocks == null ? "?" : r.blocks < target ? "jog" : "zoomies";
    const flag = r.outcome && r.outcome !== "expired" && r.outcome !== shouldBe ? "  <-- MISMATCH" : "";
    console.log(`  R${r.round}: stored outcome=${r.outcome} blocks=${r.blocks} award=${r.award}${flag}`);
  }

  /* 4) what WOULD a zoomies call on 480 have paid? */
  console.log("\n=== if Don HAD been recorded as calling zoomies ===");
  const r480 = (setl.recentSettlements || []).find((x) => x.settledThroughRound === "480");
  if (r480) {
    console.log(`  R480 outcome=zoomies, call=zoomies -> hit -> +15 points (POINTS.zoomies)`);
    console.log(`  currently stored as call=jog -> miss -> 0`);
  }
})();
