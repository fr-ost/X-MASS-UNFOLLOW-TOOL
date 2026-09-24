// ============================================================
// X Unfollow Manager Pro - options.js (v6.0.0)
// ============================================================

// Must mirror content.js's DEFAULTS. These had drifted: the settings page
// still defaulted the budgets to 40/100/25/120 while the engine had moved to
// 0 (no limit), so an unset field loaded the old number back and clamp()
// used it as the fallback.
const DEFAULTS = {
  minDelay: 22, maxDelay: 55, scrollWait: 3,
  maxActions: 0, dailyLimit: 0, windowLimit: 0,
  cooldownAfter: 12, cooldownMinutes: 6,
  maxSessionMinutes: 240,
  skipVerified: false, skipProtected: false, skipFollowsMe: false,
  keywordProtection: false, protectedKeywords: "project, team, partner",
  whitelistHandles: "",
  moniMinScore: 100, whitelistProtectVerified: true, moniHoverProbe: false,
  infiniteMode: false, idleRescanMinutes: 5, scanLimit: 0,
  reloadOnStop: false, soundEnabled: true,
  humanPacing: true, allowAnyPage: false, stopOnChallenge: true
};

const NUMBERS = {
  minDelay: [5, 600], maxDelay: [5, 600], scrollWait: [1, 30],
  // These four are the user's to choose. 0 means no limit, so the floor must
  // be 0 - a floor of 1 silently rewrote "no limit" to "one action", and the
  // old ceilings rewrote anything larger back down to them. That was the
  // "it goes back to 400" bug: the value was never rejected, just clamped.
  maxActions: [0, 100000], dailyLimit: [0, 100000], windowLimit: [0, 100000],
  cooldownAfter: [0, 100], cooldownMinutes: [1, 120],
  maxSessionMinutes: [0, 100000], moniMinScore: [0, 100000],
  idleRescanMinutes: [1, 120]
};

const CHECKS = ["skipVerified", "skipProtected", "skipFollowsMe",
                "keywordProtection", "reloadOnStop", "soundEnabled",
                "humanPacing", "allowAnyPage", "stopOnChallenge",
                "whitelistProtectVerified", "moniHoverProbe",
                "infiniteMode"];

const TEXTS = ["protectedKeywords", "whitelistHandles"];

const $ = (id) => document.getElementById(id);

// Read the version from the manifest so the badge can never drift from the
// build again (it was hardcoded, and sat at 6.10.0 for four releases).
try {
  const v = chrome.runtime.getManifest?.().version;
  if (v && $("edition")) $("edition").textContent = "v" + v;
} catch (_) {}

// Match the popup's theme choice.
chrome.storage.sync.get({ theme: "auto" }, (d) => {
  if (d.theme === "light" || d.theme === "dark")
    document.documentElement.setAttribute("data-theme", d.theme);
    try { localStorage.setItem("xuc-theme", d.theme); } catch (_) {}
});

function fill(d) {
  for (const k of Object.keys(NUMBERS)) if ($(k)) $(k).value = d[k];
  for (const k of CHECKS) if ($(k)) $(k).checked = !!d[k];
  for (const k of TEXTS) if ($(k)) $(k).value = d[k] || "";
}

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.sync.get(DEFAULTS, fill);

  $("save").addEventListener("click", saveSettings);

  // Live round trip to the telemetry server, reporting exactly what happens.
  const tBtn = $("telemetryTest"), tOut = $("telemetryTestResult");
  if (tBtn && tOut) {
    tBtn.addEventListener("click", () => {
      tOut.className = "tele-result";
      tOut.textContent = "Contacting server...";
      chrome.runtime.sendMessage({ type: "TELEMETRY_TEST" }, (res) => {
        if (chrome.runtime.lastError) {
          tOut.className = "tele-result bad";
          tOut.textContent = "Could not reach the extension worker. Reload the extension and retry.";
          return;
        }
        if (res && res.ok) {
          tOut.className = "tele-result good";
          tOut.textContent = `Connected. Server replied ${res.status} in ${res.ms} ms. ` +
                             `The dashboard should show this device within a minute.`;
        } else {
          tOut.className = "tele-result bad";
          tOut.textContent = (res && (res.reason || res.error)) || "Unknown failure.";
        }
      });
    });
  }
  $("reset").addEventListener("click", () => {
    if (!confirm("Reset every setting to the safe defaults?")) return;
    fill(DEFAULTS);
    saveSettings();
  });

  document.querySelectorAll("input").forEach(el => {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); saveSettings(); }
    });
  });
});

function clamp(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function saveSettings() {
  const data = {};
  for (const [k, [min, max]] of Object.entries(NUMBERS)) {
    if ($(k)) data[k] = clamp($(k).value, min, max, DEFAULTS[k]);
  }
  for (const k of CHECKS) if ($(k)) data[k] = $(k).checked;
  for (const k of TEXTS) if ($(k)) data[k] = $(k).value.trim();

  if (data.maxDelay < data.minDelay) {
    [data.minDelay, data.maxDelay] = [data.maxDelay, data.minDelay];
  }
  // No cross-field rewriting. A session cap larger than the daily budget used
  // to be silently reduced to match, which is the same silent-reset behaviour
  // as the clamps above - you set a number and got a different one back. The
  // mismatch is pointed out below instead; the daily budget still stops the
  // run when it is reached, so nothing is lost by keeping your value.

  fill({ ...DEFAULTS, ...data });

  chrome.storage.sync.set(data, () => {
    const warnings = [];
    // Warn on volume, never rewrite it. These are your numbers.
    if (Number(data.dailyLimit) === 0)
      warnings.push("daily budget is unlimited - watch for the volume warnings while running");
    else if (data.dailyLimit > 150)
      warnings.push("a daily budget above 150 raises your flag risk");
    if (Number(data.windowLimit) === 0)
      warnings.push("no 15-minute cap, so bursts are possible");
    else if (data.windowLimit > 30)
      warnings.push("more than 30 actions per 15 minutes looks robotic");
    if (Number(data.dailyLimit) > 0 && Number(data.maxActions) > data.dailyLimit)
      warnings.push(`session cap (${data.maxActions}) is above the daily budget (${data.dailyLimit}), so the day will run out first`);
    if (data.minDelay < 12)     warnings.push("delays under 12 seconds are fast enough to be noticed");
    if (data.allowAnyPage)      warnings.push("running outside follow lists is on");

    const status = $("status");
    status.textContent = warnings.length
      ? "\u2713  Saved \u2014 note: " + warnings.join("; ")
      : "\u2713  Settings saved";
    status.classList.toggle("warn", warnings.length > 0);
    status.style.opacity = "1";
    setTimeout(() => {
      status.style.opacity = "0";
      setTimeout(() => { status.textContent = ""; status.style.opacity = "1"; }, 300);
    }, warnings.length ? 5200 : 1800);
  });
}
