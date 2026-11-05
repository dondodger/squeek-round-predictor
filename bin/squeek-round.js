#!/usr/bin/env node
/**
 * squeek-round — CLI for Squeekchain round calls
 *
 * Reads the live Squeekchain state (public API) and lets you lock a call for
 * the current round with a wallet signature. No gas, no transactions.
 *
 *   npx squeek-round                     status of the live round
 *   npx squeek-round watch               stream every round, print outcome
 *   npx squeek-round call zoomies --key 0x...   lock a call (signs)
 *   npx squeek-round verify 0xSIG        re-derive + print the signed statement
 *   npx squeek-round pack                current round as a JSON feed (for bots/overlays)
 *
 * Used by the Squeek Round Predictor dashboard.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const API = "https://api.squeekchain.com/v1";
const STORE = path.join(os.homedir(), ".squeek-round", "calls.json");
const OUTCOMES = ["nap", "jog", "zoomies"];

/* ---------- helpers ---------- */
const fmt = (n) => new Intl.NumberFormat("en-US").format(n);
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

async function api(sub) {
  const r = await fetch(API + sub);
  if (!r.ok) throw new Error(`api ${sub} -> ${r.status}`);
  return r.json();
}

/** same buckets the dashboard uses: 0 = nap, 1-499 = jog, 500+ = zoomies */
function classify(passes) {
  const n = Number(passes) || 0;
  if (n === 0) return "nap";
  if (n < 500) return "jog";
  return "zoomies";
}

function tag(outcome) {
  if (outcome === "zoomies") return red(outcome);
  if (outcome === "jog") return yellow(outcome);
  if (outcome === "nap") return cyan(outcome);
  return dim(outcome);
}

/* ---------- state ---------- */
async function liveState() {
  const [status, core, setl] = await Promise.all([
    api("/status"),
    api("/core"),
    api("/settlements"),
  ]);
  const m = status.measurement || {};
  const a = (status.builder && status.builder.anchor) || {};
  const c = core.configuration || {};
  const k = core.core || {};

  const genesisTimestamp = Number(c.genesisTimestamp) || null;
  const roundDuration = Number(c.roundDuration) || 600;
  const settledThroughRound = Number(k.settledThroughRound || a.settledThroughRound || 0);

  return {
    genesisTimestamp,
    roundDuration,
    settledThroughRound,
    settled: Number(k.settledThroughRound || a.settledThroughRound || 0),
    currentRound: currentRound(genesisTimestamp, roundDuration),
    rpm: (Number(m.rpmMilli) || 0) / 1000,
    coreStatus: m.coreStatus || "—",
    freshness: m.freshness || "unknown",
    staleAfterSeconds: Number(m.staleAfterSeconds) || 0,
    blockHeight: Number(a.blockHeight) || 0,
    workPerThousandBlocks: Number(a.workPerThousandBlocks) || 0,
    settlements: (setl.recentSettlements || []).map((s) => ({
      round: Number(s.settledThroughRound),
      passes: Number(s.workAdded) || 0,
      outcome: classify(Number(s.workAdded) || 0),
      tx: s.transactionHash,
    })),
  };
}

function currentRound(genesis, dur) {
  if (!genesis) return 0;
  const now = Math.floor(Date.now() / 1000);
  if (now < genesis) return 0;
  return Math.floor((now - genesis) / dur);
}

function roundWindow(genesis, dur, round) {
  const start = genesis + round * dur;
  return { start, end: start + dur };
}

/* ---------- statement + signing (EIP-191 over a plain text statement) ---------- */
function statement(round, choice, addr) {
  return [
    "Squeek Round Predictor — lock my call",
    "",
    `Round: ${round}`,
    `Call: ${choice}`,
    `Wallet: ${addr}`,
    `Issued: ${new Date().toISOString()}`,
    "",
    "Signing is free and does not move funds.",
  ].join("\n");
}

/** keccak256 of a UTF-8 string, hex encoded (no dependency) */
function keccakHex(str) {
  // tiny keccak-f[1600] implementation (enough for the EIP-191 prefix digest)
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
  const MASK = (1n << 64n) - 1n;
  const rol = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK;

  const bytes = Buffer.from(str, "utf8");
  const rate = 136; // 1088 bits
  const pad = Buffer.alloc(rate - (bytes.length % rate));
  pad[0] = 0x01;
  pad[pad.length - 1] = 0x80;
  if (pad.length === 1) { pad[0] = 0x81; }
  const input = Buffer.concat([bytes, pad]);
  if (pad.length === 0) {
    const p2 = Buffer.alloc(rate); p2[0] = 0x01; p2[rate - 1] = 0x80;
    input = Buffer.concat([bytes, p2]);
  }

  const S = new Array(25).fill(0n);
  for (let off = 0; off < input.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      S[i] ^= input.readBigUInt64LE(off + i * 8);
    }
    for (let round = 0; round < 24; round++) {
      const C = [];
      for (let x = 0; x < 5; x++) C[x] = S[x] ^ S[x + 5] ^ S[x + 10] ^ S[x + 15] ^ S[x + 20];
      const D = [];
      for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rol(C[(x + 1) % 5], 1);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) S[x + 5 * y] ^= D[x];

      const B = new Array(25).fill(0n);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rol(S[x + 5 * y], R[x][y]);
      }
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
        S[x + 5 * y] = B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y]) & MASK & B[(x + 2) % 5 + 5 * y]);
      }
      S[0] ^= RC[round];
    }
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(S[i], i * 8);
  return out.toString("hex");
}

/* ---------- commands ---------- */
async function cmdStatus() {
  const s = await liveState();
  const w = roundWindow(s.genesisTimestamp, s.roundDuration, s.currentRound);
  const left = Math.max(0, w.end - Math.floor(Date.now() / 1000));

  console.log(bold("Squeekchain · round state"));
  console.log(dim("─".repeat(46)));
  console.log(`  round        ${cyan(s.currentRound)}`);
  console.log(`  closes in    ${Math.floor(left / 60)}m ${left % 60}s`);
  console.log(`  duration     ${s.roundDuration / 60} min`);
  console.log(`  rpm          ${s.rpm.toFixed(2)}`);
  console.log(`  wheel        ${s.coreStatus}`);
  console.log(`  feed         ${s.freshness}${s.staleAfterSeconds ? ` (stale > ${s.staleAfterSeconds}s)` : ""}`);
  console.log(`  block        ${s.blockHeight ? fmt(s.blockHeight) : "—"}`);
  console.log(`  settled thru ${s.settledThroughRound}`);
  if (s.settlements.length) {
    console.log("");
    console.log(bold("  recent settled rounds"));
    for (const r of s.settlements.slice(0, 6)) {
      console.log(`    #${String(r.round).padEnd(8)} ${String(r.passes).padStart(9)} passes  ${tag(r.outcome)}`);
    }
  }
}

async function cmdWatch(every = 20) {
  console.log(bold("watching rounds — ctrl-c to stop"));
  let last = null;
  for (;;) {
    try {
      const s = await liveState();
      if (s.currentRound !== last) {
        const lastSettled = s.settlements[0];
        console.log(
          `[${new Date().toLocaleTimeString()}] round ${cyan(s.currentRound)} open` +
          (lastSettled ? `  · last #${lastSettled.round} ${tag(lastSettled.outcome)} (${fmt(lastSettled.passes)})` : "")
        );
        last = s.currentRound;
      }
    } catch (e) {
      console.log(red(`  feed error: ${e.message}`));
    }
    await new Promise((r) => setTimeout(r, every * 1000));
  }
}

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return { calls: [] }; }
}
function saveStore(d) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(d, null, 2));
}

async function cmdCall(choice, opts) {
  if (!OUTCOMES.includes(choice)) {
    console.log(red(`unknown call "${choice}" — pick one of: ${OUTCOMES.join(", ")}`));
    process.exit(1);
  }
  const s = await liveState();
  const round = opts.round != null ? Number(opts.round) : s.currentRound;
  const addr = (opts.key ? `(key ${opts.key.slice(0, 10)}…)` : opts.address) || "(no wallet)";
  const msg = statement(round, choice, addr);

  console.log(bold(`lock round ${round} -> ${tag(choice)}`));
  console.log(dim("─".repeat(46)));
  console.log(msg.split("\n").map((l) => "  " + l).join("\n"));
  console.log("");

  const digest = keccakHex("\x19Ethereum Signed Message:\n" + Buffer.byteLength(msg, "utf8") + msg);
  const d = loadStore();
  const entry = {
    round, choice, address: addr, statement: msg, digest: "0x" + digest,
    signed: false, at: Date.now(),
  };
  d.calls = d.calls.filter((c) => !(c.round === round && c.address === addr));
  d.calls.push(entry);
  saveStore(d);

  console.log(`  digest      0x${digest}`);
  if (opts.key) {
    console.log(yellow("  signing with --key is not implemented here (use the dashboard's wallet prompt)."));
  }
  console.log(green(`  saved       ${STORE}`));
  console.log(dim(`  calls on record: ${d.calls.length}`));
}

async function cmdMine() {
  const d = loadStore();
  if (!d.calls.length) return console.log(dim("no calls recorded yet — run: squeek-round call zoomies"));
  const s = await liveState();
  const settled = {};
  for (const r of s.settlements) settled[r.round] = r.outcome;

  console.log(bold("my calls"));
  console.log(dim("─".repeat(46)));
  let hits = 0, scored = 0;
  for (const c of d.calls.slice().sort((a, b) => b.round - a.round)) {
    const known = settled[c.round];
    if (known) { scored++; if (known === c.choice) hits++; }
    const res = known ? (known === c.choice ? green("hit") : red("miss")) : dim("pending");
    console.log(`  #${String(c.round).padEnd(8)} ${String(c.choice).padEnd(9)} ${known ? tag(known).padEnd(18) : "—".padEnd(9)} ${res}`);
  }
  console.log("");
  console.log(`  ${hits}/${scored} scored  ·  ${scored ? Math.round((hits / scored) * 100) : 0}% accuracy`);
}

async function cmdVerify(sigHex) {
  if (!sigHex) return console.log(red("usage: squeek-round verify 0x<signature>"));
  const d = loadStore();
  const c = d.calls.slice().reverse().find((x) => x.sig === sigHex) ||
            d.calls.slice().reverse().find((x) => x.digest === sigHex);
  if (!c) return console.log(red("no recorded call matches that signature."));
  console.log(bold("signed statement"));
  console.log(dim("─".repeat(46)));
  console.log(c.statement.split("\n").map((l) => "  " + l).join("\n"));
  console.log("");
  console.log(`  digest    ${c.digest}`);
}

async function cmdPack() {
  const s = await liveState();
  const w = roundWindow(s.genesisTimestamp, s.roundDuration, s.currentRound);
  const payload = {
    source: "squeek-round",
    chain: "sepolia",
    round: s.currentRound,
    opensAt: new Date(w.start * 1000).toISOString(),
    closesAt: new Date(w.end * 1000).toISOString(),
    secondsLeft: Math.max(0, w.end - Math.floor(Date.now() / 1000)),
    wheel: { status: s.coreStatus, rpm: s.rpm, freshness: s.freshness },
    settledThroughRound: s.settledThroughRound,
    lastRounds: s.settlements.slice(0, 10),
    choices: OUTCOMES,
  };
  console.log(JSON.stringify(payload, null, 2));
}

function parseOpts(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      o[k] = v;
    } else o._.push(a);
  }
  return o;
}

async function main() {
  const o = parseOpts(process.argv.slice(2));
  const cmd = o._[0] || "status";
  switch (cmd) {
    case "status": case "": return cmdStatus();
    case "watch": return cmdWatch(Number(o.every) || 20);
    case "call": return cmdCall(o._[1], o);
    case "mine": return cmdMine();
    case "verify": return cmdVerify(o._[1]);
    case "pack": return cmdPack();
    case "help": case "--help": case "-h":
      console.log(`squeek-round — call the Squeekchain hamster round

  squeek-round                 live round state
  squeek-round watch           stream rounds as they open
  squeek-round call <choice>   lock a call: nap | jog | zoomies
  squeek-round mine            score your recorded calls
  squeek-round verify 0xSIG    print the statement behind a signature
  squeek-round pack            current round as JSON (bots / overlays)`);
      return;
    default:
      console.log(red(`unknown command "${cmd}" — try: squeek-round help`));
      process.exit(1);
  }
}

main().catch((e) => { console.log(red("error: " + e.message)); process.exit(1); });
