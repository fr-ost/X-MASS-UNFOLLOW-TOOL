// X Mass Unfollow - popup.js
(function () {
  "use strict";

  const { $, $$ } = U;
  const K = X7.K;
  let S = null;              // latest state from the worker
  let pending = null;        // action waiting in the confirm sheet

  // ------------------------------------------------------------------ views
  function show(name) {
    $$(".view").forEach((v) => v.classList.toggle("is-on", v.dataset.view === name));
  }

  function setStatus(kind, text) {
    const pill = $("#statusPill");
    pill.className = "pill" + (kind ? " is-" + kind : "");
    $("#statusText").textContent = text;
  }

  function renderAccount() {
    const acc = S.account;
    const av = $("#accAvatar");
    const fresh = U.avatar(acc && acc.avatar, acc && (acc.name || acc.handle), 40);
    av.replaceWith(fresh);
    fresh.id = "accAvatar";
    if (acc && acc.id && !acc.signedOut) {
      $("#accName").textContent = acc.name || (acc.handle ? "@" + acc.handle : "Signed in");
      $("#accHandle").textContent = acc.handle
        ? "@" + acc.handle + (acc.following != null ? " · " + U.compact(acc.following) + " following" : "")
        : "Connected to X";
    } else {
      $("#accName").textContent = acc && acc.signedOut ? "Signed out of X" : "Not connected";
      $("#accHandle").textContent = "Open x.com and sign in";
    }

    const limit = S.settings.dailyLimit;
    const used = S.today || 0;
    U.countTo($("#todayNum"), used, U.compact);
    $("#todayCap").textContent = limit ? "of " + U.compact(limit) : "today";
    const frac = limit ? Math.min(1, used / limit) : (used ? 1 : 0);
    $("#todayRing").style.strokeDashoffset = String(97.4 * (1 - frac));
    const box = $("#todayBox");
    box.classList.toggle("is-near", !!limit && frac >= 0.8 && frac < 1);
    box.classList.toggle("is-full", !!limit && frac >= 1);
    box.title = limit ? `${used} of ${limit} unfollows used in the last 24 hours` : `${used} unfollows in the last 24 hours (no daily limit)`;
  }

  function settingsLine() {
    const s = S.settings;
    const names = { safe: "Safe", balanced: "Balanced", fast: "Fast", custom: "Custom" };
    return `${names[s.speed] || "Custom"} · ${s.minDelay}-${s.maxDelay}s apart`;
  }

  function estimate(count) {
    const s = S.settings;
    const avg = (s.minDelay + s.maxDelay) / 2 + 1.5;
    let secs = count * avg;
    if (s.restEvery > 0) secs += Math.floor(count / s.restEvery) * s.restMinutes * 60;
    if (s.dailyLimit > 0) {
      const room = Math.max(0, s.dailyLimit - (S.today || 0));
      if (count > room) {
        const days = Math.ceil((count - room) / s.dailyLimit);
        return `${U.dur(Math.min(secs, room * avg))} today, then ~${days} more day${days === 1 ? "" : "s"}`;
      }
    }
    return "~" + U.dur(secs);
  }

  function scanIsStale() {
    const sc = S.scan;
    if (!sc || !sc.finishedAt) return true;
    return Date.now() - sc.finishedAt > S.settings.scanMaxAgeHours * 3600000;
  }

  // ------------------------------------------------------------------ render
  function render() {
    renderAccount();
    const { scan, job, account } = S;
    const signedOut = account && account.signedOut;

    if (scan && scan.status === "running") return renderScanning();
    if (job && ["running", "resting", "paused", "halted"].includes(job.status)) return renderRun();
    if (job && ["done", "stopped"].includes(job.status)) return renderDone();
    if (signedOut) { setStatus("halt", "Signed out"); return show("signin"); }
    if (scan && scan.status === "done" && (!account || !account.id || scan.ownerId === account.id)) return renderReady();

    setStatus("", "Ready");
    show("start");
    const note = $("#startNotice");
    note.hidden = !(scan && scan.status === "error" && scan.error);
    if (!note.hidden) note.textContent = scan.error;
  }

  function renderScanning() {
    const sc = S.scan;
    setStatus("scan", "Scanning");
    show("scanning");
    $("#scanCount").textContent = U.fmt(sc.phase === "followers" ? sc.followersRead || 0 : sc.fetched || 0);
    $("#scanMsg").textContent = sc.message || "Reading your following list...";
    const bar = $("#scanBar");
    if (sc.expected && sc.phase !== "followers") {
      bar.classList.remove("is-indeterminate");
      bar.firstElementChild.style.width = Math.min(98, Math.max(3, (sc.fetched || 0) / sc.expected * 100)) + "%";
    } else {
      bar.classList.add("is-indeterminate");
    }
  }

  function renderReady() {
    const sc = S.scan;
    setStatus("", "Ready");
    show("ready");
    U.countTo($("#stFollowing"), sc.total, U.compact);
    U.countTo($("#stNon"), sc.nonFollowers, U.compact);
    U.countTo($("#stMutual"), sc.mutuals, U.compact);

    const n = S.actionable || 0;
    const runNon = $("#runNonBtn");
    $("#runNonLabel").textContent = n ? `Unfollow ${U.fmt(n)} non-follower${n === 1 ? "" : "s"}` : "No non-followers to unfollow";
    runNon.disabled = !n || !!sc.relationshipUnknown;
    $("#runAllBtn").disabled = !S.actionableAll;

    const note = $("#readyNotice");
    note.className = "notice";
    if (sc.relationshipUnknown) {
      note.hidden = false;
      note.classList.add("is-error");
      note.textContent = "X didn't say who follows you back this time, so non-followers can't be picked safely. Rescan in a few minutes.";
    } else if (sc.partial) {
      note.hidden = false;
      note.textContent = (sc.error || "The scan stopped early.") + " Results cover " + U.fmt(sc.total) + " accounts.";
    } else if (sc.nonFollowers > 0 && !n) {
      note.hidden = false;
      note.classList.add("is-info");
      note.textContent = "Everyone who doesn't follow back is already unfollowed or protected by your whitelist / Keep rules.";
    } else {
      note.hidden = true;
    }
    $("#scanAge").textContent = "Scanned " + U.ago(sc.finishedAt) + (sc.method === "dom" ? " (page mode)" : "");
  }

  function renderRun() {
    const j = S.job;
    const pct = j.total ? Math.round(((j.done + j.skipped + j.failed) / j.total) * 100) : 0;
    const left = Math.max(0, j.total - j.index);
    show("run");

    const states = {
      running: ["run", "Running"], resting: ["rest", "Resting"], paused: ["", "Paused"], halted: ["halt", "Needs you"]
    };
    const [kind, label] = states[j.status] || ["", j.status];
    setStatus(kind, label);

    U.countTo($("#runDone"), j.done);
    $("#runTotal").textContent = "/ " + U.fmt(j.total);
    $("#runPct").textContent = pct + "%";
    const bar = $("#runBar");
    bar.className = "bar" + (j.status === "running" ? " is-live" : j.status === "resting" ? " is-rest" : "");
    bar.firstElementChild.style.width = Math.max(2, pct) + "%";

    $("#runSkipped").textContent = U.fmt(j.skipped + j.failed);
    $("#runLeft").textContent = U.fmt(left);
    $("#runEta").textContent = left ? estimate(left).replace(/^~/, "").split(" today")[0] : "-";

    const t = j.current;
    const av = $("#nowAvatar");
    const fresh = U.avatar(t && t.a, t && (t.n || t.h), 38);
    av.replaceWith(fresh);
    fresh.id = "nowAvatar";
    $("#nowHandle").textContent = t ? (t.n ? t.n + "  @" + t.h : "@" + t.h) : "-";
    $("#nowLabel").textContent = j.status === "running" ? (j.inFlight ? "Unfollowing" : "Next up") : "Up next";

    const msg = $("#runMsg");
    msg.textContent = j.message || "";
    msg.className = "run-msg" + (j.status === "halted" ? " is-error" : j.status === "resting" ? " is-warn" : "");

    // The background hint is least useful while a longer status message shows.
    $(".hint-line").hidden = !(j.status === "running" || j.status === "paused");
    $("#pauseBtn").hidden = !(j.status === "running" || j.status === "resting");
    $("#resumeBtn").hidden = !(j.status === "paused" || j.status === "halted");
    tickTimer();
  }

  function renderDone() {
    const j = S.job;
    setStatus("done", j.status === "done" ? "Finished" : "Stopped");
    show("done");
    $("#doneTitle").textContent = j.status === "done" ? "All done" : "Stopped";
    $("#doneMsg").textContent = j.message || "";
    $("#doneUn").textContent = U.fmt(j.done);
    $("#doneSkip").textContent = U.fmt(j.skipped + j.failed);
    $("#doneTime").textContent = j.finishedAt ? U.dur((j.finishedAt - j.startedAt) / 1000) : "-";
  }

  // live countdown for the run view
  function tickTimer() {
    if (!S || !S.job) return;
    const j = S.job;
    let target = null, label = "next in";
    if (j.status === "resting") { target = j.restUntil; label = j.restReason === "daily" ? "daily limit" : "break"; }
    else if (j.status === "running") { target = j.inFlight ? null : j.nextAt; }
    const el = $("#nowTimer");
    if (j.status === "running" && j.inFlight) { el.innerHTML = '<span class="spinner"></span>'; $("#nowTimerLabel").textContent = "working"; return; }
    if (!target || j.status === "paused" || j.status === "halted") { el.textContent = "-"; $("#nowTimerLabel").textContent = j.status === "paused" ? "paused" : ""; return; }
    const secs = Math.max(0, Math.round((target - Date.now()) / 1000));
    el.textContent = secs >= 3600 ? U.clock(target) : secs >= 60 ? Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0") : secs + "s";
    $("#nowTimerLabel").textContent = label;
  }
  setInterval(() => { if (S && S.job && $('[data-view="run"]').classList.contains("is-on")) tickTimer(); }, 500);

  // ------------------------------------------------------------------ sheet
  function openSheet(opts) {
    pending = opts;
    $("#sheetTitle").textContent = opts.title;
    $("#sheetBody").textContent = opts.body;
    const facts = $("#sheetFacts");
    facts.innerHTML = "";
    for (const [k, v] of opts.facts) {
      const row = document.createElement("div");
      row.innerHTML = `<span>${U.esc(k)}</span><b>${U.esc(v)}</b>`;
      facts.appendChild(row);
    }
    $("#sheetOk").querySelector("span").textContent = opts.ok || "Start";
    $("#sheet").hidden = false;
    setTimeout(() => $("#sheetOk").focus(), 50);
  }
  function closeSheet() { $("#sheet").hidden = true; pending = null; }

  function confirmRun(source) {
    const stale = scanIsStale();
    const n = source === "all" ? S.actionableAll : S.actionable;
    const s = S.settings;
    const facts = [
      ["Pace", settingsLine()],
      ["Daily limit", s.dailyLimit ? `${s.dailyLimit} (${S.today} used)` : "Off"],
      ["Estimated time", estimate(n)]
    ];
    if (stale) facts.unshift(["Scan", "Older than " + s.scanMaxAgeHours + "h - refreshed first"]);
    openSheet({
      title: source === "all"
        ? `Unfollow everyone (${U.fmt(n)})?`
        : `Unfollow ${U.fmt(n)} non-follower${n === 1 ? "" : "s"}?`,
      body: source === "all"
        ? "This includes people who follow you back. Your whitelist and Keep rules still apply."
        : "Only accounts that don't follow you back. Your whitelist and Keep rules always apply.",
      facts,
      ok: stale ? "Scan & start" : "Start",
      run: async () => {
        const r = stale
          ? await U.cmd("scan", { then: { source } })
          : await U.cmd("run", { source });
        if (!r.ok) U.toast(r.error || "Couldn't start.", "err", 5000);
        refresh();
      }
    });
  }

  // ------------------------------------------------------------------ actions
  async function startScan() {
    const btn = $("#scanBtn");
    btn.disabled = true;
    const r = await U.cmd("scan");
    btn.disabled = false;
    if (!r.ok) {
      U.toast(r.error || "Couldn't start the scan.", "err", 5000);
      if (r.needLogin) { S.account = { signedOut: true }; render(); }
    }
    refresh();
  }

  function openDash(hash) {
    U.cmd("dashboard", { hash });
    window.close();
  }

  function wire() {
    U.icons();
    U.themeButtons();
    $("#scanBtn").addEventListener("click", startScan);
    $("#rescanBtn").addEventListener("click", startScan);
    $("#scanStopBtn").addEventListener("click", () => U.cmd("scanStop").then(refresh));
    $("#runNonBtn").addEventListener("click", () => confirmRun("nonfollowers"));
    $("#runAllBtn").addEventListener("click", () => confirmRun("all"));
    $("#reviewBtn").addEventListener("click", () => openDash("following"));
    $("#pauseBtn").addEventListener("click", () => U.cmd("pause").then(refresh));
    $("#resumeBtn").addEventListener("click", () => U.cmd("resume").then(refresh));
    $("#stopBtn").addEventListener("click", () => U.cmd("stop").then(refresh));
    $("#doneOkBtn").addEventListener("click", () => U.cmd("clearJob").then(refresh));
    $("#donateDoneBtn").addEventListener("click", () => openDash("donate"));
    $("#openXBtn").addEventListener("click", () => { U.cmd("openX"); window.close(); });
    $("#retryBtn").addEventListener("click", async () => {
      const r = await U.cmd("refreshAccount");
      if (!r.ok && r.noTab) U.toast("Open x.com in a tab first.", "err");
      refresh();
    });
    $$("[data-open]").forEach((b) => b.addEventListener("click", () => openDash(b.dataset.open)));
    $("#sheetCancel").addEventListener("click", closeSheet);
    $("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
    $("#sheetOk").addEventListener("click", async () => {
      const p = pending;
      closeSheet();
      if (p && p.run) await p.run();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#sheet").hidden) { e.preventDefault(); closeSheet(); } });
  }

  // ------------------------------------------------------------------ data
  let refreshing = null;
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const r = await U.cmd("state");
      if (r && r.ok) { S = r; render(); }
      else if (!S) { setStatus("halt", "Error"); show("start"); }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  let debounce = null;
  U.watch([K.job, K.scan, K.account, K.settings, K.ledger, K.whitelist], () => {
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 120);
  });

  document.addEventListener("DOMContentLoaded", async () => {
    wire();
    show("loading");
    await refresh();
    // Quietly refresh who is signed in, if an X tab is open.
    U.cmd("refreshAccount").then((r) => { if (r && r.ok) refresh(); });
  });
})();
