// Scanner: Non-blue verified + Inactive.
//   - the blue-check flag is read; accounts with no flag are left out, never guessed
//   - the last-active check reads each account's newest post/reply/repost, skipping
//     pinned posts and other people's posts in reply threads, and records
//     "unavailable" (with a reason) instead of guessing
//   - 30d+/90d+/180d+/1y+ filters, Most/Least inactive first, "N days ago" text
//   - unavailable accounts are listed separately and can't be selected
//   - select individually / select all, then unfollow through the existing system
//   - a rate limit pauses and continues; an outage fails cleanly and "Retry unavailable" recovers
import { boot, log, assert, sleep, OUT } from "./harness.mjs";

const DAY = 864e5;
const now = Date.now();
const ago = (d) => now - d * DAY;

let nextId = 5000;
const mk = (h, o = {}) => ({
  id: String(++nextId), h, n: h.toUpperCase(), fy: false, v: false, bv: false, p: false, d: false,
  fc: 500, fr: 300, sc: 120, ca: new Date(Date.UTC(2015, 3, 1)).toUTCString(), b: "bio of " + h, ...o
});

const U = {
  recent: mk("recent_user", { last: ago(5) }),                       // active: never in an inactive list
  yr: mk("yr_user", { last: ago(400) }),                              // 1y+
  mutual: mk("mutual_old", { fy: true, last: ago(200) }),             // follows back: only checked when scope = everyone
  d100: mk("d100_user", { last: ago(100) }),
  d45: mk("d45_user", { last: ago(45) }),
  d10: mk("d10_user", { last: ago(10) }),
  never: mk("never_posted", { sc: 0 }),                                // no posts at all
  prot: mk("prot_user", { act: "protected" }),                         // posts hidden
  susp: mk("susp_user", { act: "suspended" }),                         // account unavailable
  blueOld: mk("blue_but_old", { bv: true, v: true, last: ago(800) }), // Premium blue, long quiet
  legacy: mk("legacy_check", { bv: false, v: true, last: ago(60) }),  // verified, but not blue
  pinned: mk("pinned_trap", { last: ago(500), pin: true }),            // recent pinned post must be ignored
  flake: mk("no_date_field", { last: ago(250), noCreatedAt: true }),   // date only derivable from the post id
  replier: mk("only_replies", { last: ago(120), repliesOnly: true }),  // activity is replies only
  kept: mk("kept_friend", { last: ago(300) }),                         // whitelisted
  unknown: mk("no_flag", { bv: null, last: ago(75) })                  // X didn't say whether blue (but it is quiet: 30d+)
};
const users = Object.values(U);
const idOf = (k) => U[k].id;
const handles = (rows) => rows.map((r) => r.replace(/^@/, ""));

const H = await boot({ users, owner: { id: "1000", handle: "scanner_owner", name: "Scan Owner" } });
let failed = false;
try {
  await H.page("https://x.com/home");
  await sleep(1000);
  await H.setStore({
    "x7.settings": { speed: "custom", minDelay: 2, maxDelay: 3, restEvery: 0, restMinutes: 1, dailyLimit: 400 },
    "x7.whitelist": [U.kept.h.toLowerCase()]
  });

  const d = await H.dashboard("scanner");
  await d.waitForSelector('.page[data-page="scanner"].is-on');
  await d.waitForSelector("#scEmpty:not([hidden])");
  assert(true, "Scanner shows the empty state before a scan");
  await d.screenshot({ path: OUT + "/sc0-empty.png" });

  // ---- scan -------------------------------------------------------------
  await d.click("#scEmptyScan");
  await H.waitFor(async () => { const s = await H.scan(); return s && s.status === "done" ? s : null; }, "scan", 60000);
  const stored = await H.store("x7.scanUsers");
  const by = (k) => stored.find((u) => u.i === idOf(k));
  assert(by("yr").bv === false, "scan stores bv=false for a non-blue account");
  assert(by("blueOld").bv === true, "scan stores bv=true for a Premium account");
  assert(by("unknown").bv === null, "scan stores bv=null when X doesn't say");
  assert(by("legacy").v === true && by("legacy").bv === false, "legacy check counts as verified but not blue");

  // ---- Non-blue verified --------------------------------------------------
  await d.click('a[data-route="scanner"]');          // starting a scan sends the dashboard to Overview
  await d.waitForSelector("#scRows .row", { timeout: 10000 });
  const rows = async () => d.$$eval("#scRows .row .who-line a", (a) => a.map((x) => x.textContent.replace(/^@/, "")));
  const blue = await rows();
  const expectBlue = users.filter((u) => u.bv === false).map((u) => u.h);
  assert(blue.length === expectBlue.length && expectBlue.every((h) => blue.includes(h)), `Non-blue list has exactly the ${expectBlue.length} non-blue accounts`);
  assert(!blue.includes(U.blueOld.h) && !blue.includes(U.unknown.h), "blue and unknown accounts are not listed");
  assert((await d.textContent("#cBlue")) === String(expectBlue.length), "Non-blue count badge matches");
  assert(/1 account has no Premium-check information/.test(await d.textContent("#scUnknown")), "accounts without a flag are reported, not guessed");
  assert(await d.$eval(`#scRows .row:has(a[href$="/${U.legacy.h}"]) .tag.info`, (e) => /not blue/i.test(e.textContent)), "legacy-verified account is tagged");
  assert((await d.textContent("#scColLast")) === "Joined", "blue mode shows the Joined column");
  const keptRow = await d.$eval(`#scRows .row:has(a[href$="/${U.kept.h}"]) .rowcb`, (c) => c.disabled);
  assert(keptRow, "whitelisted account is listed but can't be selected");
  await d.screenshot({ path: OUT + "/sc1-nonblue.png" });

  // Select all selects every selectable row (and not the whitelisted one)
  await d.check("#scAll");
  const nSel = await d.$$eval("#scRows .rowcb:checked", (c) => c.length);
  assert(nSel === expectBlue.length - 1, `Select all picks ${expectBlue.length - 1} (everyone but the whitelisted account)`);
  assert((await d.textContent("#scBulkCount")).startsWith(String(expectBlue.length - 1)), "bulk bar shows the selection");
  await d.click("#scBulkClear");
  assert((await d.$$eval("#scRows .rowcb:checked", (c) => c.length)) === 0, "Clear empties the selection");

  // ---- Inactive: before any check -----------------------------------------
  await d.click('#scMode button[data-m="idle"]');
  await d.waitForSelector("#scAct:not([hidden])");
  assert((await d.textContent("#scColLast")) === "Last active", "idle mode shows the Last active column");
  assert(await d.$eval("#scNone", (e) => !e.hidden && /Run the check/i.test(e.textContent)), "nothing is listed (or guessed) before the check runs");
  assert(await d.$eval("#scActText", (e) => /Not checked yet/i.test(e.textContent)), "panel says it hasn't been checked");

  // ---- check (scope: accounts that don't follow back) -----------------------
  await d.click("#scActGo");
  const a1 = await H.waitFor(async () => { const a = await H.store("x7.act"); return a && a.status === "done" ? a : null; }, "activity check", 120000);
  const data = await H.store("x7.actData");
  const near = (rec, days) => rec && rec.s === "ok" && Math.abs(rec.t - ago(days)) < 6 * 3600e3;
  assert(near(data[idOf("yr")], 400), "reads the newest post (400 days ago)");
  assert(near(data[idOf("pinned")], 500), "a recent pinned post and another person's reply-thread post are ignored (500 days)");
  assert(near(data[idOf("flake")], 250), "date is derived from the post id when created_at is missing (250 days)");
  assert(near(data[idOf("replier")], 120), "replies count as activity (120 days)");
  assert(data[idOf("never")] && data[idOf("never")].s === "none", "an account with 0 posts is recorded as never posted");
  assert(data[idOf("prot")] && data[idOf("prot")].s === "na" && /hidden/i.test(data[idOf("prot")].w), "hidden posts -> unavailable with a reason");
  assert(data[idOf("susp")] && data[idOf("susp")].s === "na" && /unavailable/i.test(data[idOf("susp")].w), "unavailable account -> unavailable with a reason");
  assert(!data[idOf("mutual")], "accounts that follow back aren't checked when the scope is non-followers");
  assert(!data[idOf("kept")], "whitelisted accounts are never checked");
  assert(a1.ok + a1.none + a1.na === a1.total, "every queued account got a recorded result");
  const readOnly = H.mock.log.destroy.length === 0;
  assert(readOnly, "the check is read-only: nothing was unfollowed");

  // ---- filters, counts, sorting ---------------------------------------------
  await sleep(1200);
  const ageOrder = async () => handles(await rows());
  // days: blue_but_old 800, pinned_trap 500, yr_user 400, no_date_field 250, only_replies 120, d100_user 100, no_flag 75, legacy_check 60, d45_user 45
  const want30 = ["blue_but_old", "pinned_trap", "yr_user", "no_date_field", "only_replies", "d100_user", "no_flag", "legacy_check", "d45_user"];
  await d.waitForSelector("#scRows .row");
  assert((await ageOrder()).join() === want30.join(), "30d+ lists the 9 quiet accounts, most inactive first");
  assert((await d.textContent("#cA30")) === "9" && (await d.textContent("#cIdle")) === "9", "30d+ count is 9");
  assert((await d.textContent("#cA90")) === "6" && (await d.textContent("#cA180")) === "4" && (await d.textContent("#cA365")) === "3", "90d+/180d+/1y+ counts are 6/4/3");
  assert((await d.textContent("#cANa")) === "3", "Unavailable count is 3 (never posted, hidden, unavailable)");
  assert(!(await ageOrder()).includes("recent_user") && !(await ageOrder()).includes("d10_user"), "recently active accounts are not listed");

  const lastText = async (h) => d.$eval(`#scRows .row:has(a[href$="/${h}"]) .last-cell`, (e) => e.textContent.replace(/\s+/g, " ").trim());
  assert(/^400 days ago/.test(await lastText("yr_user")), 'shows "400 days ago" for yr_user');
  assert(/^800 days ago/.test(await lastText("blue_but_old")), 'shows "800 days ago" for blue_but_old');
  const title = await d.$eval(`#scRows .row:has(a[href$="/yr_user"]) .last-cell`, (e) => e.title);
  assert(/^Last active: 400 days ago/.test(title), 'tooltip reads "Last active: 400 days ago (date)"');
  await d.screenshot({ path: OUT + "/sc2-inactive.png" });

  await d.selectOption("#scSort", "asc");
  await sleep(400);
  assert((await ageOrder()).join() === [...want30].reverse().join(), "Least inactive first reverses the order");
  await d.selectOption("#scSort", "desc");
  await sleep(400);
  assert((await ageOrder()).join() === want30.join(), "Most inactive first restores it");

  const filt = async (a) => { await d.click(`#scAge button[data-a="${a}"]`); await sleep(350); return ageOrder(); };
  assert((await filt("90")).join() === want30.slice(0, 6).join(), "90d+ keeps the 6 accounts quiet for 90+ days");
  assert((await filt("180")).join() === want30.slice(0, 4).join(), "180d+ keeps 4");
  assert((await filt("365")).join() === want30.slice(0, 3).join(), "1y+ keeps 3");
  await d.selectOption("#scSort", "asc");
  await sleep(300);
  assert((await ageOrder()).join() === want30.slice(0, 3).reverse().join(), "sort direction applies inside a filter");
  await d.selectOption("#scSort", "desc");

  // ---- unavailable list ------------------------------------------------------
  const na = await filt("na");
  assert(na.length === 3 && ["never_posted", "prot_user", "susp_user"].every((h) => na.includes(h)), "Unavailable lists the 3 accounts separately");
  assert(/Never posted/.test(await lastText("never_posted")) && /hidden/i.test(await lastText("prot_user")) && /unavailable/i.test(await lastText("susp_user")), "each unavailable account shows why");
  assert((await d.$$eval("#scRows .rowcb:not([disabled])", (c) => c.length)) === 0, "unavailable accounts can't be selected");
  assert(await d.$eval("#scAll", (c) => c.disabled), "Select all is disabled for unavailable accounts");
  assert(await d.$eval("#scSort", (s) => s.disabled), "sorting is disabled for unavailable accounts");
  await d.screenshot({ path: OUT + "/sc3-unavailable.png" });

  // ---- "Check remaining" with everyone in scope picks up the mutual ---------
  await d.selectOption("#scScope", "all");
  await d.click("#scActGo");
  await H.waitFor(async () => { const a = await H.store("x7.act"); return a && a.status === "done" && a.index === 1 ? a : null; }, "second check", 60000);
  const d2 = await H.store("x7.actData");
  assert(near(d2[idOf("mutual")], 200), "scope = everyone reads the mutual too (200 days), and skips what's already fresh");
  assert(near(d2[idOf("yr")], 400), "results already read are kept, not re-read");
  assert(H.mock.log.act.filter((x) => x.userId === idOf("yr")).length === 1, "an account is read once");

  // ---- Retry unavailable only re-reads the unavailable accounts ---------------
  const before = H.mock.log.act.length;
  await d.click("#scActRetry");
  await H.waitFor(async () => { const a = await H.store("x7.act"); return a && a.status === "done" && a.retry ? a : null; }, "retry", 60000);
  const reread = H.mock.log.act.slice(before).map((x) => x.userId).sort();
  assert(reread.join() === [idOf("prot"), idOf("susp")].sort().join(), "Retry reads only the 2 accounts X couldn't read (never-posted is definitive)");
  assert((await d.textContent("#scActRetry")).includes("(2)"), "the Retry button counts only retryable accounts");

  // ---- select all + unfollow through the existing system ------------------------
  await d.click('#scAge button[data-a="90"]');
  await sleep(400);
  const list90 = await ageOrder();
  assert(list90.length === 7, "90d+ now has 7 (the mutual joined)");
  await d.check("#scAll");
  assert((await d.$$eval("#scRows .rowcb:checked", (c) => c.length)) === 7, "Select all picks all 7 in the filtered list");
  await d.screenshot({ path: OUT + "/sc4-selected.png" });
  await d.click("#scBulkRun");
  await d.waitForSelector("#confirm:not([hidden])");
  assert(/Unfollow 7 accounts/.test(await d.textContent("#cfTitle")), "the usual confirmation shows 7 accounts");
  await d.click("#cfOk");
  await d.waitForSelector('.page[data-page="overview"].is-on');
  const job = await H.waitFor(async () => { const j = await H.job(); return j && j.status === "done" ? j : null; }, "unfollow run", 90000);
  assert(job.source === "ids" && job.done === 7, "the existing unfollow system ran 7 selected accounts");
  const gone = H.mock.log.destroy.map((x) => x.h).sort();
  assert(gone.join() === [...list90].sort().join(), "exactly the selected accounts were unfollowed");
  assert(!gone.includes(U.kept.h) && !gone.includes(U.unknown.h), "whitelisted and unlisted accounts were left alone");

  // ---- unfollowed accounts leave the lists -------------------------------------
  await d.click('a[data-route="scanner"]');
  await d.waitForSelector('.page[data-page="scanner"].is-on');
  await sleep(600);
  await d.click('#scAge button[data-a="30"]');
  await sleep(400);
  assert((await ageOrder()).join() === "no_flag,legacy_check,d45_user", "after the run only the 30d+ accounts that weren't selected remain, still sorted");

  // ---- scans from before the Scanner (no bv) --------------------------------------
  const keep = await H.store("x7.scanUsers");
  await H.setStore({ "x7.scanUsers": keep.map((u) => { const c = { ...u }; delete c.bv; return c; }) });
  await sleep(800);
  await d.click('#scMode button[data-m="blue"]');
  await sleep(500);
  assert(await d.$eval("#scUnknown", (e) => !e.hidden && /rescan/i.test(e.textContent)), "an older scan prompts a rescan instead of guessing");
  assert((await d.$$eval("#scRows .row", (r) => r.length)) === 0, "no account is called non-blue without the flag");
  await H.setStore({ "x7.scanUsers": keep });
  await sleep(800);

  // ---- layout -----------------------------------------------------------------------
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") { await d.click(".side [data-theme-toggle]"); await sleep(500); }
    await d.click('#scMode button[data-m="idle"]');
    await d.click('#scAge button[data-a="30"]');
    await sleep(400);
    for (const w of [1440, 1100, 760, 420]) {
      await d.setViewportSize({ width: w, height: 900 });
      await sleep(250);
      const over = await d.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(over <= 1, `Scanner fits ${w}px wide in ${theme} mode`);
    }
    await d.setViewportSize({ width: 1360, height: 900 });
    await d.screenshot({ path: OUT + `/sc5-inactive-${theme}.png` });
  }

  log("t7 scanner (main): all checks passed");
} catch (e) {
  failed = true;
  console.error("t7 FAILED:", e && e.stack || e);
} finally {
  await H.close();
}

// ===========================================================================
// Resilience: a rate limit mid-check, then an outage and a retry
// ===========================================================================
if (!failed) {
  const R = Array.from({ length: 8 }, (_, i) => mk("slow_" + i, { last: ago(60 + i * 10) }));
  const H2 = await boot({ users: R, owner: { id: "1000", handle: "scanner_owner", name: "Scan Owner" } });
  try {
    await H2.page("https://x.com/home");
    await sleep(1000);
    const d = await H2.dashboard("scanner");
    await d.waitForSelector("#scEmpty:not([hidden])");
    await d.click("#scEmptyScan");
    await H2.waitFor(async () => { const s = await H2.scan(); return s && s.status === "done" ? s : null; }, "scan", 60000);
    await d.click('a[data-route="scanner"]');
    await d.click('#scMode button[data-m="idle"]');
    await d.waitForSelector("#scAct:not([hidden])");

    // rate limit on the 3rd read: it pauses with a message, then carries on
    H2.mock.cfg.actRateAt = 3;
    await d.click("#scActGo");
    await H2.waitFor(async () => { const a = await H2.store("x7.act"); return a && /short break/i.test(a.message || "") ? a : null; }, "rate pause", 60000);
    assert(true, "a rate limit pauses the check with a message");
    const mid = await H2.store("x7.actData");
    assert(Object.keys(mid || {}).length === 2, "the 2 accounts read before the limit are kept");
    await H2.fastForward();
    const done = await H2.waitFor(async () => { const a = await H2.store("x7.act"); return a && a.status === "done" ? a : null; }, "finish after rate limit", 120000);
    assert(done.ok === 8, "after the pause it finishes all 8");
    assert(Object.keys(await H2.store("x7.actData")).length === 8, "all 8 are recorded");

    // outage: X stops answering the posts query -> clean failure, honest "unavailable", retry recovers
    await H2.setStore({ "x7.actData": {} });
    H2.mock.cfg.actDown = true;
    await d.reload();
    await d.waitForSelector('.page[data-page="scanner"].is-on');
    await d.click('#scMode button[data-m="idle"]');
    await d.waitForSelector("#scAct:not([hidden])");
    await d.click("#scActGo");
    const bad = await H2.waitFor(async () => { const a = await H2.store("x7.act"); return a && a.status === "error" ? a : null; }, "outage stops the check", 240000);
    assert(/isn't returning profile posts/i.test(bad.message), "an outage ends the check with a clear message");
    const partial = await H2.store("x7.actData");
    assert(Object.values(partial).every((r) => r.s === "na"), "accounts hit by the outage are 'unavailable', never given a date");
    assert(Object.keys(partial).length >= 1 && Object.keys(partial).length < 8, "the rest were left unchecked rather than marked");
    await sleep(800);
    assert(await d.$eval("#scActRetry", (b) => !b.hidden), "Retry unavailable is offered");

    H2.mock.cfg.actDown = false;
    await d.click("#scActRetry");
    await H2.waitFor(async () => { const a = await H2.store("x7.act"); return a && a.status === "done" && a.retry ? a : null; }, "retry after outage", 120000);
    const rec = await H2.store("x7.actData");
    assert(Object.values(rec).every((r) => r.s === "ok"), "retry replaces unavailable results with real dates");
    log("t7 scanner (resilience): all checks passed");
  } catch (e) {
    failed = true;
    console.error("t7 resilience FAILED:", e && e.stack || e);
  } finally {
    await H2.close();
  }
}
process.exit(failed ? 1 : 0);
