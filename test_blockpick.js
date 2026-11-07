/* Does preferring `projected` over `anchor` actually pick the LIVE block — and
   does it degrade safely when the builder view is missing?
   Run: node test_blockpick.js */
const assert = require("assert");

/* the exact rule we shipped in public/app.js */
function pickLive(status) {
  const a = (status.builder && status.builder.anchor) || {};
  const pj = (status.builder && status.builder.projected) || {};
  return Number(pj.blockHeight) > Number(a.blockHeight) ? pj : a;
}

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log("  ok   " + name);
  } catch (e) {
    console.log("  FAIL " + name + "\n       " + e.message);
    process.exitCode = 1;
  }
};

/* payload captured from api.squeekchain.com/v1/status while the wheel was
   turning but the chain had not settled for a while — this is the exact case
   that froze the site at 1140 while the builder was at 1219 */
const REAL_STUCK = {
  builder: {
    anchor: { blockHeight: "1185", blockProgress: "652792547", cumulativeWork: "11453" },
    projected: {
      blockHeight: "1219",
      blockProgress: "395463196",
      completedBlockCount: "34",
      firstCompletedBlock: "1186",
      lastCompletedBlock: "1219",
    },
  },
};

t("picks projected when it is ahead (the real bug)", () => {
  const live = pickLive(REAL_STUCK);
  assert.strictEqual(live.blockHeight, "1219", "should show the builder's live block");
  assert.strictEqual(live.blockProgress, "395463196");
  assert.strictEqual(live.completedBlockCount, "34");
});

t("falls back to anchor when projected is absent", () => {
  const live = pickLive({ builder: { anchor: { blockHeight: "1185" } } });
  assert.strictEqual(live.blockHeight, "1185");
});

t("falls back to anchor when projected is empty object", () => {
  const live = pickLive({ builder: { anchor: { blockHeight: "1185" }, projected: {} } });
  assert.strictEqual(live.blockHeight, "1185");
});

t("never goes backwards: equal heights keep anchor (confirmed wins)", () => {
  const live = pickLive({
    builder: {
      anchor: { blockHeight: "1185", confirmed: true },
      projected: { blockHeight: "1185" },
    },
  });
  assert.strictEqual(live.confirmed, true, "on a tie, keep the confirmed record");
});

t("projected behind anchor (stale builder) does not rewind the chain", () => {
  const live = pickLive({
    builder: { anchor: { blockHeight: "1219" }, projected: { blockHeight: "1185" } },
  });
  assert.strictEqual(live.blockHeight, "1219");
});

t("no builder at all does not throw", () => {
  const live = pickLive({});
  assert.strictEqual(live.blockHeight, undefined);
});

t("blockHeight 0 in projected does not beat a real anchor", () => {
  const live = pickLive({
    builder: { anchor: { blockHeight: "10" }, projected: { blockHeight: "0" } },
  });
  assert.strictEqual(live.blockHeight, "10", "Number('0') > 10 is false, so anchor holds");
});

t("strings are compared numerically, not lexically", () => {
  /* "999" > "1185" is TRUE as a string compare — the trap. Must be numeric. */
  const live = pickLive({
    builder: { anchor: { blockHeight: "999" }, projected: { blockHeight: "1185" } },
  });
  assert.strictEqual(live.blockHeight, "1185", "numeric compare: 1185 > 999");
});

console.log(`\n${pass}/8 passed`);
