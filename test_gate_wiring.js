/**
 * The wheel gate must reach the picker even when there is nothing else to draw.
 *
 * Regression test for a real bug. `applyWheelGate()` was first called from
 * inside renderMine(), which returns early when the connected wallet has no
 * calls yet:
 *
 *     if (!mine.length) { ...empty table...; return; }
 *     ... later ...
 *     applyWheelGate(...)          <- unreachable for a first-time visitor
 *
 * So the picker only ever closed for players who already had calls. Every new
 * player — the exact audience most likely to be scripted, and the one with
 * nothing to protect yet — saw three live buttons while the server was refusing
 * those same calls with 409. The bug was invisible to the logic tests, because
 * they exercised wheels and gates, not render order.
 *
 * This test therefore asserts the wiring, not the maths: the gate loader must be
 * invoked from boot() and must not be nested behind an early return.
 *
 * Run:  node test_gate_wiring.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "public", "app.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? "  \u2014 " + extra : ""}`); }
}

/** Slice a function body by brace matching, so nesting can be inspected. */
function bodyOf(source, header) {
  const start = source.indexOf(header);
  if (start === -1) return null;
  const open = source.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/* 1. the loader exists and reads the server's gate field */
check("loadWheelGate is defined", /\basync function loadWheelGate\s*\(/.test(SRC));
check("loadWheelGate reads /api/wheel", /loadWheelGate[\s\S]{0,400}?\/api\/wheel/.test(SRC));
check("loadWheelGate applies the server's gate verdict",
  /loadWheelGate[\s\S]{0,600}?applyWheelGate\s*\(\s*w\s*&&\s*w\.gate\s*\)/.test(SRC));

/* 2. boot() must call it — this is the wiring the bug broke */
const boot = bodyOf(SRC, "(function boot()");
check("boot() found", boot !== null);
if (boot) {
  check("boot() calls loadWheelGate", /\bloadWheelGate\s*\(\s*\)\s*;/.test(boot));
  check("boot() re-reads the gate on a timer",
    /setInterval\s*\(\s*loadWheelGate\s*,/.test(boot),
    "the wheel can stop while the page is open");
}

/* 3. it must NOT be called from inside renderMine(), which early-returns */
const renderMine = bodyOf(SRC, "async function renderMine()");
check("renderMine() found", renderMine !== null);
if (renderMine) {
  const early = renderMine.indexOf("return;");
  const gateAt = renderMine.indexOf("applyWheelGate");
  check("renderMine() no longer calls applyWheelGate",
    gateAt === -1,
    "must not hang the gate off a function that returns early for new players");
  check("the early return really does precede where the gate used to sit",
    early !== -1 && early < renderMine.length, "guard against the test going stale");
}

/* 4. the picker's disabled state is driven by the gate, not only by the clock */
const refreshLock = bodyOf(SRC, "function refreshLock()");
check("refreshLock() found", refreshLock !== null);
if (refreshLock) {
  check("refreshLock() consults wheelGate.resting",
    /wheelGate\.resting/.test(refreshLock),
    "otherwise a resting wheel leaves the lock button live on an open round");
  const restingAt = refreshLock.indexOf("wheelGate.resting");
  const disabledAt = refreshLock.indexOf("disabled = true");
  check("the resting check disables the button before the clock logic runs",
    restingAt !== -1 && disabledAt !== -1 && restingAt < disabledAt);
}

/* 5. the selection is cleared, so a stale pick cannot be submitted later */
const apply = bodyOf(SRC, "function applyWheelGate(gate)");
check("applyWheelGate() found", apply !== null);
if (apply) {
  check("applyWheelGate() disables every choice button", /\.choice/.test(apply) && /disabled\s*=/.test(apply));
  check("applyWheelGate() clears a stale selection", /state\.choice\s*=\s*null/.test(apply));
  check("applyWheelGate() reveals the explanation",
    /restingNote/.test(apply), "a greyed-out button with no reason reads as a bug");
}

/* 6. a failed read must not be mistaken for a healthy wheel */
check("a failed gate fetch does not force the picker open",
  !/catch\s*\{[^}]*applyWheelGate\s*\(\s*null\s*\)/.test(SRC.replace(/\s+/g, " ")) ||
  /resting:\s*!!\(gate/.test(SRC),
  "gate must be derived from the server payload, not assumed");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
