// X Mass Unfollow - content/txid.js
//
// Generates the `x-client-transaction-id` header that X's web app attaches to
// its API calls. Since 2025 X answers several internal endpoints (the
// Following / Followers timelines among them) with a bare 404 when the header
// is missing, so without this the API engine cannot read a following list.
//
// How it works, briefly: X's page carries a per-deployment verification key
// (<meta name="twitter-site-verification">) and a set of hidden SVG "loading"
// animations. A chunk of X's JS (ondemand.s) says which bytes of the key pick
// which animation frame. The frame is turned into an "animation key", and each
// request's id is SHA-256(method!path!time + keyword + animationKey), packed
// with the key and the time, then XOR-scrambled with one random byte.
//
// Ported from the MIT-licensed x-client-transaction-id project
// (https://github.com/Lqm1/x-client-transaction-id, (c) 2025 Lami), which is
// itself a port of iSarabjitDhiman/XClientTransaction (MIT). Rewritten as a
// dependency-free browser module.
//
// Everything here runs inside the user's own signed-in x.com tab. The only
// network requests are to x.com (the app shell) and abs.twimg.com (X's JS).

(function () {
  "use strict";

  if (window.__X7_TXID) return;

  const KEYWORD = "obfiowerehiring";
  const EXTRA_BYTE = 3;
  const EPOCH_S = 1682924400;
  const CACHE_KEY = "x7.txid";
  const CACHE_TTL_MS = 2 * 60 * 60 * 1000;   // a deployment's key lives for hours
  const INDICES_RE = /\(\w\[(\d{1,2})\],\s*16\)/g;

  // The app shell carries the key, the animation frames and the webpack chunk
  // map. Signed-in /home is tried first; /i/jf/ is the route X still serves the
  // responsive-web shell on for everyone after the Sept 2026 x-web migration.
  const SHELL_URLS = ["/home", "/i/jf/"];

  // ---------------------------------------------------------------------
  // Small math helpers (straight ports)
  // ---------------------------------------------------------------------
  function cubicValue(curves, time) {
    let startGradient = 0, endGradient = 0;
    let start = 0.0, mid = 0.0, end = 1.0;
    const calc = (a, b, m) => 3.0 * a * (1 - m) * (1 - m) * m + 3.0 * b * (1 - m) * m * m + m * m * m;

    if (time <= 0.0) {
      if (curves[0] > 0.0) startGradient = curves[1] / curves[0];
      else if (curves[1] === 0.0 && curves[2] > 0.0) startGradient = curves[3] / curves[2];
      return startGradient * time;
    }
    if (time >= 1.0) {
      if (curves[2] < 1.0) endGradient = (curves[3] - 1.0) / (curves[2] - 1.0);
      else if (curves[2] === 1.0 && curves[0] < 1.0) endGradient = (curves[1] - 1.0) / (curves[0] - 1.0);
      return 1.0 + endGradient * (time - 1.0);
    }
    while (start < end) {
      mid = (start + end) / 2;
      const xEst = calc(curves[0], curves[2], mid);
      if (Math.abs(time - xEst) < 0.00001) return calc(curves[1], curves[3], mid);
      if (xEst < time) start = mid; else end = mid;
    }
    return calc(curves[1], curves[3], mid);
  }

  function interpolate(from, to, f) {
    const out = [];
    for (let i = 0; i < from.length; i++) out.push(from[i] * (1 - f) + to[i] * f);
    return out;
  }

  function rotationMatrix(deg) {
    const rad = (deg * Math.PI) / 180;
    return [Math.cos(rad), -Math.sin(rad), Math.sin(rad), Math.cos(rad)];
  }

  function floatToHex(x) {
    const result = [];
    let quotient = Math.floor(x);
    let fraction = x - quotient;
    while (quotient > 0) {
      quotient = Math.floor(x / 16);
      const remainder = Math.floor(x - quotient * 16);
      result.unshift(remainder > 9 ? String.fromCharCode(remainder + 55) : String(remainder));
      x = quotient;
    }
    if (fraction === 0) return result.join("");
    result.push(".");
    // Bounded: a binary fraction always terminates, but never loop forever.
    for (let guard = 0; fraction > 0 && guard < 64; guard++) {
      fraction *= 16;
      const integer = Math.floor(fraction);
      fraction -= integer;
      result.push(integer > 9 ? String.fromCharCode(integer + 55) : String(integer));
    }
    return result.join("");
  }

  function solve(value, minVal, maxVal, rounding) {
    const r = (value * (maxVal - minVal)) / 255 + minVal;
    return rounding ? Math.floor(r) : Math.round(r * 100) / 100;
  }

  function b64decode(s) {
    const bin = atob(String(s).trim());
    const out = new Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function b64encode(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  // ---------------------------------------------------------------------
  // Pure derivation (exported for tests)
  // ---------------------------------------------------------------------
  function animate(frames, targetTime) {
    const fromColor = frames.slice(0, 3).concat(1).map(Number);
    const toColor = frames.slice(3, 6).concat(1).map(Number);
    const toRotation = [solve(frames[6], 60.0, 360.0, true)];
    const curves = frames.slice(7).map((v, i) => solve(v, i % 2 ? -1.0 : 0.0, 1.0, false));
    const val = cubicValue(curves, targetTime);
    const color = interpolate(fromColor, toColor, val).map((v) => Math.max(0, Math.min(255, v)));
    const rotation = interpolate([0.0], toRotation, val);
    const matrix = rotationMatrix(rotation[0]);

    const parts = color.slice(0, -1).map((v) => Math.round(v).toString(16));
    for (const value of matrix) {
      let rounded = Math.round(value * 100) / 100;
      if (rounded < 0) rounded = -rounded;
      const hex = floatToHex(rounded);
      parts.push(hex.startsWith(".") ? ("0" + hex).toLowerCase() : (hex || "0"));
    }
    parts.push("0", "0");
    return parts.join("").replace(/[.-]/g, "");
  }

  function frameRows(doc, keyBytes) {
    const frames = Array.from(doc.querySelectorAll("[id^='loading-x-anim']"));
    if (!frames.length) return null;
    const frame = frames[keyBytes[5] % 4] || frames[0];
    const path = frame && frame.children[0] && frame.children[0].children[1];
    const d = path && path.getAttribute("d");
    if (!d) return null;
    return d.substring(9).split("C").map((item) => {
      const cleaned = item.replace(/[^\d]+/g, " ").trim();
      return cleaned === "" ? [] : cleaned.split(/\s+/).map((n) => parseInt(n, 10));
    });
  }

  function animationKeyFrom(doc, keyBytes, rowIndexPos, keyByteIndices) {
    const rowIndex = keyBytes[rowIndexPos] % 16;
    let frameTime = keyByteIndices.reduce((acc, idx) => acc * (keyBytes[idx] % 16), 1);
    frameTime = Math.round(frameTime / 10) * 10;
    const rows = frameRows(doc, keyBytes);
    if (!rows || !rows[rowIndex] || rows[rowIndex].length < 11) {
      throw new Error("animation frames not found in X's page");
    }
    return animate(rows[rowIndex], frameTime / 4096);
  }

  function indicesFrom(onDemandText) {
    const out = [];
    INDICES_RE.lastIndex = 0;
    let m;
    while ((m = INDICES_RE.exec(onDemandText)) !== null) out.push(parseInt(m[1], 10));
    if (out.length < 2) throw new Error("key byte indices not found in ondemand.s");
    return { row: out[0], bytes: out.slice(1) };
  }

  // Locate the ondemand.s chunk URL inside the webpack runtime. Two shapes
  // exist in the wild: the newer runtime keeps the name and hash maps apart in
  // one expression, the older one has them as flat `,123:"hash"` maps.
  function onDemandUrlFrom(text) {
    if (!text || text.indexOf("ondemand.s") === -1) return null;
    const base = "https://abs.twimg.com/responsive-web/client-web/ondemand.s.";

    const NEW_RE = /(\d+):\s*["']ondemand\.s["'][\s\S]*?\}\)\[e\]\s*\|\|\s*e\)\s*\+\s*["']\.["']\s*\+\s*\(\{[\s\S]*?\b\1:\s*["']([a-zA-Z0-9_-]+)["']/;
    // Only run the expensive pattern on the slice that can contain it.
    const at = text.indexOf("ondemand.s");
    const slice = text.slice(Math.max(0, at - 64), at + 400000);
    const n = NEW_RE.exec(slice);
    if (n) return base + n[2] + "a.js";

    const idx = /[,{]\s*(\d+)\s*:\s*["']ondemand\.s["']/.exec(text);
    if (idx) {
      const h = new RegExp("[,{]\\s*" + idx[1] + "\\s*:\\s*[\"']([0-9a-f]{6,})[\"']").exec(text);
      if (h) return base + h[1] + "a.js";
    }
    return null;
  }

  async function sha256(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf));
  }

  // Build the header value from derived material. `time` and `rand` are only
  // passed by tests.
  async function makeId(material, method, path, time, rand) {
    const t = typeof time === "number" ? time : Math.floor((Date.now() - EPOCH_S * 1000) / 1000);
    const timeBytes = [t & 0xff, (t >> 8) & 0xff, (t >> 16) & 0xff, (t >> 24) & 0xff];
    const keyBytes = b64decode(material.key);
    const hash = await sha256(`${method}!${path}!${t}${KEYWORD}${material.animationKey}`);
    const r = typeof rand === "number" ? rand : Math.floor(Math.random() * 256);
    const body = [...keyBytes, ...timeBytes, ...hash.slice(0, 16), EXTRA_BYTE];
    const out = new Uint8Array(body.length + 1);
    out[0] = r;
    for (let i = 0; i < body.length; i++) out[i + 1] = body[i] ^ r;
    return b64encode(out).replace(/=/g, "");
  }

  // ---------------------------------------------------------------------
  // Fetching the inputs
  // ---------------------------------------------------------------------
  async function fetchCrossOrigin(url) {
    // abs.twimg.com is cross-origin from x.com, so go through the extension
    // worker, which holds that host permission. Fall back to a direct fetch.
    try {
      const res = await chrome.runtime.sendMessage({ x7: "fetchText", url });
      if (res && res.ok) return res.text;
    } catch (_) {}
    const r = await fetch(url, { credentials: "omit" });
    if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
    return r.text();
  }

  async function fetchShell(path) {
    const res = await fetch(location.origin + path, {
      credentials: "include",
      headers: { accept: "text/html,application/xhtml+xml" },
      cache: "no-store"
    });
    if (!res.ok) throw new Error("shell HTTP " + res.status);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    return { html, doc };
  }

  // The last shell fetched, shared with the API client (it also reads the
  // feature switches and the signed-in profile out of it).
  let lastShell = null;

  async function deriveMaterial() {
    let lastErr = null;
    for (const path of SHELL_URLS) {
      try {
        const { html, doc } = await fetchShell(path);
        const meta = doc.querySelector("meta[name='twitter-site-verification']");
        const key = meta && meta.getAttribute("content");
        if (!key) throw new Error("verification key missing on " + path);

        let url = null;
        for (const s of doc.querySelectorAll("script")) {
          url = onDemandUrlFrom(s.textContent || "");
          if (url) break;
        }
        if (!url) url = onDemandUrlFrom(html);
        if (!url) {
          // The runtime may live in an external file on some builds.
          for (const s of doc.querySelectorAll("script[src]")) {
            const src = s.getAttribute("src") || "";
            if (!/runtime|main|vendor/i.test(src)) continue;
            try {
              url = onDemandUrlFrom(await fetchCrossOrigin(new URL(src, location.origin).href));
            } catch (_) {}
            if (url) break;
          }
        }
        if (!url) throw new Error("ondemand.s chunk not found on " + path);

        const idx = indicesFrom(await fetchCrossOrigin(url));
        const keyBytes = b64decode(key);
        const animationKey = animationKeyFrom(doc, keyBytes, idx.row, idx.bytes);

        lastShell = { html, doc, at: Date.now(), path };
        return { key, animationKey, at: Date.now(), source: path };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("could not derive transaction material");
  }

  let material = null;
  let pending = null;
  let lastError = null;

  async function readCache() {
    try {
      const r = await chrome.storage.local.get(CACHE_KEY);
      const c = r[CACHE_KEY];
      if (c && c.key && c.animationKey && Date.now() - c.at < CACHE_TTL_MS) return c;
    } catch (_) {}
    return null;
  }

  async function init(force) {
    if (!force && material && Date.now() - material.at < CACHE_TTL_MS) return material;
    if (pending) return pending;
    pending = (async () => {
      try {
        if (!force) {
          const cached = await readCache();
          if (cached) { material = cached; return material; }
        }
        material = await deriveMaterial();
        lastError = null;
        try { await chrome.storage.local.set({ [CACHE_KEY]: material }); } catch (_) {}
        return material;
      } catch (e) {
        lastError = String(e && e.message || e);
        material = null;
        throw e;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  async function generate(method, path) {
    const m = await init(false);
    return makeId(m, String(method).toUpperCase(), path);
  }

  async function invalidate() {
    material = null;
    try { await chrome.storage.local.remove(CACHE_KEY); } catch (_) {}
  }

  // Returns the freshest shell document, fetching one if needed.
  async function shell(maxAgeMs) {
    if (lastShell && Date.now() - lastShell.at < (maxAgeMs || 10 * 60000)) return lastShell;
    for (const path of SHELL_URLS) {
      try {
        const s = await fetchShell(path);
        lastShell = { ...s, at: Date.now(), path };
        return lastShell;
      } catch (_) {}
    }
    return null;
  }

  window.__X7_TXID = {
    init, generate, invalidate, shell,
    status: () => ({ ready: !!material, error: lastError, source: material && material.source }),
    // exposed for tests only
    _test: { animate, frameRows, animationKeyFrom, indicesFrom, onDemandUrlFrom, makeId, floatToHex, cubicValue }
  };
})();
