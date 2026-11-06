/**
 * Wallet menu — the dropdown behind the 0x… chip in the header.
 *
 * Shared by index.html and profile.html. Both pages carry the same markup, so
 * they both get the same behaviour from one file rather than two copies that
 * drift.
 *
 * What "Disconnect" means here: a browser wallet has no API to revoke a site's
 * permission. MetaMask deliberately does not expose one. So this forgets the
 * connection *on this site*: it stops the page reading the accounts, clears the
 * locally cached calls, and goes back to the connect state. That is the honest
 * scope, and the menu says so instead of implying the wallet itself is
 * disconnected.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const KEY_FORGOT = "squeekround_forgot_v1";
  const KEY_CALLS = "squeekround_calls_v1";

  const menu = {
    open: false,
    addr: null,
    onDisconnect: null,
  };

  function shorten(a) {
    return a ? a.slice(0, 6) + "\u2026" + a.slice(-4) : "";
  }

  /* A wallet the user explicitly disconnected must not be silently re-adopted
     on the next page load, or disconnecting would appear to do nothing. Recording
     the address (not a boolean) means connecting a DIFFERENT account still works
     straight away. */
  function isForgotten(addr) {
    try {
      return (localStorage.getItem(KEY_FORGOT) || "").toLowerCase() === (addr || "").toLowerCase();
    } catch {
      return false;
    }
  }

  function forget(addr) {
    try {
      localStorage.setItem(KEY_FORGOT, (addr || "").toLowerCase());
    } catch {}
  }

  function unforget() {
    try {
      localStorage.removeItem(KEY_FORGOT);
    } catch {}
  }

  function note(text) {
    const n = $("wmNote");
    if (!n) return;
    n.textContent = text;
    n.hidden = !text;
  }

  function setOpen(v) {
    menu.open = v;
    const m = $("walletMenu");
    const b = $("addrBtn");
    if (m) m.hidden = !v;
    if (b) b.setAttribute("aria-expanded", v ? "true" : "false");
    if (!v) note("");
  }

  /* Show the chip for an address, or hide it. Returns true when visible. */
  function render(addr) {
    menu.addr = addr ? addr.toLowerCase() : null;
    const btn = $("addrBtn");
    const txt = $("addrText");
    const full = $("wmAddr");
    if (!btn) return false;
    if (!menu.addr) {
      btn.hidden = true;
      setOpen(false);
      return false;
    }
    if (txt) txt.textContent = shorten(menu.addr);
    if (full) full.textContent = menu.addr;
    btn.hidden = false;
    return true;
  }

  async function copyAddress() {
    const a = menu.addr;
    if (!a) return;
    let done = false;
    try {
      await navigator.clipboard.writeText(a);
      done = true;
    } catch {
      /* clipboard API needs a secure context and can be blocked; fall back to a
         hidden textarea + execCommand, which still works on plain http. */
      try {
        const ta = document.createElement("textarea");
        ta.value = a;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        done = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        done = false;
      }
    }
    note(done ? "Address copied" : "Copy blocked \u2014 select it manually");
  }

  function disconnect() {
    const a = menu.addr;
    if (a) forget(a);
    try {
      localStorage.removeItem(KEY_CALLS);
    } catch {}
    setOpen(false);
    render(null);
    if (typeof menu.onDisconnect === "function") menu.onDisconnect();
  }

  function wire() {
    const btn = $("addrBtn");
    if (!btn) return;

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpen(!menu.open);
    });

    const copy = $("wmCopy");
    if (copy) {
      copy.addEventListener("click", (e) => {
        e.stopPropagation();
        copyAddress();
      });
    }
    const dis = $("wmDisconnect");
    if (dis) {
      dis.addEventListener("click", (e) => {
        e.stopPropagation();
        disconnect();
      });
    }

    /* Click-away and Escape both close it. Listening on document with capture
       means a click anywhere else wins, including on other buttons. */
    document.addEventListener("click", (e) => {
      if (!menu.open) return;
      const wrap = btn.parentElement;
      if (wrap && !wrap.contains(e.target)) setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && menu.open) setOpen(false);
    });

    const m = $("walletMenu");
    if (m) m.addEventListener("click", (e) => e.stopPropagation());
  }

  /* Export the `menu` object ITSELF, not a fresh literal. The page hooks
     onDisconnect onto window.WalletMenu, and disconnect() reads menu.onDisconnect.
     A literal here would be a different object, so the hook would silently land
     nowhere. */
  menu.wire = wire;
  menu.render = render;
  menu.isForgotten = isForgotten;
  menu.unforget = unforget;
  menu.forget = forget;
  menu.disconnect = disconnect;
  menu.shorten = shorten;
  menu.setOpen = setOpen;
  window.WalletMenu = menu;
  wire();
})();
