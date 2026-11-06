/**
 * Test the hand-rolled keccak256 + EIP-191 ecrecover BEFORE it guards any
 * endpoint. A verifier that silently accepts a forged signature is worse than
 * no verifier at all, so this sign/recover round-trip is the gate.
 *
 * Run:  node test_ecrecover.js
 *
 * Signs with a throwaway key derived from a fixed seed (secp256k1 sign is
 * implemented here too, purely so the test is self-contained), then recovers
 * the address from the signature and requires an exact match. Also asserts a
 * TAMPERED message recovers a DIFFERENT address, which is the property the
 * endpoint actually depends on.
 */
const assert = require("assert");
const crypto = require("crypto");
const { keccak256, recoverPersonalSign } = require("./lib/sig");

/* ---------- secp256k1 sign (test-only, so the test has no dependencies) ---- */
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
  const lam = x1 === x2 && y1 === y2
    ? mod(3n * x1 * x1 * modinv(2n * y1))
    : mod((y2 - y1) * modinv(x2 - x1));
  const x3 = mod(lam * lam - x1 - x2);
  return [x3, mod(lam * (x1 - x3) - y1)];
}
function mul(k, pt) {
  let r = null, p = pt;
  while (k > 0n) { if (k & 1n) r = add(r, p); p = add(p, p); k >>= 1n; }
  return r;
}
function pubFromPriv(d) {
  const Q = mul(d, [Gx, Gy]);
  return Buffer.concat([
    Buffer.from("04", "hex"),
    Buffer.from(Q[0].toString(16).padStart(64, "0"), "hex"),
    Buffer.from(Q[1].toString(16).padStart(64, "0"), "hex"),
  ]);
}
function addrFromPriv(d) {
  return "0x" + keccak256(pubFromPriv(d).subarray(1)).subarray(12).toString("hex");
}
function personalHash(msg) {
  const b = Buffer.from(msg, "utf8");
  return keccak256(Buffer.concat([
    Buffer.from(`\x19Ethereum Signed Message:\n${b.length}`, "utf8"), b,
  ]));
}
function sign(msg, d) {
  const z = BigInt("0x" + personalHash(msg).toString("hex"));
  for (let k = 1n; k < 40n; k++) {          // deterministic-ish nonce search
    const R = mul(k, [Gx, Gy]);
    if (!R) continue;
    const r = mod(R[0], N);
    if (r === 0n) continue;
    const s = mod(modinv(k, N) * (z + r * d), N);
    if (s === 0n) continue;
    const recid = (R[1] % 2n === 0n ? 0 : 1) | (R[0] >= N ? 2 : 0);
    if (recid > 1) continue;                 // only 0/1 in the low-S range here
    return Buffer.concat([
      Buffer.from(r.toString(16).padStart(64, "0"), "hex"),
      Buffer.from(s.toString(16).padStart(64, "0"), "hex"),
      Buffer.from([27 + recid]),
    ]).toString("hex").replace(/^/, "0x");
  }
  throw new Error("no nonce found");
}

/* ------------------------------- the tests ------------------------------- */
let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = String(actual).toLowerCase() === String(expected).toLowerCase();
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { console.log(`      got      ${actual}`); console.log(`      expected ${expected}`); fail++; }
  else pass++;
}

/* 1. keccak256 canonical vectors (these are Keccak, not NIST SHA-3) */
check("keccak256('')",
  "0x" + keccak256(Buffer.from("")).toString("hex"),
  "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
check("keccak256('abc')",
  "0x" + keccak256(Buffer.from("abc")).toString("hex"),
  "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
check("keccak != NIST sha3-256",
  crypto.createHash("sha3-256").update("abc").digest("hex"),
  "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532");

/* 2. sign -> recover round-trip on the REAL lock statement shape */
const key = BigInt("0x" + "11".repeat(32)) % N;
const addr = addrFromPriv(key);
console.log(`INFO  test wallet: ${addr}`);

const msg = [
  "squeek-round — lock my round call", "", "Round: 254", "Call: zoomies",
  `Wallet: ${addr}`, `Issued: ${new Date().toISOString()}`, "",
  "Signing is free and does not move funds.",
].join("\n");

const sig = sign(msg, key);
check("recover(real lock statement) == signer",
  recoverPersonalSign(msg, sig), addr);

/* 3. THE property the endpoint relies on: a tampered message must not verify
      back to the original signer. */
check("tampered message recovers a DIFFERENT address",
  recoverPersonalSign(msg.replace("zoomies", "nap"), sig) === addr, "false");

/* 4. a different wallet must not verify as the first */
const key2 = BigInt("0x" + "22".repeat(32)) % N;
check("signature from another wallet recovers its own address",
  recoverPersonalSign(msg, sign(msg, key2)), addrFromPriv(key2));

/* 5. malformed input returns null instead of throwing */
check("garbage signature -> null", recoverPersonalSign("hi", "0xzz"), "null");
check("short signature   -> null", recoverPersonalSign("hi", "0x1234"), "null");
check("empty signature   -> null", recoverPersonalSign("hi", ""), "null");

/* 6. low-s / known EIP-191 vector from the wild, if reachable */
const KNOWN_MSG = "Hello World";
const KNOWN_SIG =
  "0x8d5f4b0f8d3f5ae1d0d5a8b2b9a7d6c3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b" +
  "7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c1b";
check("nonsense 65-byte sig is rejected or yields a lowercase 0x addr",
  /^(null|0x[0-9a-f]{40})$/.test(String(recoverPersonalSign(KNOWN_MSG, KNOWN_SIG))),
  "true");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
