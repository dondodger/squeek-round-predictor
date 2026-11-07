/* Correct Don's round 480 record: he called zoomies, the wheel did zoomies
   (43 blocks >= 40), the point was never paid because the old code recorded a
   stale grade. R479 stays a miss (jog vs zoomies) — Don confirmed that one.
   Backs up points.json first. */
const fs = require("fs");
const path = "/home/ubuntu/squeek-round-predictor/points.json";
const ADDR = "0x702e0c3f4e3cde76c6838f90f34e698779912556";
const POINTS = { hit: 10, zoomies: 15 };

const db = JSON.parse(fs.readFileSync(path, "utf8"));
const p = db.players[ADDR];
if (!p) { console.error("player not found"); process.exit(1); }

console.log("BEFORE:");
console.log(`  points=${p.points} scored=${p.scored} hits=${p.hits} streak=${p.streak}`);
for (const r of ["479", "480"]) console.log(`  R${r}:`, JSON.stringify(p.rounds[r]));

const rec = p.rounds["480"];
if (!rec) { console.error("R480 missing"); process.exit(1); }
if (rec.choice === "zoomies") { console.log("\nalready zoomies — nothing to do"); process.exit(0); }

fs.copyFileSync(path, path + ".bak-r480");
console.log(`\nbackup -> ${path}.bak-r480`);

/* what the signed call was vs what the record says */
rec.choice = "zoomies";
rec.outcome = "zoomies";
rec.blocks = 43;
rec.award = POINTS.zoomies;
rec.corrected = {
  at: new Date().toISOString(),
  reason: "recorded grade did not match the signed call; client re-read state.choice after the wallet prompt, server trusted the body",
  was: "jog",
};
p.points += POINTS.zoomies;
p.hits += 1;
p.byCall.jog = Math.max(0, (p.byCall.jog || 0) - 1);
p.byCall.zoomies = (p.byCall.zoomies || 0) + 1;
/* R479 remains graded (miss), so scored is unchanged; streak = 1 for the R480 hit */
p.streak = 1;
if (p.bestStreak < 1) p.bestStreak = 1;

fs.writeFileSync(path, JSON.stringify(db, null, 2) + "\n");

console.log("\nAFTER:");
console.log(`  points=${p.points} scored=${p.scored} hits=${p.hits} streak=${p.streak} accuracy=${Math.round((p.hits / p.scored) * 100)}%`);
for (const r of ["479", "480"]) console.log(`  R${r}:`, JSON.stringify(p.rounds[r]));
