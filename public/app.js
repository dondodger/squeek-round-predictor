/* ===========================================================
   squeek-round — client
   Reads the public Squeekchain API + SqueekCore on Sepolia.
   Drives the Gibby character from live wheel telemetry and
   locks round calls with a zero-gas wallet signature (EIP-191).
   =========================================================== */

const API = "https://api.squeekchain.com/v1";
const RPC = "https://ethereum-sepolia.publicnode.com";
const CHAIN_ID = 11155111;
const ROUND_SECS_DEFAULT = 600;
const LS_CALLS = "squeekround_calls_v1";

const $ = (id) => document.getElementById(id);
const fmt = (n) => new Intl.NumberFormat().format(n);
const short = (s) => (s ? s.slice(0, 6) + "\u2026" + s.slice(-4) : "");
const hex = (n) => "0x" + BigInt(n).toString(16);

const state = { addr: null, choice: null, rpm: 0, core: null, cfg: null, lastBlocks: 0, blockTarget: 40 };

/* ---------------- calls that the wheel can make ----------------
   The categories are ours, but the line between them is the chain's own
   targetBlocksPerActiveRound (40, read live from /core). A round that seals
   40+ blocks beat the target the core was aiming for; under that it just
   jogged along; a round with no blocks at all is a nap. Nothing is guessed —
   every grade is computed from completedBlockCount on a settled round.
   ---------------------------------------------------------------- */

function blockTarget() {
  return Number(state.blockTarget) || 40;
}

function classify(blocks) {
  const n = Number(blocks) || 0;
  if (n === 0) return "nap";
  if (n < blockTarget()) return "jog";
  return "zoomies";
}

const GRADE_LABEL = { nap: "Nap", jog: "Jog", zoomies: "Zoomies" };

/* ---------------- helpers ---------------- */

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

/* round number straight from the chain's own configuration */
function currentRound() {
  const c = state.cfg;
  if (!c || !c.genesisTimestamp) return c ? c.settledThroughRound ?? 0 : 0;
  const now = Math.floor(Date.now() / 1000);
  if (now < c.genesisTimestamp) return 0;
  return Math.floor((now - c.genesisTimestamp) / c.roundDuration);
}
function roundEndsIn() {
  const c = state.cfg;
  if (!c || !c.genesisTimestamp) return null;
  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - c.genesisTimestamp;
  if (elapsed < 0) return null;
  return c.roundDuration - (elapsed % c.roundDuration);
}

/* ---------------- Gibby: animation driven by real data ---------------- */

function buildSpokes() {
  const g = $("wheelSpokes");
  if (!g || g.childElementCount) return;
  const ns = "http://www.w3.org/2000/svg";
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const ln = document.createElementNS(ns, "line");
    ln.setAttribute("x1", 160);
    ln.setAttribute("y1", 140);
    ln.setAttribute("x2", (160 + Math.cos(a) * 94).toFixed(2));
    ln.setAttribute("y2", (140 + Math.sin(a) * 94).toFixed(2));
    g.appendChild(ln);
  }
}

/* --- Gibby, driven entirely by live chain telemetry ----------------------
   Squeekchain's work is done by a real hamster wheel (the wheel.counter
   module, usb-rp2040-a3144e-lm393). The API exposes rpmMilli / speedMmPerSecond
   / distanceMm every second. Gibby is that runner: when the wheel turns, he
   runs; when the wheel stops, he stops. Nothing here reacts to clicks.
   ------------------------------------------------------------------------ */
let runPhase = 0;       // radians, drives the gait cycle
let wheelDeg = 0;       // degrees, true drum rotation from live rpm
let lastFrame = 0;      // ms timestamp
let liveRpm = 0;        // rpm smoothed toward what the API reports

function tick(now) {
  if (!lastFrame) lastFrame = now;
  const dt = Math.min(0.1, (now - lastFrame) / 1000); // clamp tab-switch jumps
  lastFrame = now;

  // ease toward the reported rpm so the gait never snaps
  const target = state.rpm || 0;
  liveRpm += (target - liveRpm) * Math.min(1, dt * 3);

  // the character is gone; the live readout is updated from the same numbers
  const running = liveRpm > 0.15;
  const rate = Math.max(0, Math.min(1, liveRpm / 8)); // 0..1 effort

  const roRpm = $("roRpm");
  if (roRpm) roRpm.textContent = Math.round(liveRpm).toString();
  const roFill = $("roFill");
  if (roFill) {
    const C = 2 * Math.PI * 88; // r=88 in the 200x200 dial
    roFill.setAttribute("stroke-dasharray", C.toFixed(1));
    roFill.setAttribute("stroke-dashoffset", (C * (1 - rate)).toFixed(1));
  }
  const roDist = $("roDist");
  if (roDist && state.distanceMm != null) {
    roDist.textContent = (state.distanceMm / 1000).toFixed(2) + " m";
  }
  const roWork = $("roWork");
  if (roWork && state.workUnits != null) {
    roWork.textContent = Number(state.workUnits).toLocaleString();
  }
  const roState = $("roState");
  if (roState) {
    const label = !running ? "PARKED" : rate > 0.5 ? "RUNNING" : "TROTTING";
    if (roState.textContent !== label) roState.textContent = label;
    roState.className = "state-badge " + (!running ? "idle" : rate > 0.5 ? "fast" : "run");
  }

  // status words track the live chain state, never a click
  const mode = !state.core
    ? "reading the wheel"
    : !running
      ? "parked \u00b7 core " + String(state.core).toLowerCase()
      : rate > 0.5
        ? "full tilt"
        : "jogging along";
  const hud = $("hudMode");
  if (hud && hud.textContent !== mode) hud.textContent = mode;

  const cap = !running
    ? "waiting on the chain"
    : rate > 0.5
      ? "full tilt"
      : "jogging along";
  const capEl = $("capMode");
  if (capEl && capEl.textContent !== cap) capEl.textContent = cap;

  const badge = $("stateBadge");
  if (badge) {
    const label = !running ? "PARKED" : rate > 0.5 ? "RUNNING" : "TROTTING";
    if (badge.textContent !== label) badge.textContent = label;
    badge.className = "state-badge " + (!running ? "idle" : rate > 0.5 ? "fast" : "run");
  }

  requestAnimationFrame(tick);
}

function announceBlock() {
  // a new block landed: brief accent on the rpm dial, no character to animate
  const ring = document.querySelector(".ro-ring");
  if (!ring) return;
  ring.classList.remove("pulse");
  void ring.offsetWidth;
  ring.classList.add("pulse");
}

/* ---------------- live data ---------------- */

async function loadLive() {
  try {
    const [status, core, setl] = await Promise.all([
      fetch(`${API}/status`).then((r) => r.json()),
      fetch(`${API}/core`).then((r) => r.json()),
      fetch(`${API}/settlements`).then((r) => r.json()),
    ]);

    const m = status.measurement || {};
    const a = (status.builder && status.builder.anchor) || {};
    const c = core.configuration || {};
    const k = core.core || {};

    state.cfg = {
      genesisTimestamp: Number(c.genesisTimestamp) || null,
      roundDuration: Number(c.roundDuration) || ROUND_SECS_DEFAULT,
      settledThroughRound: Number(k.settledThroughRound || a.settledThroughRound || 0),
    };
    // the grading line comes off the chain too, so it moves if the core retunes
    state.blockTarget = Number(c.targetBlocksPerActiveRound) || state.blockTarget;
    state.maxWorkPerRound = Number(c.maxWorkPerRound) || null;
    state.core = m.coreStatus || null;
    state.rpm = (Number(m.rpmMilli) || 0) / 1000;
    state.distanceMm = m.distanceMm === undefined ? null : Number(m.distanceMm);
    state.workUnits = m.cumulativeWorkUnits === undefined ? null : Number(m.cumulativeWorkUnits);

    const online = m.freshness === "online" && (Number(m.staleAfterSeconds) || 0) > 0;
    $("liveDot").className = "dot " + (online ? "on" : "off");
    $("liveState").textContent = online ? "live" : `stale (${m.freshness || "unknown"})`;

    // hero facts
    $("fRound").textContent = (state.cfg.roundDuration / 60).toFixed(0) + " min";
    $("fBlock").textContent = a.blockHeight ? fmt(a.blockHeight) : "\u2014";
    $("fRpm").textContent = state.rpm.toFixed(2) + " rpm";

    // gauges — every one of these is a live API field
    $("coreStatus").textContent = m.coreStatus || "\u2014";
    $("coreNote").textContent =
      m.provenance === "hardware" ? "hardware · real wheel" : m.provenance || "device heartbeat";
    $("rpm").textContent = state.rpm.toFixed(2);
    $("rpmNote").textContent = m.rpmMilli
      ? `${m.rpmMilli} milli-rpm`
      : "wheel is still";
    // unknown != zero: show an em dash if the field is absent from the response
    const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
    const shown = (v) => (num(v) === null ? "\u2014" : fmt(num(v)));

    $("speed").textContent = shown(m.speedMmPerSecond);
    $("distance").textContent = shown(m.distanceMm);
    $("workUnits").textContent = shown(m.cumulativeWorkUnits);
    $("distNote").textContent =
      num(m.distanceMm) > 0 ? "millimetres, since boot" : "no turns recorded yet";
    $("blockHeight").textContent = a.blockHeight ? fmt(a.blockHeight) : "\u2014";

    // the physical rig that produces the numbers above
    const mod = (status.modules && status.modules[0]) || {};
    $("hwType").textContent = mod.moduleType || "\u2014";
    $("hwDriver").textContent = mod.driverId || "\u2014";
    $("hwState").textContent = mod.state || "\u2014";
    $("hwProv").textContent = mod.provenance || m.provenance || "\u2014";
    $("hwObs").textContent = mod.observedAt
      ? new Date(mod.observedAt).toLocaleTimeString()
      : "\u2014";

    // block progress meter.
    // Verified shape: cumulativeBlockUnits = blockHeight * 1e9 + blockProgress,
    // i.e. blockProgress is the position inside the CURRENT block, whose capacity
    // is exactly 1e9 units. workPerThousandBlocks / 1000 = work per block.
    // NB: the API hands these back as STRINGS, so coerce before doing maths.
    const bp = BigInt(a.blockProgress || 0);
    const UNIT_PER_BLOCK = 1000000000n;
    const wpk = Number(a.workPerThousandBlocks) || 0;
    const perBlock = wpk / 1000; // work units per block

    const pct = Number((bp * 10000n) / UNIT_PER_BLOCK) / 100;
    const p = Math.max(0, Math.min(100, pct));
    $("meterFill").style.width = p.toFixed(1) + "%";
    $("meterPct").textContent = p.toFixed(1) + "%";
    const left = Math.max(0, perBlock * (1 - pct / 100));
    $("meterLeft").textContent = left.toFixed(3) + " work left";
    $("blockProg").textContent = p.toFixed(1) + "% \u00b7 " + fmt(a.blockHeight || 0);
    $("blockLink").textContent = "block " + (a.blockHeight || "\u2014");
    $("blockLink").href = a.transactionHash
      ? "https://sepolia.etherscan.io/tx/" + a.transactionHash
      : "#chain";

    $("wpk").textContent = wpk ? fmt(wpk) : "\u2014";
    $("settled").textContent = state.cfg.settledThroughRound || "\u2014";

    renderRpm();
    renderRounds(setl);
    renderLag(setl);
    renderMine();
    $("upd").textContent = new Date().toLocaleTimeString();
  } catch (e) {
    $("liveDot").className = "dot off";
    $("liveState").textContent = "api unreachable";
    $("hudMode").textContent = "lost the wheel";
    console.warn("live load failed", e);
  }
}

/* ---------------- settled rounds ---------------- */

/* The settlements feed only advances when the wheel actually produced work.
   When the wheel idles, rounds pass with nothing to anchor, so the newest
   settlement lags the live round counter. Show that gap honestly instead of
   letting it look like the page is broken. */
function renderLag(setl) {
  const recent = (setl.recentSettlements || []).slice();
  const live = currentRound();
  if (!recent.length || !live) return;
  recent.sort((a, b) => Number(b.settledThroughRound) - Number(a.settledThroughRound));
  const last = Number(recent[0].settledThroughRound);
  const gap = Math.max(0, live - last);

  $("lagLive").textContent = "#" + live;
  $("lagSettled").textContent = "#" + last;
  $("lagGap").textContent = gap === 0 ? "0 rounds" : `${gap} rounds`;

  const sr = setl.summary || {};
  const active = Number(sr.activeRoundCount) || 0;
  const el = $("lagState");
  if (gap === 0) {
    $("lagState").textContent = "in sync";
    el.className = "lag-state ok";
  } else if (state.core === "IDLE" || state.rpm === 0) {
    el.textContent = `wheel idle — nothing to anchor`;
    el.className = "lag-state idle";
  } else {
    el.textContent = `${active} active, settling in batches`;
    el.className = "lag-state";
  }
}

function renderRounds(setl) {
  const tb = document.querySelector("#rounds tbody");
  tb.innerHTML = "";
  const recent = (setl.recentSettlements || [])
    .slice()
    .sort((x, y) => Number(y.settledThroughRound) - Number(x.settledThroughRound))
    .slice(0, 14);

  if (!recent.length) {
    tb.innerHTML = `<tr><td colspan="5">No settlements returned right now.</td></tr>`;
    return;
  }
  for (const s of recent) {
    const round = Number(s.settledThroughRound);
    const work = Number(s.workAdded) || 0;
    const blocks = s.completedBlockCount ? Number(s.completedBlockCount) : null;
    // grade off blocks sealed, not work added — see classify()
    const outcome = blocks === null ? "jog" : classify(blocks);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>#${round}</td>` +
      `<td>${fmt(work)}</td>` +
      `<td>${blocks === null ? "\u2014" : blocks}</td>` +
      `<td><span class="tag ${outcome}">${GRADE_LABEL[outcome]}</span></td>` +
      `<td><a href="https://sepolia.etherscan.io/tx/${s.transactionHash}" target="_blank" rel="noopener">${short(s.transactionHash)}</a></td>`;
    tb.appendChild(tr);
  }

  // announce when a new block lands between polls
  const h = Number((setl.recentSettlements[0] || {}).blockHeight || 0);
  if (state.lastBlocks && h > state.lastBlocks) announceBlock();
  if (h) state.lastBlocks = h;
}

/* ---------------- wallet ---------------- */

async function connect() {
  if (!window.ethereum) {
    setMsg("No wallet found. Install MetaMask or any EIP-1193 wallet.", "bad");
    return;
  }
  try {
    const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
    state.addr = addr.toLowerCase();
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
          params: [
            {
              chainId: hex(CHAIN_ID),
              chainName: "Sepolia",
              nativeCurrency: { name: "SepoliaETH", symbol: "ETH", decimals: 18 },
              rpcUrls: [RPC],
              blockExplorerUrls: ["https://sepolia.etherscan.io"],
            },
          ],
        });
      } catch (e2) {
        console.warn("chain switch skipped", e2);
      }
    }
    refreshLock();
    renderMine();
  } catch (e) {
    setMsg(e && e.code === 4001 ? "Connection rejected." : "Could not connect.", "bad");
  }
}

function setMsg(t, cls) {
  const el = $("lockMsg");
  el.textContent = t;
  el.className = "msg " + (cls || "");
}
function refreshLock() {
  $("lockBtn").disabled = !(state.addr && state.choice);
}

function statement(round, choice) {
  return [
    "squeek-round — lock my round call",
    "",
    `Round: ${round}`,
    `Call: ${choice}`,
    `Wallet: ${state.addr}`,
    `Issued: ${new Date().toISOString()}`,
    "",
    "Signing is free and does not move funds.",
  ].join("\n");
}

async function lockCall() {
  if (!state.addr || !state.choice) return;
  const round = currentRound();
  const msg = statement(round, state.choice);
  setMsg("Waiting for wallet signature\u2026");
  try {
    const sig = await window.ethereum.request({
      method: "personal_sign",
      params: [msg, state.addr],
    });
    const calls = loadCalls();
    calls[`${state.addr}:${round}`] = {
      round,
      choice: state.choice,
      sig,
      at: Date.now(),
      addr: state.addr,
    };
    saveCalls(calls);
    setMsg(`Locked \u2014 round ${round} \u2192 ${state.choice}. Signature kept in your browser.`, "ok");
    renderMine();
  } catch (e) {
    setMsg(e && e.code === 4001 ? "Signature rejected." : "Signing failed.", "bad");
  }
}

function loadCalls() {
  try {
    return JSON.parse(localStorage.getItem(LS_CALLS) || "{}");
  } catch {
    return {};
  }
}
function saveCalls(c) {
  localStorage.setItem(LS_CALLS, JSON.stringify(c));
}

/* ---------------- score my calls ---------------- */

async function renderMine() {
  const calls = loadCalls();
  const mine = Object.values(calls).filter((c) => !state.addr || c.addr === state.addr);
  const tb = document.querySelector("#myTable tbody");
  tb.innerHTML = "";

  if (!mine.length) {
    tb.innerHTML = `<tr><td colspan="4">No calls yet. Connect a wallet and lock one in.</td></tr>`;
    $("myCalls").textContent = "0";
    $("myHits").textContent = "0";
    $("myAcc").textContent = "\u2014";
    $("myStreak").textContent = "\u2014";
    return;
  }

  let settled = {};
  try {
    const setl = await fetch(`${API}/settlements`).then((r) => r.json());
    for (const s of setl.recentSettlements || []) {
      // store BLOCKS SEALED — that is what classify() grades on
      settled[Number(s.settledThroughRound)] = Number(s.completedBlockCount) || 0;
    }
  } catch {}

  let hits = 0,
    scored = 0;

  const sorted = mine.slice().sort((a, b) => b.round - a.round);
  for (const c of sorted) {
    const known = Object.prototype.hasOwnProperty.call(settled, c.round);
    let outcome = null;
    let res = `<span class="tag bad">pending</span>`;
    if (known) {
      outcome = classify(settled[c.round]);
      scored++;
      if (outcome === c.choice) {
        res = `<span class="tag ok">hit</span>`;
        hits++;
      } else {
        res = `<span class="tag bad">miss</span>`;
      }
    }
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>#${c.round}</td>` +
      `<td><span class="tag ${c.choice}">${GRADE_LABEL[c.choice] || c.choice}</span></td>` +
      `<td>${outcome ? `<span class="tag ${outcome}">${GRADE_LABEL[outcome]}</span>` : "\u2014"}</td>` +
      `<td>${res}</td>`;
    tb.appendChild(tr);
  }

  // current hit streak (most recent settled calls, newest first)
  let streak = 0;
  for (const c of sorted) {
    if (!Object.prototype.hasOwnProperty.call(settled, c.round)) continue;
    if (classify(settled[c.round]) === c.choice) streak++;
    else break;
  }

  $("myCalls").textContent = mine.length;
  $("myHits").textContent = hits;
  $("myAcc").textContent = scored ? Math.round((hits / scored) * 100) + "%" : "\u2014";
  $("myStreak").textContent = streak > 0 ? streak + "\u00d7" : "\u2014";
}

/* ---------------- live readout ---------------- */

function renderRpm() {
  const el = $("turnCount");
  if (el) el.textContent = (state.rpm || 0).toFixed(2) + " rpm";
}

/* ---------------- wire up ---------------- */

buildSpokes();
requestAnimationFrame(tick); // start the wheel drive loop

$("connectBtn").addEventListener("click", connect);
$("lockBtn").addEventListener("click", lockCall);

document.querySelectorAll(".choice").forEach((b) => {
  b.addEventListener("click", () => {
    state.choice = b.dataset.c;
    document.querySelectorAll(".choice").forEach((x) => {
      const on = x === b;
      x.classList.toggle("sel", on);
      x.setAttribute("aria-checked", on ? "true" : "false");
    });
    refreshLock();
    setMsg("");
  });
});

(function boot() {
  renderRpm();

  loadLive();
  setInterval(loadLive, 15000);

  setInterval(() => {
    const r = currentRound();
    $("curRound").textContent = r;
    const secs = roundEndsIn();
    if (secs === null) {
      $("roundTimer").textContent = "\u2014";
    } else {
      const m = Math.floor(secs / 60);
      const s = String(secs % 60).padStart(2, "0");
      $("roundTimer").textContent = `closes in ${m}m ${s}s`;
    }
  }, 1000);

  if (window.ethereum) {
    window.ethereum
      .request({ method: "eth_accounts" })
      .then((a) => {
        if (a && a.length) {
          state.addr = a[0].toLowerCase();
          $("walletLabel").textContent = short(a[0]);
          $("connectBtn").textContent = "Connected";
          refreshLock();
          renderMine();
        }
      })
      .catch(() => {});
    if (window.ethereum.on) {
      window.ethereum.on("accountsChanged", (a) => {
        state.addr = a && a.length ? a[0].toLowerCase() : null;
        $("walletLabel").textContent = state.addr ? short(a[0]) : "";
        $("connectBtn").textContent = state.addr ? "Connected" : "Connect wallet";
        refreshLock();
        renderMine();
      });
    }
  }
})();
