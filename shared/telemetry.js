// X Mass Unfollow - anonymous telemetry (service-worker side only).
//
// Sends a tiny, anonymous signal so the developer can see growth and catch
// problems: a random install ID (not derived from the device or the user),
// the extension version, an install event, a once-a-day "active" ping with the
// number of unfollows in the last 24h, and an uninstall beacon. Coarse country
// is read server-side from the network request; the IP itself is never stored.
//
// It NEVER sends: your IP, your X/Twitter username or account, your following
// list, your whitelist, your history, or anything that identifies you.
//
// Off switch: Settings -> "Anonymous usage stats". When off, nothing is sent
// and the uninstall beacon is cleared.
//
// Not configured? Leave ENDPOINT empty and this file is a silent no-op.

(function (root) {
  "use strict";

  // === CONFIGURE ME ========================================================
  // The developer's Cloudflare Worker (see tracker/). This is the production
  // endpoint and ships in every release: do not blank it when editing this
  // file. t6_telemetry fails if it is empty or not an allowed https host.
  // (Leaving it "" would disable telemetry entirely - no requests are made.)
  // The host must be allowed in manifest.json connect-src, which already
  // allows https://*.workers.dev.
  const ENDPOINT = "https://unfollow.shahriarahmed614.workers.dev";
  // =========================================================================
  // You can also set the URL without editing this file by writing an
  // "x7.trackerUrl" string into chrome.storage.local. The constant above wins
  // when both are set, so production stays deterministic.

  async function endpoint() {
    if (ENDPOINT) return ENDPOINT.replace(/\/+$/, "");
    try {
      const u = (await chrome.storage.local.get("x7.trackerUrl"))["x7.trackerUrl"];
      if (typeof u === "string" && /^https:\/\/[^\s"']+$/.test(u)) return u.replace(/\/+$/, "");
    } catch (_) {}
    return "";
  }

  const K = {
    id: "x7.tid",         // anonymous install id
    day: "x7.tday",       // last UTC day an "active" ping was sent
    installed: "x7.tinst" // whether the install event has been sent
  };

  async function get(key, fallback) {
    try { const r = await chrome.storage.local.get(key); return r[key] === undefined ? fallback : r[key]; }
    catch (_) { return fallback; }
  }
  async function set(obj) { try { await chrome.storage.local.set(obj); } catch (_) {} }

  function uuid() {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function version() {
    try { return chrome.runtime.getManifest().version; } catch (_) { return null; }
  }

  async function enabled() {
    if (!(await endpoint())) return false;
    try {
      const s = (await chrome.storage.local.get("x7.settings"))["x7.settings"];
      return !s || s.telemetry !== false; // default on
    } catch (_) { return false; }
  }

  async function id() {
    let v = await get(K.id, null);
    if (!v) { v = uuid(); await set({ [K.id]: v }); }
    return v;
  }

  // Keep the uninstall beacon current so a removal is counted. Cleared when
  // the user opts out.
  async function syncUninstallUrl() {
    try {
      const base = await endpoint();
      if (!base || !(await enabled())) { chrome.runtime.setUninstallURL(""); return; }
      const url = `${base}/bye?i=${encodeURIComponent(await id())}&v=${encodeURIComponent(version() || "")}`;
      if (url.length <= 1023) chrome.runtime.setUninstallURL(url);
    } catch (_) {}
  }

  async function send(events) {
    if (!events.length || !(await enabled())) return;
    const base = await endpoint();
    if (!base) return;
    try {
      // text/plain keeps it a CORS "simple" request (no preflight); the Worker
      // parses the body as JSON regardless.
      await fetch(`${base}/e`, {
        method: "POST", keepalive: true, credentials: "omit", cache: "no-store",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ i: await id(), v: version(), e: events })
      });
    } catch (_) { /* offline or blocked - fine, it's best-effort */ }
  }

  // Fired once, the first time the worker ever runs after install.
  async function onInstall() {
    await syncUninstallUrl();
    if (await get(K.installed, false)) return;
    await set({ [K.installed]: true });
    await send([{ t: "install", ts: Date.now() }]);
  }

  // At most once per UTC day, when the extension is actually used.
  // `unfollows24h` is an aggregate count only.
  async function active(unfollows24h) {
    if (!(await enabled())) return;
    const d = new Date().toISOString().slice(0, 10);
    if ((await get(K.day, null)) === d) return;
    await set({ [K.day]: d });
    await syncUninstallUrl();
    await send([{ t: "active", ts: Date.now(), n: Math.max(0, Math.round(Number(unfollows24h) || 0)) }]);
  }

  root.X7Telemetry = { onInstall, active, syncUninstallUrl, id };
})(self);
