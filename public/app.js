/* Squeek Round Predictor — client
 * Reads Squeekchain public API + SqueekCore on Sepolia.
 * Locks your round call with a zero-gas wallet signature (EIP-191).
 */
const API = "https://api.squeekchain.com/v1";
const CORE = "0xfd6c166d4b8e2962e65746a13e5a0797cd4de0c4";
const RPC = "https://ethereum-sepolia.publicnode.com";
const CHAIN_ID = 11155111;
const ROUND_SECS = 600; // 10 minutes
const LS_CALLS = "sqk_predictor_calls_v1";

let p = { addr: null, choice: null };
const $ = (id) => document.getElementById(id);

/* ---------- helpers ---------- */
const hex = (n) => "0x" + BigInt(n).toString(16);
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}
function classify(passes) {
  const n = Number(passes);
  if (n === 0) return "nap";
  if (n < 500) return "jog";
  return "zoomies";
}
const fmt = (n) => new Intl.NumberFormat().format(n);
const short = (s) => (s ? s.slice(0, 6) + "…" + s.slice(-4) : "");

/* round number derived from genesis + round duration (chain configuration) */
let cfg = { genesisTimestamp: null, roundDuration: ROUND_SECS, settledThroughRound: null };
function currentRound() {
  if (!cfg.genesisTimestamp) return cfg.settledThroughRound ?? 0;
  const now = Math.floor(Date.now() / 1000);
  if (now < cfg.genesisTimestamp) return 0;
  return Math.floor((now - cfg.genesisTimestamp) / cfg.roundDuration);
}

/* ---------- live data ---------- */
async function loadLive() {
  try {
    const [status, core, setl] = await Promise.all([
      fetch(`${API}/status`).then((r) => r.json()),
      fetch(`${API}/core`).then((r) => r.json()),
      fetch(`${API}/settlements`).then((r) => r.json()),
    ]);
    const m = status.measurement || {};
    const a = (status.builder && status.builder.anchor) || {};
    const c = (core.configuration) || {};
    const k = (core.core) || {};

    cfg.genesisTimestamp = Number(c.genesisTimestamp) || cfg.genesisTimestamp;
    cfg.roundDuration = Number(c.roundDuration) || ROUND_SECS;
    cfg.settledThroughRound = Number(k.settledThroughRound || a.settledThroughRound || 0);

    const online = m.freshness === "online" && m.staleAfterSeconds > 0;
    $("liveDot").className = "dot " + (online ? "on" : "off");
    $("liveState").textContent = online
      ? `live · freshness ${m.freshness}`
      : `stale (${m.freshness || "unknown"})`;
    $("coreStatus").textContent = m.coreStatus || "—";
    $("rpm").textContent = ((Number(m.rpmMilli) || 0) / 1000).toFixed(2);
    $("roundDur").textContent = (cfg.roundDuration / 60).toFixed(0) + " min";
    $("settled").textContent = cfg.settledThroughRound || "—";
    $("blockHeight").textContent = a.blockHeight ? fmt(a.blockHeight) : "—";
    $("wpk").textContent = a.workPerThousandBlocks ? fmt(a.workPerThousandBlocks) : "—";

    renderRounds(setl);
    renderMine();
  } catch (e) {
    $("liveDot").className = "dot off";
    $("liveState").textContent = "api unreachable";
    console.warn("live load failed", e);
  }
}

/* recent rounds: settlements give settled round numbers + tx hashes.
 * passes per round come from the SqueekCore settlement payload (workAdded
 * on a 600s round == wheel passes). We bucket conservatively and mark
 * outcomes we can read directly. */
function renderRounds(setl) {
  const tb = document.querySelector("#rounds tbody");
  tb.innerHTML = "";
  const recent = (setl.recentSettlements || []).slice(0, 12);
  if (!recent.length) {
    tb.innerHTML = `<tr><td colspan="5">No settlements returned right now.</td></tr>`;
    return;
  }
  for (const s of recent) {
    const round = Number(s.settledThroughRound);
    const work = Number(s.workAdded) || 0;
    // one active round's work added ≈ passes for that round
    const passes = work;
    const outcome = classify(passes);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${round}</td>` +
      `<td><span class="tag ok">settled</span></td>` +
      `<td>${fmt(passes)}</td>` +
      `<td><span class="tag ${outcome}">${outcome}</span></td>` +
      `<td><a href="https://sepolia.etherscan.io/tx/${s.transactionHash}" target="_blank" rel="noopener">${short(s.transactionHash)}</a></td>`;
    tb.appendChild(tr);
  }
  $("upd").textContent = new Date().toLocaleTimeString();
}

/* ---------- wallet ---------- */
async function connect() {
  if (!window.ethereum) {
    setMsg("No wallet found. Install MetaMask or another EIP-1193 wallet.", "bad");
    return;
  }
  const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
  p.addr = addr.toLowerCase();
  $("walletLabel").textContent = short(addr);
  $("connectBtn").textContent = "Connected";
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hex(CHAIN_ID) }],
    });
  } catch (_) {
    try {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hex(CHAIN_ID),
          chainName: "Sepolia",
          nativeCurrency: { name: "SepoliaETH", symbol: "ETH", decimals: 18 },
          rpcUrls: [RPC],
          blockExplorerUrls: ["https://sepolia.etherscan.io"],
        }],
      });
    } catch (e2) { console.warn("chain switch skipped", e2); }
  }
  refreshLock();
  renderMine();
}

function setMsg(t, cls) {
  const el = $("lockMsg");
  el.textContent = t;
  el.className = "msg " + (cls || "");
}

function refreshLock() {
  $("lockBtn").disabled = !(p.addr && p.choice);
}

/* signed statement ties the caller to a wallet without any gas */
function statement(round, choice) {
  return [
    "Squeek Round Predictor — lock my call",
    "",
    `Round: ${round}`,
    `Call: ${choice}`,
    `Wallet: ${p.addr}`,
    `Issued: ${new Date().toISOString()}`,
    "",
    "Signing is free and does not move funds.",
  ].join("\n");
}

async function lockCall() {
  if (!p.addr || !p.choice) return;
  const round = currentRound();
  const msg = statement(round, p.choice);
  setMsg("Waiting for wallet signature…");
  try {
    const sig = await window.ethereum.request({
      method: "personal_sign",
      params: [msg, p.addr],
    });
    const calls = loadCalls();
    calls[`${p.addr}:${round}`] = {
      round, choice: p.choice, sig, at: Date.now(), addr: p.addr,
    };
    saveCalls(calls);
    setMsg(`Locked: round ${round} → ${p.choice}. Signature saved locally.`, "ok");
    renderMine();
  } catch (e) {
    setMsg(e && e.code === 4001 ? "Signature rejected." : "Signing failed.", "bad");
  }
}

function loadCalls() {
  try { return JSON.parse(localStorage.getItem(LS_CALLS) || "{}"); } catch { return {}; }
}
function saveCalls(c) { localStorage.setItem(LS_CALLS, JSON.stringify(c)); }

/* score my calls against settled rounds from the API */
let settledMap = {};
async function renderMine() {
  const calls = loadCalls();
  const mine = Object.values(calls).filter((c) => !p.addr || c.addr === p.addr);
  const tb = document.querySelector("#myTable tbody");
  tb.innerHTML = "";
  if (!mine.length) {
    tb.innerHTML = `<tr><td colspan="4">No calls yet. Connect a wallet and lock one.</td></tr>`;
    $("myCalls").textContent = "0";
    $("myHits").textContent = "0";
    $("myAcc").textContent = "—";
    return;
  }
  // fetch settlements to score
  let settled = {};
  try {
    const setl = await fetch(`${API}/settlements`).then((r) => r.json());
    for (const s of setl.recentSettlements || []) {
      settled[Number(s.settledThroughRound)] = Number(s.workAdded) || 0;
    }
  } catch {}
  let hits = 0, scored = 0;
  mine.sort((a, b) => b.round - a.round).forEach((c) => {
    const known = Object.prototype.hasOwnProperty.call(settled, c.round);
    let outcome = "—", res = `<span class="tag bad">pending</span>`;
    if (known) {
      outcome = classify(settled[c.round]);
      scored++;
      if (outcome === c.choice) { res = `<span class="tag ok">hit</span>`; hits++; }
      else res = `<span class="tag bad">miss</span>`;
    }
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${c.round}</td>` +
      `<td><span class="tag ${c.choice}">${c.choice}</span></td>` +
      `<td>${known ? `<span class="tag ${outcome}">${outcome}</span>` : "—"}</td>` +
      `<td>${res}</td>`;
    tb.appendChild(tr);
  });
  $("myCalls").textContent = mine.length;
  $("myHits").textContent = hits;
  $("myAcc").textContent = scored ? Math.round((hits / scored) * 100) + "%" : "—";
}

/* ---------- wire up ---------- */
$("connectBtn").addEventListener("click", connect);
$("lockBtn").addEventListener("click", lockCall);
document.querySelectorAll(".choice").forEach((b) => {
  b.addEventListener("click", () => {
    p.choice = b.dataset.c;
    document.querySelectorAll(".choice").forEach((x) => x.classList.toggle("sel", x === b));
    refreshLock();
    setMsg("");
  });
});

(function boot() {
  loadLive();
  setInterval(loadLive, 15000);
  setInterval(() => { $("curRound").textContent = currentRound(); }, 1000);
  if (window.ethereum) {
    window.ethereum.request({ method: "eth_accounts" }).then((a) => {
      if (a && a.length) { p.addr = a[0].toLowerCase(); $("walletLabel").textContent = short(a[0]); $("connectBtn").textContent = "Connected"; refreshLock(); renderMine(); }
    });
    window.ethereum.on && window.ethereum.on("accountsChanged", (a) => {
      p.addr = a && a.length ? a[0].toLowerCase() : null;
      $("walletLabel").textContent = p.addr ? short(a[0]) : "";
      refreshLock(); renderMine();
    });
  }
})();
