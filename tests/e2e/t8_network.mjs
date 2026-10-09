// Optional network sharing (Mellowtel):
//   - the SDK loads in the worker but does nothing until a user opts in
//   - install-time permissions are unchanged (website access is optional only)
//   - the support prompt shows once, after the welcome screen, with equal choices
//   - "No thanks" / "Maybe later" are remembered; "later" asks again after a week, at most twice
//   - without Chrome's permission, nothing is turned on
//   - the Settings toggle reflects the state
import { boot, log, assert, sleep, OUT, EXT } from "./harness.mjs";
import fs from "fs";
import path from "path";

const H = await boot({ netPrompt: true });
let failed = false;
try {
  const man = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  assert(JSON.stringify(man.permissions) === JSON.stringify(["storage", "unlimitedStorage", "alarms", "scripting"]), "install-time permissions are unchanged");
  assert(JSON.stringify(man.host_permissions) === JSON.stringify(["https://x.com/*", "https://twitter.com/*", "https://abs.twimg.com/*"]), "install-time host access is unchanged (x.com only)");
  assert(man.optional_host_permissions.includes("<all_urls>") && man.optional_permissions.includes("declarativeNetRequestWithHostAccess"), "website access is optional, asked only on opt-in");
  assert(man.content_scripts.every((c) => !c.matches.includes("<all_urls>")), "no content script runs on every site by default");

  const sdk = await H.sw.evaluate(() => typeof Mellowtel === "function" && self.X7_MELLOWTEL_KEY);
  assert(sdk === "intgr-6V01Yr3uRt", "the Mellowtel SDK loads in the worker with the integration ID");
  const regs = await H.sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  assert(regs.length === 0, "no Mellowtel content script is registered before opt-in");
  const st0 = await H.sw.evaluate(() => X7Net.status());
  assert(st0.available && !st0.optedIn && !st0.granted && st0.shouldPrompt, "fresh install: available, off, not granted, prompt due");

  // First open: welcome first, then the prompt
  const d = await H.dashboard("welcome");
  await d.waitForSelector("#welcome:not([hidden])");
  await sleep(900);
  assert(await d.$eval("#netAsk", (e) => e.hidden), "the prompt never covers the welcome screen");
  await d.click("#welcomeLater");
  await d.waitForSelector("#netAsk:not([hidden])", { timeout: 5000 });
  assert(true, "the support prompt appears after the welcome screen");
  const txt = (await d.textContent("#netAsk")).replace(/\s+/g, " ");
  assert(/100% free/.test(txt) && /without paying/.test(txt), "it says the extension is free and support costs nothing");
  assert(/never reads your X account/.test(txt) && /public web pages/.test(txt) && /from your connection/.test(txt), "it explains plainly what sharing does and doesn't do");
  assert((await d.$$("#netAsk #netYes, #netAsk #netLater, #netAsk #netNo")).length === 3, "Yes / Maybe later / No thanks are all offered");
  await sleep(700);
  await d.screenshot({ path: OUT + "/n1-prompt-light.png" });

  // Without Chrome's permission nothing turns on
  const r = await H.sw.evaluate(() => X7Net.optIn());
  assert(r.ok === false, "the worker refuses to opt in without Chrome's permission");
  assert((await H.sw.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length === 0, "still no content script registered");

  // Maybe later -> remembered, re-asked only after a week
  await d.click("#netLater");
  await sleep(500);
  let net = await H.store("x7.net");
  assert(net.state === "later" && net.asked === 1, "Maybe later is remembered");
  assert(!(await H.sw.evaluate(() => X7Net.status())).shouldPrompt, "not asked again right away");
  await H.setStore({ "x7.net": { ...net, askedAt: Date.now() - 8 * 864e5 } });
  assert((await H.sw.evaluate(() => X7Net.status())).shouldPrompt, "asked once more after a week");
  await H.setStore({ "x7.net": { state: "later", asked: 2, askedAt: Date.now() - 30 * 864e5 } });
  assert(!(await H.sw.evaluate(() => X7Net.status())).shouldPrompt, "never asked more than twice");

  // No thanks -> never again
  await H.setStore({ "x7.net": { state: "new", asked: 0 } });
  const d2 = await H.dashboard("overview");
  await d2.evaluate(() => window.X7Theme && X7Theme.set("dark"));
  await d2.waitForSelector("#netAsk:not([hidden])", { timeout: 5000 });
  await sleep(700);
  await d2.screenshot({ path: OUT + "/n2-prompt-dark.png" });
  await d2.click("#netNo");
  await sleep(500);
  assert((await H.store("x7.net")).state === "no", "No thanks is remembered");
  const d3 = await H.dashboard("settings");
  await d3.waitForSelector('.page[data-page="settings"].is-on');
  await sleep(1200);
  assert(await d3.$eval("#netAsk", (e) => e.hidden), "after No thanks the prompt doesn't come back");
  assert(!(await d3.$eval("#netPanel", (e) => e.hidden)) && !(await d3.isChecked("#netToggle")), "Settings shows network sharing, off");
  await d3.locator("#netPanel").screenshot({ path: OUT + "/n3-settings.png" });

  // Layout: prompt fits a small window
  await H.setStore({ "x7.net": { state: "new", asked: 0 } });
  const d4 = await H.dashboard("overview");
  await d4.setViewportSize({ width: 420, height: 700 });
  await d4.waitForSelector("#netAsk:not([hidden])", { timeout: 5000 });
  const fits = await d4.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  assert(fits, "the prompt fits a 420px window");
  log("t8 network: all checks passed");
} catch (e) {
  failed = true;
  console.error("t8 FAILED:", e && e.stack || e);
} finally {
  await H.close();
}
process.exit(failed ? 1 : 0);
