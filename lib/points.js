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

const verdict = require("./verdict");

const POINTS = { hit: 10, zoomies: 15 };

/**
 * What a streak is worth, on top of the base award for the hit itself.
 *
 * This used to be a flat +5 at three in a row, which made a run of nine worth
 * exactly as much as a run of three — the reward stopped rewarding, and there
 * was no reason to protect a streak once it had started. It now climbs:
 *
 *   1-2   nothing. A streak should be earned before it pays.
 *   3-4   +5
 *   5-6   +10
 *   7-8   +15
 *   9+    +25    a nine-round run is roughly a one-in-500 event at even odds;
 *                it should feel like one.
 *
 * Deliberately kept modest at the low end so a player's FIRST hit is not worth
 * less than it was before. The extra comes only from going on a run.
 */
const STREAK_BANDS = [
  { at: 9, bonus: 25 },
  { at: 7, bonus: 15 },
  { at: 5, bonus: 10 },
  { at: 3, bonus: 5 },
];

function streakBonus(streak) {
  const s = Number(streak);
  if (!Number.isFinite(s) || s < 3) return 0;
  for (const band of STREAK_BANDS) {
    if (s >= band.at) return band.bonus;
  }
  return 0;
}

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
 * Remember the round clock so settle() can tell an open round from a closed one.
 * The chain settles a round as soon as it has seen enough work, which can be
 * before the round's 600s window has closed — so "is it in the settlement list"
 * is not the same question as "is the round over". Called from the server with
 * whatever the public API reports.
 */
function setConfig(cfg) {
  if (!cfg) return;
  const g = Number(cfg.genesisTimestamp);
  const d = Number(cfg.roundDuration);
  if (!Number.isFinite(g) || !Number.isFinite(d) || g <= 0 || d <= 0) return;
  if (db.config && db.config.genesisTimestamp === g && db.config.roundDuration === d) return;
  db.config = { genesisTimestamp: g, roundDuration: d };
  dirty = true;
  save();
}

/**
 * Settle a player's pending calls against the rounds the chain has settled.
 * `settled` is { round: completedBlockCount }. Returns how many were graded.
 */
function settle(p, settled) {
  const tip = Math.max(...Object.keys(settled).map(Number), 0);
  /* Which round is the wall clock in right now? A round only ends when its
     600s window closes — but the chain settles a round as soon as it has seen
     enough work, which can be well BEFORE that window closes. So the newest
     entry in `settled` may be the round the player is still calling, and
     grading against it settles a call the instant it is locked: Don picked
     zoomies with minutes left on the clock and it went straight to hit.

     A call is only gradable once its round is behind the clock. Until then it
     stays pending, which is what the player expects after locking. */
  const cfg = (db.config) || {};
  const genesis = Number(cfg.genesisTimestamp) || 0;
  const dur = Number(cfg.roundDuration) || 600;
  const curRound = genesis ? Math.floor(Date.now() / 1000 - genesis) / dur : null;
  const nowRound = curRound === null ? null : Math.floor(curRound);
  let graded = 0;
  for (const [r, rec] of Object.entries(p.rounds)) {
    if (rec.outcome) continue;
    const round = Number(r);
    /* A round that has not finished yet cannot have an outcome, no matter what
       the settlement list says. Leave it pending. */
    if (nowRound !== null && round >= nowRound) continue;
    /* Age check BEFORE the presence check. The API only exposes the last few
       settlements, so a call whose round has scrolled out of that window will
       never appear in `settled` again — testing presence first and skipping on
       a miss left those calls pending forever, no matter how much time passed.
       A round older than the window is unscoreable, so say so out loud. */
    if (tip && round < tip - MAX_SCORED_AGE && !Object.prototype.hasOwnProperty.call(settled, round)) {
      rec.outcome = "expired"; // the settlement window moved past it; it cannot be graded
      rec.award = 0;
      rec.expiredAt = new Date().toISOString();
      graded++;
      dirty = true;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(settled, round)) continue;
    const outcome = classify(settled[round]);
    rec.outcome = outcome;
    /* Keep the raw reading on the record. The autopsy needs the actual block
       count to say HOW close a call was ("missed Zoomies by 7"), and without it
       the explanation could only repeat the outcome back. */
    rec.blocks = Number(settled[round]);
    rec.gradedAt = new Date().toISOString();
    p.scored++;
    if (outcome === rec.choice) {
      rec.award = outcome === "zoomies" ? POINTS.zoomies : POINTS.hit;
      p.hits++;
      p.streak++;
      if (p.streak > p.bestStreak) p.bestStreak = p.streak;
      const bonus = streakBonus(p.streak);
      rec.bonus = bonus;
      rec.award += bonus;
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

  /* Read the call OUT OF THE SIGNED STATEMENT rather than trusting the body.
     The signature is the only part of the request the player actually
     authorised, so it is the only part that may decide what they called.
     Previously we checked that the message *mentioned* body.choice and then
     stored body.choice anyway — so a request whose body disagreed with its own
     signature was accepted, logged, and graded as the wrong call. The player
     signed zoomies, the table said jog, and they were paid nothing. */
  const signed = message.match(/^Call:\s*(\S+)\s*$/im);
  if (!signed) return { ok: false, reason: "statement_missing_call" };
  const signedChoice = signed[1].toLowerCase();
  if (!["nap", "jog", "zoomies"].includes(signedChoice))
    return { ok: false, reason: "statement_bad_call" };
  /* and the body must agree with what was signed, or something rewrote it */
  if (signedChoice !== String(choice).toLowerCase())
    return { ok: false, reason: "statement_call_mismatch" };

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

/**
 * The same profile, with each graded call explained in words and given a share
 * line. Kept separate from publicView so the raw ledger shape stays available
 * for anything that wants the numbers unattended.
 */
function getProfileExplained(address) {
  const p = getProfile(address);
  if (!p) return null;
  const streakSoFar = p.streak;
  let walked = 0;
  p.recent = (p.recent || []).map((r) => {
    const rec = {
      round: r.round,
      choice: r.choice,
      outcome: r.outcome || null,
      blocks: r.blocks,
      award: r.award,
      bonus: r.bonus || 0,
      at: r.at,
      gradedAt: r.gradedAt,
    };
    /* The streak a call sat at when it was graded. Only the current run is
       stored, so walk back from the present streak: the newest graded hit is at
       strength `streak`, the one before it one less, and a miss breaks the run. */
    if (rec.outcome && rec.outcome !== "expired") {
      if (rec.outcome === rec.choice) {
        rec.streak = Math.max(1, streakSoFar - walked);
        walked++;
      } else {
        rec.streak = 0;
        walked = 0;
      }
    }
    rec.verdict = verdict.autopsy(rec);
    rec.share = verdict.share(rec);
    return rec;
  });
  return p;
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

module.exports = { streakBonus, STREAK_BANDS, lockCall, getProfile, getProfileExplained, settle, player, save, stats, classify, POINTS, TARGET_BLOCKS, setConfig };
