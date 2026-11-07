/* The stored call must be the call that was SIGNED, never the one in the body.
   This is the bug that cost Don a zoomies hit on R480: he signed zoomies, the
   record said jog, the guards passed anyway, and he was paid 0.
   Run: node test_bindchoice.js */
const assert = require("assert");

/* mirror of the guard inside lib/points.js lockCall */
function checkCall(message, bodyChoice) {
  const signed = message.match(/^Call:\s*(\S+)\s*$/im);
  if (!signed) return { ok: false, reason: "statement_missing_call" };
  const signedChoice = signed[1].toLowerCase();
  if (!["nap", "jog", "zoomies"].includes(signedChoice))
    return { ok: false, reason: "statement_bad_call" };
  if (signedChoice !== String(bodyChoice).toLowerCase())
    return { ok: false, reason: "statement_call_mismatch" };
  return { ok: true, choice: signedChoice };
}

const stmt = (round, choice, extra = "") =>
  ["Squeek Round Predictor — lock my call", "", `Round: ${round}`, `Call: ${choice}`,
   "Wallet: 0x1111111111111111111111111111111111111111", "Issued: 2026-11-07T03:50:31.598Z", "",
   "Signing is free and does not move funds."].join("\n") + extra;

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};

t("honest zoomies call is accepted and stored as zoomies", () => {
  const r = checkCall(stmt(480, "zoomies"), "zoomies");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.choice, "zoomies");
});

t("DON'S BUG: body says jog but signature says zoomies is now REJECTED", () => {
  const r = checkCall(stmt(480, "zoomies"), "jog");
  assert.strictEqual(r.ok, false, "must not accept a body that disagrees with the signature");
  assert.strictEqual(r.reason, "statement_call_mismatch");
});

t("case-insensitive: signed Zoomies vs body zoomies still matches", () => {
  const r = checkCall(stmt(480, "Zoomies"), "zoomies");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.choice, "zoomies");
});

t("a message carrying BOTH words is read from the Call: line only", () => {
  /* the old guard was satisfied by any mentioning of the word. Even if the
     message is polluted, the parsed value is the Call: line and must match. */
  const r = checkCall(stmt(480, "zoomies", "\n\nCall: jog"), "jog");
  assert.strictEqual(r.ok, false, "body=jog vs first Call: line=zoomies -> mismatch");
});

t("a statement with no Call: line at all is rejected", () => {
  const r = checkCall(stmt(480, "zoomies").replace(/^Call:.*$/m, ""), "zoomies");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "statement_missing_call");
});

t("a Call: line naming a bogus grade is rejected", () => {
  const r = checkCall(stmt(480, "turbo"), "turbo");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "statement_bad_call");
});

t("trailing spaces on the Call: line still parse", () => {
  const r = checkCall(stmt(480, "zoomies").replace("Call: zoomies", "Call:  zoomies   "), "zoomies");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.choice, "zoomies");
});

t("all three grades round-trip when honest", () => {
  for (const c of ["nap", "jog", "zoomies"]) {
    const r = checkCall(stmt(480, c), c);
    assert.strictEqual(r.ok, true, c + " should be accepted");
    assert.strictEqual(r.choice, c);
  }
});

t("all three grades rejected when the body is swapped", () => {
  const all = ["nap", "jog", "zoomies"];
  for (const signed of all) for (const body of all) {
    const r = checkCall(stmt(480, signed), body);
    if (signed === body) assert.strictEqual(r.ok, true);
    else assert.strictEqual(r.ok, false, `${signed} vs ${body} must be rejected`);
  }
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
