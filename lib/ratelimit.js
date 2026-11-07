/**
 * A small fixed-window rate limiter, in memory.
 *
 * Scope, stated plainly so nobody later mistakes this for more than it is: this
 * keeps one client from filling the ledger or burning the box's CPU. It is NOT
 * what makes the scoreboard trustworthy — the signature check in points.js is.
 * A determined attacker with many wallets is not stopped here and was never
 * going to be; see the note at the bottom of this file.
 *
 * Fixed window rather than sliding: one integer per key, no timers, no arrays
 * that grow. The trade-off is the classic boundary burst — a caller can spend
 * its whole allowance at the end of one window and again at the start of the
 * next, so the effective peak is 2x the limit. For a write endpoint that a
 * human triggers once per ten-minute round, 2x of "generous" is still fine, and
 * the memory guarantee is worth more than the precision.
 */

const WINDOW_MS = 60_000;

/* Prune occasionally rather than on a timer, so an idle process does no work.
   Every PRUNE_EVERY hits we sweep entries whose window has expired; without
   this a long-lived process accumulates one entry per IP that ever visited. */
const PRUNE_EVERY = 500;

function createLimiter({ limit, windowMs = WINDOW_MS }) {
  const hits = new Map(); // key -> { count, resetAt }
  let sinceSweep = 0;

  function sweep(now) {
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }

  /**
   * @returns {{ ok: true } | { ok: false, retryAfter: number, limit: number }}
   *   retryAfter in whole seconds, always >= 1 so a client never sees "retry
   *   now" and immediately retries.
   */
  function check(key, now = Date.now()) {
    /* Sweep upkeep is charged to every request, including refused ones — an
       attacker hammering a spent key is exactly when the map is most likely to
       be full of dead entries, so counting those is the right call. */
    if (++sinceSweep >= PRUNE_EVERY) {
      sinceSweep = 0;
      sweep(now);
    }

    const e = hits.get(key);
    if (!e || e.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return { ok: true };
    }

    /* Only a request that is still inside its allowance advances the counter.
       Incrementing on refused calls let a caller drive `count` up without
       bound, which made retryAfter dishonest and — because the sweep rides on
       the same tally — let a flood of refusals trigger sweeps far more often
       than PRUNE_EVERY intended. The count now means "calls actually allowed
       this window" and stops at limit + 1. */
    if (e.count >= limit) {
      return {
        ok: false,
        retryAfter: Math.max(1, Math.ceil((e.resetAt - now) / 1000)),
        limit,
      };
    }

    e.count++;
    return { ok: true };
  }

  /* Exposed for tests: inspect without consuming, and reset between cases. */
  function peek(key) {
    return hits.get(key) || null;
  }
  function clear() {
    hits.clear();
    sinceSweep = 0;
  }

  return { check, peek, clear, limit };
}

/**
 * The client key for a request.
 *
 * X-Forwarded-For is trusted only for its FIRST hop, and only because this
 * server sits behind a reverse proxy on the same box. A client can forge the
 * header, so this key is a speed bump, not an identity — which is exactly the
 * level of assurance a "don't hammer me" limit needs. Anything that has to be
 * unforgeable belongs behind a signature, and the submit path already has one.
 */
function clientKey(req, fallback = "unknown") {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  return req.socket?.remoteAddress || fallback;
}

module.exports = { createLimiter, clientKey, WINDOW_MS };
