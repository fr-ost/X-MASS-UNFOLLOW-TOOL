// Core flow: install -> scan via API (POST + txid + feature self-heal) ->
// unfollow non-followers via API while the X tab is in the background,
// with whitelist, a 429 auto-rest, and a cooldown break.
import { boot, log, assert, sleep, OUT } from "./harness.mjs";

const H = await boot();
const { mock } = H;
let failed = false;
try {
  log("ext id", H.extId);
  // Welcome page opens on install.
  await sleep(1500);
  const welcome = H.ctx.pages().find((p) => p.url().includes("dashboard.html"));
  assert(!!welcome, "dashboard opens on first install");

  const x = await H.page("https://x.com/home");
  await sleep(1200);

  // Fast test pacing.
  await H.setStore({ "x7.settings": { speed: "custom", minDelay: 2, maxDelay: 2, restEvery: 8, restMinutes: 1, dailyLimit: 0 } });

  const pop = await H.popup();
  await pop.waitForSelector('[data-view="start"].is-on', { timeout: 15000 });
  await pop.waitForFunction(() => document.querySelector("#accName").textContent.includes("Test Person"), null, { timeout: 15000 });
  assert(true, "popup shows the signed-in account");
  await pop.screenshot({ path: OUT + "/p1-start.png" });

  // Whitelist one non-follower (acct_9) before running.
  await H.setStore({ "x7.whitelist": ["acct_9"] });

  await pop.click("#scanBtn");
  await pop.waitForSelector('[data-view="scanning"].is-on', { timeout: 10000 });
  await pop.screenshot({ path: OUT + "/p2-scanning.png" });
  const scan = await H.waitFor(async () => { const s = await H.scan(); return s && s.status === "done" ? s : null; }, "scan done", 60000);
  log("scan:", JSON.stringify({ total: scan.total, non: scan.nonFollowers, mutual: scan.mutuals, pages: scan.pages, method: scan.method }));
  assert(scan.total === 230, "scan read all 230 accounts");
  assert(scan.nonFollowers === 26, "26 non-followers found");
  assert(scan.method === "api", "scan used the API");
  assert(mock.log.gql.every((g) => g.method === "POST"), "GraphQL adapted to POST");
  assert(mock.log.txOk > 0 && mock.log.txBad.length === 0, `transaction ids valid (ok=${mock.log.txOk}, bad=${mock.log.txBad.length})`);
  assert(mock.log.gqlBad.some((b) => b.why === "features"), "missing feature flag was learned from X's error");

  await pop.waitForSelector('[data-view="ready"].is-on', { timeout: 10000 });
  const label = await pop.textContent("#runNonLabel");
  log("button:", label);
  assert(/Unfollow 25 non-followers/.test(label), "whitelisted account excluded (25 actionable)");
  await pop.screenshot({ path: OUT + "/p3-ready.png" });

  // 429 on the 5th unfollow.
  mock.cfg.destroy429At = 5;

  await pop.click("#runNonBtn");
  await pop.waitForSelector("#sheet:not([hidden])");
  await pop.screenshot({ path: OUT + "/p4-confirm.png" });
  await pop.click("#sheetOk");
  await pop.waitForSelector('[data-view="run"].is-on', { timeout: 10000 });

  // Put another tab in front: the X tab is now hidden.
  const other = await H.page("about:blank");
  await other.bringToFront();
  const vis = await x.evaluate(() => document.visibilityState);
  log("x tab visibility:", vis);

  await H.waitFor(async () => (await H.job()).done >= 2, "first unfollows", 30000);
  await pop.bringToFront();
  await sleep(300);
  await pop.screenshot({ path: OUT + "/p5-running.png" });
  await other.bringToFront();

  // Rate limit -> resting with reason "rate".
  const rested = await H.waitFor(async () => { const j = await H.job(); return j.status === "resting" && j.restReason === "rate" ? j : null; }, "rate rest", 40000);
  assert(rested.restUntil - Date.now() >= 4 * 60000, "rests at least 5 min after a 429");
  await pop.bringToFront();
  await sleep(300);
  await pop.screenshot({ path: OUT + "/p6-resting.png" });
  await other.bringToFront();
  await H.fastForward();

  // Cooldown after 8.
  const cool = await H.waitFor(async () => { const j = await H.job(); return j.status === "resting" && j.restReason === "cooldown" ? j : null; }, "cooldown", 60000);
  assert(cool.done === 8, "cooldown kicks in after 8 unfollows");
  await H.fastForward();

  // Finish (fast-forward through further cooldowns).
  const fin = await H.waitFor(async () => {
    const j = await H.job();
    if (j.status === "resting") await H.fastForward();
    return j.status === "done" ? j : null;
  }, "job done", 180000, 700);
  log("job:", JSON.stringify({ done: fin.done, skipped: fin.skipped, failed: fin.failed, executor: fin.executor }));
  assert(fin.done === 25, "unfollowed all 25");
  assert(mock.log.destroy.length === 25, "mock saw 25 successful destroys");
  assert(!mock.log.destroy.some((d) => d.h === "acct_9"), "whitelisted acct_9 untouched");
  const nonIds = new Set(mock.users.filter((u) => !u.fy).map((u) => u.id));
  assert(mock.log.destroy.every((d) => nonIds.has(d.id)), "only non-followers were unfollowed");
  // Pacing: gaps between consecutive destroys (excluding fast-forwarded ones) >= ~2s
  const gaps = mock.log.destroy.slice(1).map((d, i) => d.t - mock.log.destroy[i].t);
  log("min gap ms:", Math.min(...gaps));
  assert(Math.min(...gaps) >= 1500, "pacing respected between unfollows");
  const hist = await H.store("x7.history");
  assert(hist.length === 25, "history has 25 entries");
  const ledger = await H.store("x7.ledger");
  assert(ledger.length === 25, "daily ledger counted 25");

  await pop.bringToFront();
  await pop.waitForSelector('[data-view="done"].is-on', { timeout: 10000 });
  await pop.screenshot({ path: OUT + "/p7-done.png" });
  const badge = await H.sw.evaluate(() => chrome.action.getBadgeText({}));
  log("badge:", badge);
  assert(badge === "✓", "badge shows a check when finished");

  // Ad rendered in popup
  const adShown = await pop.evaluate(() => !document.querySelector("#adZone").hidden && !!document.querySelector("#adSlot [data-adsonbread]"));
  assert(adShown, "banner ad rendered in popup");
  assert(mock.log.lastAdReq && mock.log.lastAdReq.api_key === "3f7833e9-73d8-4412-870a-e6c49bc91f90", "ad request uses the publisher key");
} catch (e) {
  failed = true;
  console.error(e);
  console.log("SW logs:\n" + H.swLogs.slice(-40).join("\n"));
  console.log("job:", JSON.stringify(await H.job().catch(() => null)));
  console.log("scan:", JSON.stringify(await H.scan().catch(() => null)));
  console.log("mock gqlBad:", JSON.stringify(mock.log.gqlBad.slice(-10)), "txBad:", JSON.stringify(mock.log.txBad.slice(-5)));
} finally {
  await H.close();
  process.exit(failed ? 1 : 0);
}
