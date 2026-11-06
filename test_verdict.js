/**
 * Tests for lib/verdict.js — the plain-language story of a graded call.
 *
 * Two features hang off this: the per-call autopsy (what went right or wrong,
 * and by how much) and the share text. Both put numbers in front of a player, so
 * the phrasing has to stay honest at the edges — a field that is missing must
 * not be quietly rendered as a zero, which is the same trap that bit the round
 * archive. Values arrive from the API as strings, so that is what is tested.
 */
const assert = require("assert");
const verdict = require("./lib/verdict");

let pass = 0;
const ok = (name, fn) => {
  try {
    fn();
    console.log("  PASS  " + name);
    pass++;
  } catch (e) {
    console.log("  FAIL  " + name + "\n        " + e.message);
    process.exitCode = 1;
  }
};

console.log("verdict.js");

/* ---------- gap: how far off a hit was ---------- */
ok("gap: under the target reports blocks short", () => {
  const v = verdict.gap("jog", 33);
  assert.strictEqual(v.direction, "under");
  assert.strictEqual(v.blocks, 7, "33 -> 40 is 7 short");
});

ok("gap: past the target reports blocks over", () => {
  const v = verdict.gap("zoomies", 48);
  assert.strictEqual(v.direction, "over");
  assert.strictEqual(v.blocks, 8);
});

ok("gap: exactly on the target is neither", () => {
  const v = verdict.gap("zoomies", 40);
  assert.strictEqual(v.blocks, 0);
});

ok("gap: a missing reading is null, never zero", () => {
  assert.strictEqual(verdict.gap("jog", null), null);
  assert.strictEqual(verdict.gap("jog", ""), null);
  assert.strictEqual(verdict.gap("jog", "--"), null);
  assert.strictEqual(verdict.gap("jog", undefined), null);
});

/* ---------- autopsy: the one-line explanation ---------- */
ok("autopsy: a hit says so and names the call", () => {
  const t = verdict.autopsy({ round: 358, choice: "jog", outcome: "jog", blocks: 33, award: 10 });
  assert.ok(/358/.test(t), "round missing: " + t);
  assert.ok(/jog/i.test(t), "call missing: " + t);
  assert.ok(/33/.test(t), "blocks missing: " + t);
});

ok("autopsy: a jog called as zoomies says how many blocks short", () => {
  const t = verdict.autopsy({
    round: 360,
    choice: "zoomies",
    outcome: "jog",
    blocks: 33,
    award: 0,
  });
  assert.ok(/7/.test(t), "the 7-block gap is missing from: " + t);
});

ok("autopsy: a nap called during a real round says the wheel moved", () => {
  const t = verdict.autopsy({
    round: 361,
    choice: "nap",
    outcome: "jog",
    blocks: 12,
    award: 0,
  });
  assert.ok(/turned|moved/i.test(t), "should say the wheel turned: " + t);
  assert.ok(/12/.test(t), "should carry the block reading: " + t);
});

ok("autopsy: a miss never claims the player was right", () => {
  const t = verdict.autopsy({
    round: 362,
    choice: "zoomies",
    outcome: "nap",
    blocks: 0,
    award: 0,
  });
  assert.ok(!/\byou got it\b|\bcorrect\b|\bnice\b/i.test(t), "false praise: " + t);
  assert.ok(/0/.test(t), "should mention the 0 blocks: " + t);
});

ok("autopsy: missing blocks degrades honestly, no invented number", () => {
  const t = verdict.autopsy({ round: 363, choice: "jog", outcome: "jog", blocks: null, award: 10 });
  assert.ok(/363/.test(t));
  assert.ok(!/0 blocks/.test(t), "null blocks leaked in as 0: " + t);
});

ok("autopsy: missing blocks never produces machine grammar", () => {
  /* the live bug: with no reading this used to say "it called Jog" */
  for (const rec of [
    { round: 1, choice: "jog", outcome: "jog", blocks: null },
    { round: 2, choice: "nap", outcome: "zoomies", blocks: null },
    { round: 3, choice: "zoomies", outcome: "nap", blocks: null },
    { round: 4, choice: "jog", outcome: "nap", blocks: "" },
  ]) {
    const t = verdict.autopsy(rec);
    assert.ok(!/it called/i.test(t), "machine grammar in: " + t);
    assert.ok(!/\bnull\b|\bNaN\b|undefined/i.test(t), "leaked a JS value: " + t);
    assert.ok(t.length > 20, "sentence too thin: " + t);
  }
});

ok("autopsy: a hit with no reading still reads like a sentence", () => {
  const t = verdict.autopsy({ round: 358, choice: "jog", outcome: "jog", blocks: null });
  assert.ok(/landed/i.test(t), "should say it landed: " + t);
  assert.ok(!/\bnull\b/.test(t));
});

ok("autopsy: a miss with no reading names the band it came in as", () => {
  const t = verdict.autopsy({ round: 357, choice: "nap", outcome: "zoomies", blocks: null });
  assert.ok(/zoomies/i.test(t), "should name the outcome band: " + t);
  assert.ok(!/it called/i.test(t));
});

ok("autopsy: never states the same fact twice in one line", () => {
  /* live bug: "it was a Zoomies. Missed — it came in as a Zoomies." — the
     outcome was announced twice. The band name itself is allowed to appear more
     than once (a Nap call explained by "so it was not a nap" is a real
     sentence), but the block count and the outcome statement must not repeat. */
  for (const rec of [
    { round: 1, choice: "nap", outcome: "zoomies", blocks: null },
    { round: 2, choice: "nap", outcome: "zoomies", blocks: 48 },
    { round: 3, choice: "jog", outcome: "jog", blocks: 20 },
    { round: 4, choice: "zoomies", outcome: "jog", blocks: 33 },
    { round: 5, choice: "nap", outcome: "jog", blocks: 12 },
    { round: 6, choice: "jog", outcome: "zoomies", blocks: 52 },
  ]) {
    const t = verdict.autopsy(rec);
    const nums = rec.blocks === null ? [] : (t.match(/\d+/g) || []);
    const dupes = nums.filter((n, i) => nums.indexOf(n) !== i);
    assert.strictEqual(dupes.length, 0, `block count repeated in: ${t}`);
  }
});

ok("autopsy: the outcome band is stated, not announced twice", () => {
  const t = verdict.autopsy({ round: 2, choice: "nap", outcome: "zoomies", blocks: 48 });
  const statements = (t.toLowerCase().match(/a zoomies|was a zoomies|is a zoomies|as a zoomies/g) || []);
  assert.ok(statements.length <= 1, "outcome announced twice in: " + t);
});

ok("autopsy: never writes 'a Zoomies' — the band is a plural name", () => {
  /* Caught in a rendered screenshot: "it came in as a Zoomies" is wrong, the
     band is called Zoomies and takes no article. */
  for (const rec of [
    { round: 1, choice: "nap", outcome: "zoomies", blocks: null },
    { round: 2, choice: "nap", outcome: "zoomies", blocks: 48 },
    { round: 3, choice: "nap", outcome: "zoomies", blocks: 0 },
    { round: 4, choice: "jog", outcome: "zoomies", blocks: 52 },
  ]) {
    const t = verdict.autopsy(rec);
    assert.ok(!/\ba Zoomies\b/i.test(t), "bad article in: " + t);
  }
});

ok("autopsy: a still wheel facing a Zoomies call says it never turned", () => {
  const t = verdict.autopsy({ round: 417, choice: "zoomies", outcome: "nap", blocks: 0 });
  assert.ok(/never turned/i.test(t), "should say the wheel never turned: " + t);
  assert.ok(!/40 blocks short/i.test(t), "0 blocks is not '40 short': " + t);
});

ok("autopsy: a bonus is called out when it was paid", () => {
  const t = verdict.autopsy({
    round: 364,
    choice: "jog",
    outcome: "jog",
    blocks: 20,
    award: 15,
    bonus: 5,
  });
  assert.ok(/streak/i.test(t), "bonus not mentioned: " + t);
});

ok("autopsy: no bonus means no streak talk", () => {
  const t = verdict.autopsy({ round: 365, choice: "jog", outcome: "jog", blocks: 20, award: 10 });
  assert.ok(!/streak/i.test(t), "streak mentioned without a bonus: " + t);
});

/* ---------- share line ---------- */
ok("share: a hit reads naturally and carries the round", () => {
  const t = verdict.share({ round: 358, choice: "zoomies", outcome: "zoomies", blocks: 48, streak: 3 });
  assert.ok(/358/.test(t));
  assert.ok(/48/.test(t));
  assert.ok(/3/.test(t), "streak missing: " + t);
});

ok("share: a streak of one is not bragged about", () => {
  const t = verdict.share({ round: 359, choice: "jog", outcome: "jog", blocks: 20, streak: 1 });
  assert.ok(!/streak/i.test(t), "one hit called a streak: " + t);
});

ok("share: a miss is not spun as a win", () => {
  const t = verdict.share({ round: 360, choice: "jog", outcome: "nap", blocks: 0, streak: 0 });
  assert.ok(!/\bwon\b|\bhit\b|\bnailed\b/i.test(t), "miss spun as a win: " + t);
});

ok("share: stays short enough for a post", () => {
  const t = verdict.share({ round: 12345, choice: "zoomies", outcome: "zoomies", blocks: 999, streak: 12 });
  assert.ok(t.length <= 180, "too long: " + t.length);
});

console.log("\n" + pass + "/22 passed");
