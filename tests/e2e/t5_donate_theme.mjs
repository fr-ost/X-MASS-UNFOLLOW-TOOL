// Donate page: real addresses, copy buttons, QR codes that decode to the exact
// address as rendered on the page (light and dark), theme toggle + persistence.
import { boot, log, assert, sleep, OUT } from "./harness.mjs";
import { execFileSync } from "child_process";
import path from "path";

const WALLETS = {
  evm: "0x257F291514AaAa1533832cC2C8981Cc14063ED17",
  sol: "GwwZWYxzms9ebEWQNCAJrPSQdsN6SVPGbpMwCYomWqWa",
  btc: "bc1qg6clyevlmfekg3rkyhlk5ggeh3g6dnt5sdje4j"
};
const DIR = path.dirname(new URL(import.meta.url).pathname);

const H = await boot();
let failed = false;
try {
  const d = await H.dashboard("donate");
  await d.waitForSelector('.page[data-page="donate"].is-on');
  await sleep(900);
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") { await d.click(".side [data-theme-toggle]"); await sleep(600); }
    assert((await d.evaluate(() => document.documentElement.dataset.theme)) === theme, `donate page in ${theme} mode`);
    await d.screenshot({ path: `${OUT}/donate-${theme}.png`, fullPage: true });
    const files = [];
    for (const k of Object.keys(WALLETS)) {
      const card = d.locator(`.wallet[data-wallet="${k}"]`);
      assert((await card.locator(".addr").textContent()).trim() === WALLETS[k], `${k} address text is exact (${theme})`);
      const f = `${OUT}/qr-${theme}-${k}.png`;
      await card.locator(".w-qr").screenshot({ path: f });
      files.push([k, f]);
    }
    const decoded = JSON.parse(execFileSync("python3", [path.join(DIR, "decode_qr.py"), ...files.map((x) => x[1])]).toString());
    for (const [k, f] of files) assert(decoded[f] === WALLETS[k], `${k} QR on the page decodes to the address (${theme})`);
  }

  // Copy button
  await d.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
  await d.click('.wallet[data-wallet="btc"] .w-copy');
  await sleep(300);
  const clip = await d.evaluate(() => window.__copied);
  assert(clip === WALLETS.btc, "Copy puts the exact BTC address on the clipboard");
  assert(/Copied/.test(await d.textContent('.wallet[data-wallet="btc"] .w-copy')), "button confirms the copy");

  // In-page jump keeps the router on the donate page
  await d.click("#donateJump");
  await sleep(800);
  assert((await d.evaluate(() => document.querySelector('.page[data-page="donate"]').classList.contains("is-on"))), "Donate now scrolls without leaving the page");

  // Rate link points at the store reviews
  const STORE = "https://chromewebstore.google.com/detail/x-twitter-mass-unfollow-t/igpjmagghnibmjkkdcgpjgpkfkpiglnl";
  assert((await d.getAttribute("#rateLink", "href")) === STORE + "/reviews", "rate link goes to the store reviews");
  await d.click("#shareBtn");
  await sleep(300);
  assert((await d.evaluate(() => window.__copied)) === STORE, "share copies the store link");

  // Footer credits + bug report
  const foot = await d.textContent(".page-foot");
  assert(/A product of Unique Labs\. Developed by Shahriar Ahmed\./.test(foot.replace(/\s+/g, " ")), "footer credits text");
  assert(await d.$('.page-foot a[href="https://www.shahriarahmed.net"]'), "footer links the website");
  assert((await d.textContent('.page-foot a.dev-link[href="https://www.shahriarahmed.net"]')) === "Shahriar Ahmed", "developer name links the website");
  assert(await d.$('.side-foot a[href="https://t.me/igfrostt"]'), "sidebar has Report a bug");

  // Theme persists to other pages (popup) and the appearance setting reflects it
  const pop = await H.popup();
  await sleep(500);
  assert((await pop.evaluate(() => document.documentElement.dataset.theme)) === "dark", "popup opens in dark mode after toggling");
  assert(/Report a bug/.test(await pop.textContent(".popup-credits")) && /Unique Labs/.test(await pop.textContent(".popup-credits")), "popup credits + bug link");
  await pop.click("[data-theme-toggle]");
  await sleep(500);
  assert((await d.evaluate(() => document.documentElement.dataset.theme)) === "light", "toggling in the popup updates the open dashboard");
  await d.click('a[data-route="settings"]');
  await d.click('#themeSeg button[data-pref="system"]');
  assert((await d.evaluate(() => localStorage.getItem("x7.theme"))) === "system", "appearance setting stores System");

  // Responsive: no horizontal overflow on the donate page at small widths
  await d.goto(`chrome-extension://${H.extId}/dashboard.html#donate`);
  for (const w of [1440, 1100, 760, 420]) {
    await d.setViewportSize({ width: w, height: 900 });
    await sleep(400);
    const over = await d.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(over <= 1, `donate page fits ${w}px wide`);
  }
  await d.setViewportSize({ width: 760, height: 1000 });
  await d.screenshot({ path: `${OUT}/donate-narrow.png`, fullPage: true });
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await H.close();
  process.exit(failed ? 1 : 0);
}
