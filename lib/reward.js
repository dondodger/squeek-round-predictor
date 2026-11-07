/**
 * Season 1 rewards — the pool, the split, the eligibility bar, the on-chain read.
 *
 * Kept in its own module for one reason: these are the numbers the site makes
 * a promise about. They belong in one place, commented, so that whoever changes
 * the pool size or the split can see exactly what they are changing and what
 * else moves with it (the split must still sum to 100, the treasury balance
 * decides how many weeks are left).
 *
 * Three things this file deliberately does NOT do:
 *
 *   1. It never sends a token. Paying a winner is a human decision made by Don
 *      against a printed list — a script that moves funds on a schedule is a
 *      script that can pay the wrong person while nobody is watching.
 *   2. It never invents a balance. If Sepolia cannot be reached the API says
 *      so, because a prize pool shown as "0" when the RPC is down is a lie in
 *      the most damaging direction: it makes the project look broke.
 *   3. It never invents an "always", because the two "always" claims a rewards
 *      page is tempted to make — "free forever" and "the token is worthless" —
 *      are not ours to promise beyond the season actually on offer. The note
 *      below is scoped to the season, not to the token for all time.
 */

const RPC = process.env.SQUEEK_RPC || "https://ethereum-sepolia.publicnode.com";
const SQK = "0xd78a3956cF63164d1Fa1C622ad3c66623162Fa1e"; // Squeek (SQK), Sepolia
const TREASURY = "0xf8c16c046D3eEcC5Dc5f78A07693757aa0f23831";

/* Selectors we need. Only three views, so no ABI library is worth the weight —
   the project already hand-rolls EIP-191 rather than pull in ethers. */
const SEL_BALANCE = "0x70a08231"; // balanceOf(address)
const SEL_DECIMALS = "0x313ce567"; // decimals()
const SEL_SYMBOL = "0x95d89b41"; // symbol()

const SEASON = {
  id: 1,
  /* When the season opened. Anything locked before this does not count — the
     board had calls from before the season existed and paying those out would
     be paying people who were not playing the same game. */
  startsAt: process.env.SQUEEK_SEASON_START || "2026-11-07T00:00:00Z",

  /* Weekly pool. 600 SQK is funded; at 150/week that is four weeks. */
  weeklyPool: 150,
  funded: 600,

  /* Split of the weekly pool. Must sum to 100. */
  split: [
    { rank: 1, pct: 50, label: "1st" },
    { rank: 2, pct: 30, label: "2nd" },
    { rank: 3, pct: 20, label: "3rd" },
  ],

  /* Eligibility. Two rules, and both exist for the same reason: a prize should
     reward playing well over a week, not catching one lucky round or showing up
     once. Without a floor, a single correct call on a quiet Monday can outrank
     someone who played all seven days — and the board would look rigged even
     though nothing broke.
     - minCalls: calls that must be locked inside the week to qualify at all.
     - a player must also have scored at least one correct call. */
  minCalls: 5,

  /* The entry fee. There is not one, and this is load-bearing: SQK only exists
     for people who staked an Squeek NFT, so gating play behind SQK would gate
     play behind owning a scarce NFT. The game is free; the reward is the only
     thing SQK touches. */
  entryFee: 0,

  /* Said on the page, in these words. Scoped to the season on purpose — see
     note 3 at the top of this file. */
  note:
    "Rewards are Sepolia testnet SQK and carry no monetary value. " +
    "This is a community experiment, not a paid competition.",
};

/** Plain-English amounts, derived so the page can never contradict the config. */
function prizes() {
  return SEASON.split.map((s) => ({
    rank: s.rank,
    label: s.label,
    pct: s.pct,
    amount: Math.round((SEASON.weeklyPool * s.pct) / 100),
  }));
}

function pad32(hexNo0x) {
  return hexNo0x.toLowerCase().padStart(64, "0");
}

async function rpcCall(to, data) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
  if (!r.ok) throw new Error("rpc http " + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  if (typeof j.result !== "string") throw new Error("rpc empty");
  return j.result;
}

function decodeUint(hex) {
  if (!hex || hex === "0x") throw new Error("empty word");
  return BigInt(hex);
}

/* Minimal ABI string decode: offset(32) | length(32) | data */
function decodeString(hex) {
  const b = Buffer.from(hex.slice(2), "hex");
  if (b.length < 64) throw new Error("short string");
  const len = Number(BigInt("0x" + b.subarray(32, 64).toString("hex")));
  if (!(len > 0 && len <= 64)) throw new Error("bad string length");
  return b.subarray(64, 64 + len).toString("utf8");
}

/**
 * Read the pool straight off Sepolia.
 *
 * Returns { ok:false, reason } when the chain cannot be read — never a zero
 * balance, because a prize pool rendering as empty is worse than one saying it
 * could not be checked. The caller decides how to phrase that to the player.
 */
async function pool() {
  const base = { treasury: TREASURY, token: SQK, chain: "sepolia", season: seasonInfo() };
  try {
    const [rawBal, rawDec, rawSym] = await Promise.all([
      rpcCall(SQK, SEL_BALANCE + pad32(TREASURY.slice(2))),
      rpcCall(SQK, SEL_DECIMALS),
      rpcCall(SQK, SEL_SYMBOL),
    ]);
    const decimals = Number(decodeUint(rawDec));
    const balance = Number(decodeUint(rawBal)) / Math.pow(10, decimals);
    const symbol = decodeString(rawSym);

    /* Weeks remaining is floor(balance / weekly), and it is shown only as a
       whole number: "3 weeks left" is honest, "3.7 weeks" invites a player to
       do arithmetic the pool does not guarantee. */
    const weeksLeft = Math.floor(balance / SEASON.weeklyPool);

    return {
      ok: true,
      symbol,
      decimals,
      balance,
      balanceRaw: rawBal,
      weeklyPool: SEASON.weeklyPool,
      weeksLeft,
      prizes: prizes(),
      readAt: new Date().toISOString(),
      ...base,
    };
  } catch (e) {
    return {
      ok: false,
      reason: String((e && e.message) || e),
      weeklyPool: SEASON.weeklyPool,
      prizes: prizes(),
      ...base,
    };
  }
}

function seasonInfo() {
  const start = new Date(SEASON.startsAt);
  const ms = Date.now() - start.getTime();
  const week = ms < 0 ? 0 : Math.floor(ms / (7 * 24 * 3600 * 1000)) + 1;
  return {
    id: SEASON.id,
    startsAt: SEASON.startsAt,
    week,
    weeklyPool: SEASON.weeklyPool,
    funded: SEASON.funded,
    /* Eligibility travels with the season info so the page, the payout sheet
       and anything added later all quote the same bar. */
    minCalls: SEASON.minCalls,
    entryFee: SEASON.entryFee,
    note: SEASON.note,
  };
}

/** Exposed so callers phrase the rule the same way the page does. */
function minCalls() {
  return SEASON.minCalls;
}

module.exports = { SEASON, seasonInfo, prizes, pool, minCalls, TREASURY, SQK };
