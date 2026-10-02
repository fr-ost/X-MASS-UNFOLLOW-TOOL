// X Mass Unfollow - shared UI helpers for the popup and the dashboard.
(function () {
  "use strict";

  const U = {};

  U.$ = (sel, root) => (root || document).querySelector(sel);
  U.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  U.cmd = (cmd, extra) =>
    chrome.runtime.sendMessage(Object.assign({ cmd }, extra || {}))
      .then((r) => r || { ok: false, error: "No answer from the extension." })
      .catch((e) => ({ ok: false, error: String(e && e.message || e) }));

  U.get = async (key, fallback) => {
    try { const r = await chrome.storage.local.get(key); return r[key] === undefined ? fallback : r[key]; }
    catch (_) { return fallback; }
  };
  U.set = (obj) => chrome.storage.local.set(obj).catch(() => {});

  U.watch = (keys, fn) => {
    const set = new Set(keys);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (Object.keys(changes).some((k) => set.has(k))) fn(changes);
    });
  };

  U.esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  U.fmt = (n) => (n == null || Number.isNaN(Number(n))) ? "-" : Number(n).toLocaleString();
  U.compact = (n) => {
    if (n == null) return "-";
    n = Number(n);
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (n >= 1e4) return Math.round(n / 1e3) + "K";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  };

  U.ago = (ts) => {
    if (!ts) return "never";
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 45) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    if (h < 24) return h + " h ago";
    const d = Math.round(h / 24);
    return d + (d === 1 ? " day ago" : " days ago");
  };

  U.dur = (sec) => {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + "s";
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + "m" + (s ? " " + String(s).padStart(2, "0") + "s" : "");
    const h = Math.floor(m / 60);
    return h + "h " + String(m % 60).padStart(2, "0") + "m";
  };

  U.clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  U.date = (ts) => new Date(ts).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });

  // Animate a number from its current value to `to` (fluent counters).
  U.countTo = (el, to, fmt) => {
    if (!el) return;
    const f = fmt || U.fmt;
    const target = Number(to);
    if (!Number.isFinite(target)) { el.textContent = f(to); return; }
    const from = Number(el.dataset.n || 0);
    el.dataset.n = String(target);
    if (from === target || matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = f(target); return; }
    const t0 = performance.now(), dur = Math.min(900, 250 + Math.abs(target - from) * 4);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = f(Math.round(from + (target - from) * e));
      if (k < 1 && el.dataset.n === String(target)) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  U.copy = async (text) => {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (__) {}
      ta.remove();
      return ok;
    }
  };

  U.links = {
    bug: "https://t.me/igfrostt",
    support: "https://t.me/igfrostt",
    site: "https://www.shahriarahmed.net",
    store: "https://chromewebstore.google.com/detail/x-twitter-mass-unfollow-t/igpjmagghnibmjkkdcgpjgpkfkpiglnl"
  };

  // Theme toggle buttons: any [data-theme-toggle] flips light/dark.
  U.themeButtons = (root) => U.$$("[data-theme-toggle]", root).forEach((b) => {
    if (b.dataset.themeWired) return;
    b.dataset.themeWired = "1";
    b.classList.add("theme-btn");
    b.insertAdjacentHTML("afterbegin", U.icon("sun", "ic-sun") + U.icon("moon", "ic-moon"));
    const label = () => b.setAttribute("aria-label", window.X7Theme && X7Theme.current() === "dark" ? "Switch to light mode" : "Switch to dark mode");
    label();
    b.title = "Light / dark mode";
    b.addEventListener("click", () => { if (window.X7Theme) X7Theme.toggle(); label(); });
    window.addEventListener("x7-theme", label);
  });

  U.bigAvatar = (url) => String(url || "").replace(/_normal(\.\w+)$/, "_bigger$1");

  // Avatar element with an initial-letter fallback (no inline handlers: CSP).
  U.avatar = (url, name, size) => {
    const wrap = document.createElement("span");
    wrap.className = "avatar";
    if (size) { wrap.style.width = wrap.style.height = size + "px"; wrap.style.fontSize = Math.round(size * 0.38) + "px"; }
    const letter = (String(name || "?").trim()[0] || "?").toUpperCase();
    if (url) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
      img.addEventListener("error", () => { img.remove(); wrap.textContent = letter; }, { once: true });
      img.src = U.bigAvatar(url);
      wrap.appendChild(img);
    } else {
      wrap.textContent = letter;
    }
    return wrap;
  };

  let toastHost = null;
  U.toast = (msg, kind, ms) => {
    if (!toastHost) {
      toastHost = document.createElement("div");
      toastHost.className = "toast-host";
      document.body.appendChild(toastHost);
    }
    const t = document.createElement("div");
    t.className = "toast" + (kind ? " " + kind : "");
    t.textContent = msg;
    toastHost.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 260); }, ms || 3200);
  };

  U.csvCell = (v) => {
    const s = String(v == null ? "" : v);
    return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1") + '"' : s;
  };
  U.csv = (header, rows) => [header.map(U.csvCell).join(","), ...rows.map((r) => r.map(U.csvCell).join(","))].join("\r\n");

  U.download = (filename, text, mime) => {
    const blob = new Blob(["﻿" + text], { type: mime || "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  // Tiny CSV reader: quoted fields, embedded commas/newlines, BOM.
  U.parseCsv = (text) => {
    const rows = []; let row = [], f = "", q = false;
    const s = String(text || "").replace(/^﻿/, "");
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
        continue;
      }
      if (c === '"') { q = true; continue; }
      if (c === ",") { row.push(f); f = ""; continue; }
      if (c === "\n" || c === "\r") {
        if (c === "\r" && s[i + 1] === "\n") i++;
        row.push(f); f = "";
        if (row.some((x) => x.trim())) rows.push(row);
        row = [];
        continue;
      }
      f += c;
    }
    row.push(f);
    if (row.some((x) => x.trim())) rows.push(row);
    return rows;
  };

  // Pull @handles out of a CSV or a plain list, whatever its shape.
  U.handlesFrom = (text) => {
    const rows = U.parseCsv(text);
    const out = [], seen = new Set();
    let skipped = 0;
    if (!rows.length) return { handles: out, skipped };
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const named = ["handle", "username", "screen_name", "user", "account", "twitter", "x"];
    const col = head.findIndex((h) => named.includes(h));
    const urlCol = head.findIndex((h) => /url|link|profile/.test(h));
    const body = (col >= 0 || urlCol >= 0) ? rows.slice(1) : rows;
    for (const r of body) {
      let h = null;
      if (col >= 0) h = X7.cleanHandle(r[col]);
      if (!h && urlCol >= 0) h = X7.cleanHandle(r[urlCol]);
      if (!h) {
        for (const cell of r) {
          const c = String(cell).trim();
          // A bare word only counts when the whole cell is one; inside longer
          // text, only @handles and profile links do.
          h = /\s/.test(c) ? null : X7.cleanHandle(c);
          if (!h) {
            for (const part of c.split(/[\s;]+/)) {
              if (/^@|(?:x|twitter)\.com\//i.test(part)) { h = X7.cleanHandle(part); if (h) break; }
            }
          }
          if (h) break;
        }
      }
      if (!h) { skipped++; continue; }
      const k = h.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k); out.push(h);
    }
    return { handles: out, skipped };
  };

  // ---- icons (24px stroke) ----
  const P = {
    home: '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9v11h13V9"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.5 14.8c1.6.8 2.7 2.6 3 5.2"/>',
    userX: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.8-3.5 3.4-5.5 6.5-5.5 1.4 0 2.7.4 3.8 1.1"/><path d="m16.5 14.5 4 4m0-4-4 4"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
    history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 4v4.5H8"/><path d="M12 8v4l3 2"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.2-2.4 3.7"/><path d="M12 17h.01"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M8.5 5.5v13M15.5 5.5v13" stroke-width="2.4"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.2" fill="currentColor" stroke="none"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.6L4 8"/><path d="M4 3.5V8h4.5"/><path d="M4 13a8 8 0 0 0 14.6 4.6L20 16"/><path d="M20 20.5V16h-4.5"/>',
    download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
    upload: '<path d="M12 15V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
    scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M7 12h10"/>',
    sparkles: '<path d="M12 4.5 13.6 9 18 10.5l-4.4 1.6L12 16.5l-1.6-4.4L6 10.5 10.4 9z"/><path d="M19 3v4M17 5h4"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    send: '<path d="M21 4 3 11l6.5 2.5L12 20l3.2-4.2L19 19z"/><path d="m9.5 13.5 5-4"/>',
    alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4M12 17h.01"/>',
    heart: '<path d="M12 20s-7.5-4.4-7.5-10A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7.5 3c0 5.6-7.5 10-7.5 10z"/>',
    file: '<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4.5"/>',
    star: '<path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 9.7l5.4-.8z"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.5 5.5 7 7M17 17l1.5 1.5M18.5 5.5 17 7M7 17l-1.5 1.5"/>',
    moon: '<path d="M20 14.2A8.3 8.3 0 1 1 9.8 4a6.6 6.6 0 0 0 10.2 10.2z"/>',
    monitor: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2"/><path d="M9 20h6M12 16v4"/>',
    bug: '<rect x="7.5" y="8" width="9" height="12" rx="4.5"/><path d="M9.5 8V6.5a2.5 2.5 0 0 1 5 0V8M12 12v8M3.5 13h4M16.5 13h4M4.5 8.5l3 2M19.5 8.5l-3 2M4.5 18.5l3-2M19.5 18.5l-3-2"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.2a1.7 1.7 0 0 0-1.7-1.7H6.2a1.7 1.7 0 0 0-1.7 1.7v7.6a1.7 1.7 0 0 0 1.7 1.7h2.3"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5z"/>',
    coffee: '<path d="M5 9h11v5.5A4.5 4.5 0 0 1 11.5 19h-2A4.5 4.5 0 0 1 5 14.5z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3.5c-.6.8-.6 1.7 0 2.5M11 3.5c-.6.8-.6 1.7 0 2.5"/>',
    share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4.1M8.2 13.2l7.6 4.1"/>',
    gift: '<rect x="4" y="9" width="16" height="11" rx="1.8"/><path d="M3 9h18M12 9v11M12 9c-1.5-3.5-5.5-4-5.5-1.5S10 9 12 9zM12 9c1.5-3.5 5.5-4 5.5-1.5S14 9 12 9z"/>',
    rocket: '<path d="M12 15c-1-1-2.5-3.4-2-6.5C10.6 5 13 3 16.5 3c.3 3.5-1.6 6-5 7.5"/><path d="M9.5 12.5 7 15l2 2 2.5-2.5M6.5 17.5 4 20M9 14l-4-1 3-3"/><path d="M14 11l1 4-3 3"/>'
  };
  U.icon = (name, cls) =>
    `<svg class="ic ${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`;

  // Fill every [data-icon] placeholder.
  U.icons = (root) => U.$$("[data-icon]", root).forEach((el) => {
    if (el.dataset.iconDone) return;
    el.insertAdjacentHTML("afterbegin", U.icon(el.dataset.icon));
    el.dataset.iconDone = "1";
  });

  window.U = U;
})();
