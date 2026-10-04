// X Mass Unfollow - anonymous usage tracker (Cloudflare Worker + D1)
//
// One file, no build step. Paste it into a Worker, bind a D1 database as DB,
// and set an ADMIN_PASSWORD secret. See README.md for the 5-minute setup.
//
//   POST /e        anonymous events from the extension (install, daily active)
//   GET  /bye      uninstall beacon (the extension's setUninstallURL)
//   POST /bye      optional uninstall-reason form from that page
//   GET  /admin    the dashboard (HTTP Basic auth, user = anything, pass = ADMIN_PASSWORD)
//   GET  /admin/api/overview   JSON for the dashboard
//
// WHAT IS AND ISN'T STORED
//   Stored: a random install ID the extension generates (not derived from the
//   device or the user), the extension version, coarse country from
//   Cloudflare's edge metadata, timestamps, and an aggregate count of
//   unfollows reported by active users.
//   NOT stored or received: IP address, X/Twitter username or account, email,
//   device fingerprint, following list, or anything that identifies a person.
//   The install ID is anonymous and resettable (the user clearing extension
//   data gives them a new one).

const VERSION = "1.0.0";
const TYPES = new Set(["install", "active"]);
const MAX_BODY = 16384;
const MAX_EVENTS = 20;
const DAY_EVENT_CAP = 200;        // per install per day, guards the database
const DAY = 86400000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS installs (
    iid TEXT PRIMARY KEY,
    first_seen INTEGER, last_seen INTEGER, installed_at INTEGER, uninstalled_at INTEGER,
    version TEXT, country TEXT,
    active_days INTEGER DEFAULT 0, unfollows INTEGER DEFAULT 0,
    uninstall_reason TEXT, uninstall_note TEXT,
    day TEXT, day_events INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER, iid TEXT, type TEXT, version TEXT, country TEXT, n INTEGER)`,
  `CREATE INDEX IF NOT EXISTS ev_ts ON events(ts)`,
  `CREATE INDEX IF NOT EXISTS ev_type ON events(type, ts)`,
  `CREATE INDEX IF NOT EXISTS in_last ON installs(last_seen)`
];

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const str = (v, n) => (v == null || v === "" ? null : String(v).slice(0, n || 120));
const int = (v) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? x : null; };
const today = (ts) => new Date(ts || Date.now()).toISOString().slice(0, 10);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function json(data, status, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, extra || {})
  });
}
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400"
};
const country = (req) => str((req.cf && req.cf.country) || req.headers.get("cf-ipcountry"), 8);

// ---------------------------------------------------------------------------
// POST /e  - anonymous events
// ---------------------------------------------------------------------------
async function ingest(req, env) {
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ ok: false }, 413, CORS);
  let b;
  try { b = JSON.parse(raw); } catch (_) { return json({ ok: false, error: "bad json" }, 400, CORS); }

  const iid = String((b && b.i) || "");
  if (!/^[a-z0-9-]{16,40}$/i.test(iid)) return json({ ok: false, error: "bad id" }, 400, CORS);

  const now = Date.now();
  const version = str(b.v, 20);
  const cc = country(req);
  const day = today(now);

  const prev = await env.DB.prepare("SELECT day, day_events FROM installs WHERE iid = ?").bind(iid).first();
  const used = prev && prev.day === day ? prev.day_events : 0;
  if (used >= DAY_EVENT_CAP) return json({ ok: true, dropped: true }, 200, CORS);

  const events = (Array.isArray(b.e) ? b.e : []).slice(0, Math.min(MAX_EVENTS, DAY_EVENT_CAP - used))
    .filter((e) => e && TYPES.has(e.t));
  let activeDays = 0, unf = 0, installedAt = null;
  const rows = events.map((e) => {
    let ts = int(e.ts);
    if (!ts || ts > now + 60000 || ts < now - 14 * DAY) ts = now;
    let n = int(e.n);
    if (n != null) n = Math.max(0, Math.min(n, 100000));
    if (e.t === "active") { activeDays++; if (n) unf += n; }
    if (e.t === "install") installedAt = ts;
    return env.DB.prepare("INSERT INTO events (ts, iid, type, version, country, n) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(ts, iid, e.t, version, cc, e.t === "active" ? (n || 0) : null);
  });

  const upsert = env.DB.prepare(`INSERT INTO installs
      (iid, first_seen, last_seen, installed_at, version, country, active_days, unfollows, day, day_events)
    VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(iid) DO UPDATE SET
      last_seen = excluded.last_seen,
      installed_at = COALESCE(installs.installed_at, excluded.installed_at),
      uninstalled_at = NULL,
      version = COALESCE(excluded.version, installs.version),
      country = COALESCE(excluded.country, installs.country),
      active_days = installs.active_days + excluded.active_days,
      unfollows = installs.unfollows + excluded.unfollows,
      day = excluded.day,
      day_events = CASE WHEN installs.day = excluded.day THEN installs.day_events + excluded.day_events ELSE excluded.day_events END`)
    .bind(iid, now, installedAt, version, cc, activeDays, unf, day, rows.length);

  await env.DB.batch([upsert, ...rows]);
  return json({ ok: true, n: rows.length }, 200, CORS);
}

// ---------------------------------------------------------------------------
// /bye  (uninstall)
// ---------------------------------------------------------------------------
const STORE = "https://chromewebstore.google.com/detail/x-twitter-mass-unfollow-t/igpjmagghnibmjkkdcgpjgpkfkpiglnl";
const REASONS = [
  ["broken", "It stopped working / had bugs"],
  ["slow", "Too slow"],
  ["done", "I only needed it once"],
  ["ads", "The ads"],
  ["other_tool", "I found another tool"],
  ["other", "Something else"]
];

async function bye(req, env, url) {
  if (req.method === "POST") {
    const f = await req.formData().catch(() => null);
    const id = f && String(f.get("i") || "");
    const reason = f && String(f.get("reason") || "");
    const note = f && str(f.get("note"), 1000);
    if (id && /^[a-z0-9-]{16,40}$/i.test(id) && REASONS.some(([k]) => k === reason)) {
      await env.DB.prepare("UPDATE installs SET uninstall_reason = ?, uninstall_note = ? WHERE iid = ?").bind(reason, note, id).run();
    }
    return pageResponse(byePage(null, true));
  }
  const iid = String(url.searchParams.get("i") || "");
  const valid = /^[a-z0-9-]{16,40}$/i.test(iid);
  if (valid) {
    const now = Date.now();
    const cc = country(req);
    const v = str(url.searchParams.get("v"), 20);
    const seen = await env.DB.prepare("SELECT uninstalled_at FROM installs WHERE iid = ?").bind(iid).first();
    if (!seen || !seen.uninstalled_at) {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO installs (iid, first_seen, last_seen, uninstalled_at, version, country, day, day_events)
            VALUES (?1, ?2, ?2, ?2, ?3, ?4, ?5, 0)
          ON CONFLICT(iid) DO UPDATE SET uninstalled_at = ?2`).bind(iid, now, v, cc, today(now)),
        env.DB.prepare("INSERT INTO events (ts, iid, type, version, country, n) VALUES (?, ?, 'uninstall', ?, ?, NULL)")
          .bind(now, iid, v, cc)
      ]);
    }
  }
  return pageResponse(byePage(valid ? iid : null, false));
}

function pageResponse(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff"
    }
  });
}

function byePage(iid, thanks) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>X Mass Unfollow - sorry to see you go</title><meta name="robots" content="noindex">
<style>
:root{--bg:#F5F7FB;--card:#fff;--text:#0C1324;--muted:#5B6478;--line:#E3E8F0;--acc:#3D5AFE;--accs:#EEF1FF}
@media (prefers-color-scheme:dark){:root{--bg:#0B1020;--card:#121A2E;--text:#EEF2FA;--muted:#9AA5BD;--line:#22304D;--acc:#7C93FF;--accs:#1A2547}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;max-width:520px;width:100%;padding:32px;box-shadow:0 20px 50px -30px rgba(15,23,42,.35)}
h1{font-size:23px;margin:0 0 6px;letter-spacing:-.02em}p{color:var(--muted);margin:0 0 18px}
label{display:flex;gap:10px;align-items:center;padding:11px 14px;border:1px solid var(--line);border-radius:12px;margin-bottom:8px;cursor:pointer}
label:has(input:checked){border-color:var(--acc);background:var(--accs)}
textarea{width:100%;min-height:76px;border:1px solid var(--line);border-radius:12px;padding:10px 12px;font:inherit;background:transparent;color:inherit;margin-top:4px}
button,.btn{display:inline-block;margin-top:14px;border:0;border-radius:12px;padding:12px 18px;font:600 15px/1 inherit;font-family:inherit;color:#fff;background:linear-gradient(135deg,#3B82F6,#4F46E5 55%,#7C3AED);cursor:pointer;text-decoration:none}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.ghost{background:transparent;color:var(--acc);border:1px solid var(--line)}
small{color:var(--muted);display:block;margin-top:18px}
</style></head><body><main class="card">
${thanks ? `<h1>Thank you</h1><p>Your feedback goes straight to the developer and helps fix what went wrong.</p>
<div class="row"><a class="btn" href="${STORE}">Reinstall</a><a class="btn ghost" href="https://t.me/igfrostt">Report a bug</a></div>`
  : `<h1>Sorry to see you go</h1><p>X Mass Unfollow has been removed. What made you uninstall it? One tap helps a lot - it's anonymous.</p>
<form method="post" action="/bye">${iid ? `<input type="hidden" name="i" value="${esc(iid)}">` : ""}
${REASONS.map(([k, t], i) => `<label><input type="radio" name="reason" value="${k}"${i === 0 ? " required" : ""}> ${esc(t)}</label>`).join("")}
<textarea name="note" maxlength="1000" placeholder="Anything else? (optional)"></textarea>
<div class="row"><button type="submit">Send feedback</button><a class="btn ghost" href="${STORE}">Reinstall</a></div></form>`}
<small>A product of Unique Labs. Developed by <a href="https://www.shahriarahmed.net" style="color:inherit">Shahriar Ahmed</a>.</small>
</main></body></html>`;
}

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------
async function sha(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function authorized(req, env) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  let pass = "";
  try { pass = atob(h.slice(6)).split(":").slice(1).join(":"); } catch (_) { return false; }
  const a = await sha(pass), b = await sha(env.ADMIN_PASSWORD);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function admin(req, env, url) {
  if (!env.ADMIN_PASSWORD) return pageResponse("<p>Set the ADMIN_PASSWORD secret on this Worker to open the dashboard.</p>", 503);
  if (!(await authorized(req, env))) {
    return new Response("Authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="X Mass Unfollow tracker", charset="UTF-8"' } });
  }
  const p = url.pathname;
  if (p === "/admin" || p === "/admin/") {
    return pageResponse(DASHBOARD);
  }

  const DB = env.DB;
  const now = Date.now();
  const days = Math.max(1, Math.min(365, int(url.searchParams.get("days")) || 30));
  const since = now - days * DAY;

  if (p === "/admin/api/overview") {
    const q = (sql, ...a) => DB.prepare(sql).bind(...a);
    const activeSince = (ms) => q("SELECT COUNT(DISTINCT iid) n FROM events WHERE type = 'active' AND ts >= ?", now - ms);
    const [tot, dau, wau, mau, per, series, cc, ver] = await DB.batch([
      q(`SELECT COUNT(*) total, SUM(uninstalled_at IS NULL) live, SUM(uninstalled_at IS NOT NULL) gone,
          COALESCE(SUM(unfollows),0) unf FROM installs`),
      activeSince(DAY), activeSince(7 * DAY), activeSince(30 * DAY),
      q(`SELECT SUM(type='install') inst, SUM(type='uninstall') uninst,
          COALESCE(SUM(CASE WHEN type='active' THEN n END),0) unf,
          COUNT(DISTINCT CASE WHEN type='active' THEN iid END) active FROM events WHERE ts >= ?`, since),
      q(`SELECT date(ts/1000,'unixepoch') d,
          SUM(type='install') inst, SUM(type='uninstall') uninst,
          COUNT(DISTINCT CASE WHEN type='active' THEN iid END) active,
          COALESCE(SUM(CASE WHEN type='active' THEN n END),0) unf
         FROM events WHERE ts >= ? GROUP BY d ORDER BY d`, since),
      q(`SELECT COALESCE(country,'??') k, COUNT(*) n FROM installs WHERE uninstalled_at IS NULL GROUP BY k ORDER BY n DESC LIMIT 20`),
      q(`SELECT COALESCE(version,'?') k, COUNT(*) n FROM installs WHERE uninstalled_at IS NULL GROUP BY k ORDER BY n DESC LIMIT 12`)
    ]);
    const one = (r) => (r.results && r.results[0]) || {};
    const t = one(tot);
    const gone = t.gone || 0, total = t.total || 0;
    return json({
      days,
      totals: { live: t.live || 0, total, gone, unfollows: t.unf || 0,
        uninstallRate: total ? Math.round((gone / total) * 1000) / 10 : 0 },
      active: { d1: one(dau).n || 0, d7: one(wau).n || 0, d30: one(mau).n || 0 },
      period: one(per),
      series: series.results,
      country: cc.results,
      version: ver.results
    });
  }

  if (p === "/admin/api/reasons") {
    const r = await DB.prepare(`SELECT uninstall_reason k, COUNT(*) n FROM installs
      WHERE uninstalled_at >= ? AND uninstall_reason IS NOT NULL GROUP BY k ORDER BY n DESC`).bind(since).all();
    const notes = await DB.prepare(`SELECT uninstall_reason k, uninstall_note note, uninstalled_at ts FROM installs
      WHERE uninstalled_at >= ? AND uninstall_note IS NOT NULL AND uninstall_note <> '' ORDER BY uninstalled_at DESC LIMIT 100`).bind(since).all();
    return json({
      reasons: r.results.map((x) => Object.assign(x, { label: (REASONS.find(([key]) => key === x.k) || [0, x.k])[1] })),
      notes: notes.results
    });
  }

  return json({ ok: false, error: "not found" }, 404);
}

// ---------------------------------------------------------------------------
// retention (daily Cron Trigger): drop raw events past the window.
// There is no personal data to scrub - nothing identifying is ever stored.
// ---------------------------------------------------------------------------
async function retention(env) {
  const keep = Math.max(30, int(env.RETENTION_DAYS) || 400);
  await env.DB.prepare("DELETE FROM events WHERE ts < ?").bind(Date.now() - keep * DAY).run();
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (!env.DB) return json({ ok: false, error: "Bind a D1 database to this Worker as DB." }, 500);
      await ensureSchema(env);
      if (url.pathname === "/e") {
        if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
        if (req.method === "POST") return await ingest(req, env);
        return json({ ok: false }, 405, CORS);
      }
      if (url.pathname === "/bye") return await bye(req, env, url);
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return await admin(req, env, url);
      if (url.pathname === "/") return json({ ok: true, service: "x-mass-unfollow-tracker", version: VERSION });
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      console.error(e);
      return json({ ok: false, error: "server error" }, 500, url.pathname === "/e" ? CORS : undefined);
    }
  },
  async scheduled(_event, env) {
    await ensureSchema(env);
    await retention(env);
  }
};

// ---------------------------------------------------------------------------
// dashboard (served at /admin)
// ---------------------------------------------------------------------------
const DASHBOARD = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>X Mass Unfollow - Tracker</title>
<style>
:root{color-scheme:light;
 --bg:#F4F6FB;--surface:#fff;--surface-2:#F0F3F9;--line:#E4E9F1;--text:#0C1324;--text-2:#3B4459;--muted:#6B7489;
 --accent:#3D5AFE;--accent-soft:#EEF1FF;--s1:#2a78d6;--s2:#eb6834;
 --good:#0B7A42;--good-soft:#E7F6EE;--bad:#C4253D;--bad-soft:#FDECEF;
 --shadow:0 1px 2px rgba(15,23,42,.05),0 10px 30px -20px rgba(15,23,42,.3)}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;
 --bg:#090E1A;--surface:#111828;--surface-2:#182134;--line:#223049;--text:#EDF1FA;--text-2:#C2CBDD;--muted:#8A95AE;
 --accent:#8098FF;--accent-soft:#19234A;--s1:#3987e5;--s2:#d95926;
 --good:#4ADE80;--good-soft:#112A1D;--bad:#FF7A8A;--bad-soft:#2E1219;
 --shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px -20px rgba(0,0,0,.7)}}
:root[data-theme=dark]{color-scheme:dark;
 --bg:#090E1A;--surface:#111828;--surface-2:#182134;--line:#223049;--text:#EDF1FA;--text-2:#C2CBDD;--muted:#8A95AE;
 --accent:#8098FF;--accent-soft:#19234A;--s1:#3987e5;--s2:#d95926;
 --good:#4ADE80;--good-soft:#112A1D;--bad:#FF7A8A;--bad-soft:#2E1219;
 --shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px -20px rgba(0,0,0,.7)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);
 font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.bar{max-width:1240px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:-.01em}
.logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#3B82F6,#4F46E5 55%,#7C3AED);display:grid;place-items:center;color:#fff;font-weight:800;font-size:13px}
.brand small{display:block;font-weight:500;color:var(--muted);font-size:12px}
.spacer{flex:1}
select,button.ibtn{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:8px 11px;color:inherit;font:inherit;cursor:pointer}
.wrap{max-width:1240px;margin:0 auto;padding:20px 20px 60px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:15px 16px;box-shadow:var(--shadow)}
.tile .lab{color:var(--muted);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.tile .val{font-size:26px;font-weight:750;letter-spacing:-.02em;margin-top:5px}
.tile .sub{color:var(--muted);font-size:12px;margin-top:3px}
.tile .val.good{color:var(--good)}.tile .val.bad{color:var(--bad)}
.grid{display:grid;grid-template-columns:1.6fr 1fr;gap:16px;align-items:start}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:var(--shadow);margin-bottom:16px}
.card h2{font-size:14px;margin:0 0 2px;letter-spacing:-.01em}
.card .cap{color:var(--muted);font-size:12px;margin:0 0 12px}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--text-2);margin-bottom:8px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.chart{width:100%;height:220px;display:block;overflow:visible}
.chart .gl{stroke:var(--line);stroke-width:1}
.chart text{fill:var(--muted);font-size:10px}
.tip{position:fixed;pointer-events:none;background:var(--text);color:var(--bg);padding:6px 9px;border-radius:8px;font-size:12px;opacity:0;transition:opacity .1s;white-space:nowrap;z-index:9;box-shadow:var(--shadow)}
.bars{display:flex;flex-direction:column;gap:8px}
.brow{display:grid;grid-template-columns:120px 1fr 54px;align-items:center;gap:10px;font-size:13px}
.brow .bk{color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brow .bt{background:var(--surface-2);border-radius:6px;height:16px;overflow:hidden}
.brow .bf{height:100%;background:var(--s1);border-radius:6px}
.brow .bn{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}.err{color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600;font-size:12px}
.flag{font-size:16px;margin-right:6px}
.note{display:none}
</style></head><body>
<div class="top"><div class="bar">
  <div class="brand"><span class="logo">X</span><span>Mass Unfollow<small>anonymous usage tracker</small></span></div>
  <span class="spacer"></span>
  <select id="range">
    <option value="7">Last 7 days</option>
    <option value="30" selected>Last 30 days</option>
    <option value="90">Last 90 days</option>
    <option value="365">Last year</option>
  </select>
  <button class="ibtn" id="theme" title="Toggle theme">◐</button>
  <button class="ibtn" id="refresh" title="Refresh">↻</button>
</div></div>
<div class="wrap">
  <div id="tiles" class="tiles"></div>
  <div class="card">
    <h2>Installs, uninstalls & active users</h2>
    <p class="cap" id="growthCap">Daily, over the selected range.</p>
    <div class="legend">
      <span><i style="background:var(--s1)"></i>Installs</span>
      <span><i style="background:var(--bad)"></i>Uninstalls</span>
      <span><i style="background:var(--s2)"></i>Active users</span>
    </div>
    <svg class="chart" id="growth" preserveAspectRatio="none"></svg>
  </div>
  <div class="grid">
    <div class="card">
      <h2>Unfollows reported</h2>
      <p class="cap">Aggregate across all active users, per day.</p>
      <svg class="chart" id="unf" preserveAspectRatio="none"></svg>
    </div>
    <div class="card">
      <h2>By country</h2>
      <p class="cap">Live installs, top 20.</p>
      <div id="country" class="bars"></div>
    </div>
  </div>
  <div class="grid">
    <div class="card">
      <h2>By version</h2>
      <p class="cap">Live installs.</p>
      <div id="version" class="bars"></div>
    </div>
    <div class="card">
      <h2>Why people uninstall</h2>
      <p class="cap">From the uninstall feedback page.</p>
      <div id="reasons"><p class="muted">Loading…</p></div>
    </div>
  </div>
  <p class="muted" style="font-size:12px;margin-top:8px">No IP address, X username or personal data is collected. Install IDs are random and anonymous.</p>
</div>
<div class="tip" id="tip"></div>
<script>
const $=(s)=>document.querySelector(s);
const fmt=(n)=>(n==null?"0":Number(n).toLocaleString());
const tip=$("#tip");
function showTip(e,html){tip.innerHTML=html;tip.style.opacity=1;tip.style.left=(e.clientX+12)+"px";tip.style.top=(e.clientY+12)+"px";}
function hideTip(){tip.style.opacity=0;}
const flag=(cc)=>{if(!cc||cc.length!==2||cc==="??")return"🏳️";return String.fromCodePoint(...[...cc.toUpperCase()].map(c=>127397+c.charCodeAt(0)));};

(function(){ // theme toggle
  try{const t=localStorage.getItem("trk.theme");if(t)document.documentElement.setAttribute("data-theme",t);}catch(e){}
  $("#theme").onclick=()=>{const cur=document.documentElement.getAttribute("data-theme")||(matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light");const next=cur==="dark"?"light":"dark";document.documentElement.setAttribute("data-theme",next);try{localStorage.setItem("trk.theme",next);}catch(e){}draw();};
})();

let DATA=null;
async function load(){
  const days=$("#range").value;
  $("#tiles").innerHTML='<div class="tile"><div class="lab">Loading…</div></div>';
  try{
    const [ov,rs]=await Promise.all([
      fetch("/admin/api/overview?days="+days,{headers:{accept:"application/json"}}).then(r=>r.json()),
      fetch("/admin/api/reasons?days="+days,{headers:{accept:"application/json"}}).then(r=>r.json())
    ]);
    DATA={ov,rs};draw();
  }catch(e){$("#tiles").innerHTML='<div class="tile"><div class="lab err">Failed to load</div><div class="sub">'+e+'</div></div>';}
}
function tiles(ov){
  const t=ov.totals,a=ov.active,p=ov.period;
  const items=[
    ["Live installs",fmt(t.live),"currently installed",""],
    ["Active today",fmt(a.d1),"unique, last 24h",""],
    ["Active 7-day",fmt(a.d7),"WAU",""],
    ["Active 30-day",fmt(a.d30),"MAU",""],
    ["Installs ("+ov.days+"d)",fmt(p.inst),"new in range","good"],
    ["Uninstalls ("+ov.days+"d)",fmt(p.uninst),"removed in range","bad"],
    ["Uninstall rate",t.uninstallRate+"%","of all-time installs",t.uninstallRate>40?"bad":""],
    ["Unfollows ("+ov.days+"d)",fmt(p.unf),"reported by users",""]
  ];
  $("#tiles").innerHTML=items.map(([l,v,s,c])=>'<div class="tile"><div class="lab">'+l+'</div><div class="val '+c+'">'+v+'</div><div class="sub">'+s+'</div></div>').join("");
}
function bars(el,rows,label){
  if(!rows.length){el.innerHTML='<p class="muted">No data yet.</p>';return;}
  const max=Math.max(...rows.map(r=>r.n),1);
  el.innerHTML=rows.map(r=>{
    const k=label==="country"?(flag(r.k)+" "+(r.k||"??")):(r.k||"?");
    return '<div class="brow"><span class="bk" title="'+k+'">'+k+'</span><span class="bt"><span class="bf" style="width:'+Math.max(2,Math.round(r.n/max*100))+'%"></span></span><span class="bn">'+fmt(r.n)+'</span></div>';
  }).join("");
}
// Grouped daily bar chart (installs/uninstalls/active) with hover.
function barChart(svg,series,keys,colors,labels){
  const W=svg.clientWidth||880,H=220,padL=36,padB=22,padT=8;
  svg.setAttribute("viewBox","0 0 "+W+" "+H);svg.innerHTML="";
  const NS="http://www.w3.org/2000/svg";
  const data=series.length?series:[{d:"",_empty:1}];
  const max=Math.max(1,...data.flatMap(d=>keys.map(k=>+d[k]||0)));
  const plotW=W-padL-8,plotH=H-padB-padT;
  for(let g=0;g<=4;g++){const y=padT+plotH*(g/4);const v=Math.round(max*(1-g/4));
    const ln=document.createElementNS(NS,"line");ln.setAttribute("x1",padL);ln.setAttribute("x2",W-8);ln.setAttribute("y1",y);ln.setAttribute("y2",y);ln.setAttribute("class","gl");svg.appendChild(ln);
    const tx=document.createElementNS(NS,"text");tx.setAttribute("x",padL-6);tx.setAttribute("y",y+3);tx.setAttribute("text-anchor","end");tx.textContent=fmt(v);svg.appendChild(tx);}
  const n=data.length,slot=plotW/n,bw=Math.max(1,Math.min(slot/ (keys.length+0.6), 16));
  data.forEach((d,i)=>{
    const x0=padL+slot*i+(slot-bw*keys.length)/2;
    keys.forEach((k,j)=>{
      const v=+d[k]||0,h=v/max*plotH,x=x0+j*bw,y=padT+plotH-h;
      const r=document.createElementNS(NS,"rect");
      r.setAttribute("x",x+0.5);r.setAttribute("y",y);r.setAttribute("width",Math.max(0.5,bw-1));r.setAttribute("height",Math.max(0,h));
      r.setAttribute("rx",Math.min(3,bw/2));r.setAttribute("fill",colors[j]);
      r.addEventListener("mousemove",(e)=>showTip(e,'<b>'+d.d+'</b><br>'+labels.map((L,m)=>L+': '+fmt(d[keys[m]])).join("<br>")));
      r.addEventListener("mouseleave",hideTip);
      svg.appendChild(r);
    });
  });
  if(n<=14||n>0){const step=Math.ceil(n/8);data.forEach((d,i)=>{if(i%step)return;const tx=document.createElementNS(NS,"text");tx.setAttribute("x",padL+slot*i+slot/2);tx.setAttribute("y",H-6);tx.setAttribute("text-anchor","middle");tx.textContent=(d.d||"").slice(5);svg.appendChild(tx);});}
}
function draw(){
  if(!DATA)return;
  const {ov,rs}=DATA;
  tiles(ov);
  barChart($("#growth"),ov.series,["inst","uninst","active"],["var(--s1)","var(--bad)","var(--s2)"],["Installs","Uninstalls","Active"]);
  barChart($("#unf"),ov.series,["unf"],["var(--s2)"],["Unfollows"]);
  bars($("#country"),ov.country,"country");
  bars($("#version"),ov.version,"version");
  const r=rs.reasons||[];
  if(!r.length){$("#reasons").innerHTML='<p class="muted">No uninstall feedback yet.</p>';}
  else{
    const max=Math.max(...r.map(x=>x.n),1);
    const notes=(rs.notes||[]).filter(x=>x.note);
    $("#reasons").innerHTML='<div class="bars">'+r.map(x=>'<div class="brow"><span class="bk" title="'+x.label+'">'+x.label+'</span><span class="bt"><span class="bf" style="width:'+Math.max(2,Math.round(x.n/max*100))+'%;background:var(--bad)"></span></span><span class="bn">'+fmt(x.n)+'</span></div>').join("")+'</div>'+
      (notes.length?'<table style="margin-top:12px"><tr><th>Note</th></tr>'+notes.slice(0,12).map(nt=>'<tr><td>'+(nt.note.replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])))+'</td></tr>').join("")+'</table>':"");
  }
}
$("#range").onchange=load;$("#refresh").onclick=load;
addEventListener("resize",()=>{clearTimeout(window._rz);window._rz=setTimeout(draw,150);});
load();
</script></body></html>`;
