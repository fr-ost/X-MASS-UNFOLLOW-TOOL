// X Mass Unfollow - theme loader.
// Loaded in <head> of every page before the stylesheets paint, so a dark
// page never flashes white. The choice ("system" | "light" | "dark") lives in
// this extension's localStorage, which every extension page shares; the
// storage event keeps other open pages in sync instantly.
(function () {
  "use strict";
  var KEY = "x7.theme";
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function pref() {
    try { var v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "system"; }
    catch (_) { return "system"; }
  }
  function resolve(p) { return p === "dark" || (p === "system" && mq && mq.matches) ? "dark" : "light"; }

  function apply() {
    var p = pref(), r = resolve(p), el = document.documentElement;
    el.setAttribute("data-theme", r);
    el.setAttribute("data-theme-pref", p);
    el.style.colorScheme = r;
    try { window.dispatchEvent(new CustomEvent("x7-theme", { detail: { theme: r, pref: p } })); } catch (_) {}
  }

  apply();
  if (mq && mq.addEventListener) mq.addEventListener("change", apply);
  window.addEventListener("storage", function (e) { if (e.key === KEY) apply(); });

  window.X7Theme = {
    pref: pref,
    current: function () { return resolve(pref()); },
    set: function (p) { try { localStorage.setItem(KEY, p); } catch (_) {} apply(); },
    toggle: function () { this.set(resolve(pref()) === "dark" ? "light" : "dark"); }
  };
})();
