/**
 * Squeek Round Predictor — static server + tiny JSON proxy
 * Serves ./public and exposes /proxy/* for the Squeekchain public API
 * (so the page keeps working even if a browser blocks a CORS header).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

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

  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
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
