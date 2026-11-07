#!/usr/bin/env node
/**
 * Run every test against a scratch ledger.
 *
 * The rules that keep a player's scoreboard safe are enforced here rather than
 * trusted to each test file:
 *   - SQUEER_POINTS points the ledger at a throwaway file for the whole suite.
 *   - SQUEER_TEST=1 makes lib/points refuse to touch the live ledger at all, so
 *     a test that overwrites the path by accident throws instead of writing.
 *   - The live points.json is checksummed before and after; any change fails the
 *     run and names the test that caused it.
 *
 * Usage: node run-tests.js [name ...]      (no args = all)
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = __dirname;
const LIVE = path.join(ROOT, "points.json");
const SCRATCH = path.join(ROOT, ".run-tests-ledger.json");

const TESTS = [
  "test_roundphase", "test_finalgrade", "test_openround", "test_bindchoice",
  "test_expire", "test_blockpick", "test_wheel", "test_verdict",
  "test_streak", "test_points_api", "test_rounds", "test_waiting",
  "test_board_midround", "test_call_phase", "test_leaderboard",
];

const sha = (p) => (fs.existsSync(p) ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") : "absent");

const wanted = process.argv.slice(2);
const list = wanted.length ? wanted : TESTS;

/* seed the scratch ledger from nothing: tests build their own fixtures */
fs.writeFileSync(SCRATCH, JSON.stringify({ version: 1, config: null, players: {} }));

const before = sha(LIVE);
let failed = 0, passed = 0;
const dirty = [];

for (const name of list) {
  const file = path.join(ROOT, name + ".js");
  if (!fs.existsSync(file)) { console.log(`  ??   ${name} (no such test)`); failed++; continue; }
  const r = spawnSync(process.execPath, [file], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, SQUEER_POINTS: SCRATCH, SQUEER_TEST: "1", NODE_ENV: "test" },
  });
  const tail = (r.stdout || "").trim().split("\n").filter(Boolean).pop() || "(no output)";
  const ok = r.status === 0;
  if (ok) passed++; else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name.padEnd(18)} ${tail}`);
  if (sha(LIVE) !== before) { dirty.push(name); }
}

/* the scratch file is ours to remove; tell the caller if any test reached past it */
fs.rmSync(SCRATCH, { force: true });
for (const f of fs.readdirSync(ROOT)) {
  if (/^\.(run-tests|test-)/.test(f) && f.endsWith("-ledger.json")) fs.rmSync(path.join(ROOT, f), { force: true });
}

const after = sha(LIVE);
console.log(`\n${passed}/${passed + failed} test files passed`);
if (after !== before) {
  console.log(`\nTHE LIVE LEDGER CHANGED during: ${dirty.join(", ")}`);
  console.log("A test is writing to points.json — fix it, that file is the players'.");
  process.exit(1);
}
console.log("live ledger untouched");
process.exit(failed ? 1 : 0);
