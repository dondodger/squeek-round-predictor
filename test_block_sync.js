/**
 * The two block numbers on the page must be labelled honestly.
 *
 * A real bug lived here: `core.blockHeight` (the last block the wheel SEALED,
 * 1999) was shown under the label "Block height" with a link to the Sepolia
 * transaction hash. A reader takes "Block height" to mean the Ethereum chain
 * head, which is 12,082,729 — a 6042x lie, and one the owner spotted by
 * comparing our page against the live stream.
 *
 * These tests pin the meaning of each number so the labels cannot drift back:
 *   chain.sepoliaBlock  -> the real Ethereum height, from chain.indexedThroughBlock
 *   wheel.sealedBlocks  -> blocks the wheel has sealed, from core.blockHeight
 *
 * They also require the setup to fetch /v1/settlements, which is the only
 * endpoint that reports the wheel's real recent output (blockHeight,
 * lastCompletedBlock, completedBlockCount per round) — the evidence a reader
 * needs to see that the wheel is resting rather than the page being stale.
 */
const fs = require("fs");
const path = require("path");

let pass = 0;
let fail = 0;

function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

const html = fs.readFileSync(path.join(__dirname, "public/index.html"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "public/app.js"), "utf8");

console.log("\nthe chain height and the wheel's own count are different numbers");

ok("the chain's own height is read from chain.indexedThroughBlock", () => {
  if (!/indexedThroughBlock/.test(app))
    throw new Error("app.js never reads chain.indexedThroughBlock — the real Ethereum height");
});

ok("the wheel's sealed-block count is read from core.blockHeight", () => {
  if (!/blockHeight/.test(app))
    throw new Error("app.js never reads core.blockHeight");
});

ok("the label 'Block height' is gone, or no longer labels the wheel's count", () => {
  /* If the phrase survives it must not sit directly above the wheel counter. */
  const bad = /Block height[\s\S]{0,120}?id="blockHeight"/.test(html);
  if (bad)
    throw new Error('"Block height" still labels the wheel counter (#blockHeight) — a reader takes that to mean Ethereum');
});

ok("the Sepolia link is labelled as Sepolia, not as 'block <n>'", () => {
  const link = html.match(/id="blockLink"[^>]*>([^<]*)</);
  if (link && /^\s*block\s*(&mdash;|—)?\s*$/i.test(link[1]))
    throw new Error('the link still reads "block —" with no chain named');
});

console.log("\nthe wheel's recent output must come from the settlements endpoint");

ok("app.js fetches the settlements endpoint", () => {
  /* The call is written as `${API}/settlements`, so match the path, not a
     literal "/v1/settlements" — an earlier version of this test demanded the
     literal and failed on correct code. */
  if (!/\$\{API\}\/settlements|["'`]\/v1\/settlements/.test(app))
    throw new Error("app.js does not fetch the settlements endpoint — no evidence of the wheel's recent work");
});

ok("app.js uses completedBlockCount from the settlements payload", () => {
  if (!/completedBlockCount/.test(app))
    throw new Error("app.js ignores completedBlockCount — cannot show how much the wheel produced");
});

ok("app.js shows a Squeek block number that it can trace to a live payload", () => {
  /* lastCompletedBlock only appears in the settlements feed; the page is not
     required to use it, but the block height it shows must come from a field
     the API actually publishes. */
  if (!/blockHeight|lastCompletedBlock/.test(app))
    throw new Error("app.js shows no block number traceable to an API field");
});

console.log("\nnothing on the page claims the wheel count is the Ethereum head");

ok("no string pairs 'Block height' with a Sepolia transaction link", () => {
  const idx = html.indexOf("Block height");
  if (idx !== -1) {
    const around = html.slice(idx, idx + 400);
    if (/etherscan|sepolia/i.test(around))
      throw new Error("a Sepolia explorer link sits next to a 'Block height' label");
  }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
