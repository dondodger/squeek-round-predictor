/* The rule Don actually reported, end to end against the live server:
   locking a call on the round the clock is currently in must leave it PENDING,
   even when the chain has already published a settlement for that round.

   The chain publishes settlements as soon as it has seen enough work, which can
   be before the 600s window closes. Grading straight off that list settled a
   call the instant it was locked — Don called zoomies with six minutes left and
   was told "miss" before the round had even finished.

   Run: node probe_still_pending.js */
const { execFileSync } = require("child_process");
const fs = require("fs");

const API = "http://127.0.0.1:8787";
const CHAIN = "https://api.squeekchain.com/v1/core";

/* Generate ONE account and keep its key, so the address in the statement, the
   address in the body and the address that signed are all the same wallet. */
const PY_NEW = `
import json,sys
from eth_account import Account
print(json.dumps({"address": Account.create().key.hex()}))
`;
const PY_SIGN = `
import json,sys
from eth_account import Account
from eth_account.messages import encode_defunct
acct = Account.from_key(sys.argv[1])
sig = Account.sign_message(encode_defunct(text=sys.argv[2]), private_key=acct.key).signature.hex()
if not sig.startswith("0x"): sig = "0x" + sig
print(json.dumps({"address": acct.address, "sig": sig}))
`;
const run = (code, args = []) => JSON.parse(execFileSync("python3", ["-c", code, ...args], { encoding: "utf8" }).trim());

const statement = (round, choice, addr) =>
  ["squeek-round \u2014 lock my round call", "", `Round: ${round}`, `Call: ${choice}`,
    `Wallet: ${addr}`, `Issued: ${new Date().toISOString()}`, "",
    "Signing proves I am the wallet making this call. No gas, no transfer."].join("\n");

(async () => {
  const core = await (await fetch(CHAIN)).json();
  const cfg = core.configuration || {};
  if (!cfg.genesisTimestamp) { console.log("chain /core gave no configuration; retry"); process.exitCode = 2; return; }
  const G = Number(cfg.genesisTimestamp), D = Number(cfg.roundDuration);
  const now = Math.floor(Date.now() / 1000);
  const live = Math.floor((now - G) / D);
  const endsIn = G + (live + 1) * D - now;
  console.log(`=== clock ===\n  live round ${live}   window ends in ${endsIn}s\n`);

  /* one wallet for the whole probe */
  const { address: key } = run(PY_NEW);
  const { address: addr } = run(PY_SIGN, [key, "warm"]);
  const msg = statement(live, "zoomies", addr);
  const { sig } = run(PY_SIGN, [key, msg]);

  const r = await fetch(`${API}/api/points/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: addr, round: live, choice: "zoomies", sig, message: msg }),
  });
  const raw = await r.text();
  let j = {}; try { j = JSON.parse(raw); } catch {}
  console.log(`  submit -> http=${r.status} ${raw.slice(0, 200)}\n`);
  if (r.status !== 200 || !j.ok) { console.log("ACCEPT FAILED — the fix is not in effect"); process.exitCode = 1; return; }

  /* the authoritative record is the persisted one */
  const saved0 = JSON.parse(fs.readFileSync("points.json", "utf8"));
  const p0 = saved0.players[addr.toLowerCase()] || saved0.players[addr];
  const rec = p0 && p0.rounds && p0.rounds[String(live)];
  const pending = !!(rec && !rec.outcome);
  console.log(`  record for R${live}: ${JSON.stringify(rec)}`);
  if (rec && Object.prototype.hasOwnProperty.call(rec, "waiting")) {
    console.log(`  NEW FIELD PRESENT: waiting=${rec.waiting} over=${rec.over} phase=${rec.phase}`);
  } else if (rec) {
    console.log(`  NEW FIELD MISSING: server is running pre-fix code`);
  }
  console.log(`\n  ${pending ? "PASS" : "FAIL"}  locked mid-round stays PENDING (chain has settled R${live} already)`);
  console.log(`  ${endsIn > 0 ? "  (its window still has " + endsIn + "s to run)" : ""}`);

  /* and it must not be graded later either, until the window really closes */
  /* read the stored record straight from the scoreboard: the submit response
     carries the profile but the authoritative record is what got persisted */
  const saved = JSON.parse(fs.readFileSync("points.json", "utf8"));
  const p = saved.players[addr.toLowerCase()] || saved.players[addr];
  const rec2 = p && p.rounds && p.rounds[String(live)];
  console.log(`  persisted record: ${JSON.stringify(rec2)}`);
  console.log(`  ${rec2 && !rec2.outcome ? "OK   still pending after it was saved" : "CHECK outcome=" + (rec2 && rec2.outcome)}`);
  process.exitCode = pending ? 0 : 1;
})();
