// X Mass Unfollow - background.js (service worker)
//
// The engine. It owns every run from start to finish:
//
//   scan   read your whole following list, a page at a time, through X's
//          own API (or, if X rejects that, by scrolling the Following page)
//   run    work through a queue of accounts one unfollow at a time, with
//          randomised pacing, rests, a rolling daily cap, and automatic
//          backing off when X asks for it
//
// Why the worker and not the x.com tab (as in v6):
//   A page script lives and dies with its tab. Switch tabs and Chrome stops
//   rendering it; leave it in the background and Chrome throttles or freezes
//   it; navigate and it is gone. That is why v6 runs stopped after the first
//   20-30 accounts. Here the x.com tab only executes single, short requests
//   on demand. All state is in chrome.storage, so a closed popup, a reloaded
//   tab or a restarted worker never loses a run.

importScripts("shared/config.js");
importScripts("shared/telemetry.js");

const { K } = X7;
const X_URLS = ["https://x.com/*", "https://twitter.com/*"];
const CS_FILES = ["content/txid.js", "content/xapi.js", "content/dom.js", "content/content.js"];
const ACTIVE_JOB = new Set(["running", "resting"]);
const HISTORY_MAX = 20000;
const DONE_IDS_MAX = 100000;

const COLORS = {
  run: "#4F46E5", rest: "#F59E0B", scan: "#7C3AED", halt: "#DC2626", done: "#16A34A", paused: "#64748B"
};

// ===========================================================================
// Storage helpers
// ===========================================================================
async function load(key, fallback) {
  try {
    const r = await chrome.storage.local.get(key);
    return r[key] === undefined ? fallback : r[key];
  } catch (_) { return fallback; }
}
async function save(obj) {
  try { await chrome.storage.local.set(obj); } catch (e) { console.warn("[x7] save failed", e); }
}

async function getSettings() { return X7.normalizeSettings(await load(K.settings, {})); }
async function getWhitelist() {
  const arr = await load(K.whitelist, []);
  return new Set((Array.isArray(arr) ? arr : []).map((h) => String(h).toLowerCase()));
}

// Big arrays are cached in memory; storage is the source of truth.
const mem = { scanUsers: null, scanSeen: null, followerIds: null, liveCursor: undefined, doneIds: null };

async function getScanUsers() {
  if (!mem.scanUsers) {
    const arr = await load(K.scanUsers, []);
    mem.scanUsers = Array.isArray(arr) ? arr : [];
    mem.scanSeen = new Set(mem.scanUsers.map((u) => u.i));
  }
  return mem.scanUsers;
}

async function getDoneIds() {
  if (!mem.doneIds) mem.doneIds = new Set(await load(K.doneIds, []));
  return mem.doneIds;
}

async function addDone(id) {
  if (!id) return;
  const set = await getDoneIds();
  if (set.has(id)) return;
  set.add(id);
  let arr = [...set];
  if (arr.length > DONE_IDS_MAX) { arr = arr.slice(arr.length - DONE_IDS_MAX); mem.doneIds = new Set(arr); }
  await save({ [K.doneIds]: arr });
}

// Rolling 24h ledger of unfollow timestamps (the daily cap).
async function getLedger() {
  const cutoff = Date.now() - 86400000;
  const arr = await load(K.ledger, []);
  return (Array.isArray(arr) ? arr : []).filter((t) => t > cutoff).sort((a, b) => a - b);
}
async function pushLedger() {
  const l = await getLedger();
  l.push(Date.now());
  await save({ [K.ledger]: l });
  return l.length;
}

async function pushHistory(t, source) {
  const h = await load(K.history, []);
  const arr = Array.isArray(h) ? h : [];
  arr.push({ i: t.i || null, h: t.h || "", n: t.n || "", a: t.a || "", t: Date.now(), s: source || "" });
  if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
  await save({ [K.history]: arr });
}

const rand = (a, b) => a + Math.random() * (b - a);

// Anonymous "active" ping, at most once a day (deduped inside telemetry).
// Carries only the count of unfollows in the last 24h, nothing identifying.
function pingActive() {
  try { getLedger().then((l) => X7Telemetry.active(l.length)).catch(() => {}); } catch (_) {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// ===========================================================================
// Keepalive + scheduling
//
// A worker with nothing to do is stopped after ~30s. While a scan or run is
// active, a cheap API call every 20s keeps it up so short waits can use
// setTimeout. Every wait is ALSO backed by a chrome.alarm, so if Chrome stops
// the worker anyway, the alarm starts it again and the run continues from
// storage.
// ===========================================================================
let keepTimer = null;
function keepAlive(on) {
  if (on && !keepTimer) keepTimer = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  if (!on && keepTimer) { clearInterval(keepTimer); keepTimer = null; }
}

let tickTimer = null;
function scheduleTick(ms) {
  ms = Math.max(0, Math.round(ms || 0));
  clearTimeout(tickTimer);
  tickTimer = setTimeout(() => tick("timer"), ms);
  chrome.alarms.create("x7.tick", { when: Date.now() + Math.max(ms + 2000, 30000) });
}

let ticking = false;
async function tick(reason) {
  if (ticking) return;
  ticking = true;
  try {
    const scan = await load(K.scan, null);
    if (scan && scan.status === "running") {
      keepAlive(true);
      await scanStep(scan);
      return;
    }
    const job = await load(K.job, null);
    if (job && ACTIVE_JOB.has(job.status)) {
      keepAlive(true);
      await jobStep(job);
      return;
    }
    const act = await load(K.act, null);
    if (act && act.status === "running") {
      keepAlive(true);
      await actStep(act);
      return;
    }
    keepAlive(false);
    chrome.alarms.clear("x7.tick");
  } catch (e) {
    console.error("[x7] tick failed:", e);
    scheduleTick(15000);
  } finally {
    ticking = false;
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "x7.tick" || a.name === "x7.watch") tick(a.name);
  if (a.name === "x7.badgeClear") setBadge("", null);
});
chrome.alarms.create("x7.watch", { periodInMinutes: 1 });

// ===========================================================================
// Tabs: find an x.com tab that can take work, inject the executor if a tab
// predates this version (no "refresh the page first"), or open one.
// ===========================================================================
const readyWaiters = new Map();   // tabId -> [{ match, resolve }]

function sendTab(tabId, msg, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => finish({ ok: false, kind: "transient", message: "The X tab did not answer.", noAnswer: true }), timeoutMs || 60000);
    try {
      chrome.tabs.sendMessage(tabId, msg).then(
        (r) => finish(r || { ok: false, kind: "transient", message: "No answer from the X tab.", noAnswer: true }),
        (e) => finish({ ok: false, kind: "transient", message: String((e && e.message) || e), noAnswer: true })
      );
    } catch (e) {
      finish({ ok: false, kind: "transient", message: String(e.message || e), noAnswer: true });
    }
  });
}

async function tabInfo(tabId) {
  if (tabId == null) return null;
  try { return await chrome.tabs.get(tabId); } catch (_) { return null; }
}

const isXUrl = (u) => /^https:\/\/(x|twitter)\.com\//.test(u || "");

async function ping(tabId) {
  const r = await sendTab(tabId, { x7: "ping" }, 3500);
  return r && r.ok ? r : null;
}

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CS_FILES });
    return true;
  } catch (_) { return false; }
}

async function usable(tabId) {
  const tab = await tabInfo(tabId);
  if (!tab || !isXUrl(tab.url) || tab.discarded) return null;
  let p = await ping(tabId);
  if (!p && tab.status === "complete") {
    if (await inject(tabId)) p = await ping(tabId);
  }
  return p ? tab : null;
}

function waitReady(tabId, match, timeoutMs) {
  return new Promise((resolve) => {
    const list = readyWaiters.get(tabId) || [];
    const entry = { match, resolve: null };
    const t = setTimeout(() => {
      const l = readyWaiters.get(tabId) || [];
      readyWaiters.set(tabId, l.filter((e) => e !== entry));
      resolve(false);
    }, timeoutMs);
    entry.resolve = (ok) => { clearTimeout(t); resolve(ok); };
    list.push(entry);
    readyWaiters.set(tabId, list);
  });
}

function resolveReady(tabId, url) {
  const list = readyWaiters.get(tabId);
  if (!list || !list.length) return;
  const keep = [];
  for (const e of list) {
    if (!e.match || e.match(url)) e.resolve(true); else keep.push(e);
  }
  readyWaiters.set(tabId, keep);
}

// Wait until the tab's content script answers from a page matching `match`.
// Races the "ready" announcement against polling, because the page can
// finish loading before anyone is listening for the announcement.
async function waitTabReady(tabId, match, timeoutMs, readyPromise) {
  const until = Date.now() + (timeoutMs || 45000);
  let announced = false;
  if (readyPromise) readyPromise.then((ok) => { if (ok) announced = true; });
  while (Date.now() < until) {
    if (announced) return true;
    const tab = await tabInfo(tabId);
    if (!tab) return false;
    if (tab.status === "complete" && (!match || match(tab.url))) {
      const p = await ping(tabId);
      if (p && (!match || match(p.url))) return true;
      if (!p && await inject(tabId)) {
        const p2 = await ping(tabId);
        if (p2 && (!match || match(p2.url))) return true;
      }
    }
    await sleep(1200);
  }
  return false;
}

// Navigate a tab and wait until our content script reports from the new page.
async function navigate(tabId, url, match, timeoutMs) {
  const ready = waitReady(tabId, match, timeoutMs || 45000);
  try { await chrome.tabs.update(tabId, { url }); } catch (_) { return false; }
  await sleep(400);
  return waitTabReady(tabId, match, timeoutMs || 45000, ready);
}

// Returns { tabId, created } or null.
async function acquireTab(preferId, opts) {
  opts = opts || {};
  if (preferId != null) {
    const t = await usable(preferId);
    if (t) return { tabId: t.id, created: false };
  }
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: X_URLS }); } catch (_) {}
  // Visible tabs first (least likely to be frozen), then most recently used.
  tabs.sort((a, b) => (b.active - a.active) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
  for (const t of tabs) {
    if (t.id === preferId) continue;
    if (await usable(t.id)) return { tabId: t.id, created: false };
  }
  // A discarded X tab can be woken up.
  const sleeping = tabs.find((t) => t.discarded);
  if (sleeping) {
    const ready = waitReady(sleeping.id, null, 40000);
    try { await chrome.tabs.reload(sleeping.id); } catch (_) {}
    if (await ready && await usable(sleeping.id)) return { tabId: sleeping.id, created: false };
  }
  if (!opts.create) return null;
  try {
    const tab = await chrome.tabs.create({ url: "https://x.com/home", active: !!opts.active });
    const ok = await waitReady(tab.id, null, 45000);
    if (ok || await usable(tab.id)) return { tabId: tab.id, created: true };
  } catch (_) {}
  return null;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  readyWaiters.delete(tabId);
  const job = await load(K.job, null);
  if (job && (job.tabId === tabId || job.workerTabId === tabId)) {
    if (job.tabId === tabId) { job.tabId = null; job.ownTab = false; }
    if (job.workerTabId === tabId) job.workerTabId = null;
    await save({ [K.job]: job });
  }
});

// ===========================================================================
// Badge
// ===========================================================================
function short(n) {
  n = Number(n) || 0;
  if (n >= 10000) return Math.floor(n / 1000) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function setBadge(text, color, title) {
  try {
    chrome.action.setBadgeText({ text: text || "" }).catch(() => {});
    if (color) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: "#FFFFFF" }).catch(() => {});
    chrome.action.setTitle({ title: title || "X Mass Unfollow" }).catch(() => {});
  } catch (_) {}
}

async function refreshBadge() {
  const scan = await load(K.scan, null);
  const job = await load(K.job, null);
  if (scan && scan.status === "running") return setBadge(short(scan.fetched || 0), COLORS.scan, "Scanning your following list");
  if (!job) return setBadge("");
  switch (job.status) {
    case "running": return setBadge(short(job.done), COLORS.run, `Unfollowing - ${job.done} of ${job.total}`);
    case "resting": return setBadge(short(job.done), COLORS.rest, job.message || "Resting");
    case "paused":  return setBadge("||", COLORS.paused, "Paused");
    case "halted":  return setBadge("!", COLORS.halt, job.message || "Needs your attention");
    case "done":
      setBadge("✓", COLORS.done, job.message || "Finished");
      chrome.alarms.create("x7.badgeClear", { when: Date.now() + 5 * 60000 });
      return;
    default: return setBadge("");
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[K.job] || changes[K.scan]) refreshBadge();
  // Data deleted from the dashboard: drop the in-memory copies too.
  if (changes[K.scanUsers] && changes[K.scanUsers].newValue === undefined) { mem.scanUsers = null; mem.scanSeen = null; }
  if (changes[K.doneIds] && changes[K.doneIds].newValue === undefined) mem.doneIds = null;
});

// ===========================================================================
// Account
// ===========================================================================
async function refreshAccount(tabId) {
  const who = await sendTab(tabId, { x7: "whoami", deep: true }, 30000);
  if (who && who.ok && who.signedIn) {
    const prev = await load(K.account, null);
    const acc = {
      id: who.id, handle: who.handle || (prev && prev.id === who.id ? prev.handle : ""),
      name: who.name || (prev && prev.id === who.id ? prev.name : ""),
      avatar: who.avatar || (prev && prev.id === who.id ? prev.avatar : ""),
      followers: who.followers != null ? who.followers : (prev && prev.id === who.id ? prev.followers : null),
      following: who.following != null ? who.following : (prev && prev.id === who.id ? prev.following : null),
      at: Date.now()
    };
    await save({ [K.account]: acc });
    return acc;
  }
  if (who && who.ok && !who.signedIn) {
    await save({ [K.account]: { id: null, signedOut: true, at: Date.now() } });
  }
  return null;
}

// ===========================================================================
// SCAN
// ===========================================================================
function scanSummary(users) {
  let non = 0, mutual = 0, unknown = 0;
  for (const u of users) {
    if (u.fy === false) non++; else if (u.fy === true) mutual++; else unknown++;
  }
  return { total: users.length, nonFollowers: non, mutuals: mutual, unknown };
}

async function startScan(opts) {
  opts = opts || {};
  const job = await load(K.job, null);
  if (job && ACTIVE_JOB.has(job.status)) return { ok: false, error: "A run is in progress. Pause or stop it first." };
  const cur = await load(K.scan, null);
  if (cur && cur.status === "running") return { ok: true, already: true };

  const got = await acquireTab(null, { create: true });
  if (!got) return { ok: false, error: "Couldn't open X. Check that x.com loads in this browser." };
  const acc = await refreshAccount(got.tabId);
  if (!acc) return { ok: false, error: "You're not signed in to X. Sign in at x.com, then scan again.", needLogin: true };

  mem.scanUsers = [];
  mem.scanSeen = new Set();
  mem.followerIds = null;
  mem.liveCursor = undefined;
  const scan = {
    status: "running", method: "api", phase: "following",
    ownerId: acc.id, handle: acc.handle, expected: acc.following,
    startedAt: Date.now(), cursor: null, pages: 0, fetched: 0, errors: 0, emptyPages: 0,
    tabId: got.tabId, ownTab: got.created, then: opts.then || null,
    message: "Reading your following list..."
  };
  await save({ [K.scan]: scan, [K.scanUsers]: [] });
  keepAlive(true);
  scheduleTick(0);
  return { ok: true };
}

async function checkpointScan(scan) {
  scan.cursor = mem.liveCursor === undefined ? scan.cursor : mem.liveCursor;
  await save({ [K.scan]: scan, [K.scanUsers]: mem.scanUsers });
}

function addScanUsers(list) {
  let fresh = 0;
  for (const u of list || []) {
    if (!u || !u.i || mem.scanSeen.has(u.i)) continue;
    mem.scanSeen.add(u.i);
    mem.scanUsers.push(u);
    fresh++;
  }
  return fresh;
}

async function scanFail(scan, message, keepPartial) {
  scan.status = keepPartial && mem.scanUsers && mem.scanUsers.length ? "done" : "error";
  if (scan.status === "done") {
    scan.partial = true;
    Object.assign(scan, scanSummary(mem.scanUsers));
  }
  scan.error = message;
  scan.message = message;
  scan.finishedAt = Date.now();
  scan.then = null;
  await checkpointScan(scan);
  await closeOwnTab(scan.ownTab ? scan.tabId : null);
  keepAlive(false);
}

async function closeOwnTab(tabId) {
  if (tabId == null) return;
  const job = await load(K.job, null);
  if (job && ACTIVE_JOB.has(job.status) && (job.tabId === tabId || job.workerTabId === tabId)) return;
  try { await chrome.tabs.remove(tabId); } catch (_) {}
}

async function finishScan(scan) {
  const users = await getScanUsers();
  if (scan.phase === "followers" && mem.followerIds) {
    for (const u of users) u.fy = mem.followerIds.has(u.i);
    mem.followerIds = null;
  }
  Object.assign(scan, scanSummary(users), {
    status: "done", finishedAt: Date.now(), message: "Scan complete.",
    seconds: Math.round((Date.now() - scan.startedAt) / 1000)
  });
  const then = scan.then;
  scan.then = null;
  await checkpointScan(scan);
  if (then && then.source) {
    const r = await startJob({ source: then.source, keepTabId: scan.tabId, ownTab: scan.ownTab });
    if (!r.ok) {
      scan.message = r.error;
      await save({ [K.scan]: scan });
      await closeOwnTab(scan.ownTab ? scan.tabId : null);
    }
  } else {
    await closeOwnTab(scan.ownTab ? scan.tabId : null);
  }
}

async function scanStep(scan) {
  const now = Date.now();
  await getScanUsers();
  if (scan.waitUntil && now < scan.waitUntil) { scheduleTick(scan.waitUntil - now); return; }
  scan.waitUntil = null;

  if (scan.method === "dom") return domScanStep(scan);

  const got = await acquireTab(scan.tabId, { create: true });
  if (!got) {
    scan.errors++;
    if (scan.errors > 8) return scanFail(scan, "Couldn't reach an X tab to read your list.", true);
    scan.message = "Waiting for an X tab...";
    await save({ [K.scan]: scan });
    scheduleTick(8000);
    return;
  }
  if (got.tabId !== scan.tabId) { scan.tabId = got.tabId; scan.ownTab = got.created; }

  if (scan.phase === "followers" && !mem.followerIds) {
    // The worker restarted mid-phase; the follower set lives in memory only.
    mem.followerIds = new Set();
    mem.liveCursor = null;
  }
  const op = scan.phase === "followers" ? "Followers" : "Following";
  const cursor = mem.liveCursor === undefined ? scan.cursor : mem.liveCursor;
  const r = await sendTab(scan.tabId, { x7: "page", op, userId: scan.ownerId, cursor, count: 100 }, 90000);

  if (r.uid && r.uid !== scan.ownerId) return scanFail(scan, "You switched X accounts during the scan. Scan again.", false);

  if (r.ok) {
    scan.errors = 0;
    scan.pages++;
    let fresh = 0;
    if (scan.phase === "followers") {
      for (const u of r.users) mem.followerIds.add(u.i);
      fresh = r.users.length;
      scan.followersRead = mem.followerIds.size;
      scan.message = `Checking who follows you back... ${scan.followersRead.toLocaleString()}`;
    } else {
      fresh = addScanUsers(r.users);
      scan.fetched = mem.scanUsers.length;
      scan.message = `Read ${scan.fetched.toLocaleString()}${scan.expected ? " of ~" + scan.expected.toLocaleString() : ""} accounts`;
    }
    scan.emptyPages = fresh ? 0 : scan.emptyPages + 1;
    mem.liveCursor = r.cursor;

    if (r.end || scan.emptyPages >= 3 || scan.pages > 2000) {
      if (scan.phase === "following") {
        const n = mem.scanUsers.length;
        const unknown = mem.scanUsers.filter((u) => u.fy === null).length;
        const mutual = mem.scanUsers.filter((u) => u.fy === true).length;
        const acc = await load(K.account, null);
        const hasFollowers = !acc || acc.followers == null || acc.followers > 0;
        // If X left out the "follows you" flag - or reports that nobody in a
        // sizeable list follows back, which usually means the flag moved -
        // work it out from the followers list, so no mutual is ever lost.
        if (n && (unknown === n || (n >= 30 && mutual === 0 && hasFollowers))) {
          scan.phase = "followers";
          mem.followerIds = new Set();
          mem.liveCursor = null;
          scan.cursor = null;
          scan.message = "Checking who follows you back...";
          await save({ [K.scan]: scan, [K.scanUsers]: mem.scanUsers });
          scheduleTick(rand(800, 1500));
          return;
        }
      }
      return finishScan(scan);
    }

    if (scan.phase === "following" && scan.pages % 10 === 0) await checkpointScan(scan);
    else await save({ [K.scan]: { ...scan, cursor: scan.cursor } });

    let gap = rand(700, 1500);
    if (r.rate && r.rate.remaining !== null && r.rate.remaining <= 1 && r.rate.resetAt) {
      gap = Math.max(gap, r.rate.resetAt - Date.now() + 3000);
      scan.waitUntil = Date.now() + gap;
      scan.message = `X asked for a short break. Continuing at ${clock(scan.waitUntil)}.`;
      await checkpointScan(scan);
    }
    scheduleTick(gap);
    return;
  }

  switch (r.kind) {
    case "rate": {
      const ms = Math.min(Math.max(r.waitMs || 15 * 60000, 60000), 3 * 3600000);
      scan.waitUntil = Date.now() + ms;
      scan.message = `X asked for a short break. Continuing at ${clock(scan.waitUntil)}.`;
      await checkpointScan(scan);
      scheduleTick(ms);
      return;
    }
    case "auth":
      return scanFail(scan, "You're signed out of X. Sign in, then scan again.", true);
    case "locked":
    case "suspended":
      return scanFail(scan, "X has restricted this account. Open x.com and follow X's instructions first.", true);
    case "endpoint":
      if (scan.phase === "followers") {
        // Could not resolve relationships: keep what we have, flagged.
        mem.followerIds = null;
        scan.phase = "following";
        scan.relationshipUnknown = true;
        return finishScan(scan);
      }
      return switchToDomScan(scan, r.message);
    default: {
      scan.errors++;
      if (r.noAnswer) scan.tabId = null;
      if (scan.errors > 8) return scanFail(scan, "X kept failing to load your list. Try again in a few minutes.", true);
      scan.message = "X was slow to answer. Retrying...";
      await save({ [K.scan]: scan });
      scheduleTick(Math.min(60000, 3000 * scan.errors));
    }
  }
}

// ---- fallback: read the list by scrolling the Following page -------------
async function switchToDomScan(scan, why) {
  console.warn("[x7] API read unavailable, falling back to page scan:", why);
  const acc = await load(K.account, null);
  const handle = scan.handle || (acc && acc.handle);
  if (!handle) return scanFail(scan, "Couldn't read your list. Open your profile on X once, then scan again.", true);
  scan.method = "dom";
  scan.handle = handle;
  scan.stale = 0;
  scan.steps = 0;
  scan.domTab = null;
  scan.apiError = why || null;
  scan.message = "Reading your list from the Following page. Keep that X tab in front until it finishes.";
  await save({ [K.scan]: scan });
  scheduleTick(0);
}

async function domScanStep(scan) {
  const url = `https://x.com/${scan.handle}/following`;
  const onPage = (u) => new RegExp(`^https://(x|twitter)\\.com/${scan.handle}/following/?(\\?|$)`, "i").test(u || "");

  let tab = scan.domTab != null ? await tabInfo(scan.domTab) : null;
  if (!tab) {
    // Use the X tab in front if there is one, otherwise open one in front:
    // X only renders the list in a visible tab.
    let candidate = null;
    try {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active && isXUrl(active.url)) candidate = active;
    } catch (_) {}
    if (!candidate) {
      try { candidate = await chrome.tabs.create({ url, active: true }); } catch (_) {}
    }
    if (!candidate) return scanFail(scan, "Couldn't open your Following page.", true);
    scan.domTab = candidate.id;
    if (!onPage(candidate.url)) {
      if (!await navigate(candidate.id, url, onPage, 45000)) {
        scan.errors++;
        if (scan.errors > 5) return scanFail(scan, "Your Following page didn't load.", true);
      }
    } else if (!await usable(candidate.id)) {
      await inject(candidate.id);
    }
    await sendTab(scan.domTab, { x7: "domScanReset" }, 5000);
    await save({ [K.scan]: scan });
    scheduleTick(2500);
    return;
  }
  if (!onPage(tab.url)) {
    if (!await navigate(tab.id, url, onPage, 45000)) {
      scan.errors++;
      if (scan.errors > 5) return scanFail(scan, "Your Following page didn't load.", true);
    }
    await save({ [K.scan]: scan });
    scheduleTick(2500);
    return;
  }

  const r = await sendTab(tab.id, { x7: "domScanStep", handle: scan.handle, settleMs: 1100 }, 30000);
  if (r.uid && r.uid !== scan.ownerId) return scanFail(scan, "You switched X accounts during the scan. Scan again.", false);
  if (!r.ok) {
    if (r.kind === "auth" || r.kind === "locked" || r.kind === "suspended") {
      return scanFail(scan, "X needs your attention in the open tab. Sort it out, then scan again.", true);
    }
    scan.errors++;
    if (scan.errors > 10) return scanFail(scan, "Couldn't read the Following page.", true);
    if (r.noAnswer && !await usable(tab.id)) await inject(tab.id);
    await save({ [K.scan]: scan });
    scheduleTick(2000);
    return;
  }
  scan.errors = 0;
  if (r.hidden) {
    scan.message = "Paused - bring the X tab to the front to keep scanning.";
    await save({ [K.scan]: scan });
    scheduleTick(2000);
    return;
  }

  const fresh = addScanUsers(r.users);
  scan.steps++;
  scan.fetched = mem.scanUsers.length;
  scan.stale = fresh ? 0 : scan.stale + 1;
  scan.message = `Read ${scan.fetched.toLocaleString()}${scan.expected ? " of ~" + scan.expected.toLocaleString() : ""} accounts (scrolling)`;

  const finished = r.empty || (scan.stale >= 8 && r.atBottom && !r.loading) || scan.stale >= 30 || scan.steps > 6000;
  if (finished) return finishScan(scan);
  if (scan.steps % 15 === 0) await checkpointScan(scan); else await save({ [K.scan]: scan });
  scheduleTick(250);
}

async function stopScan() {
  const scan = await load(K.scan, null);
  if (!scan || scan.status !== "running") return { ok: true };
  await getScanUsers();
  if (mem.scanUsers.length) {
    scan.partial = true;
    scan.then = null;
    mem.followerIds = null;
    if (scan.phase === "followers") { scan.phase = "following"; scan.relationshipUnknown = true; }
    await finishScan(scan);
    const s2 = await load(K.scan, null);
    s2.message = "Scan stopped early - results are partial.";
    await save({ [K.scan]: s2 });
  } else {
    scan.status = "idle";
    scan.message = "Scan stopped.";
    scan.then = null;
    await save({ [K.scan]: scan });
    await closeOwnTab(scan.ownTab ? scan.tabId : null);
  }
  return { ok: true };
}

// ===========================================================================
// ACTIVITY CHECK (Scanner -> Inactive)
//
// Reads, one profile at a time, when each account last posted. It is
// read-only: it never follows, unfollows or changes anything. Results are kept
// per account in K.actData, so a closed tab, a restarted worker or a later
// session never repeats work. tick() serves scans and unfollow runs first, so
// this only ever works while nothing else is.
//
// Nothing is guessed: an account whose last post can't be read is recorded as
// "na" with the reason, and is listed separately in the dashboard.
// ===========================================================================
const ACT_FRESH_MS = 7 * 24 * 3600000;   // a result younger than this is not read again
const actMem = { data: null, byId: null, src: null };

async function getActData() {
  if (!actMem.data) {
    const d = await load(K.actData, {});
    actMem.data = d && typeof d === "object" && !Array.isArray(d) ? d : {};
  }
  return actMem.data;
}

async function startAct(opts) {
  opts = opts || {};
  const scan = await load(K.scan, null);
  if (scan && scan.status === "running") return { ok: false, error: "Wait for the scan to finish." };
  if (!scan || scan.status !== "done") return { ok: false, error: "Scan your following list first." };
  const job = await load(K.job, null);
  if (job && ACTIVE_JOB.has(job.status)) return { ok: false, error: "A run is in progress. Pause or stop it first." };
  const cur = await load(K.act, null);
  if (cur && cur.status === "running") return { ok: true, already: true };

  const got = await acquireTab(null, { create: true });
  if (!got) return { ok: false, error: "Couldn't open X. Check that x.com loads in this browser." };
  const p = await ping(got.tabId);
  const uid = p && p.uid;
  if (!uid) { if (got.created) await closeOwnTab(got.tabId); return { ok: false, error: "You're not signed in to X. Sign in at x.com first.", needLogin: true }; }
  if (scan.ownerId && scan.ownerId !== uid) {
    if (got.created) await closeOwnTab(got.tabId);
    return { ok: false, error: "Your scan is for a different X account. Scan again first." };
  }

  actMem.data = null;
  const [users, wl, done, data] = await Promise.all([getScanUsers(), getWhitelist(), getDoneIds(), getActData()]);
  const scope = opts.scope === "all" ? "all" : "non";
  const retry = !!opts.retry;
  const now = Date.now();
  const queue = [];
  for (const u of users) {
    if (done.has(u.i) || wl.has(String(u.h).toLowerCase())) continue;
    const r = data[u.i];
    if (retry) { if (r && r.s === "na") queue.push(u.i); continue; }       // retry: only the unavailable ones
    if (scope === "non" && u.fy !== false) continue;
    if (r && r.s !== "na" && now - r.at < ACT_FRESH_MS) continue;            // fresh enough
    if (r && r.s === "na") continue;                                         // unavailable: only on an explicit retry
    queue.push(u.i);
  }
  if (!queue.length) {
    if (got.created) await closeOwnTab(got.tabId);
    return { ok: true, none: true, total: 0 };
  }

  const act = {
    status: "running", scope, retry, ownerId: uid, queue, total: queue.length, index: 0,
    ok: 0, none: 0, na: 0, errors: 0, consecutiveFails: 0, startedAt: now,
    tabId: got.tabId, ownTab: got.created, message: "Checking when accounts last posted..."
  };
  await save({ [K.act]: act });
  keepAlive(true);
  scheduleTick(0);
  return { ok: true, total: queue.length };
}

async function finishAct(act, status, message) {
  act.status = status;
  act.finishedAt = Date.now();
  act.queue = [];
  act.message = message || (status === "done"
    ? `Done. ${act.ok.toLocaleString()} read, ${(act.na + act.none).toLocaleString()} without a date.`
    : "Stopped.");
  await save({ [K.act]: act });
  keepAlive(false);
  await closeOwnTab(act.ownTab ? act.tabId : null);
  actMem.data = null;
}

async function stopAct() {
  const act = await load(K.act, null);
  if (!act || act.status !== "running") return { ok: true };
  await finishAct(act, "stopped", `Stopped after ${act.index.toLocaleString()} account${act.index === 1 ? "" : "s"}. What was read is kept.`);
  return { ok: true };
}

async function actStep(act) {
  if (act.index >= act.queue.length) return finishAct(act, "done");
  const users = await getScanUsers();
  if (actMem.src !== users) { actMem.src = users; actMem.byId = new Map(users.map((u) => [u.i, u])); }
  const id = act.queue[act.index];
  const u = actMem.byId.get(id);
  const [wl, done] = await Promise.all([getWhitelist(), getDoneIds()]);
  if (!u || done.has(id) || wl.has(String(u.h).toLowerCase())) {        // gone, unfollowed or protected since the queue was built
    act.index++;
    await save({ [K.act]: act });
    scheduleTick(0);
    return;
  }

  const got = await acquireTab(act.tabId, { create: true });
  if (!got) {
    act.errors++;
    if (act.errors > 8) return finishAct(act, "error", "Couldn't reach an X tab. What was read is kept.");
    act.message = "Waiting for an X tab...";
    await save({ [K.act]: act });
    scheduleTick(8000);
    return;
  }
  if (got.tabId !== act.tabId) { act.tabId = got.tabId; act.ownTab = got.created; }

  const r = await sendTab(act.tabId, { x7: "lastPost", userId: u.i, posts: typeof u.sc === "number" ? u.sc : null }, 60000);
  if (r.uid && r.uid !== act.ownerId) return finishAct(act, "error", "You switched X accounts. Check again.");

  const data = await getActData();
  const advance = async (rec, gap) => {
    data[id] = Object.assign(rec, { at: Date.now() });
    act.index++;
    act.errors = 0;
    act.message = `Checked ${act.index.toLocaleString()} of ${act.total.toLocaleString()}`;
    await save({ [K.actData]: data, [K.act]: act });
    if (act.index >= act.queue.length) return finishAct(act, "done");
    scheduleTick(gap);
  };

  if (r.ok) {
    act.consecutiveFails = 0;
    let rec;
    if (r.state === "ok") { rec = { t: r.t, s: "ok" }; act.ok++; }
    else if (r.state === "none") { rec = { t: null, s: "none" }; act.none++; }
    else { rec = { t: null, s: "na", w: String(r.why || "Unavailable").slice(0, 80) }; act.na++; }
    let gap = rand(1100, 2400);
    if (r.rate && r.rate.remaining !== null && r.rate.remaining <= 1 && r.rate.resetAt) {
      gap = Math.max(gap, r.rate.resetAt - Date.now() + 3000);
      act.waitUntil = Date.now() + gap;
    }
    return advance(rec, gap);
  }

  switch (r.kind) {
    case "rate": {
      const ms = Math.min(Math.max(r.waitMs || 15 * 60000, 60000), 3 * 3600000);
      act.waitUntil = Date.now() + ms;
      act.message = `X asked for a short break. Continuing at ${clock(act.waitUntil)}.`;
      await save({ [K.act]: act });
      scheduleTick(ms);
      return;
    }
    case "auth":
      return finishAct(act, "error", "You're signed out of X. Sign in, then check again. What was read is kept.");
    case "locked":
    case "suspended":
      return finishAct(act, "error", "X has restricted this account. Open x.com and follow X's instructions first.");
    case "gone":
      act.na++;
      return advance({ t: null, s: "na", w: "Account not found" }, rand(900, 1600));
    case "endpoint":
      act.consecutiveFails++;
      if (act.consecutiveFails >= 5) {
        return finishAct(act, "error", "X isn't returning profile posts right now. Try again later. What was read is kept.");
      }
      act.na++;
      return advance({ t: null, s: "na", w: "X didn't return this profile's posts" }, rand(1500, 3000));
    default:
      act.errors++;
      if (r.noAnswer) act.tabId = null;
      if (act.errors > 6) return finishAct(act, "error", "X kept failing to answer. Try again in a few minutes. What was read is kept.");
      act.message = "X was slow to answer. Retrying...";
      await save({ [K.act]: act });
      scheduleTick(Math.min(60000, 3000 * act.errors));
  }
}

// ===========================================================================
// RUN (the unfollow queue)
// ===========================================================================
async function buildTargets(source, payload) {
  const settings = await getSettings();
  const wl = await getWhitelist();
  const done = await getDoneIds();
  const users = await getScanUsers();
  let list = [];

  if (source === "nonfollowers" || source === "all") {
    for (const u of users) {
      if (source === "nonfollowers" && u.fy !== false) continue;
      if (done.has(u.i)) continue;
      if (X7.keepReason(u, settings, wl)) continue;
      list.push(u);
    }
  } else if (source === "ids") {
    const want = new Set((payload.ids || []).map(String));
    for (const u of users) if (want.has(u.i) && !done.has(u.i) && !wl.has(u.h.toLowerCase())) list.push(u);
  } else if (source === "handles") {
    const seen = new Set();
    const byHandle = new Map(users.map((u) => [u.h.toLowerCase(), u]));
    for (const raw of payload.handles || []) {
      const h = X7.cleanHandle(raw);
      if (!h) continue;
      const k = h.toLowerCase();
      if (seen.has(k) || wl.has(k)) continue;
      seen.add(k);
      const known = byHandle.get(k);
      if (known && done.has(known.i)) continue;
      list.push(known || { i: null, h, n: "", a: "" });
    }
  }
  return list.map((u) => ({ i: u.i || null, h: u.h, n: u.n || "", a: u.a || "" }));
}

async function startJob(opts) {
  const source = opts.source;
  const scan = await load(K.scan, null);
  if (scan && scan.status === "running") return { ok: false, error: "Wait for the scan to finish." };
  const cur = await load(K.job, null);
  if (cur && ACTIVE_JOB.has(cur.status)) return { ok: false, error: "A run is already in progress." };

  // Make sure we act as the account the scan belongs to.
  const got = await acquireTab(opts.keepTabId != null ? opts.keepTabId : null, { create: true });
  if (!got) return { ok: false, error: "Couldn't open X. Check that x.com loads in this browser." };
  const p = await ping(got.tabId);
  const uid = p && p.uid;
  if (!uid) return { ok: false, error: "You're not signed in to X. Sign in at x.com first.", needLogin: true };
  if (source !== "handles" && scan && scan.ownerId && scan.ownerId !== uid) {
    return { ok: false, error: "Your scan is for a different X account. Scan again first." };
  }

  const queue = await buildTargets(source, opts);
  if (!queue.length) {
    if (got.created) await closeOwnTab(got.tabId);
    return { ok: false, error: source === "nonfollowers"
      ? "Everyone left either follows you back or is protected by your Keep rules."
      : "Nothing to unfollow." };
  }

  const job = {
    id: Date.now().toString(36), status: "running", source, ownerId: uid,
    total: queue.length, index: 0, done: 0, skipped: 0, failed: 0,
    startedAt: Date.now(), nextAt: Date.now(), sinceRest: 0,
    executor: "api", tabId: got.tabId, ownTab: !!(got.created || opts.ownTab), workerTabId: null,
    consecutiveFails: 0, targetFails: 0, rateHits: 0, tabWaits: 0,
    current: null, inFlight: null, message: "Starting...", log: []
  };
  await save({ [K.queue]: queue, [K.job]: job });
  keepAlive(true);
  scheduleTick(300);
  return { ok: true, total: queue.length };
}

function logLine(job, h, r, m) {
  job.log.unshift({ t: Date.now(), h, r, m });
  if (job.log.length > 40) job.log.length = 40;
}

async function finishJob(job, status, message) {
  job.status = status;
  job.message = message;
  job.finishedAt = Date.now();
  job.current = null;
  job.inFlight = null;
  await save({ [K.job]: job });
  keepAlive(false);
  if (job.workerTabId != null) { try { await chrome.tabs.remove(job.workerTabId); } catch (_) {} job.workerTabId = null; }
  if (job.ownTab && job.tabId != null) { try { await chrome.tabs.remove(job.tabId); } catch (_) {} }
  job.tabId = null;
  job.ownTab = false;
  await save({ [K.job]: job });
}

async function profileExec(job, t) {
  if (!t.h) return { ok: false, kind: "transient", message: "no handle" };
  const url = "https://x.com/" + encodeURIComponent(t.h);
  const match = (u) => {
    try { return new URL(u).pathname.split("/")[1].toLowerCase() === t.h.toLowerCase(); } catch (_) { return false; }
  };
  // A dedicated background tab, so the user's own X tab is never navigated.
  let wt = job.workerTabId != null && await tabInfo(job.workerTabId) ? job.workerTabId : null;
  if (wt == null) {
    let tab;
    try { tab = await chrome.tabs.create({ url, active: false }); }
    catch (_) { return { ok: false, kind: "transient", message: "couldn't open a tab" }; }
    wt = tab.id;
    job.workerTabId = wt;
    await save({ [K.job]: job });
    if (!await waitTabReady(wt, match, 45000, waitReady(wt, match, 45000))) {
      return { ok: false, kind: "transient", message: "the profile page didn't load" };
    }
  } else if (!await navigate(wt, url, match, 45000)) {
    return { ok: false, kind: "transient", message: "the profile page didn't load" };
  }
  await sleep(rand(900, 1600));
  return sendTab(wt, { x7: "profileUnfollow", id: t.i, h: t.h }, 50000);
}

// Save the run's progress without undoing a Pause/Stop the user pressed while
// a request was in flight.
async function commitJob(job) {
  const latest = await load(K.job, null);
  if (!latest || latest.id !== job.id) return false;
  if (!ACTIVE_JOB.has(latest.status)) {
    job.status = latest.status;
    job.message = latest.message;
    job.finishedAt = latest.finishedAt;
    job.tabId = latest.tabId;
    job.workerTabId = latest.workerTabId;
    job.ownTab = latest.ownTab;
    job.restUntil = null;
  }
  await save({ [K.job]: job });
  return true;
}

async function jobStep(job) {
  const now = Date.now();
  if (job.status === "resting") {
    if (job.restUntil && now < job.restUntil) { scheduleTick(job.restUntil - now); return; }
    job.status = "running";
    job.restReason = null;
    job.restUntil = null;
    job.message = "Back to work.";
  }
  if (job.nextAt && now < job.nextAt) { scheduleTick(job.nextAt - now); return; }

  const settings = await getSettings();

  // Daily cap (rolling 24h). Rest until a slot frees, then carry on.
  const ledger = await getLedger();
  if (settings.dailyLimit > 0 && ledger.length >= settings.dailyLimit) {
    const freeAt = ledger[ledger.length - settings.dailyLimit] + 86400000 + 30000;
    job.status = "resting";
    job.restReason = "daily";
    job.restUntil = Math.max(freeAt, now + 60000);
    job.message = `Daily limit of ${settings.dailyLimit} reached. Continues automatically at ${clock(job.restUntil)}.`;
    await save({ [K.job]: job });
    scheduleTick(job.restUntil - now);
    return;
  }

  // Scheduled rest.
  if (settings.restEvery > 0 && job.sinceRest >= settings.restEvery) {
    const mins = settings.restMinutes * rand(0.85, 1.2);
    job.status = "resting";
    job.restReason = "cooldown";
    job.restUntil = now + mins * 60000;
    job.sinceRest = 0;
    job.message = `Short break after ${settings.restEvery} unfollows. Back at ${clock(job.restUntil)}.`;
    await save({ [K.job]: job });
    scheduleTick(job.restUntil - now);
    return;
  }

  // Next target, skipping anyone whitelisted or already done since queuing.
  const queue = await load(K.queue, []);
  const wl = await getWhitelist();
  const done = await getDoneIds();
  while (job.index < queue.length) {
    const t = queue[job.index];
    if (wl.has(String(t.h).toLowerCase())) { job.skipped++; job.index++; logLine(job, t.h, "skip", "on your whitelist"); continue; }
    if (t.i && done.has(t.i)) { job.skipped++; job.index++; continue; }
    break;
  }
  if (job.index >= queue.length) {
    return finishJob(job, "done", `Finished. Unfollowed ${job.done.toLocaleString()} account${job.done === 1 ? "" : "s"}.`);
  }
  const t = queue[job.index];
  job.current = t;

  const got = await acquireTab(job.tabId, { create: true });
  if (!got) {
    job.tabWaits = (job.tabWaits || 0) + 1;
    if (job.tabWaits > 12) {
      job.status = "halted";
      job.haltKind = "tab";
      job.message = "Couldn't reach x.com. Open x.com, then press Resume.";
      await save({ [K.job]: job });
      return;
    }
    job.message = "Waiting for an X tab...";
    job.nextAt = now + 15000;
    await save({ [K.job]: job });
    scheduleTick(15000);
    return;
  }
  job.tabWaits = 0;
  if (got.tabId !== job.tabId) { job.tabId = got.tabId; job.ownTab = got.created; }

  job.inFlight = { i: t.i, h: t.h, at: Date.now() };
  job.message = `Unfollowing @${t.h}...`;
  if (!await commitJob(job) || !ACTIVE_JOB.has(job.status)) return;

  let r = null;
  if (job.executor === "api") {
    r = await sendTab(job.tabId, { x7: "unfollow", id: t.i, h: t.h }, 45000);
    if (r && !r.ok && r.kind === "endpoint") {
      console.warn("[x7] direct unfollow rejected, switching to profile mode:", r.message);
      job.executor = "profile";
      await save({ [K.health]: { at: Date.now(), note: "Direct unfollow rejected by X (" + (r.status || "?") + "). Using profile mode." } });
    }
  }
  if (job.executor === "profile" && (!r || (!r.ok && r.kind === "endpoint"))) {
    r = await profileExec(job, t);
    if (r && !r.ok && r.kind === "endpoint") r.kind = "transient";
  }

  job.inFlight = null;
  r = r || { ok: false, kind: "transient", message: "no result" };

  if (r.uid && job.ownerId && r.uid !== job.ownerId) {
    job.status = "halted";
    job.haltKind = "account";
    job.message = "You switched to a different X account. Switch back, then press Resume.";
    await commitJob(job);
    return;
  }

  if (r.ok) {
    job.done++;
    job.index++;
    job.sinceRest++;
    job.consecutiveFails = 0;
    job.targetFails = 0;
    job.rateHits = 0;
    await pushLedger();
    await pushHistory({ ...t, i: t.i || r.id || null }, job.source);
    await addDone(t.i || r.id);
    logLine(job, t.h, "ok", "unfollowed");
    let delay = rand(settings.minDelay, settings.maxDelay);
    if (Math.random() < 0.08) delay *= rand(1.8, 3);            // an occasional longer pause
    job.nextAt = Date.now() + delay * 1000;
    job.message = `Unfollowed @${t.h}`;
  } else if (r.kind === "gone") {
    job.skipped++;
    job.index++;
    job.targetFails = 0;
    if (t.i) await addDone(t.i);
    logLine(job, t.h, "skip", r.message || "not following / unavailable");
    job.nextAt = Date.now() + rand(1500, 3500);
    job.message = `@${t.h} skipped - ${r.message || "already gone"}`;
  } else if (r.kind === "rate") {
    job.rateHits++;
    let ms = Math.max(r.waitMs || 15 * 60000, 5 * 60000);
    if (job.rateHits >= 3) ms *= 2;
    ms = Math.min(ms, 3 * 3600000);
    job.status = "resting";
    job.restReason = "rate";
    job.restUntil = Date.now() + ms;
    job.message = `X asked to slow down. Resting until ${clock(job.restUntil)}, then continuing automatically.`;
    logLine(job, t.h, "wait", "X rate limit");
  } else if (r.kind === "auth" || r.kind === "locked" || r.kind === "suspended" || r.kind === "challenge") {
    job.status = "halted";
    job.haltKind = r.kind;
    job.message = r.kind === "auth"
      ? "You're signed out of X. Sign in, then press Resume."
      : r.kind === "locked"
        ? "X is asking you to verify your account. Open x.com, complete X's check, wait a while, then press Resume."
        : "X has restricted this account. Stop and check x.com.";
    logLine(job, t.h, "fail", r.kind);
  } else {
    job.consecutiveFails++;
    job.targetFails++;
    if (r.noAnswer) job.tabId = null;
    if (job.targetFails >= 3) {
      job.failed++;
      job.index++;
      job.targetFails = 0;
      logLine(job, t.h, "fail", r.message || "failed");
    }
    if (job.consecutiveFails >= 24) {
      job.status = "halted";
      job.haltKind = "errors";
      job.message = "X keeps failing to respond. Check x.com in a tab, then press Resume.";
    } else if (job.consecutiveFails % 8 === 0) {
      job.status = "resting";
      job.restReason = "errors";
      job.restUntil = Date.now() + 10 * 60000;
      job.message = `X is having trouble. Retrying at ${clock(job.restUntil)}.`;
    } else {
      job.nextAt = Date.now() + Math.min(60000, 4000 * Math.pow(1.7, job.consecutiveFails - 1));
      job.message = `Couldn't unfollow @${t.h} (${r.message || "error"}). Retrying...`;
    }
  }

  // Show who is actually next, not the account just handled.
  job.current = job.index < queue.length ? queue[job.index] : null;

  if (job.status === "running" && job.index >= queue.length) {
    const latest = await load(K.job, null);
    if (latest && latest.id === job.id && ACTIVE_JOB.has(latest.status)) {
      return finishJob(job, "done", `Finished. Unfollowed ${job.done.toLocaleString()} account${job.done === 1 ? "" : "s"}.`);
    }
  }
  if (!await commitJob(job)) return;
  if (ACTIVE_JOB.has(job.status)) {
    const wake = job.status === "resting" ? job.restUntil - Date.now() : job.nextAt - Date.now();
    scheduleTick(Math.max(0, wake));
  } else {
    keepAlive(false);
  }
}

async function controlJob(action) {
  const job = await load(K.job, null);
  if (!job) return { ok: false, error: "Nothing is running." };
  if (action === "pause") {
    if (!ACTIVE_JOB.has(job.status)) return { ok: true };
    job.status = "paused";
    job.message = "Paused.";
  } else if (action === "resume") {
    if (!["paused", "halted"].includes(job.status)) return { ok: true };
    job.status = "running";
    job.haltKind = null;
    job.nextAt = Date.now();
    job.consecutiveFails = 0;
    job.tabWaits = 0;
    job.message = "Resuming...";
    await save({ [K.job]: job });
    keepAlive(true);
    scheduleTick(200);
    return { ok: true };
  } else if (action === "stop") {
    if (["done", "stopped"].includes(job.status)) return { ok: true };
    await finishJob(job, "stopped", `Stopped. Unfollowed ${job.done.toLocaleString()} account${job.done === 1 ? "" : "s"}.`);
    return { ok: true };
  }
  await save({ [K.job]: job });
  return { ok: true };
}

// ===========================================================================
// State for the UI
// ===========================================================================
async function uiState() {
  const [account, scan, job, settings, ledger, health, actFull] = await Promise.all([
    load(K.account, null), load(K.scan, null), load(K.job, null), getSettings(), getLedger(), load(K.health, null), load(K.act, null)
  ]);
  const act = actFull ? Object.assign({}, actFull, { queue: undefined }) : null;
  let actionable = null, actionableAll = null;
  if (scan && scan.status === "done") {
    const users = await getScanUsers();
    const wl = await getWhitelist();
    const done = await getDoneIds();
    actionable = 0; actionableAll = 0;
    for (const u of users) {
      if (done.has(u.i) || X7.keepReason(u, settings, wl)) continue;
      actionableAll++;
      if (u.fy === false) actionable++;
    }
  }
  return {
    ok: true, account, scan, job, settings, health, act,
    today: ledger.length, actionable, actionableAll,
    version: chrome.runtime.getManifest().version
  };
}

async function runHealth() {
  const got = await acquireTab(null, { create: true });
  if (!got) return { ok: false, error: "Couldn't open x.com." };
  const r = await sendTab(got.tabId, { x7: "health" }, 120000);
  const out = { at: Date.now(), ...r };
  await save({ [K.health]: out });
  if (got.created) await closeOwnTab(got.tabId);
  return { ok: true, health: out };
}

async function openX(path) {
  const url = "https://x.com/" + (path || "home");
  try {
    const [tab] = await chrome.tabs.query({ url: X_URLS, currentWindow: true });
    if (tab && !path) { await chrome.tabs.update(tab.id, { active: true }); return; }
  } catch (_) {}
  chrome.tabs.create({ url });
}

async function emergencyStop() {
  await stopScan();
  await controlJob("stop");
  await stopAct();
}

// ===========================================================================
// Messages
// ===========================================================================
const FETCH_ALLOWED = /^https:\/\/(abs(-\d+)?\.twimg\.com|x\.com|twitter\.com)\//;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return;

  // From content scripts -------------------------------------------------
  if (msg.x7 === "ready" && sender.tab) {
    resolveReady(sender.tab.id, msg.url || sender.tab.url);
    return;
  }
  if (msg.x7 === "fetchText") {
    if (typeof msg.url !== "string" || !FETCH_ALLOWED.test(msg.url)) {
      sendResponse({ ok: false, error: "blocked host" });
      return;
    }
    fetch(msg.url, { credentials: "omit", cache: "force-cache" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))))
      .then((text) => sendResponse({ ok: true, text }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  // From the popup / dashboard ------------------------------------------
  // Only the extension's own pages may command the engine; content scripts
  // (which run on x.com) never can.
  const fromExtensionPage = typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
  if (typeof msg.cmd !== "string" || !fromExtensionPage) return;
  const run = async () => {
    switch (msg.cmd) {
      case "state": pingActive(); return uiState();
      case "scan": return startScan({ then: msg.then || null });
      case "scanStop": return stopScan();
      case "run": return startJob({ source: msg.source, ids: msg.ids, handles: msg.handles });
      case "pause": return controlJob("pause");
      case "resume": return controlJob("resume");
      case "stop": return controlJob("stop");
      case "clearJob": {
        const job = await load(K.job, null);
        if (job && ACTIVE_JOB.has(job.status)) return { ok: false, error: "Stop the run first." };
        await chrome.storage.local.remove([K.job, K.queue]);
        return { ok: true };
      }
      case "actStart": return startAct({ scope: msg.scope, retry: !!msg.retry });
      case "actStop": return stopAct();
      case "health": return runHealth();
      case "syncTelemetry": X7Telemetry.syncUninstallUrl(); return { ok: true };
      case "refreshAccount": {
        const got = await acquireTab(null, { create: false });
        if (!got) return { ok: false, noTab: true };
        return { ok: true, account: await refreshAccount(got.tabId) };
      }
      case "openX": await openX(msg.path); return { ok: true };
      case "dashboard":
        chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html" + (msg.hash ? "#" + msg.hash : "")) });
        return { ok: true };
      default: return { ok: false, error: "unknown command" };
    }
  };
  run().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

chrome.commands?.onCommand.addListener((command) => {
  if (command === "emergency-stop") emergencyStop();
});

// ===========================================================================
// Install / update / startup
// ===========================================================================
async function migrateFromV6() {
  const meta = await load(K.meta, {});
  if (meta.migrated7) return;
  try {
    const sync = await chrome.storage.sync.get(null).catch(() => ({}));
    const local = await chrome.storage.local.get(null).catch(() => ({}));

    const settings = X7.normalizeSettings({
      keepVerified: !!sync.skipVerified,
      keepProtected: !!sync.skipProtected,
      keepKeywords: sync.keywordProtection ? (sync.protectedKeywords || "") : ""
    });
    const wl = String(sync.whitelistHandles || "").split(/[,\s\n]+/).map(X7.cleanHandle).filter(Boolean).map((h) => h.toLowerCase());
    const history = (Array.isArray(local.unfollowedProfiles) ? local.unfollowedProfiles : []).map((r) => ({
      i: null, h: r.username || "", n: r.name || "", a: "", t: Date.parse(r.unfollowedAt) || Date.now(), s: "v6"
    })).filter((r) => r.h);
    const ledger = (Array.isArray(local.actionLog) ? local.actionLog : []).filter((t) => t > Date.now() - 86400000);

    const patch = { [K.meta]: { migrated7: true, at: Date.now() } };
    if (!local[K.settings]) patch[K.settings] = settings;
    if (!local[K.whitelist]) patch[K.whitelist] = [...new Set(wl)];
    if (!local[K.history] && history.length) patch[K.history] = history.slice(-HISTORY_MAX);
    if (!local[K.ledger] && ledger.length) patch[K.ledger] = ledger;
    await chrome.storage.local.set(patch);

    const oldLocal = ["unfollowedProfiles", "actionLog", "unfollowedIndex", "lifetimeUnfollows", "lastScan", "listRun",
      "activeSession", "haltUntil", "haltKind", "xumpReload", "xumpDryCycles", "lastStopReport", "continuousDefaultReset",
      "dedupSeeded", "adsonbread_uid_legacy"];
    await chrome.storage.local.remove(oldLocal).catch(() => {});
    await chrome.storage.sync.clear().catch(() => {});
  } catch (e) {
    console.warn("[x7] migration skipped:", e);
    await save({ [K.meta]: { migrated7: true, at: Date.now(), failed: true } });
  }
}

async function injectIntoOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: X_URLS });
    for (const t of tabs) {
      if (t.discarded || t.status !== "complete") continue;
      chrome.scripting.executeScript({ target: { tabId: t.id }, files: CS_FILES }).catch(() => {});
    }
  } catch (_) {}
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await migrateFromV6();
  injectIntoOpenTabs();
  X7Telemetry.onInstall();
  setBadge("");
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html#welcome") }).catch(() => {});
  }
  // An update replaces the worker mid-run; pick the run back up.
  resumeOnWake();
});

// After a browser restart, a run is paused rather than resumed silently:
// nobody expects unfollowing to start by itself when they open Chrome.
chrome.runtime.onStartup.addListener(async () => {
  X7Telemetry.syncUninstallUrl();
  const job = await load(K.job, null);
  if (job && ACTIVE_JOB.has(job.status)) {
    job.status = "paused";
    job.message = "Paused because the browser restarted. Press Resume to continue.";
    job.tabId = null; job.workerTabId = null; job.ownTab = false;
    await save({ [K.job]: job });
  }
  const scan = await load(K.scan, null);
  if (scan && scan.status === "running") {
    scan.tabId = null; scan.domTab = null; scan.ownTab = false;
    await save({ [K.scan]: scan });
  }
  const act = await load(K.act, null);
  if (act && act.status === "running") {
    act.status = "stopped"; act.queue = []; act.tabId = null; act.ownTab = false;
    act.message = "Stopped because the browser restarted. What was read is kept.";
    await save({ [K.act]: act });
  }
  refreshBadge();
});

async function resumeOnWake() {
  const job = await load(K.job, null);
  const scan = await load(K.scan, null);
  if (job && job.inFlight && Date.now() - job.inFlight.at > 120000) {
    job.inFlight = null;
    await save({ [K.job]: job });
  }
  const act = await load(K.act, null);
  if ((scan && scan.status === "running") || (job && ACTIVE_JOB.has(job.status)) || (act && act.status === "running")) {
    keepAlive(true);
    scheduleTick(1500);
  }
  refreshBadge();
}

resumeOnWake();
