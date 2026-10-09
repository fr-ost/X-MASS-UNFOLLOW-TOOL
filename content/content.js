// X Mass Unfollow - content/content.js
//
// The x.com side of the extension is a thin executor. All scheduling, pacing
// and state live in the background worker (background.js), which survives
// tab switches, reloads and the popup closing. The worker asks this script to
// do one small thing at a time - read one page of the list, unfollow one
// account - and records the result.
//
// This script never acts on its own initiative and never alters x.com's page.

(function () {
  "use strict";

  const VERSION = chrome.runtime.getManifest().version;
  if (window.__X7_CS === VERSION) return;
  window.__X7_CS = VERSION;

  const API = window.__X7_API;
  const DOM = window.__X7_DOM;

  function fail(e) {
    return { ok: false, kind: (e && e.kind) || "transient", message: String((e && e.message) || e), waitMs: e && e.waitMs };
  }

  function reply(promise, sendResponse) {
    Promise.resolve()
      .then(() => promise())
      .then((r) => sendResponse({ ...(r || {}), uid: API.uid() }))
      .catch((e) => sendResponse({ ...fail(e), uid: API.uid() }));
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.x7 !== "string" || sender.id !== chrome.runtime.id) return;

    switch (msg.x7) {
      case "ping":
        sendResponse({
          ok: true, v: VERSION, url: location.href, uid: API.uid(),
          hidden: document.hidden, challenge: DOM.challenge()
        });
        return;

      case "whoami":
        return reply(() => API.whoami(!!msg.deep), sendResponse);

      case "page":
        return reply(() => API.listPage(msg.op || "Following", msg.userId || API.uid(), msg.cursor || null, msg.count), sendResponse);

      case "lastPost":
        return reply(() => API.lastPost(msg.userId, msg.posts), sendResponse);

      case "unfollow":
        return reply(() => API.unfollow({ id: msg.id, h: msg.h }), sendResponse);

      case "profileUnfollow":
        return reply(() => DOM.profileUnfollow({ id: msg.id, h: msg.h }), sendResponse);

      case "domScanStep":
        return reply(() => DOM.scanStep({ handle: msg.handle, settleMs: msg.settleMs }), sendResponse);

      case "domScanReset":
        DOM.scanReset();
        sendResponse({ ok: true });
        return;

      case "health":
        return reply(() => API.health(), sendResponse);

      default:
        return;
    }
  });

  // Tell the worker this tab is ready to take work (used after it navigates a
  // tab, and to notice tabs opened after the extension started).
  try {
    chrome.runtime.sendMessage({ x7: "ready", url: location.href, uid: API.uid() }).catch(() => {});
  } catch (_) {}
})();
