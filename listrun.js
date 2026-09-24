// X Unfollow Manager Pro - listrun.js (v6.16.0)
//
// Targeted unfollow from an explicit list of handles.
//
// This is a SEPARATE engine from the list-scrolling one in content.js. That
// one walks your Following page and decides who to remove as it goes. This
// one is handed a finite list of handles - imported from CSV, or taken
// straight from a scan - and works through it by visiting each profile in
// turn and unfollowing there.
//
// Why visit profiles at all
// -------------------------
// Because the input is a list of names, not a rendered page. There is no row
// to click. Going to x.com/<handle> puts the account's own follow button on
// screen, which is the same control the DOM engine uses, so the actual click
// path and its confirm dialog are shared rather than reimplemented.
//
// Navigation destroys the page, so this cannot be a loop. Each profile visit
// is one step of a state machine whose position lives in chrome.storage:
//
//   start -> navigate to handle[0]
//            page loads -> resume() sees an active run on the right profile
//                       -> unfollow -> record -> wait -> navigate to handle[1]
//            ...
//            index past the end -> finish
//
// That makes it naturally crash-proof: a closed tab, a reload, or a Chrome
// discard just means the next page load picks the run up where it stopped.

(function () {
  "use strict";

  const LR = {};
  const LIST_KEY = "listRun";

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  async function getRun() {
    try {
      const r = await chrome.storage.local.get(LIST_KEY);
      return r[LIST_KEY] || null;
    } catch (_) { return null; }
  }

  async function setRun(run) {
    try { await chrome.storage.local.set({ [LIST_KEY]: run }); } catch (_) {}
  }

  async function patchRun(patch) {
    const run = await getRun();
    if (!run) return null;
    const next = { ...run, ...patch, heartbeatTs: Date.now() };
    await setRun(next);
    return next;
  }

  async function clearRun() {
    try { await chrome.storage.local.remove(LIST_KEY); } catch (_) {}
  }

  LR.get = getRun;
  LR.clear = clearRun;

  // ---------------------------------------------------------------
  // Handle hygiene
  // ---------------------------------------------------------------
  function cleanHandle(raw) {
    if (!raw) return null;
    let h = String(raw).trim();
    if (!h) return null;
    // Accept a full profile URL, an @handle, or a bare handle.
    const m = h.match(/(?:twitter|x)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i);
    if (m) h = m[1];
    h = h.replace(/^@+/, "").trim();
    if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
    // Reserved paths that are not accounts.
    if (/^(home|explore|notifications|messages|settings|i|search|compose)$/i.test(h)) return null;
    return h;
  }

  LR.cleanHandle = cleanHandle;

  // ---------------------------------------------------------------
  // CSV parsing
  //
  // Deliberately tolerant: the file may be this extension's own export, a
  // spreadsheet the user edited, or a single column of handles pasted into a
  // text file. Quoted fields with embedded commas and newlines are handled,
  // because our own export produces them (bios contain commas).
  // ---------------------------------------------------------------
  function parseCsv(text) {
    const rows = [];
    let row = [], field = "", inQuotes = false;

    const src = String(text).replace(/^\uFEFF/, "");   // strip BOM

    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (inQuotes) {
        if (c === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
        continue;
      }
      if (c === '"') { inQuotes = true; continue; }
      if (c === ",") { row.push(field); field = ""; continue; }
      if (c === "\n" || c === "\r") {
        if (c === "\r" && src[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some((f) => f.trim() !== "")) rows.push(row);
        row = [];
        continue;
      }
      field += c;
    }
    row.push(field);
    if (row.some((f) => f.trim() !== "")) rows.push(row);
    return rows;
  }

  // Pull handles out of whatever shape the CSV is in.
  LR.handlesFromCsv = function (text) {
    const rows = parseCsv(text);
    if (!rows.length) return { handles: [], skipped: 0 };

    const header = rows[0].map((h) => h.trim().toLowerCase());
    // Recognise our own export, and common spreadsheet column names.
    const named = ["handle", "username", "screen_name", "user", "account"];
    let col = header.findIndex((h) => named.includes(h));
    let urlCol = header.findIndex((h) => /url|link|profile/.test(h));

    const looksLikeHeader = col >= 0 || urlCol >= 0 ||
      header.some((h) => named.includes(h) || /url|link|profile/.test(h));
    const body = looksLikeHeader ? rows.slice(1) : rows;

    const out = [];
    const seen = new Set();
    let skipped = 0;

    for (const r of body) {
      let h = null;
      if (col >= 0)         h = cleanHandle(r[col]);
      if (!h && urlCol >= 0) h = cleanHandle(r[urlCol]);
      if (!h) {
        // Fall back to the first cell in the row that looks like a handle
        // or a profile URL. Covers a bare one-column list.
        for (const cell of r) {
          h = cleanHandle(cell);
          if (h) break;
        }
      }
      if (!h) { skipped++; continue; }
      const key = h.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(h);
    }

    return { handles: out, skipped };
  };

  // ---------------------------------------------------------------
  // Creating a run
  // ---------------------------------------------------------------
  LR.create = async function (handles, source) {
    const clean = [];
    const seen = new Set();
    for (const raw of handles) {
      const h = cleanHandle(raw);
      if (!h) continue;
      const k = h.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      clean.push(h);
    }
    if (!clean.length) throw new Error("No usable handles found.");

    await setRun({
      handles: clean,
      index: 0,
      done: [],
      failed: [],
      skipped: [],
      source: source || "import",
      active: false,
      paused: false,
      createdAt: Date.now(),
      heartbeatTs: Date.now()
    });
    return clean.length;
  };

  LR.start = async function () {
    const run = await getRun();
    if (!run) throw new Error("No list loaded. Import a CSV or use your scan results first.");
    if (run.index >= run.handles.length) throw new Error("This list is already finished.");
    await patchRun({ active: true, paused: false, startedAt: Date.now() });
    return true;
  };

  LR.pause = async function () { await patchRun({ paused: true }); };
  LR.resumeRun = async function () { await patchRun({ paused: false, active: true }); };
  LR.stop = async function () { await patchRun({ active: false, paused: false }); };

  // ---------------------------------------------------------------
  // Progress summary for the UI
  // ---------------------------------------------------------------
  LR.summary = async function () {
    const run = await getRun();
    if (!run) return null;
    return {
      total: run.handles.length,
      index: run.index,
      done: run.done.length,
      skipped: Array.isArray(run.skipped) ? run.skipped.length : (Number(run.skipped) || 0),
      failed: run.failed.length,
      active: !!run.active,
      paused: !!run.paused,
      source: run.source,
      current: run.handles[run.index] || null,
      remaining: Math.max(0, run.handles.length - run.index)
    };
  };

  // ---------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------
  LR.profileUrl = (handle) => "https://" + location.hostname + "/" + handle;

  // Which handle is this page showing, if any.
  function currentProfileHandle() {
    const m = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    return m ? m[1] : null;
  }
  LR.currentProfileHandle = currentProfileHandle;

  window.__XUMP_LIST = LR;
})();
