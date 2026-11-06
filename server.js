/**
 * Squeek Round Predictor — static server + tiny JSON proxy
 * Serves ./public and exposes /proxy/* for the Squeekchain public API
 * (so the page keeps working even if a browser blocks a CORS header).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const points = require("./lib/points");

const PORT = process.env.PORT || 8787;
const PUB = path.join(__dirname, "public");
const API = "https://api.squeekchain.com/v1";

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
let settledCache = { at: 0, map: {} };
async function settledMap() {
  if (Date.now() - settledCache.at < 20000) return settledCache.map;
  try {
    const r = await fetch(`${API}/settlements`);
    const j = await r.json();
    const map = {};
    for (const s of j.recentSettlements || []) {
      map[Number(s.settledThroughRound)] = Number(s.completedBlockCount) || 0;
    }
    settledCache = { at: Date.now(), map };
    return map;
  } catch {
    return settledCache.map;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  /* ------------- scoreboard API (own data, not an upstream proxy) ------- */

  if (url.pathname === "/api/points/submit" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const out = points.lockCall(body);
      if (!out.ok) return json(res, 400, { error: out.reason });
      /* grade immediately: the player should see the points the moment the
         round they called has settled, without waiting for the next visit */
      const m = await settledMap();
      points.settle(points.player(body.address), m);
      points.save();
      return json(res, 200, {
        ok: true,
        duplicate: !!out.duplicate,
        profile: points.getProfile(body.address),
      });
    } catch (e) {
      return json(res, 400, { error: "bad_request" });
    }
  }

  if (url.pathname === "/api/points/leaderboard") {
    return json(res, 200, points.stats());
  }

  if (url.pathname.startsWith("/api/points/profile/")) {
    const addr = decodeURIComponent(url.pathname.slice("/api/points/profile/".length));
    const prof = points.getProfile(addr);
    if (!prof) return json(res, 400, { error: "bad_address" });
    /* grade anything already settled before answering */
    if (!prof.empty) {
      const m = await settledMap();
      if (points.settle(points.player(addr), m)) points.save();
      return json(res, 200, points.getProfile(addr));
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
});
