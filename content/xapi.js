// X Mass Unfollow - content/xapi.js
//
// A small client for the same internal endpoints X's own web app calls:
//
//   * GraphQL "Following" / "Followers" timelines - to read the whole list
//     page by page, with an authoritative "follows you" flag per account.
//   * REST friendships/destroy.json - the request X's own Unfollow button
//     sends.
//
// Why not scroll the page and click buttons (what v6 did)?
//   Chrome stops rendering a tab that is not visible, so X never loads more
//   rows while you are on another tab. A scroll-driven run therefore stalled
//   as soon as the first rendered batch (about 20-30 accounts) was used up.
//   Direct requests do not depend on rendering, scrolling or the tab being
//   visible, and they cannot click the wrong row.
//
// It runs in the user's own signed-in x.com tab, with the user's own session.
// Nothing is sent anywhere except x.com (and abs.twimg.com for X's own JS).
//
// Everything that X rotates is discovered at runtime instead of hardcoded:
//   - query ids and the feature-switch list, read from X's JS bundles
//   - feature values, read from the app shell's __INITIAL_STATE__
//   - GET vs POST (X moved some timelines to POST in Aug 2026)
//   - the x-client-transaction-id header (txid.js)
// and a missing feature flag named by an error is added and retried.

(function () {
  "use strict";

  if (window.__X7_API) return;

  const TX = () => window.__X7_TXID;

  // X's public web-app bearer. Stable for years; the bundle copy wins if found.
  const WEB_BEARER = "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  const OPS_KEY = "x7.ops";
  const OPS_TTL_MS = 12 * 60 * 60 * 1000;

  // Known-good feature flags, used when the bundle metadata cannot be read.
  const BASE_FEATURES = {
    rweb_video_screen_enabled: false,
    payments_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_jetfuel_frame: true,
    responsive_web_grok_share_attachment_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_grok_analysis_button_from_backend: true,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_grok_community_note_auto_translation_is_enabled: false,
    responsive_web_enhance_cards_enabled: false
  };

  // ---------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------
  function cookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // The signed-in account's numeric id, from the `twid` cookie ("u=123").
  function uid() {
    const raw = cookie("twid");
    const m = raw && String(raw).match(/(\d{2,})/);
    return m ? m[1] : null;
  }

  const csrf = () => cookie("ct0") || "";
  const lang = () => (document.documentElement.getAttribute("lang") || navigator.language || "en").slice(0, 5);

  // ---------------------------------------------------------------------
  // Errors carry a `kind` the engine understands:
  //   rate      - X asked us to slow down; waitMs says how long
  //   auth      - signed out / session expired
  //   locked    - account temporarily locked by X
  //   suspended - account suspended
  //   gone      - the target account no longer exists / not followed
  //   endpoint  - X rejected the request shape (header, method, query id)
  //   transient - network or 5xx; try again later
  // ---------------------------------------------------------------------
  function apiError(kind, message, extra) {
    const e = new Error(message || kind);
    e.kind = kind;
    Object.assign(e, extra || {});
    return e;
  }

  function rateWait(res, fallbackMs) {
    const reset = Number(res && res.headers && res.headers.get("x-rate-limit-reset")) * 1000;
    if (reset && reset > Date.now()) return Math.min(reset - Date.now() + 5000, 3 * 60 * 60000);
    return fallbackMs;
  }

  function classify(res, json) {
    const status = res.status;
    const errors = (json && Array.isArray(json.errors)) ? json.errors : [];
    const codes = errors.map((e) => Number(e.code)).filter((c) => !Number.isNaN(c));
    const msg = errors.map((e) => e.message).filter(Boolean).join("; ").slice(0, 300);

    if (status === 429 || codes.includes(88)) {
      return { kind: "rate", status, waitMs: rateWait(res, 15 * 60000), message: msg || "rate limited" };
    }
    if (codes.includes(326)) return { kind: "locked", status, message: msg || "account locked" };
    if (codes.includes(64)) return { kind: "suspended", status, message: msg || "account suspended" };
    if (status === 401 || codes.some((c) => c === 32 || c === 89 || c === 215 || c === 239)) {
      return { kind: "auth", status, message: msg || "not signed in" };
    }
    if (codes.includes(353)) return { kind: "auth", status, message: "session token mismatch - reload x.com" };
    if (codes.some((c) => c === 34 || c === 50 || c === 63 || c === 108)) {
      return { kind: "gone", status, message: msg || "account not found" };
    }
    // Follow/unfollow volume limits come back as 403 with these codes.
    if (codes.some((c) => c === 161 || c === 344 || c === 327) || /limit/i.test(msg)) {
      return { kind: "rate", status, waitMs: rateWait(res, 30 * 60000), message: msg || "action limit" };
    }
    if (status >= 500) return { kind: "transient", status, message: msg || "X server error " + status };
    if (status === 404 || status === 405 || status === 403 || status === 400) {
      return { kind: "endpoint", status, message: msg || "X rejected the request (" + status + ")" };
    }
    return { kind: "transient", status, message: msg || "HTTP " + status };
  }

  async function readJson(res) {
    const text = await res.text().catch(() => "");
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  // ---------------------------------------------------------------------
  // Bundle discovery: bearer, query ids, feature switches
  // ---------------------------------------------------------------------
  let ops = null;          // { at, bearer, ops: {Name: {id, type, features, toggles}}, methods: {Name: "GET"|"POST"} }
  let featureValues = {};  // name -> boolean, from __INITIAL_STATE__

  async function fetchCrossOrigin(url) {
    try {
      const res = await chrome.runtime.sendMessage({ x7: "fetchText", url });
      if (res && res.ok) return res.text;
    } catch (_) {}
    const r = await fetch(url, { credentials: "omit" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  }

  function listOf(str) {
    if (!str) return [];
    return str.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }

  // Find an operation's metadata in a bundle. Minified bundles contain
  //   {queryId:"abc",operationName:"Following",operationType:"query",
  //    metadata:{featureSwitches:[...],fieldToggles:[...]}}
  // but the key order has changed before, so search around the name.
  function findOp(text, name) {
    const marker = 'operationName:"' + name + '"';
    let at = text.indexOf(marker);
    while (at !== -1) {
      const before = text.slice(Math.max(0, at - 260), at);
      const after = text.slice(at, at + 8000);
      let id = null;
      const qb = before.match(/queryId:\s*"([A-Za-z0-9_-]{8,})"[^{}]*$/);
      if (qb) id = qb[1];
      if (!id) {
        const qa = after.slice(marker.length, 300).match(/^[^{}]*?queryId:\s*"([A-Za-z0-9_-]{8,})"/);
        if (qa) id = qa[1];
      }
      if (id) {
        const next = after.indexOf("operationName:", marker.length);
        const scope = next > 0 ? after.slice(0, next) : after;
        const fs = scope.match(/featureSwitches:\s*\[([^\]]*)\]/);
        const ft = scope.match(/fieldToggles:\s*\[([^\]]*)\]/);
        const ot = scope.match(/operationType:\s*"(\w+)"/);
        return { id, type: ot ? ot[1] : "query", features: listOf(fs && fs[1]), toggles: listOf(ft && ft[1]) };
      }
      at = text.indexOf(marker, at + marker.length);
    }
    return null;
  }

  function extractInitialState(text) {
    const at = text.indexOf("__INITIAL_STATE__");
    if (at < 0) return null;
    const start = text.indexOf("{", at);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let j = start; j < text.length; j++) {
      const c = text.charCodeAt(j);
      if (inStr) {
        if (esc) esc = false;
        else if (c === 92) esc = true;           // backslash
        else if (c === 34) inStr = false;        // quote
        continue;
      }
      if (c === 34) inStr = true;
      else if (c === 123) depth++;
      else if (c === 125) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, j + 1)); } catch (_) { return null; }
        }
      }
    }
    return null;
  }

  function featureValuesFrom(state) {
    const out = {};
    const fsw = state && state.featureSwitch;
    if (!fsw) return out;
    const take = (cfg) => {
      if (!cfg) return;
      for (const [k, v] of Object.entries(cfg)) {
        if (v && typeof v === "object" && "value" in v && typeof v.value === "boolean") out[k] = v.value;
        else if (typeof v === "boolean") out[k] = v;
      }
    };
    take(fsw.defaultConfig);
    take(fsw.user && fsw.user.config);
    take(fsw.config);
    return out;
  }

  function bundleUrlsFrom(doc) {
    const urls = [];
    if (!doc) return urls;
    doc.querySelectorAll("script[src], link[rel='preload'][href], link[rel='modulepreload'][href]").forEach((el) => {
      const raw = el.getAttribute("src") || el.getAttribute("href") || "";
      if (!/\.js(\?|$)/.test(raw)) return;
      let u;
      try { u = new URL(raw, location.origin).href; } catch (_) { return; }
      if (/abs\.twimg\.com|\/responsive-web\/|client-web|x-web/.test(u) && !urls.includes(u)) urls.push(u);
    });
    // main.* first: it carries the GraphQL operation table.
    return urls.sort((a, b) => (/\/main\./.test(b) ? 1 : 0) - (/\/main\./.test(a) ? 1 : 0));
  }

  const KNOWN_OPS = ["Following", "Followers"];

  async function discover(force, wanted) {
    const need = wanted || KNOWN_OPS;
    if (!force && ops && Date.now() - ops.at < OPS_TTL_MS && need.every((n) => ops.ops[n])) return ops;
    if (!force && !ops) {
      try {
        const c = (await chrome.storage.local.get(OPS_KEY))[OPS_KEY];
        if (c && Date.now() - c.at < OPS_TTL_MS && need.every((n) => c.ops && c.ops[n])) {
          ops = c;
          featureValues = c.featureValues || {};
          return ops;
        }
      } catch (_) {}
    }

    const found = { at: Date.now(), bearer: null, ops: {}, methods: (ops && ops.methods) || {}, learned: (ops && ops.learned) || {}, featureValues: {} };
    const look = [...new Set([...need, ...KNOWN_OPS])];
    const shell = await TX().shell(force ? 0 : undefined).catch(() => null);
    if (shell) {
      const st = extractInitialState(shell.html);
      found.featureValues = featureValuesFrom(st);
      found.viewer = viewerFrom(st);
    }

    const urls = [...new Set([...bundleUrlsFrom(document), ...bundleUrlsFrom(shell && shell.doc)])];
    for (const url of urls.slice(0, 14)) {
      if (look.every((n) => found.ops[n]) && found.bearer) break;
      let text;
      try { text = await fetchCrossOrigin(url); } catch (_) { continue; }
      if (!found.bearer) {
        const b = text.match(/"(AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%_-]{40,})"/);
        if (b) found.bearer = "Bearer " + b[1];
      }
      for (const n of look) if (!found.ops[n]) {
        const op = findOp(text, n);
        if (op) found.ops[n] = op;
      }
    }

    // Keep anything found earlier that this pass did not see again.
    if (ops && ops.ops) for (const [n, op] of Object.entries(ops.ops)) if (!found.ops[n]) found.ops[n] = op;
    const missing = need.filter((n) => !found.ops[n]);
    if (missing.length) {
      throw apiError("endpoint", "Could not find X's " + missing.join(" / ") + " query in its app code.");
    }
    if (!found.bearer && ops && ops.bearer) found.bearer = ops.bearer;
    ops = found;
    featureValues = found.featureValues || {};
    try { await chrome.storage.local.set({ [OPS_KEY]: ops }); } catch (_) {}
    return ops;
  }

  const bearer = () => (ops && ops.bearer) || WEB_BEARER;

  function buildFeatures(op, extra) {
    const out = {};
    const names = op.features && op.features.length ? op.features : Object.keys(BASE_FEATURES);
    for (const n of names) {
      out[n] = n in featureValues ? featureValues[n] : (n in BASE_FEATURES ? BASE_FEATURES[n] : false);
    }
    return Object.assign(out, extra || {});
  }

  function buildToggles(op) {
    const out = {};
    for (const n of op.toggles || []) out[n] = n in featureValues ? featureValues[n] : false;
    return out;
  }

  // ---------------------------------------------------------------------
  // Request plumbing
  // ---------------------------------------------------------------------
  let lastTxError = null;

  async function headers(method, url, extra) {
    const h = {
      authorization: bearer(),
      "x-csrf-token": csrf(),
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": lang()
    };
    try {
      h["x-client-transaction-id"] = await TX().generate(method, new URL(url).pathname);
      lastTxError = null;
    } catch (e) {
      // Some endpoints still work without it; the caller sees the 404 if not.
      lastTxError = String(e && e.message || e);
    }
    return Object.assign(h, extra || {});
  }

  async function send(method, url, body, contentType) {
    const hdr = await headers(method, url, contentType ? { "content-type": contentType } : null);
    let res;
    try {
      res = await fetch(url, { method, credentials: "include", headers: hdr, body: body || undefined, cache: "no-store" });
    } catch (e) {
      throw apiError("transient", "Network error talking to X.");
    }
    const json = await readJson(res);
    return { res, json };
  }

  // One GraphQL read with self-healing: method switch, fresh transaction
  // material, fresh query ids and learned feature flags, in that order.
  async function gql(name, variables) {
    await discover(false, [name]);
    // Flags X demanded on an earlier call are sent from the start.
    let extraFeatures = Object.assign({}, (ops.learned && ops.learned[name]) || {});
    let refreshedTx = false, rediscovered = false;

    for (let round = 0; round < 8; round++) {
      const op = ops.ops[name];
      if (!op) throw apiError("endpoint", "X's " + name + " query is unavailable.");
      const features = buildFeatures(op, extraFeatures);
      const fieldToggles = buildToggles(op);
      const preferred = ops.methods[name] || "GET";
      const order = preferred === "POST" ? ["POST", "GET"] : ["GET", "POST"];

      let last = null;
      for (const method of order) {
        const base = location.origin + "/i/api/graphql/" + op.id + "/" + name;
        let r;
        if (method === "GET") {
          const qs = "?variables=" + encodeURIComponent(JSON.stringify(variables)) +
            "&features=" + encodeURIComponent(JSON.stringify(features)) +
            (Object.keys(fieldToggles).length ? "&fieldToggles=" + encodeURIComponent(JSON.stringify(fieldToggles)) : "");
          r = await send("GET", base + qs, null, "application/json");
        } else {
          r = await send("POST", base, JSON.stringify({ variables, features, fieldToggles, queryId: op.id }), "application/json");
        }
        last = r;
        if (r.res.ok && r.json && r.json.data) {
          if (ops.methods[name] !== method) {
            ops.methods[name] = method;
            try { await chrome.storage.local.set({ [OPS_KEY]: ops }); } catch (_) {}
          }
          return { json: r.json, res: r.res };
        }
        const errText = ((r.json && r.json.errors) || []).map((e) => e.message).join("; ");
        const missing = errText.match(/features cannot be null:?\s*([A-Za-z0-9_,\s]+)/i);
        if (missing) break;                               // handled below
        const cls = classify(r.res, r.json);
        if (cls.kind !== "endpoint") throw apiError(cls.kind, cls.message, cls);
        // endpoint -> try the other method
      }

      const errText = ((last.json && last.json.errors) || []).map((e) => e.message).join("; ");
      const missing = errText.match(/features cannot be null:?\s*([A-Za-z0-9_,\s]+)/i);
      if (missing) {
        for (const f of listOf(missing[1])) extraFeatures[f] = f in featureValues ? featureValues[f] : false;
        ops.learned = ops.learned || {};
        ops.learned[name] = Object.assign({}, extraFeatures);
        try { await chrome.storage.local.set({ [OPS_KEY]: ops }); } catch (_) {}
        continue;
      }
      if (!refreshedTx) {
        refreshedTx = true;
        await TX().invalidate();
        try { await TX().init(true); } catch (_) {}
        continue;
      }
      if (!rediscovered) {
        rediscovered = true;
        await discover(true, [name]);
        continue;
      }
      const cls = classify(last.res, last.json);
      throw apiError("endpoint", cls.message || "X rejected the " + name + " request.", { status: last.res.status, txError: lastTxError });
    }
    throw apiError("endpoint", "X kept rejecting the " + name + " request.");
  }

  // ---------------------------------------------------------------------
  // Timeline parsing
  // ---------------------------------------------------------------------
  function findInstructions(node, depth) {
    if (!node || typeof node !== "object" || depth > 7) return null;
    if (Array.isArray(node.instructions)) return node.instructions;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === "object") {
        const r = findInstructions(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  function entriesOf(json) {
    const ins = findInstructions(json && json.data, 0) || [];
    const out = [];
    for (const i of ins) {
      if (Array.isArray(i.entries)) out.push(...i.entries);
      if (i.entry) out.push(i.entry);
      if (Array.isArray(i.moduleItems)) out.push(...i.moduleItems.map((m) => ({ entryId: m.entryId, content: m.item })));
    }
    return out;
  }

  function parseUser(result) {
    if (!result || typeof result !== "object") return null;
    if (result.__typename === "UserUnavailable") return null;
    if (result.user && !result.rest_id) result = result.user;   // visibility wrapper
    const legacy = result.legacy || {};
    const core = result.core || {};
    const id = result.rest_id || legacy.id_str;
    const handle = core.screen_name || legacy.screen_name;
    if (!id || !handle) return null;

    // X drops false booleans from its payloads, so "followed_by" missing from
    // a relationship object that is present means "does not follow you".
    // Only when there is no relationship data at all is it truly unknown.
    const relObj = result.relationship_perspectives;
    const rel = relObj || {};
    const legacyHasRel = "following" in legacy || "followed_by" in legacy;
    const tri = (a, b) => {
      if (a !== undefined && a !== null) return !!a;
      if (b !== undefined && b !== null) return !!b;
      return (relObj && typeof relObj === "object") || legacyHasRel ? false : null;
    };
    const avatar = (result.avatar && result.avatar.image_url) || legacy.profile_image_url_https || "";
    const created = core.created_at || legacy.created_at;
    const bio = (result.profile_bio && result.profile_bio.description) || legacy.description || "";
    const prot = result.privacy && result.privacy.protected !== undefined ? result.privacy.protected : legacy.protected;

    return {
      i: String(id),
      h: String(handle),
      n: String(core.name || legacy.name || ""),
      a: String(avatar),
      fy: tri(rel.followed_by, legacy.followed_by),
      fw: tri(rel.following, legacy.following),
      v: !!(result.is_blue_verified || (result.verification && result.verification.verified) || legacy.verified),
      // Premium blue check only. null = X didn't say, which is never treated as "not blue".
      bv: typeof result.is_blue_verified === "boolean" ? result.is_blue_verified : null,
      p: !!prot,
      fc: typeof legacy.followers_count === "number" ? legacy.followers_count : null,
      fr: typeof legacy.friends_count === "number" ? legacy.friends_count : null,
      sc: typeof legacy.statuses_count === "number" ? legacy.statuses_count : null,
      ca: created ? (Date.parse(created) || null) : null,
      d: !!legacy.default_profile_image || /default_profile_images/.test(avatar),
      b: String(bio).replace(/\s+/g, " ").slice(0, 220)
    };
  }

  function parsePage(json) {
    const users = [];
    let cursor = null;
    for (const e of entriesOf(json)) {
      const eid = String(e.entryId || "");
      const c = e.content || {};
      if (/^cursor-bottom/i.test(eid) || c.cursorType === "Bottom") {
        cursor = c.value || (c.itemContent && c.itemContent.value) || cursor;
        continue;
      }
      const r = (c.itemContent && c.itemContent.user_results && c.itemContent.user_results.result) ||
                (e.item && e.item.itemContent && e.item.itemContent.user_results && e.item.itemContent.user_results.result);
      const u = parseUser(r);
      if (u) users.push(u);
    }
    return { users, cursor };
  }

  // One page of a user list (Following, or Followers as a fallback when X
  // stops including relationship flags).
  async function listPage(name, userId, cursor, count) {
    const want = Math.min(count || 100, (ops && ops.pageCount) || 100);
    const variables = { userId: String(userId), count: want, includePromotedContent: false };
    if (cursor) variables.cursor = cursor;
    let got;
    try {
      got = await gql(name, variables);
    } catch (e) {
      // If X refuses a large page, fall back to the page size its own app uses.
      if (e.kind !== "endpoint" || want <= 20) throw e;
      variables.count = 20;
      got = await gql(name, variables);
      ops.pageCount = 20;
      try { await chrome.storage.local.set({ [OPS_KEY]: ops }); } catch (_) {}
    }
    const { json, res } = got;
    const { users, cursor: next } = parsePage(json);
    const remaining = Number(res.headers.get("x-rate-limit-remaining"));
    const reset = Number(res.headers.get("x-rate-limit-reset")) * 1000;
    const end = !next || /^0\|/.test(next) || next === cursor;
    return {
      ok: true, users, cursor: next, end,
      rate: { remaining: Number.isFinite(remaining) ? remaining : null, resetAt: reset || null }
    };
  }

  // ---------------------------------------------------------------------
  // Last activity
  //
  // X shows nobody's "last seen", and the following list carries no activity
  // at all. The only activity signal a signed-in session can read is the
  // account's newest post, reply or repost, so that is what "last active"
  // means here. It is read from the account's own timeline, one profile at a
  // time. Pinned posts are skipped (they are old by design), and only posts
  // written by the account itself count (reply threads also show the other
  // person's post). Nothing is ever guessed: when the date can't be read the
  // answer is "na", with the reason.
  // ---------------------------------------------------------------------
  // Only the posts-and-replies timeline is used. The posts-only one leaves out
  // replies, so for someone who mostly replies it would report an older date
  // than their real activity, which would be a guess in the wrong direction.
  const ACTIVITY_OPS = [
    ["UserTweetsAndReplies", (id) => ({ userId: String(id), count: 20, includePromotedContent: false, withCommunity: true, withVoice: true })]
  ];
  const SNOWFLAKE_EPOCH = 1288834974657;

  // Post ids are time-ordered snowflakes, so the id alone gives the time.
  function snowflakeMs(id) {
    try { return Number(BigInt(String(id)) >> BigInt(22)) + SNOWFLAKE_EPOCH; } catch (_) { return null; }
  }

  function postTimeOf(tw) {
    const l = tw.legacy || {};
    const c = tw.core || {};
    let ts = Date.parse(l.created_at || c.created_at || "");
    if (!Number.isFinite(ts)) ts = snowflakeMs(tw.rest_id || l.id_str);
    const ok = Number.isFinite(ts) && ts > 1.14e12 && ts < Date.now() + 864e5;
    return ok ? ts : null;
  }

  function scanActivity(json, userId) {
    const out = { latest: null, seen: 0, tombstone: false, unavailable: false };
    const user = json && json.data && json.data.user && json.data.user.result;
    if (user && user.__typename === "UserUnavailable") { out.unavailable = true; return out; }

    const consider = (res) => {
      let tw = res;
      if (tw && tw.tweet && !tw.legacy) tw = tw.tweet;              // visibility wrapper
      if (!tw || typeof tw !== "object") return;
      const author = tw.core && tw.core.user_results && tw.core.user_results.result;
      const aid = (author && (author.rest_id || (author.legacy && author.legacy.id_str))) || (tw.legacy && tw.legacy.user_id_str);
      if (!aid || String(aid) !== String(userId)) return;           // someone else's post in the thread
      const t = postTimeOf(tw);
      if (t == null) return;
      out.seen++;
      if (out.latest === null || t > out.latest) out.latest = t;
    };
    const visit = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 9) return;
      if (node.tweet_results && node.tweet_results.result) consider(node.tweet_results.result);
      if (node.itemType === "TimelineTombstone" || node.__typename === "TimelineTombstone") out.tombstone = true;
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === "object" && k !== "tweet_results") visit(v, depth + 1);
      }
    };

    for (const ins of findInstructions(json && json.data, 0) || []) {
      if (ins.type === "TimelinePinEntry") continue;               // pinned posts say nothing about activity
      const list = [];
      if (Array.isArray(ins.entries)) list.push(...ins.entries);
      if (Array.isArray(ins.moduleItems)) list.push(...ins.moduleItems);
      for (const e of list) {
        if (/^(promoted|cursor|who-to-follow|tweetdetail)/i.test(String(e.entryId || ""))) continue;
        visit(e, 0);
      }
    }
    return out;
  }

  // posts: the account's total post count when known (0 = never posted).
  async function lastPost(userId, posts) {
    let lastErr = null, empty = null;
    for (const [name, vars] of ACTIVITY_OPS) {
      let got;
      try { got = await gql(name, vars(userId)); }
      catch (e) {
        if (e.kind === "endpoint") { lastErr = e; continue; }       // this query isn't available
        throw e;
      }
      const remaining = Number(got.res.headers.get("x-rate-limit-remaining"));
      const reset = Number(got.res.headers.get("x-rate-limit-reset")) * 1000;
      const rate = { remaining: Number.isFinite(remaining) ? remaining : null, resetAt: reset || null };
      const a = scanActivity(got.json, userId);
      if (a.unavailable) return { ok: true, state: "na", why: "Account unavailable", rate };
      if (a.latest !== null) return { ok: true, state: "ok", t: a.latest, op: name, rate };
      if (posts === 0) return { ok: true, state: "none", rate };
      if (a.tombstone) return { ok: true, state: "na", why: "Posts are hidden", rate };
      empty = { rate };                                              // nothing of theirs on this page
    }
    if (empty) return { ok: true, state: "na", why: "No recent post could be read", rate: empty.rate };
    throw lastErr || apiError("endpoint", "X's profile posts query is unavailable.");
  }

  // ---------------------------------------------------------------------
  // Unfollow
  // ---------------------------------------------------------------------
  async function unfollow(target) {
    const url = location.origin + "/i/api/1.1/friendships/destroy.json";
    const p = new URLSearchParams({
      include_profile_interstitial_type: "1",
      include_blocking: "1",
      include_blocked_by: "1",
      include_followed_by: "1",
      include_want_retweets: "1",
      include_mute_edge: "1",
      include_can_dm: "1",
      include_can_media_tag: "1",
      include_ext_is_blue_verified: "1",
      include_ext_verified_type: "1",
      include_ext_profile_image_shape: "1",
      skip_status: "1"
    });
    if (target.id) p.set("user_id", String(target.id));
    else p.set("screen_name", String(target.h || "").replace(/^@/, ""));

    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try {
        r = await send("POST", url, p.toString(), "application/x-www-form-urlencoded");
      } catch (e) {
        return { ok: false, kind: e.kind || "transient", message: e.message };
      }
      if (r.res.ok) {
        // X returns the user object. A 200 without one is still a success:
        // the server accepted the unfollow.
        const j = r.json || {};
        return { ok: true, kind: "ok", id: j.id_str || target.id || null, h: j.screen_name || target.h || null };
      }
      const cls = classify(r.res, r.json);
      if (cls.kind === "endpoint" && attempt === 0) {
        await TX().invalidate();
        try { await TX().init(true); } catch (_) {}
        continue;
      }
      return { ok: false, ...cls };
    }
    return { ok: false, kind: "endpoint", message: "X rejected the unfollow request." };
  }

  // ---------------------------------------------------------------------
  // The signed-in profile, for the header of the popup.
  // ---------------------------------------------------------------------
  function viewerFrom(state) {
    try {
      const id = state && state.session && state.session.user_id;
      const ents = state && state.entities && state.entities.users && state.entities.users.entities;
      const u = id && ents && ents[id];
      if (!u) return null;
      const legacy = u.legacy || u;
      const core = u.core || {};
      return {
        id: String(id),
        handle: core.screen_name || legacy.screen_name || "",
        name: core.name || legacy.name || "",
        avatar: (u.avatar && u.avatar.image_url) || legacy.profile_image_url_https || "",
        followers: typeof legacy.followers_count === "number" ? legacy.followers_count : null,
        following: typeof legacy.friends_count === "number" ? legacy.friends_count : null
      };
    } catch (_) { return null; }
  }

  function viewerFromDom() {
    const out = { handle: "", name: "", avatar: "" };
    const sw = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (sw) {
      const img = sw.querySelector("img[src]");
      if (img) out.avatar = img.src;
      const lines = (sw.innerText || "").split("\n").map((x) => x.trim()).filter(Boolean);
      const h = lines.find((x) => x.startsWith("@"));
      const n = lines.find((x) => !x.startsWith("@"));
      if (h) out.handle = h.slice(1);
      if (n) out.name = n;
    }
    if (!out.handle) {
      const href = (document.querySelector('[data-testid="AppTabBar_Profile_Link"]') || {}).getAttribute?.("href") || "";
      if (/^\/[A-Za-z0-9_]{1,15}$/.test(href)) out.handle = href.slice(1);
    }
    return out;
  }

  async function whoami(deep) {
    const id = uid();
    if (!id) return { ok: true, signedIn: false };
    const dom = viewerFromDom();
    let v = (ops && ops.viewer && ops.viewer.id === id) ? ops.viewer : null;
    if (deep || !v || !v.handle) {
      try {
        const shell = await TX().shell();
        const st = shell && extractInitialState(shell.html);
        const fresh = viewerFrom(st);
        if (fresh && fresh.id === id) v = fresh;
      } catch (_) {}
    }
    return {
      ok: true, signedIn: true, id,
      handle: (v && v.handle) || dom.handle || "",
      name: (v && v.name) || dom.name || "",
      avatar: (v && v.avatar) || dom.avatar || "",
      followers: v ? v.followers : null,
      following: v ? v.following : null
    };
  }

  // ---------------------------------------------------------------------
  // Health check for the Help page. Read-only.
  // ---------------------------------------------------------------------
  async function health() {
    const out = { signedIn: !!uid(), csrf: !!csrf(), txid: null, ops: null, read: null };
    if (!out.signedIn) return out;
    try { await TX().init(false); out.txid = "ok"; }
    catch (e) { out.txid = String(e.message || e); }
    try {
      await discover(false);
      out.ops = Object.keys(ops.ops).join(", ") + (ops.bearer ? " (bearer from app)" : " (default bearer)");
    } catch (e) { out.ops = String(e.message || e); }
    try {
      const r = await listPage("Following", uid(), null, 1);
      const flags = r.users.length ? (r.users[0].fy === null ? "no relationship flag" : "relationship ok") : "empty";
      out.read = "ok via " + (ops.methods.Following || "GET") + ", " + flags;
    } catch (e) { out.read = (e.kind || "error") + ": " + (e.message || e); }
    // Can the Scanner read profile activity? Tried on your own account.
    try {
      const r = await lastPost(uid(), null);
      out.activity = r.state === "ok" ? "ok, last post " + new Date(r.t).toISOString().slice(0, 10)
        : r.state === "none" ? "ok, no posts yet" : "reachable, but no date: " + r.why;
    } catch (e) { out.activity = (e.kind || "error") + ": " + (e.message || e); }
    return out;
  }

  window.__X7_API = {
    uid, csrf, whoami, listPage, lastPost, unfollow, health, discover,
    _test: { parsePage, parseUser, findOp, extractInitialState, featureValuesFrom, classify, scanActivity }
  };
})();
