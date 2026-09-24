// X Unfollow Manager Pro - graphql.js (v6.15.0)
//
// Reads the COMPLETE following list through the same internal endpoint X's own
// web app uses, instead of scrolling the page and reading the DOM.
//
// Why this exists
// ---------------
// Every hard bug in this extension's history came from reading the list by
// scrolling: X virtualizes rows (they are deleted from the DOM once off
// screen), so page height and row count go flat while hundreds of accounts
// remain, and X only paginates so deep per page load. Cursor pagination has
// neither problem - it walks the entire list in seconds and returns a
// `followed_by` flag per account, which is authoritative in a way that
// sniffing a "Follows you" badge out of the DOM never is.
//
// Credentials
// -----------
// This runs in the content script, on x.com, using the session the user is
// already signed into. Nothing is sent anywhere except x.com itself, and no
// token ever leaves the browser. That is the whole reason to do it here
// rather than through a third-party API: unfollowing (and reading a private
// following list) requires acting AS the account owner, so any external
// service offering it would need the user's session cookies handed over -
// which is account-takeover capability, not an API integration.
//
// Fragility, and what is done about it
// ------------------------------------
// This is an undocumented internal API. Three things rotate, and each is
// resolved at runtime rather than hardcoded:
//   * the bearer token       -> scraped from the app's JS bundles
//   * the operation query id -> scraped from the app's JS bundles
//   * the `features` object  -> X rejects a call that omits a flag it wants,
//                               and names the missing flag in the error. That
//                               error is parsed and the flag added, so the
//                               call heals itself instead of breaking.
// If any of it fails, scan() throws and the caller falls back to the DOM
// path, so a rotated hash degrades to the old behaviour instead of breaking
// the extension.

(function () {
  "use strict";

  const GQL = {};

  // ---------------------------------------------------------------
  // Session values
  // ---------------------------------------------------------------
  function cookie(name) {
    const m = document.cookie.match(new RegExp("(^|;\\s*)" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[2]) : null;
  }

  // The signed-in user's numeric id lives in the `twid` cookie as `u=<id>`.
  function ownUserId() {
    const raw = cookie("twid");
    if (!raw) return null;
    const m = String(raw).match(/\d+/);
    return m ? m[0] : null;
  }

  function csrfToken() {
    return cookie("ct0");
  }

  // ---------------------------------------------------------------
  // Bearer token + query id, scraped from the app's own JS bundles.
  //
  // Cached in sessionStorage: the bundles are large, and a scan should not
  // re-download them for every page load.
  // ---------------------------------------------------------------
  const CACHE_KEY = "xump-gql-cache";

  function readCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return {};
      const c = JSON.parse(raw);
      // A day is long enough to be useful, short enough that a rotated hash
      // is picked up without the user having to do anything.
      if (Date.now() - (c.ts || 0) > 86400000) return {};
      return c;
    } catch (_) { return {}; }
  }

  function writeCache(patch) {
    try {
      const c = { ...readCache(), ...patch, ts: Date.now() };
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(c));
    } catch (_) {}
  }

  // Collect candidate bundle URLs from the loaded document.
  function bundleUrls() {
    const urls = new Set();
    document.querySelectorAll("script[src]").forEach((s) => {
      const u = s.src || "";
      if (/abs\.twimg\.com|\/responsive-web\/|client-web/.test(u)) urls.add(u);
    });
    document.querySelectorAll("link[href]").forEach((l) => {
      const u = l.href || "";
      if (/abs\.twimg\.com.*\.js($|\?)/.test(u)) urls.add(u);
    });
    return [...urls];
  }

  async function fetchText(url) {
    // Bundles live on abs.twimg.com, which is cross-origin from x.com. A
    // content-script fetch would be blocked by CORS, so this goes through the
    // background worker, which holds the host permission.
    const res = await chrome.runtime.sendMessage({ action: "FETCH_TEXT", url });
    if (!res || !res.ok) throw new Error(res?.error || "bundle fetch failed");
    return res.text;
  }

  // X's public web bearer is a long constant embedded in the bundles.
  const BEARER_RE = /(AAAAAAAAA[A-Za-z0-9%\-_]{60,})/;

  async function resolveBearer() {
    const cached = readCache().bearer;
    if (cached) return cached;

    for (const url of bundleUrls()) {
      try {
        const txt = await fetchText(url);
        const m = txt.match(BEARER_RE);
        if (m) {
          const bearer = "Bearer " + m[1];
          writeCache({ bearer });
          return bearer;
        }
      } catch (_) { /* try the next bundle */ }
    }
    throw new Error("Could not read the API token from this page. Reload x.com and try again.");
  }

  // Query ids appear beside their operation name in the bundles, in either
  // order depending on how the chunk was minified.
  function findQueryId(txt, opName) {
    const a = new RegExp(
      'queryId:"([A-Za-z0-9_\\-]{10,})"[^}]{0,120}?operationName:"' + opName + '"');
    const b = new RegExp(
      'operationName:"' + opName + '"[^}]{0,120}?queryId:"([A-Za-z0-9_\\-]{10,})"');
    return (txt.match(a) || txt.match(b) || [])[1] || null;
  }

  async function resolveQueryId(opName) {
    const key = "qid_" + opName;
    const cached = readCache()[key];
    if (cached) return cached;

    for (const url of bundleUrls()) {
      try {
        const txt = await fetchText(url);
        const id = findQueryId(txt, opName);
        if (id) { writeCache({ [key]: id }); return id; }
      } catch (_) { /* try the next bundle */ }
    }
    throw new Error("Could not locate the " + opName + " query. X may have changed its app.");
  }

  // ---------------------------------------------------------------
  // Feature flags.
  //
  // X rejects a request that omits a feature flag it expects, and helpfully
  // names it. Rather than hardcoding a list that goes stale, start with the
  // known set and let the error response teach us the rest.
  // ---------------------------------------------------------------
  const BASE_FEATURES = {
    rweb_video_screen_enabled: false,
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
    responsive_web_jetfuel_frame: false,
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
    responsive_web_enhance_cards_enabled: false
  };

  // "The following features cannot be null: foo,bar" -> ["foo","bar"]
  function missingFeatures(errText) {
    const m = String(errText).match(/features cannot be null:?\s*([A-Za-z0-9_,\s]+)/i);
    if (!m) return [];
    return m[1].split(",").map((s) => s.trim()).filter(Boolean);
  }

  // ---------------------------------------------------------------
  // Response parsing
  // ---------------------------------------------------------------
  function walkEntries(json) {
    // The timeline shape has moved around between versions, so probe the
    // known locations rather than assuming one.
    const roots = [
      json?.data?.user?.result?.timeline?.timeline?.instructions,
      json?.data?.user?.result?.timeline_v2?.timeline?.instructions,
      json?.data?.user?.result?.timeline?.instructions
    ].filter(Array.isArray);
    const out = [];
    for (const instructions of roots) {
      for (const ins of instructions) {
        if (Array.isArray(ins.entries)) out.push(...ins.entries);
        if (ins.entry) out.push(ins.entry);
      }
    }
    return out;
  }

  function parsePage(json) {
    const users = [];
    let cursor = null;

    for (const entry of walkEntries(json)) {
      const id = entry?.entryId || "";

      if (id.startsWith("cursor-bottom")) {
        cursor = entry?.content?.value || null;
        continue;
      }

      const result =
        entry?.content?.itemContent?.user_results?.result ||
        entry?.item?.itemContent?.user_results?.result;
      if (!result) continue;

      // `core` is the newer shape; `legacy` the older. Read both.
      const legacy = result.legacy || {};
      const core   = result.core   || {};
      const handle = core.screen_name || legacy.screen_name;
      if (!handle) continue;

      const rel = result.relationship_perspectives || {};

      users.push({
        userId:      result.rest_id || legacy.id_str || null,
        handle,
        name:        core.name || legacy.name || "",
        followsYou:  !!(rel.followed_by ?? legacy.followed_by),
        following:   !!(rel.following  ?? legacy.following ?? true),
        verified:    !!(result.is_blue_verified || legacy.verified),
        isProtected: !!(legacy.protected || result.privacy?.protected),
        followers:   legacy.followers_count ?? null,
        friends:     legacy.friends_count ?? null,
        statuses:    legacy.statuses_count ?? null,
        lastTweetAt: legacy.status?.created_at || null,
        bio:         legacy.description || ""
      });
    }

    return { users, cursor };
  }

  // ---------------------------------------------------------------
  // One page of the Following timeline
  // ---------------------------------------------------------------
  async function fetchPage({ userId, cursor, bearer, queryId, features }) {
    const variables = {
      userId,
      count: 100,                 // X caps this well below what it accepts
      includePromotedContent: false
    };
    if (cursor) variables.cursor = cursor;

    const url = "https://" + location.hostname + "/i/api/graphql/" + queryId +
      "/Following?variables=" + encodeURIComponent(JSON.stringify(variables)) +
      "&features=" + encodeURIComponent(JSON.stringify(features));

    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        "authorization": bearer,
        "x-csrf-token": csrfToken() || "",
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-active-user": "yes",
        "x-twitter-client-language": "en",
        "content-type": "application/json"
      }
    });

    if (res.status === 429) {
      const reset = Number(res.headers.get("x-rate-limit-reset") || 0) * 1000;
      const waitMs = reset ? Math.max(0, reset - Date.now()) : 60000;
      const e = new Error("rate-limited");
      e.rateLimited = true;
      e.waitMs = waitMs;
      throw e;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("X refused the request. Reload x.com so the session refreshes, then try again.");
    }

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); }
    catch (_) { throw new Error("Unreadable response from X."); }

    if (json.errors && json.errors.length) {
      const msg = json.errors.map((e) => e.message).join("; ");
      const missing = missingFeatures(msg);
      if (missing.length) {
        const e = new Error("missing-features");
        e.missingFeatures = missing;
        throw e;
      }
      throw new Error(msg.slice(0, 200));
    }

    return parsePage(json);
  }

  // ---------------------------------------------------------------
  // Public: scan the whole following list
  //
  // onProgress({ scanned, nonFollowers, page }) is called after each page so
  // the UI can count up live. Returns the full account list; filtering to
  // non-followers is the caller's job.
  // ---------------------------------------------------------------
  // limit: stop after this many accounts have been read (0 = whole list).
  GQL.scan = async function scan({ onProgress, shouldStop, limit } = {}) {
    // limit caps how many accounts to read. 0 or undefined means the whole
    // list. Useful on very large accounts, where a full read takes a while
    // and brushes closer to X's read rate limits.
    const cap = Number(limit) > 0 ? Number(limit) : Infinity;

    const userId = ownUserId();
    if (!userId) throw new Error("Not signed in to X on this tab.");
    if (!csrfToken()) throw new Error("Missing session token. Reload x.com and try again.");

    const bearer  = await resolveBearer();
    const queryId = await resolveQueryId("Following");

    let features = { ...BASE_FEATURES };
    const all = [];
    const seen = new Set();
    let cursor = null;
    let page = 0;

    // Hard ceiling. 400 pages x 100 accounts is far beyond any real following
    // list and guarantees a malformed cursor cannot spin forever.
    while (page < 400) {
      if (shouldStop && shouldStop()) break;

      let result;
      try {
        result = await fetchPage({ userId, cursor, bearer, queryId, features });
      } catch (e) {
        if (e.missingFeatures) {
          // Teach ourselves the flags X wants and retry the same page.
          for (const f of e.missingFeatures) features[f] = false;
          continue;
        }
        if (e.rateLimited) {
          // Surface it rather than silently stalling; the caller decides.
          const err = new Error(
            "X rate-limited the scan after " + all.length +
            " accounts. Wait about " + Math.ceil(e.waitMs / 60000) +
            " min and scan again - progress so far is kept.");
          err.partial = all;
          throw err;
        }
        throw e;
      }

      page++;

      let added = 0;
      for (const u of result.users) {
        const key = u.userId || u.handle;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(u);
        added++;
      }

      if (onProgress) {
        onProgress({
          scanned: all.length,
          nonFollowers: all.filter((u) => !u.followsYou).length,
          page
        });
      }

      // Stop at the user's scan limit. Checked after the page is merged so
      // the limit is a floor, not a hard truncation mid-page.
      if (limit && all.length >= limit) break;

      // Stop at the user's cap, if they set one.
      if (all.length >= cap) {
        all.length = Math.min(all.length, cap);
        break;
      }

      // Done when X stops giving a cursor, or a page adds nobody new.
      if (!result.cursor || added === 0) break;
      cursor = result.cursor;

      // Gentle spacing. This is far below what the web app itself does while
      // a user scrolls, but there is no reason to be the fastest client X
      // has ever seen.
      await new Promise((r) => setTimeout(r, 900));
    }

    return all;
  };

  GQL.available = function () {
    return !!(ownUserId() && csrfToken());
  };

  // ---------------------------------------------------------------
  // Unfollow one account.
  //
  // This is the exact request X's own Unfollow button fires: same endpoint,
  // same session, same headers. Nothing about it is a back door - the only
  // thing this code controls is the pacing between calls, which is where
  // account safety actually lives.
  //
  // Returns { ok } or throws. A 429 carries waitMs so the caller can rest
  // rather than hammer.
  // ---------------------------------------------------------------
  GQL.unfollow = async function unfollow(userId) {
    if (!userId) throw new Error("no user id");
    const body = new URLSearchParams({
      user_id: String(userId),
      include_profile_interstitial_type: "1",
      include_blocking: "1",
      skip_status: "1"
    });

    const res = await fetch(
      "https://" + location.hostname + "/i/api/1.1/friendships/destroy.json", {
        method: "POST",
        credentials: "include",
        headers: {
          "authorization": await resolveBearer(),
          "x-csrf-token": csrfToken() || "",
          "x-twitter-auth-type": "OAuth2Session",
          "x-twitter-active-user": "yes",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      });

    if (res.status === 429) {
      const reset = Number(res.headers.get("x-rate-limit-reset") || 0) * 1000;
      const e = new Error("rate-limited");
      e.rateLimited = true;
      e.waitMs = reset ? Math.max(0, reset - Date.now()) : 900000;
      throw e;
    }
    if (res.status === 401 || res.status === 403) {
      const e = new Error("challenge");
      e.challenge = true;
      throw e;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);

    const json = await res.json().catch(() => null);
    // X returns the user object. `following: false` confirms the unfollow;
    // some responses omit the flag entirely, in which case a 200 with an id
    // is the confirmation.
    if (json && json.id_str) return { ok: true, wasFollowing: json.following !== false };
    return { ok: true };
  };

  // Resolve a handle to a numeric id, for CSV rows that carry only a handle.
  GQL.resolveHandle = async function resolveHandle(handle) {
    const clean = String(handle || "").replace(/^@/, "").trim();
    if (!clean) return null;

    const queryId = await resolveQueryId("UserByScreenName");
    const url = "https://" + location.hostname + "/i/api/graphql/" + queryId +
      "/UserByScreenName?variables=" +
      encodeURIComponent(JSON.stringify({ screen_name: clean })) +
      "&features=" + encodeURIComponent(JSON.stringify({
        hidden_profile_subscriptions_enabled: true,
        profile_label_improvements_pcf_label_in_post_enabled: true,
        rweb_tipjar_consumption_enabled: true,
        verified_phone_label_enabled: false,
        subscriptions_verification_info_is_identity_verified_enabled: true,
        subscriptions_verification_info_verified_since_enabled: true,
        highlights_tweets_tab_ui_enabled: true,
        responsive_web_twitter_article_notes_tab_enabled: true,
        subscriptions_feature_can_gift_premium: true,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true
      }));

    const res = await fetch(url, {
      credentials: "include",
      headers: {
        "authorization": await resolveBearer(),
        "x-csrf-token": csrfToken() || "",
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-active-user": "yes",
        "content-type": "application/json"
      }
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return json?.data?.user?.result?.rest_id || null;
  };

  window.__XUMP_GQL = GQL;
})();
