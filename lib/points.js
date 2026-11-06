/**
 * Points ledger for squeek-round.
 *
 * Calls are already locked off-chain with a free wallet signature (see
 * public/app.js `lockCall`). This module turns that same signature into a
 * *server-side* record so a player's score follows their WALLET, not their
 * browser: connect the same address on any device and the points are there.
 *
 * Design choices worth keeping:
 *   - The signature is the write credential. Nothing is stored unless
 *     recoverPersonalSign() gives back the address the client claims, so a
 *     third party cannot post points for someone else's wallet.
 *   - One entry per (address, round). A re-post of the same round is a no-op,
 *     which stops a player farming the same result by replaying the request.
 *   - Points up to `MAX_SCORED_ROUNDS` most recent settled rounds only, so an
 *     old signature cannot be replayed to score a round it never called.
 *   - Nothing here is on-chain and nothing moves funds. It is a scoreboard.
 */
const fs = require("fs");
const path = require("path");
const { recoverPersonalSign } = require("./sig");

const DATA = process.env.SQUEER_POINTS || path.join(__dirname, "..", "points.json");
const TARGET_BLOCKS = Number(process.env.SQUEER_TARGET_BLOCKS) || 40;
/* Points are only awarded for a round that has settled within this many rounds
   of the tip, so an old signature cannot be posted months later. */
const MAX_SCORED_AGE = Number(process.env.SQUEER_SCORE_AGE) || 20;

const POINTS = { hit: 10, zoomies: 15, streakBonus: 5, streakAt: 3 };

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA, "utf8"));
    if (raw && typeof raw === "object" && raw.players) return raw;
  } catch {}
  return { version: 1, updatedAt: null, players: {} };
}

let db = load();
let dirty = false;

function save() {
  if (!dirty) return;
  db.updatedAt = new Date().toISOString();
  const tmp = DATA + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA); // atomic: never leave a half-written ledger
  dirty = false;
}

/* periodic flush so a crash loses at most a minute of scores */
const timer = setInterval(save, 60000);
if (timer.unref) timer.unref();

function classify(blocks) {
  const n = Number(blocks) || 0;
  if (n === 0) return "nap";
  if (n < TARGET_BLOCKS) return "jog";
  return "zoomies";
}

function blank(addr) {
  return {
    address: addr,
    points: 0,
    calls: 0,
    scored: 0,
    hits: 0,
    streak: 0,
    bestStreak: 0,
    byCall: { nap: 0, jog: 0, zoomies: 0 },
    rounds: {},           // round -> { choice, outcome, award, at }
    firstSeen: new Date().toISOString(),
    lastSeen: null,
  };
}

function player(addr) {
  const a = String(addr).toLowerCase();
  if (!db.players[a]) db.players[a] = blank(a);
  return db.players[a];
}

/**
 * Settle a player's pending calls against the rounds the chain has settled.
 * `settled` is { round: completedBlockCount }. Returns how many were graded.
 */
function settle(p, settled) {
  const tip = Math.max(...Object.keys(settled).map(Number), 0);
  let graded = 0;
  for (const [r, rec] of Object.entries(p.rounds)) {
    if (rec.outcome) continue;
    const round = Number(r);
    if (!Object.prototype.hasOwnProperty.call(settled, round)) continue;
    if (tip && round < tip - MAX_SCORED_AGE) {
      rec.outcome = "expired"; // settled long ago, we can no longer trust the read
      rec.award = 0;
      graded++;
      continue;
    }
    const outcome = classify(settled[round]);
    rec.outcome = outcome;
    rec.gradedAt = new Date().toISOString();
    p.scored++;
    if (outcome === rec.choice) {
      rec.award = outcome === "zoomies" ? POINTS.zoomies : POINTS.hit;
      p.hits++;
      p.streak++;
      if (p.streak > p.bestStreak) p.bestStreak = p.streak;
      if (p.streak >= POINTS.streakAt) rec.award += POINTS.streakBonus;
      p.points += rec.award;
    } else {
      rec.award = 0;
      p.streak = 0;
    }
    graded++;
    dirty = true;
  }
  return graded;
}

/**
 * Record a locked call.
 * Returns { ok, reason?, player? } — reason is a short machine string.
 */
function lockCall({ address, round, choice, sig, message }) {
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return { ok: false, reason: "bad_address" };
  if (!["nap", "jog", "zoomies"].includes(choice)) return { ok: false, reason: "bad_choice" };
  if (!Number.isFinite(Number(round)) || Number(round) <= 0) return { ok: false, reason: "bad_round" };
  if (!sig || !message) return { ok: false, reason: "missing_signature" };

  const recovered = recoverPersonalSign(message, sig);
  if (!recovered) return { ok: false, reason: "bad_signature" };
  if (recovered.toLowerCase() !== address.toLowerCase())
    return { ok: false, reason: "signature_address_mismatch" };

  /* the signed statement must actually name this round and this call, so a
     valid signature for round 10 cannot be replayed as round 11 */
  const r = Number(round);
  if (!new RegExp(`Round:\\s*${r}\\b`).test(message)) return { ok: false, reason: "statement_round_mismatch" };
  if (!new RegExp(`Call:\\s*${choice}\\b`, "i").test(message)) return { ok: false, reason: "statement_call_mismatch" };

  const p = player(address);
  p.lastSeen = new Date().toISOString();
  const key = String(r);
  if (p.rounds[key]) return { ok: true, duplicate: true, player: publicView(p) };

  p.rounds[key] = { choice, sig: null, at: new Date().toISOString() };
  p.calls++;
  p.byCall[choice]++;
  dirty = true;
  save();
  return { ok: true, duplicate: false, player: publicView(p) };
}

function publicView(p) {
  const recent = Object.entries(p.rounds)
    .map(([r, v]) => ({ round: Number(r), ...v }))
    .sort((a, b) => b.round - a.round)
    .slice(0, 20);
  return {
    address: p.address,
    points: p.points,
    calls: p.calls,
    scored: p.scored,
    hits: p.hits,
    accuracy: p.scored ? Math.round((p.hits / p.scored) * 100) : null,
    streak: p.streak,
    bestStreak: p.bestStreak,
    byCall: p.byCall,
    recent,
    firstSeen: p.firstSeen,
    lastSeen: p.lastSeen,
  };
}

function getProfile(address) {
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  const a = address.toLowerCase();
  if (!db.players[a]) return { empty: true, address: a, points: 0, calls: 0, scored: 0, hits: 0, accuracy: null, streak: 0, bestStreak: 0, byCall: { nap: 0, jog: 0, zoomies: 0 }, recent: [] };
  return publicView(db.players[a]);
}

function stats() {
  const all = Object.values(db.players);
  return {
    players: all.length,
    calls: all.reduce((n, p) => n + p.calls, 0),
    hits: all.reduce((n, p) => n + p.hits, 0),
    pointsAwarded: all.reduce((n, p) => n + p.points, 0),
    targetBlocks: TARGET_BLOCKS,
    scoring: POINTS,
    updatedAt: db.updatedAt,
  };
}

module.exports = { lockCall, getProfile, settle, player, save, stats, classify, POINTS, TARGET_BLOCKS };
