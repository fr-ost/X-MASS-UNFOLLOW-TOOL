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
//   * the ad follows the page's light/dark theme
//
// The key below is a public publisher identifier, not a secret.

(function () {
  "use strict";

  const API_KEY = "3f7833e9-73d8-4412-870a-e6c49bc91f90";

  function language() {
    try { return chrome.i18n.getUILanguage() || "en"; } catch (_) { return navigator.language || "en"; }
  }

  function theme() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  let shownTheme = null;
  let loading = false;

  async function mount() {
    const slot = document.querySelector("[data-ad-placement]");
    if (!slot || typeof window.AdsOnBread === "undefined" || loading) return;
    const zone = slot.closest("[data-ad-zone]") || slot;
    const placement = slot.getAttribute("data-ad-placement") === "card" ? "card" : "banner";
    const t = theme();
    loading = true;
    try {
      const ad = await window.AdsOnBread.load(API_KEY, placement, slot, { theme: t, language: language() });
      if (ad && slot.childElementCount > 0) {
        shownTheme = t;
        zone.hidden = false;
        document.documentElement.classList.add("has-ad");
      }
    } catch (_) {
      // An ad problem must never affect the extension.
    } finally {
      loading = false;
    }
  }

  // Re-render in the new colours when the user flips the theme. The SDK
  // replaces the slot's contents, so there is still only one ad on the page.
  let t = null;
  window.addEventListener("x7-theme", () => {
    if (shownTheme === null || shownTheme === theme()) return;
    clearTimeout(t);
    t = setTimeout(mount, 250);
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
