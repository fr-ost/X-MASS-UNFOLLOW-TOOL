// X Mass Unfollow - content/dom.js
//
// Fallbacks for when X's internal API cannot be used. These drive X's own
// page exactly as a person would, so X's app sends its own requests:
//
//   profileUnfollow  - on x.com/<handle>, click Following -> Unfollow.
//                      Used only if the API unfollow is rejected. A profile
//                      page always has exactly one follow control for that
//                      account, so this can never hit the wrong person.
//   scanStep         - on x.com/<you>/following, read the rendered rows and
//                      scroll one screen. Used only if the API read is
//                      rejected. Needs a visible tab (X does not render rows
//                      in hidden tabs), which the engine tells the user.
//
// Nothing here touches any page other than the one the engine opened.

(function () {
  "use strict";

  if (window.__X7_DOM) return;

  const SEL = {
    cell: '[data-testid="UserCell"]',
    primary: '[data-testid="primaryColumn"]',
    followsYou: '[data-testid="userFollowIndicator"]',
    confirmDialog: '[data-testid="confirmationSheetDialog"]',
    confirmBtn: '[data-testid="confirmationSheetConfirm"]',
    cancelBtn: '[data-testid="confirmationSheetCancel"]',
    emptyState: '[data-testid="empty_state_header_text"]',
    toast: '[data-testid="toast"], [role="alert"]',
    verified: '[data-testid="icon-verified"]',
    lock: '[data-testid="icon-lock"]',
    spinner: '[role="progressbar"]'
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (v) => (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/["\\]/g, "\\$&");

  // ---------------------------------------------------------------------
  // Challenge / blocked states. Never click through these.
  // ---------------------------------------------------------------------
  function challenge() {
    const p = location.pathname;
    if (/^\/account\/access/i.test(p)) return "locked";
    if (/^\/account\/suspended/i.test(p)) return "suspended";
    if (/^\/i\/flow\/(login|signup)/i.test(p) || /^\/login\/?$/i.test(p)) return "auth";
    if (document.querySelector('iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], #arkose, div[id^="arkose"]')) return "captcha";
    return null;
  }

  function toastKind() {
    for (const n of document.querySelectorAll(SEL.toast)) {
      const s = (n.innerText || "").toLowerCase();
      if (!s) continue;
      if (/rate limit|too many|over the limit|unable to (un)?follow more|try again later/.test(s)) return "rate";
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Profile unfollow
  // ---------------------------------------------------------------------
  function profileButtons(id) {
    const root = document.querySelector(SEL.primary) || document;
    const notInList = (b) => !b.closest(SEL.cell);
    if (id) {
      return {
        un: root.querySelector(`[data-testid="${esc(id)}-unfollow"]`),
        fo: root.querySelector(`[data-testid="${esc(id)}-follow"]`)
      };
    }
    return {
      un: [...root.querySelectorAll('[data-testid$="-unfollow"]')].find(notInList) || null,
      fo: [...root.querySelectorAll('[data-testid$="-follow"]')].find(notInList) || null
    };
  }

  // Confirmation is scoped strictly to X's confirmation sheet (or, on builds
  // that show a menu instead, a menu item that says Unfollow). Never "the
  // first button in any dialog" - that could be a cookie banner.
  async function waitConfirm(timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const btn = document.querySelector(`${SEL.confirmDialog} ${SEL.confirmBtn}`) ||
                  document.querySelector(SEL.confirmBtn);
      if (btn) return btn;
      const item = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
        .find((el) => /unfollow/i.test(el.getAttribute("data-testid") || "") ||
                      /^\s*unfollow\b/i.test(el.innerText || ""));
      if (item) return item;
      await wait(150);
    }
    return null;
  }

  async function dismiss() {
    const cancel = document.querySelector(SEL.cancelBtn);
    if (cancel) { cancel.click(); await wait(300); return; }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await wait(300);
  }

  function pageSaysGone() {
    if (document.querySelector(SEL.emptyState)) {
      const t = (document.querySelector(SEL.emptyState).innerText || "").toLowerCase();
      if (/exist|suspend|unavailable|not found|doesn/.test(t)) return true;
    }
    return false;
  }

  async function profileUnfollow(target) {
    const h = String(target.h || "").replace(/^@/, "").toLowerCase();
    const here = (location.pathname.split("/")[1] || "").toLowerCase();
    if (!h || here !== h) return { ok: false, kind: "transient", message: "not on the profile yet" };

    let id = target.id || null;
    let btn = null;
    const until = Date.now() + 22000;
    while (Date.now() < until) {
      const ch = challenge();
      if (ch) return { ok: false, kind: ch === "captcha" ? "locked" : ch, message: "X is showing a " + ch + " screen" };
      const b = profileButtons(id);
      if (b.un) { btn = b.un; break; }
      if (b.fo) return { ok: false, kind: "gone", message: "already not following" };
      if (pageSaysGone()) return { ok: false, kind: "gone", message: "account unavailable" };
      await wait(350);
    }
    if (!btn) return { ok: false, kind: "transient", message: "the profile did not finish loading" };

    const m = (btn.getAttribute("data-testid") || "").match(/^(.+)-unfollow$/);
    if (m) id = m[1];

    await wait(300 + Math.random() * 500);
    btn.click();
    const confirm = await waitConfirm(6000);
    if (!confirm) {
      await dismiss();
      return { ok: false, kind: "transient", message: "the confirmation did not open" };
    }
    await wait(200 + Math.random() * 400);
    confirm.click();

    const verifyUntil = Date.now() + 9000;
    while (Date.now() < verifyUntil) {
      const b = profileButtons(id);
      if (b.fo || !b.un) return { ok: true, kind: "ok", id };
      const t = toastKind();
      if (t) return { ok: false, kind: "rate", waitMs: 20 * 60000, message: "X says to slow down" };
      await wait(250);
    }
    await dismiss();
    return { ok: false, kind: toastKind() || "transient", waitMs: 20 * 60000, message: "X did not confirm the unfollow" };
  }

  // ---------------------------------------------------------------------
  // Scroll scan of the Following page
  // ---------------------------------------------------------------------
  function isFollowingPage(handle) {
    const m = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/following\/?$/i);
    return !!m && (!handle || m[1].toLowerCase() === String(handle).toLowerCase());
  }

  function readRow(cell) {
    let id = null, following = false;
    for (const b of cell.querySelectorAll("[data-testid]")) {
      const t = b.getAttribute("data-testid") || "";
      const m = t.match(/^(\d+)-(unfollow|follow|cancel)$/);
      if (m) { id = m[1]; following = m[2] === "unfollow"; break; }
    }
    if (!id || !following) return null;

    let h = "";
    for (const a of cell.querySelectorAll('a[href^="/"]')) {
      const href = a.getAttribute("href") || "";
      if (/^\/[A-Za-z0-9_]{1,15}$/.test(href)) { h = href.slice(1); break; }
    }
    if (!h) {
      const mm = (cell.innerText || "").match(/@([A-Za-z0-9_]{1,15})/);
      if (mm) h = mm[1];
    }
    if (!h) return null;

    const lines = (cell.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const img = cell.querySelector('img[src*="profile_images"], img[src*="default_profile"]');
    const avatar = img ? img.getAttribute("src") || "" : "";
    const handleLine = lines.findIndex((l) => l.toLowerCase() === "@" + h.toLowerCase());
    const bio = handleLine >= 0 ? lines.slice(handleLine + 1).filter((l) => !/^(follows you|following|follow)$/i.test(l)).join(" ") : "";
    return {
      i: id, h, n: lines[0] && !lines[0].startsWith("@") ? lines[0] : h, a: avatar,
      fy: !!cell.querySelector(SEL.followsYou), fw: true,
      v: !!cell.querySelector(SEL.verified), p: !!cell.querySelector(SEL.lock),
      fc: null, fr: null, sc: null, ca: null,
      d: /default_profile/.test(avatar), b: bio.slice(0, 220)
    };
  }

  function readRows() {
    const out = [];
    for (const c of document.querySelectorAll(SEL.cell)) {
      const r = readRow(c);
      if (r) out.push(r);
    }
    return out;
  }

  let scanStepNo = 0;
  async function scanStep(opts) {
    const handle = opts && opts.handle;
    if (!isFollowingPage(handle)) return { ok: false, kind: "wrongPage", message: "not on the Following page" };
    const ch = challenge();
    if (ch) return { ok: false, kind: ch === "captcha" ? "locked" : ch, message: "X is showing a " + ch + " screen" };
    if (document.hidden) return { ok: true, hidden: true, users: [] };

    const seen = new Map();
    for (const u of readRows()) seen.set(u.i, u);

    scanStepNo++;
    const cells = document.querySelectorAll(SEL.cell);
    const last = cells[cells.length - 1];
    if (last && scanStepNo % 3 === 0) {
      try { last.scrollIntoView({ block: "end" }); } catch (_) {}
    } else {
      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
    }
    await wait((opts && opts.settleMs) || 1100);
    for (const u of readRows()) seen.set(u.i, u);

    const doc = document.documentElement;
    return {
      ok: true, hidden: false, users: [...seen.values()],
      atBottom: window.scrollY + window.innerHeight >= doc.scrollHeight - 80,
      loading: !!document.querySelector(`${SEL.primary} ${SEL.spinner}`),
      empty: !!document.querySelector(SEL.emptyState) && !cells.length
    };
  }

  function scanReset() {
    scanStepNo = 0;
    try { window.scrollTo(0, 0); } catch (_) {}
  }

  window.__X7_DOM = { challenge, profileUnfollow, scanStep, scanReset, isFollowingPage };
})();
