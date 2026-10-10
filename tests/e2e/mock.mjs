// Mock of the parts of x.com / abs.twimg.com the extension talks to.
// Strict where X is strict: GraphQL Following requires POST (Aug 2026 change)
// and a valid x-client-transaction-id (verified with an
// animation key computed by the independent Python reference implementation).
import https from "https";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(fs.readFileSync(path.join(DIR, "assets.json"), "utf8"));
const BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const FOLLOWING_FEATURES = ["rweb_video_screen_enabled", "profile_label_improvements_pcf_label_in_post_enabled", "responsive_web_graphql_timeline_navigation_enabled", "verified_phone_label_enabled"];

export function createMock(opts = {}) {
  const M = {
    cfg: {
      requirePost: true, requireTxid: true, followingDown: false, followersDown: false,
      destroyMode: "ok", destroy429At: 0, destroyRequireTxid: true,
      pageSize: 40, noRelFlags: false, hiddenFeature: true, rateOnCall: 0,
      actDown: false, actRateAt: 0
    },
    owner: opts.owner || { id: "1000", handle: "tester", name: "Test Person" },
    users: [],
    following: new Set(),
    log: { gql: [], gqlBad: [], destroy: [], ui: [], txOk: 0, txBad: [], shell: 0, bundles: 0, trk: [], trkEvents: [], trkBye: [], act: [] },
    counters: { gql: 0, destroy: 0, act: 0 }
  };

  const N = opts.users ? 0 : (opts.n || 230);
  for (const u of opts.users || []) { M.users.push(u); M.following.add(u.id); }
  for (let i = 0; i < N; i++) {
    const id = String(2000 + i);
    M.users.push({
      id, h: "acct_" + i, n: "Account " + i,
      fy: i % 9 !== 0,
      v: i % 10 === 3, p: i % 17 === 5, d: i % 13 === 0,
      fc: (i * 37) % 5000, fr: i % 23 === 0 ? 4000 : (i * 11) % 900, sc: i % 50,
      ca: new Date(Date.UTC(2010 + (i % 15), i % 12, 1)).toUTCString(),
      b: i % 4 === 0 ? "Founder at a startup. Coffee." : "Just a test account #" + i
    });
    M.following.add(id);
  }
  M.byId = new Map(M.users.map((u) => [u.id, u]));
  M.byHandle = new Map(M.users.map((u) => [u.h.toLowerCase(), u]));

  function verifyTx(method, p, tx) {
    if (!tx) return "missing";
    const b = Buffer.from(tx + "=".repeat((4 - (tx.length % 4)) % 4), "base64");
    const r = b[0];
    const bytes = [...b.subarray(1)].map((x) => x ^ r);
    const kb = [...Buffer.from(A.key, "base64")];
    if (bytes.length !== kb.length + 21) return "len";
    for (let i = 0; i < kb.length; i++) if (bytes[i] !== kb[i]) return "key";
    const o = kb.length;
    const t = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
    const now = Math.floor((Date.now() - 1682924400 * 1000) / 1000);
    if (Math.abs(now - t) > 120) return "time";
    const h = crypto.createHash("sha256").update(`${method}!${p}!${t}obfiowerehiring${A.animationKey}`).digest();
    for (let k = 0; k < 16; k++) if (bytes[o + 4 + k] !== h[k]) return "hash";
    if (bytes[o + 20] !== 3) return "tail";
    return null;
  }

  function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || "").split(/;\s*/)) {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
    }
    return out;
  }

  function authed(req) {
    const c = cookies(req);
    return c.auth_token && c.ct0 && req.headers["x-csrf-token"] === c.ct0 && req.headers.authorization === "Bearer " + BEARER;
  }

  function userResult(u) {
    const r = {
      __typename: "User", rest_id: u.id, is_blue_verified: u.bv !== undefined ? u.bv : u.v,
      core: { created_at: u.ca, name: u.n, screen_name: u.h },
      avatar: { image_url: u.d ? "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png" : `https://pbs.twimg.com/profile_images/${u.id}/a_normal.jpg` },
      legacy: Object.assign({ default_profile_image: u.d, description: u.b, followers_count: u.fc, friends_count: u.fr, statuses_count: u.sc }, u.bv === false && u.v ? { verified: true } : {}),
      privacy: { protected: u.p }
    };
    if (M.cfg.omitFalse) r.relationship_perspectives = Object.assign({ following: true }, u.fy ? { followed_by: true } : {});
    else if (!M.cfg.noRelFlags) r.relationship_perspectives = { following: M.following.has(u.id), followed_by: u.fy };
    return r;
  }

  function timeline(list, offset, count) {
    const page = list.slice(offset, offset + count);
    const end = offset + page.length >= list.length;
    const entries = page.map((u) => ({
      entryId: "user-" + u.id, sortIndex: String(9e15 - offset),
      content: { entryType: "TimelineTimelineItem", __typename: "TimelineTimelineItem",
        itemContent: { itemType: "TimelineUser", __typename: "TimelineUser", user_results: { result: userResult(u) }, userDisplayType: "User" } }
    }));
    entries.push({ entryId: "cursor-bottom-" + offset, content: { entryType: "TimelineTimelineCursor", __typename: "TimelineTimelineCursor", value: end ? "0|end" + offset : "c:" + (offset + page.length), cursorType: "Bottom" } });
    entries.push({ entryId: "cursor-top-" + offset, content: { entryType: "TimelineTimelineCursor", __typename: "TimelineTimelineCursor", value: "-1|top", cursorType: "Top" } });
    return { data: { user: { result: { __typename: "User", timeline: { timeline: { instructions: [{ type: "TimelineClearCache" }, { type: "TimelineAddEntries", entries }] } } } } } };
  }

  // ---- posts-and-replies timeline (the Scanner's last-active check) ----
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p2 = (n) => String(n).padStart(2, "0");
  // X's own format: "Wed Oct 10 20:19:24 +0000 2018"
  function xDate(ts) {
    const d = new Date(ts);
    return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000 ${d.getUTCFullYear()}`;
  }
  let tweetSeq = 0;
  const snowflake = (ts) => String(((BigInt(Math.floor(ts)) - BigInt(1288834974657)) << BigInt(22)) | BigInt(++tweetSeq & 0xfff));
  function tweetResult(authorId, ts, noDate) {
    const id = snowflake(ts);
    const legacy = { user_id_str: String(authorId), full_text: "post " + id };
    if (!noDate) legacy.created_at = xDate(ts);
    return { __typename: "Tweet", rest_id: id, core: { user_results: { result: { __typename: "User", rest_id: String(authorId) } } }, legacy };
  }
  const tweetItem = (authorId, ts, noDate) => ({ itemContent: { itemType: "TimelineTweet", __typename: "TimelineTweet", tweet_results: { result: tweetResult(authorId, ts, noDate) } } });
  const tweetEntry = (authorId, ts, noDate) => ({
    entryId: "tweet-" + (++tweetSeq), content: Object.assign({ entryType: "TimelineTimelineItem", __typename: "TimelineTimelineItem" }, tweetItem(authorId, ts, noDate))
  });

  function postsTimeline(u, userId) {
    const day = 864e5;
    if (!u) {
      // The owner (health check) has a recent post; anyone else the mock doesn't know is unavailable.
      if (String(userId) === M.owner.id) u = { id: M.owner.id, last: Date.now() - day };
      else return { data: { user: { result: { __typename: "UserUnavailable", reason: "NotFound" } } } };
    }
    if (u.act === "suspended") return { data: { user: { result: { __typename: "UserUnavailable", reason: "Suspended" } } } };
    const ins = [{ type: "TimelineClearCache" }];
    // A pinned post is old by design; if it were counted it would hide real inactivity.
    if (u.pin) ins.push({ type: "TimelinePinEntry", entry: tweetEntry(u.id, Date.now() - day, u.noCreatedAt) });
    const entries = [];
    if (u.act === "protected") {
      entries.push({ entryId: "tweet-tombstone", content: { entryType: "TimelineTimelineItem", itemContent: { itemType: "TimelineTombstone", __typename: "TimelineTombstone", text: { text: "These posts are protected" } } } });
    } else if (u.act !== "empty" && u.last) {
      if (!u.repliesOnly) {
        entries.push(tweetEntry(u.id, u.last, u.noCreatedAt), tweetEntry(u.id, u.last - 3 * day, u.noCreatedAt), tweetEntry(u.id, u.last - 40 * day, u.noCreatedAt));
      }
      // A reply thread: someone else's recent post, then this account's reply.
      const replyAt = u.repliesOnly ? u.last : u.last - 5 * day;
      entries.push({
        entryId: "profile-conversation-" + (++tweetSeq),
        content: { entryType: "TimelineTimelineModule", __typename: "TimelineTimelineModule", items: [
          { entryId: "c-a", item: tweetItem("999999", Date.now() - 3600e3, false) },
          { entryId: "c-b", item: tweetItem(u.id, replyAt, u.noCreatedAt) }
        ] }
      });
    }
    entries.push({ entryId: "cursor-bottom-1", content: { entryType: "TimelineTimelineCursor", __typename: "TimelineTimelineCursor", value: "0|end", cursorType: "Bottom" } });
    ins.push({ type: "TimelineAddEntries", entries });
    return { data: { user: { result: { __typename: "User", rest_id: String(userId), timeline: { timeline: { instructions: ins } } } } } };
  }

  function send(res, status, body, headers) {
    const h = Object.assign({ "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json" }, headers || {});
    res.writeHead(status, h);
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }

  function shellHtml() {
    const state = {
      featureSwitch: { defaultConfig: Object.fromEntries(FOLLOWING_FEATURES.map((f) => [f, { value: f !== "verified_phone_label_enabled" }])) },
      session: { user_id: M.owner.id },
      entities: { users: { entities: { [M.owner.id]: { id_str: M.owner.id, screen_name: M.owner.handle, name: M.owner.name, profile_image_url_https: "https://pbs.twimg.com/profile_images/1000/me_normal.jpg", followers_count: 321, friends_count: M.following.size } } } }
    };
    const runtime = opts.oldRuntime
      ? `!function(){var x={20113:"ondemand.s",4100:"bundle.Foo"},y={4100:"aaaa1111",20113:"${A.hash}"};}()`
      : `!function(){var n={};n.u=e=>(({20113:"ondemand.s",4100:"bundle.Foo"})[e]||e)+"."+({4100:"aaaa",20113:"${A.hash}"})[e]+"a.js";}()`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="twitter-site-verification" content="${A.key}"/>
<title>Home / X</title>
<script>window.__INITIAL_STATE__=${JSON.stringify(state)};window.__META_DATA__={"env":"prod"};</script>
<style>body{font-family:sans-serif;margin:0} nav{position:fixed;left:0;top:0;width:220px;padding:16px} main{margin-left:240px;padding:16px;min-height:2000px}</style>
</head><body>${A.framesHtml}
<div id="react-root"><nav><div data-testid="SideNav_AccountSwitcher_Button"><img src="https://pbs.twimg.com/profile_images/1000/me_normal.jpg" width="32"><div><div>${M.owner.name}</div><div>@${M.owner.handle}</div></div></div>
<a data-testid="AppTabBar_Profile_Link" href="/${M.owner.handle}">Profile</a></nav><main data-testid="primaryColumn"><h1>Home</h1><p>Mock X timeline.</p></main></div>
<script>${runtime}</script>
<script src="https://abs.twimg.com/responsive-web/client-web/main.abc123.js"></script>
</body></html>`;
  }

  function bundleJs() {
    const fs1 = FOLLOWING_FEATURES.map((f) => `"${f}"`).join(",");
    return `(function(){var e={exports:{}};var BEARER="${BEARER}";
e.exports={queryId:"QfollowingAAA111",operationName:"Following",operationType:"query",metadata:{featureSwitches:[${fs1}],fieldToggles:["withAuxiliaryUserLabels"]}};
e.exports={queryId:"QfollowersBBB222",operationName:"Followers",operationType:"query",metadata:{featureSwitches:[${fs1}],fieldToggles:[]}};
e.exports={queryId:"QotherCCC333",operationName:"FollowingTimelineX",operationType:"query",metadata:{featureSwitches:[],fieldToggles:[]}};
e.exports={queryId:"QutrCCC444",operationName:"UserTweetsAndReplies",operationType:"query",metadata:{featureSwitches:[${fs1}],fieldToggles:["withArticlePlainText"]}};
})();`;
  }

  function profileHtml(u) {
    const following = M.following.has(u.id);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${u.n} (@${u.h}) / X</title></head><body>
<div data-testid="primaryColumn"><h2>${u.n}</h2><div>@${u.h}</div><div id="ctl"></div>
<section><h3>You might like</h3><div data-testid="UserCell"><button data-testid="999-unfollow">Following</button></div></section></div>
<script>
let following=${following};const id="${u.id}";
function render(){document.getElementById("ctl").innerHTML=following?'<button data-testid="'+id+'-unfollow">Following</button>':'<button data-testid="'+id+'-follow">Follow</button>';}
setTimeout(render,500);
document.addEventListener("click",async(e)=>{const b=e.target.closest("[data-testid]");if(!b)return;const t=b.dataset.testid;
if(t===id+"-unfollow"){const d=document.createElement("div");d.setAttribute("role","dialog");d.innerHTML='<div data-testid="confirmationSheetDialog"><b>Unfollow @${u.h}?</b><button data-testid="confirmationSheetConfirm">Unfollow</button><button data-testid="confirmationSheetCancel">Cancel</button></div>';document.body.appendChild(d);}
if(t==="confirmationSheetConfirm"){await fetch("/__mock/ui-unfollow",{method:"POST",body:id});following=false;b.closest('[role="dialog"]').remove();render();}
if(t==="confirmationSheetCancel"){b.closest('[role="dialog"]').remove();}
});
</script></body></html>`;
  }

  function followingPageHtml() {
    const list = M.users.filter((u) => M.following.has(u.id));
    const cells = list.map((u) => `<div data-testid="cellInnerDiv"><div data-testid="UserCell" style="height:90px;border-bottom:1px solid #eee;display:flex;gap:8px">
<a href="/${u.h}"><img src="${u.d ? "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png" : "https://pbs.twimg.com/profile_images/" + u.id + "/a_normal.jpg"}" width="40"></a>
<div><a href="/${u.h}"><span>${u.n}</span></a>${u.v ? '<svg data-testid="icon-verified"></svg>' : ""}${u.p ? '<svg data-testid="icon-lock"></svg>' : ""}
<div><span>@${u.h}</span>${u.fy ? '<div data-testid="userFollowIndicator"><span>Follows you</span></div>' : ""}</div><div>${u.b}</div></div>
<button data-testid="${u.id}-unfollow">Following</button></div></div>`);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>People followed by ${M.owner.name}</title></head><body style="margin:0">
<div data-testid="primaryColumn"><h2>Following</h2><div id="list"></div><div id="spin" role="progressbar" hidden>...</div></div>
<script>
const cells=${JSON.stringify(cells)};let shown=0;
function more(){const next=cells.slice(shown,shown+20);document.getElementById("list").insertAdjacentHTML("beforeend",next.join(""));shown+=next.length;}
more();
let loading=false;
window.addEventListener("scroll",()=>{if(loading||shown>=cells.length)return;if(window.scrollY+innerHeight>=document.documentElement.scrollHeight-300){loading=true;setTimeout(()=>{more();loading=false;},300);}});
</script></body></html>`;
  }

  async function body(req) {
    return new Promise((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => resolve(b));
    });
  }

  async function handle(req, res) {
    const host = String(req.headers.host || "").split(":")[0];
    const url = new URL(req.url, "https://" + host);
    const p = url.pathname;

    // Anonymous usage tracker (stands in for the Cloudflare Worker).
    if (host === "unfollow.shahriarahmed614.workers.dev") {
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS" };
      if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
      if (p === "/e") {
        let j = {};
        try { j = JSON.parse(await body(req)); } catch (_) {}
        M.log.trk.push(j);
        (j.e || []).forEach((e) => M.log.trkEvents.push(Object.assign({ i: j.i, v: j.v }, e)));
        return send(res, 200, { ok: true }, cors);
      }
      if (p === "/bye") { M.log.trkBye.push(url.search); return send(res, 200, { ok: true }, cors); }
      return send(res, 404, { error: "nf" }, cors);
    }

    if (host === "pbs.twimg.com" || (host === "abs.twimg.com" && p.startsWith("/sticky/"))) {
      const hue = [...p].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
      const idm = p.match(/profile_images\/(\d+)\//);
      const who = idm && (M.byId.get(idm[1]) || (idm[1] === M.owner.id ? { n: M.owner.name } : null));
      if (who && opts.initialsAvatars) {
        const ini = String(who.n).split(/\s+/).map((w) => w[0] || "").join("").slice(0, 2).toUpperCase();
        res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=3600" });
        return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},75%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},70%,48%)"/></linearGradient></defs><rect width="96" height="96" fill="url(#a)"/><text x="48" y="58" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="34" font-weight="700" fill="#fff" text-anchor="middle">${ini}</text></svg>`);
      }
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=3600" });
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="hsl(${hue},55%,62%)"/><circle cx="48" cy="38" r="18" fill="rgba(255,255,255,.85)"/><rect x="18" y="62" width="60" height="40" rx="20" fill="rgba(255,255,255,.85)"/></svg>`);
    }

    if (host === "abs.twimg.com") {
      if (p === "/responsive-web/client-web/main.abc123.js") { M.log.bundles++; res.writeHead(200, { "content-type": "application/javascript" }); return res.end(bundleJs()); }
      if (p === `/responsive-web/client-web/ondemand.s.${A.hash}a.js`) { res.writeHead(200, { "content-type": "application/javascript" }); return res.end(A.ondemand); }
      return send(res, 404, "nf");
    }

    // ---- x.com ----
    if (p === "/home" || p === "/i/jf/" || p === "/") { M.log.shell++; return send(res, 200, shellHtml()); }
    if (p === "/favicon.ico") return send(res, 404, "");

    const gm = p.match(/^\/i\/api\/graphql\/([^/]+)\/(Following|Followers|UserTweetsAndReplies)$/);
    if (gm) {
      const [, qid, op] = gm;
      const isAct = op === "UserTweetsAndReplies";
      if (!isAct) M.counters.gql++;
      const rec = { method: req.method, op, t: Date.now() };
      if (isAct && M.cfg.actDown) { M.log.gqlBad.push({ ...rec, why: "actDown" }); res.writeHead(404); return res.end(); }
      if ((op === "Following" && M.cfg.followingDown) || (op === "Followers" && M.cfg.followersDown)) { M.log.gqlBad.push({ ...rec, why: "down" }); res.writeHead(404); return res.end(); }
      if (M.cfg.requirePost && req.method !== "POST") { M.log.gqlBad.push({ ...rec, why: "method" }); res.writeHead(404); return res.end(); }
      const txErr = verifyTx(req.method, p, req.headers["x-client-transaction-id"]);
      if (txErr) { M.log.txBad.push({ p, why: txErr }); }
      else M.log.txOk++;
      if (M.cfg.requireTxid && txErr) { M.log.gqlBad.push({ ...rec, why: "tx:" + txErr }); res.writeHead(404); return res.end(); }
      if (!authed(req)) return send(res, 401, { errors: [{ code: 32, message: "Could not authenticate you." }] });
      const expectQ = { Following: "QfollowingAAA111", Followers: "QfollowersBBB222", UserTweetsAndReplies: "QutrCCC444" }[op];
      if (qid !== expectQ) { M.log.gqlBad.push({ ...rec, why: "qid" }); return send(res, 400, { errors: [{ message: "Query: Unspecified" }] }); }
      let variables, features;
      if (req.method === "POST") { const j = JSON.parse(await body(req)); variables = j.variables; features = j.features; }
      else { variables = JSON.parse(url.searchParams.get("variables")); features = JSON.parse(url.searchParams.get("features")); }
      const need = [...FOLLOWING_FEATURES, ...(M.cfg.hiddenFeature ? ["mock_hidden_flag"] : [])];
      const missing = need.filter((f) => !(f in (features || {})));
      if (missing.length) { M.log.gqlBad.push({ ...rec, why: "features" }); return send(res, 400, { errors: [{ message: "The following features cannot be null: " + missing.join(", ") }] }); }
      if (isAct) {
        M.counters.act++;
        if (M.cfg.actRateAt && M.counters.act === M.cfg.actRateAt) {
          return send(res, 429, { errors: [{ code: 88, message: "Rate limit exceeded" }] }, { "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 2) });
        }
        M.log.act.push({ ...rec, userId: String(variables.userId) });
        const target = M.byId.get(String(variables.userId));
        return send(res, 200, postsTimeline(target, variables.userId),
          { "x-rate-limit-remaining": "400", "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 900) });
      }
      if (M.cfg.rateOnCall && M.counters.gql === M.cfg.rateOnCall) {
        return send(res, 429, { errors: [{ code: 88, message: "Rate limit exceeded" }] }, { "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 2) });
      }
      if (M.cfg.maxCount && variables.count > M.cfg.maxCount) { M.log.gqlBad.push({ ...rec, why: "count" }); return send(res, 400, { errors: [{ message: "count must be <= " + M.cfg.maxCount }] }); }
      M.log.gql.push({ ...rec, cursor: variables.cursor || null, count: variables.count });
      const offset = variables.cursor && variables.cursor.startsWith("c:") ? Number(variables.cursor.slice(2)) : 0;
      const list = op === "Following"
        ? M.users.filter((u) => M.following.has(u.id))
        : M.users.filter((u) => u.fy);
      return send(res, 200, timeline(list, offset, Math.min(variables.count || 20, M.cfg.pageSize)),
        { "x-rate-limit-remaining": "400", "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 900) });
    }

    if (p === "/i/api/1.1/friendships/destroy.json") {
      M.counters.destroy++;
      const form = new URLSearchParams(await body(req));
      const txErr = verifyTx("POST", p, req.headers["x-client-transaction-id"]);
      if (txErr) M.log.txBad.push({ p, why: txErr }); else M.log.txOk++;
      if (M.cfg.destroyMode === "404") { res.writeHead(404); return res.end(); }
      if (M.cfg.destroyRequireTxid && txErr) { res.writeHead(404); return res.end(); }
      if (!authed(req)) return send(res, 401, { errors: [{ code: 32, message: "Could not authenticate you." }] });
      if (M.cfg.destroy429At && M.counters.destroy === M.cfg.destroy429At) {
        return send(res, 429, { errors: [{ code: 88, message: "Rate limit exceeded" }] }, { "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 2) });
      }
      if (M.cfg.destroyMode === "locked") return send(res, 403, { errors: [{ code: 326, message: "To protect our users from spam..." }] });
      let u = form.get("user_id") ? M.byId.get(form.get("user_id")) : M.byHandle.get(String(form.get("screen_name") || "").toLowerCase());
      if (!u) return send(res, 404, { errors: [{ code: 34, message: "Sorry, that page does not exist." }] });
      M.following.delete(u.id);
      M.log.destroy.push({ id: u.id, h: u.h, t: Date.now() });
      return send(res, 200, { id_str: u.id, screen_name: u.h, following: false });
    }

    if (p === "/__mock/ui-unfollow" && req.method === "POST") {
      const id = (await body(req)).trim();
      M.following.delete(id);
      M.log.ui.push({ id, t: Date.now() });
      return send(res, 200, { ok: true });
    }

    const fm = p.match(/^\/([A-Za-z0-9_]{1,15})\/following\/?$/);
    if (fm) return send(res, 200, followingPageHtml());
    const pm = p.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    if (pm) {
      const u = M.byHandle.get(pm[1].toLowerCase());
      if (!u) return send(res, 200, `<html><body><div data-testid="primaryColumn"><div data-testid="empty_state_header_text">This account doesn't exist</div></div></body></html>`);
      return send(res, 200, profileHtml(u));
    }
    return send(res, 404, "not found");
  }

  M.start = (port) => new Promise((resolve) => {
    M.server = https.createServer({ key: fs.readFileSync(path.join(DIR, "key.pem")), cert: fs.readFileSync(path.join(DIR, "cert.pem")) },
      (req, res) => handle(req, res).catch((e) => { console.error("mock error", e); try { res.writeHead(500); res.end(); } catch (_) {} }));
    M.server.listen(port || 443, "127.0.0.1", resolve);
  });
  M.stop = () => new Promise((r) => M.server.close(r));
  return M;
}
