// ============================================================
// X Unfollow Manager Pro - background.js (v6.14.0)
//
// Changes vs 5.1.0
//   - The offscreen document and its silent audio loop are gone. A
//     long-lived port from the content script keeps this worker alive,
//     which needs no extra permission and leaves no audio indicator.
//   - Alarms created for a tab are now cancelled when that tab closes.
//     v5 leaked one alarm per pending long wait.
//   - Every chrome.action call is guarded. v5 threw unhandled promise
//     rejections whenever a tab closed mid-session.
//   - Adds the Alt+Shift+S emergency stop.
//   - Adds a HALTED state so a captcha or lockout is visible on the
//     toolbar icon, not just inside the popup.
// ============================================================

// Anonymous usage reporting. Inert until TELEMETRY_ENDPOINT is set in
// telemetry.js, and switchable off by the user in Settings.
try {
  importScripts("telemetry.js");
} catch (err) {
  // Never swallow this. If the module fails to load, telemetry silently
  // does nothing forever and there is no way to tell from the outside.
  console.error("[X Unfollow Console] telemetry.js failed to load:", err);
}

const ACTIVE_TABS = new Set();
const KEEPALIVE_PORTS = new Set();
const pendingShort = new Map();   // "tabId:id" -> {tabId, id, timeoutId}

const SHORT_WAIT_MS = 30000;      // below this, setTimeout in the worker
const COLORS = {
  running:  "#fb3b4b",
  waiting:  "#38bdf8",
  cooldown: "#8b5cf6",
  paused:   "#f59e0b",
  done:     "#10b981",
  halted:   "#dc2626"
};

// ---- safe wrappers --------------------------------------------------------
// The badge is always set globally, never per tab. A run belongs to the
// browser profile as far as the user is concerned, so its counter should be
// visible from whichever tab they happen to be looking at. The tabId
// argument is retained for call-site clarity but intentionally ignored.
function setBadge(_tabId, text, color, title) {
  const opts = {};
  try {
    chrome.action.setBadgeText({ ...opts, text }).catch(() => {});
    if (color) chrome.action.setBadgeBackgroundColor({ ...opts, color }).catch(() => {});
    if (title) chrome.action.setTitle({ ...opts, title }).catch(() => {});
  } catch (_) {}
}

// ---- keepalive ------------------------------------------------------------
// An open port resets the worker's idle timer. The content script pings
// every 20s and recycles the port every 4 minutes.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "xump-keepalive") return;
  KEEPALIVE_PORTS.add(port);
  port.onMessage.addListener(() => { /* the message itself is the heartbeat */ });
  port.onDisconnect.addListener(() => {
    KEEPALIVE_PORTS.delete(port);
    void chrome.runtime.lastError;
  });
});

// ---- wake scheduling ------------------------------------------------------
function scheduleShortWake(tabId, id, ms) {
  const key = `${tabId}:${id}`;
  const prev = pendingShort.get(key);
  if (prev) clearTimeout(prev.timeoutId);
  const timeoutId = setTimeout(() => {
    pendingShort.delete(key);
    chrome.tabs.sendMessage(tabId, { type: "WAKE", id }).catch(() => {});
  }, ms);
  pendingShort.set(key, { tabId, id, timeoutId });
}

function scheduleLongWake(tabId, id, ms) {
  // chrome.alarms clamps to 30s minimum in released builds.
  chrome.alarms.create(`wake:${tabId}:${id}`, { delayInMinutes: Math.max(ms / 60000, 0.5) });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (typeof Telemetry !== "undefined" && alarm.name === Telemetry.HEARTBEAT_ALARM) {
    Telemetry.heartbeat();
    return;
  }
  const m = /^wake:(\d+):(\d+)$/.exec(alarm.name);
  if (!m) return;
  chrome.tabs.sendMessage(Number(m[1]), { type: "WAKE", id: Number(m[2]) }).catch(() => {});
});

async function dropTabPending(tabId) {
  for (const [key, val] of pendingShort.entries()) {
    if (val.tabId === tabId) {
      clearTimeout(val.timeoutId);
      pendingShort.delete(key);
    }
  }
  // v5 never cleared these, so alarms accumulated for every closed tab.
  try {
    const alarms = await chrome.alarms.getAll();
    for (const a of alarms) {
      if (a.name.startsWith(`wake:${tabId}:`)) chrome.alarms.clear(a.name);
    }
  } catch (_) {}
}

// ---- messages -------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  const tabId = sender?.tab?.id;

  // Fetch a text asset the content script cannot reach directly. Used only to
  // read X's own JS bundles from its CDN, which is cross-origin from x.com and
  // therefore blocked by CORS in a content script. Restricted to X's own hosts
  // so this can never be used as a general-purpose proxy.
  if (msg.action === "FETCH_TEXT" && typeof msg.url === "string") {
    const allowed = /^https:\/\/(abs\.twimg\.com|abs-\d+\.twimg\.com|x\.com|twitter\.com)\//;
    if (!allowed.test(msg.url)) {
      sendResponse({ ok: false, error: "blocked host" });
      return true;
    }
    fetch(msg.url, { credentials: "omit" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))))
      .then((text) => sendResponse({ ok: true, text }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;   // keep the channel open for the async response
  }

  // Any activity re-arms reporting. This covers installs that happened
  // before the endpoint was set, which otherwise stay silent forever.
  if (typeof Telemetry !== "undefined") Telemetry.ensureArmed();

  // Live connection test from the settings page.
  if (msg.type === "TELEMETRY_TEST") {
    if (typeof Telemetry === "undefined") {
      sendResponse({ ok: false, reason: "telemetry.js did not load. See the service worker console." });
    } else {
      Telemetry.test().then(sendResponse);
    }
    return true;
  }

  // Opening the popup counts as being active, and proves connectivity.
  if (msg.type === "TELEMETRY_PING") {
    if (typeof Telemetry !== "undefined") Telemetry.heartbeat();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "REQUEST_WAKE" && tabId != null && msg.id != null) {
    const ms = Math.max(0, Number(msg.ms) || 0);
    if (ms < SHORT_WAIT_MS) scheduleShortWake(tabId, msg.id, ms);
    else scheduleLongWake(tabId, msg.id, ms);
    sendResponse({ scheduled: true });
    return true;
  }

  if (tabId == null) return;

  if (msg.type === "PROGRESS") {
    ACTIVE_TABS.add(tabId);
    const n = Number(msg.count || 0);
    const text = (msg.message || "").toLowerCase();

    let color = COLORS.running, label = "Running";
    if (text.includes("paused"))                       { color = COLORS.paused;   label = "Paused"; }
    else if (text.includes("cooldown") || text.includes("rest")) { color = COLORS.cooldown; label = "Cooldown"; }
    else if (text.includes("waiting") || text.includes("scrolling") || text.includes("loading")) {
      color = COLORS.waiting; label = "Waiting";
    }
    setBadge(tabId, n > 0 ? String(n) : "0", color, `X Unfollow Manager Pro - ${label}`);
  }

  if (msg.type === "HALTED") {
    ACTIVE_TABS.delete(tabId);
    dropTabPending(tabId);
    if (typeof Telemetry !== "undefined") {
      Telemetry.session({
        count: msg.count, attempted: msg.attempted, mode: msg.mode,
        elapsedSeconds: msg.elapsedSeconds, haltKind: msg.haltKind
      });
    }
    setBadge(tabId, "!", COLORS.halted,
      `X Unfollow Manager Pro - stopped: ${msg.haltKind || "challenge"}`);
  }

  if (msg.type === "STOPPED") {
    ACTIVE_TABS.delete(tabId);
    dropTabPending(tabId);
    if (typeof Telemetry !== "undefined" && Number(msg.attempted) > 0) {
      Telemetry.session({
        count: msg.count, attempted: msg.attempted, mode: msg.mode,
        elapsedSeconds: msg.elapsedSeconds, haltKind: null
      });
    }
    setBadge(tabId, "\u2713", COLORS.done, "X Unfollow Manager Pro - Stopped");
    setTimeout(() => setBadge(tabId, "", null, "X Unfollow Manager Pro"), 8000);
  }
});

// ---- emergency stop hotkey ------------------------------------------------
chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== "emergency-stop") return;
  try {
    const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
    for (const t of tabs) {
      if (t.id != null) chrome.tabs.sendMessage(t.id, { action: "STOP" }).catch(() => {});
    }
  } catch (_) {}
});

// ---- lifecycle ------------------------------------------------------------
chrome.runtime.onInstalled.addListener((details) => {
  setBadge(null, "");
  const reason = details?.reason;
  if (reason === "update" || reason === "install") {
    // Clear any stale safety lock left over from a previous version.
    chrome.storage.local.remove(["haltUntil", "haltKind"]).catch(() => {});

    // Migrate budget caps that were left at the OLD defaults. These are the
    // exact values that made a run stall around 25-30 unfollows: the 15-min
    // window cap of 25, the 40-action session cap, and the 120-min wall
    // clock. We only rewrite a value that still equals its old default, so a
    // user who deliberately chose their own number is never overridden.
    chrome.storage.sync.get({ windowLimit: null, maxActions: null, maxSessionMinutes: null, dailyLimit: null })
      .then((s) => {
        const patch = {};
        if (s.windowLimit === 25) patch.windowLimit = 48;
        if (s.maxActions === 40) patch.maxActions = 100;
        if (s.maxSessionMinutes === 120) patch.maxSessionMinutes = 240;
        // The daily/window/session caps are now the user's to set, with 0
        // meaning no limit. Anyone still sitting on the old built-in numbers
        // is moved to unlimited; a number they chose themselves is left be.
        if (s.dailyLimit === 100 || s.dailyLimit === 400) patch.dailyLimit = 0;
        if (s.windowLimit === 48) patch.windowLimit = 0;
        if (s.maxActions === 100) patch.maxActions = 0;
        if (Object.keys(patch).length) return chrome.storage.sync.set(patch);
      })
      .catch(() => {});

    // Seed the continuous-mode settings for anyone updating from a build that
    // predates them, so the stored config matches the new defaults rather than
    // leaving them undefined.
    chrome.storage.sync.get({ infiniteMode: null, idleRescanMinutes: null })
      .then((s) => {
        const patch = {};
        // Seed as OFF. Continuous mode reloads the page mid-run, which
        // should be something you switch on deliberately, not something an
        // update turns on for you.
        if (s.infiniteMode === null || s.infiniteMode === undefined) patch.infiniteMode = false;
        if (!s.idleRescanMinutes) patch.idleRescanMinutes = 5;
        if (Object.keys(patch).length) return chrome.storage.sync.set(patch);
      })
      .catch(() => {});
  }


    // One-time: existing installs were seeded with continuous mode ON by a
    // previous version, so a changed default alone would never reach them.
    // They are the installs actually experiencing the page refreshing itself,
    // so switch it off once and record that we did. Anyone who turns it back
    // on afterwards keeps their choice, because this never runs again.
    chrome.storage.local.get({ continuousDefaultReset: false }).then((f) => {
      if (f.continuousDefaultReset) return;
      return chrome.storage.sync.set({ infiniteMode: false })
        .then(() => chrome.storage.local.set({ continuousDefaultReset: true }));
    }).catch(() => {});

  // Show the handbook on first install only - never on an update, which would
  // pop an unrequested tab every time the extension refreshes itself.
  if (reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("tutorial.html") }).catch(() => {});
  }

  if (typeof Telemetry !== "undefined") Telemetry.onInstalled(details);
});

// Make the side panel available on X tabs. Wrapped because the sidePanel API
// only exists in Chrome 114+, and the extension must still load without it.
try {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false })
    .catch(() => {});
} catch (_) {}

// Re-arm the heartbeat and uninstall hook whenever the worker wakes.
chrome.runtime.onStartup?.addListener(() => {
  if (typeof Telemetry !== "undefined") Telemetry.onStartup();
});

// Arm as soon as the worker boots for any reason at all.
if (typeof Telemetry !== "undefined") Telemetry.ensureArmed();

// Drain any pings that failed while the machine was offline.
chrome.runtime.onConnect.addListener(() => {
  if (typeof Telemetry !== "undefined") Telemetry.flush();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ACTIVE_TABS.delete(tabId);
  dropTabPending(tabId);
});

// ------------------------------------------------------------
// SESSION WATCHDOG
//
// The unfollow engine lives in the x.com page. That makes it vulnerable to
// something no amount of in-page code can prevent: Chrome discarding or
// freezing a backgrounded tab to reclaim memory. When that happens the page
// is torn down, the loop stops, and the console reports "Standing by" the
// next time it is opened - which is what a run looks like after the browser
// has been minimised for a while.
//
// The page cannot revive itself once it is gone, so liveness is owned here
// instead. Every minute this checks whether a session claims to be running
// and whether its heartbeat is still fresh. A stale heartbeat means the page
// stopped without stopping the session, so the tab is reloaded - and the
// content script's existing auto-resume picks the run straight back up.
// ------------------------------------------------------------
const WATCHDOG_ALARM = "xump:watchdog";
const STALE_AFTER_MS = 150000;   // ~2.5 min without a heartbeat = page is gone

chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });

async function reviveIfStalled() {
  let store;
  try {
    store = await chrome.storage.local.get(["activeSession", "listRun"]);
  } catch (_) { return; }

  const session = store.activeSession;
  const listRun = store.listRun;

  // Which run, if any, claims to be live right now?
  const claim = (session && session.heartbeatTs)
    ? { kind: "session", ts: session.heartbeatTs, path: session.sessionPath }
    : (listRun && listRun.active && !listRun.paused && listRun.heartbeatTs)
      ? { kind: "list", ts: listRun.heartbeatTs, path: null }
      : null;
  if (!claim) return;

  if (Date.now() - claim.ts < STALE_AFTER_MS) return;   // still beating

  // Do not fight a safety lock: if the extension deliberately halted, the
  // run is meant to be stopped and reviving it would defeat the point.
  try {
    const { haltUntil } = await chrome.storage.local.get("haltUntil");
    if (haltUntil && Date.now() < haltUntil) return;
  } catch (_) {}

  try {
    const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
    if (!tabs.length) return;                 // nothing to revive into

    // Prefer a discarded tab; otherwise take the first X tab we have.
    const target = tabs.find(t => t.discarded) || tabs[0];
    console.warn("[X Unfollow Manager] watchdog: run went quiet, reloading tab", target.id);
    await chrome.tabs.reload(target.id, { bypassCache: false });
  } catch (e) {
    console.warn("[X Unfollow Manager] watchdog could not revive:", e);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === WATCHDOG_ALARM) reviveIfStalled();
});
