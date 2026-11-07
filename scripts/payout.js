#!/usr/bin/env node
/**
 * squeek-round — weekly payout sheet.
 *
 * Prints the top three for a given week and the exact SQK amount each is owed.
 * It does NOT send anything. Paying out is a human act: read the sheet, open the
 * treasury in MetaMask, send three transfers. A script that moves funds while
 * nobody is watching is a script that can pay the wrong address once and be
 * wrong forever.
 *
 * Usage:
 *   node scripts/payout.js                  # the week that just closed
 *   node scripts/payout.js --week 1         # a specific week
 *   node scripts/payout.js --json           # machine-readable, for piping
 *   node scripts/payout.js --csv            # comma-separated, for a spreadsheet
 *
 * Week boundaries are Monday 00:00 UTC, counted from SQUEEK_SEASON_START
 * (default 2026-11-07). See lib/reward.js for the pool and the split.
 */

const path = require("path");
const reward = require(path.join(__dirname, "..", "lib", "reward"));

const WEEK_MS = 7 * 24 * 3600 * 1000;

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

function weekBounds(weekNo) {
  const start = new Date(reward.SEASON.startsAt).getTime();
  const from = start + (weekNo - 1) * WEEK_MS;
  return { from, to: from + WEEK_MS };
}

/**
 * A player is in the running only if they locked a call inside the window.
 * Calls made before the season or in an earlier week do not roll over — a
 * weekly prize for a cumulative score would be the same three names every week
 * and would stop rewarding anyone new for showing up.
 *
 * `rounds` is a map of roundNumber -> record, not an array. The points each
 * call actually earned live on the record (`award`, plus any `bonus` from a
 * streak), so the weekly total is read off the ledger rather than recomputed —
 * recomputing it here is how the sheet and the site would drift apart.
 */
function scoreWeek(from, to) {
  /* Read the ledger file directly rather than through the module's db handle:
     this is a reporting tool, and it must not be able to mutate the very file
     it is reporting on. */
  const file = path.join(__dirname, "..", "points.json");
  const ledger = JSON.parse(require("fs").readFileSync(file, "utf8"));
  const rows = [];

  for (const [addr, p] of Object.entries(ledger.players || {})) {
    const rounds = p.rounds && typeof p.rounds === "object" ? Object.entries(p.rounds) : [];
    let points = 0;
    let hits = 0;
    const played = [];

    for (const [roundNo, rec] of rounds) {
      const t = rec && rec.at ? Date.parse(rec.at) : NaN;
      if (!Number.isFinite(t) || t < from || t >= to) continue;
      played.push(roundNo);
      const award = Number(rec.award || 0);
      const bonus = Number(rec.bonus || 0);
      points += award + bonus;
      if (award > 0) hits += 1;
    }

    if (!played.length) continue;
    rows.push({ address: addr, points, calls: played.length, hits, rounds: played });
  }

  /* Tie-break the same way the board does: points, then hits, then fewer calls
     — consistency here matters, because a player who reads the board and then
     reads this sheet should never see two different orders. */
  rows.sort((a, b) => b.points - a.points || b.hits - a.hits || a.calls - b.calls);

  /* A prize is not paid for merely showing up. If only one player scored, one
     prize goes out — the pool is not "spend 150 every Monday no matter what",
     it is "the top three who actually scored share 150". Paying 45 SQK to a
     player with zero correct calls would make the pool look like a giveaway
     and would be the first thing anyone questioned. */
  return rows.filter((r) => r.points > 0);
}

async function main() {
  const s = reward.seasonInfo();
  const weekNo = Number(arg("week", s.week - 1)) || 1; // default: the week that closed
  const { from, to } = weekBounds(weekNo);
  const rows = scoreWeek(from, to);
  const prizes = reward.prizes();

  const winners = rows.slice(0, 3).map((r, i) => {
    const p = prizes[i] || { label: "-", amount: 0, pct: 0 };
    return { rank: i + 1, label: p.label, amount: p.amount, ...r };
  });

  const total = winners.reduce((n, w) => n + w.amount, 0);
  const pool = await reward.pool();

  if (arg("json")) {
    console.log(
      JSON.stringify(
        {
          week: weekNo,
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          treasury: reward.TREASURY,
          token: reward.SQK,
          symbol: pool.symbol || "SQK",
          total,
          treasuryBalance: pool.ok ? pool.balance : null,
          winners,
          everyone: rows,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (arg("csv")) {
    console.log("rank,address,points,calls,hits,amount");
    for (const w of winners) console.log(`${w.rank},${w.address},${w.points},${w.calls},${w.hits},${w.amount}`);
    return;
  }
  const line = "-".repeat(66);
  console.log("");
  console.log(`  SQUEEK-ROUND · SEASON ${s.id} · WEEK ${weekNo} PAYOUT SHEET`);
  console.log(`  ${new Date(from).toISOString()}  ->  ${new Date(to).toISOString()}`);
  console.log(line);

  if (!winners.length) {
    console.log("  Nobody locked a call in this window. No payout.");
    console.log(line);
    return;
  }

  for (const w of winners) {
    console.log(`  #${w.rank}  ${w.label.padEnd(4)}  ${String(w.amount).padStart(3)} SQK   ${w.address}`);
    console.log(`        ${w.points} points · ${w.hits}/${w.calls} graded`);
  }

  console.log(line);
  console.log(`  Total to pay      : ${total} SQK`);
  if (pool.ok) {
    console.log(`  Treasury balance  : ${pool.balance} ${pool.symbol || "SQK"}`);
    console.log(
      `  After this payout : ${Number((pool.balance - total).toFixed(4))} ${pool.symbol || "SQK"}`,
    );
    if (pool.balance < total) {
      console.log("");
      console.log("  !! The treasury cannot cover this payout. Top it up before sending.");
    }
  } else {
    console.log(`  Treasury balance  : could not read (${pool.reason}) — check before sending`);
  }
  console.log("");
  console.log("  Send from the treasury wallet. Paying is manual on purpose: read this");
  console.log("  sheet, then send three transfers. Nothing here moves funds.");
  console.log("");
}

main().catch((e) => {
  console.error("payout sheet failed:", (e && e.message) || e);
  process.exit(1);
});
