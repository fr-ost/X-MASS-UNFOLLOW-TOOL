import { boot, log, assert, sleep, OUT } from "./harness.mjs";

const H = await boot();
let failed = false;
const now = Date.now();
const acc = { id: "1000", handle: "tester", name: "Test Person", avatar: "https://pbs.twimg.com/profile_images/1000/me_normal.jpg", followers: 321, following: 1834, at: now };
const users = Array.from({ length: 40 }, (_, i) => ({ i: String(2000 + i), h: "acct_" + i, n: "Account " + i, a: "https://pbs.twimg.com/profile_images/" + (2000 + i) + "/a_normal.jpg", fy: i % 3 !== 0, fw: true, v: false, p: false, fc: 100, fr: 100, sc: 10, ca: null, d: false, b: "" }));
const scanDone = { status: "done", method: "api", ownerId: "1000", handle: "tester", total: 1834, nonFollowers: 412, mutuals: 1422, unknown: 0, startedAt: now - 60000, finishedAt: now - 30000 };
const baseJob = { id: "j1", source: "nonfollowers", ownerId: "1000", total: 412, index: 133, done: 127, skipped: 4, failed: 2, startedAt: now - 3600000, nextAt: now + 14000, sinceRest: 7, executor: "api", consecutiveFails: 0, targetFails: 0, rateHits: 0, current: { i: "2005", h: "elonfan_2041", n: "Crypto Daily Signals", a: "https://pbs.twimg.com/profile_images/2005/a_normal.jpg" }, inFlight: null, log: [] };

const states = {
  start: { "x7.scan": null, "x7.job": null },
  scanning: { "x7.scan": { status: "running", method: "api", phase: "following", ownerId: "1000", fetched: 1240, expected: 1834, message: "Read 1,240 of ~1,834 accounts", startedAt: now }, "x7.job": null },
  ready: { "x7.scan": scanDone, "x7.scanUsers": users, "x7.job": null },
  running: { "x7.scan": scanDone, "x7.job": { ...baseJob, status: "running", message: "Unfollowed @lowkey_bot" } },
  resting: { "x7.scan": scanDone, "x7.job": { ...baseJob, status: "resting", restReason: "rate", restUntil: now + 17 * 60000, message: "X asked to slow down. Resting until 3:42 PM, then continuing automatically." } },
  halted: { "x7.scan": scanDone, "x7.job": { ...baseJob, status: "halted", haltKind: "locked", message: "X is asking you to verify your account. Open x.com, complete X's check, wait a while, then press Resume." } },
  done: { "x7.scan": scanDone, "x7.job": { ...baseJob, status: "done", index: 412, done: 401, skipped: 9, failed: 2, finishedAt: now, message: "Finished. Unfollowed 401 accounts." } },
  signin: { "x7.scan": null, "x7.job": null, "x7.account": { id: null, signedOut: true, at: now } }
};

try {
  await H.setStore({ "x7.account": acc, "x7.ledger": Array.from({ length: 127 }, (_, i) => now - i * 60000) });
  for (const [name, st] of Object.entries(states)) {
    const patch = {};
    const remove = [];
    for (const [k, v] of Object.entries(st)) { if (v === null) remove.push(k); else patch[k] = v; }
    if (remove.length) await (await H.page(`chrome-extension://${H.extId}/privacy.html`)).evaluate((r) => chrome.storage.local.remove(r), remove);
    if (Object.keys(patch).length) await H.setStore(patch);
    if (name !== "signin") await H.setStore({ "x7.account": acc });
    const p = await H.popup();
    await p.waitForSelector(`[data-view="${name === "start" ? "start" : name === "scanning" ? "scanning" : name === "ready" ? "ready" : name === "signin" ? "signin" : name === "done" ? "done" : "run"}"].is-on`, { timeout: 10000 });
    await sleep(900);
    const ov = await p.evaluate(() => {
      const st = document.querySelector("#stage");
      return { overflow: st.scrollHeight - st.clientHeight, bodyH: document.body.scrollHeight };
    });
    log(name, JSON.stringify(ov));
    await p.screenshot({ path: `${OUT}/s-${name}.png` });
    assert(ov.overflow <= 2, `${name}: content fits without scrolling`);
    await p.close();
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await H.close();
  process.exit(failed ? 1 : 0);
}
