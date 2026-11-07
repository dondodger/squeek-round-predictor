/**
 * Tests for lib/ratelimit.js.
 *
 * The limiter is small, but it sits in front of the only write endpoint on the
 * site. If it is wrong in the permissive direction the ledger eats junk; wrong
 * in the strict direction real players get locked out of a free game for no
 * reason. Both are worth a test each.
 */
const assert = require("assert");
const { createLimiter, clientKey, WINDOW_MS } = require("./lib/ratelimit");

let pass = 0, fail = 0, group = "";
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};
const g = (name) => { group = name; console.log(`\n${name}`); };

/* ---- the allowance ---- */

g("allowance");

t("allows exactly `limit` calls inside one window", () => {
  const l = createLimiter({ limit: 3 });
  const now = 1_000_000;
  assert.deepStrictEqual(l.check("a", now), { ok: true });
  assert.deepStrictEqual(l.check("a", now), { ok: true });
  assert.deepStrictEqual(l.check("a", now), { ok: true });
  const fourth = l.check("a", now);
  assert.strictEqual(fourth.ok, false, "4th call should be refused");
});

t("refuses the call after the limit, not the limit-th", () => {
  const l = createLimiter({ limit: 1 });
  assert.strictEqual(l.check("a", 0).ok, true);
  assert.strictEqual(l.check("a", 0).ok, false);
});

t("retryAfter counts down as the window drains", () => {
  const l = createLimiter({ limit: 1, windowMs: 60_000 });
  const t0 = 5_000_000;
  l.check("a", t0);
  const at0 = l.check("a", t0);
  const at30 = l.check("a", t0 + 30_000);
  const at59 = l.check("a", t0 + 59_000);
  assert.strictEqual(at0.retryAfter, 60, "full window at the start");
  assert.strictEqual(at30.retryAfter, 30, "half left");
  assert.strictEqual(at59.retryAfter, 1, "rounds up, never 0");
  assert.ok(at59.retryAfter >= 1, "never tells a client to retry immediately");
});

t("retryAfter never reports zero", () => {
  const l = createLimiter({ limit: 1, windowMs: 1000 });
  const t0 = 0;
  l.check("a", t0);
  const last = l.check("a", t0 + 999);   // 1ms before reset
  assert.ok(last.retryAfter >= 1, `got ${last.retryAfter}`);
});

/* ---- key isolation ---- */

g("keys are independent");

t("one hot key does not spend another's allowance", () => {
  const l = createLimiter({ limit: 2 });
  const now = 0;
  l.check("a", now); l.check("a", now);          // a exhausted
  assert.strictEqual(l.check("a", now).ok, false);
  assert.strictEqual(l.check("b", now).ok, true, "b unaffected by a");
});

t("draining one key leaves another fully intact", () => {
  const l = createLimiter({ limit: 5 });
  const now = 100;
  for (let i = 0; i < 20; i++) l.check("hot", now);
  for (let i = 0; i < 5; i++) assert.strictEqual(l.check("cold", now).ok, true, `call ${i + 1}`);
  assert.strictEqual(l.check("cold", now).ok, false);
});

t("a refused call does not inflate the stored count", () => {
  /* Regression: `e.count++` used to run before the limit test, so 1000 refused
     calls drove count to 1000. retryAfter was computed from resetAt and stayed
     honest, but the inflated counter also charged 1000 units of sweep upkeep,
     firing sweeps far more often than intended. */
  const l = createLimiter({ limit: 2, windowMs: 60_000 });
  const now = 0;
  l.check("a", now); l.check("a", now);          // count = 2
  for (let i = 0; i < 1000; i++) l.check("a", now);
  assert.strictEqual(l.peek("a").count, 2, "count must stop at the limit");
});

/* ---- window rollover ---- */

g("window rollover");

t("allowance resets once the window expires", () => {
  const l = createLimiter({ limit: 2, windowMs: 60_000 });
  l.check("a", 0); l.check("a", 0);      // window opens at 0, closes at 60_000
  assert.strictEqual(l.check("a", 0).ok, false);
  assert.strictEqual(l.check("a", 60_000).ok, true, "new window, fresh allowance");
  assert.strictEqual(l.check("a", 60_000).ok, true, "fresh allowance is full");
  assert.strictEqual(l.check("a", 60_000).ok, false);
});

t("a key idle across many windows is not punished", () => {
  const l = createLimiter({ limit: 1, windowMs: 1000 });
  l.check("a", 0);
  assert.strictEqual(l.check("a", 5_000).ok, true);
});

/* ---- the documented burst ---- */

g("fixed-window boundary burst (known, bounded)");

t("peak is 2x limit across a boundary, and no worse", () => {
  /* A fixed window opens at the FIRST hit and closes windowMs later, so the
     boundary sits at firstHit+windowMs, not at a multiple of windowMs. Assert
     the boundary from the observed state rather than assuming where it is —
     the first two drafts of this test guessed and were wrong twice. */
  const l = createLimiter({ limit: 3, windowMs: 1000 });
  const burst = (at) => { let n = 0; for (let i = 0; i < 5; i++) if (l.check("a", at).ok) n++; return n; };

  const first = burst(1000);
  assert.strictEqual(first, 3, "first window grants the full allowance");
  const resetAt = l.peek("a").resetAt;
  assert.strictEqual(resetAt, 2000, "window closes windowMs after the first hit");

  assert.strictEqual(burst(resetAt - 1), 0, "just before the boundary: still spent");
  const second = burst(resetAt);
  assert.strictEqual(second, 3, "at the boundary a fresh allowance opens");
  assert.strictEqual(first + second, 6, "2x limit is the documented worst case");
});

/* ---- memory ---- */

g("memory");

t("expired keys are swept, so the map does not grow forever", () => {
  const l = createLimiter({ limit: 1, windowMs: 1000 });
  // 400 hits at t=0, all expiring at t=1000
  for (let i = 0; i < 400; i++) l.check("ip" + i, 0);
  // now move past their expiry and trip the sweep with fresh traffic
  for (let i = 0; i < 600; i++) l.check("new" + i, 5_000);
  assert.strictEqual(l.peek("ip0"), null, "expired entry swept");
  assert.strictEqual(l.peek("ip399"), null, "expired entry swept");
  assert.notStrictEqual(l.peek("new0"), null, "fresh entries remain");
});

t("a live key survives a sweep triggered by other keys", () => {
  const l = createLimiter({ limit: 1, windowMs: 60_000 });
  l.check("vip", 0);                       // expires at t=60000
  for (let i = 0; i < 600; i++) l.check("junk" + i, 30_000);  // sweep fires mid-life
  assert.notStrictEqual(l.peek("vip"), null, "unexpired entry must not be swept");
});

/* ---- client key extraction ---- */

g("clientKey");

const req = (headers = {}, remote) => ({ headers, socket: { remoteAddress: remote } });

t("prefers the first hop of X-Forwarded-For", () => {
  assert.strictEqual(clientKey(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })), "1.2.3.4");
});

t("falls back to x-real-ip", () => {
  assert.strictEqual(clientKey(req({ "x-real-ip": "9.9.9.9" })), "9.9.9.9");
});

t("falls back to the socket address", () => {
  assert.strictEqual(clientKey(req({}, "127.0.0.1")), "127.0.0.1");
});

t("never returns undefined for a bare request", () => {
  const k = clientKey(req({}));
  assert.strictEqual(typeof k, "string");
  assert.ok(k.length > 0);
});

t("ignores an empty X-Forwarded-For rather than keying everyone together", () => {
  assert.strictEqual(clientKey(req({ "x-forwarded-for": "", "x-real-ip": "8.8.8.8" })), "8.8.8.8");
});

t("strips whitespace around the first hop", () => {
  assert.strictEqual(clientKey(req({ "x-forwarded-for": "  4.4.4.4  , 1.1.1.1" })), "4.4.4.4");
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
