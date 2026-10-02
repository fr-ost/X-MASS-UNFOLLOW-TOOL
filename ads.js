// X Mass Unfollow - ads.js
//
// Shows ONE AdsOnBread ad on this extension page:
//   popup      -> "banner" (horizontal, 300-500px wide)
//   dashboard  -> "card"   (vertical, 180px wide)
// The page declares which with data-ad-placement on its slot.
//
// Rules this follows (AdsOnBread + Chrome Web Store ads policy):
//   * ads only appear in the extension's own pages - never injected into x.com
//   * one ad per page at a time
//   * the SDK (v1.2.0) is vendored in /vendor, not loaded from a CDN
//   * if nothing is served, the slot stays hidden: no empty box
//   * the SDK's viewability check is left intact
//
// The key below is a public publisher identifier, not a secret.

(function () {
  "use strict";

  const API_KEY = "3f7833e9-73d8-4412-870a-e6c49bc91f90";

  function language() {
    try { return chrome.i18n.getUILanguage() || "en"; } catch (_) { return navigator.language || "en"; }
  }

  async function mount() {
    const slot = document.querySelector("[data-ad-placement]");
    if (!slot || typeof window.AdsOnBread === "undefined") return;
    const zone = slot.closest("[data-ad-zone]") || slot;
    const placement = slot.getAttribute("data-ad-placement") === "card" ? "card" : "banner";
    try {
      const ad = await window.AdsOnBread.load(API_KEY, placement, slot, { theme: "light", language: language() });
      if (ad && slot.childElementCount > 0) {
        zone.hidden = false;
        document.documentElement.classList.add("has-ad");
      }
    } catch (_) {
      // An ad problem must never affect the extension.
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
