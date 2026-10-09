// X Mass Unfollow - content/mellowtel-content.js
//
// Part of the optional "network sharing" feature (Mellowtel). It is NOT in the
// manifest's static content scripts: the background worker registers it
// (shared/network.js) only after a user opts in and Chrome grants website
// access, and unregisters it on opt-out. Until then it never runs anywhere.
// The Mellowtel SDK itself does nothing unless the user has opted in.
(function () {
  "use strict";
  try {
    if (typeof Mellowtel !== "function" || !self.X7_MELLOWTEL_KEY) return;
    const m = new Mellowtel(self.X7_MELLOWTEL_KEY);
    m.initContentScript().catch(() => {});
  } catch (_) { /* never let this affect a page */ }
})();
