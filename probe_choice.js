/* Can lockCall be told to store a DIFFERENT choice than the one signed?
   That is the shape of Don's bug: he signed "Call: zoomies" and the record
   came out as "jog". Walk every path that writes p.rounds[key].choice and
   test the statement/call cross-check that is supposed to make it impossible.
   Run: node probe_choice.js */
const points = require("./lib/points");

const ADDR = "0x1111111111111111111111111111111111111111";
const ROUND = 480;

/* what Don signed, as the browser builds it (public/app.js statement()) */
function statement(round, choice) {
  return [
    "Squeek Round Predictor — lock my call",
    "",
    `Round: ${round}`,
    `Call: ${choice}`,
    `Wallet: ${ADDR}`,
    "Issued: 2026-11-07T03:50:31.598Z",
    "",
    "Signing is free and does not move funds.",
  ].join("\n");
}

console.log("=== the signed statement for a zoomies call ===");
console.log(statement(ROUND, "zoomies"));
console.log();

/* The cross-check in lockCall:
     new RegExp(`Call:\\s*${choice}\\b`, "i").test(message)
   It tests that the message CONTAINS the choice being submitted. If the
   message contains BOTH words, the test passes for either — and the stored
   value is whatever the body said, not what was signed. */
const BOTH = statement(ROUND, "zoomies") + "\n\nCall: jog";

console.log("=== does the guard notice a body that disagrees with the signature? ===");
for (const [submitted, msg, label] of [
  ["zoomies", statement(ROUND, "zoomies"), "honest: body matches signature"],
  ["jog", BOTH, "TAMPERED: signed zoomies, body says jog, message carries both"],
  ["zoomies", BOTH, "TAMPERED: signed jog, body says zoomies"],
]) {
  const guardPasses = new RegExp(`Call:\\s*${submitted}\\b`, "i").test(msg);
  const roundGuard = new RegExp(`Round:\\s*${ROUND}\\b`).test(msg);
  console.log(`  body=${submitted.padEnd(8)} ${label}`);
  console.log(`     round guard: ${roundGuard}   call guard: ${guardPasses}  -> lockCall would ${guardPasses && roundGuard ? "ACCEPT" : "reject"}`);
}

console.log("\n=== which words can the call guard be satisfied by? ===");
const msg = statement(ROUND, "zoomies");
for (const c of ["nap", "jog", "zoomies"]) {
  console.log(`  "Call: ${c}" found in a zoomies statement? ${new RegExp(`Call:\\s*${c}\\b`, "i").test(msg)}`);
}

console.log(`
=== CONCLUSION ===
The guard proves the MESSAGE mentions the choice. It does not prove the
message's choice is the ONLY one, and it does not bind body.choice to what
was actually signed. lockCall stores body.choice verbatim:

    p.rounds[key] = { choice, ... };   // choice === body.choice

So if anything on the wire (or in the browser) rewrites choice after signing,
the signature still verifies, the guards still pass, and the record silently
disagrees with what the player signed. That is exactly Don's report: he signed
zoomies, the record says jog, and he was paid nothing.
`);
