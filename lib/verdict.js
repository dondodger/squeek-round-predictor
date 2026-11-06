/**
 * verdict.js — the plain-language story of one graded call.
 *
 * Two things read from here: the per-call autopsy ("what happened, and by how
 * much") and the share line. Both are shown to a player as fact, so:
 *
 *   - a reading we do not have is never rendered as a zero. `blocks: null` must
 *     not read as "0 blocks", because 0 blocks is a real thing (a nap) and
 *     printing it would state something we do not know.
 *   - a miss is never phrased as a win. The copy says what happened.
 *
 * Blocks arrive from the chain API as strings, so everything parses defensively
 * rather than trusting Number() — Number("") is 0.
 */
const TARGET_BLOCKS = 40;

const BAND_LABEL = { nap: "Nap", jog: "Jog", zoomies: "Zoomies" };

function label(band) {
  return BAND_LABEL[band] || String(band || "?");
}

/** Read a count from the API. Blank/missing is null, never 0. */
function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * How far a round landed from what the call needed, in blocks.
 *
 * The reference point is NOT always the 40-block target. A Nap call is a bet
 * that the wheel never turned, so it is measured against zero — reporting "28
 * blocks short of 40" for a Nap called during a 12-block jog would be true but
 * meaningless. Jog and Zoomies are bets about the target, so those use 40.
 */
function gap(choice, blocks) {
  const b = num(blocks);
  if (b === null) return null;
  const ref = choice === "nap" ? 0 : TARGET_BLOCKS;
  const diff = ref - b;
  if (diff === 0) return { direction: "on", blocks: 0 };
  return diff > 0
    ? { direction: "under", blocks: diff }
    : { direction: "over", blocks: -diff };
}

/**
 * One line explaining a graded call. Always states what the wheel did, then
 * accounts for the call against it. Never praises a miss.
 *
 * When the block reading is missing (rounds graded before we started storing it)
 * the sentence degrades to something still readable in English. It must never
 * fall through to "it called Jog" — that is a machine talking, not a sentence.
 */
function autopsy(rec) {
  const round = num(rec && rec.round);
  const choice = rec && rec.choice;
  const outcome = rec && rec.outcome;
  const blocks = num(rec && rec.blocks);
  const bonus = num(rec && rec.bonus) || 0;
  const bits = [];

  if (!outcome) {
    return round === null ? "Not settled yet." : `Round ${round}: not settled yet.`;
  }

  if (outcome === "expired") {
    const head = round === null ? "This call" : `Round ${round}`;
    return `${head} settled too long ago to read. Not scored.`;
  }

  const head = round === null ? "You" : `Round ${round}: you`;

  /* What the wheel actually did, in words. With a reading we name the count AND
     the band once; with no reading we can only name the band. Either way the
     outcome is stated exactly once — repeating it reads like a machine. */
  if (choice === outcome) {
    bits.push(
      blocks === null
        ? `${head} called ${label(choice)} and it landed.`
        : `${head} called ${label(choice)} and it ran ${blocks} blocks. Landed.`
    );
    if (bonus > 0) bits.push(`+${bonus} streak bonus on top.`);
    return bits.join(" ");
  }

  bits.push(
    blocks === null
      ? `${head} called ${label(choice)}. It came in as ${label(outcome)}.`
      : `${head} called ${label(choice)} — it ran ${blocks} blocks, ${label(outcome)}.`
  );

  const g = gap(choice, blocks);
  /* The reading is already on the line, so the follow-up explains the gap
     WITHOUT repeating the count or the call. "The wheel moved 48 blocks" after
     "it ran 48 blocks" says the same thing twice. */
  if (blocks !== null) {
    if (choice === "nap") {
      bits.push("The wheel turned, so it was not a nap.");
    } else if (choice === "zoomies" && g && g.direction === "under") {
      /* A wheel that never turned is a Nap, not a Zoomies that fell short. */
      bits.push(
        blocks === 0
          ? "The wheel never turned."
          : `That is ${g.blocks} block${g.blocks === 1 ? "" : "s"} short of the 40 needed.`
      );
    } else if (choice === "jog" && g && g.direction === "over") {
      bits.push(`That is ${g.blocks} block${g.blocks === 1 ? "" : "s"} past the 40 a Jog allows.`);
    }
  }
  return bits.join(" ");
}

/**
 * A share line for a post. Names the round and the outcome factually; a single
 * hit is not called a streak, and a miss is not dressed up.
 */
function share(rec) {
  const round = num(rec && rec.round);
  const choice = rec && rec.choice;
  const outcome = rec && rec.outcome;
  const blocks = num(rec && rec.blocks);
  const streak = num(rec && rec.streak) || 0;

  if (!outcome) {
    return round === null
      ? "Locked a call on squeek-round."
      : `Locked round ${round} on squeek-round.`;
  }

  if (choice === outcome) {
    const did = blocks === null ? label(outcome) : `${blocks}-block ${label(outcome)}`;
    const streakBit = streak >= 2 ? ` ${streak} in a row.` : "";
    return round === null
      ? `Called it — ${did}.${streakBit}`
      : `Round ${round}: called ${did}.${streakBit}`;
  }

  const did = blocks === null ? label(outcome) : `${label(outcome)} (${blocks} blocks)`;
  return round === null
    ? `Called ${label(choice)}, got ${did}.`
    : `Round ${round}: called ${label(choice)}, got ${did}.`;
}

module.exports = { gap, autopsy, share, num, label, TARGET_BLOCKS };
