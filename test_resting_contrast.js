/**
 * Contrast check for the resting state.
 *
 * The disabled picker uses opacity:0.5, which is where accessibility usually
 * breaks: the text colour is fine on its own, but compositing it at 50% over the
 * panel can drop it under 4.5:1. The rule here is not "does it look ok" — it is
 * the measured ratio, and a change to any of these colours must be re-measured.
 *
 * Which is why this prints the numbers rather than asserting a vibe: the earlier
 * pass on this project reported "fixed" for text that painted black on black.
 */

/* WCAG relative luminance + contrast. */
function lum(hex) {
  const h = hex.replace("#", "");
  const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = v.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function ratio(a, b) {
  const l1 = lum(a);
  const l2 = lum(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite `fg` over `bg` at `alpha` — what opacity actually renders. */
function over(fg, bg, alpha) {
  const f = fg.replace("#", "");
  const b = bg.replace("#", "");
  const mix = [0, 2, 4].map((i) => {
    const fc = parseInt(f.slice(i, i + 2), 16);
    const bc = parseInt(b.slice(i, i + 2), 16);
    return Math.round(fc * alpha + bc * (1 - alpha));
  });
  return "#" + mix.map((c) => c.toString(16).padStart(2, "0")).join("");
}

/* The palette actually declared in public/style.css :root — read from the file,
   not retyped, so this cannot drift from what ships. */
const fs = require("fs");
const css = fs.readFileSync("public/style.css", "utf8");
function token(name) {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
  if (!m) throw new Error(`token --${name} not found in style.css`);
  return m[1];
}

const text = token("text");
const surface = token("surface");
const surface2 = token("surface-2");
const gold = token("gold");

console.log("palette read from style.css:");
console.log(`  --text      ${text}`);
console.log(`  --surface   ${surface}`);
console.log(`  --surface-2 ${surface2}`);
console.log(`  --gold      ${gold}`);
console.log();

const rows = [];

/* The resting note sits on --surface-2 with no opacity: plain text, must pass. */
rows.push([".resting-note body", text, surface2, 1]);
rows.push([".resting-note <b>", gold, surface2, 1]);

/* The disabled picker: text composited at 0.5 over --surface. */
const dimText = over(text, surface, 0.5);
rows.push([".choice:disabled text", dimText, surface, 1]);
const dimGoldOnSel = over(gold, surface, 0.5);
rows.push([".choice:disabled glyph (gold)", dimGoldOnSel, surface, 1]);

let worst = Infinity;
let fails = 0;
for (const [label, fg, bg, alpha] of rows) {
  const r = ratio(fg, bg) * 1;
  const off = label.includes("disabled") || label.includes("glyph");
  /* Disabled controls are exempt from WCAG 1.4.3, but "exempt" is not "invisible":
     hold the dimmed text to 3:1 (the large-text / UI-component floor) so a player
     can still read what the options are. */
  const floor = off ? 3.0 : 4.5;
  const ok = r >= floor;
  if (!ok) fails++;
  if (r < worst) worst = r;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(30)} ${r.toFixed(2)}:1  (floor ${floor})`);
}

console.log();
console.log(`worst ratio: ${worst.toFixed(2)}:1`);
if (fails) {
  console.log(`${fails} below floor \u2014 raise the opacity or lighten the colour.`);
  process.exit(1);
}
console.log("all above floor.");
