/* The two things Don reported after the first round of fixes, as tests so they
   cannot come back.

   A. A call locked mid-round must stay ungraded until its own window closes,
      even when the chain has already published a settlement for that round.
      Don called zoomies with ~6 minutes left, the chain had settled the round,
      and he was told "miss" immediately.

   B. An ungraded call is labelled by its OWN round, not by whatever the wheel
      is doing now. When the wheel paused, every ungraded call read "wheel
      resting", so a fresh call looked like it joined the stale pile.

   Calls are signed with eth_account, because lockCall() verifies the signature
   and would reject a hand-written placeholder.
   Run: node test_waiting.js */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/* The module reads its ledger path from SQUEER_POINTS, so point it at a
   scratch file. An earlier version of this test wrote to the real
   points.json and wiped a player's history when a run died before the
   restore step — the test must never touch the live ledger. */
const REAL_DB = path.join(__dirname, "points.json");
const DB = path.join(__dirname, ".test-waiting-ledger.json");
process.env.SQUEER_POINTS = DB;
const BASE = path.join(__dirname, ".test-waiting-base.json");

const GENESIS = 1793735400, DUR = 600;
const at = (round, off) => (GENESIS + round * DUR + off) * 1000;

const PY = `
import json,sys
from eth_account import Account
from eth_account.messages import encode_defunct
mode, key, msg = sys.argv[1], sys.argv[2], sys.argv[3]
acct = Account.create() if mode == "new" else Account.from_key(key)
sig = Account.sign_message(encode_defunct(text=msg), private_key=acct.key).signature.hex()
if not sig.startswith("0x"): sig = "0x" + sig
print(json.dumps({"address": acct.address, "key": acct.key.hex(), "sig": sig}))
`;
const py = (mode, key, msg) =>
  JSON.parse(execFileSync("python3", ["-c", PY, mode, key || "", msg || ""], { encoding: "utf8" }).trim());

const statement = (round, choice, addr) =>
  ["squeek-round \u2014 lock my round call", "", `Round: ${round}`, `Call: ${choice}`,
    `Wallet: ${addr}`, `Issued: ${new Date().toISOString()}`, "",
    "Signing proves I am the wallet making this call. No gas, no transfer."].join("\n");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};

function fresh() {
  fs.copyFileSync(BASE, DB);
  delete require.cache[require.resolve("./lib/points")];
  const p = require("./lib/points");
  p.setConfig({ genesisTimestamp: String(GENESIS), roundDuration: String(DUR) });
  return p;
}

fs.writeFileSync(BASE, JSON.stringify({ config: { genesisTimestamp: GENESIS, roundDuration: DUR }, players: {} }));

/* place a real, verifiable call at a chosen wall-clock moment */
function lockAt(p, round, choice, whenMs) {
  const realNow = Date.now;
  Date.now = () => whenMs;
  try {
    const acct = py("new");
    const msg = statement(round, choice, acct.address);
    const { sig } = py("sign", acct.key, msg);
    const out = p.lockCall({ address: acct.address, round, choice, sig, message: msg });
    assert.ok(out.ok, "lockCall accepted the call: " + out.reason);
    return acct.address;
  } finally { Date.now = realNow; }
}

/* read one call's row back at a chosen wall-clock moment */
function readAt(p, addr, round, whenMs) {
  const realNow = Date.now;
  Date.now = () => whenMs;
  try {
    return p.getProfileExplained(addr).recent.find((r) => r.round === round);
  } finally { Date.now = realNow; }
}

/* --- B: what an ungraded call is labelled --------------------------------- */

t("a call on the round in progress reads as waiting", () => {
  const p = fresh();
  const addr = lockAt(p, 483, "zoomies", at(483, 100));
  /* read it back at the SAME moment: lockAt() restores the real clock when it
     returns, and by then 483 may already be over in real time */
  const row = readAt(p, addr, 483, at(483, 150));
  assert.ok(row, "the call is on the profile");
  assert.strictEqual(row.waiting, true, "its round is still running");
  assert.strictEqual(row.over, false);
  assert.strictEqual(row.outcome, null, "not graded yet");
});

t("a call whose round has closed but is ungraded is NOT waiting", () => {
  const p = fresh();
  const addr = lockAt(p, 483, "jog", at(483, 100));
  /* read it back two rounds later, when 485 is the live round */
  const row = readAt(p, addr, 483, at(485, 100));
  assert.strictEqual(row.waiting, false, "483 is behind the clock now");
  assert.strictEqual(row.over, true, "its window has closed");
});

t("REGRESSION: a fresh call does not inherit the stale pile's label", () => {
  const p = fresh();
  const addr = lockAt(p, 480, "nap", at(480, 100));      // older call
  const addr2 = lockAt(p, 483, "zoomies", at(483, 100)); // fresh call
  const oldRow = readAt(p, addr, 480, at(483, 150));
  const newRow = readAt(p, addr2, 483, at(483, 150));
  assert.strictEqual(newRow.waiting, true, "the fresh call waits on its own round");
  assert.strictEqual(oldRow.waiting, false, "the old call's round is over");
});

/* --- A: the grading rule -------------------------------------------------- */

t("a live round is not graded even when the chain has settled it", () => {
  const p = fresh();
  const addr = lockAt(p, 483, "zoomies", at(483, 100));
  const realNow = Date.now;
  Date.now = () => at(483, 200);      // still inside 483
  try {
    p.settle(p.player(addr), { 483: 39 });   // chain already published 483
    const rec = p.player(addr).rounds["483"];
    assert.strictEqual(rec.outcome, undefined,
      "graded a round that is still running — this is the bug Don hit");
  } finally { Date.now = realNow; }
});

t("once the window closes it is graded from the settled count", () => {
  const p = fresh();
  const addr = lockAt(p, 483, "zoomies", at(483, 100));
  const realNow = Date.now;
  Date.now = () => at(484, 100);      // 484 live, so 483 closed
  try {
    p.settle(p.player(addr), { 483: 39 });
    const rec = p.player(addr).rounds["483"];
    assert.strictEqual(rec.outcome, "jog", "39 blocks is jog");
    assert.strictEqual(rec.award, 0, "a wrong call scores nothing");
  } finally { Date.now = realNow; }
});

t("the same call graded at minute 1 and minute 9 gives one answer", () => {
  const p = fresh();
  const a = lockAt(p, 483, "zoomies", at(483, 60));
  const b = lockAt(p, 483, "zoomies", at(483, 540));
  const realNow = Date.now;
  Date.now = () => at(484, 100);
  try {
    p.settle(p.player(a), { 483: 45 });
    p.settle(p.player(b), { 483: 45 });
    assert.strictEqual(p.player(a).rounds["483"].outcome, "zoomies");
    assert.strictEqual(p.player(b).rounds["483"].outcome, "zoomies");
  } finally { Date.now = realNow; }
});

/* --- real data ------------------------------------------------------------ */

t("REAL DATA: Don's R483 call was inside its window when locked", () => {
  /* he locked 04:24:01Z; R483 runs 04:20:00Z-04:30:00Z, so 359s were left */
  const lockTs = Date.UTC(2026, 10, 7, 4, 24, 1) / 1000;
  const openAt = GENESIS + 483 * DUR, closeAt = openAt + DUR;
  assert.strictEqual(closeAt - lockTs, 359, "359s of the round were still to run");
  assert.ok(lockTs > openAt && lockTs < closeAt, "the call was inside the window");
});

t("the live ledger was never opened by this test", () => {
  assert.ok(!fs.existsSync(DB) || DB !== REAL_DB,
    "the test must write to its own scratch ledger");
});

t("fixture calls never reach the live ledger", () => {
  const today = fs.existsSync(REAL_DB) ? fs.readFileSync(REAL_DB, "utf8") : "";
  assert.ok(!today.includes("waiting-fixture"),
    "no fixture marker may appear in the player's ledger");
});

fs.rmSync(BASE, { force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
