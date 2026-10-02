// Renders the icon pack to PNG with Chromium. Run from the repo root:
//   PLAYWRIGHT=/path/to/playwright node design/build-icons.mjs
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { iconSvg } from "./icon.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const targets = [
  { file: "icon16.png", size: 16, pad: 0, simple: true },
  { file: "icon32.png", size: 32, pad: 1, simple: false },
  { file: "icon48.png", size: 48, pad: 2, simple: false },
  { file: "icon128.png", size: 128, pad: 16, simple: false },   // store spec: 96px art + 16px padding
  { file: "ui/logo.svg", size: 128, pad: 0, simple: false, svgOnly: true }
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const t of targets) {
  const svg = iconSvg(t);
  if (t.svgOnly) { fs.writeFileSync(path.join(ROOT, t.file), svg); continue; }
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.screenshot({ path: path.join(ROOT, t.file), omitBackground: true, clip: { x: 0, y: 0, width: t.size, height: t.size } });
  console.log("wrote", t.file);
}
fs.writeFileSync(path.join(ROOT, "design/icon-source.svg"), iconSvg({ size: 512, pad: 0 }));
await browser.close();
