// X Mass Unfollow - shared/config.js
// Loaded by the background worker (importScripts) and by every extension page.

(function (root) {
  "use strict";

  const K = {
    settings: "x7.settings",
    whitelist: "x7.whitelist",
    account: "x7.account",
    scan: "x7.scan",
    scanUsers: "x7.scanUsers",
    job: "x7.job",
    queue: "x7.queue",
    ledger: "x7.ledger",
    history: "x7.history",
    doneIds: "x7.doneIds",
    health: "x7.health",
    meta: "x7.meta"
  };

  // Speed presets. Delays are seconds between unfollows (randomised inside the
  // range), then a rest every `restEvery` unfollows, and a rolling 24-hour cap.
  // X commonly limits accounts at around 400 follow/unfollow actions a day
  // (about 1,000 with Premium), so the defaults stay under that.
  const PRESETS = {
    safe:     { minDelay: 15, maxDelay: 35, restEvery: 30, restMinutes: 10, dailyLimit: 250 },
    balanced: { minDelay: 8,  maxDelay: 20, restEvery: 50, restMinutes: 6,  dailyLimit: 400 },
    fast:     { minDelay: 4,  maxDelay: 10, restEvery: 80, restMinutes: 5,  dailyLimit: 1000 }
  };

  const DEFAULT_SETTINGS = Object.assign({ speed: "balanced" }, PRESETS.balanced, {
    keepVerified: false,
    keepProtected: false,
    keepMinFollowers: 0,      // keep accounts with at least this many followers (0 = off)
    keepKeywords: "",         // comma separated; matched against name, handle and bio
    scanMaxAgeHours: 12,      // older scans are refreshed before a quick run
    telemetry: true           // anonymous usage stats (install/active/uninstall + country)
  });

  const LIMITS = {
    minDelay: [2, 600], maxDelay: [2, 900], restEvery: [0, 1000],
    restMinutes: [1, 240], dailyLimit: [0, 5000], keepMinFollowers: [0, 100000000],
    scanMaxAgeHours: [1, 720]
  };

  function normalizeSettings(s) {
    const out = Object.assign({}, DEFAULT_SETTINGS, s || {});
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
      let n = Math.round(Number(out[k]));
      if (!Number.isFinite(n)) n = DEFAULT_SETTINGS[k];
      out[k] = Math.max(lo, Math.min(hi, n));
    }
    if (out.maxDelay < out.minDelay) [out.minDelay, out.maxDelay] = [out.maxDelay, out.minDelay];
    if (!["safe", "balanced", "fast", "custom"].includes(out.speed)) out.speed = "custom";
    out.keepVerified = !!out.keepVerified;
    out.keepProtected = !!out.keepProtected;
    out.telemetry = out.telemetry !== false;
    out.keepKeywords = String(out.keepKeywords || "").slice(0, 2000);
    return out;
  }

  function cleanHandle(raw) {
    if (!raw) return null;
    let h = String(raw).trim();
    const m = h.match(/(?:twitter|x)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i);
    if (m) h = m[1];
    h = h.replace(/^@+/, "").trim();
    if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
    if (/^(home|explore|notifications|messages|settings|i|search|compose|intent|share|login|logout|signup|tos|privacy)$/i.test(h)) return null;
    return h;
  }

  function parseKeywords(s) {
    return String(s || "").split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  }

  // Why an account would be kept, or null if it may be unfollowed.
  // Shared by the engine and the review table so both always agree.
  function keepReason(u, settings, whitelistSet) {
    const h = String(u.h || "").toLowerCase();
    if (whitelistSet && whitelistSet.has(h)) return "whitelist";
    if (settings.keepVerified && u.v) return "verified";
    if (settings.keepProtected && u.p) return "private";
    if (settings.keepMinFollowers > 0 && typeof u.fc === "number" && u.fc >= settings.keepMinFollowers) return "big account";
    const kws = parseKeywords(settings.keepKeywords);
    if (kws.length) {
      const hay = (u.n + " " + u.h + " " + (u.b || "")).toLowerCase();
      if (kws.some((k) => hay.includes(k))) return "keyword";
    }
    return null;
  }

  root.X7 = { K, PRESETS, DEFAULT_SETTINGS, LIMITS, normalizeSettings, cleanHandle, parseKeywords, keepReason };
})(typeof self !== "undefined" ? self : window);
