// X Unfollow Manager Pro - ads.js
//
// Loads a single AdsOnBread placement into the console's own UI.
//
// Scope, deliberately:
//   * Ads render ONLY in surfaces this extension owns - the popup and the
//     side panel. Nothing is ever injected into x.com. Injecting ads into a
//     page the extension does not own is ad injection, which is both a
//     Chrome Web Store violation and the kind of thing that gets an
//     extension pulled rather than warned.
//   * The SDK is vendored (shipped in the package), not fetched at runtime.
//     Manifest V3 forbids remotely hosted code; a bundled file is fine.
//   * One slot, at the bottom, below the controls. It never sits between the
//     user and a button they came here to press.
//
// The publisher key below is a public identifier, not a secret: everything in
// an extension package is readable by anyone who unzips it. That is normal
// for this kind of key, but it is worth knowing it is not private.

(function () {
  "use strict";

  const PUBLISHER_KEY = "3f7833e9-73d8-4412-870a-e6c49bc91f90";
  const SLOT_ID = "ad-slot";
  const ZONE_ID = "adZone";

  function currentTheme() {
    // Mirror whatever the console is showing, so the ad never fights the UI.
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "light") return attr;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark" : "light";
  }

  function uiLanguage() {
    try {
      const l = chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage();
      if (l) return l;
    } catch (_) {}
    return navigator.language || "en";
  }

  async function init() {
    const zone = document.getElementById(ZONE_ID);
    const slot = document.getElementById(SLOT_ID);
    if (!zone || !slot) return;
    if (typeof window.AdsOnBread === "undefined") return;   // vendor file missing

    try {
      await window.AdsOnBread.load(PUBLISHER_KEY, "banner", slot, {
        theme: currentTheme(),
        language: uiLanguage()
      });
    } catch (_) {
      // Never let an ad failure affect the console.
    }

    // Only reveal the zone if something actually rendered. A no-fill request
    // should leave no empty box and no unexplained gap in the layout.
    requestAnimationFrame(() => {
      if (slot.childElementCount > 0) zone.hidden = false;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  // Re-render on theme change so the ad follows the console's light/dark state.
  document.addEventListener("xump-theme-changed", () => {
    const slot = document.getElementById(SLOT_ID);
    const zone = document.getElementById(ZONE_ID);
    if (!slot || !zone || zone.hidden) return;
    slot.innerHTML = "";
    init();
  });
})();
