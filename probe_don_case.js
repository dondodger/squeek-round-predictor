#!/usr/bin/env node
/**
 * Reproduce Don's exact complaint against the RUNNING server over HTTP.
 *
 *   "I called at minute 6 of the round and it settled instantly as a loss."
 *
 * The chain publishes a running completedBlockCount, so the settlement map can
 * already carry the round Don is still calling. This asks the live scoreboard
 * what it thinks of a call made NOW, mid-round, and prints the verdict the
 * browser will render.
 *
 * Run: node probe_don_case.js
 */
const { execFileSync } = require("child_process");

const BASE = process.env.SQUEER_BASE || "http://127.0.0.1:8787";

const PY = `
import json,sys
from eth_account import Account
from eth_account.messages import encode_defunct
mode,key,msg = sys.argv[1], sys.argv[2], sys.argv[3]
acct = Account.create() if mode == "new" else Account.from_key(key)
sig = Account.sign_message(encode_defunct(text=msg), private_key=acct.key).signature.hex()
if not sig.startswith("0x"): sig = "0x" + sig
print(json.dumps({"address": acct.address, "key": acct.key.hex(), "sig": sig}))
`;
const py = (mode, key, msg) =>
  JSON.parse(execFileSync("python3", ["-c", PY, mode, key || "", msg || ""], { encoding: "utf8" }).trim());

const statement = (round, choice, addr) => [
  "squeek-round \u2014 lock my round call", "",
  "Round: " + round, "Call: " + choice, "Wallet: " + addr,
  "Issued: " + new Date().toISOString(), "",
  "Signing proves I am the wallet making this call. No gas, no transfer.",
].join("\n");

(async () => {
  const core = await (await fetch("https://api.squeekchain.com/v1/core")).json();
  const c = core.configuration || {};
  const G = Number(c.genesisTimestamp), D = Number(c.roundDuration);
  const now = Math.floor(Date.now() / 1000);
  const live = Math.floor((now - G) / D);
  const elapsed = now - (G + live * D);
  const left = D - elapsed;

  console.log(`round R${live} is RUNNING  (minute ${(elapsed / 60).toFixed(1)} of ${D / 60}, ${left}s left)`);

  const a = py("new");
  const choice = "zoomies";
  const msg = statement(live, choice, a.address);
  const s = py("sign", a.key, msg);

  const r = await fetch(`${BASE}/api/points/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: a.address, round: live, choice, sig: s.sig, message: msg }),
  });
  const j = await r.json().catch(() => ({}));
  console.log(`submit -> http=${r.status} ok=${j.ok}`);

  const p = await (await fetch(`${BASE}/api/points/profile/${a.address}`)).json();
  const row = (p.recent || []).find((x) => x.round === live) || {};

  console.log(`\nwhat the board will show for R${live}:`);
  console.log(`  choice   = ${row.choice}`);
  console.log(`  outcome  = ${row.outcome === null ? "null  (NOT graded)" : row.outcome}`);
  console.log(`  phase    = ${row.phase}`);
  console.log(`  waiting  = ${row.waiting}`);
  console.log(`  over     = ${row.over}`);
  console.log(`  verdict  = ${row.verdict}`);

  console.log();
  const okWait = row.outcome === null && row.waiting === true && row.over === false;
  if (okWait) {
    console.log("PASS: a call made mid-round is WAITING, not graded. Don's bug 1 is fixed.");
  } else {
    console.log("FAIL: it graded mid-round, or the fields are missing.");
  }
  process.exit(okWait ? 0 : 1);
})().catch((e) => { console.error("probe error:", e.message); process.exit(2); });
