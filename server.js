/**
 * Squeek Round Predictor — static server + tiny JSON proxy
 * Serves ./public and exposes /proxy/* for the Squeekchain public API
 * (so the page keeps working even if a browser blocks a CORS header).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const points = require("./lib/points");
const rounds = require("./lib/rounds");
const wheel = require("./lib/wheel");
const reward = require("./lib/reward");
const { createLimiter, clientKey } = require("./lib/ratelimit");

const PORT = process.env.PORT || 8787;
const PUB = path.join(__dirname, "public");
const API = "https://api.squeekchain.com/v1";

/* Write-path protection. Three separate limits, because they stop three
   different things — none of them is anti-cheat (the signature check in
   points.js is; see the note in lib/ratelimit.js).

     submit  12/min per IP. A player locks at most one call per 10-minute round,
             so 12/min is roughly 100x a real player's pace: unreachable by
             hand, and reached by a script in seconds.
     api     240/min per IP. Caps the read endpoints. A page load fires three
             or four of these, and a player refreshing constantly still lands an
             order of magnitude under.
     body    8 KB. The largest legitimate body is a signature plus a short
             signed statement — around 400 bytes. Refusing anything bigger stops
             a caller from making the process buffer megabytes before we ever
             look at the JSON.

   All three are keyed per IP. A caller with a botnet is not stopped by any of
   this; it is stopped by needing a valid signature for every accepted call. */
const submitLimit = createLimiter({ limit: 12 });
const apiLimit = createLimiter({ limit: 240 });
const MAX_BODY = 8 * 1024;

/* Last wheel reading, so a frozen odometer can be detected between polls. */
let wheelPrev = null;
let wheelState = null;
let wheelStalled = 0;

/* Prize pool cache — see /api/reward. */
let rewardCache = null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function send(res, code, body, type) {
  res.writeHead(code, {
    "content-type": type || "text/plain; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-cache",
  });
  res.end(body);
}

// allowed upstream paths
const ALLOW = [
  /^\/status$/,
  /^\/core$/,
  /^\/settlements$/,
  /^\/economy\/state$/,
  /^\/accounts\/0x[a-fA-F0-9]{40}$/,
  /^\/accounts\/0x[a-fA-F0-9]{40}\/activity$/,
];

function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error("too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), "application/json; charset=utf-8");
}

/* Settled rounds, cached briefly: the write path needs them to grade a call
   and the public API should not be hammered on every request. */
/* Settlements observed since the last ingest, folded into the round archive so
   the hit-rate can be computed from every round we have ever seen rather than
   the ten the chain API exposes. */
const seen = [];
let settledCache = { at: 0, map: {} };
async function settledMap() {
  if (Date.now() - settledCache.at < 20000) return settledCache.map;
  try {
    const r = await fetch(`${API}/settlements`);
    const j = await r.json();
    const map = {};
    for (const s of j.recentSettlements || []) {
      const round = rounds.parseRound(s.settledThroughRound);
      const blocks = rounds.parseBlocks(s.completedBlockCount);
      /* Skip anything we cannot read cleanly. The old `Number(x) || 0` turned a
         blank or missing field into 0, and 0 grades as a nap — so a malformed
         settlement would have silently scored real calls against a round that
         never happened. */
      if (round === null || blocks === null) continue;
      map[round] = blocks;
      /* Fold every settlement we see into the local archive, which is what lets
         the hit-rate be computed from hundreds of rounds rather than the ten the
         API exposes. Cheap, idempotent, and it is what makes the numbers ours. */
      seen.push({ settledThroughRound: round, completedBlockCount: blocks });
    }
    rounds.ingest(seen.splice(0));
    settledCache = { at: Date.now(), map };
    return map;
  } catch {
    return settledCache.map;
  }
}

/* The round clock, so settle() can refuse to grade a round that is still open.
   The chain settles a round as soon as it has seen enough work, which can be
   before the round's 600s window closes — so the newest settlement may name the
   round the player is still calling, and grading against it paid out a call the
   moment it was locked. Kept in the scoreboard db so it survives a restart. */
let cfgCache = { at: 0, cfg: null };
async function roundClock() {
  if (Date.now() - cfgCache.at < 60000 && cfgCache.cfg) return cfgCache.cfg;
  try {
    const c = await (await fetch(`${API}/core`)).json();
    const cfg = c.configuration || {};
    points.setConfig(cfg);
    cfgCache = { at: Date.now(), cfg };
    return cfg;
  } catch {
    return cfgCache.cfg;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  /* Read-path ceiling, applied to every /api/ route here rather than repeated
     inside each handler. The submit route is deliberately excluded: it checks a
     much tighter limit of its own, and letting the loose limit run first would
     mean a spammer's first 240 submits were counted against the wrong bucket
     and the tight limit never told the real story. */
  if (url.pathname.startsWith("/api/") && url.pathname !== "/api/points/submit") {
    const rl = apiLimit.check(clientKey(req));
    if (!rl.ok) {
      res.setHeader("retry-after", String(rl.retryAfter));
      return json(res, 429, {
        error: "rate_limited",
        retryAfter: rl.retryAfter,
        limit: rl.limit,
      });
    }
  }

  /* ------------- scoreboard API (own data, not an upstream proxy) ------- */

  if (url.pathname === "/api/points/submit" && req.method === "POST") {
    /* Rate limit first, and before reading the body: the point of the limit is
       to not do work for a caller who is over it. The body limit below is the
       only sane way to bound the cost of parsing an untrusted payload. */
    const rl = submitLimit.check(clientKey(req));
    if (!rl.ok) {
      res.setHeader("retry-after", String(rl.retryAfter));
      return json(res, 429, {
        error: "rate_limited",
        retryAfter: rl.retryAfter,
        limit: rl.limit,
      });
    }

    try {
      const raw = await readBody(req, MAX_BODY);
      const body = JSON.parse(raw || "{}");
      /* Warm the round clock before validating: lockCall() needs it to tell an
         open round from a closed one, and a cold server would otherwise have no
         way to answer and would refuse every call. */
      await roundClock();
      let out = points.lockCall(body);
      if (!out.ok && out.reason === "no_clock") {
        out = points.lockCall(body);   // clock just warmed; retry once
      }
      if (!out.ok) return json(res, 400, { error: out.reason });
      /* grade immediately: the player should see the points the moment the
         round they called has settled, without waiting for the next visit */
      await roundClock();
      const m = await settledMap();
      points.settle(points.player(body.address), m);
      points.save();
      return json(res, 200, {
        ok: true,
        duplicate: !!out.duplicate,
        profile: points.getProfile(body.address),
      });
    } catch (e) {
      /* A body that never arrives is worth distinguishing from a body we
         refuse: the first is the caller's fault, the second is malformed or
         oversized, and conflating them made an 8 KB cap look like a bad
         request. 413 is the honest code for the cap. */
      if (e && e.message === "too_large")
        return json(res, 413, { error: "body_too_large", limit: MAX_BODY });
      return json(res, 400, { error: "bad_request" });
    }
  }

  if (url.pathname === "/api/points/leaderboard") {
    /* Named ranking. `?limit=` is clamped inside leaderboard() so a huge
       value cannot ask the process to build a million-row array. */
    const limit = url.searchParams.get("limit");
    return json(
      res,
      200,
      points.leaderboard(limit ? { limit: Number(limit) } : {}),
    );
  }

  /* The local round archive: how often each band really fires, across every
     settled round we have collected — not the ten the chain API exposes.
     Calls settledMap() first so a page load is enough to keep the archive
     growing, even on a quiet day with no calls to submit. */
  if (url.pathname === "/api/points/hitrate") {
    await settledMap();
    return json(res, 200, rounds.hitRate());
  }

  /* The season's prize pool, read live off Sepolia. Cached for a minute: the
     balance only moves when Don funds it or a payout goes out, and this keeps
     the public RPC from being called on every page view. */
  if (url.pathname === "/api/reward") {
    const now = Date.now();
    if (rewardCache && now - rewardCache.at < 60000) return json(res, 200, rewardCache.body);
    const body = await reward.pool();
    rewardCache = { at: now, body };
    return json(res, 200, body);
  }

  /* The wheel's own telemetry, summarised. The UI needs this to stop labelling
     every ungated call "pending" — a round whose wheel never turned can never
     be graded, and saying "pending" there is a lie the player waits on for
     hours. See lib/wheel.js. */
  async function refreshWheel() {
    const [st, setl] = await Promise.all([
      fetch(`${API}/status`).then((r) => r.json()),
      fetch(`${API}/settlements`).then((r) => r.json()),
    ]);
    const w = wheel.readWheel(st, wheelPrev);
    wheelPrev = { odometer: w.odometer };
    wheelState = w;
    wheelStalled = wheel.stalledRounds(setl);
    return { ...w, stalledRounds: wheelStalled, checkedAt: new Date().toISOString() };
  }

  if (url.pathname === "/api/wheel") {
    try {
      return json(res, 200, await refreshWheel());
    } catch (e) {
      /* Never guess. If the chain is unreachable we say so rather than implying
         the wheel is fine. */
      return json(res, 200, {
        turning: false,
        stuck: false,
        unknown: true,
        reason: "chain telemetry unreachable",
        error: String((e && e.message) || e),
      });
    }
  }

  if (url.pathname.startsWith("/api/points/profile/")) {
    const addr = decodeURIComponent(url.pathname.slice("/api/points/profile/".length));
    const prof = points.getProfile(addr);
    if (!prof) return json(res, 400, { error: "bad_address" });
    /* grade anything already settled before answering, so the fresh grades are
       included in the explanation we send back */
    if (!prof.empty) {
      await roundClock();
      const m = await settledMap();
      if (points.settle(points.player(addr), m)) points.save();
      /* The profile must know whether the wheel is turning, otherwise an
         ungated call reads as "pending" and the player waits on nothing. Fetch
         it here when no /api/wheel call has populated it yet — the page may
         well be the first one opened. */
      if (!wheelState) {
        try {
          await refreshWheel();
        } catch {
          /* leave wheelState null; the UI falls back to "pending" */
        }
      }
      const out = points.getProfileExplained(addr);
      out.wheel = wheelState;
      out.stalledRounds = wheelStalled;
      return json(res, 200, out);
    }
    return json(res, 200, prof);
  }

  /* ------------------------- upstream proxy ---------------------------- */

  if (url.pathname.startsWith("/proxy/")) {
    const sub = url.pathname.slice("/proxy".length);
    if (!ALLOW.some((r) => r.test(sub))) return send(res, 403, "forbidden");
    try {
      const r = await fetch(API + sub + (url.search || ""));
      const text = await r.text();
      return send(res, r.status, text, "application/json; charset=utf-8");
    } catch (e) {
      return send(res, 502, JSON.stringify({ error: "upstream_unreachable" }), "application/json");
    }
  }

  /* pretty URL: /profile serves public/profile.html */
  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  if (rel === "/profile" || rel === "/profile/") rel = "/profile.html";
  const file = path.join(PUB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUB)) return send(res, 403, "forbidden");

  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "not found");
    send(res, 200, data, MIME[path.extname(file)] || "application/octet-stream");
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Squeek Round Predictor listening on http://127.0.0.1:${PORT}`);
  /* Learn the round clock at boot so the very first call after a restart can be
     judged instead of refused. */
  roundClock()
    .then((c) => console.log("round clock:", c && c.genesisTimestamp ? `${c.genesisTimestamp}/${c.roundDuration}s` : "unavailable"))
    .catch(() => {});
});
