// Bulk-selection bar: stays on screen while scrolling a long list, fits from desktop to phone width, never covers the last row.
import { boot, log, assert, sleep, OUT } from "./harness.mjs";
const H = await boot();
let failed = false;
try {
  await H.page("https://x.com/home");
  await sleep(1000);
  const d = await H.dashboard("following");
  await d.waitForSelector("#flEmpty:not([hidden])");
  await d.click("#flEmptyScan");
  await H.waitFor(async () => { const s = await H.scan(); return s && s.status === "done" ? s : null; }, "scan", 60000);
  await d.click('a[data-route="following"]');
  await d.waitForSelector("#flRows .row");
  await d.click(".side [data-theme-toggle]"); await sleep(400);
  await d.click('#flSeg button[data-f="all"]'); await sleep(300);
  await d.check("#flAll"); await sleep(500);
  for (const [w, h] of [[1440, 900], [760, 900], [400, 800], [340, 700]]) {
    await d.setViewportSize({ width: w, height: h }); await sleep(400);
    await d.evaluate(() => scrollTo({ top: document.body.scrollHeight / 3, behavior: "instant" })); await sleep(900);
    const r = await d.evaluate(() => {
      const b = document.querySelector("#bulk"), r = b.getBoundingClientRect();
      const kids = [...b.children].map((c) => c.getBoundingClientRect()).filter((x) => x.width);
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height, iw: innerWidth, ih: innerHeight,
        overflow: b.scrollWidth > b.clientWidth + 1, kidsOut: kids.some((k) => k.right > r.right + 1 || k.left < r.left - 1),
        pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    log(w, JSON.stringify(r));
    assert(r.top >= 0 && r.bottom <= r.ih && r.left >= 0 && r.right <= r.iw, `bar in view at ${w}px`);
    assert(!r.overflow && !r.kidsOut && !r.pageOverflow, `no overflow at ${w}px`);
    await d.screenshot({ path: `${OUT}/bulk-${w}.png` });
  }
  // last row reachable above the bar
  await d.setViewportSize({ width: 1440, height: 900 });
  for (let i = 0; i < 12; i++) { await d.evaluate(() => scrollTo(0, document.body.scrollHeight)); await sleep(250); }
  const cover = await d.evaluate(() => {
    const rows = document.querySelectorAll("#flRows .row"), last = rows[rows.length - 1].getBoundingClientRect();
    return last.bottom <= document.querySelector("#bulk").getBoundingClientRect().top + 1;
  });
  await d.screenshot({ path: `${OUT}/bulk-end.png` });
  assert(cover, "last row isn't covered by the bar at the end of the list");
} catch (e) { failed = true; console.error(e); } finally { await H.close(); process.exit(failed ? 1 : 0); }
