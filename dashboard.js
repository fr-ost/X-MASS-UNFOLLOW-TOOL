// X Mass Unfollow - dashboard.js
(function () {
  "use strict";

  const { $, $$ } = U;
  const K = X7.K;
  const CHUNK = 60;

  const D = {
    S: null,                 // worker state (account, scan, job, settings, today...)
    users: [],               // scan results
    byId: new Map(),
    wl: new Set(),           // lowercase handles
    done: new Set(),         // unfollowed ids
    history: [],
    sel: new Set(),
    seg: "non",
    chips: new Set(),
    sort: "list",
    q: "",
    list: [],                // current filtered list
    shown: 0,
    hiList: [],
    hiShown: 0,
    page: "overview"
  };

  // ======================================================================
  // helpers
  // ======================================================================
  const settings = () => (D.S && D.S.settings) || X7.DEFAULT_SETTINGS;
  const keepOf = (u) => X7.keepReason(u, settings(), D.wl);
  const monthYear = (ts) => ts ? new Date(ts).toLocaleDateString([], { month: "short", year: "numeric" }) : "-";

  function avatarHtml(url, name, size) {
    const letter = U.esc((String(name || "?").trim()[0] || "?").toUpperCase());
    const st = size ? ` style="width:${size}px;height:${size}px"` : "";
    if (!url) return `<span class="avatar"${st}>${letter}</span>`;
    return `<span class="avatar"${st} data-letter="${letter}"><img class="av" alt="" loading="lazy" referrerpolicy="no-referrer" src="${U.esc(U.bigAvatar(url))}" style="width:100%;height:100%;object-fit:cover;display:block"></span>`;
  }
  // Broken avatar -> initial letter (one capturing listener; no inline handlers).
  document.addEventListener("error", (e) => {
    const t = e.target;
    if (t && t.tagName === "IMG" && t.classList.contains("av")) {
      const wrap = t.parentElement;
      t.remove();
      if (wrap) wrap.textContent = wrap.dataset.letter || "?";
    }
  }, true);

  function swapAvatar(sel, url, name, size) {
    const old = $(sel);
    if (!old) return;
    const el = U.avatar(url, name, size);
    el.id = old.id;
    old.replaceWith(el);
  }

  // ======================================================================
  // confirm modal
  // ======================================================================
  function confirmBox(o) {
    return new Promise((resolve) => {
      $("#cfTitle").textContent = o.title;
      $("#cfBody").textContent = o.body || "";
      const icon = $("#cfIcon");
      icon.className = "modal-icon" + (o.info ? " is-info" : "");
      icon.innerHTML = U.icon(o.icon || "userX");
      const facts = $("#cfFacts");
      facts.innerHTML = "";
      for (const [k, v] of o.facts || []) {
        const d = document.createElement("div");
        d.innerHTML = `<span>${U.esc(k)}</span><b>${U.esc(v)}</b>`;
        facts.appendChild(d);
      }
      const ok = $("#cfOk");
      ok.className = "btn " + (o.danger ? "btn-danger-soft" : "btn-primary");
      ok.querySelector("span").textContent = o.ok || "Confirm";
      const box = $("#confirm");
      box.hidden = false;
      setTimeout(() => ok.focus(), 30);
      const done = (v) => {
        box.hidden = true;
        ok.removeEventListener("click", yes);
        $("#cfCancel").removeEventListener("click", no);
        box.removeEventListener("click", outside);
        document.removeEventListener("keydown", key);
        resolve(v);
      };
      const yes = () => done(true);
      const no = () => done(false);
      const outside = (e) => { if (e.target === box) done(false); };
      const key = (e) => { if (e.key === "Escape") done(false); };
      ok.addEventListener("click", yes);
      $("#cfCancel").addEventListener("click", no);
      box.addEventListener("click", outside);
      document.addEventListener("keydown", key);
    });
  }

  function paceFacts(count) {
    const s = settings();
    const names = { safe: "Safe", balanced: "Balanced", fast: "Fast", custom: "Custom" };
    const avg = (s.minDelay + s.maxDelay) / 2 + 1.5;
    let secs = count * avg;
    if (s.restEvery > 0) secs += Math.floor(count / s.restEvery) * s.restMinutes * 60;
    let eta = "~" + U.dur(secs);
    if (s.dailyLimit > 0) {
      const room = Math.max(0, s.dailyLimit - (D.S ? D.S.today : 0));
      if (count > room) eta = `~${Math.ceil((count - room) / s.dailyLimit) + 1} days (daily limit)`;
    }
    return [
      ["Pace", `${names[s.speed] || "Custom"} · ${s.minDelay}-${s.maxDelay}s apart`],
      ["Daily limit", s.dailyLimit ? `${s.dailyLimit} (${D.S ? D.S.today : 0} used today)` : "Off"],
      ["Estimated time", eta]
    ];
  }

  async function startRun(payload, count, label) {
    const ok = await confirmBox({
      title: `Unfollow ${U.fmt(count)} account${count === 1 ? "" : "s"}?`,
      body: label || "Whitelisted accounts are always skipped. You can pause or stop at any time.",
      facts: paceFacts(count),
      ok: "Start unfollowing"
    });
    if (!ok) return false;
    const r = await U.cmd("run", payload);
    if (!r.ok) { U.toast(r.error || "Couldn't start.", "err", 5000); return false; }
    U.toast(`Started - ${U.fmt(r.total)} in the queue.`, "ok");
    location.hash = "#overview";
    return true;
  }

  async function startScan(then) {
    const r = await U.cmd("scan", then ? { then } : {});
    if (!r.ok) U.toast(r.error || "Couldn't start the scan.", "err", 6000);
    else { U.toast("Scanning your following list...", "ok"); location.hash = "#overview"; }
    await refreshState();
  }

  // ======================================================================
  // routing
  // ======================================================================
  function route() {
    let r = location.hash.replace(/^#/, "") || "overview";
    if (r === "welcome") {
      $("#welcome").hidden = false;
      history.replaceState(null, "", "#overview");
      r = "overview";
    }
    if (!$(`.page[data-page="${r}"]`)) r = "overview";
    D.page = r;
    $$(".page").forEach((p) => p.classList.toggle("is-on", p.dataset.page === r));
    $$(".nav a").forEach((a) => a.classList.toggle("is-on", a.dataset.route === r));
    if (r === "following") renderFollowing(true);
    if (r === "whitelist") renderWhitelist();
    if (r === "history") renderHistory(true);
    if (r === "settings") fillSettings();
    window.scrollTo({ top: 0 });
  }

  // ======================================================================
  // data
  // ======================================================================
  async function refreshState() {
    const s = await U.cmd("state");
    if (s && s.ok) D.S = s;
    renderOverview();
    renderSide();
  }

  async function loadUsers() {
    const arr = await U.get(K.scanUsers, []);
    D.users = Array.isArray(arr) ? arr : [];
    D.byId = new Map(D.users.map((u) => [u.i, u]));
    for (const id of [...D.sel]) if (!D.byId.has(id)) D.sel.delete(id);
  }
  async function loadWl() { D.wl = new Set((await U.get(K.whitelist, [])).map((h) => String(h).toLowerCase())); }
  async function loadDone() { D.done = new Set(await U.get(K.doneIds, [])); }
  async function loadHistory() { const h = await U.get(K.history, []); D.history = Array.isArray(h) ? h : []; }

  async function saveWl() {
    await U.set({ [K.whitelist]: [...D.wl].sort() });
  }

  // ======================================================================
  // overview
  // ======================================================================
  function greeting() {
    const h = new Date().getHours();
    return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  }

  function renderOverview() {
    const S = D.S;
    if (!S) return;
    const acc = S.account;
    swapAvatar("#ovAvatar", acc && acc.avatar, acc && (acc.name || acc.handle), 52);
    if (acc && acc.id && !acc.signedOut) {
      $("#ovHello").textContent = `${greeting()}${acc.name ? ", " + acc.name.split(" ")[0] : ""}`;
      const bits = [];
      if (acc.handle) bits.push("@" + acc.handle);
      if (acc.following != null) bits.push(U.fmt(acc.following) + " following");
      if (acc.followers != null) bits.push(U.fmt(acc.followers) + " followers");
      $("#ovSub").textContent = bits.join(" · ") || "Connected to X";
    } else {
      $("#ovHello").textContent = "Welcome";
      $("#ovSub").textContent = acc && acc.signedOut ? "You're signed out of X. Sign in at x.com to continue." : "Open x.com and sign in, then scan your following list.";
    }

    const sc = S.scan && S.scan.status === "done" ? S.scan : null;
    $("#kFollowing").textContent = sc ? U.fmt(sc.total) : "-";
    $("#kFollowingSub").textContent = sc ? "scanned " + U.ago(sc.finishedAt) : "scan to see";
    $("#kNon").textContent = sc ? U.fmt(sc.nonFollowers) : "-";
    $("#kNonSub").textContent = sc ? `${U.fmt(S.actionable)} ready to unfollow` : " ";
    $("#kMutual").textContent = sc ? U.fmt(sc.mutuals) : "-";
    $("#kToday").textContent = U.fmt(S.today);
    $("#kTodaySub").textContent = S.settings.dailyLimit ? `of ${U.fmt(S.settings.dailyLimit)} daily limit` : "no daily limit set";
    $("#ovScanBtn").querySelector("span").textContent = sc ? "Rescan" : "Scan following";
    $("#ovScanBtn").disabled = !!(S.scan && S.scan.status === "running");

    const nav = $("#navNon");
    nav.hidden = !(sc && S.actionable);
    nav.textContent = U.compact(S.actionable || 0);

    renderRunPanel();
    renderFeed();
  }

  function renderRunPanel() {
    const S = D.S;
    const j = S.job;
    const scan = S.scan;
    const pill = $("#rpPill");
    const setPill = (kind, text) => { pill.className = "pill" + (kind ? " is-" + kind : ""); $("#rpPillText").textContent = text; };

    $("#rpIdle").hidden = $("#rpActive").hidden = $("#rpScan").hidden = true;

    if (scan && scan.status === "running") {
      setPill("scan", "Scanning");
      $("#rpScan").hidden = false;
      $("#rpScanNum").textContent = U.fmt(scan.phase === "followers" ? scan.followersRead || 0 : scan.fetched || 0);
      $("#rpScanMsg").textContent = scan.message || "";
      const bar = $("#rpScanBar");
      if (scan.expected && scan.phase !== "followers") {
        bar.classList.remove("is-indeterminate");
        bar.firstElementChild.style.width = Math.min(98, Math.max(3, (scan.fetched || 0) / scan.expected * 100)) + "%";
      } else bar.classList.add("is-indeterminate");
      return;
    }

    if (j) {
      const active = ["running", "resting", "paused", "halted"].includes(j.status);
      const labels = { running: ["run", "Running"], resting: ["rest", "Resting"], paused: ["", "Paused"], halted: ["halt", "Needs you"], done: ["done", "Finished"], stopped: ["", "Stopped"] };
      const [k, t] = labels[j.status] || ["", j.status];
      setPill(k, t);
      $("#rpActive").hidden = false;
      const pct = j.total ? Math.round(((j.done + j.skipped + j.failed) / j.total) * 100) : 0;
      $("#rpDone").textContent = U.fmt(j.done);
      $("#rpTotal").textContent = "/ " + U.fmt(j.total) + " unfollowed";
      $("#rpPct").textContent = pct + "%";
      const bar = $("#rpBar");
      bar.className = "bar" + (j.status === "running" ? " is-live" : j.status === "resting" ? " is-rest" : (j.status === "done" ? " is-done" : ""));
      bar.firstElementChild.style.width = Math.max(2, pct) + "%";
      const t2 = j.current;
      swapAvatar("#rpAvatar", t2 && t2.a, t2 && (t2.n || t2.h), 40);
      $("#rpNow").textContent = active && t2 ? (t2.n ? `${t2.n}  @${t2.h}` : "@" + t2.h) : (j.message || "-");
      $("#rpNowLabel").textContent = active ? (j.inFlight ? "Unfollowing" : "Next up") : "Summary";
      const msg = $("#rpMsg");
      msg.textContent = active ? (j.message || "") : `${U.fmt(j.done)} unfollowed, ${U.fmt(j.skipped + j.failed)} skipped${j.finishedAt ? ", took " + U.dur((j.finishedAt - j.startedAt) / 1000) : ""}.`;
      msg.className = "rp-msg" + (j.status === "halted" ? " is-error" : j.status === "resting" ? " is-warn" : "");
      $("#rpSkipped").textContent = U.fmt(j.skipped + j.failed);
      $("#rpLeft").textContent = U.fmt(Math.max(0, j.total - j.index));
      $("#rpMode").textContent = j.executor === "profile" ? "Profile" : "Direct";
      $("#rpPause").hidden = !(j.status === "running" || j.status === "resting");
      $("#rpResume").hidden = !(j.status === "paused" || j.status === "halted");
      $("#rpStop").hidden = !active;
      $("#rpClear").hidden = active;
      tickTimers();
      return;
    }

    setPill("", "Idle");
    $("#rpIdle").hidden = false;
    const sc = scan && scan.status === "done" ? scan : null;
    const n = S.actionable || 0;
    $("#rpRunNonLabel").textContent = sc ? (n ? `Unfollow ${U.fmt(n)} non-follower${n === 1 ? "" : "s"}` : "No non-followers left") : "Scan & unfollow non-followers";
    $("#rpRunNon").disabled = !!(sc && (!n || sc.relationshipUnknown));
    $("#rpIdleText").textContent = sc
      ? (sc.relationshipUnknown
          ? "X didn't report who follows you back in the last scan. Rescan in a few minutes."
          : `${U.fmt(sc.nonFollowers)} of the ${U.fmt(sc.total)} accounts you follow don't follow you back.`)
      : "Scan your following list, then unfollow everyone who doesn't follow you back with one click.";
  }

  function tickTimers() {
    const j = D.S && D.S.job;
    if (!j) return;
    const el = $("#rpTimer"), lab = $("#rpTimerLabel");
    if (j.status === "running" && j.inFlight) { el.innerHTML = '<span class="spinner"></span>'; lab.textContent = "working"; return; }
    let target = null, label = "next in";
    if (j.status === "resting") { target = j.restUntil; label = j.restReason === "daily" ? "daily limit" : "break"; }
    else if (j.status === "running") target = j.nextAt;
    if (!target) { el.textContent = "-"; lab.textContent = j.status === "paused" ? "paused" : ""; return; }
    const secs = Math.max(0, Math.round((target - Date.now()) / 1000));
    el.textContent = secs >= 3600 ? U.clock(target) : secs >= 60 ? Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0") : secs + "s";
    lab.textContent = label;
  }
  setInterval(tickTimers, 500);

  function renderFeed() {
    const feed = $("#feed");
    const j = D.S && D.S.job;
    let items = [];
    if (j && j.log && j.log.length) {
      items = j.log.slice(0, 25).map((l) => ({ h: l.h, r: l.r, m: l.m, t: l.t }));
    } else {
      items = D.history.slice(-25).reverse().map((h) => ({ h: h.h, n: h.n, a: h.a, r: "ok", m: "unfollowed", t: h.t }));
    }
    $("#feedEmpty").hidden = items.length > 0;
    const byH = new Map(D.users.map((u) => [u.h.toLowerCase(), u]));
    feed.innerHTML = items.map((it) => {
      const u = byH.get(String(it.h || "").toLowerCase()) || it;
      return `<li>${avatarHtml(u.a, u.n || it.h, 30)}<div class="f-text"><b>@${U.esc(it.h)}</b> ${U.esc(it.m || "")}<small>${U.esc(U.ago(it.t))}</small></div><span class="f-dot ${U.esc(it.r)}"></span></li>`;
    }).join("");
  }

  // ---------- sidebar run card ----------
  function renderSide() {
    const S = D.S;
    if (!S) return;
    $("#version").textContent = "v" + S.version;
    const card = $("#sideRun");
    const j = S.job, sc = S.scan;
    const pill = $("#sideRunPill");
    if (sc && sc.status === "running") {
      card.hidden = false;
      pill.className = "pill is-scan";
      $("#sideRunText").textContent = "Scanning";
      $("#sideRunNum").textContent = U.fmt(sc.fetched || 0);
      $("#sideRunBar").className = "bar is-scan is-live is-indeterminate";
      $("#sideRunMsg").textContent = sc.message || "";
    } else if (j && ["running", "resting", "paused", "halted"].includes(j.status)) {
      card.hidden = false;
      const map = { running: ["run", "Running"], resting: ["rest", "Resting"], paused: ["", "Paused"], halted: ["halt", "Needs you"] };
      pill.className = "pill" + (map[j.status][0] ? " is-" + map[j.status][0] : "");
      $("#sideRunText").textContent = map[j.status][1];
      $("#sideRunNum").textContent = `${U.fmt(j.done)}/${U.fmt(j.total)}`;
      const bar = $("#sideRunBar");
      bar.className = "bar" + (j.status === "running" ? " is-live" : j.status === "resting" ? " is-rest" : "");
      bar.firstElementChild.style.width = Math.max(2, j.total ? (j.index / j.total) * 100 : 0) + "%";
      $("#sideRunMsg").textContent = j.message || "";
    } else {
      card.hidden = true;
    }
    const wl = $("#navWl");
    wl.hidden = !D.wl.size;
    wl.textContent = U.compact(D.wl.size);
  }

  // ======================================================================
  // following table
  // ======================================================================
  function matchesChips(u) {
    for (const c of D.chips) {
      if (c === "noavatar" && !u.d) return false;
      if (c === "fewposts" && !(typeof u.sc === "number" && u.sc < 10)) return false;
      if (c === "fewfollowers" && !(typeof u.fc === "number" && u.fc < 50)) return false;
      if (c === "spammy" && !(typeof u.fr === "number" && typeof u.fc === "number" && u.fr >= 100 && u.fr >= 10 * Math.max(1, u.fc))) return false;
      if (c === "verified" && !u.v) return false;
      if (c === "private" && !u.p) return false;
    }
    return true;
  }

  function computeList() {
    const q = D.q.trim().toLowerCase().replace(/^@/, "");
    const counts = { non: 0, mutual: 0, all: 0, kept: 0, done: 0 };
    const out = [];
    for (let idx = 0; idx < D.users.length; idx++) {
      const u = D.users[idx];
      const isDone = D.done.has(u.i);
      const kept = !isDone && keepOf(u);
      if (isDone) counts.done++;
      else {
        counts.all++;
        if (u.fy === false) counts.non++;
        if (u.fy === true) counts.mutual++;
        if (kept) counts.kept++;
      }
      let inSeg;
      switch (D.seg) {
        case "non": inSeg = !isDone && u.fy === false; break;
        case "mutual": inSeg = !isDone && u.fy === true; break;
        case "kept": inSeg = !!kept; break;
        case "done": inSeg = isDone; break;
        default: inSeg = !isDone;
      }
      if (!inSeg || !matchesChips(u)) continue;
      if (q && !(u.h.toLowerCase().includes(q) || (u.n || "").toLowerCase().includes(q) || (u.b || "").toLowerCase().includes(q))) continue;
      out.push({ u, idx, kept, isDone });
    }
    const cmpNum = (a, b, f, dir) => {
      const x = a.u[f], y = b.u[f];
      if (x == null && y == null) return a.idx - b.idx;
      if (x == null) return 1;
      if (y == null) return -1;
      return dir * (x - y) || a.idx - b.idx;
    };
    switch (D.sort) {
      case "oldest": out.sort((a, b) => b.idx - a.idx); break;
      case "name": out.sort((a, b) => (a.u.n || a.u.h).localeCompare(b.u.n || b.u.h)); break;
      case "fcDesc": out.sort((a, b) => cmpNum(a, b, "fc", -1)); break;
      case "fcAsc": out.sort((a, b) => cmpNum(a, b, "fc", 1)); break;
      case "posts": out.sort((a, b) => cmpNum(a, b, "sc", 1)); break;
      case "joined": out.sort((a, b) => cmpNum(a, b, "ca", -1)); break;
      default: break;
    }
    $("#cNon").textContent = U.compact(counts.non);
    $("#cMutual").textContent = U.compact(counts.mutual);
    $("#cAll").textContent = U.compact(counts.all);
    $("#cKept").textContent = U.compact(counts.kept);
    $("#cDone").textContent = U.compact(counts.done);
    return out;
  }

  function rowHtml(it) {
    const u = it.u;
    const sel = D.sel.has(u.i);
    const selectable = !it.kept && !it.isDone;
    const tags = [];
    if (u.fy === true) tags.push('<span class="tag ok">Follows you</span>');
    if (u.v) tags.push('<span class="tag info">Verified</span>');
    if (u.p) tags.push('<span class="tag">Private</span>');
    if (it.isDone) tags.push('<span class="tag">Unfollowed</span>');
    else if (it.kept && it.kept !== "whitelist") tags.push(`<span class="tag warn">Kept: ${U.esc(it.kept)}</span>`);
    const wl = D.wl.has(u.h.toLowerCase());
    const keepCls = wl ? "is-on" : (it.kept ? "is-rule" : "");
    const keepTitle = wl ? "On your whitelist - click to remove" : (it.kept ? "Kept by a Keep rule (" + it.kept + ")" : "Add to whitelist");
    return `<div class="row${sel ? " is-sel" : ""}${it.isDone ? " is-done" : ""}" data-id="${U.esc(u.i)}">
      <label class="cb"><input type="checkbox" class="rowcb" ${sel ? "checked" : ""} ${selectable ? "" : "disabled"}><span></span></label>
      <div class="who-cell">${avatarHtml(u.a, u.n || u.h, 40)}
        <div class="who-text">
          <div class="who-line"><b>${U.esc(u.n || u.h)}</b><a href="https://x.com/${encodeURIComponent(u.h)}" target="_blank" rel="noopener">@${U.esc(u.h)}</a><span class="tags">${tags.join("")}</span></div>
          <div class="bio">${U.esc(u.b || "")}</div>
        </div>
      </div>
      <span class="num-cell fc-cell">${U.compact(u.fc)}</span>
      <span class="num-cell posts-cell">${U.compact(u.sc)}</span>
      <span class="num-cell joined-cell">${U.esc(monthYear(u.ca))}</span>
      <span class="keep-cell"><button class="keep-btn ${keepCls}" title="${U.esc(keepTitle)}" data-keep="${U.esc(u.h)}">${U.icon("shield")}</button></span>
    </div>`;
  }

  function renderFollowing(reset) {
    const hasScan = D.users.length > 0;
    $("#flEmpty").hidden = hasScan;
    $("#flBody").hidden = !hasScan;
    const sc = D.S && D.S.scan;
    const acc = D.S && D.S.account;
    const otherAccount = sc && acc && acc.id && sc.ownerId && sc.ownerId !== acc.id;
    $("#flSub").textContent = hasScan && sc && sc.finishedAt
      ? `${U.fmt(D.users.length)} accounts · scanned ${U.ago(sc.finishedAt)}${sc.partial ? " (partial)" : ""}` +
        (otherAccount ? " · this scan is from a different X account - rescan" : "")
      : "Review everyone you follow, choose who goes, protect who stays.";
    if (!hasScan) { $("#bulk").hidden = true; return; }

    if (reset) {
      D.list = computeList();
      D.shown = 0;
      $("#flRows").innerHTML = "";
    }
    renderMoreRows();
    $("#flNone").hidden = D.list.length > 0;
    syncSelectAll();
    renderBulk();
  }

  function renderMoreRows() {
    if (D.shown >= D.list.length) return;
    const next = D.list.slice(D.shown, D.shown + CHUNK);
    $("#flRows").insertAdjacentHTML("beforeend", next.map(rowHtml).join(""));
    D.shown += next.length;
  }

  const moreObs = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && D.page === "following") renderMoreRows();
    if (entries.some((e) => e.isIntersecting) && D.page === "history") renderMoreHistory();
  }, { rootMargin: "600px" });

  function selectable() { return D.list.filter((it) => !it.kept && !it.isDone); }

  function syncSelectAll() {
    const all = $("#flAll");
    const sel = selectable();
    const n = sel.filter((it) => D.sel.has(it.u.i)).length;
    all.checked = sel.length > 0 && n === sel.length;
    all.indeterminate = n > 0 && n < sel.length;
    all.disabled = sel.length === 0;
  }

  function renderBulk() {
    const n = D.sel.size;
    $("#bulk").hidden = n === 0 || D.page !== "following";
    $("#bulkCount").textContent = `${U.fmt(n)} selected`;
  }

  function updateRowSel(id) {
    const row = $(`.row[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    const on = D.sel.has(id);
    row.classList.toggle("is-sel", on);
    const cb = row.querySelector(".rowcb");
    if (cb) cb.checked = on;
  }

  async function toggleWhitelist(handle) {
    const k = handle.toLowerCase();
    if (D.wl.has(k)) { D.wl.delete(k); U.toast(`@${handle} removed from whitelist`); }
    else {
      D.wl.add(k);
      const u = D.users.find((x) => x.h.toLowerCase() === k);
      if (u) D.sel.delete(u.i);
      U.toast(`@${handle} will never be unfollowed`, "ok");
    }
    await saveWl();
  }

  function exportUsers(items, name) {
    const rows = items.map(({ u }) => [
      u.h, u.n, "https://x.com/" + u.h, u.fy === true ? "yes" : u.fy === false ? "no" : "unknown",
      u.fc ?? "", u.fr ?? "", u.sc ?? "", u.v ? "yes" : "no", u.p ? "yes" : "no",
      u.ca ? new Date(u.ca).toISOString().slice(0, 10) : "", u.b || ""
    ]);
    const csv = U.csv(["handle", "name", "profile_url", "follows_you", "followers", "following", "posts", "verified", "private", "joined", "bio"], rows);
    U.download(`x-${name}-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  }

  function wireFollowing() {
    let qTimer = null;
    $("#flSearch").addEventListener("input", (e) => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { D.q = e.target.value; renderFollowing(true); }, 140);
    });
    $("#flSeg").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-f]");
      if (!b) return;
      D.seg = b.dataset.f;
      $$("#flSeg button").forEach((x) => x.classList.toggle("is-on", x === b));
      renderFollowing(true);
    });
    $("#flChips").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-x]");
      if (!b) return;
      const k = b.dataset.x;
      if (D.chips.has(k)) D.chips.delete(k); else D.chips.add(k);
      b.classList.toggle("is-on", D.chips.has(k));
      renderFollowing(true);
    });
    $("#flSort").addEventListener("change", (e) => { D.sort = e.target.value; renderFollowing(true); });

    $("#flRows").addEventListener("change", (e) => {
      if (!e.target.classList.contains("rowcb")) return;
      const id = e.target.closest(".row").dataset.id;
      if (e.target.checked) D.sel.add(id); else D.sel.delete(id);
      updateRowSel(id);
      syncSelectAll();
      renderBulk();
    });
    $("#flRows").addEventListener("click", (e) => {
      const k = e.target.closest("[data-keep]");
      if (!k || k.classList.contains("is-rule")) return;
      toggleWhitelist(k.dataset.keep);
    });
    $("#flAll").addEventListener("change", (e) => {
      for (const it of selectable()) { if (e.target.checked) D.sel.add(it.u.i); else D.sel.delete(it.u.i); }
      $$("#flRows .row").forEach((r) => updateRowSel(r.dataset.id));
      syncSelectAll();
      renderBulk();
    });

    $("#bulkClear").addEventListener("click", () => {
      D.sel.clear();
      $$("#flRows .row").forEach((r) => updateRowSel(r.dataset.id));
      syncSelectAll(); renderBulk();
    });
    $("#bulkKeep").addEventListener("click", async () => {
      for (const id of D.sel) { const u = D.byId.get(id); if (u) D.wl.add(u.h.toLowerCase()); }
      const n = D.sel.size;
      D.sel.clear();
      await saveWl();
      U.toast(`${U.fmt(n)} added to your whitelist`, "ok");
    });
    $("#bulkExport").addEventListener("click", () => {
      exportUsers([...D.sel].map((id) => ({ u: D.byId.get(id) })).filter((x) => x.u), "selected");
    });
    $("#bulkRun").addEventListener("click", async () => {
      const ids = [...D.sel];
      if (await startRun({ source: "ids", ids }, ids.length, "Only the accounts you selected. Whitelisted accounts are always skipped.")) {
        D.sel.clear();
        renderBulk();
      }
    });
    $("#flExport").addEventListener("click", () => exportUsers(D.list, D.seg === "non" ? "non-followers" : D.seg));
    $("#flScan").addEventListener("click", () => startScan());
    $("#flEmptyScan").addEventListener("click", () => startScan());
    moreObs.observe($("#flMore"));
  }

  // ======================================================================
  // whitelist
  // ======================================================================
  function renderWhitelist() {
    const q = $("#wlSearch").value.trim().toLowerCase().replace(/^@/, "");
    const list = [...D.wl].sort().filter((h) => !q || h.includes(q));
    $("#wlCount").textContent = U.fmt(D.wl.size);
    $("#wlEmpty").hidden = list.length > 0;
    const byH = new Map(D.users.map((u) => [u.h.toLowerCase(), u]));
    $("#wlList").innerHTML = list.map((h) => {
      const u = byH.get(h);
      return `<span class="wl-item"><a href="https://x.com/${encodeURIComponent(h)}" target="_blank" rel="noopener">@${U.esc(u ? u.h : h)}</a><button title="Remove" data-rm="${U.esc(h)}">${U.icon("x")}</button></span>`;
    }).join("");
  }

  function wireWhitelist() {
    const add = async () => {
      const raw = $("#wlInput").value;
      const hs = raw.split(/[\s,;]+/).map(X7.cleanHandle).filter(Boolean);
      if (!hs.length) { U.toast("Type a handle like @name", "err"); return; }
      let n = 0;
      for (const h of hs) { if (!D.wl.has(h.toLowerCase())) { D.wl.add(h.toLowerCase()); n++; } }
      $("#wlInput").value = "";
      await saveWl();
      U.toast(n ? `${n} added to your whitelist` : "Already on your whitelist", n ? "ok" : "");
    };
    $("#wlAdd").addEventListener("click", add);
    $("#wlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
    $("#wlSearch").addEventListener("input", renderWhitelist);
    $("#wlList").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-rm]");
      if (!b) return;
      D.wl.delete(b.dataset.rm);
      await saveWl();
    });
    $("#wlExport").addEventListener("click", () => {
      U.download(`x-whitelist-${new Date().toISOString().slice(0, 10)}.csv`, U.csv(["handle", "profile_url"], [...D.wl].sort().map((h) => [h, "https://x.com/" + h])));
    });
  }

  // ======================================================================
  // history
  // ======================================================================
  function renderHistory(reset) {
    if (reset) {
      const q = $("#hiSearch").value.trim().toLowerCase().replace(/^@/, "");
      D.hiList = D.history.slice().reverse().filter((h) => !q || String(h.h).toLowerCase().includes(q) || String(h.n || "").toLowerCase().includes(q));
      D.hiShown = 0;
      $("#hiList").innerHTML = "";
    }
    $("#hiCount").textContent = U.fmt(D.history.length);
    $("#hiEmpty").hidden = D.hiList.length > 0;
    renderMoreHistory();
  }

  function renderMoreHistory() {
    if (D.hiShown >= D.hiList.length) return;
    const next = D.hiList.slice(D.hiShown, D.hiShown + CHUNK);
    $("#hiList").insertAdjacentHTML("beforeend", next.map((h) => `
      <div class="hi-row">${avatarHtml(h.a, h.n || h.h, 36)}
        <div class="hi-who"><b>${U.esc(h.n || "@" + h.h)}</b><a href="https://x.com/${encodeURIComponent(h.h)}" target="_blank" rel="noopener">@${U.esc(h.h)}</a></div>
        <span class="tag">${U.esc({ nonfollowers: "Non-follower", all: "Unfollow all", ids: "Selected", handles: "Imported", v6: "Earlier version" }[h.s] || "Unfollowed")}</span>
        <time title="${U.esc(new Date(h.t).toLocaleString())}">${U.esc(U.ago(h.t))}</time>
      </div>`).join(""));
    D.hiShown += next.length;
  }

  function wireHistory() {
    let t = null;
    $("#hiSearch").addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => renderHistory(true), 140); });
    $("#hiExport").addEventListener("click", () => {
      if (!D.history.length) { U.toast("History is empty."); return; }
      const rows = D.history.slice().reverse().map((h) => [h.h, h.n || "", "https://x.com/" + h.h, new Date(h.t).toISOString(), h.s || ""]);
      U.download(`x-unfollowed-${new Date().toISOString().slice(0, 10)}.csv`, U.csv(["handle", "name", "profile_url", "unfollowed_at", "source"], rows));
    });
    $("#hiClear").addEventListener("click", async () => {
      if (!D.history.length) return;
      const ok = await confirmBox({ title: "Clear your unfollow history?", body: "This only deletes the list kept in this browser. It doesn't re-follow anyone.", ok: "Clear history", danger: true, icon: "trash" });
      if (!ok) return;
      await U.set({ [K.history]: [] });
      U.toast("History cleared.");
    });
    moreObs.observe($("#hiMore"));
  }

  // ======================================================================
  // import
  // ======================================================================
  let imported = [];
  function setImported(text) {
    const { handles, skipped } = U.handlesFrom(text);
    const fresh = handles.filter((h) => !D.wl.has(h.toLowerCase()));
    imported = fresh;
    const protectedN = handles.length - fresh.length;
    $("#impRun").disabled = !fresh.length;
    $("#impRunLabel").textContent = fresh.length ? `Unfollow ${U.fmt(fresh.length)} account${fresh.length === 1 ? "" : "s"}` : "Unfollow these";
    $("#impInfo").textContent = handles.length
      ? `Found ${U.fmt(handles.length)} account${handles.length === 1 ? "" : "s"}` +
        (protectedN ? ` · ${protectedN} whitelisted (skipped)` : "") +
        (skipped ? ` · ${skipped} unreadable line${skipped === 1 ? "" : "s"}` : "")
      : "Whitelisted accounts are skipped automatically.";
  }

  function wireImport() {
    const drop = $("#drop");
    const readFile = (f) => {
      if (!f) return;
      if (f.size > 20 * 1024 * 1024) { U.toast("That file is too large.", "err"); return; }
      const r = new FileReader();
      r.onload = () => { $("#impText").value = String(r.result || ""); setImported($("#impText").value); };
      r.readAsText(f);
    };
    $("#impPick").addEventListener("click", () => $("#impFile").click());
    $("#impFile").addEventListener("change", (e) => readFile(e.target.files[0]));
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("is-over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("is-over"); }));
    drop.addEventListener("drop", (e) => readFile(e.dataTransfer.files[0]));
    let t = null;
    $("#impText").addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => setImported($("#impText").value), 200); });
    $("#impRun").addEventListener("click", async () => {
      if (!imported.length) return;
      if (await startRun({ source: "handles", handles: imported }, imported.length, "Accounts from your list that you already don't follow are skipped automatically.")) {
        $("#impText").value = "";
        setImported("");
      }
    });
  }

  // ======================================================================
  // settings
  // ======================================================================
  const NUM_FIELDS = ["minDelay", "maxDelay", "restEvery", "restMinutes", "dailyLimit", "scanMaxAgeHours", "keepMinFollowers"];

  function fillSettings() {
    const s = settings();
    for (const k of NUM_FIELDS) if ($("#" + k) && document.activeElement !== $("#" + k)) $("#" + k).value = s[k];
    $("#keepVerified").checked = !!s.keepVerified;
    $("#keepProtected").checked = !!s.keepProtected;
    if (document.activeElement !== $("#keepKeywords")) $("#keepKeywords").value = s.keepKeywords || "";
    $$(".preset").forEach((p) => p.classList.toggle("is-on", p.dataset.speed === s.speed));
    speedWarnings(s);
  }

  function speedWarnings(s) {
    const w = [];
    if (s.dailyLimit === 0) w.push("No daily limit: X may restrict your account if you unfollow hundreds in a day.");
    else if (s.dailyLimit > 400 && s.speed !== "fast") w.push("More than 400 a day is usually only safe on X Premium accounts.");
    if (s.minDelay < 4) w.push("Delays under 4 seconds are fast enough for X to notice.");
    if (s.speed === "fast") w.push("Fast is meant for Premium accounts. If X asks you to slow down, the run rests automatically.");
    const el = $("#speedWarn");
    el.hidden = !w.length;
    el.textContent = w.join(" ");
  }

  let saveTimer = null;
  function queueSave(patch) {
    D.S.settings = X7.normalizeSettings(Object.assign({}, D.S.settings, patch));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await U.set({ [K.settings]: D.S.settings });
      const b = $("#savedBadge");
      b.classList.add("show");
      setTimeout(() => b.classList.remove("show"), 1400);
      speedWarnings(D.S.settings);
    }, 350);
  }

  function wireSettings() {
    $("#presets").addEventListener("click", (e) => {
      const p = e.target.closest(".preset");
      if (!p) return;
      const speed = p.dataset.speed;
      const patch = speed === "custom" ? { speed } : Object.assign({ speed }, X7.PRESETS[speed]);
      queueSave(patch);
      fillSettings();
    });
    for (const k of NUM_FIELDS) {
      $("#" + k).addEventListener("input", (e) => {
        const v = e.target.value;
        if (v === "") return;
        const patch = { [k]: Number(v) };
        if (["minDelay", "maxDelay", "restEvery", "restMinutes", "dailyLimit"].includes(k)) patch.speed = "custom";
        queueSave(patch);
        $$(".preset").forEach((p) => p.classList.toggle("is-on", p.dataset.speed === (patch.speed || D.S.settings.speed)));
      });
      $("#" + k).addEventListener("blur", fillSettings);
    }
    $("#keepVerified").addEventListener("change", (e) => queueSave({ keepVerified: e.target.checked }));
    $("#keepProtected").addEventListener("change", (e) => queueSave({ keepProtected: e.target.checked }));
    $("#keepKeywords").addEventListener("input", (e) => queueSave({ keepKeywords: e.target.value }));
    $("#resetSettings").addEventListener("click", async () => {
      if (!await confirmBox({ title: "Reset settings?", body: "Speed and Keep rules go back to the recommended defaults. Your whitelist and history are kept.", ok: "Reset", info: true, icon: "refresh" })) return;
      D.S.settings = X7.normalizeSettings({});
      await U.set({ [K.settings]: D.S.settings });
      fillSettings();
      U.toast("Settings reset.", "ok");
    });
    $("#wipeAll").addEventListener("click", async () => {
      if (!await confirmBox({ title: "Delete all extension data?", body: "Your scan, whitelist, history and settings will be erased from this browser. This can't be undone.", ok: "Delete everything", danger: true, icon: "trash" })) return;
      await U.cmd("scanStop");
      await U.cmd("stop");
      await chrome.storage.local.clear();
      U.toast("All data deleted.");
      setTimeout(() => location.reload(), 600);
    });
  }

  // ======================================================================
  // help / health
  // ======================================================================
  function renderHealth(h) {
    const list = $("#healthList");
    if (!h) { list.innerHTML = ""; return; }
    const row = (label, ok, detail) => `<li>${U.icon(ok ? "check" : "alert", ok ? "ok" : "bad")}<b>${U.esc(label)}</b><span>${U.esc(detail)}</span></li>`;
    const items = [];
    if (h.ok === false && h.message) items.push(row("Connection", false, h.message));
    items.push(row("Signed in to X", !!h.signedIn, h.signedIn ? "Yes" : "No - sign in at x.com"));
    if (h.signedIn) {
      items.push(row("Session token", !!h.csrf, h.csrf ? "Present" : "Missing - reload x.com"));
      items.push(row("Request signing", h.txid === "ok", h.txid === "ok" ? "Working" : String(h.txid || "Not checked")));
      items.push(row("X app queries", !!h.ops && !/could not|error/i.test(h.ops), String(h.ops || "Not checked")));
      items.push(row("Reading your list", /^ok/.test(h.read || ""), String(h.read || "Not checked")));
    }
    if (h.at) items.push(`<li>${U.icon("clock")}<b>Checked</b><span>${U.esc(U.ago(h.at))}</span></li>`);
    list.innerHTML = items.join("");
  }

  function wireHelp() {
    $("#healthBtn").addEventListener("click", async () => {
      const b = $("#healthBtn");
      b.disabled = true;
      b.querySelector("span").textContent = "Checking...";
      const r = await U.cmd("health");
      b.disabled = false;
      b.querySelector("span").textContent = "Run check";
      if (!r.ok) { U.toast(r.error || "Check failed.", "err"); return; }
      renderHealth(r.health);
    });
  }

  // ======================================================================
  // overview wiring
  // ======================================================================
  function wireOverview() {
    $("#ovScanBtn").addEventListener("click", () => startScan());
    $("#rpRunNon").addEventListener("click", async () => {
      const S = D.S;
      const sc = S.scan && S.scan.status === "done" ? S.scan : null;
      const stale = !sc || Date.now() - sc.finishedAt > S.settings.scanMaxAgeHours * 3600000;
      if (!sc) return startScan({ source: "nonfollowers" });
      if (stale) {
        const ok = await confirmBox({ title: "Refresh your scan first?", body: `Your scan is from ${U.ago(sc.finishedAt)}. It will be refreshed, then everyone who doesn't follow you back is unfollowed.`, ok: "Scan & start", info: true, icon: "scan", facts: paceFacts(S.actionable || 0) });
        if (ok) startScan({ source: "nonfollowers" });
        return;
      }
      startRun({ source: "nonfollowers" }, S.actionable || 0, "Only accounts that don't follow you back. Your whitelist and Keep rules always apply.");
    });
    $("#rpReview").addEventListener("click", () => { location.hash = "#following"; });
    $("#rpPause").addEventListener("click", () => U.cmd("pause").then(refreshState));
    $("#rpResume").addEventListener("click", () => U.cmd("resume").then(refreshState));
    $("#rpStop").addEventListener("click", async () => {
      if (await confirmBox({ title: "Stop this run?", body: "Progress so far is kept. You can start a new run any time.", ok: "Stop", danger: true, icon: "stop" })) U.cmd("stop").then(refreshState);
    });
    $("#rpClear").addEventListener("click", () => U.cmd("clearJob").then(refreshState));
    $("#rpScanStop").addEventListener("click", () => U.cmd("scanStop").then(refreshState));

    $("#welcomeScan").addEventListener("click", () => { $("#welcome").hidden = true; startScan(); });
    $("#welcomeLater").addEventListener("click", () => { $("#welcome").hidden = true; });
  }

  // ======================================================================
  // live updates
  // ======================================================================
  let stTimer = null;
  U.watch([K.job, K.scan, K.account, K.ledger], () => {
    clearTimeout(stTimer);
    stTimer = setTimeout(refreshState, 150);
  });
  U.watch([K.scanUsers], async () => { await loadUsers(); if (D.page === "following") renderFollowing(true); renderFeed(); });
  U.watch([K.whitelist], async () => {
    await loadWl();
    renderSide();
    if (D.page === "whitelist") renderWhitelist();
    if (D.page === "following") { const y = window.scrollY; renderFollowing(true); window.scrollTo(0, y); }
    refreshState();
  });
  U.watch([K.doneIds], async () => {
    await loadDone();
    if (D.page === "following") { const y = window.scrollY; renderFollowing(true); window.scrollTo(0, y); }
  });
  U.watch([K.history], async () => { await loadHistory(); renderFeed(); if (D.page === "history") renderHistory(true); });
  U.watch([K.settings], async () => {
    const s = await U.get(K.settings, null);
    if (D.S && s) D.S.settings = X7.normalizeSettings(s);
    if (D.page === "settings") fillSettings();
    if (D.page === "following") renderFollowing(true);
  });

  // ======================================================================
  // boot
  // ======================================================================
  document.addEventListener("DOMContentLoaded", async () => {
    U.icons();
    await Promise.all([loadUsers(), loadWl(), loadDone(), loadHistory()]);
    await refreshState();
    wireOverview();
    wireFollowing();
    wireWhitelist();
    wireHistory();
    wireImport();
    wireSettings();
    wireHelp();
    window.addEventListener("hashchange", route);
    route();
    renderHealth(D.S && D.S.health && D.S.health.signedIn !== undefined ? D.S.health : null);
    U.cmd("refreshAccount").then((r) => { if (r && r.ok) refreshState(); });
  });
})();
