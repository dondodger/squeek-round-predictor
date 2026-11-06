/**
 * Minimal EIP-191 personal_sign recovery + verification, no dependencies.
 *
 * Why hand-rolled: the repo ships with zero node_modules (plain `node server.js`),
 * and pulling in ethers for one function would add an install step to a project
 * whose whole pitch is "run it with node".
 *
 * Recovered from secp256k1 by solving for the public key from the signature
 * (r, s, v) and the message hash, using node's built-in ECDH to do the curve
 * maths. Tested against ethers-computed fixtures in test_ecrecover.js.
 */
const crypto = require("crypto");

const P = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F");
const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const Gx = BigInt("0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798");
const Gy = BigInt("0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8");

function mod(a, m = P) {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function modinv(a, m = P) {
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return mod(old_s, m);
}

// affine add / double on secp256k1
function add(p1, p2) {
  if (p1 === null) return p2;
  if (p2 === null) return p1;
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  if (x1 === x2 && mod(y1 + y2) === 0n) return null;
  let lam;
  if (x1 === x2 && y1 === y2) {
    lam = mod(3n * x1 * x1 * modinv(2n * y1));
  } else {
    lam = mod((y2 - y1) * modinv(x2 - x1));
  }
  const x3 = mod(lam * lam - x1 - x2);
  const y3 = mod(lam * (x1 - x3) - y1);
  return [x3, y3];
}

function mul(k, pt) {
  let r = null;
  let p = pt;
  while (k > 0n) {
    if (k & 1n) r = add(r, p);
    p = add(p, p);
    k >>= 1n;
  }
  return r;
}

function sqrtMod(a) {
  // p % 4 === 3, so sqrt = a^((p+1)/4)
  return powmod(a, (P + 1n) / 4n, P);
}

function powmod(b, e, m) {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

function hexToBytes(h) {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  return Buffer.from(s.padStart(s.length + (s.length % 2), "0"), "hex");
}

/**
 * keccak256 — node's sha3-256 is NOT keccak256, so it is implemented here.
 */
function keccak256(bytes) {
  // Keccak-f[1600], rate 1088 bits / 136 bytes, padding 0x01..0x80 (Keccak, not SHA3)
  const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  const R = [
    [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
  ];
  const mask = (1n << 64n) - 1n;
  const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & mask;

  const st = Array.from({ length: 25 }, () => 0n);

  // pad: Keccak padding is 0x01 ... 0x80 (SHA-3 uses 0x06)
  const rate = 136;
  const padLen = rate - (bytes.length % rate);
  const padded = Buffer.alloc(bytes.length + padLen);
  bytes.copy(padded);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      st[i] ^= padded.readBigUInt64LE(off + i * 8);
    }
    // 24 rounds
    for (let round = 0; round < 24; round++) {
      // theta
      const C = [];
      for (let x = 0; x < 5; x++) C[x] = st[x] ^ st[x + 5] ^ st[x + 10] ^ st[x + 15] ^ st[x + 20];
      const D = [];
      for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let x = 0; x < 5; x++)
        for (let y = 0; y < 5; y++) st[x + 5 * y] ^= D[x];
      // rho + pi
      const B = Array(25).fill(0n);
      for (let x = 0; x < 5; x++)
        for (let y = 0; y < 5; y++) {
          const nx = y;
          const ny = (2 * x + 3 * y) % 5;
          B[nx + 5 * ny] = rotl(st[x + 5 * y], R[x][y]);
        }
      // chi
      for (let x = 0; x < 5; x++)
        for (let y = 0; y < 5; y++) {
          st[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & mask & B[((x + 2) % 5) + 5 * y]);
        }
      // iota
      st[0] ^= RC[round];
    }
  }

  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(st[i], i * 8);
  return out;
}

/**
 * Recover the address that signed `message` (EIP-191 personal_sign).
 * Returns a lowercase 0x address, or null if the signature is malformed.
 */
function recoverPersonalSign(message, signature) {
  try {
    const sig = hexToBytes(signature);
    if (sig.length !== 65) return null;
    const r = BigInt("0x" + sig.subarray(0, 32).toString("hex"));
    const s = BigInt("0x" + sig.subarray(32, 64).toString("hex"));
    let v = sig[64];
    if (v < 27) v += 27;
    if (v !== 27 && v !== 28) return null;
    if (r === 0n || s === 0n || r >= N || s >= N) return null;

    // EIP-191: hash "\x19Ethereum Signed Message:\n" + len + message
    const msgBytes = Buffer.from(message, "utf8");
    const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${msgBytes.length}`, "utf8");
    const digest = keccak256(Buffer.concat([prefix, msgBytes]));

    const z = BigInt("0x" + digest.toString("hex"));
    const recid = v - 27;

    // Q = r^-1 (s*R - z*G)
    const x = r + BigInt(recid >> 1) * N;
    if (x >= P) return null;
    const alpha = mod(x * x * x + 7n);
    let beta = sqrtMod(alpha);
    if (mod(beta) % 2n !== BigInt(recid & 1)) beta = mod(P - beta);
    const R = [x, beta];

    const rinv = modinv(r, N);
    const u1 = mod(-z * rinv, N);
    const u2 = mod(s * rinv, N);
    const Q = add(mul(u1, [Gx, Gy]), mul(u2, R));
    if (Q === null) return null;

    const pub = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(Q[0].toString(16).padStart(64, "0"), "hex"),
      Buffer.from(Q[1].toString(16).padStart(64, "0"), "hex"),
    ]);

    // address = last 20 bytes of keccak256(pubkey[1:])
    const h = keccak256(pub.subarray(1));
    return "0x" + h.subarray(12).toString("hex");
  } catch {
    return null;
  }
}

module.exports = { keccak256, recoverPersonalSign };
