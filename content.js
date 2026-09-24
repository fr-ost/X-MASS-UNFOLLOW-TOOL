// ============================================================
// X Unfollow Manager Pro - content.js (v6.14.0)
//
// WHAT CHANGED vs 5.1.0 (see CHANGELOG.md for the full list)
//
//   1. INFINITE SCROLL FIXED. v5 had an explicit "reset the counter and
//      keep going rather than terminating" branch, so on any page where
//      the button selector never matched it scrolled forever. Sessions
//      now have four independent stop conditions and a hard wall clock.
//   2. PAGE GUARD. v5 would happily run on the home timeline. It now
//      refuses to start anywhere except a real follow list.
//   3. WRONG-ROW UNFOLLOW FIXED. v5 searched the whole document for a
//      button reading "Unfollow" to confirm with. Hovering any other row
//      turns its label into "Unfollow", so it could confirm against a
//      different account. Confirmation is now scoped to the dialog.
//   4. CHALLENGE DETECTION. Captcha, account lockout, logged-out and
//      rate-limit states now halt the session instead of hammering
//      through them. The extension never tries to solve a challenge -
//      it hands the tab back to you, because continuing to click during
//      a challenge is exactly what escalates a soft limit into a lock.
//   5. VERIFIED ACTIONS. v5 incremented the counter on click. It now
//      confirms the row actually flipped to "Follow" before counting.
//   6. QUOTA LEDGER. Rolling 24h and 15min budgets that survive reloads.
//   7. SELECTORS. Now testid-first, so it works in every X UI language.
// ============================================================

(() => {
"use strict";

if (window.__xumpLoaded) return;
window.__xumpLoaded = true;

// ------------------------------------------------------------
// Selectors - single source of truth. If X changes its DOM,
// this is the only block that should need editing.
// ------------------------------------------------------------
const SEL = {
  unfollowBtn:  '[data-testid$="-unfollow"]',
  followBtn:    '[data-testid$="-follow"]',
  userCell:     '[data-testid="UserCell"]',
  cellInner:    '[data-testid="cellInnerDiv"]',
  followsYou:   '[data-testid="userFollowIndicator"]',
  confirmDlg:   '[data-testid="confirmationSheetDialog"]',
  confirmBtn:   '[data-testid="confirmationSheetConfirm"]',
  cancelBtn:    '[data-testid="confirmationSheetCancel"]',
  primaryCol:   '[data-testid="primaryColumn"]',
  spinner:      '[role="progressbar"]',
  toast:        '[data-testid="toast"]',
  emptyState:   '[data-testid="empty_state_header_text"]',
  // Verification badge. X ships the blue/gold/gray checkmark as an inline
  // SVG. The testid is the primary hook; the others are structural so that
  // detection does not depend on the badge's aria-label, which is localized
  // (on a Bengali or Spanish UI it is NOT the string "Verified").
  verified:     '[data-testid="icon-verified"]',
  switcher:     '[data-testid="SideNav_AccountSwitcher_Button"]',
  profileLink:  '[data-testid="AppTabBar_Profile_Link"]',
  retryBtn:     '[data-testid="retry"]'
};

// Pages the session is allowed to run on. Anything else is refused,
// which is the single biggest fix for the runaway-scroll reports.
const LIST_PAGES = [
  /^\/[A-Za-z0-9_]{1,15}\/following\/?$/i,
  /^\/[A-Za-z0-9_]{1,15}\/followers\/?$/i,
  /^\/[A-Za-z0-9_]{1,15}\/verified_followers\/?$/i,
  /^\/[A-Za-z0-9_]{1,15}\/followers_you_follow\/?$/i,
  /^\/[A-Za-z0-9_]{1,15}\/creator-subscriptions\/subscriptions\/?$/i,
  /^\/i\/lists\/\d+\/members\/?$/i,
  /^\/i\/lists\/\d+\/subscribers\/?$/i
];

const DEFAULTS = {
  // pacing
  minDelay: 22, maxDelay: 55, scrollWait: 3,
  // budgets
  //   maxActions is the per-session cap. It defaulted to 40, which quietly
  //   ended a run long before the daily limit. It now equals dailyLimit so a
  //   single session can spend the whole day's budget - which is what
  //   "run until the daily limit hits" means.
  //   windowLimit is the 15-minute cap. At 25 it was the real reason a run
  //   appeared to "stop after 25-30": once 25 actions landed inside a 15-min
  //   window the loop dropped into a rate-rest and then trickled one action
  //   per freed slot, which looks stalled. It is raised so natural pacing
  //   (delays + the 6-min cooldown) is the governor instead, never this cap.
  // Set any of these to 0 for no cap. They are yours to choose: 0 means the
  // run is governed by your pacing and by X's own signals, not by a number
  // here. Warnings still fire at the volumes that historically draw
  // attention, but they warn - they do not stop the run.
  maxActions: 0, dailyLimit: 0, windowLimit: 0,
  cooldownAfter: 12, cooldownMinutes: 6,
  //   A full 100-action run with cooldowns is ~2 hours, so the old 120-minute
  //   wall clock could cut it off before the daily limit. Raised to 240.
  maxSessionMinutes: 240,
  // filters
  skipVerified: false, skipProtected: false, skipFollowsMe: false,
  keywordProtection: false, protectedKeywords: "project, team, partner",
  whitelistHandles: "",
  // Moni low-score cleanup
  moniMinScore: 100,             // unfollow accounts scoring below this
  // Moni now shows its score inline beside the handle, so hovering each row
  // is no longer needed - and hovering was what made a run look like it was
  // "just scrolling around". Off by default; a row with no inline score is
  // simply skipped, which is the safe outcome.
  moniHoverProbe: false,
  runInBackground: true,         // keep working while the tab is in the background
  whitelistProtectVerified: true,// still keep verified accounts in Moni mode
  // behaviour
  reloadOnStop: false, soundEnabled: true,
  humanPacing: true, allowAnyPage: false, stopOnChallenge: true,
  // Infinite mode: never end a run on its own. No session cap, no wall clock,
  // no "end of list" stop - when the list runs dry it reloads and keeps
  // sweeping until YOU press Stop. Safety halts (verification prompts,
  // repeated failures) still stop it: those protect the account, and
  // overriding them is how an account gets locked rather than rate-limited.
  scanLimit: 0,                    // 0 = no cap on a scan
  // Continuous mode now defaults OFF.
  //
  // It exists to get past X's pagination ceiling: when X stops serving more
  // of your list, the only way to see the rest is to reload the page. That
  // is a real capability and it stays available - but as a default it meant
  // the page refreshed itself during normal use, which is disorienting and
  // was the single most-reported problem with this extension.
  //
  // Off, a run walks the list until it is genuinely exhausted and then stops
  // and tells you so. Nothing reloads underneath you. Turn it on in Settings
  // if you want the run to keep reloading and sweeping until you stop it.
  infiniteMode: false,
  idleRescanMinutes: 5             // how long to wait before re-sweeping an exhausted list
};

// Moni score loading grace: the Moni extension injects scores a moment after
// X renders each row, so we wait and re-check before deciding it is absent.
const MONI_GRACE_MS       = 9000;  // total time to wait for scores to appear
const MONI_POLL_MS        = 750;   // how often to re-check during the grace

const HALT_LOCK_MINUTES   = 45;  // refuse to restart this long after a hard challenge
const STALL_PROBES        = 8;   // empty probes at list end before we call it finished
const PROBE_MS            = 2200;// gap between end-of-list probes
// Volumes at which X has historically started limiting accounts. Crossing
// one produces a warning in the console and a beep, never a stop.
const WARN_DAY_LEVELS     = [400, 700, 1000, 1500];
const SOFT_FAIL_LIMIT     = 6;   // consecutive silent failures before circuit break
// How many vigorous load attempts must each surface ZERO new accounts before
// we accept the list has truly ended. End-of-list is judged on new unique
// user IDs, not page height, because X virtualizes rows (height goes flat
// while more accounts still exist).
//
// Raised from 14 to 22: on an account with a high mutual-to-non-follower
// ratio, the currently-rendered batch of rows is mostly skips and clears
// fast, so 14 was being reached by ordinary batch turnover - not genuine
// list exhaustion - which produced reload-to-top cycling roughly every 90
// seconds. See AGGRESSIVE_AFTER and the reload-wait fix in
// endOfLoadableList for the rest of that story.
const END_CONFIRM         = 22;
// Failed gentle attempts before resorting to the violent full-height jump.
// Raised from 2: at 2, most of a probing cycle was spent doing the
// disruptive bottom-jump-jiggle-bottom motion, which is exactly what "not
// scrolling properly" describes. Most stalls resolve with plain scrolling
// once X genuinely has more to render; the violent jump is now a last
// resort in the final stretch, not the default response to one bad probe.
const AGGRESSIVE_AFTER    = 16;
// Scrolls in a row that yield no actionable row before we give up. This is
// deliberately independent of document height: an endless feed keeps growing,
// so height-based end detection alone can never terminate on one.
const MAX_BARREN_SCROLLS  = 60;
// X paginates a following list only so deep per page-load - after ~100-200
// entries it stops serving more, especially while you are unfollowing. The
// reliable way past that ceiling is to reload the list (removed accounts are
// gone, so the next batch shifts into the servable window) and continue. This
// caps how many such reload cycles a single run will do as a safety backstop;
// the real terminator is "a whole cycle unfollowed nobody" -> genuinely done.
const MAX_RELOAD_CYCLES   = 60;
const RELOAD_KEY          = "xumpReload";

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
let running = false;
let paused = false;
let count = 0;
let attempted = 0;
let mode = "Idle";
let startedAt = null;
let currentTimer = null;
let nonFollowersOnly = true;
let dryRun = false;
let moniMode = false;        // Moni low-score cleanup mode active
let moniThreshold = 0;       // unfollow accounts with score below this
let softFails = 0;
let haltReason = null;
let sessionPath = "";
let stopIssued = false;
let keepPort = null;
let keepTimer = null;
let reloadCycles = 0;        // reload-continue cycles in the current run

// Concurrency control.
//   runEpoch increments on every start AND every stop. A loop captures its
//   epoch at launch and, at every await boundary, checks that it is still
//   the current one. The instant Stop (or a second Start) bumps the epoch,
//   the old loop sees the mismatch and exits, so two loops can never run at
//   once and a stopped loop can never linger into the next session.
//   loopActive is a hard interlock: start() refuses to launch a new loop
//   while any previous loop body has not yet returned.
let runEpoch = 0;
let loopActive = false;

// Progress tracking for the stall watchdog.
//   lastProgressAt     when the run last did something real
//   plannedWaitCredit  time deliberately spent waiting, which is not a stall
let lastProgressAt = Date.now();
let plannedWaitCredit = 0;

function noteProgress() {
  lastProgressAt = Date.now();
  plannedWaitCredit = 0;
}

// Deliberate waiting is not stalling. Cooldowns, pacing gaps and rate rests
// all pass through here so the watchdog does not count them against the run.
function creditPlannedWait(ms) {
  plannedWaitCredit += Math.max(0, ms);
}

const processed = new Set();               // userIds acted on or skipped
const skipStats = Object.create(null);     // reason -> count
const preview = [];                        // dry-run results

// ------------------------------------------------------------
// Background-safe sleep. setTimeout in a hidden tab gets clamped to
// roughly once a minute, so anything >= 250ms is scheduled by the
// service worker and delivered back as a message, which is not throttled.
// ------------------------------------------------------------
// ------------------------------------------------------------
// Timing that survives background-tab throttling.
//
// THE BUG THIS FIXES: when the X tab is not focused, Chrome clamps the
// page's setTimeout to about once a second, and requestAnimationFrame
// (which "smooth" scrolling relies on) barely runs. In v6.0 the loop
// then crawled or stalled, and because X also stops rendering new list
// rows in a hidden tab, the scroll logic could churn without making
// progress - the "switches tab and it scrolls forever" report.
//
// Web Workers are NOT throttled in background tabs, so we run every wait
// of 250ms+ inside a dedicated timer worker and get woken by postMessage.
// If the worker cannot be created (rare CSP edge cases), we fall back to
// the service worker, and finally to a plain page timer.
// ------------------------------------------------------------
const pendingWakes = new Map();
let wakeIdSeq = 1;
let timerWorker = null;
let workerBroken = false;

function initTimerWorker() {
  if (timerWorker || workerBroken) return;
  try {
    const url = chrome.runtime.getURL("worker.js");
    timerWorker = new Worker(url);
    timerWorker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "fire") {
        const fn = pendingWakes.get(m.id);
        if (fn) { pendingWakes.delete(m.id); fn(); }
      }
    };
    timerWorker.onerror = () => { workerBroken = true; timerWorker = null; };
  } catch (_) {
    workerBroken = true;
  }
}

function sleep(ms) {
  ms = Math.max(0, Math.floor(ms));
  if (ms <= 0) return Promise.resolve();

  const epochAtCall = runEpoch;

  return new Promise(resolve => {
    const id = wakeIdSeq++;
    let done = false;
    let guard = null;

    const finish = () => {
      if (done) return;
      done = true;
      pendingWakes.delete(id);
      if (guard) { clearTimeout(guard); guard = null; }
      try { timerWorker?.postMessage({ type: "clear", id }); } catch (_) {}
      resolve();
    };

    // If the run was stopped/superseded while we were queued, resolve now
    // so the awaiting loop can reach its next epoch check and exit at once.
    const finishIfStale = () => {
      if (runEpoch !== epochAtCall) { finish(); return true; }
      return false;
    };

    pendingWakes.set(id, () => { if (!finishIfStale()) finish(); });

    // Primary: the timer worker (throttling-proof).
    initTimerWorker();
    if (timerWorker && !workerBroken) {
      try {
        timerWorker.postMessage({ type: "set", id, ms });
        scheduleSwBackstop(id, ms + 20000);
        return;
      } catch (_) {
        workerBroken = true;
      }
    }

    // Fallback: service-worker wake (also not page-throttled).
    try {
      chrome.runtime.sendMessage({ type: "REQUEST_WAKE", id, ms }).catch(() => {
        guard = setTimeout(finish, ms);
      });
      guard = setTimeout(finish, ms + 20000);
    } catch (_) {
      guard = setTimeout(finish, ms);
    }
  });
}

// Resolve every pending wait immediately. Called by stop() so an in-flight
// sleep does not hold the old loop alive for its full duration - the loop
// wakes, sees the epoch has moved, and returns on the spot.
function abortAllWaits() {
  const fns = [...pendingWakes.values()];
  pendingWakes.clear();
  try { timerWorker?.postMessage({ type: "clearAll" }); } catch (_) {}
  for (const fn of fns) { try { fn(); } catch (_) {} }
}

// Ask the service worker to ping this tab after `ms` as a safety net for a
// worker timer that somehow never fires. Reuses the existing WAKE plumbing.
function scheduleSwBackstop(id, ms) {
  try {
    chrome.runtime.sendMessage({ type: "REQUEST_WAKE", id, ms }).catch(() => {});
  } catch (_) {}
}

// ------------------------------------------------------------
// Visibility gate.
//
// Even with worker-driven timing, actually unfollowing in a hidden tab is
// unreliable: X pauses its virtual-list rendering and lazy-load fetches
// when document.hidden is true, so new rows never appear and clicks can
// land on stale nodes. Rather than fight that, we PAUSE the action loop
// while the tab is hidden and resume the instant it is visible again.
// Timing keeps running; only the DOM work waits. This is what stops the
// runaway scrolling: the loop never scrolls a tab that X is not rendering.
// ------------------------------------------------------------
function pageHidden() {
  return document.visibilityState === "hidden" || document.hidden === true;
}

async function waitForVisible() {
  if (!pageHidden()) return;
  const epochAtStart = runEpoch;
  const stillCurrent = () => running && runEpoch === epochAtStart && !haltReason;
  notify("Paused - tab in background. Bring this tab forward to continue.");
  while (stillCurrent() && pageHidden()) {
    await sleep(1000);
  }
  if (stillCurrent()) {
    // Let X re-render its list before we resume touching it.
    notify("Tab active again. Resuming shortly...");
    await sleep(1200);
  }
}

// Interruptible sleep: returns early if the session stops or halts.
//
// Every millisecond spent here is a deliberate wait (backoff after a failed
// action, end-of-list probes, pause polling), so it is credited to the stall
// watchdog exactly like countdown() is. Before, idle() waits were NOT
// credited, so a slow patch - e.g. X being sluggish to load more rows right
// after a 6-minute cooldown - could accumulate as "no progress" and end an
// otherwise healthy run. Crediting all deliberate waits means the watchdog
// now only ever fires on genuine spinning, never on time we chose to wait.
async function idle(ms) {
  const epochAtStart = runEpoch;
  const startedAtMs = Date.now();
  const step = Math.min(ms, 1000);
  let left = ms;
  while (left > 0 && running && runEpoch === epochAtStart && !haltReason) {
    await sleep(Math.min(step, left));
    left -= step;
  }
  creditPlannedWait(Date.now() - startedAtMs);
}

// ------------------------------------------------------------
// Messaging
// ------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "WAKE" && msg.id != null) {
    const fn = pendingWakes.get(msg.id);
    if (fn) { pendingWakes.delete(msg.id); fn(); }
    return;
  }

  switch (msg.action) {
    case "LIST_IMPORT_CSV":
      (async () => {
        const LR = window.__XUMP_LIST;
        const { handles, skipped } = LR.handlesFromCsv(msg.text || "");
        if (!handles.length) throw new Error("No handles found in that file.");
        const fresh = await filterAlreadyUnfollowed(handles);
        if (!fresh.length) {
          throw new Error(`All ${handles.length} accounts were already unfollowed.`);
        }
        const n = await LR.create(fresh, msg.source || "csv");
        return { ok: true, count: n, skipped, alreadyDone: handles.length - fresh.length };
      })().then(r => sendResponse(r))
          .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    case "LIST_FROM_SCAN":
      (async () => {
        const { lastScan } = await chrome.storage.local.get("lastScan");
        const rows = lastScan?.nonFollowers || [];
        if (!rows.length) throw new Error("No scan results yet. Run a scan first.");
        const all = rows.map(u => u.handle).filter(Boolean);
        const fresh = await filterAlreadyUnfollowed(all);
        if (!fresh.length) throw new Error("Everyone in that scan has already been unfollowed.");
        const n = await window.__XUMP_LIST.create(fresh, "scan");
        return { ok: true, count: n, skipped: 0, alreadyDone: all.length - fresh.length };
      })().then(r => sendResponse(r))
          .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    case "LIST_START":
      (async () => {
        await window.__XUMP_LIST.start();
        stepListRun();
        return { ok: true };
      })().then(r => sendResponse(r))
          .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    case "LIST_PAUSE":
      window.__XUMP_LIST.pause().then(() => sendResponse({ ok: true }));
      return true;
    case "LIST_RESUME":
      window.__XUMP_LIST.resumeRun().then(() => { stepListRun(); sendResponse({ ok: true }); });
      return true;
    case "LIST_STOP":
      window.__XUMP_LIST.stop().then(() => sendResponse({ ok: true }));
      return true;
    case "LIST_CLEAR":
      window.__XUMP_LIST.clear().then(() => sendResponse({ ok: true }));
      return true;
    case "LIST_STATUS":
      window.__XUMP_LIST.summary().then(s => sendResponse({ ok: true, list: s }));
      return true;
    case "GET_PROFILE":
      sendResponse({ profile: getLoggedInProfile(), context: pageContext() });
      return true;
    case "SCAN_NON_FOLLOWERS":
      runScan().then(r => sendResponse(r)).catch(e =>
        sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    case "STOP_SCAN":
      scanStop = true;
      sendResponse({ ok: true });
      return true;
    case "GET_SCAN":
      chrome.storage.local.get("lastScan")
        .then(r => sendResponse({ ok: true, scan: r.lastScan || null }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    case "GET_STATE":
      getBudget().then(b => sendResponse(state(running ? "Running" : "Idle", running, b)));
      return true;
    case "START_NON_FOLLOWERS":
      start(true, false).then(r => sendResponse(r));
      return true;
    case "START_ALL":
      start(false, false).then(r => sendResponse(r));
      return true;
    case "START_MONI":
      startMoni(false).then(r => sendResponse(r));
      return true;
    case "START_MONI_DRY_RUN":
      startMoni(true).then(r => sendResponse(r));
      return true;
    case "MONI_DUMP":
      (async () => {
        const rows = [...document.querySelectorAll(SEL.userCell)].slice(0, 25);
        const out = rows.map((row) => {
          const btn = row.querySelector(SEL.unfollowBtn) || row.querySelector(SEL.followBtn);
          const handleEl = handleElOf(row);
          const cands = digitLeaves(row);
          const hy = handleEl ? midY(handleEl) : null;
          return {
            handle: btn ? handleOf(btn) : (row.textContent.match(/@([A-Za-z0-9_]{1,15})/) || [])[1] || "?",
            scoreRead: readMoniScore(row),
            numbersFoundInRow: cands.map(c => c.value),
            onHandleLine: hy === null ? "no-layout"
              : cands.filter(c => { const y = midY(c.el); return y !== null && Math.abs(y - hy) <= 14; })
                     .map(c => c.value),
            canUnfollow: !!row.querySelector(SEL.unfollowBtn),
            decisionAtThreshold: (() => {
              const n = readMoniScore(row);
              if (n === null) return "SKIP (no score)";
              return n >= moniThreshold ? `SKIP (>= ${moniThreshold})` : `UNFOLLOW (< ${moniThreshold})`;
            })()
          };
        });
        console.warn("\n=========== MONI SCORE DUMP ===========\n" +
          JSON.stringify({ threshold: moniThreshold, rows: out }, null, 2) +
          "\n=======================================\n" +
          "Copy this whole block if any score looks wrong.");
        return { ok: true, rows: out };
      })().then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: String(e) }));
      return true;
    case "DIAGNOSE":
      runDiagnostics().then(text => sendResponse({ text }))
                      .catch(e => sendResponse({ text: "diagnostics failed: " + e.message }));
      return true;
    case "CHECK_MONI":
      // Quick, non-committal presence probe for the popup.
      sendResponse({ presence: moniPresence(), context: pageContext() });
      return true;
    case "START_DRY_RUN":
      start(msg.nonFollowersOnly !== false, true).then(r => sendResponse(r));
      return true;
    case "PAUSE":
      paused = true; notify("Paused"); sendResponse(state("Paused", true));
      return true;
    case "RESUME":
      paused = false; notify("Resumed"); sendResponse(state("Resumed", true));
      return true;
    case "STOP":
      stop("Stopped manually.");
      sendResponse(state("Stopped", false));
      return true;
    case "GET_PREVIEW":
      sendResponse({ preview: preview.slice(0, 500), skipStats });
      return true;
    default:
      return;
  }
});


// ------------------------------------------------------------
// Diagnostics.
//
// Reading Moni scores depends on X's private DOM, which I cannot see from
// here and which changes. Rather than guess at it again, this captures what
// the extension actually finds on the real page so the reader can be fixed
// against facts instead of assumptions.
//
// It reports structure only: tag names, test ids, class names and the shape
// of numbers. It does not include handles, display names or bio text.
// ------------------------------------------------------------
function sketch(el, depth = 0, max = 3) {
  if (!el || depth > max) return "";
  const pad = "  ".repeat(depth);
  const cls = (el.getAttribute?.("class") || "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
  const tid = el.getAttribute?.("data-testid");
  const href = el.getAttribute?.("href");
  const own = [...el.childNodes]
    .filter(n => n.nodeType === 3)
    .map(n => n.textContent.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 40);
  // Numbers are what matter; other text is redacted for privacy.
  const shown = /^[0-9][0-9,]*$/.test(own) ? own : (own ? `"<text:${own.length}>"` : "");
  let line = `${pad}<${el.tagName?.toLowerCase()}`;
  if (tid) line += ` data-testid="${tid}"`;
  if (cls) line += ` class="${cls}"`;
  if (href) line += ` href="${href}"`;
  line += `>${shown ? " " + shown : ""}\n`;
  for (const c of [...(el.children || [])].slice(0, 12)) line += sketch(c, depth + 1, max);
  return line;
}

async function runDiagnostics() {
  const out = [];
  const p = (x) => out.push(x);

  p("=== Unfollow Console diagnostics ===");
  p("version: " + (chrome.runtime.getManifest?.().version || "?"));
  p("url path: " + location.pathname);
  const ctx = pageContext();
  p(`on a follow list: ${ctx.isList}   challenge: ${ctx.challenge || "none"}`);

  const btns = [...document.querySelectorAll(SEL.unfollowBtn)].filter(isVisible);
  p(`unfollow buttons visible: ${btns.length}`);
  if (!btns.length) {
    p("NO ROWS FOUND. Open your Following list and try again.");
    return out.join("\n");
  }

  const pres = moniPresence();
  p(`rows: ${pres.total}  rows with a Moni host node: ${pres.hosts}  rows with a readable score: ${pres.scores}`);

  const r = readRow(btns[0]);
  p("");
  p("--- first row ---");
  p(`userId: ${r.userId ? "(present)" : "(MISSING)"}   handle: ${r.handle ? "(present)" : "(MISSING)"}`);
  p(`inline score read: ${readMoniScore(rowOf(r.btn))}`);
  p("row structure:");
  p(sketch(rowOf(r.btn), 0, 4));

  p("--- hovering that row ---");
  const link = profileLinkOf(rowOf(r.btn), r.handle);
  p(`profile link found: ${!!link}`);
  if (!link) return out.join("\n");

  fireHover(link);
  await sleep(400);
  fireHover(link);
  await sleep(1600);

  const card = findHoverCard(r.handle);
  p(`hover card found: ${!!card}`);
  if (card) {
    p(`card tag: ${card.tagName?.toLowerCase()}  testid: ${card.getAttribute("data-testid") || "(none)"}`);
    p(`score read from card: ${readMoniScoreFromCard(card)}`);
    const pills = collectScorePills(card);
    p(`number-only elements in card: ${pills.length}`);
    pills.slice(0, 8).forEach((el, i) => {
      p(`  [${i}] "${el.textContent.trim()}" insideLink=${!!el.closest("a")} ` +
        `insideButton=${!!el.closest('button,[role="button"]')} ` +
        `class="${(el.getAttribute("class") || "").slice(0, 40)}"`);
    });
    p("card structure:");
    p(sketch(card, 0, 5));
  } else {
    p("The card was not located. Elements outside the list that mention this handle:");
    const h = cssEsc(r.handle || "");
    const refs = h ? document.querySelectorAll(`a[href="/${h}"], a[href^="/${h}/"]`) : [];
    p(`  matches: ${refs.length}`);
    [...refs].slice(0, 5).forEach((a, i) => {
      p(`  [${i}] href=${a.getAttribute("href")} inList=${!!a.closest(SEL.userCell)}`);
    });
  }
  endHover(link);
  p("=== end ===");
  return out.join("\n");
}

// ------------------------------------------------------------
// Page context + guards
// ------------------------------------------------------------
function pageContext() {
  const path = location.pathname;
  const isList = LIST_PAGES.some(re => re.test(path));
  return {
    path,
    isList,
    challenge: detectChallenge(),
    listType: isList ? (path.split("/").pop() || "following") : null
  };
}

// Returns a hard reason string, a soft reason string, or null.
// HARD  -> stop immediately and lock restarts for a while.
// SOFT  -> counted; several in a row trip the circuit breaker.
function detectChallenge() {
  const p = location.pathname;

  if (/^\/account\/access/i.test(p))            return "locked";
  if (/^\/account\/suspended/i.test(p))         return "suspended";
  if (/^\/i\/flow\/(login|signup)/i.test(p))    return "logged-out";
  if (/^\/login\/?$/i.test(p))                  return "logged-out";

  // Arkose / FunCaptcha challenge widget
  if (document.querySelector(
    'iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], iframe[title*="challenge" i], ' +
    'div[id^="arkose"], #arkose, [data-testid="ocfEnterTextTextInput"]'
  )) return "captcha";

  // Denied write / hard rate limit surfaces as a full-screen error page
  if (document.querySelector('[data-testid="error-detail"]')) {
    const t = (document.body.innerText || "").toLowerCase();
    if (t.includes("rate limit") || t.includes("try again later")) return "rate-limited";
  }
  return null;
}

// Toast text is noisy on X, so it is a soft signal only.
function detectSoftFailure() {
  const nodes = document.querySelectorAll(`${SEL.toast}, [role="alert"]`);
  for (const n of nodes) {
    const s = (n.innerText || "").toLowerCase();
    if (!s) continue;
    if (/rate limit|too many|over the limit|限制/.test(s))        return "rate-limit";
    if (/try again|something went wrong|couldn.t|unable to/.test(s)) return "x-error";
  }
  return null;
}

async function getHaltLock() {
  const { haltUntil = 0, haltKind = "" } =
    await chrome.storage.local.get({ haltUntil: 0, haltKind: "" });
  if (Date.now() < haltUntil) {
    return { locked: true, until: haltUntil, kind: haltKind,
             minutes: Math.ceil((haltUntil - Date.now()) / 60000) };
  }
  return { locked: false };
}

async function setHaltLock(kind) {
  await chrome.storage.local.set({
    haltUntil: Date.now() + HALT_LOCK_MINUTES * 60000,
    haltKind: kind
  });
}

// ------------------------------------------------------------
// Quota ledger - rolling 24h and 15min budgets, persisted
// ------------------------------------------------------------
async function readLog() {
  const { actionLog = [] } = await chrome.storage.local.get({ actionLog: [] });
  const cutoff = Date.now() - 86400000;
  return actionLog.filter(t => t > cutoff);
}

async function recordAction() {
  const log = await readLog();
  log.push(Date.now());
  await chrome.storage.local.set({ actionLog: log });
}

// Warn once per level per run when the day's volume crosses a known-risky
// mark. This replaces the old hard stop at the daily number.
const warnedLevels = new Set();
function warnIfHigh(dayUsed, soundOn) {
  for (const level of WARN_DAY_LEVELS) {
    if (dayUsed >= level && !warnedLevels.has(level)) {
      warnedLevels.add(level);
      notify(`Warning: ${dayUsed} unfollows today. X commonly limits accounts around this volume - consider stopping.`);
      console.warn(`[X Unfollow Manager] VOLUME WARNING: ${dayUsed} actions in 24h.`);
      try { if (soundOn) alarmBeep(); } catch (_) {}
    }
  }
}

async function getBudget(settings) {
  const s = settings || await chrome.storage.sync.get(DEFAULTS);
  const log = await readLog();
  const now = Date.now();
  const day = log.length;
  const win = log.filter(t => now - t < 15 * 60000).length;

  // A limit of 0 means "no cap" - the run is governed by pacing and by X's
  // own signals rather than by a number here. Anything above 0 is enforced
  // exactly as before.
  const dayCap = Number(s.dailyLimit) > 0 ? Number(s.dailyLimit) : Infinity;
  const winCap = Number(s.windowLimit) > 0 ? Number(s.windowLimit) : Infinity;

  let resetIn = 0;
  if (day >= dayCap && log.length) resetIn = Math.ceil((log[0] + 86400000 - now) / 60000);
  else if (win >= winCap) {
    const oldestInWindow = log.find(t => now - t < 15 * 60000);
    if (oldestInWindow) resetIn = Math.ceil((oldestInWindow + 15 * 60000 - now) / 60000);
  }

  return {
    dayUsed: day, dayLimit: dayCap === Infinity ? 0 : dayCap,
    winUsed: win, winLimit: winCap === Infinity ? 0 : winCap,
    dayLeft: dayCap === Infinity ? Infinity : Math.max(0, dayCap - day),
    winLeft: winCap === Infinity ? Infinity : Math.max(0, winCap - win),
    unlimitedDay: dayCap === Infinity,
    unlimitedWin: winCap === Infinity,
    resetInMinutes: resetIn
  };
}

// ------------------------------------------------------------
// Profile detection
// ------------------------------------------------------------
function getLoggedInProfile() {
  const result = { name: "", handle: "", avatar: "" };
  const sw = document.querySelector(SEL.switcher);
  if (sw) {
    const img = sw.querySelector("img[src]");
    if (img) result.avatar = img.src;
    const lines = (sw.innerText || "").split("\n").map(x => x.trim()).filter(Boolean);
    const h = lines.find(x => x.startsWith("@"));
    const n = lines.find(x => !x.startsWith("@") && x.toLowerCase() !== "more");
    if (n) result.name = n;
    if (h) result.handle = h.replace(/^@/, "");
  }
  if (!result.handle) {
    const href = document.querySelector(SEL.profileLink)?.getAttribute("href") || "";
    if (/^\/[A-Za-z0-9_]{1,15}$/.test(href)) result.handle = href.slice(1);
  }
  if (!result.avatar) {
    const img = document.querySelector(`${SEL.switcher} img`);
    if (img) result.avatar = img.src;
  }
  if (!result.name && result.handle) result.name = result.handle;
  return result;
}

// ------------------------------------------------------------
// Scroll engine - finds the element that actually scrolls.
// X uses the window on most list pages but a nested overflow
// container inside modals and some layouts. v5 always assumed
// window, which is one reason scrolling appeared to do nothing.
// ------------------------------------------------------------
function getScroller() {
  const anchor = document.querySelector(SEL.cellInner) ||
                 document.querySelector(SEL.userCell) ||
                 document.querySelector(SEL.primaryCol);
  let el = anchor?.parentElement;
  while (el && el !== document.body) {
    const st = getComputedStyle(el);
    if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 40) return el;
    el = el.parentElement;
  }
  return window;
}

function scrollMetrics(sc) {
  if (sc === window) {
    return {
      top: window.scrollY || 0,
      view: window.innerHeight,
      height: Math.max(document.documentElement.scrollHeight || 0, document.body.scrollHeight || 0)
    };
  }
  return { top: sc.scrollTop, view: sc.clientHeight, height: sc.scrollHeight };
}

function scrollBy(sc, px) {
  if (sc === window) window.scrollBy({ top: px, behavior: "auto" });
  else sc.scrollTop += px;
}

function atBottom(sc) {
  const m = scrollMetrics(sc);
  return m.top + m.view >= m.height - 240;
}

function isLoadingMore() {
  return !!document.querySelector(`${SEL.primaryCol} ${SEL.spinner}`) ||
         !!document.querySelector(SEL.spinner);
}

function rowCount() {
  return document.querySelectorAll(SEL.userCell).length;
}

// Loose path comparison. X rewrites URLs across reloads - a trailing slash
// appears or disappears, handle casing changes - and an exact === test would
// treat that as the user navigating away and kill a healthy session.
function samePath(a, b) {
  const norm = (p) => String(p || "").toLowerCase().replace(/\/+$/, "");
  return norm(a) === norm(b);
}

// ------------------------------------------------------------
// Force X to render/fetch the next page of the list.
//
// X's follow lists are virtualized: rows that scroll out of view are
// removed from the DOM, so page height and row COUNT stop growing even
// though hundreds more accounts remain. Passive scrolling plus a
// height-growth check therefore concludes "end of list" far too early -
// that was the bug behind runs ending at ~22-42 accounts.
//
// This does the one thing that reliably triggers X's lazy loader,
// whatever element actually scrolls: it pulls the LAST rendered cell fully
// into view (so X's bottom intersection sentinel fires), then does a small
// up-then-down jiggle, because some builds only fetch on a fresh downward
// intersection and need the sentinel to leave and re-enter the viewport.
// ------------------------------------------------------------
async function loadMoreRows(sc, s, aggressive = false) {
  const m = scrollMetrics(sc);

  // Gentle first. Nudging down about one screen is enough to bring X's
  // bottom sentinel into range in the ordinary case, and it leaves the
  // viewport near the accounts we are working through.
  //
  // The aggressive path below teleports to the very bottom of the list. That
  // is what makes a run look like it is scrolling wildly: it jumps to the
  // end, then the next account to act on is back near the top, so the page
  // snaps back up again. It is still needed - it is what got runs past X's
  // pagination ceiling - but only when the gentle nudge stops producing new
  // accounts, not on every single fetch.
  if (!aggressive) {
    scrollBy(sc, Math.round(m.view * 0.9));
    await countdown("Scrolling", Math.max(1, s.scrollWait), "Loading more accounts");
    return;
  }

  // Drive to the ACTUAL bottom of the scroller. X keeps a tall virtual height
  // below the last rendered cell, so scrolling only to that cell never
  // reaches the sentinel and never triggers a fetch.
  if (sc === window) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
  else sc.scrollTop = sc.scrollHeight;
  const cells = document.querySelectorAll(SEL.userCell);
  const last = cells[cells.length - 1];
  if (last) { try { last.scrollIntoView({ block: "end", behavior: "auto" }); } catch (_) {} }
  await sleep(700);
  scrollBy(sc, -Math.round(m.view * 0.6));   // sentinel leaves the viewport
  await sleep(350);
  // ...and back to the very bottom, so it re-enters and forces a fetch.
  if (sc === window) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
  else sc.scrollTop = sc.scrollHeight;
  await countdown("Scrolling", Math.max(1, s.scrollWait), "Loading more accounts");
}

// ------------------------------------------------------------
// Row model
// ------------------------------------------------------------
function userIdOf(btn) {
  const tid = btn.getAttribute("data-testid") || "";
  const m = tid.match(/^(.+)-unfollow$/);
  return m ? m[1] : "";
}

function rowOf(btn) {
  return btn.closest(SEL.userCell) ||
         btn.closest(SEL.cellInner) ||
         btn.closest('[role="listitem"]') ||
         btn.parentElement;
}

function handleOf(btn) {
  const row = rowOf(btn);
  if (row) {
    for (const a of row.querySelectorAll('a[href^="/"]')) {
      const href = a.getAttribute("href") || "";
      if (/^\/[A-Za-z0-9_]{1,15}$/.test(href)) return href.slice(1).toLowerCase();
    }
    const m = (row.innerText || "").match(/@([A-Za-z0-9_]{1,15})/);
    if (m) return m[1].toLowerCase();
  }
  const aria = btn.getAttribute("aria-label") || "";
  const am = aria.match(/@([A-Za-z0-9_]{1,15})/);
  return am ? am[1].toLowerCase() : "";
}

function displayNameOf(btn) {
  const row = rowOf(btn);
  const line = (row?.innerText || "").split("\n").map(s => s.trim()).filter(Boolean)[0];
  return line || "";
}

function bioOf(btn) {
  const row = rowOf(btn);
  const lines = (row?.innerText || "").split("\n").map(s => s.trim()).filter(Boolean);
  return lines.slice(2).join(" ");
}

function readRow(btn) {
  const row = rowOf(btn);
  const nameLink = row?.querySelector('a[href^="/"]') || row;
  const text = (row?.innerText || "").toLowerCase();
  return {
    btn,
    userId: userIdOf(btn),
    handle: handleOf(btn),
    name: displayNameOf(btn),
    bio: bioOf(btn),
    text,
    followsYou: detectFollowsYou(row, text),
    verified: detectVerified(row),
    isProtected: detectProtected(row, text),
    pending: /pending/i.test(text),
    // Inline score if present, otherwise whatever a previous hover probe
    // found for this account. moniProbed tells the caller whether we have
    // already spent a probe on it, so we never probe the same row twice.
    moniScore: (() => {
      const inline = readMoniScore(row);
      if (inline !== null) return inline;
      const id = userIdOf(btn);
      return moniScoreCache.has(id) ? moniScoreCache.get(id) : null;
    })(),
    moniProbed: readMoniScore(row) !== null || moniScoreCache.has(userIdOf(btn))
  };
}

// ------------------------------------------------------------
// Moni score reader.
//
// The Moni ("Moni Discover") extension injects a small Smart-Followers
// score pill next to each account's name on X: a number followed by a
// little flag icon (see the purple "13 / 7 / 245" badges in the UI).
// We read that number so the user can unfollow everyone below a chosen
// score, mutuals included.
//
// Moni is a third-party extension and does not expose a stable API in the
// page, so this reader is deliberately defensive. It does NOT depend on any
// single Moni class name. It looks for Moni's injected container by a set
// of signals and, as a fallback, finds the score pill structurally: a small
// element holding a bare integer that sits next to the name and is NOT one
// of X's own numbers (which are the follow/following counts and always have
// accompanying text like "Followers").
//
// Returns an integer score, or null if no score is present yet.
// ------------------------------------------------------------
// Find the container holding the "@handle" text. Moni injects its pill right
// beside the handle (see the badge position in the list), so this is the only
// region worth searching. Scoping here is what keeps bio text, the display
// name, and X's own counts out of the search entirely.
// The element showing the "@handle" text. Note this is deliberately NOT
// found via a link: X wraps the display name AND the handle in a single
// <a href="/handle">, so an anchor whose text is exactly "@handle" usually
// does not exist. Matching the text node directly is what actually works.
function handleElOf(row) {
  for (const el of row.querySelectorAll("span, div")) {
    if (el.children.length > 1) continue;
    const t = (el.textContent || "").trim();
    if (/^@[A-Za-z0-9_]{1,15}$/.test(t)) return el;
  }
  return null;
}

function midY(el) {
  try {
    const r = el.getBoundingClientRect();
    if (!r || (!r.top && !r.height)) return null;   // no layout (or hidden)
    return r.top + r.height / 2;
  } catch (_) { return null; }
}

// Every bare-integer leaf in the row that could be Moni's badge.
// Excluded: anything inside a link (X's follower/following counts are always
// links, Moni's badge never is), the follow button, and the bio.
function digitLeaves(row) {
  const btn = row.querySelector('[data-testid$="-unfollow"], [data-testid$="-follow"]');
  const bio = row.querySelector('[data-testid="UserDescription"]');
  const out = [];
  for (const el of row.querySelectorAll("span, div")) {
    if (el.children.length > 0) continue;                    // leaves only
    if (el.closest("a")) continue;
    if (btn && btn.contains(el)) continue;
    if (bio && bio.contains(el)) continue;
    const t = (el.textContent || "").trim();
    if (!/^[0-9][0-9,]{0,7}$/.test(t)) continue;
    const n = parseInt(t.replace(/,/g, ""), 10);
    if (Number.isFinite(n)) out.push({ el, value: n });
  }
  return out;
}

function readMoniScore(row) {
  if (!row?.querySelector) return null;

  // 1. Moni's own labelled node, trusted only when its own text is just the
  //    number. Matching loosely on a class containing "moni" and then pulling
  //    the first integer out of it could collide with X's obfuscated class
  //    names and return a digit from somewhere else entirely.
  for (const h of row.querySelectorAll(
        '[data-moni], [data-moni-score], [class*="getmoni" i], [id*="moni" i], ' +
        'moni-score, [data-testid*="moni" i], [class*="smart-followers" i]')) {
    const own = (h.textContent || "").trim();
    if (/^[0-9][0-9,]{0,7}$/.test(own)) {
      const n = parseInt(own.replace(/,/g, ""), 10);
      if (Number.isFinite(n)) return n;
    }
  }

  const cands = digitLeaves(row);
  if (!cands.length) return null;

  // 2. Geometry. The badge sits on the same visual line as the handle - that
  //    is precisely how a person identifies it on screen, and it survives X
  //    or Moni restructuring their markup, which a DOM-shape rule does not.
  const handleEl = handleElOf(row);
  const hy = handleEl ? midY(handleEl) : null;
  if (hy !== null) {
    const sameLine = cands.filter((c) => {
      const y = midY(c.el);
      return y !== null && Math.abs(y - hy) <= 14;          // one text line
    });
    const vals = [...new Set(sameLine.map((c) => c.value))];
    if (vals.length === 1) return vals[0];
    if (vals.length > 1) return null;   // ambiguous on the line -> refuse
  }

  // 3. No layout available (hidden row, or a test environment). Fall back to
  //    uniqueness across the row, which is safe because links, the button and
  //    the bio are already excluded.
  const all = [...new Set(cands.map((c) => c.value))];
  return all.length === 1 ? all[0] : null;
}

// Pull the first standalone integer from an element's own text.
function firstIntIn(el) {
  const t = (el.textContent || "").trim();
  const m = t.match(/^\s*([0-9][0-9,]{0,7})\s*$/) || t.match(/\b([0-9][0-9,]{0,6})\b/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

// Candidate pill elements: small leaf-ish nodes near the name that are not
// X's structural pieces. We avoid the button and the bio.
function collectScorePills(row) {
  const out = [];
  const btn = row.querySelector('[data-testid$="-unfollow"], [data-testid$="-follow"]');
  const all = row.querySelectorAll("span, div");
  for (const el of all) {
    if (el.children.length > 2) continue;                 // want leaf-ish pills
    if (btn && (btn.contains(el) || el.contains(btn))) continue;
    const t = (el.textContent || "").trim();
    if (!/^[0-9][0-9,]{0,7}$/.test(t)) continue;          // pill is just a number
    out.push(el);
  }
  return out;
}

// Validate a candidate as a Moni pill and return its integer, or null.
// Guards against picking up X's own numbers.
function pillInteger(el) {
  const t = (el.textContent || "").trim();
  if (!/^[0-9][0-9,]{0,7}$/.test(t)) return null;

  // Reject if this number is actually one of X's metrics. X wraps follow
  // counts with descriptive text/links ("Followers", "Following") and marks
  // them up as links to /followers etc. Moni's pill does neither.
  const link = el.closest('a[href*="/followers"], a[href*="/following"], a[href*="/verified_followers"]');
  if (link) return null;

  // Reject compact-count strings like "1.2K"/"3.4M" (X style); Moni shows a
  // plain integer. Our regex already excludes letters, but be explicit.
  if (/[km]/i.test(t)) return null;

  const n = parseInt(t.replace(/,/g, ""), 10);
  if (!Number.isFinite(n)) return null;

  // A Moni pill sits near the name, not deep in the bio. Sanity-check that an
  // ancestor within a few hops is the name/header area.
  let hops = 0, cur = el;
  while (cur && hops < 6) {
    if (cur.querySelector && cur.querySelector('a[href^="/"] [dir], [data-testid="User-Name"]')) break;
    cur = cur.parentElement; hops++;
  }
  return n;
}

// ------------------------------------------------------------
// Hover-card score probing.
//
// Moni does not always inject a score into the follow-list row. On many
// accounts the score only exists inside X's profile hover card, the popup
// that appears when you hover a username. Reading the row alone therefore
// reports "no score" for accounts that do have one.
//
// So when a row has no inline score we synthesise a hover over that row's
// profile link, wait for X to build the card and Moni to fill it in, read
// the score out of the card, then dismiss it. Each account is probed at
// most once per session and the answer is cached, because every probe
// makes X fetch a profile and we do not want to hammer that.
// ------------------------------------------------------------

const moniScoreCache = new Map();   // userId -> number | null (null = truly absent)

const HOVER_SETTLE_MS   = 260;   // let the pointer "rest" before X reacts
const HOVER_TIMEOUT_MS  = 4500;  // give up on a card after this
const HOVER_POLL_MS     = 160;
const INLINE_RETRIES    = 3;     // re-check the row before resorting to hover
const NO_SCORE_STREAK_LIMIT = 8; // give up if this many in a row cannot be read
// Time the run may spend genuinely stuck before it gives up. Planned waits
// (cooldowns, pacing delays, rate rests) are credited back, so this is 4
// minutes of unexplained inactivity, not 4 minutes of wall clock. v6.7.0 set
// this to 2.5 minutes of wall clock and did not credit waits, so a normal
// 6-minute cooldown killed the session at the 12th unfollow.
const NO_PROGRESS_MS  = 360000;  // 6 min of UNEXPLAINED inactivity (waits are credited)
const MAX_ITERATIONS  = 25000;   // absolute ceiling, whatever else happens

function cssEsc(v) {
  return (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/["\\]/g, "\\$&");
}

// The profile link inside a row, used as the hover target.
function profileLinkOf(row, handle) {
  if (!row?.querySelector) return null;
  if (handle) {
    const exact = row.querySelector(`a[href="/${cssEsc(handle)}"]`);
    if (exact) return exact;
  }
  for (const a of row.querySelectorAll('a[href^="/"]')) {
    if (/^\/[A-Za-z0-9_]{1,15}$/.test(a.getAttribute("href") || "")) return a;
  }
  return null;
}

function mouseInit(el) {
  const r = el.getBoundingClientRect();
  return {
    bubbles: true, cancelable: true, view: window,
    clientX: Math.round(r.left + r.width / 2),
    clientY: Math.round(r.top + r.height / 2)
  };
}

// React listens through delegated pointer/mouse events, so a plain
// dispatch is enough - we do not need a real cursor.
function fireHover(el) {
  const init = mouseInit(el);
  const p = { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true };
  try { el.dispatchEvent(new PointerEvent("pointerover", p)); } catch (_) {}
  try { el.dispatchEvent(new PointerEvent("pointerenter", p)); } catch (_) {}
  el.dispatchEvent(new MouseEvent("mouseover", init));
  el.dispatchEvent(new MouseEvent("mouseenter", init));
  el.dispatchEvent(new MouseEvent("mousemove", init));
}

function endHover(el) {
  const init = { bubbles: true, cancelable: true, view: window, clientX: 2, clientY: 2 };
  const p = { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true,
              relatedTarget: document.body };
  el.dispatchEvent(new MouseEvent("mousemove", init));
  el.dispatchEvent(new MouseEvent("mouseout", { ...init, relatedTarget: document.body }));
  el.dispatchEvent(new MouseEvent("mouseleave", init));
  try { el.dispatchEvent(new PointerEvent("pointerout", p)); } catch (_) {}
  try { el.dispatchEvent(new PointerEvent("pointerleave", p)); } catch (_) {}
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

// Find the hover card for one specific handle. Matching on the handle
// matters: without it a stale card left over from a previous row could be
// read and the wrong account judged.
// Find the overlay that X renders for one handle.
//
// This deliberately does not trust any single test id. X renders the card in
// a portal at the end of <body>, and if the id ever changes, an id-only
// finder silently returns nothing and every account looks unscored.
//
// The reliable structural fact is: the card references this handle and
// contains no UserCell, because it is not part of the list. So we climb from
// a link to the handle up to the LARGEST ancestor that still contains no
// UserCell. That is the whole card, whatever it is called this week.
function findHoverCard(handle) {
  if (!handle) return null;
  const h = cssEsc(handle);
  const scopes = [];

  // Preferred: X's own container, when the id is present.
  for (const c of document.querySelectorAll(
        '[data-testid="HoverCard"], [data-testid="hoverCardParent"]')) {
    if (isVisible(c) && c.querySelector(`a[href="/${h}"], a[href^="/${h}/"]`)) scopes.push(c);
  }

  // Structural: climb out of any reference to this handle that is not in the list.
  for (const a of document.querySelectorAll(`a[href="/${h}"], a[href^="/${h}/"]`)) {
    if (a.closest(SEL.userCell)) continue;          // that is the list row
    let el = a.parentElement, best = null;
    for (let i = 0; i < 14 && el && el !== document.body; i++) {
      if (el.querySelector(SEL.userCell)) break;    // climbed into the list
      best = el;
      el = el.parentElement;
    }
    if (best && isVisible(best) && !scopes.includes(best)) scopes.push(best);
  }

  // Prefer the richest scope: the one that actually looks like a profile card.
  scopes.sort((a, b) => scoreCardness(b) - scoreCardness(a));
  return scopes[0] || null;
}

// How much does this element look like a profile card? Used only to pick
// between candidate scopes.
function scoreCardness(el) {
  let n = 0;
  if (el.querySelector('a[href$="/following"], a[href$="/followers"], a[href$="/verified_followers"]')) n += 3;
  if (el.querySelector('[data-testid$="-unfollow"], [data-testid$="-follow"]')) n += 2;
  if (el.querySelector("img")) n += 1;
  return n;
}

// Read a score out of a hover card. Stricter than the row reader, because
// the card also displays follower and following counts, which are bare
// numbers too. Those are always inside links to /followers or /following,
// and always sit AFTER the score in document order, so we use both facts.
function readMoniScoreFromCard(card) {
  if (!card?.querySelector) return null;

  // 1. Moni's own injected node, if it labels itself at all.
  const host = card.querySelector(
    '[class*="moni" i], [class*="getmoni" i], [id*="moni" i], ' +
    '[data-moni], [data-moni-score], [data-testid*="moni" i], moni-score, ' +
    '[class*="smart-followers" i], [class*="smartFollowers" i]');
  if (host) {
    const n = firstIntIn(host);
    if (n !== null) return n;
  }

  // 2. Structural, with one rule that cannot misfire:
  //
  //    On X, the follower and following counts in a profile card are always
  //    LINKS, because clicking them opens those lists. Moni's badge is not a
  //    link. So a bare number that is not inside an <a> is the score, and a
  //    bare number inside an <a> never is.
  //
  //    v6.5.1 had a looser fallback that accepted any leftover candidate.
  //    If the count links did not match the selector it was checking, that
  //    fallback read "4,287" as the score, every account landed above the
  //    threshold, and the run skipped everyone while hovering and scrolling.
  //    Reading nothing is safe here; reading the wrong number is not. So
  //    there is deliberately no loose fallback any more.
  for (const el of collectScorePills(card)) {
    if (el.closest("a")) continue;                 // that is a count, not a score
    if (el.closest('button, [role="button"]')) continue;
    const n = pillInteger(el);
    if (n !== null) return n;
  }
  return null;
}

// Probe one account. Returns a number, or null if it genuinely has no score.
//
// preflight=true is used by the start-up check, which runs BEFORE the session
// is marked running. Without it the guards below would abort the probe
// instantly and every Moni-via-hover-only setup would be reported as
// "Moni not detected".
async function probeScoreByHover(r, preflight = false) {
  const row = rowOf(r.btn);
  const link = profileLinkOf(row, r.handle);
  if (!link) return null;

  const live = () => preflight ? !stopIssued : (running && !haltReason);

  try {
    link.scrollIntoView({ block: "nearest", behavior: "auto" });
    await sleep(rand(180, 340));
    if (!live()) return null;

    fireHover(link);
    await sleep(HOVER_SETTLE_MS);
    fireHover(link);                       // a second nudge; X can miss the first

    const deadline = Date.now() + HOVER_TIMEOUT_MS;
    while (Date.now() < deadline && live()) {
      const card = findHoverCard(r.handle);
      if (card) {
        const n = readMoniScoreFromCard(card);
        if (n !== null) return n;
      }
      await sleep(HOVER_POLL_MS);
    }
    return null;
  } finally {
    try { endHover(link); } catch (_) {}
    // Wait for the card to actually go away. If it is still on screen it can
    // sit over the row and swallow the unfollow click.
    const closeBy = Date.now() + 2500;
    while (Date.now() < closeBy && findHoverCard(r.handle)) await sleep(120);
    await sleep(rand(180, 320));
  }
}

// Full resolution path for one row: inline first, then hover.
async function resolveMoniScore(r, s) {
  try {
    return await resolveMoniScoreInner(r, s);
  } catch (err) {
    console.warn("[X Unfollow Console] score lookup failed:", err);
    return null;   // treat as unscored rather than ending the run
  }
}

async function resolveMoniScoreInner(r, s) {
  const row = rowOf(r.btn);

  // Moni often injects inline a beat after the row renders, so look again
  // a few times before paying for a hover.
  for (let i = 0; i < INLINE_RETRIES; i++) {
    const inline = readMoniScore(row);
    if (inline !== null) return inline;
    await sleep(380);
    if (!running || haltReason) return null;
  }

  if (s.moniHoverProbe === false) return null;

  notify(`Checking score for @${r.handle || "account"}...`);
  const viaHover = await probeScoreByHover(r, false);
  if (viaHover !== null) return viaHover;

  // One last inline look: the hover may have caused Moni to fill the row in.
  return readMoniScore(row);
}

// Does this row currently show ANY Moni score? Used to decide whether Moni
// is installed at all versus simply slow to load.
function rowHasMoniHost(row) {
  return !!row?.querySelector?.(
    '[class*="moni" i], [class*="getmoni" i], [id*="moni" i], ' +
    '[data-moni], [data-moni-score], [data-testid*="moni" i], moni-score'
  );
}

// Scan the whole list: how many rows have a Moni host / a readable score.
function moniPresence() {
  const rows = document.querySelectorAll(SEL.userCell);
  let hosts = 0, scores = 0, total = 0;
  for (const cell of rows) {
    total++;
    if (rowHasMoniHost(cell)) hosts++;
    if (readMoniScore(cell) !== null) scores++;
  }
  return { total, hosts, scores };
}

// ------------------------------------------------------------
// Badge detection - deliberately language-independent.
//
// The v6.0.0 bug: skip-verified never fired because detection leaned on
// svg[aria-label*="Verified"]. That aria-label is translated per UI
// language, so on a non-English X (the reporter is on Bengali) it never
// matched and verified accounts got unfollowed anyway.
//
// These helpers try, in order: the stable testid, a broad multi-language
// aria-label match, and finally the badge's structural SVG fingerprint,
// which carries no text at all. Any one hit is enough.
// ------------------------------------------------------------

// Checkmark aria-labels across the UI languages X ships. Used only as a
// secondary signal; the testid and structural checks do the heavy lifting.
const VERIFIED_ARIA = /verified|verificad|vérifié|verifizier|verificato|проверенн|認証済|已认证|已驗證|인증된|यच|যাচাই|تم التحقق|doğrulan|zweryfikowan|geverifieerd/i;

function badgeSvgs(row) {
  if (!row?.querySelectorAll) return [];
  // X's verification badge SVG uses a 22x22 viewBox. Filter to that so we
  // do not pick up unrelated icons (reply, retweet, etc. use other sizes).
  return [...row.querySelectorAll('svg[viewBox="0 0 22 22"]')];
}

function detectVerified(row) {
  if (!row?.querySelector) return false;

  // 1. Stable test id (all badge colors share it).
  if (row.querySelector('[data-testid="icon-verified"]')) return true;

  // 2. Any element whose aria-label reads "verified" in any shipped language.
  for (const el of row.querySelectorAll('[aria-label]')) {
    if (VERIFIED_ARIA.test(el.getAttribute("aria-label") || "")) return true;
  }

  // 3. Structural fingerprint. The checkmark badge is a 22x22 SVG sitting
  //    inside the display-name link (not the avatar, not the button). Its
  //    single filled path is the scalloped-circle checkmark. We match the
  //    badge by position + shape, with no reliance on any text.
  for (const svg of badgeSvgs(row)) {
    // Must be adjacent to the name, i.e. inside a link that is not the button.
    if (svg.closest('button, [role="button"]')) continue;
    const inNameArea = svg.closest('a[href^="/"]') ||
                       svg.closest('[data-testid="User-Name"]') ||
                       svg.closest('[dir="ltr"], [dir="auto"]');
    if (!inNameArea) continue;
    const path = svg.querySelector("path");
    const d = path?.getAttribute("d") || "";
    // The verification checkmark path starts at the top of the scalloped
    // circle: "M20.396 11..." for blue, and the gold/gray variants share the
    // same leading geometry. A 22x22 filled badge in the name area that is
    // not a follow indicator is, in practice, the verification badge.
    if (/^M20\.396\s*11/.test(d) || svg.getAttribute("aria-label")) return true;
    // Even without the exact path string, a lone 22x22 badge svg in the name
    // area that carries a <g><path> checkmark counts.
    if (svg.querySelector("g path")) return true;
  }
  return false;
}

function detectProtected(row, text) {
  if (row?.querySelector) {
    if (row.querySelector('[data-testid="icon-lock"]')) return true;
    for (const el of row.querySelectorAll('[aria-label]')) {
      if (/protected|lock|privé|privado|geschützt|保護|비공개|সুরক্ষিত|محمي/i
          .test(el.getAttribute("aria-label") || "")) return true;
    }
    // Small lock SVG next to the name.
    for (const svg of row.querySelectorAll("svg")) {
      if (svg.closest('button, [role="button"]')) continue;
      const al = svg.getAttribute("aria-label") || "";
      if (/protect|lock|privé|privado|保護|비공개|সুরক্ষিত/i.test(al)) return true;
    }
  }
  return /\bprotected\b|🔒/.test(text || "");
}

function detectFollowsYou(row, text) {
  if (row?.querySelector) {
    const ind = row.querySelector('[data-testid="userFollowIndicator"]');
    if (ind) return true;
  }
  // "Follows you" pill, across languages.
  return /follows you|te sigue|vous suit|folgt dir|ti segue|подписан на вас|フォローされています|关注了你|팔로우함|আপনাকে অনুসরণ করে/i
    .test(text || "");
}

// ------------------------------------------------------------
// Filters
// ------------------------------------------------------------
function parseList(str) {
  return String(str || "").split(/[,\n]/).map(x => x.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
}

function decide(r, s) {
  // Whitelist and pending always win, in every mode.
  if (r.pending)                                        return "pending-request";
  if (parseList(s.whitelistHandles).includes(r.handle)) return "whitelisted";

  // ---- Moni low-score mode --------------------------------------------
  // A dedicated mode: unfollow accounts whose Moni score is below the
  // threshold, INCLUDING accounts that follow you back (that is the whole
  // point of the mode, so followsYou does not protect here). The caller
  // guarantees Moni scores are present before this runs; a row with no
  // score is skipped rather than risked.
  if (moniMode) {
    // Still honor the explicit protection toggles the user set.
    if (s.whitelistProtectVerified && r.verified)  return "verified";
    if (parseList(s.whitelistHandles).includes(r.handle)) return "whitelisted";
    if (r.moniScore === null)                      return "no-score";
    if (r.moniScore >= moniThreshold)              return "score-ok";
    return null;   // below threshold -> unfollow, even if a mutual
  }

  // ---- Normal modes ----------------------------------------------------
  if (nonFollowersOnly && r.followsYou)                return "follows-you";
  if (s.skipFollowsMe && r.followsYou)                 return "mutual-protected";
  if (s.skipVerified && r.verified)                    return "verified";
  if (s.skipProtected && r.isProtected)                return "protected";
  if (s.keywordProtection && parseList(s.protectedKeywords).some(k => r.text.includes(k)))
                                                       return "keyword-protected";
  return null;
}

// ------------------------------------------------------------
// Find the next actionable row
// ------------------------------------------------------------
// Returns a row to act on, or a sentinel:
//   null                  -> nothing actionable in view, scroll for more
//   { needsScore: row }   -> Moni mode, and this row has no score yet. The
//                            caller must resolve it (inline retry, then a
//                            hover probe) before the row can be judged.
// The current working batch: a snapshot of rows taken once, then drained.
// Re-querying the DOM after every action was what let the engine's position
// drift around; taking a snapshot and working through it means the run
// behaves the same way twice in a row.
let targetBatch = [];

function collectBatch() {
  const out = [];
  for (const btn of document.querySelectorAll(SEL.unfollowBtn)) {
    if (!btn.isConnected) continue;
    const id = userIdOf(btn);
    if (!id || processed.has(id)) continue;
    // Reject only genuinely unusable nodes (detached, display:none), never
    // merely off-screen ones - those are perfectly clickable.
    try {
      const st = getComputedStyle(btn);
      if (st.display === "none" || st.visibility === "hidden") continue;
    } catch (_) {}
    out.push(btn);
  }
  return out;   // document order: plain top to bottom
}

function nextTarget(s, refilled = false) {
  // Serve from the snapshot first. Nothing here touches the scroll position.
  while (targetBatch.length) {
    const btn = targetBatch.shift();
    if (!btn.isConnected) continue;
    // The row may have changed under us (already unfollowed, or recycled by
    // X's virtual list into a different account) - re-verify before using it.
    if (!btn.matches(SEL.unfollowBtn)) continue;
    const id = userIdOf(btn);
    if (!id || processed.has(id)) continue;

    const r = readRow(btn);

    // In Moni mode an unscored, unprobed row is not a decision yet. Put it
    // back so the same row is reconsidered once its score resolves.
    if (moniMode && !r.moniProbed) { targetBatch.unshift(btn); return { needsScore: r }; }

    const skip = decide(r, s);
    if (skip) {
      processed.add(id);
      skipStats[skip] = (skipStats[skip] || 0) + 1;
      noteProgress();     // working through the list counts as progress
      continue;
    }
    noteProgress();
    return r;
  }

  // Batch drained. Refill once from the DOM; if that yields nothing usable,
  // there is genuinely nothing to act on and the caller will fetch more.
  if (refilled) return null;
  targetBatch = collectBatch();
  if (!targetBatch.length) return null;
  return nextTarget(s, true);
}

// ------------------------------------------------------------
// The unfollow action, with confirmation scoped to the dialog
// and verification that it actually took effect.
// ------------------------------------------------------------
async function waitForDialog(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dlg = document.querySelector(SEL.confirmDlg) ||
                document.querySelector('div[role="dialog"]');
    if (dlg && isVisible(dlg)) {
      const confirm = dlg.querySelector(SEL.confirmBtn) ||
                      [...dlg.querySelectorAll('button,div[role="button"]')]
                        .find(b => isVisible(b) &&
                              !/cancel/i.test(b.getAttribute("data-testid") || "") &&
                              (b.getAttribute("data-testid") || "").toLowerCase() !== "confirmationsheetcancel");
      if (confirm) return { dlg, confirm };
    }
    await sleep(120);
  }
  return null;
}

async function dismissDialog() {
  const dlg = document.querySelector(SEL.confirmDlg) || document.querySelector('div[role="dialog"]');
  const cancel = dlg?.querySelector(SEL.cancelBtn);
  if (cancel) { cancel.click(); await sleep(400); return; }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(400);
}

// The row keeps its userId, so success is "the -unfollow button for this
// id is gone or has become a -follow button".
async function verifyUnfollowed(userId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const esc = (window.CSS && CSS.escape) ? CSS.escape(userId) : userId.replace(/["\\]/g, "\\$&");
  while (Date.now() < deadline) {
    const still = document.querySelector(`[data-testid="${esc}-unfollow"]`);
    const now   = document.querySelector(`[data-testid="${esc}-follow"]`);
    if (now || !still) return true;
    await sleep(200);
  }
  return false;
}

async function performUnfollow(r) {
  // No scrollIntoView before clicking.
  //
  // A button can be clicked whether or not it is on screen - the click event
  // is dispatched directly and does not depend on the viewport. Scrolling
  // each row into view first meant the page crept downward after every
  // single unfollow, which is what "it scrolls after every unfollow"
  // describes. The page now stays still for the whole batch and moves once,
  // when the batch is finished.
  const attempt = async () => {
    if (!r.btn.isConnected) return { ok: false, reason: "row-detached" };

    r.btn.click();
    await sleep(rand(350, 700));

    const dialog = await waitForDialog(6000);
    if (!dialog) {
      await dismissDialog();
      return { ok: false, reason: "no-dialog" };
    }

    await sleep(rand(200, 500));
    dialog.confirm.click();

    const ok = await verifyUnfollowed(r.userId, 6000);
    if (!ok) {
      await dismissDialog();
      return { ok: false, reason: detectSoftFailure() || "not-confirmed" };
    }
    return { ok: true };
  };

  await sleep(rand(500, 1100));
  let res = await attempt();

  // Reliability fallback. If the dialog never opened, the row may genuinely
  // need to be rendered in view for X to respond. Scroll it in and try once
  // more - this costs a scroll, but only on the rare failure rather than on
  // every action.
  if (!res.ok && res.reason === "no-dialog" && r.btn.isConnected) {
    try { r.btn.scrollIntoView({ block: "nearest", behavior: "auto" }); } catch (_) {}
    await sleep(450);
    res = await attempt();
  }
  return res;
}

// ------------------------------------------------------------
// Moni low-score cleanup entry point.
//
// Before committing, we confirm the Moni extension is actually present and
// its scores have loaded. Because Moni injects scores a beat after X renders
// the list, we poll for up to MONI_GRACE_MS before concluding it is absent -
// this is the "wait before warning" the feature calls for.
// ------------------------------------------------------------
async function startMoni(isDryRun) {
  if (running || loopActive) return state("Already running", true);

  const ctx = pageContext();
  const s = await chrome.storage.sync.get(DEFAULTS);

  if (ctx.challenge) {
    return { ...state("Blocked: " + challengeText(ctx.challenge), false), blocked: ctx.challenge };
  }
  if (!ctx.isList && !s.allowAnyPage) {
    return { ...state("Open your Following list first.", false), blocked: "wrong-page", suggestion: "/following" };
  }

  // Wait for Moni to inject scores. We need at least one row on the page and
  // at least one readable score to consider Moni present and loaded.
  //
  // Two different waits: if a Moni host node is on the page, scores are just
  // loading, so give the full grace. If there is no Moni host at all after a
  // couple of probes, Moni almost certainly is not installed, so we do not
  // make the user wait the whole grace before telling them.
  const fullDeadline = Date.now() + MONI_GRACE_MS;
  const noHostDeadline = Date.now() + Math.min(MONI_GRACE_MS, 3000);
  let presence = moniPresence();
  notify("Looking for Moni scores...");

  while (presence.scores === 0) {
    const now = Date.now();
    const hostSeen = presence.hosts > 0;
    if (now >= fullDeadline) break;
    if (!hostSeen && now >= noHostDeadline) break;   // clearly no Moni
    await sleep(MONI_POLL_MS);
    presence = moniPresence();
    if (stopIssued) return state("Stopped.", false);
  }

  // Moni may populate only the profile hover cards and never the rows, in
  // which case counting inline scores would wrongly conclude it is absent.
  // Before giving up, open one account's card and look there.
  if (presence.scores === 0 && s.moniHoverProbe !== false) {
    const btn = [...document.querySelectorAll(SEL.unfollowBtn)].find(isVisible);
    if (btn) {
      notify("No scores on the list. Checking a profile card...");
      const probe = await probeScoreByHover(readRow(btn), true);
      if (probe !== null) presence = { ...presence, scores: 1 };
    }
  }

  if (presence.scores === 0) {
    // Distinguish "Moni not installed" from "Moni installed but no scores".
    const kind = presence.hosts > 0 ? "moni-loading" : "moni-missing";
    return {
      ...state(kind === "moni-missing"
        ? "Moni extension not detected."
        : "Moni is loading scores. Try again in a moment.", false),
      blocked: kind,
      moniInstallUrl: "https://extension.getmoni.io/"
    };
  }

  // Good to go. Configure Moni mode and hand off to the shared launcher.
  moniThreshold = Math.max(0, parseInt(s.moniMinScore, 10) || 0);
  return await launch({ nf: false, isDryRun: !!isDryRun, moni: true, settings: s });
}

// ------------------------------------------------------------
// Lifecycle
// ------------------------------------------------------------
async function start(nf, isDryRun) {
  if (running || loopActive) return state("Already running", true);

  const ctx = pageContext();
  const s = await chrome.storage.sync.get(DEFAULTS);

  if (ctx.challenge) {
    return { ...state("Blocked: " + challengeText(ctx.challenge), false), blocked: ctx.challenge };
  }
  if (!ctx.isList && !s.allowAnyPage) {
    return {
      ...state("Open your Following list first.", false),
      blocked: "wrong-page",
      suggestion: "/following"
    };
  }

  return launch({ nf, isDryRun: !!isDryRun, moni: false, settings: s });
}

// Shared launcher for every mode. Does the halt-lock and budget checks, then
// arms the epoch/interlock and starts the loop. Both start() and startMoni()
// funnel through here so the concurrency guarantees are identical.
async function launch({ nf, isDryRun, moni, settings, resumed }) {
  if (running || loopActive) return state("Already running", true);
  const s = settings || await chrome.storage.sync.get(DEFAULTS);

  // A fresh (non-resumed) start begins a new run, so the reload-cycle counter
  // resets. A resume after a reload-continue must preserve it.
  if (!isDryRun) {
    if (resumed) reloadCycles = await getReloadCycles();
    else { reloadCycles = 0; await setReloadCycles(0); await setDryCycles(0); }
  }

  const lock = await getHaltLock();
  if (lock.locked && !isDryRun) {
    return { ...state(`Safety lock active. ${lock.minutes} min left.`, false), blocked: "halt-lock", lock };
  }

  if (!isDryRun) {
    let b = await getBudget(s);
    if (b.dayLeft <= 0 && !s.infiniteMode) {
      return { ...state(`Daily budget used (${b.dayUsed}/${b.dayLimit}).`, false), blocked: "daily-budget", budget: b };
    }
    // THE 40-50 BUG: a reload-continue lands here with the 15-minute window
    // already spent (windowLimit is 48). The old code returned "blocked" and
    // auto-resume discarded that result, so the page reloaded and the run
    // silently died forever. A resumed run must WAIT for the window to free
    // instead of refusing - the window cap is a pacing device, not a reason
    // to abandon the session.
    if (b.winLeft <= 0) {
      if (!resumed) {
        return { ...state(`15-min budget used. Wait ${b.resetInMinutes} min.`, false), blocked: "window-budget", budget: b };
      }
      running = true;                      // claim the run so nothing else starts
      openKeepalive();
      while (b.winLeft <= 0) {
        const wait = Math.max(1, b.resetInMinutes);
        notify(`Rate resting ${wait} min, then continuing automatically.`);
        await sleep(Math.min(wait, 5) * 60000);
        if (stopIssued) { running = false; return state("Stopped.", false); }
        b = await getBudget(s);
      }
      running = false;                     // hand off cleanly to the normal start below
    }
  }

  // Guard again in case an await above yielded and something else started.
  if (running || loopActive) return state("Already running", true);

  const myEpoch = ++runEpoch;     // this run's identity
  running = true; paused = false; haltReason = null; stopIssued = false;
  count = 0; attempted = 0; softFails = 0;
  targetBatch = [];
  openKeepalive();
  processed.clear(); preview.length = 0; moniScoreCache.clear();
  noteProgress();
  for (const k of Object.keys(skipStats)) delete skipStats[k];
  nonFollowersOnly = nf;
  dryRun = !!isDryRun;
  moniMode = !!moni;
  const base = moni ? `Moni < ${moniThreshold}` : (nf ? "Non-followers" : "All");
  mode = (isDryRun ? "Preview " : "") + base;
  startedAt = Date.now();
  sessionPath = location.pathname;
  currentTimer = null;

  notify("Running: " + mode);
  if (!dryRun) {
    persistSession({
      nf: nonFollowersOnly, moni: moniMode, threshold: moniThreshold,
      sessionPath, startedAt, mode, ts: Date.now(), heartbeatTs: Date.now()
    });
  }
  loop(myEpoch);                  // pass the epoch into the loop
  return state("Started " + mode, true);
}

// ------------------------------------------------------------
// Service-worker keepalive.
// v5 used an offscreen document playing a silent audio loop to stop
// Chrome evicting the worker. That needs the "offscreen" permission,
// puts a permanent audio indicator on the tab, and is the kind of
// thing Web Store review flags. A long-lived port does the same job
// with no extra permission: an open port resets the worker's idle
// timer, and we recycle it before Chrome's 5-minute ceiling.
// ------------------------------------------------------------
function openKeepalive() {
  closeKeepalive();
  try {
    keepPort = chrome.runtime.connect({ name: "xump-keepalive" });
    keepPort.onDisconnect.addListener(() => {
      keepPort = null;
      if (running) setTimeout(openKeepalive, 1000);
    });
    keepTimer = setInterval(() => {
      if (!running) return closeKeepalive();
      if (!dryRun) touchSession();      // keep the resume record alive
      try { keepPort?.postMessage({ t: Date.now() }); } catch (_) { openKeepalive(); }
    }, 20000);
    // Recycle before Chrome's hard port lifetime.
    setTimeout(() => { if (running) openKeepalive(); }, 240000);
  } catch (_) {}
}

function closeKeepalive() {
  if (keepTimer) { clearInterval(keepTimer); keepTimer = null; }
  try { keepPort?.disconnect(); } catch (_) {}
  keepPort = null;
}

// ------------------------------------------------------------
// Session persistence + auto-resume.
//
// The single biggest cause of "the background is not stable" is not this
// code at all: it is Chrome discarding or freezing a backgrounded tab
// (Memory Saver, or an OS memory reclaim). When that happens the whole page
// context is torn down, the timer worker dies, and every bit of in-memory
// run state is lost. On restore the content script re-runs from scratch and
// the session is simply gone - it looks like the run "stopped" on its own.
//
// No keepalive can prevent a tab discard. The durable fix is to write the
// shape of the active run to storage and, when a fresh content script loads
// onto the same list, pick the run back up where it left off. Because the
// unfollowed accounts no longer carry an -unfollow button and the 24h quota
// ledger is persisted, resuming can neither double-act on anyone nor exceed
// the daily budget.
//
//   heartbeatTs is refreshed while the run is live. On load we only resume a
//   session whose heartbeat is recent, so a tab reopened long after the fact
//   does not spontaneously start unfollowing.
// ------------------------------------------------------------
const SESSION_KEY = "activeSession";
// Resume only if the run was live this recently. This must comfortably exceed
// the longest deliberate wait a run can take, or a session dies silently:
// infinite mode idles up to idleRescanMinutes on a dry sweep and up to 10 min
// on a daily-cap rest, and a rate-rest can add more on top. 45 min leaves room
// for all of them while still refusing to resume a tab reopened hours later.
const RESUME_FRESH_MS = 45 * 60000;

async function persistSession(info) {
  try { await chrome.storage.local.set({ [SESSION_KEY]: info }); } catch (_) {}
}
async function clearSession() {
  try { await chrome.storage.local.remove(SESSION_KEY); } catch (_) {}
}
async function touchSession() {
  try {
    const { [SESSION_KEY]: s } = await chrome.storage.local.get(SESSION_KEY);
    if (s) { s.heartbeatTs = Date.now(); await chrome.storage.local.set({ [SESSION_KEY]: s }); }
  } catch (_) {}
}

// Reload-cycle counter, kept in its own key so relaunch/resume doesn't reset
// it. Read on load; reset to 0 only when a run is started fresh (not resumed).
async function getReloadCycles() {
  try { const r = await chrome.storage.local.get(RELOAD_KEY); return (r[RELOAD_KEY]?.cycles) || 0; }
  catch (_) { return 0; }
}
async function setReloadCycles(n) {
  try { await chrome.storage.local.set({ [RELOAD_KEY]: { cycles: n, ts: Date.now() } }); } catch (_) {}
}

// End of the currently loadable list. X has stopped serving more rows. If the
// run removed anyone this cycle, reloading shifts the next batch into view, so
// reload and let auto-resume continue. If a whole cycle removed nobody - or we
// Reload backoff.
//
// Infinite mode reloads to keep going, which is right when the page is healthy
// but dangerous when it is not: if X is down, rate-limiting hard, or the list
// never renders, an unguarded design would reload every ~25 seconds forever
// and hammer X from the user's own session. So we count reload cycles that
// produced NO unfollow and grow the wait between them. Any successful
// unfollow resets the counter to zero, so a healthy run never waits.
const DRY_KEY = "xumpDryCycles";
async function getDryCycles() {
  try { const r = await chrome.storage.local.get(DRY_KEY); return r[DRY_KEY]?.n || 0; }
  catch (_) { return 0; }
}
async function setDryCycles(n) {
  try { await chrome.storage.local.set({ [DRY_KEY]: { n, ts: Date.now() } }); } catch (_) {}
}
// 0s, 30s, 1m, 2m, 4m, 8m, capped at 15m.
function dryBackoffMs(n) {
  if (n <= 0) return 0;
  return Math.min(15 * 60000, 30000 * Math.pow(2, n - 1));
}
async function waitOutDryBackoff() {
  const n = await getDryCycles();
  const ms = dryBackoffMs(n);
  if (ms > 0) {
    notify(`Nothing found in ${n} attempt${n === 1 ? "" : "s"}. Waiting ${Math.round(ms / 60000) || 1} min before retrying.`);
    // Deliberately NOT idle(): idle() returns instantly when `running` is
    // false, and one caller (the blank-page resume path) runs with running
    // false - exactly the case this backoff exists to throttle. Chunked
    // sleeps stay responsive to Stop without depending on run state.
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (stopIssued) return;
      await sleep(1000);
      if (Date.now() % 30000 < 1100) await touchSession();
    }
    creditPlannedWait(ms);
  }
  await setDryCycles(n + 1);
}

// Recycle the page instead of ending the run.
//
// In infinite mode a stuck or exhausted page is not a reason to quit - it is a
// reason to reload. This refreshes the resume record (so the fresh page picks
// the session straight back up), then reloads. Called by the watchdogs, which
// would otherwise terminate the session.
async function recycleForInfinite(why) {
  try {
    await setReloadCycles((await getReloadCycles()) + 1);
    await touchSession();              // critical: keeps the resume record fresh
    notify(`${why}...`);
    await waitOutDryBackoff();         // never hammer X when nothing is working
    if (stopIssued) return;
    await touchSession();              // backoff may have been long; refresh again
    await sleep(900);
    location.reload();
  } catch (_) {
    // If anything above fails we must not leave the run wedged; fall back to
    // a plain reload, which auto-resume will still pick up.
    try { location.reload(); } catch (__) {}
  }
}

// are out of budget or reload attempts - the list is genuinely exhausted; stop.
async function endOfLoadableList(finishMsgIfDone) {
  const s = await chrome.storage.sync.get(DEFAULTS).catch(() => DEFAULTS);
  const b = await getBudget().catch(() => null);
  const dayLeft = b ? b.dayLeft : 1;
  reloadCycles = await getReloadCycles();

  // Real minimum pause before ANY reload, regardless of this cycle's count.
  //
  // THE BUG: reaching this function at all already means barren just maxed
  // out - i.e. we JUST spent a couple of minutes finding nothing new. The
  // old code treated "count > 0 this cycle" as "still actively removing
  // accounts, skip the wait" and reloaded after ~1 second. But `count` only
  // needed to be 1 - a single early unfollow in an otherwise-exhausted batch
  // satisfied it - so once any account had been removed, every subsequent
  // exhaustion reloaded almost instantly. Each reload resets the page to the
  // top (SPAs do not preserve scroll position across a reload), so this
  // produced the reported loop: unfollow one, snap to the top, unfollow one,
  // snap to the top - every ~90 seconds, with no real pause between.
  //
  // A cycle that removed accounts still reloads sooner than a genuinely dry
  // one (there was real content nearby, worth checking again promptly), but
  // "sooner" now means a real, visible pause - never near-instant.
  const productiveWaitMs = 90000;
  const cycleContext = { barrenAtTrigger: END_CONFIRM, thisCycleRemoved: count, reloadCycles };

  // Infinite mode: a dry list is not a reason to finish. Wait a little (so we
  // are not hammering X), then reload and sweep again. New non-followers
  // appear over time as people unfollow you, so this keeps working forever.
  if (s.infiniteMode) {
    if (dayLeft <= 0 && b) {
      // Daily cap reached. Do not stop - idle until it frees, then continue.
      notify(`Daily limit reached (${b.dayUsed}/${b.dayLimit}). Waiting, will continue automatically.`);
      await idle(10 * 60000);
      if (stopIssued || !running) return "done";
    }
    await setReloadCycles(reloadCycles + 1);
    await touchSession();
    const mins = Math.max(1, s.idleRescanMinutes || 5);
    if (count > 0) {
      console.warn("[X Unfollow Manager] RELOAD (productive cycle):", { ...cycleContext, waitMs: productiveWaitMs });
      notify(`Removed ${count} so far. Pausing before reloading to fetch more...`);
      await setDryCycles(0);          // real progress this cycle clears the backoff
      await idle(productiveWaitMs);
    } else {
      console.warn("[X Unfollow Manager] RELOAD (dry cycle):", { ...cycleContext, waitMinutes: mins });
      notify(`No non-followers in this sweep. Re-checking in ${mins} min...`);
      await idle(mins * 60000);
      await waitOutDryBackoff();     // escalate if sweeps keep coming up empty
    }
    if (stopIssued || !running) return "done";
    await touchSession();            // long waits must not age out the resume record
    await sleep(800);
    location.reload();
    return "reloading";
  }

  // Finite mode: do not reload. The list as X is willing to serve it has been
  // worked through, so the run finishes and says so.
  //
  // This used to reload here too, which meant switching continuous mode off
  // did not actually stop the page refreshing itself - the two paths had
  // drifted apart. Reloading to get past X's pagination ceiling is now
  // exclusively a continuous-mode behaviour, which is the one place the user
  // has explicitly asked for it.
  await setReloadCycles(0);
  if (count > 0) {
    notify(`${finishMsgIfDone} Reload the page and start again to continue past this point.`);
  } else if (reloadCycles > 0) {
    notify("No more accounts left to remove on this list.");
  } else {
    notify(finishMsgIfDone);
  }
  return "done";
}

async function stop(message = "Stopped.") {
  if (stopIssued) return;
  stopIssued = true;
  await emitStopReport(message, "STOP");   // capture WHY before state is reset
  runEpoch++;              // invalidate the running loop's identity at once
  clearSession();          // a clean end must not auto-resume
  closeKeepalive();
  // Clear any outstanding worker timers so nothing fires after we stop.
  try { timerWorker?.postMessage({ type: "clearAll" }); } catch (_) {}
  running = false; paused = false; mode = "Idle"; currentTimer = null;
  moniMode = false;
  abortAllWaits();         // wake any in-flight sleep so the loop exits now
  const budget = await getBudget().catch(() => null);
  try {
    chrome.runtime.sendMessage({ ...state(message, false, budget), type: "STOPPED" }).catch(() => {});
  } catch (_) {}
  const s = await chrome.storage.sync.get(DEFAULTS);
  if (s.reloadOnStop && !haltReason) setTimeout(() => location.reload(), 900);
}

async function halt(kind, message) {
  haltReason = kind;
  running = false;
  stopIssued = true;
  runEpoch++;              // invalidate the running loop at once
  clearSession();          // do not auto-resume into a challenge/lock
  closeKeepalive();
  try { timerWorker?.postMessage({ type: "clearAll" }); } catch (_) {}
  abortAllWaits();
  await setHaltLock(kind);
  try {
    chrome.runtime.sendMessage({
      ...state(message, false), type: "HALTED", haltKind: kind
    }).catch(() => {});
  } catch (_) {}
  alarmBeep();
  console.warn("[X Unfollow Manager] HALTED:", kind, message);
  await emitStopReport(message, "HALT");
}

function challengeText(kind) {
  switch (kind) {
    case "captcha":      return "X is showing a verification challenge. Solve it yourself in this tab, then wait a while before restarting.";
    case "locked":       return "Your account is temporarily locked by X. Complete the steps X shows, then rest the account.";
    case "suspended":    return "This account is suspended. Stop automating and contact X support.";
    case "logged-out":   return "You have been logged out. Sign in again before running a session.";
    case "rate-limited": return "X is rate limiting this account. Wait it out before running again.";
    default:             return "X interrupted the session.";
  }
}

// ------------------------------------------------------------
// Main loop
// ------------------------------------------------------------
async function loop(myEpoch) {
  // This loop is the current run only while its epoch matches and running
  // is set. The moment Stop/halt/a new Start bumps runEpoch, alive() goes
  // false and the loop exits at its next check - which is immediate,
  // because stop() also aborts any in-flight sleep.
  const alive = () => running && runEpoch === myEpoch && !stopIssued;

  loopActive = true;
  try {
    const s = await chrome.storage.sync.get(DEFAULTS);
    if (!alive()) return;

    const sc0 = getScroller();
    let stallProbes = 0;
    let barren = 0;          // consecutive load attempts that surfaced no NEW account
    let lastHeight = scrollMetrics(sc0).height;
    let lastRows = rowCount();
    let noTargetPasses = 0;
    let noScoreStreak = 0;   // consecutive accounts whose score could not be read

    const hardDeadline = Date.now() + Math.max(5, s.maxSessionMinutes) * 60000;

    // ---- progress watchdog ------------------------------------------
    // Every runaway so far slipped past whichever specific counter was
    // supposed to catch it. This one does not care about the cause: if the
    // run stops making any kind of forward progress, it ends. Progress
    // means either an account was acted on, or a row we had never seen
    // before appeared. Anything else is spinning.
    let iterations = 0;
    const everSeen = new Set();
    noteProgress();

    const scanForNewRows = () => {
      let fresh = 0;
      for (const b of document.querySelectorAll(SEL.unfollowBtn)) {
        const id = userIdOf(b);
        if (id && !everSeen.has(id)) { everSeen.add(id); fresh++; }
      }
      if (fresh) noteProgress();
      return fresh;
    };
    scanForNewRows();

    while (alive()) {
      // ---- background operation ---------------------------------------
      // The loop keeps working while the tab is hidden. All waiting is done
      // by a Web Worker timer, which Chrome does not throttle, and nothing
      // here depends on requestAnimationFrame or on the tab being painted.
      // Only if the user has explicitly asked it to pause does it wait.
      // No background pausing. All waiting is done by a Web Worker timer,
      // which Chrome does not throttle, and nothing here needs the tab to be
      // painted - so a hidden tab is not a reason to stop working.

      // ---- watchdog: hard iteration ceiling ---------------------------
      // In infinite mode these watchdogs must not END the run - a stuck page
      // is fixed by reloading it, not by giving up. Each one recycles the
      // page and the session resumes on the fresh load.
      if (++iterations > MAX_ITERATIONS) {
        if (s.infiniteMode) { await recycleForInfinite("Refreshing to keep going"); return; }
        notify("Safety limit reached. Session ended.");
        break;
      }

      // ---- watchdog: no forward progress ------------------------------
      if (Date.now() - lastProgressAt - plannedWaitCredit > NO_PROGRESS_MS) {
        if (s.infiniteMode) { await recycleForInfinite("Page went quiet - refreshing"); return; }
        notify("Nothing new found for a while. Session ended.");
        break;
      }

      // ---- stop condition 1: wall clock -------------------------------
      if (Date.now() > hardDeadline && !s.infiniteMode) {
        notify("Session time limit reached.");
        break;
      }

      // ---- stop condition 2: navigated away ---------------------------
      // Compared loosely: X normalises URLs across reloads (trailing slash,
      // handle casing), and an exact string test would read that as the user
      // navigating away and end a healthy run.
      if (!samePath(location.pathname, sessionPath)) {
        notify("Page changed. Session ended.");
        break;
      }

      // ---- stop condition 3: challenge --------------------------------
      const ch = detectChallenge();
      if (ch && s.stopOnChallenge) {
        await halt(ch, challengeText(ch));
        return;
      }

    if (paused) { await sleep(600); continue; }

    // ---- stop condition 4: budget exhausted -------------------------
    if (!dryRun) {
      const b = await getBudget(s);
      if (b.dayLeft <= 0) {
        // Infinite mode: the daily cap is a pacing device, not an ending. Rest
        // until it frees and carry on, because the user asked for a run that
        // only stops when they stop it.
        if (s.infiniteMode) {
          notify(`Daily limit reached (${b.dayUsed}/${b.dayLimit}). Resting, will continue automatically.`);
          await countdown("Daily rest", 15 * 60, "Waiting for daily limit to free up");
          continue;
        }
        notify(`Daily budget reached (${b.dayUsed}/${b.dayLimit}).`);
        break;
      }
      if (b.winLeft <= 0) {
        notify(`15-min budget reached. Resting ${b.resetInMinutes || 1} min.`);
        await countdown("Rate rest", Math.max(60, (b.resetInMinutes || 1) * 60), "Respecting 15-min limit");
        continue;
      }
    }

    if (Number(s.maxActions) > 0 && count >= s.maxActions && !s.infiniteMode) { notify("Session target reached."); break; }

    const sc = getScroller();
    const target = nextTarget(s);

    // ------------------------------------------------------------
    // Moni scores still loading for on-screen rows. Wait a beat and
    // re-scan rather than scrolling past accounts whose score has not
    // arrived yet. Bounded so a permanently-unscored row cannot hang the
    // run: after several waits we let those rows fall through as skipped.
    // ------------------------------------------------------------
    if (target && target.needsScore) {
      const r = target.needsScore;
      const score = await resolveMoniScore(r, s);

      // If the run was interrupted mid-probe (tab hidden, stop pressed), the
      // null we got back means "did not finish", not "has no score". Caching
      // it would permanently mark a scored account as unscored.
      if (score === null && !alive()) continue;

      moniScoreCache.set(r.userId, score);

      if (score === null) {
        noScoreStreak++;
        notify(`No Moni score for @${r.handle || "account"} - skipping.`);

        // If nothing can be read for many accounts in a row, something is
        // wrong with score reading rather than with those accounts. Stop and
        // say so, instead of quietly scrolling the whole list unfollowing
        // no one, which just looks broken.
        if (noScoreStreak >= NO_SCORE_STREAK_LIMIT) {
          await stop(`Could not read a Moni score for ${noScoreStreak} accounts in a row. ` +
                     `Check that Moni is loading scores on this page, then try again.`);
          return;
        }
      } else {
        noScoreStreak = 0;
        noteProgress();
        notify(`@${r.handle || "account"} scored ${score}`);
      }
      continue;   // re-scan; the cache now answers for this row
    }

    // ------------------------------------------------------------
    // No actionable row in the current DOM: fetch more, or - only after
    // trying hard and repeatedly getting nothing new - conclude the list
    // has ended.
    //
    // THE FIX: end-of-list is judged on whether NEW unique accounts are
    // still appearing (everSeen growing), NOT on page height or row count.
    // X recycles off-screen rows out of the DOM, so height and count go
    // flat while hundreds of accounts remain - which is exactly why runs
    // were ending around 22-42. loadMoreRows() forces X's lazy loader by
    // scrolling the last cell into view and jiggling the sentinel.
    // ------------------------------------------------------------
    if (!target) {
      // Empty list. X shows this state transiently after a reload too, so in
      // continuous mode it is a reason to reload and re-check, not to finish.
      // Only a finite run treats it as the end.
      if (rowCount() === 0 && document.querySelector(SEL.emptyState)) {
        if (s.infiniteMode) {
          await recycleForInfinite("List looks empty - re-checking");
          return;
        }
        notify("This list is empty.");
        break;
      }

      const seenBefore = everSeen.size;
      // Gentle scrolling first; only reach for the full-height jump once a
      // couple of gentle fetches in a row have produced nothing new.
      await loadMoreRows(sc, s, barren >= AGGRESSIVE_AFTER);
      const fresh = scanForNewRows();          // updates everSeen, credits progress
      const gotNew = fresh > 0 || everSeen.size > seenBefore;

      if (gotNew || isLoadingMore()) {
        // New accounts arrived (or a fetch is in flight). Not the end.
        barren = 0;
        continue;
      }

      // Nothing new this attempt. Only accept exhaustion after many patient,
      // vigorous fetches that each surfaced nothing. NOTE: this no longer
      // requires atBottom() - X reports a tall virtual scroll height that is
      // never "at the bottom", which is exactly why the old check spun for
      // ~36 minutes instead of concluding. New-accounts-seen is the signal.
      barren++;
      notify(`Looking for more accounts (${barren}/${END_CONFIRM})`);

      if (barren >= END_CONFIRM && !isLoadingMore()) {
        const outcome = await endOfLoadableList(
          count > 0
            ? `Reached the end of the list. Unfollowed ${count}.`
            : "No accounts on this list matched your filters.");
        if (outcome === "reloading") return;   // page is reloading; loop ends here
        break;                                  // genuinely done
      }

      await idle(PROBE_MS);
      continue;
    }

    barren = 0;
    noTargetPasses = 0;
    stallProbes = 0;
    processed.add(target.userId);

    // ---- dry run: record and move on --------------------------------
    if (dryRun) {
      preview.push({
        handle: target.handle, name: target.name,
        followsYou: target.followsYou, verified: target.verified
      });
      count++;
      notify(`Preview: @${target.handle || "unknown"}`);
      await sleep(rand(120, 260));
      continue;
    }

    // ---- real action ------------------------------------------------
    // Final visibility check: if the user switched away during the scan or
    // the pre-action delay, do not begin a new unfollow. Wait for the tab
    // to come back first. An action already in flight is never interrupted.
    // (Previously this re-queued the target and continued whenever the tab
    // was hidden, which was both an unwanted pause and a tight loop with no
    // sleep in it. A hidden tab now changes nothing.)

    attempted++;
    const res = await performUnfollow(target);

    if (!res.ok) {
      softFails++;
      skipStats["failed-" + res.reason] = (skipStats["failed-" + res.reason] || 0) + 1;
      notify(`Could not unfollow @${target.handle || "?"} (${res.reason})`);

      if (res.reason === "rate-limit") {
        await halt("rate-limited", challengeText("rate-limited"));
        return;
      }
      if (softFails >= SOFT_FAIL_LIMIT) {
        await halt("repeated-failures",
          "Several actions failed in a row. X is probably throttling this account. Session stopped.");
        return;
      }
      // Back off, growing with each consecutive failure. A one-off DOM timing
      // miss (dialog not found because the row recycled) recovers on the next
      // pass; a real throttle keeps failing and climbs toward the halt above.
      const backoff = Math.min(60000, 4000 * Math.pow(2, softFails - 1));
      await idle(backoff);
      continue;
    }

      softFails = 0;
      count++;
      noteProgress();
      await setDryCycles(0);      // real progress clears the reload backoff
      await recordAction();
      try {
        const b2 = await getBudget(s);
        warnIfHigh(b2.dayUsed, s.soundEnabled);
      } catch (_) {}
      await bumpLifetimeUnfollows();
      budgetCacheAt = 0;          // gauge should reflect this immediately
      refreshBudgetCache();
      await saveUnfollowedProfile(target);
      playBeep(s.soundEnabled);
      notify("Unfollowed @" + (target.handle || "account"));

      if ((Number(s.maxActions) > 0 && count >= s.maxActions && !s.infiniteMode) || !alive()) break;

      if (s.cooldownAfter > 0 && count % s.cooldownAfter === 0) {
        await countdown("Cooldown", s.cooldownMinutes * 60, "Cooldown running");
        if (!alive()) break;
      }

      let delay = rand(s.minDelay, s.maxDelay);
      // Human pacing: occasional longer pause so the rhythm is not machine-regular.
      if (s.humanPacing && Math.random() < 0.14) delay = Math.round(delay * rand(180, 320) / 100);
      await countdown("Next action", delay, "Waiting before next action");
    }

    // Only the current run may write the "finished" state. A loop that was
    // superseded (epoch moved) exits quietly and lets the new run own state.
    if (runEpoch === myEpoch && !stopIssued) {
      const summary = dryRun
        ? `Preview complete. ${count} accounts match your filters.`
        : `Finished. Unfollowed ${count} of ${attempted} attempted.`;
      await stop(summary);
    }
  } catch (err) {
    // Without this, any thrown error left `running` true with no loop alive:
    // the popup said "Running" forever while nothing happened, and the only
    // way out was reloading the page. Now a crash ends the session cleanly
    // and reports itself.
    console.error("[X Unfollow Console] session error:", err);
    if (runEpoch === myEpoch && !stopIssued) {
      try {
        await stop("Session ended after an unexpected error. Details are in the console.");
      } catch (_) {
        running = false;
        stopIssued = true;
      }
    }
  } finally {
    // Always release the interlock, even if the loop threw. Without this a
    // crash would leave loopActive stuck true and block all future starts.
    loopActive = false;
    if (runEpoch === myEpoch) {
      running = false;          // never leave the UI claiming to run
      closeKeepalive();
    }
  }
}

// ------------------------------------------------------------
// Lifetime counter.
//
// The archive is capped and the user can clear it, so its length is not a
// lifetime total. This counter only ever increases. It is seeded from the
// existing archive the first time it is touched, so users who already have
// history do not restart from zero.
// ------------------------------------------------------------
async function bumpLifetimeUnfollows() {
  try {
    const { lifetimeUnfollows = null, unfollowedProfiles = [] } =
      await chrome.storage.local.get({ lifetimeUnfollows: null, unfollowedProfiles: [] });
    const base = typeof lifetimeUnfollows === "number"
      ? lifetimeUnfollows
      : (Array.isArray(unfollowedProfiles) ? unfollowedProfiles.length : 0);
    await chrome.storage.local.set({ lifetimeUnfollows: base + 1 });
  } catch (_) { /* never let bookkeeping break a run */ }
}

// ------------------------------------------------------------
// Storage of the archive (trimmed so it cannot grow forever)
// ------------------------------------------------------------
const ARCHIVE_MAX = 5000;

// ------------------------------------------------------------
// Dedup index.
//
// The archive (unfollowedProfiles) holds a full record per account and is
// capped at ARCHIVE_MAX, dropping the OLDEST rows once full. That makes it
// the wrong thing to test "have I unfollowed this person before" against:
// on a big cleanup the earliest names silently fall off the end and would be
// visited a second time.
//
// So a separate, much lighter index is kept alongside it - just lowercase
// handles. Both engines write to it, so a list run never revisits somebody
// the Following-page engine already removed, and vice versa.
// ------------------------------------------------------------
const DEDUP_KEY = "unfollowedIndex";
const DEDUP_MAX = 50000;         // handles only, so this is cheap to hold

async function getDedupSet() {
  try {
    const r = await chrome.storage.local.get(DEDUP_KEY);
    const arr = r[DEDUP_KEY];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (_) { return new Set(); }
}

async function addToDedup(handles) {
  const list = (Array.isArray(handles) ? handles : [handles])
    .map(h => String(h || "").replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  if (!list.length) return;
  try {
    const set = await getDedupSet();
    let changed = false;
    for (const h of list) if (!set.has(h)) { set.add(h); changed = true; }
    if (!changed) return;
    let arr = [...set];
    if (arr.length > DEDUP_MAX) arr = arr.slice(arr.length - DEDUP_MAX);
    await chrome.storage.local.set({ [DEDUP_KEY]: arr });
  } catch (_) {}
}

// Drop handles we have already unfollowed at some point. Uses the dedup
// index rather than the archive, because the archive evicts its oldest rows
// once full and would let early names back in on a large cleanup.
async function filterAlreadyUnfollowed(handles) {
  const set = await getDedupSet();
  const out = [];
  const seen = new Set();
  for (const raw of handles) {
    const h = String(raw || "").replace(/^@/, "").trim();
    if (!h) continue;
    const k = h.toLowerCase();
    if (set.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out;
}

async function saveUnfollowedProfile(target) {
  const handle = (target.handle || "").replace(/^@/, "").toLowerCase();
  const record = {
    username: handle,
    name: target.name || "",
    profileUrl: handle ? `https://x.com/${handle}` : "",
    followedBack: !!target.followsYou,
    verified: !!target.verified,
    unfollowedAt: new Date().toISOString(),
    sourceUrl: location.href,
    mode
  };
  const { unfollowedProfiles = [] } = await chrome.storage.local.get({ unfollowedProfiles: [] });
  const rows = Array.isArray(unfollowedProfiles) ? unfollowedProfiles : [];
  // Index first, and unconditionally: the archive can evict old rows, the
  // index must not forget.
  await addToDedup(handle);
  if (handle && rows.some(r => r.username === handle)) return;
  rows.push(record);
  while (rows.length > ARCHIVE_MAX) rows.shift();
  await chrome.storage.local.set({ unfollowedProfiles: rows });
}

// ------------------------------------------------------------
// Timers and helpers
// ------------------------------------------------------------
async function countdown(label, totalSeconds, message, isAlive) {
  const startedAtMs = Date.now();
  const epochAtStart = runEpoch;
  // The default liveness test belongs to the Following-page engine, which
  // signals a live run with `running`. The list engine never sets that flag,
  // so without an override every countdown broke on its first tick and the
  // list ran with no delay at all. Callers outside that engine pass their own.
  const stillCurrent = isAlive || (() => running && runEpoch === epochAtStart && !stopIssued);
  totalSeconds = Math.max(1, Math.floor(Number(totalSeconds) || 1));
  for (let remaining = totalSeconds; remaining > 0; remaining--) {
    if (!stillCurrent()) break;
    currentTimer = { label, totalSeconds, remainingSeconds: remaining };
    notify(message);
    await sleep(1000);
    while (paused && stillCurrent()) { notify("Paused"); await sleep(600); }
    if (detectChallenge()) break;   // do not idle through a challenge
  }
  currentTimer = null;
  // Waiting on purpose is not a stall.
  creditPlannedWait(Date.now() - startedAtMs);
}

function rand(min, max) {
  min = Number(min); max = Number(max);
  if (!isFinite(min)) min = 0;
  if (!isFinite(max)) max = min;
  if (max < min) [min, max] = [max, min];
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const st = getComputedStyle(el);
  if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
  return true;
}

function tone(freq, ms, vol) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + ms / 1000 + 0.02);
    setTimeout(() => ctx.close().catch(() => {}), ms + 200);
  } catch (_) {}
}

function playBeep(enabled) { if (enabled) tone(520, 120, 0.05); }
function alarmBeep() { tone(300, 260, 0.09); setTimeout(() => tone(240, 400, 0.09), 320); }

// ------------------------------------------------------------
// Diagnostics: rolling breadcrumb of the last status lines, and a single
// structured report emitted the instant a run ends, so WHY it ended is not
// a guess. Every exit funnels through stop() or halt(), so capturing there
// covers all of them: watchdog, end-of-list, budget, challenge, failures.
// This is local to your browser console only - it is never sent anywhere.
// ------------------------------------------------------------
const recentNotes = [];
function pushNote(message) {
  const t = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  recentNotes.push(`+${t}s c=${count} a=${attempted} sf=${softFails} | ${message}`);
  while (recentNotes.length > 24) recentNotes.shift();
}

async function emitStopReport(reason, kind) {
  const budget = await getBudget().catch(() => null);
  let scroll = null;
  try {
    const sc = getScroller();
    const m = scrollMetrics(sc);
    scroll = {
      scroller: sc === window ? "window" : (sc.tagName + (sc.getAttribute?.("aria-label") ? `[${sc.getAttribute("aria-label")}]` : "")),
      top: Math.round(m.top), view: Math.round(m.view), height: Math.round(m.height),
      pxFromBottom: Math.round(m.height - (m.top + m.view)),
      atBottom: atBottom(sc), loadingSpinner: isLoadingMore(),
      renderedRows: rowCount(), unfollowBtns: document.querySelectorAll(SEL.unfollowBtn).length
    };
  } catch (_) {}
  const report = {
    version: chrome.runtime.getManifest?.().version || "?",
    endedBecause: reason,
    kind: kind || (haltReason ? "HALT" : "STOP"),
    haltReason: haltReason || null,
    unfollowed: count,
    attempted: attempted,
    softFails: softFails,
    reloadCycles,
    elapsedSeconds: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
    mode,
    path: location.pathname,
    dayUsed: budget?.dayUsed, dayLimit: budget?.dayLimit,
    winUsed: budget?.winUsed, winLimit: budget?.winLimit,
    scroll,
    skipStats: { ...skipStats },
    lastLines: [...recentNotes]
  };
  try { await chrome.storage.local.set({ lastStopReport: report }); } catch (_) {}
  // One unmistakable, copy-pasteable block.
  console.warn(
    "\n=================== XUMP STOP REPORT ===================\n" +
    JSON.stringify(report, null, 2) +
    "\n=======================================================\n" +
    "Copy everything between the lines above and send it back."
  );
  return report;
}

// ------------------------------------------------------------
// Full-list scan.
//
// Reads the entire following list through X's own internal endpoint rather
// than by scrolling, then stores the result so the popup can show it and
// export it. This is read-only: it never unfollows anybody.
// ------------------------------------------------------------
let scanStop = false;
let scanning = false;

async function runScan() {
  if (scanning) return { ok: false, error: "A scan is already running." };
  if (running)  return { ok: false, error: "Stop the unfollow session before scanning." };

  const GQL = window.__XUMP_GQL;
  if (!GQL || !GQL.available()) {
    return { ok: false, error: "Open x.com and make sure you are signed in, then try again." };
  }

  scanning = true;
  scanStop = false;
  const startedAtMs = Date.now();

  try {
    const cfg = await chrome.storage.sync.get(DEFAULTS).catch(() => DEFAULTS);
    const accounts = await GQL.scan({
      limit: Number(cfg.scanLimit) || 0,       // 0 = read the whole list
      shouldStop: () => scanStop,
      onProgress: (p) => {
        try {
          chrome.runtime.sendMessage({
            type: "SCAN_PROGRESS",
            scanned: p.scanned,
            nonFollowers: p.nonFollowers,
            page: p.page
          }).catch(() => {});
        } catch (_) {}
      }
    });

    const nonFollowers = accounts.filter((u) => !u.followsYou);
    const scan = {
      at: Date.now(),
      seconds: Math.round((Date.now() - startedAtMs) / 1000),
      total: accounts.length,
      mutuals: accounts.length - nonFollowers.length,
      nonFollowers,
      stopped: scanStop
    };

    await chrome.storage.local.set({ lastScan: scan });
    scanning = false;
    return { ok: true, scan };
  } catch (e) {
    scanning = false;
    // A rate-limited scan still carries whatever it managed to read.
    if (e && e.partial && e.partial.length) {
      const nonFollowers = e.partial.filter((u) => !u.followsYou);
      const scan = {
        at: Date.now(),
        seconds: Math.round((Date.now() - startedAtMs) / 1000),
        total: e.partial.length,
        mutuals: e.partial.length - nonFollowers.length,
        nonFollowers,
        partial: true
      };
      await chrome.storage.local.set({ lastScan: scan });
      return { ok: false, error: String(e.message || e), scan };
    }
    return { ok: false, error: String(e?.message || e) };
  }
}


// ------------------------------------------------------------
// LIST RUN
//
// Targeted unfollow from an explicit list of handles (imported CSV, or a
// scan result). Entirely separate from the Following-page engine above: that
// one scrolls and decides, this one is given names and visits each profile.
//
// Because every step navigates, this cannot be a loop. Each page load calls
// stepListRun(), which does exactly one unfollow and then moves on. State
// lives in storage, so closing the tab or a Chrome discard costs nothing but
// the current step.
// ------------------------------------------------------------
let listStepping = false;

// Mirrors of the stored run's flags, kept in memory so the pacing waits can
// test liveness synchronously (a countdown ticks once a second and cannot do
// an async storage read on every tick). Refreshed whenever the run is read or
// a transport command arrives.
let listActive = false;
let listPaused = false;

// Liveness test handed to countdown() for list pacing. Without this, countdown
// falls back to the Following-page engine's `running` flag, which a list run
// never sets - so every wait ended instantly and the list ran with no gaps.
const listAlive = () => listActive && !listPaused && !stopIssued;

async function syncListFlags() {
  try {
    const r = await chrome.storage.local.get("listRun");
    listActive = !!r.listRun?.active;
    listPaused = !!r.listRun?.paused;
  } catch (_) {}
  return { listActive, listPaused };
}

// Handles already in the unfollow archive. Used to skip accounts a previous
// run already removed, so a stale or re-imported CSV costs no page visits.
async function archivedHandles() {
  try {
    const { unfollowedProfiles = [] } = await chrome.storage.local.get({ unfollowedProfiles: [] });
    const set = new Set();
    for (const r of (Array.isArray(unfollowedProfiles) ? unfollowedProfiles : [])) {
      if (r && r.username) set.add(String(r.username).toLowerCase());
    }
    return set;
  } catch (_) { return new Set(); }
}

// Unfollow the account whose profile is currently open.
async function unfollowOnProfile() {
  // On a profile the control carries the same testid suffix as a list row,
  // so the existing click-and-confirm path is reused rather than rewritten.
  let btn = null;
  for (let i = 0; i < 30; i++) {
    btn = document.querySelector(SEL.unfollowBtn);
    if (btn) break;
    // Already not following -> nothing to do. Distinguish that from a page
    // that simply has not rendered yet.
    if (document.querySelector(SEL.followBtn)) return { ok: false, reason: "not-following" };
    if (document.querySelector(SEL.emptyState)) return { ok: false, reason: "no-account" };
    await sleep(400);
  }
  if (!btn) return { ok: false, reason: "no-button" };

  const testid = btn.getAttribute("data-testid") || "";
  const userId = testid.replace(/-unfollow$/, "");

  return await performUnfollow({ btn, userId });
}

async function stepListRun() {
  if (listStepping) return;
  const LR = window.__XUMP_LIST;
  if (!LR) return;

  const run = await LR.get();
  if (!run || !run.active || run.paused) return;
  if (running || loopActive) return;          // never fight the DOM engine

  listActive = !!run.active;
  listPaused = !!run.paused;

  // Finished?
  if (run.index >= run.handles.length) {
    await LR.stop();
    notify(`List finished. Unfollowed ${run.done.length} of ${run.handles.length}.`);
    return;
  }

  // De-dup against the unfollow archive BEFORE navigating anywhere. A handle
  // already recorded as unfollowed needs no page visit at all, so a stale or
  // re-imported CSV skips straight past everything already done instead of
  // spending a navigation and a delay on each one.
  const archive = await archivedHandles();
  let skipTo = run.index;
  const skippedNow = [];
  while (skipTo < run.handles.length &&
         archive.has(String(run.handles[skipTo]).toLowerCase())) {
    skippedNow.push(run.handles[skipTo]);
    skipTo++;
  }
  if (skippedNow.length) {
    const updated = await patchRunSafe({
      index: skipTo,
      skipped: [...(Array.isArray(run.skipped) ? run.skipped : []), ...skippedNow]
    });
    notify(skippedNow.length === 1
      ? `@${skippedNow[0]} already unfollowed - skipped.`
      : `Skipped ${skippedNow.length} already unfollowed.`);
    if (!updated || skipTo >= updated.handles.length) {
      await LR.stop();
      notify(`List finished. Unfollowed ${(updated || run).done.length} of ${(updated || run).handles.length}.`);
      return;
    }
    // Continue with the refreshed position.
    listStepping = false;
    return stepListRun();
  }

  const target = run.handles[run.index];
  const here = LR.currentProfileHandle();

  // Not on the target's profile yet -> go there.
  //
  // This used to refuse to navigate unless the current page was recognised
  // (a profile, the root, or a follow list). Any other page - settings,
  // messages, a login flow, a search result - failed every branch, so the
  // function returned having done nothing, and because nothing re-invokes it
  // except a page load, the run sat at 0/N forever. That was the "it does
  // nothing" state.
  //
  // The user pressed Start on this list, and this script only ever runs on
  // x.com, so navigating is what was asked for. The one page we leave alone
  // is a challenge/verification screen, where moving would be actively bad.
  if (!here || here.toLowerCase() !== target.toLowerCase()) {
    if (pageContext().challenge) {
      await LR.pause();
      notify("X is asking for verification. List paused.");
      return;
    }
    notify(`Going to @${target} (${run.index + 1}/${run.handles.length})`);
    location.href = LR.profileUrl(target);
    return;
  }

  listStepping = true;
  try {
    const s = await chrome.storage.sync.get(DEFAULTS);

    // Liveness for THIS engine. countdown() defaults its aliveness test to
    // the Following-page engine's `running` flag, which a list run never
    // sets - so every wait aborted on its first tick and the list ran with
    // no gap at all. This is the fix for "time interval not working".
    const listAlive = () => !stopIssued && !haltReason;

    // Safety gates, same as the main engine.
    const lock = await getHaltLock();
    if (lock.locked) {
      await LR.pause();
      notify(`Safety lock active. List paused, ${lock.minutes} min left.`);
      return;
    }
    const ch = pageContext().challenge;
    if (ch && s.stopOnChallenge) {
      await LR.pause();
      await halt(ch, challengeText(ch));
      return;
    }

    // Budgets: a list run spends the same daily allowance as everything else.
    const b = await getBudget(s);
    if (b.dayLeft <= 0) {
      await LR.pause();
      notify(`Daily limit reached (${b.dayUsed}/${b.dayLimit}). List paused - resume it tomorrow.`);
      return;
    }
    if (b.winLeft <= 0) {
      const mins = Math.max(1, b.resetInMinutes || 1);
      notify(`15-min limit reached. Waiting ${mins} min.`);
      await countdown("Rate rest", mins * 60, "Waiting for the 15-min window", listAlive);
      listStepping = false;
      if (!listAlive()) return;
      return stepListRun();
    }

    // Session cap. Counts only accounts this run actually unfollowed, so a
    // list full of already-gone entries never burns the allowance.
    if (!s.infiniteMode && Number(s.maxActions) > 0 && run.done.length >= s.maxActions) {
      await LR.pause();
      notify(`Session cap reached (${run.done.length}/${s.maxActions}). List paused.`);
      return;
    }

    // ---- PACING GATE -------------------------------------------------
    // The authoritative delay. Because this engine advances by navigating,
    // an in-memory countdown is not enough on its own: if the page navigates
    // early, is reloaded, or the context is discarded mid-wait, that wait is
    // simply lost and the next profile gets actioned immediately. That is
    // why the list appeared to run at full speed.
    //
    // So the earliest permitted time for the NEXT action is written to
    // storage the moment an action completes. It survives navigation,
    // reload, tab discard and browser restart. Whatever else happens, this
    // gate is honoured before another account is touched.
    if (run.nextAllowedAt && Date.now() < run.nextAllowedAt) {
      const waitSecs = Math.ceil((run.nextAllowedAt - Date.now()) / 1000);
      notify(`Pacing - ${waitSecs}s before @${target}`);
      await countdown("Next", waitSecs, `Waiting before @${target}`, listAlive);
      if (!listAlive()) return;
      // Re-read: the wait may have been long enough for things to change.
      const nowRun = await LR.get();
      if (!nowRun || !nowRun.active || nowRun.paused) return;
    }

    notify(`List: @${target} (${run.index + 1}/${run.handles.length})`);
    await sleep(rand(900, 2000));               // let the profile settle

    const res = await unfollowOnProfile();

    // Compute the next permitted action time IMMEDIATELY, before anything
    // else can go wrong, and persist it with the progress update below.
    let gapSecs;
    if (res.ok || res.reason === "not-confirmed" || res.reason === "rate-limit") {
      // The account was touched - X saw an action - so a full human delay is
      // owed. "not-confirmed" counts: the click went through even if the UI
      // did not confirm, and pretending otherwise is how a run speeds up
      // exactly when it should be slowing down.
      gapSecs = rand(s.minDelay, s.maxDelay);
      // Human pacing: occasional much longer pause so the rhythm is not
      // machine-regular. Same rule and odds as the Following-page engine.
      if (s.humanPacing && Math.random() < 0.14) {
        gapSecs = Math.round(gapSecs * rand(180, 320) / 100);
      }
    } else {
      // Nothing was done to the account, so only a short hop - but never
      // zero, or a run of skips would machine-gun page loads.
      gapSecs = rand(4, 9);
    }

    const patch = { index: run.index + 1, nextAllowedAt: Date.now() + gapSecs * 1000 };
    if (res.ok) {
      patch.done = [...run.done, target];
      await recordAction();
      try {
        const b2 = await getBudget(s);
        warnIfHigh(b2.dayUsed, s.soundEnabled);
      } catch (_) {}
      await bumpLifetimeUnfollows();
      await saveUnfollowedProfile({ handle: target, userId: null, name: "" });
      playBeep(s.soundEnabled);
      notify(`Unfollowed @${target}`);
    } else if (res.reason === "not-following") {
      // Already gone. Record it so we never come back, and do not count it
      // as a failure.
      patch.skipped = [...(Array.isArray(run.skipped) ? run.skipped : []), target];
      await addToDedup(target);
      notify(`@${target} - already not following, skipped.`);
    } else if (res.reason === "no-account") {
      patch.skipped = [...(Array.isArray(run.skipped) ? run.skipped : []), target];
      await addToDedup(target);
      notify(`@${target} - account unavailable, skipped.`);
    } else {
      patch.failed = [...run.failed, { handle: target, reason: res.reason }];
      notify(`@${target} - could not unfollow (${res.reason})`);

      // X explicitly rate-limited us. Stop at once rather than continuing:
      // pushing through a rate limit is what turns it into a lockout.
      if (res.reason === "rate-limit") {
        await patchRunSafe({ ...patch, nextAllowedAt: Date.now() + 20 * 60000 });
        await LR.pause();
        await halt("rate-limited",
          "X rate-limited this account. List paused - wait before continuing.");
        return;
      }

      // Several real failures in a row means X is throttling; stop rather
      // than grind through the rest of the list making it worse.
      if (patch.failed.slice(-SOFT_FAIL_LIMIT).length >= SOFT_FAIL_LIMIT) {
        await LR.pause();
        await halt("repeated-failures",
          "Several list unfollows failed in a row. X is probably throttling. List paused.");
        return;
      }
    }

    const next = await patchRunSafe(patch);
    if (!next || !next.active || next.paused) return;

    if (next.index >= next.handles.length) {
      await LR.stop();
      notify(`List finished. Unfollowed ${next.done.length} of ${next.handles.length}.`);
      return;
    }

    // Cooldown after each batch, on top of the per-action gate. Only real
    // unfollows count toward it - a skip cost the account nothing.
    const doneCount = next.done.length;
    if (s.cooldownAfter > 0 && res.ok && doneCount > 0 && doneCount % s.cooldownAfter === 0) {
      // Push the gate out by the whole cooldown, so it is enforced even if
      // this page goes away mid-rest.
      await patchRunSafe({ nextAllowedAt: Date.now() + s.cooldownMinutes * 60000 });
      notify(`Cooldown ${s.cooldownMinutes} min after ${doneCount} unfollows.`);
      await countdown("Cooldown", s.cooldownMinutes * 60,
        `Cooldown after ${doneCount} unfollows`, listAlive);
    } else {
      // Serve the per-action gap here as well, so the wait is visible in the
      // console. If this page is navigated away mid-wait, the persisted gate
      // makes the next page finish the remainder - the delay cannot be lost.
      const leftMs = (next.nextAllowedAt || 0) - Date.now();
      if (leftMs > 0) {
        await countdown("Next", Math.ceil(leftMs / 1000),
          `Next: @${next.handles[next.index]}`, listAlive);
      }
    }

    if (!listAlive()) return;
    const still = await window.__XUMP_LIST.get();
    if (!still || !still.active || still.paused) return;
    location.href = window.__XUMP_LIST.profileUrl(still.handles[still.index]);
  } catch (e) {
    // Never let an exception leave a run wedged mid-list.
    console.warn("[X Unfollow Manager] list step failed:", e);
    notify("List step failed - retrying shortly.");
    listStepping = false;
    await sleep(8000);
    if (!stopIssued && !haltReason) stepListRun();
    return;
  } finally {
    listStepping = false;
  }
}

// patchRun lives inside listrun.js's closure, so go through storage here.
async function patchRunSafe(patch) {
  try {
    const r = await chrome.storage.local.get("listRun");
    const run = r.listRun;
    if (!run) return null;
    const next = { ...run, ...patch, heartbeatTs: Date.now() };
    await chrome.storage.local.set({ listRun: next });
    return next;
  } catch (_) { return null; }
}

function state(message, runningState, budget) {
  const elapsedSeconds = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  const minutes = Math.max(elapsedSeconds / 60, 1 / 60);
  return {
    message, running: runningState, count, attempted, mode,
    timer: currentTimer, elapsedSeconds, rate: count / minutes,
    dryRun, haltReason, budget: budget || null,
    context: pageContext(), skipStats
  };
}

// Budget is cached because notify() fires roughly once a second and reading
// storage that often is wasteful. A few seconds of staleness is invisible.
let budgetCache = null;
let budgetCacheAt = 0;

function refreshBudgetCache() {
  if (Date.now() - budgetCacheAt < 4000) return;
  budgetCacheAt = Date.now();
  getBudget().then(b => { budgetCache = b; }).catch(() => {});
}

function notify(message) {
  refreshBudgetCache();
  pushNote(message);
  try {
    chrome.runtime.sendMessage({
      ...state(message, true, budgetCache), type: "PROGRESS"
    }).catch(() => {});
  } catch (_) {}
  console.log("[X Unfollow Manager]", message);
}

// ------------------------------------------------------------
// SPA navigation guard - v5 kept running after you clicked away
// ------------------------------------------------------------
let lastPath = location.pathname;
setInterval(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    if (running && !samePath(lastPath, sessionPath)) stop("Page changed. Session ended.");
  }
}, 1500);

// Watch for a challenge appearing even while idle, so the popup can warn.
const chObserver = new MutationObserver(() => {
  if (!running) return;
  const ch = detectChallenge();
  if (ch) halt(ch, challengeText(ch));
});
try {
  chObserver.observe(document.documentElement, { childList: true, subtree: true });
} catch (_) {}

window.addEventListener("beforeunload", () => { running = false; });

// When the tab returns to the foreground, nudge any in-flight wait so the
// loop re-checks visibility promptly instead of waiting out a full tick.
document.addEventListener("visibilitychange", () => {
  if (!pageHidden() && running) {
    // Fire the shortest pending wake early; the loop will re-baseline.
    const first = pendingWakes.entries().next().value;
    if (first) {
      const [id, fn] = first;
      pendingWakes.delete(id);
      try { timerWorker?.postMessage({ type: "clear", id }); } catch (_) {}
      fn();
    }
  }
  // Update the badge so the user can see it paused/resumed from the toolbar.
  if (running) {
    notify(pageHidden()
      ? "Paused - tab in background."
      : "Tab active. Running.");
  }
});

// ------------------------------------------------------------
// Resume a run that a tab discard or reload interrupted.
//
// Runs once, on load. It only resumes when ALL of these hold, so it can
// never surprise the user by unfollowing on its own:
//   - a session record exists and its heartbeat is recent (the run really
//     was live moments ago, not hours),
//   - no safety lock is active,
//   - the daily budget is not already spent,
//   - we are on the exact list the run was working, and its rows have
//     rendered.
// Anything else clears the record or leaves it for a later, valid load.
// ------------------------------------------------------------
// ------------------------------------------------------------
// Continue an active list run on this page load.
//
// The list engine advances by navigating, so every step lands here. Runs
// after a short settle so X has begun rendering the profile.
// ------------------------------------------------------------
// Seed the dedup index from the existing archive, once. Anyone upgrading has
// an unfollow history already; without this backfill their first list run
// would happily revisit everybody they removed before this version.
(async function seedDedupIndex() {
  try {
    const r = await chrome.storage.local.get([DEDUP_KEY, "unfollowedProfiles", "dedupSeeded"]);
    if (r.dedupSeeded) return;
    const rows = Array.isArray(r.unfollowedProfiles) ? r.unfollowedProfiles : [];
    const handles = rows.map(x => x && x.username).filter(Boolean);
    if (handles.length) await addToDedup(handles);
    await chrome.storage.local.set({ dedupSeeded: true });
  } catch (_) {}
})();

// ------------------------------------------------------------
// List ticker.
//
// stepListRun() has many legitimate early returns: wrong page, budget spent,
// a wait still owed, a transient error. Previously the ONLY thing that
// re-invoked it was a page load, so any early return stranded the run
// permanently - the console kept saying "Running 0/1928" while nothing
// happened, because nothing was ever going to call it again.
//
// This ticker makes the engine self-healing: while a run is active it retries
// every few seconds. stepListRun() is idempotent and guarded by listStepping,
// so a tick that arrives mid-step is a no-op rather than a double action.
// ------------------------------------------------------------
let listTicker = null;

function startListTicker() {
  if (listTicker) return;
  listTicker = setInterval(async () => {
    try {
      const LR = window.__XUMP_LIST;
      if (!LR) return;
      const run = await LR.get();
      if (!run || !run.active || run.paused) return;   // idle; keep watching

      // Beat the heartbeat every tick. The background watchdog reloads a tab
      // whose run has gone quiet, and a list run only writes progress once
      // per account - during a six-minute cooldown that would look dead and
      // get the tab reloaded out from under a perfectly healthy run.
      try {
        await chrome.storage.local.set({
          listRun: { ...run, heartbeatTs: Date.now() }
        });
      } catch (_) {}

      if (listStepping || running || loopActive) return;
      stepListRun();
    } catch (_) {}
  }, 7000);
}

(async function maybeStepListRun() {
  try {
    startListTicker();                 // always watching, even if idle now
    const LR = window.__XUMP_LIST;
    if (!LR) return;
    const run = await LR.get();
    if (!run || !run.active || run.paused) return;
    await sleep(1500);
    stepListRun();
  } catch (_) {}
})();

(async function maybeResumeSession() {
  let saved;
  try { ({ [SESSION_KEY]: saved } = await chrome.storage.local.get(SESSION_KEY)); }
  catch (_) { return; }
  if (!saved) return;

  try {
    const lock = await getHaltLock();
    if (lock.locked) { await clearSession(); return; }

    const fresh = Date.now() - (saved.heartbeatTs || 0) < RESUME_FRESH_MS;
    if (!fresh) { await clearSession(); return; }

    // Wrong page: keep the record - the user may be mid-navigation back to
    // the list - but do nothing here.
    if (!samePath(location.pathname, saved.sessionPath)) return;

    const cfg = await chrome.storage.sync.get(DEFAULTS).catch(() => DEFAULTS);
    const b = await getBudget().catch(() => null);
    // In infinite mode a spent daily budget is a reason to WAIT, not to bin
    // the session - launch() rests and continues. Only a finite run ends here.
    if (b && b.dayLeft <= 0 && !cfg.infiniteMode) { await clearSession(); return; }

    // Wait for X to paint the list before touching it. X can be slow right
    // after a reload, so keep the resume record's heartbeat fresh while we
    // wait - otherwise a slow load could age the record past the freshness
    // window and orphan the very session we are trying to restore.
    for (let i = 0; i < 40 && !document.querySelector(SEL.unfollowBtn); i++) {
      if (i % 10 === 9) await touchSession();
      await sleep(500);
    }
    if (!document.querySelector(SEL.unfollowBtn)) {
      // List didn't render. In infinite mode, reload and try again rather
      // than leaving a live session stranded on a blank page.
      if (cfg.infiniteMode && Date.now() - (saved.heartbeatTs || 0) < RESUME_FRESH_MS) {
        await waitOutDryBackoff();   // page isn't rendering; back off, don't hammer
        await touchSession();
        await sleep(4000);
        location.reload();
      }
      return;
    }
    if (running || loopActive) return;

    notify("Reconnecting - resuming your unfollow session.");
    if (saved.moni) {
      moniThreshold = saved.threshold || 0;
      await launch({ nf: false, isDryRun: false, moni: true, resumed: true });
    } else {
      await launch({ nf: saved.nf !== false, isDryRun: false, moni: false, resumed: true });
    }
  } catch (_) { /* never let resume throw into page load */ }
})();

})();
