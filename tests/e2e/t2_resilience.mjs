import { boot, log, assert, sleep, OUT } from "./harness.mjs";

const only = process.argv[2];
const results = [];

async function scenario(name, fn, mockOpts) {
  if (only && !name.startsWith(only)) return;
  log("=== " + name);
  const H = await boot(mockOpts);
  H.cmd = async (cmd, extra) => {
    if (!H.ext) H.ext = await H.page(`chrome-extension://${H.extId}/popup.html`, { width: 380, height: 600 });
    return H.ext.evaluate(([c, e]) => chrome.runtime.sendMessage(Object.assign({ cmd: c }, e || {})), [cmd, extra]);
  };
  try {
    await H.setStore({ "x7.settings": { speed: "custom", minDelay: 2, maxDelay: 2, restEvery: 0, restMinutes: 1, dailyLimit: 0 } });
    await fn(H);
    results.push([name, "PASS"]);
  } catch (e) {
    results.push([name, "FAIL: " + e.message]);
    console.error(e);
    console.log("SW logs:\n" + H.swLogs.slice(-30).join("\n"));
    console.log("job:", JSON.stringify(await H.job().catch(() => null)));
    console.log("scan:", JSON.stringify(await H.scan().catch(() => null)));
  } finally {
    await H.close().catch(() => {});
  }
}

async function scanFirst(H) {
  const r = await H.cmd("scan");
  assert(r.ok, "scan started");
  return H.waitFor(async () => { const s = await H.scan(); return s && s.status === "done" ? s : null; }, "scan", 60000);
}

// A. Direct unfollow rejected -> profile mode
await scenario("A profile-mode fallback", async (H) => {
  await H.page("https://x.com/home");
  await sleep(1000);
  await scanFirst(H);
  H.mock.cfg.destroyMode = "404";
  const r = await H.cmd("run", { source: "ids", ids: ["2000", "2009", "2018"] });
  assert(r.ok && r.total === 3, "run of 3 selected started");
  const j = await H.waitFor(async () => { const j = await H.job(); return j.status === "done" ? j : null; }, "done", 120000);
  assert(j.executor === "profile", "switched to profile mode");
  assert(j.done === 3, "3 unfollowed via profiles");
  assert(H.mock.log.ui.length === 3, "mock saw 3 UI unfollows");
  const tabs = H.ctx.pages().map((p) => p.url());
  assert(!tabs.some((u) => /x\.com\/acct_/.test(u)), "worker tab closed afterwards");
});

// B. X tab frozen mid-run
await scenario("B frozen tab recovery", async (H) => {
  const x = await H.page("https://x.com/home");
  await sleep(1000);
  await scanFirst(H);
  const r = await H.cmd("run", { source: "nonfollowers" });
  assert(r.ok, "run started");
  await H.waitFor(async () => (await H.job()).done >= 2, "2 done", 30000);
  const cdp = await H.ctx.newCDPSession(x);
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  log("  x tab frozen at done=" + (await H.job()).done);
  const j = await H.waitFor(async () => { const j = await H.job(); return j.done >= 8 ? j : null; }, "progress after freeze", 120000);
  assert(j.done >= 8, "kept unfollowing after the tab froze (done=" + j.done + ")");
  const xTabs = H.ctx.pages().filter((p) => p.url().startsWith("https://x.com/"));
  log("  x tabs now:", xTabs.map((p) => p.url()).join(", "));
});

// C. Worker killed mid-run (Chrome stops idle workers; updates restart them)
await scenario("C worker killed mid-run", async (H) => {
  await H.page("https://x.com/home");
  await sleep(1000);
  await scanFirst(H);
  await H.cmd("run", { source: "nonfollowers" });
  await H.waitFor(async () => (await H.job()).done >= 3, "3 done", 30000);
  const before = (await H.job()).done;
  await H.stopWorker();
  log("  worker stopped at done=" + before);
  await sleep(3000);
  const mid = (await H.job()).done;
  const j = await H.waitFor(async () => { const j = await H.job(); return j && j.done >= mid + 3 ? j : null; }, "progress after restart", 100000);
  assert(j.done >= mid + 3, "run continued after the worker was killed (done=" + j.done + ")");
});

// D. Account locked -> halted, then resume
await scenario("D lock halts", async (H) => {
  await H.page("https://x.com/home");
  await sleep(1000);
  await scanFirst(H);
  await H.cmd("run", { source: "nonfollowers" });
  await H.waitFor(async () => (await H.job()).done >= 2, "2 done", 30000);
  H.mock.cfg.destroyMode = "locked";
  const j = await H.waitFor(async () => { const j = await H.job(); return j.status === "halted" ? j : null; }, "halted", 30000);
  assert(j.haltKind === "locked", "halted with kind locked");
  const n = H.mock.counters.destroy;
  await sleep(6000);
  assert(H.mock.counters.destroy === n, "no more requests while halted");
  const pop = await H.popup();
  await pop.waitForSelector('[data-view="run"].is-on');
  await pop.screenshot({ path: OUT + "/p8-halted.png" });
  H.mock.cfg.destroyMode = "ok";
  await pop.click("#resumeBtn");
  await H.waitFor(async () => (await H.job()).done >= j.done + 2, "resumed progress", 30000);
  assert(true, "resumed after the user fixed it");
});

// E. Account switched mid-run
await scenario("E account switch halts", async (H) => {
  await H.page("https://x.com/home");
  await sleep(1000);
  await scanFirst(H);
  await H.cmd("run", { source: "nonfollowers" });
  await H.waitFor(async () => (await H.job()).done >= 2, "2 done", 30000);
  await H.ctx.addCookies([{ name: "twid", value: "u%3D5555", domain: "x.com", path: "/", secure: true, sameSite: "None" }]);
  const j = await H.waitFor(async () => { const j = await H.job(); return j.status === "halted" ? j : null; }, "halted", 30000);
  assert(j.haltKind === "account", "halted because the account changed");
});

// F. Daily limit
await scenario("F daily limit rests", async (H) => {
  await H.setStore({ "x7.settings": { speed: "custom", minDelay: 2, maxDelay: 2, restEvery: 0, restMinutes: 1, dailyLimit: 3 } });
  await H.page("https://x.com/home");
  await sleep(1000);
  await scanFirst(H);
  await H.cmd("run", { source: "nonfollowers" });
  const j = await H.waitFor(async () => { const j = await H.job(); return j.status === "resting" && j.restReason === "daily" ? j : null; }, "daily rest", 40000);
  assert(j.done === 3, "stopped at exactly 3");
  assert(j.restUntil - Date.now() > 23 * 3600000, "rests until the 24h window frees");
  const pop = await H.popup();
  await pop.waitForSelector('[data-view="run"].is-on');
  await sleep(400);
  await pop.screenshot({ path: OUT + "/p9-daily.png" });
});

// G. GraphQL read blocked -> page scan by scrolling
await scenario("G DOM scan fallback", async (H) => {
  H.mock.cfg.followingDown = true;
  const x = await H.page("https://x.com/home");
  await sleep(1000);
  await x.bringToFront();
  const r = await H.cmd("scan");
  assert(r.ok, "scan started");
  const s = await H.waitFor(async () => { const s = await H.scan(); return s && s.status === "done" ? s : null; }, "dom scan", 150000);
  log("  dom scan:", s.total, s.nonFollowers, s.method);
  assert(s.method === "dom", "fell back to scrolling");
  assert(s.total === 230 && s.nonFollowers === 26, "page scan found everyone");
});

// H. Signed out
await scenario("H signed out", async (H) => {
  await H.ctx.clearCookies();
  await H.page("https://x.com/home");
  await sleep(1000);
  const r = await H.cmd("scan");
  assert(!r.ok && r.needLogin, "scan refuses with a sign-in message: " + r.error);
  const pop = await H.popup();
  await pop.waitForSelector('[data-view="signin"].is-on', { timeout: 10000 });
  await pop.screenshot({ path: OUT + "/p10-signin.png" });
});

// I. No relationship flags -> followers list used
await scenario("I followers fallback", async (H) => {
  H.mock.cfg.noRelFlags = true;
  await H.page("https://x.com/home");
  await sleep(1000);
  const s = await scanFirst(H);
  assert(s.nonFollowers === 26 && s.mutuals === 204, "relationships resolved from the followers list");
});

// J. Old-style webpack runtime + no X tab open at all
await scenario("J no tab + old runtime", async (H) => {
  const r = await H.cmd("scan");
  assert(r.ok, "scan started without any X tab open");
  const s = await H.waitFor(async () => { const s = await H.scan(); return s && s.status === "done" ? s : null; }, "scan", 60000);
  assert(s.total === 230, "scan complete");
  await sleep(1500);
  assert(!H.ctx.pages().some((p) => p.url().startsWith("https://x.com/")), "background tab it opened was closed");
}, { oldRuntime: true });

// K. X omits false "followed_by" flags
await scenario("K omitted false flags", async (H) => {
  H.mock.cfg.omitFalse = true;
  await H.page("https://x.com/home");
  await sleep(1000);
  const s = await scanFirst(H);
  assert(s.nonFollowers === 26 && s.mutuals === 204 && s.unknown === 0, "missing flag read as 'does not follow you'");
});

// L. X caps the page size
await scenario("L page size cap", async (H) => {
  H.mock.cfg.maxCount = 20;
  await H.page("https://x.com/home");
  await sleep(1000);
  const s = await scanFirst(H);
  assert(s.method === "api" && s.total === 230, "scan stayed on the API with 20 per page");
});

console.log("\n" + results.map(([n, r]) => `${r.startsWith("PASS") ? "PASS" : "FAIL"}  ${n}${r.startsWith("PASS") ? "" : "  - " + r}`).join("\n"));
process.exit(results.some(([, r]) => !r.startsWith("PASS")) ? 1 : 0);
