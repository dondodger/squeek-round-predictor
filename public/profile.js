/**
 * Profile page: reads the scoreboard for the connected wallet.
 *
 * Deliberately wallet-first. There is no email, no sign-up, no cookie holding a
 * score — the address IS the account. That is why the page can be honest about
 * what it shows: it asked the server for /api/points/profile/<addr> and printed
 * the answer, nothing more.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const state = { addr: null, prof: null };

  function shorten(a) {
    return a ? a.slice(0, 6) + "\u2026" + a.slice(-4) : "";
  }

  function setNet(ok, txt) {
    const pill = $("netPill");
    if (!pill) return;
    pill.classList.toggle("pill-warn", !ok);
    $("netTxt").textContent = txt;
  }

  async function connect() {
    if (!window.ethereum) {
      setNet(false, "No wallet found");
      return;
    }
    try {
      const accts = await window.ethereum.request({ method: "eth_requestAccounts" });
      state.addr = accts && accts[0] ? accts[0] : null;
      if (!state.addr) return;
      $("walletLabel").textContent = shorten(state.addr);
      $("connectBtn").hidden = true;
      $("profileBtn").hidden = false;
      const chainId = await window.ethereum.request({ method: "eth_chainId" });
      setNet(chainId === "0xaa36a7", chainId === "0xaa36a7" ? "Sepolia" : "Chain " + chainId);
      await load();
    } catch (e) {
      setNet(false, "Connect cancelled");
    }
  }

  async function load() {
    if (!state.addr) return;
    $("needWallet").hidden = true;
    $("profWrap").hidden = false;
    $("profAddr").textContent = state.addr;

    let prof = null;
    try {
      const r = await fetch("/api/points/profile/" + state.addr, { cache: "no-store" });
      prof = await r.json();
      if (prof.error) prof = null;
    } catch {
      prof = null;
    }

    if (!prof) {
      $("profRank").textContent = "Could not reach the scoreboard. Try reloading.";
      return;
    }
    state.prof = prof;
    render(prof);
  }

  function render(p) {
    $("profPoints").textContent = (p.points || 0).toLocaleString();
    $("profCalls").textContent = p.calls || 0;
    $("profScored").textContent = p.scored || 0;
    $("profHits").textContent = p.hits || 0;
    $("profAcc").textContent = p.accuracy === null || p.accuracy === undefined ? "\u2014" : p.accuracy + "%";
    $("profStreak").textContent = p.streak ? p.streak : "\u2014";
    $("profBest").textContent = p.bestStreak ? p.bestStreak : "\u2014";

    const by = p.byCall || { nap: 0, jog: 0, zoomies: 0 };
    $("cbNap").textContent = by.nap || 0;
    $("cbJog").textContent = by.jog || 0;
    $("cbZoom").textContent = by.zoomies || 0;

    $("profSeen").textContent = p.lastSeen
      ? "last call " + new Date(p.lastSeen).toLocaleString()
      : "no calls yet";

    if (!p.calls) {
      $("profRank").textContent = "No calls yet — lock one on the predictor.";
    } else if (!p.scored) {
      $("profRank").textContent = "All calls are pending; the chain grades a round when it settles.";
    } else {
      $("profRank").textContent = p.hits + " of " + p.scored + " graded rounds called correctly";
    }

    const tb = document.querySelector("#profTable tbody");
    tb.innerHTML = "";
    const rows = (p.recent || []).slice(0, 20);
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="4" class="empty">Nothing locked yet.</td></tr>';
      return;
    }
    for (const r of rows) {
      const tr = document.createElement("tr");
      const wheel = r.outcome
        ? r.outcome === "expired"
          ? "not graded"
          : r.outcome
        : "pending";
      const pts = r.award === undefined || r.award === null ? "\u2014" : r.award ? "+" + r.award : "0";
      const cls = r.outcome && r.outcome === r.choice ? "good" : r.outcome ? "bad" : "";
      tr.innerHTML =
        "<td>" + r.round + "</td>" +
        '<td class="cap">' + (r.choice || "") + "</td>" +
        '<td class="cap">' + wheel + "</td>" +
        '<td class="' + cls + '">' + pts + "</td>";
      tb.appendChild(tr);
    }
  }

  $("connectBtn").addEventListener("click", connect);
  const c2 = $("connectBtn2");
  if (c2) c2.addEventListener("click", connect);

  if (window.ethereum) {
    window.ethereum.on && window.ethereum.on("accountsChanged", (a) => {
      state.addr = a && a[0] ? a[0] : null;
      if (state.addr) {
        $("walletLabel").textContent = shorten(state.addr);
        load();
      } else {
        $("connectBtn").hidden = false;
        $("profileBtn").hidden = true;
        $("walletLabel").textContent = "";
        $("profWrap").hidden = true;
        $("needWallet").hidden = false;
      }
    });
  }

  /* If the page was opened with ?addr= the wallet is only needed to CONFIRM it
     is yours; we still require a connect rather than trusting the query string,
     because otherwise anyone could read a public scoreboard entry and there is
     no reason to expose that here. */
  const qa = new URLSearchParams(location.search).get("addr");
  if (qa) $("profSeen").textContent = "Connect " + shorten(qa) + " to confirm";
})();
