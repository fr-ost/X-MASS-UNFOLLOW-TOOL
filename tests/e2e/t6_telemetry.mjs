// Anonymous telemetry: an install event and a once-a-day active ping reach the
// tracker with ONLY anonymous fields; the opt-out and the "no endpoint" case
// send nothing; and the payload never contains anything that identifies a user.
import { boot, log, assert, sleep } from "./harness.mjs";

const EP = "https://trk.x7.workers.dev";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_EVENT_KEYS = new Set(["t", "ts", "n"]);

const H = await boot();
let failed = false;
try {
  const VER = await H.sw.evaluate(() => chrome.runtime.getManifest().version);
  const now = Date.now();

  // Configure the endpoint (via the storage override), seed a 3-unfollow ledger,
  // and make the install event eligible to fire again.
  await H.setStore({ "x7.trackerUrl": EP, "x7.ledger": [now - 1000, now - 2000, now - 3000], "x7.tinst": false, "x7.tday": null });

  const activeEvents = () => H.mock.log.trkEvents.filter((e) => e.t === "active");

  // --- install -------------------------------------------------------------
  await H.sw.evaluate(() => X7Telemetry.onInstall());
  const ins = await H.waitFor(() => H.mock.log.trkEvents.find((e) => e.t === "install") || null, "install event");
  assert(UUID.test(ins.i), "install carries a random anonymous id");
  assert(ins.v === VER, "install carries the extension version");

  // --- active ping with the aggregate unfollow count -----------------------
  await H.sw.evaluate(() => pingActive());
  const act = await H.waitFor(() => activeEvents()[0] || null, "active event");
  assert(act.i === ins.i, "active uses the same anonymous id");
  assert(act.n === 3, "active ping reports the 24h unfollow count from the ledger");

  // --- once per day --------------------------------------------------------
  const n1 = activeEvents().length;
  await H.sw.evaluate(() => pingActive());
  await sleep(700);
  assert(activeEvents().length === n1, "active ping fires at most once per day");

  // --- privacy contract: nothing identifying is ever sent ------------------
  const blob = JSON.stringify(H.mock.log.trk).toLowerCase();
  for (const bad of ["ip", "handle", "username", "twid", "auth", "password", "following", "tester", "@"]) {
    assert(!blob.includes(bad), `payload never contains "${bad}"`);
  }
  for (const j of H.mock.log.trk) {
    assert(Object.keys(j).sort().join(",") === "e,i,v", "each payload has only i, v, e");
    for (const e of (j.e || [])) {
      for (const k of Object.keys(e)) assert(ALLOWED_EVENT_KEYS.has(k), `event key "${k}" is one of t/ts/n`);
    }
  }

  // --- opt-out stops everything -------------------------------------------
  await H.setStore({ "x7.settings": { telemetry: false }, "x7.tday": null });
  const n2 = H.mock.log.trkEvents.length;
  await H.sw.evaluate(() => pingActive());
  await sleep(700);
  assert(H.mock.log.trkEvents.length === n2, "opt-out stops the active ping");

  // --- no endpoint configured = silent no-op -------------------------------
  await H.setStore({ "x7.settings": { telemetry: true }, "x7.trackerUrl": "", "x7.tday": null });
  const n3 = H.mock.log.trkEvents.length;
  await H.sw.evaluate(() => pingActive());
  await sleep(600);
  assert(H.mock.log.trkEvents.length === n3, "no endpoint means nothing is sent");

  log("t6 telemetry: all checks passed");
} catch (e) {
  failed = true;
  console.error("t6 FAILED:", e && e.stack || e);
} finally {
  await H.close();
}
process.exit(failed ? 1 : 0);
