// X Mass Unfollow - shared/network.js (background worker)
//
// Optional "network sharing", powered by Mellowtel. It is OFF unless the user
// presses Enable in the support prompt or in Settings, and the Mellowtel SDK is
// not even initialised until then.
//
// How consent and permissions work here:
//   - The manifest declares website access only as OPTIONAL
//     (optional_host_permissions + optional_permissions), so installing or
//     updating the extension shows no new permission warning and never
//     disables the extension for existing users.
//   - The extension page asks Chrome for that access from the Enable click
//     (a user gesture is required); Chrome shows its own dialog.
//   - Only then does this module opt the user in, register the Mellowtel content
//     script, and start the SDK. Opting out reverses all of it and gives the
//     permission back.
//
// Nothing here touches the unfollow engine; every call is wrapped so a failure
// can only ever mean "network sharing isn't running".

(function (root) {
  "use strict";

  const NET_KEY = "x7.net";                 // { state: "new"|"in"|"later"|"no", asked, askedAt, at }
  const SCRIPT_ID = "x7-mellowtel";
  const PERMS = { permissions: ["declarativeNetRequestWithHostAccess"], origins: ["<all_urls>"] };
  const REMIND_AFTER_MS = 7 * 24 * 3600000; // "Maybe later" asks once more, a week on
  const MAX_ASKS = 2;

  let sdk = null;

  const lib = () => (typeof root.Mellowtel === "function" ? root.Mellowtel : null);
  const key = () => root.X7_MELLOWTEL_KEY || "";

  function instance() {
    if (!sdk) {
      const L = lib();
      if (!L || !key()) throw new Error("Network sharing isn't available in this build.");
      sdk = new L(key());
    }
    return sdk;
  }

  async function load() {
    try { const r = await chrome.storage.local.get(NET_KEY); return Object.assign({ state: "new", asked: 0 }, r[NET_KEY] || {}); }
    catch (_) { return { state: "new", asked: 0 }; }
  }
  async function save(patch) {
    const cur = await load();
    const next = Object.assign(cur, patch);
    try { await chrome.storage.local.set({ [NET_KEY]: next }); } catch (_) {}
    return next;
  }

  async function granted() {
    try { return !!(await chrome.permissions.contains(PERMS)); } catch (_) { return false; }
  }
  async function sdkOptedIn() {
    try { return !!(await instance().getOptInStatus()); } catch (_) { return false; }
  }
  async function isRegistered() {
    try { return (await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] })).length > 0; }
    catch (_) { return false; }
  }
  async function register() {
    if (await isRegistered()) return;
    await chrome.scripting.registerContentScripts([{
      id: SCRIPT_ID, matches: ["<all_urls>"],
      js: ["shared/mellowtel-key.js", "vendor/mellowtel.js", "content/mellowtel-content.js"],
      runAt: "document_start", allFrames: true, persistAcrossSessions: true
    }]);
  }
  async function unregister() {
    try { if (await isRegistered()) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }); } catch (_) {}
  }

  // Opted in only counts while Chrome still grants the access (the user can
  // withdraw it from chrome://extensions at any time).
  async function status() {
    const [state, perm] = await Promise.all([load(), granted()]);
    const optedIn = perm ? await sdkOptedIn() : false;
    return {
      ok: true, available: !!(lib() && key()), granted: perm, optedIn,
      state: state.state, asked: state.asked, askedAt: state.askedAt || 0,
      // The one-time prompt: never asked, or "later" once more after a week.
      shouldPrompt: !optedIn && (state.state === "new" ||
        (state.state === "later" && state.asked < MAX_ASKS && Date.now() - (state.askedAt || 0) >= REMIND_AFTER_MS))
    };
  }

  // Called when the worker starts. Does nothing at all unless a user has opted
  // in AND Chrome still grants the access.
  async function boot() {
    try {
      if (!lib()) return;
      if (!(await granted()) || !(await sdkOptedIn())) { await unregister(); return; }
      await register();
      await instance().initBackground();
    } catch (e) { console.warn("[x7] network sharing:", (e && e.message) || e); }
  }

  // Must follow Chrome's permission grant (done by the page, from the click).
  async function optIn() {
    try {
      if (!lib()) return { ok: false, error: "Network sharing isn't available in this build." };
      if (!(await granted())) return { ok: false, error: "Chrome's permission wasn't granted, so nothing was turned on." };
      const m = instance();
      await m.initBackground();
      const opted = await m.optIn();
      if (!opted) return { ok: false, error: "Couldn't turn on network sharing. Try again in a moment." };
      await register();
      const started = await m.start();
      if (started === false) { await unregister(); return { ok: false, error: "Network sharing couldn't start. Nothing was turned on." }; }
      await save({ state: "in", at: Date.now() });
      return { ok: true };
    } catch (e) {
      await unregister();
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async function optOut() {
    try { if (lib() && key()) await instance().optOut(); } catch (_) {}
    await unregister();
    try { await chrome.permissions.remove(PERMS); } catch (_) {}
    await save({ state: "no", at: Date.now() });
    return { ok: true };
  }

  // The user's answer to the one-time prompt.
  async function answer(choice) {
    if (choice === "later") { const cur = await load(); await save({ state: "later", asked: (cur.asked || 0) + 1, askedAt: Date.now() }); }
    else if (choice === "no") await save({ state: "no", at: Date.now() });
    return { ok: true };
  }

  async function settingsLink() {
    try { return { ok: true, url: await instance().generateSettingsLink() }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  root.X7Net = { status, boot, optIn, optOut, answer, settingsLink, PERMS };
})(self);
