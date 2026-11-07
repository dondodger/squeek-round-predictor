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

  /* "Connect" here only ever READS an address — eth_requestAccounts on an
     already-authorised site returns instantly with no popup. So we call it
     unattended on load, exactly like the main page does. Landing on /profile
     should show the scoreboard, never a second connect prompt. */
  async function connect() {
    if (!window.ethereum) {
      setNet(false, "No wallet found");
      return;
    }
    try {
      const accts = await window.ethereum.request({ method: "eth_requestAccounts" });
      state.addr = accts && accts[0] ? accts[0].toLowerCase() : null;
      if (!state.addr) return;
      $("connectBtn").hidden = true;
      $("profileBtn").hidden = false;
      const chainId = await window.ethereum.request({ method: "eth_chainId" });
      setNet(chainId === "0xaa36a7", chainId === "0xaa36a7" ? "Sepolia" : "Chain " + chainId);
      await load();
    } catch (e) {
      setNet(false, "Connect cancelled");
    }
  }

  /* Silent path: eth_accounts lists accounts already granted to this origin and
     never prompts. If there is one, we are already connected — go straight to
     the score. A wallet the user explicitly disconnected is skipped. */
  async function autoConnect() {
    if (!window.ethereum || !window.ethereum.request) return false;
    try {
      const accts = await window.ethereum.request({ method: "eth_accounts" });
      if (!accts || !accts.length) return false;
      if (window.WalletMenu && window.WalletMenu.isForgotten(accts[0])) return false;
      state.addr = accts[0].toLowerCase();
      $("connectBtn").hidden = true;
      $("profileBtn").hidden = false;
      if (window.WalletMenu) window.WalletMenu.render(state.addr);
      try {
        const chainId = await window.ethereum.request({ method: "eth_chainId" });
        setNet(chainId === "0xaa36a7", chainId === "0xaa36a7" ? "Sepolia" : "Chain " + chainId);
      } catch {}
      await load();
      return true;
    } catch {
      return false;
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

    /* An ungraded call is only "pending" if the wheel is still turning. When the
       wheel has stopped, nothing is coming and we say so — see lib/wheel.js. */
    const resting = p.wheel && p.wheel.stuck;
    const restLabel = "wheel resting";
    const restTitle = "The wheel is not turning, so no blocks are being produced.";

    if (!p.calls) {
      $("profRank").textContent = "No calls yet — lock one on the predictor.";
    } else if (resting && !p.scored) {
      $("profRank").textContent =
        "The wheel is resting — no blocks are being produced, so nothing can be graded yet. Your calls are not queued or lost.";
    } else if (!p.scored) {
      $("profRank").textContent = "All calls are pending; the chain grades a round when it settles.";
    } else if (resting) {
      $("profRank").textContent =
        p.hits + " of " + p.scored + " graded rounds called correctly · the wheel is resting, so newer calls await the next run";
    } else {
      $("profRank").textContent = p.hits + " of " + p.scored + " graded rounds called correctly";
    }

    const tb = document.querySelector("#profTable tbody");
    tb.innerHTML = "";
    const rows = (p.recent || []).slice(0, 20);
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="5" class="empty">Nothing locked yet.</td></tr>';
      return;
    }
    for (const r of rows) {
      const tr = document.createElement("tr");
      /* The second column is what the WHEEL DID. The third is what the player
         called. Blank columns 2-3 previously showed the outcome word alone, so
         "zoomies" next to a "jog" call read as if the player had called
         zoomies and been paid nothing. Name the column's subject instead. */
      const did = r.outcome
        ? r.outcome === "expired"
          ? "not graded"
          : r.outcome
        : resting
          ? restLabel
          : "pending";
      const pts = r.award === undefined || r.award === null ? "\u2014" : r.award ? "+" + r.award : "0";
      const hit = r.outcome && r.outcome === r.choice;
      const cls = r.outcome ? (hit ? "good" : "bad") : "";
      /* A streak that is still alive gets its own marker, so a run is visible at
         a glance instead of having to be counted. */
      const fire = r.streak >= 3 && hit ? '<span class="fire">\ud83d\udd25' + r.streak + "</span>" : "";
      /* A resting call gets a hover hint so the label is explained, not just
         asserted. */
      const wheelCell =
        !r.outcome && resting
          ? '<span class="tag wait" title="' + restTitle + '">' + restLabel + "</span>"
          : did;
      /* Say plainly which of the two the player got wrong, and never leave a
         blank-looking zero to be misread as a hit that paid nothing. */
      const verdictCell = r.outcome
        ? r.outcome === "expired"
          ? '<span class="vmiss">window closed</span>'
          : hit
            ? '<span class="vhit">hit</span>' + fire
            : '<span class="vmiss">missed</span>' +
              '<span class="vwhy">you called ' + (r.choice || "?") + ", wheel " + did + "</span>"
        : wheelCell;
      tr.innerHTML =
        "<td>" + r.round + "</td>" +
        '<td class="cap">' + (r.choice || "") + "</td>" +
        '<td class="cap">' + (r.outcome && r.outcome !== "expired" ? did : wheelCell) + "</td>" +
        '<td class="cap">' + verdictCell + "</td>" +
        '<td class="' + cls + '">' + pts + "</td>";
      if (r.outcome && r.outcome !== "expired") {
        tr.classList.add("row-tap");
        tr.tabIndex = 0;
        tr.setAttribute("role", "button");
        tr.title = "What happened in round " + r.round;
        const open = () => showAutopsy(r);
        tr.addEventListener("click", open);
        tr.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
        });
      }
      tb.appendChild(tr);
    }
  }

  /* ------------------------------ autopsy -------------------------------- */

  let autopsyRec = null;

  function showAutopsy(r) {
    autopsyRec = r;
    const band = { nap: "Nap", jog: "Jog", zoomies: "Zoomies" }[r.outcome] || (r.outcome || "");
    const hit = r.outcome === r.choice;
    const hasBlocks = r.blocks !== null && r.blocks !== undefined;
    $("autopsyKicker").textContent = "Round " + r.round + " \u2014 " + (hit ? "you called it" : "missed");
    /* Only claim a block count when there is one. Rounds graded before we began
       storing the reading simply show the band — "reading unavailable" in a
       headline is an error message, not a feature. */
    $("autopsyTitle").textContent = hasBlocks ? band + " \u2014 " + r.blocks + " blocks" : band;
    $("autopsyTitle").className = "autopsy-title " + (hit ? "good" : "bad");
    $("autopsyBody").textContent = r.verdict || "";
    $("autopsyMeta").textContent =
      (r.award ? "+" + r.award + " points" : r.outcome ? "no points" : "") +
      (r.streak >= 2 && hit ? " \u00b7 " + r.streak + " in a row" : "");
    const share = $("autopsyShare");
    share.disabled = false;
    share.textContent = "Share on X";
    $("autopsy").hidden = false;
    $("autopsyClose").focus();
  }

  function closeAutopsy() {
    $("autopsy").hidden = true;
    autopsyRec = null;
  }

  /* The share button hands off to X's own composer. It never posts on the
     player's behalf — nothing is sent until they press Post over there. */
  function shareAutopsy() {
    if (!autopsyRec) return;
    const text = autopsyRec.share || "";
    const url = "https://squeekround.my.id/profile";
    const intent =
      "https://twitter.com/intent/tweet?text=" +
      encodeURIComponent(text) +
      "&url=" +
      encodeURIComponent(url);
    window.open(intent, "_blank", "noopener,noreferrer");
  }

  $("autopsyClose").addEventListener("click", closeAutopsy);
  $("autopsyShare").addEventListener("click", shareAutopsy);
  $("autopsy").addEventListener("click", (e) => {
    if (e.target.id === "autopsy") closeAutopsy();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("autopsy").hidden) closeAutopsy();
  });

  /* Disconnect forgets the wallet for this site: drop back to the connect state
     rather than leaving a scoreboard on screen that nobody is signed in for. */
  if (window.WalletMenu) {
    window.WalletMenu.onDisconnect = () => {
      state.addr = null;
      state.prof = null;
      $("connectBtn").hidden = false;
      $("profileBtn").hidden = true;
      $("profWrap").hidden = true;
      $("needWallet").hidden = false;
      const tb = document.querySelector("#profTable tbody");
      if (tb) tb.innerHTML = "";
    };
  }

  $("connectBtn").addEventListener("click", connect);
  const c2 = $("connectBtn2");
  if (c2) c2.addEventListener("click", connect);

  if (window.ethereum) {
    window.ethereum.on && window.ethereum.on("accountsChanged", (a) => {
      state.addr = a && a[0] ? a[0].toLowerCase() : null;
      if (state.addr) {
        if (window.WalletMenu) window.WalletMenu.unforget();
        $("connectBtn").hidden = true;
        $("profileBtn").hidden = false;
        if (window.WalletMenu) window.WalletMenu.render(state.addr);
        load();
      } else {
        $("connectBtn").hidden = false;
        $("profileBtn").hidden = true;
        if (window.WalletMenu) window.WalletMenu.render(null);
        $("profWrap").hidden = true;
        $("needWallet").hidden = false;
      }
    });
  }

  /* Land on the scoreboard, not on a connect prompt. The main page hands us an
     already-authorised wallet, so read it silently and paint immediately. If
     there is genuinely no wallet, autoConnect() leaves the prompt in place and
     the click handler above covers it. */
  autoConnect();

  /* One more attempt on pageshow: Firefox restores bfcache entries with the
     script already run, in which case the first call happened on a DOM state
     that no longer exists. */
  window.addEventListener("pageshow", (e) => {
    if (e.persisted && !state.addr) autoConnect();
  });

  /* If the page was opened with ?addr= the wallet is only needed to CONFIRM it
     is yours; we still require a connect rather than trusting the query string,
     because otherwise anyone could read a public scoreboard entry and there is
     no reason to expose that here. */
  const qa = new URLSearchParams(location.search).get("addr");
  if (qa) $("profSeen").textContent = "Connect " + shorten(qa) + " to confirm";
})();
