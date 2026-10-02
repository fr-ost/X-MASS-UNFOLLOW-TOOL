import { createRequire } from "module";
import { execSync } from "child_process";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
import fs from "fs";
import os from "os";
import path from "path";
import { createMock } from "./mock.mjs";

export const EXT = process.env.EXT || path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
export const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), "out");
fs.mkdirSync(OUT, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function log(...a) { console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a); }
export function assert(cond, msg) { if (!cond) throw new Error("ASSERT: " + msg); log("  ok -", msg); }

function ensureCert() {
  const dir = path.dirname(new URL(import.meta.url).pathname);
  if (fs.existsSync(path.join(dir, "cert.pem"))) return;
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 -subj "/CN=x.com" -addext "subjectAltName=DNS:x.com,DNS:twitter.com,DNS:abs.twimg.com,DNS:edge.adsonbread.com,DNS:pbs.twimg.com"`, { cwd: dir, stdio: "ignore" });
}

export async function boot(mockOpts, ctxOpts) {
  ensureCert();
  const mock = createMock(mockOpts);
  await mock.start(443);
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "x7-"));
  const ctx = await chromium.launchPersistentContext(udd, {
    channel: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 860 },
    ...(ctxOpts || {}),
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--host-resolver-rules=MAP x.com 127.0.0.1, MAP twitter.com 127.0.0.1, MAP abs.twimg.com 127.0.0.1, MAP pbs.twimg.com 127.0.0.1, MAP edge.adsonbread.com 127.0.0.1",
      "--ignore-certificate-errors",
      "--no-proxy-server"
    ]
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const swLogs = [];
  sw.on("console", (m) => swLogs.push(m.type() + ": " + m.text()));
  await ctx.addCookies([
    { name: "ct0", value: "csrf123", domain: "x.com", path: "/", secure: true, sameSite: "Lax" },
    { name: "twid", value: "u%3D1000", domain: "x.com", path: "/", secure: true, sameSite: "None" },
    { name: "auth_token", value: "tok", domain: "x.com", path: "/", secure: true, httpOnly: true, sameSite: "None" }
  ]);
  const H = { mock, ctx, sw, extId, swLogs, udd };

  // Storage goes through an extension page, so it works across worker restarts.
  H.extPage = null;
  const ep = async () => {
    if (!H.extPage || H.extPage.isClosed()) {
      H.extPage = await ctx.newPage();
      await H.extPage.goto(`chrome-extension://${extId}/privacy.html`);
    }
    return H.extPage;
  };
  H.store = async (key) => (await ep()).evaluate((k) => chrome.storage.local.get(k).then((r) => r[k]), key);
  H.setStore = async (obj) => (await ep()).evaluate((o) => chrome.storage.local.set(o), obj);
  H.stopWorker = async () => {
    const p = await ctx.newPage();
    await p.goto("chrome://serviceworker-internals/");
    await p.waitForTimeout(800);
    await p.locator("button", { hasText: "Stop" }).first().click();
    await p.waitForTimeout(800);
    await p.close();
  };
  H.job = () => H.store("x7.job");
  H.scan = () => H.store("x7.scan");
  H.waitFor = async (fn, what, timeoutMs = 60000, every = 500) => {
    const until = Date.now() + timeoutMs;
    let last;
    while (Date.now() < until) {
      last = await fn();
      if (last) return last;
      await sleep(every);
    }
    throw new Error("timeout waiting for " + what);
  };
  // Skip a scheduled wait (rest or pacing) without waiting in real time.
  H.fastForward = () => sw.evaluate(async () => {
    const j = await load(K.job, null);
    if (j) { if (j.restUntil) j.restUntil = Date.now(); j.nextAt = Date.now(); await save({ [K.job]: j }); }
    const s = await load(K.scan, null);
    if (s && s.waitUntil) { s.waitUntil = Date.now(); await save({ [K.scan]: s }); }
    scheduleTick(0);
  });
  H.page = async (url, viewport) => {
    const p = await ctx.newPage();
    if (viewport) await p.setViewportSize(viewport);
    p.on("pageerror", (e) => log("PAGE ERROR", url, e.message));
    p.on("console", (m) => { if (m.type() === "error") log("console.error", url.slice(0, 60), m.text().slice(0, 200)); });
    await p.goto(url);
    return p;
  };
  H.popup = () => H.page(`chrome-extension://${extId}/popup.html`, { width: 380, height: 600 });
  H.dashboard = (hash) => H.page(`chrome-extension://${extId}/dashboard.html${hash ? "#" + hash : ""}`, { width: 1360, height: 900 });
  H.close = async () => { await ctx.close(); await mock.stop(); };
  return H;
}
