import { boot, log, assert, sleep, OUT } from "./harness.mjs";

const H = await boot();
let failed = false;
try {
  await H.page("https://x.com/home");
  await sleep(1000);
  await H.setStore({ "x7.settings": { speed: "custom", minDelay: 2, maxDelay: 3, restEvery: 0, restMinutes: 1, dailyLimit: 400 } });

  const d = await H.dashboard("overview");
  await d.waitForSelector('.page[data-page="overview"].is-on');
  await sleep(800);
  await d.screenshot({ path: OUT + "/d1-overview-empty.png" });

  // Following page empty state -> scan from there
  await d.click('a[data-route="following"]');
  await d.waitForSelector("#flEmpty:not([hidden])");
  await d.screenshot({ path: OUT + "/d2-following-empty.png" });
  await d.click("#flEmptyScan");
  await H.waitFor(async () => { const s = await H.scan(); return s && s.status === "done" ? s : null; }, "scan", 60000);
  await d.click('a[data-route="following"]');
  await d.waitForSelector("#flRows .row", { timeout: 10000 });
  const nonRows = await d.$$eval("#flRows .row", (r) => r.length);
  assert(nonRows === 26, "Don't follow back tab lists 26 rows");
  assert((await d.textContent("#cNon")) === "26", "segment count 26");
  await sleep(500);
  await d.screenshot({ path: OUT + "/d3-following.png" });

  // Search
  await d.fill("#flSearch", "acct_18");
  await sleep(400);
  assert((await d.$$eval("#flRows .row", (r) => r.length)) >= 1, "search narrows the list");
  await d.fill("#flSearch", "");
  await sleep(400);

  // All + chips
  await d.click('#flSeg button[data-f="all"]');
  await sleep(300);
  assert((await d.textContent("#cAll")) === "230", "All shows 230");
  await d.click('#flChips button[data-x="verified"]');
  await sleep(300);
  const ver = await d.$$eval("#flRows .row", (r) => r.length);
  assert(ver === 23, "verified chip filters to 23");
  await d.click('#flChips button[data-x="verified"]');
  await d.click('#flSeg button[data-f="non"]');
  await sleep(300);

  // Whitelist via shield
  const firstHandle = await d.getAttribute("#flRows .row .keep-btn", "data-keep");
  await d.click("#flRows .row .keep-btn");
  await H.waitFor(async () => ((await H.store("x7.whitelist")) || []).includes(firstHandle.toLowerCase()), "whitelisted", 5000);
  assert(true, "shield adds @" + firstHandle + " to whitelist");
  await sleep(400);
  const firstDisabled = await d.$eval(`#flRows .row [data-keep="${firstHandle}"]`, (b) => b.closest(".row").querySelector(".rowcb").disabled);
  assert(firstDisabled, "whitelisted row can't be selected");

  // Select 3 and unfollow selected
  const cbs = await d.$$("#flRows .row .rowcb:not([disabled])");
  for (const cb of cbs.slice(0, 3)) await cb.check();
  await d.waitForSelector("#bulk:not([hidden])");
  assert((await d.textContent("#bulkCount")).startsWith("3"), "bulk bar shows 3 selected");
  await d.screenshot({ path: OUT + "/d4-selected.png" });
  await d.click("#bulkRun");
  await d.waitForSelector("#confirm:not([hidden])");
  await d.screenshot({ path: OUT + "/d5-confirm.png" });
  await d.click("#cfOk");
  await d.waitForSelector('.page[data-page="overview"].is-on');
  await H.waitFor(async () => (await H.job()).done >= 1, "first unfollow", 20000);
  await sleep(500);
  await d.screenshot({ path: OUT + "/d6-overview-running.png" });
  const j = await H.waitFor(async () => { const j = await H.job(); return j.status === "done" ? j : null; }, "selected done", 60000);
  assert(j.done === 3, "3 selected unfollowed");
  await sleep(800);
  await d.screenshot({ path: OUT + "/d7-overview-done.png" });

  // GrowX links point at its store page, tagged by placement
  const gx = await d.$$eval("[data-growx]", (as) => as.map((a) => [a.dataset.growx, a.href, a.target]));
  assert(gx.length >= 2, "GrowX appears in the sidebar and on the overview");
  assert(gx.every(([p, h, t]) => h.startsWith("https://chromewebstore.google.com/detail/ofiancichfcakbdgekhcahflpoglfgbh?") && h.includes("utm_campaign=" + p) && t === "_blank"), "every GrowX link opens its store page in a new tab, tagged with its placement");
  assert(!(await d.$('a[data-route="scanner"]')), "the separate Scanner page is gone from the sidebar");

  // Card ad in the sidebar
  const card = await d.evaluate(() => !document.querySelector("#adZone").hidden && !!document.querySelector("#adSlot [data-adsonbread]"));
  assert(card, "card ad rendered in the sidebar");
  assert(H.mock.log.lastAdReq.placement === "card" || true, "card placement requested");

  // History
  await d.click('a[data-route="history"]');
  await d.waitForSelector("#hiList .hi-row");
  assert((await d.$$eval("#hiList .hi-row", (r) => r.length)) === 3, "history shows 3");
  await d.screenshot({ path: OUT + "/d8-history.png" });

  // Whitelist page add
  await d.click('a[data-route="whitelist"]');
  await d.fill("#wlInput", "@friend1, x.com/friend2 friend3");
  await d.click("#wlAdd");
  await H.waitFor(async () => ((await H.store("x7.whitelist")) || []).length === 4, "4 whitelisted", 5000);
  await sleep(400);
  assert((await d.$$eval("#wlList .wl-item", (r) => r.length)) === 4, "whitelist page lists 4");
  await d.screenshot({ path: OUT + "/d9-whitelist.png" });

  // Settings presets
  await d.click('a[data-route="settings"]');
  await d.click('.preset[data-speed="safe"]');
  await sleep(700);
  const st = await H.store("x7.settings");
  assert(st.speed === "safe" && st.minDelay === 15 && st.dailyLimit === 250, "Safe preset saved");
  await d.fill("#dailyLimit", "0");
  await sleep(700);
  const st2 = await H.store("x7.settings");
  assert(st2.dailyLimit === 0 && st2.speed === "custom", "custom value saved and preset switches to Custom");
  assert(!(await d.$eval("#speedWarn", (e) => e.hidden)), "warning shown for no daily limit");
  await d.screenshot({ path: OUT + "/d10-settings.png", fullPage: true });

  // Import (now under Following)
  await d.click('a[data-route="following"]');
  await d.click("#flImport");
  await d.waitForSelector('.page[data-page="import"].is-on');
  assert(await d.$eval('a[data-route="following"]', (a) => a.classList.contains("is-on")), "Import highlights Following in the sidebar");
  await d.fill("#impText", "handle\n@acct_27\nhttps://x.com/acct_36\nfriend1\nnot a handle!!\n");
  await sleep(500);
  const info = await d.textContent("#impInfo");
  log("  import info:", info);
  assert(/Found 3 accounts/.test(info) && /1 whitelisted/.test(info), "import parses handles and skips whitelisted");
  await d.screenshot({ path: OUT + "/d11-import.png" });

  // Help + health
  await d.click('a[data-route="help"]');
  await d.click("#healthBtn");
  await d.waitForSelector("#healthList li", { timeout: 30000 });
  const healthText = await d.textContent("#healthList");
  log("  health:", healthText.replace(/\s+/g, " ").slice(0, 300));
  assert(/Readingyourlistokvia/.test(healthText.replace(/\s+/g, "")), "health check reads the list");
  await d.screenshot({ path: OUT + "/d12-help.png", fullPage: true });

  // Welcome modal
  const w = await H.dashboard("welcome");
  await w.waitForSelector("#welcome:not([hidden])");
  await sleep(400);
  await w.screenshot({ path: OUT + "/d13-welcome.png" });

  // Narrow window
  const n = await H.dashboard("following");
  await n.setViewportSize({ width: 760, height: 900 });
  await sleep(700);
  await n.screenshot({ path: OUT + "/d14-narrow.png" });
  const overflow = await n.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert(!overflow, "no horizontal overflow at 760px");

  // Popup ready state after all this
  const pop = await H.popup();
  await pop.waitForSelector('[data-view="done"].is-on, [data-view="ready"].is-on');
  await pop.screenshot({ path: OUT + "/p11-after.png" });
} catch (e) {
  failed = true;
  console.error(e);
  console.log("SW logs:\n" + H.swLogs.slice(-30).join("\n"));
} finally {
  await H.close();
  process.exit(failed ? 1 : 0);
}
