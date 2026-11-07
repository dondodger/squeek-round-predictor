/* Render the profile table exactly as profile.js does, from the real API payload,
   and print what each cell will say. Verifies the new Verdict column by reading
   the same fields the page reads — since the live page needs a wallet to show it. */
const API = "https://squeekround.my.id/api/points/profile/";
const ADDR = "0x702e0c3f4e3cde76c6838f90f34e698779912556";

(async () => {
  const r = await fetch(API + ADDR);
  const p = await r.json();
  const resting = p.wheel && p.wheel.stuck;
  const restLabel = "wheel resting";
  console.log(`points=${p.points} scored=${p.scored} hits=${p.hits} | resting=${resting}\n`);
  console.log("Round | Your call | Wheel did | Verdict | Points");
  console.log("-".repeat(78));
  for (const rr of (p.recent || []).slice(0, 20)) {
    const did = rr.outcome ? (rr.outcome === "expired" ? "not graded" : rr.outcome)
      : resting ? restLabel : "pending";
    const pts = rr.award === undefined || rr.award === null ? "\u2014" : rr.award ? "+" + rr.award : "0";
    const hit = rr.outcome && rr.outcome === rr.choice;
    const verdict = rr.outcome
      ? (rr.outcome === "expired" ? "window closed"
        : hit ? "hit" : `missed (you called ${rr.choice}, wheel ${did})`)
      : did;
    console.log(`${rr.round} | ${rr.choice} | ${rr.outcome && rr.outcome !== "expired" ? did : did} | ${verdict} | ${pts}`);
  }
  console.log("\nexpired rows (no longer stuck pending):");
  for (const rr of (p.recent || []).filter((x) => x.outcome === "expired")) {
    console.log(`   R${rr.round}  choice=${rr.choice}  outcome=expired  award=${rr.award}`);
  }
})();
