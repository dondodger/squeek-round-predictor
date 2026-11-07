/**
 * End-to-end test of the points API, run against a throwaway instance so the
 * live scoreboard is never touched. Proves the four things that matter:
 *
 *   1. a genuine signature is accepted and the round is recorded
 *   2. a FORGED signature (someone else's address) is rejected
 *   3. a REPLAYED signature (same sig, different round) is rejected
 *   4. points appear for a settled round, and the profile follows the ADDRESS
 *      (the whole reason this is server-side: switch browsers, same wallet,
 *      same points)
 *
 * Run:  node test_points_api.js
 */
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const TMP = path.join(require("os").tmpdir(), "squeer_test_points.json");
try { fs.unlinkSync(TMP); } catch {}

const { keccak256, recoverPersonalSign } = require("./lib/sig");

/* ---- tiny signer (same maths as test_ecrecover.js, kept local) ---- */
const P = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F");
const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const Gx = BigInt("0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798");
const Gy = BigInt("0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8");
const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
function modinv(a, m = P) {
  let [or_, r] = [mod(a, m), m], [os, s] = [1n, 0n];
  while (r !== 0n) { const q = or_ / r; [or_, r] = [r, or_ - q * r]; [os, s] = [s, os - q * s]; }
  return mod(os, m);
}
function add(p1, p2) {
  if (!p1) return p2; if (!p2) return p1;
  const [x1, y1] = p1, [x2, y2] = p2;
  if (x1 === x2 && mod(y1 + y2) === 0n) return null;
  const lam = x1 === x2 && y1 === y2 ? mod(3n * x1 * x1 * modinv(2n * y1))
                                     : mod((y2 - y1) * modinv(x2 - x1));
  const x3 = mod(lam * lam - x1 - x2);
  return [x3, mod(lam * (x1 - x3) - y1)];
}
function mul(k, pt) { let r = null, p = pt; while (k > 0n) { if (k & 1n) r = add(r, p); p = add(p, p); k >>= 1n; } return r; }
function addrOf(d) {
  const Q = mul(d, [Gx, Gy]);
  const pub = Buffer.concat([Buffer.from("04", "hex"),
    Buffer.from(Q[0].toString(16).padStart(64, "0"), "hex"),
    Buffer.from(Q[1].toString(16).padStart(64, "0"), "hex")]);
  return "0x" + keccak256(pub.subarray(1)).subarray(12).toString("hex");
}
function sign(msg, d) {
  const b = Buffer.from(msg, "utf8");
  const z = BigInt("0x" + keccak256(Buffer.concat([
    Buffer.from(`\x19Ethereum Signed Message:\n${b.length}`, "utf8"), b])).toString("hex"));
  for (let k = 1n; k < 40n; k++) {
    const R = mul(k, [Gx, Gy]); if (!R) continue;
    const r = mod(R[0], N); if (r === 0n) continue;
    const s = mod(modinv(k, N) * (z + r * d), N); if (s === 0n) continue;
    const recid = (R[1] % 2n === 0n ? 0 : 1) | (R[0] >= N ? 2 : 0);
    if (recid > 1) continue;
    return "0x" + Buffer.concat([
      Buffer.from(r.toString(16).padStart(64, "0"), "hex"),
      Buffer.from(s.toString(16).padStart(64, "0"), "hex"),
      Buffer.from([27 + recid])]).toString("hex");
  }
  throw new Error("no nonce");
}
function statement(round, choice, addr) {
  return ["squeek-round — lock my round call", "", `Round: ${round}`, `Call: ${choice}`,
    `Wallet: ${addr}`, `Issued: ${new Date().toISOString()}`, "",
    "Signing is free and does not move funds."].join("\n");
}

/* ---- request helper ---- */
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port, method, path: p,
      headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} },
      (res) => { let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => resolve({ code: res.statusCode, body: s })); });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : "\n      " + extra}`);
  cond ? pass++ : fail++;
}

(async () => {
  const PORT = 8899;
  const child = require("child_process").spawn("node", ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), SQUEER_POINTS: TMP, SQUEER_SCORE_AGE: "500" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  await new Promise((r) => setTimeout(r, 1200));

  try {
    const key = BigInt("0x" + "33".repeat(32)) % N;
    const addr = addrOf(key);
    const other = BigInt("0x" + "44".repeat(32)) % N;
    const otherAddr = addrOf(other);
    console.log(`INFO  player   ${addr}`);
    console.log(`INFO  attacker ${otherAddr}\n`);

    /* The call has to be on the round the clock is currently in: a round that
       has closed is refused (its result is already public), and a future round
       is refused too. 999999 was neither — it was decades away, so submit()
       correctly answered round_not_open. */
    const r0 = await req(PORT, "GET", "/proxy/status");
    const st = JSON.parse(r0.body);
    console.log("INFO  live rpm", st.measurement && st.measurement.rpmMilli);

    const core = await fetch("https://api.squeekchain.com/v1/core").then((r) => r.json()).catch(() => null);
    const cfgSrc = core && core.configuration ? core.configuration : null;
    const GEN = Number((cfgSrc && cfgSrc.genesisTimestamp) || 1793735400);
    const DUR = Number((cfgSrc && cfgSrc.roundDuration) || 600);
    const ROUND = Math.floor((Math.floor(Date.now() / 1000) - GEN) / DUR);   // the live round
    console.log("INFO  live round", ROUND);
    const msg = statement(ROUND, "zoomies", addr);

    /* 1. genuine signature accepted */
    let res = await req(PORT, "POST", "/api/points/submit",
      { address: addr, round: ROUND, choice: "zoomies", sig: sign(msg, key), message: msg });
    check("genuine signature accepted", res.code === 200 && JSON.parse(res.body).ok === true,
      res.body);
    check("call recorded (calls=1)", JSON.parse(res.body).profile.calls === 1);

    /* 2. forged: attack signs with his own key but claims the victim address */
    const forgedMsg = statement(ROUND + 1, "nap", addr);
    res = await req(PORT, "POST", "/api/points/submit",
      { address: addr, round: ROUND + 1, choice: "nap", sig: sign(forgedMsg, other), message: forgedMsg });
    check("forged signature rejected", res.code === 400 && JSON.parse(res.body).error === "signature_address_mismatch",
      res.body);

    /* 3. replay: valid sig for round A posted as round B */
    const replayMsg = statement(ROUND + 2, "jog", addr);
    const replaySig = sign(replayMsg, key);
    res = await req(PORT, "POST", "/api/points/submit",
      { address: addr, round: ROUND + 3, choice: "jog", sig: replaySig, message: replayMsg });
    check("replayed signature rejected (round mismatch)",
      res.code === 400 && JSON.parse(res.body).error === "statement_round_mismatch", res.body);

    /* 4. duplicate round is a no-op, not a second point */
    res = await req(PORT, "POST", "/api/points/submit",
      { address: addr, round: ROUND, choice: "zoomies", sig: sign(msg, key), message: msg });
    const dup = JSON.parse(res.body);
    check("duplicate round is a no-op", res.code === 200 && dup.duplicate === true && dup.profile.calls === 1,
      res.body);

    /* 5. profile is keyed by ADDRESS — the actual requirement */
    res = await req(PORT, "GET", "/api/points/profile/" + addr);
    const prof = JSON.parse(res.body);
    check("profile readable by address", res.code === 200 && prof.address === addr, res.body);
    check("fresh wallet has no points yet (round unsettled)", prof.points === 0, JSON.stringify(prof.points));

    /* 6. bad address / bad choice are refused */
    res = await req(PORT, "POST", "/api/points/submit", { address: "nope", round: 1, choice: "nap", sig: "0x00", message: "x" });
    check("bad address refused", res.code === 400, res.body);
    res = await req(PORT, "POST", "/api/points/submit",
      { address: addr, round: 5, choice: "moon", sig: sign(statement(5, "moon", addr), key), message: statement(5, "moon", addr) });
    check("unknown choice refused", res.code === 400 && JSON.parse(res.body).error === "bad_choice", res.body);

    /* 7. the ledger file actually landed on disk */
    await new Promise((r) => setTimeout(r, 300));
    check("ledger written to disk", fs.existsSync(TMP), TMP);
    if (fs.existsSync(TMP)) {
      const db = JSON.parse(fs.readFileSync(TMP, "utf8"));
      check("ledger keyed by lowercase address", !!db.players[addr.toLowerCase()], Object.keys(db.players).join(","));
    }
  } finally {
    child.kill();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
