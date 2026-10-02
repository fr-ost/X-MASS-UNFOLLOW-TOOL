// Builds the Chrome Web Store graphics from the real extension UI.
//   PLAYWRIGHT=/path/to/playwright node design/store-assets.mjs
// 1) boots the extension against the mock x.com with fictional showcase data
// 2) captures real popup / dashboard screens at 2x
// 3) composes 5 screenshots (1280x800) + small tile (440x280) + marquee (1400x560)
// Output: store/ (24-bit PNG, no alpha, as the Web Store requires).
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { boot, sleep } from "../tests/e2e/harness.mjs";
import { showcase } from "./showcase-data.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, "store");
const CAP = path.join(ROOT, "design", ".captures");
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(CAP, { recursive: true });

const data = showcase();
const H = await boot({ users: data.users, owner: data.owner, initialsAvatars: true }, { deviceScaleFactor: 2 });
H.mock.cfg.pageSize = 100;
const now = Date.now();

async function setTheme(t) {
  const p = await H.page(`chrome-extension://${H.extId}/privacy.html`);
  await p.evaluate((x) => localStorage.setItem("x7.theme", x), t);
  await p.close();
}
async function popupShot(name, theme, viewName) {
  await setTheme(theme);
  const p = await H.ctx.newPage();
  await p.setViewportSize({ width: 380, height: 600 });
  await p.goto(`chrome-extension://${H.extId}/popup.html`);
  await p.waitForSelector(`[data-view="${viewName}"].is-on`, { timeout: 15000 });
  await sleep(1600);
  const h = await p.evaluate(() => document.body.scrollHeight);
  await p.setViewportSize({ width: 380, height: Math.min(600, h) });
  await sleep(300);
  await p.screenshot({ path: path.join(CAP, name + ".png"), scale: "device" });
  await p.close();
}
async function dashShot(name, theme, hash, prep, size) {
  await setTheme(theme);
  const p = await H.ctx.newPage();
  await p.setViewportSize(size || { width: 1360, height: 860 });
  await p.goto(`chrome-extension://${H.extId}/dashboard.html#${hash}`);
  await sleep(1200);
  if (prep) await prep(p);
  await sleep(900);
  await p.screenshot({ path: path.join(CAP, name + ".png") });
  await p.close();
}

try {
  // ---- real data: scan the showcase account ----
  await H.page("https://x.com/home");
  await sleep(1200);
  await H.setStore({ "x7.settings": { speed: "balanced", minDelay: 8, maxDelay: 20, restEvery: 50, restMinutes: 6, dailyLimit: 400 } });
  await H.setStore({ "x7.whitelist": ["cafe_atlas", "pixelpinestudio", "sofiamtz_codes", "hannahlee_ux"] });
  const ext = await H.page(`chrome-extension://${H.extId}/privacy.html`);
  await ext.evaluate(() => chrome.runtime.sendMessage({ cmd: "scan" }));
  await H.waitFor(async () => { const s = await H.scan(); return s && s.status === "done" ? s : null; }, "scan", 120000);

  // Ready state (light + dark)
  await popupShot("popup-ready-light", "light", "ready");
  await popupShot("popup-ready-dark", "dark", "ready");

  // Following review (light), filtered to non-followers, a few selected
  await dashShot("dash-following-light", "light", "following", async (p) => {
    await p.waitForSelector("#flRows .row");
    const cbs = await p.$$("#flRows .row .rowcb:not([disabled])");
    for (const cb of cbs.slice(1, 4)) await cb.check();
    await p.mouse.move(5, 5);
  });

  // A run in progress: history + an active job (fabricated progress numbers)
  const non = data.users.filter((u) => !u.fy);
  const hist = non.slice(20, 147).map((u, i) => ({ i: u.id, h: u.h, n: u.n, a: `https://pbs.twimg.com/profile_images/${u.id}/a_normal.jpg`, t: now - (127 - i) * 26000, s: "nonfollowers" }));
  const cur = non[3];
  const job = {
    id: "show", status: "running", source: "nonfollowers", ownerId: "1000", total: 408, index: 131, done: 127, skipped: 3, failed: 1,
    startedAt: now - 3400000, nextAt: now + 14000, sinceRest: 27, executor: "api", consecutiveFails: 0, targetFails: 0, rateHits: 0,
    current: { i: cur.id, h: cur.h, n: cur.n, a: `https://pbs.twimg.com/profile_images/${cur.id}/a_normal.jpg` }, inFlight: null,
    message: `Unfollowed @${non[2].h}`,
    log: hist.slice(-12).reverse().map((h, k) => ({ t: h.t, h: h.h, r: k === 4 ? "skip" : "ok", m: k === 4 ? "on your whitelist" : "unfollowed" }))
  };
  await H.setStore({ "x7.history": hist, "x7.ledger": hist.map((h) => h.t), "x7.job": job });
  await popupShot("popup-run-light", "light", "run");
  await popupShot("popup-run-dark", "dark", "run");
  await dashShot("dash-overview-dark", "dark", "overview");
  await dashShot("dash-overview-light", "light", "overview");
  await H.setStore({ "x7.job": { ...job, status: "resting", restReason: "cooldown", restUntil: now + 5 * 60000 + 12000, message: "Short break after 50 unfollows. Back in a few minutes." } });
  await popupShot("popup-rest-light", "light", "run");
  await H.setStore({ "x7.job": { ...job, status: "done", index: 408, done: 401, skipped: 6, failed: 1, finishedAt: now, startedAt: now - 3 * 3600000 - 1260000, message: "Finished. Unfollowed 401 accounts." } });
  await popupShot("popup-done-light", "light", "done");
  await dashShot("dash-settings-light", "light", "settings", null, { width: 1360, height: 900 });
  await dashShot("dash-whitelist-light", "light", "history", null, { width: 1360, height: 900 });
} finally {
  await H.close();
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------
const { chromium } = (await import("module")).createRequire(import.meta.url)(process.env.PLAYWRIGHT || "playwright");
const img = (n) => "data:image/png;base64," + fs.readFileSync(path.join(CAP, n + ".png")).toString("base64");
const logo = "data:image/svg+xml;base64," + fs.readFileSync(path.join(ROOT, "ui/logo.svg")).toString("base64");
const tok = (n) => "data:image/svg+xml;base64," + fs.readFileSync(path.join(ROOT, `ui/donate/tok-${n}.svg`)).toString("base64");

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;color:#0C1324;overflow:hidden}
.scene{position:relative;overflow:hidden}
.bg-light{background:radial-gradient(900px 500px at 85% -10%,rgba(99,102,241,.22),transparent 60%),radial-gradient(700px 500px at -10% 110%,rgba(59,130,246,.18),transparent 60%),linear-gradient(180deg,#F7F8FD,#EEF1FB)}
.bg-dark{color:#E9EDF6;background:radial-gradient(900px 500px at 85% -10%,rgba(124,58,237,.35),transparent 60%),radial-gradient(800px 520px at -10% 110%,rgba(59,130,246,.28),transparent 60%),#090D16}
.bg-brand{color:#fff;background:radial-gradient(800px 420px at 90% 0%,rgba(255,255,255,.18),transparent 60%),linear-gradient(135deg,#3B82F6 0%,#4F46E5 52%,#7C3AED 100%)}
.brand{display:flex;align-items:center;gap:12px;font-weight:800;font-size:20px;letter-spacing:-.02em}
.brand img{width:44px;height:44px;filter:drop-shadow(0 8px 18px rgba(79,70,229,.35))}
.brand small{display:block;font-size:13px;font-weight:700;background:linear-gradient(135deg,#3B82F6,#7C3AED);-webkit-background-clip:text;color:transparent}
.bg-brand .brand small,.bg-dark .brand small{-webkit-background-clip:initial;background:none;color:rgba(255,255,255,.85)}
h1{font-size:54px;line-height:1.04;letter-spacing:-.045em;font-weight:850}
h1 .g{background:linear-gradient(135deg,#3B82F6,#6D3AF0 60%,#A855F7);-webkit-background-clip:text;color:transparent}
.bg-dark h1 .g{background:linear-gradient(135deg,#7AA2FF,#A78BFA);-webkit-background-clip:text}
.sub{font-size:20px;line-height:1.45;color:#4A5468;margin-top:16px}
.bg-dark .sub{color:#A5AFC4}
.ticks{list-style:none;margin-top:26px;display:grid;gap:13px}
.ticks li{display:flex;align-items:center;gap:12px;font-size:18px;font-weight:600}
.ticks li::before{content:"";width:26px;height:26px;flex:none;border-radius:8px;background:linear-gradient(135deg,#3B82F6,#7C3AED) center/16px no-repeat;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m5 12.5 4.5 4.5L19 7.5'/%3E%3C/svg%3E"),linear-gradient(135deg,#3B82F6,#7C3AED)}
.shot{border-radius:22px;box-shadow:0 40px 80px rgba(15,23,42,.28),0 0 0 1px rgba(15,23,42,.06);overflow:hidden;background:#fff}
.bg-dark .shot{box-shadow:0 40px 90px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.08)}
.shot img{display:block;width:100%}
.win{border-radius:16px;overflow:hidden;box-shadow:0 40px 90px rgba(15,23,42,.28),0 0 0 1px rgba(15,23,42,.08);background:#fff}
.bg-dark .win{box-shadow:0 40px 100px rgba(0,0,0,.65),0 0 0 1px rgba(255,255,255,.08);background:#111725}
.bar{height:34px;display:flex;align-items:center;gap:7px;padding:0 14px;background:#EEF1F6;border-bottom:1px solid #E1E5EE}
.bg-dark .bar{background:#171F31;border-color:#232D44}
.bar i{width:11px;height:11px;border-radius:50%;background:#F87171}.bar i:nth-child(2){background:#FBBF24}.bar i:nth-child(3){background:#34D399}
.bar span{margin-left:14px;flex:1;height:20px;border-radius:7px;background:#fff;font-size:11px;color:#8A93A6;display:flex;align-items:center;padding-left:10px}
.bg-dark .bar span{background:#0E1424;color:#6E7A93}
.win img{display:block;width:100%}
.badge{position:absolute;display:flex;align-items:center;gap:12px;padding:14px 18px;border-radius:18px;background:#fff;box-shadow:0 24px 50px rgba(15,23,42,.22);font-weight:750;font-size:16px}
.badge b{font-size:28px;letter-spacing:-.03em;color:#E11D48}
.bg-dark .badge{background:#171F31;color:#E9EDF6;box-shadow:0 24px 50px rgba(0,0,0,.5)}
.pill{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;font-weight:750;font-size:14px;background:rgba(79,70,229,.1);color:#3D44D6}
.bg-dark .pill,.bg-brand .pill{background:rgba(255,255,255,.14);color:#fff}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.feat{padding:22px;border-radius:20px;background:#fff;box-shadow:0 12px 30px rgba(15,23,42,.08),0 0 0 1px rgba(15,23,42,.05)}
.feat i{display:grid;place-items:center;width:46px;height:46px;border-radius:14px;background:linear-gradient(135deg,rgba(59,130,246,.15),rgba(124,58,237,.15));font-style:normal;font-size:22px;margin-bottom:12px;color:#4F46E5}
.feat b{display:block;font-size:19px;letter-spacing:-.02em;margin-bottom:4px}
.feat p{font-size:14.5px;color:#4A5468;line-height:1.45}
`;
const ICON = (d) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const I = {
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 4v4.5H8"/><path d="M12 8v4l3 2"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  upload: '<path d="M12 15V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'
};

const scenes = {
  "01-unfollow-non-followers": { w: 1280, h: 800, html: `
  <div class="scene bg-light" style="width:1280px;height:800px">
    <div style="position:absolute;left:84px;top:96px;width:560px">
      <div class="brand"><img src="${logo}"><div>X Mass Unfollow<small>Free &amp; Unlimited</small></div></div>
      <h1 style="margin-top:44px">See who doesn't follow you back. <span class="g">Unfollow them in one click.</span></h1>
      <p class="sub">The free &amp; unlimited mass unfollow tool for X (Twitter).</p>
      <ul class="ticks"><li>Scans your whole following list in a minute</li><li>Bulk unfollow non-followers - or everyone</li><li>Whitelist the people you never want to lose</li></ul>
    </div>
    <div class="shot" style="position:absolute;right:110px;top:84px;width:400px"><img src="${img("popup-ready-light")}"></div>
    <div class="badge" style="right:450px;top:560px"><b>412</b><span>don't follow<br>you back</span></div>
  </div>` },
  "02-review-and-pick": { w: 1280, h: 800, html: `
  <div class="scene bg-light" style="width:1280px;height:800px">
    <div style="position:absolute;left:0;right:0;top:54px;text-align:center">
      <span class="pill">Review &amp; pick</span>
      <h1 style="font-size:46px;margin-top:14px">Choose exactly who goes - <span class="g">and who stays</span></h1>
      <p class="sub" style="font-size:18px;margin-top:10px">Search, filter and multi-select your whole following list. One tap on the shield protects anyone forever.</p>
    </div>
    <div class="win" style="position:absolute;left:110px;right:110px;top:268px;height:600px"><div class="bar"><i></i><i></i><i></i><span>X Mass Unfollow &middot; Dashboard</span></div><img src="${img("dash-following-light")}"></div>
  </div>` },
  "03-runs-in-background": { w: 1280, h: 800, html: `
  <div class="scene bg-light" style="width:1280px;height:800px">
    <div style="position:absolute;left:84px;top:120px;width:520px">
      <span class="pill">Safe pacing</span>
      <h1 style="margin-top:18px">Runs in the background. <span class="g">Safely.</span></h1>
      <p class="sub">Switch tabs, close the popup, keep working - it carries on at a human pace.</p>
      <ul class="ticks"><li>Random delays and regular breaks</li><li>A daily limit that continues automatically</li><li>Rests on its own if X says slow down</li><li>Emergency stop: Alt + Shift + S</li></ul>
    </div>
    <div class="shot" style="position:absolute;right:300px;top:96px;width:340px;transform:rotate(-3deg);opacity:.98"><img src="${img("popup-rest-light")}"></div>
    <div class="shot" style="position:absolute;right:76px;top:70px;width:370px"><img src="${img("popup-run-light")}"></div>
  </div>` },
  "04-dark-mode": { w: 1280, h: 800, html: `
  <div class="scene bg-dark" style="width:1280px;height:800px">
    <div style="position:absolute;left:84px;top:70px;width:560px">
      <span class="pill">New</span>
      <h1 style="margin-top:16px;font-size:50px">Beautiful in <span class="g">light &amp; dark</span></h1>
    </div>
    <div class="win" style="position:absolute;left:84px;top:236px;width:860px;height:620px"><div class="bar"><i></i><i></i><i></i><span>X Mass Unfollow &middot; Overview</span></div><img src="${img("dash-overview-dark")}"></div>
    <div class="shot" style="position:absolute;right:70px;top:120px;width:350px"><img src="${img("popup-run-dark")}"></div>
  </div>` },
  "05-free-and-private": { w: 1280, h: 800, html: `
  <div class="scene bg-light" style="width:1280px;height:800px">
    <div style="position:absolute;left:84px;top:70px;width:620px">
      <span class="pill">100% free &middot; no sign-up</span>
      <h1 style="margin-top:16px;font-size:50px">Free. Unlimited. <span class="g">Private.</span></h1>
      <p class="sub" style="font-size:18px">No paywall, no tracking. Your data never leaves your browser.</p>
    </div>
    <div class="grid" style="position:absolute;left:84px;top:300px;width:720px">
      <div class="feat"><i>${ICON(I.shield)}</i><b>Whitelist</b><p>Protect friends and favourites - never unfollowed.</p></div>
      <div class="feat"><i>${ICON(I.sliders)}</i><b>Keep rules</b><p>Keep verified, private or big accounts automatically.</p></div>
      <div class="feat"><i>${ICON(I.history)}</i><b>History</b><p>See everyone you unfollowed, and when.</p></div>
      <div class="feat"><i>${ICON(I.download)}</i><b>CSV export</b><p>Download non-followers, selections and history.</p></div>
      <div class="feat"><i>${ICON(I.upload)}</i><b>Import a list</b><p>Unfollow exactly the accounts in a CSV.</p></div>
      <div class="feat"><i>${ICON(I.lock)}</i><b>Private</b><p>No servers, no analytics. Everything stays local.</p></div>
    </div>
    <div class="shot" style="position:absolute;right:84px;top:110px;width:350px"><img src="${img("popup-done-light")}"></div>
  </div>` },
  "promo-small-440x280": { w: 440, h: 280, html: `
  <div class="scene bg-brand" style="width:440px;height:280px">
    <div style="position:absolute;left:30px;top:34px;width:250px">
      <img src="${logo}" style="width:62px;height:62px;filter:drop-shadow(0 10px 20px rgba(0,0,0,.25))">
      <div style="font-size:30px;font-weight:850;letter-spacing:-.04em;line-height:1.05;margin-top:16px">X Mass<br>Unfollow</div>
      <div style="margin-top:12px;display:inline-block;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.18);font-weight:800;font-size:13.5px">Free &amp; Unlimited</div>
      <div style="margin-top:12px;font-size:13.5px;opacity:.92;font-weight:600">Unfollow non-followers in one click</div>
    </div>
    <div class="shot" style="position:absolute;left:270px;top:30px;width:200px;transform:rotate(4deg);box-shadow:0 24px 50px rgba(0,0,0,.35)"><img src="${img("popup-ready-light")}"></div>
  </div>` },
  "promo-marquee-1400x560": { w: 1400, h: 560, html: `
  <div class="scene bg-brand" style="width:1400px;height:560px">
    <div style="position:absolute;left:80px;top:78px;width:560px">
      <div class="brand" style="font-size:22px"><img src="${logo}" style="filter:drop-shadow(0 10px 20px rgba(0,0,0,.25))"><div>X Mass Unfollow<small>Free &amp; Unlimited</small></div></div>
      <h1 style="margin-top:30px;font-size:52px">The best way to mass unfollow on X</h1>
      <p class="sub" style="color:rgba(255,255,255,.88);font-size:19px">Find everyone who doesn't follow you back and clean up your following list in minutes - free, unlimited and private.</p>
    </div>
    <div class="win" style="position:absolute;left:690px;top:70px;width:760px;height:540px;box-shadow:0 40px 90px rgba(0,0,0,.35)"><div class="bar"><i></i><i></i><i></i><span>X Mass Unfollow &middot; Dashboard</span></div><img src="${img("dash-following-light")}"></div>
    <div class="shot" style="position:absolute;left:600px;top:150px;width:290px;box-shadow:0 40px 90px rgba(0,0,0,.4)"><img src="${img("popup-ready-light")}"></div>
  </div>` }
};

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [name, s] of Object.entries(scenes)) {
  await page.setViewportSize({ width: s.w, height: s.h });
  await page.setContent(`<!DOCTYPE html><html><head><style>${CSS}</style></head><body>${s.html}</body></html>`);
  await page.waitForTimeout(400);
  const raw = path.join(CAP, name + ".raw.png");
  await page.screenshot({ path: raw, clip: { x: 0, y: 0, width: s.w, height: s.h } });
  // Flatten to 24-bit RGB (no alpha) as the Web Store requires.
  execFileSync("python3", ["-c", `from PIL import Image; im=Image.open(${JSON.stringify(raw)}).convert("RGB"); im.save(${JSON.stringify(path.join(OUT, name + ".png"))}, optimize=True); print(im.size, im.mode)`], { stdio: "inherit" });
}
await browser.close();
console.log("done ->", OUT);
