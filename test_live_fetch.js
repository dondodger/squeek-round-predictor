#!/usr/bin/env node
/**
 * A rejected fetch in loadLive() freezes the entire live panel.
 *
 * The regression this guards against: `loadLive` fetches four endpoints inside
 * one Promise.all, and `/measurement/blocks` was called with a `?t=<ts>`
 * cache-buster that the API rejects with HTTP 400 {"error":"invalid_query"}.
 * One 400 rejected the whole Promise.all, so the wheel board sat on PARKED and
 * the block numbers stopped moving — while the wheel was actually turning.
 * The owner saw a live wheel next to a parked board and called it drift.
 *
 * Two things must hold, and neither is about maths:
 *   1. no chain endpoint is called with a query string
 *   2. a single failing endpoint must not blank the whole panel
 */
const fs = require("fs");
const path = require("path");

const app = fs.readFileSync(path.join(__dirname, "public/app.js"), "utf8");
let pass = 0, fail = 0;

function ok(name, fn) {
  try { fn(); console.log("  PASS " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n        " + e.message); fail++; }
}

ok("no chain endpoint is fetched with a query string", () => {
  /* Match fetch(`${API}/path?whatever`) — the API documents no query params on
     these endpoints and 400s on any it does not know. */
  const bad = [...app.matchAll(/fetch\(`\$\{API\}(\/[^`?]*)\?[^`]*`\)/g)];
  if (bad.length)
    throw new Error(
      "cache-busted chain calls (API returns 400 invalid_query): " +
        bad.map((m) => m[1]).join(", ")
    );
});

ok("no hardcoded api.squeekchain.com URL with a query string", () => {
  const bad = [...app.matchAll(/https:\/\/api\.squeekchain\.com\/([^\s"'`?]*)\?[^\s"'`]*/g)];
  if (bad.length)
    throw new Error("hardcoded query-string API URLs: " + bad.map((m) => m[1]).join(", "));
});

ok("/measurement/blocks is still the source for the live block", () => {
  if (!/\/measurement\/blocks/.test(app))
    throw new Error("the provisional-block endpoint is gone — the live block number has no source");
});

ok("loadLive isolates each endpoint so one failure cannot blank the panel", () => {
  /* Look for a per-call catch: `fetch(...).then(...).catch(` or a helper that
     returns a fallback. Without one, a single 400/500 rejects Promise.all. */
  const all = app.indexOf("Promise.all(");
  const seg = app.slice(all, all + 1400);
  const perCallCatch = /\.catch\(/.test(seg) || /safeGet|softGet|tolerant/.test(seg);
  if (!perCallCatch)
    throw new Error(
      "loadLive's Promise.all has no per-endpoint fallback: one failing endpoint " +
        "still freezes every number on the page"
    );
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
