# X Mass Unfollow - anonymous usage tracker

A tiny, self-hosted analytics backend for the extension: a Cloudflare Worker
plus a D1 database and a private, password-protected dashboard. It answers the
questions you actually care about - how many people installed, how many are
still using it, where they are, what versions are out there, how many uninstall
and why - **without collecting anything that identifies a person.**

## What it stores

| Stored | Not stored / never received |
| --- | --- |
| A random install ID the extension makes up (not from the device or the user) | IP address |
| Extension version | X/Twitter username or account |
| Install / daily-active / uninstall events (timestamps) | Following list, whitelist, history |
| Aggregate unfollow count reported by active users | Email, name, device fingerprint |
| Coarse **country** (from Cloudflare's edge, not an IP lookup) | Anything that identifies a person |

The install ID is anonymous and resets whenever the user clears extension data.
Users can switch the whole thing off in **Settings -> Privacy**.

## Deploy (about 5 minutes, free tier)

**Dashboard way (no CLI):**

1. **Cloudflare dashboard -> Workers & Pages -> Create -> Worker.** Name it
   e.g. `x-mass-unfollow-tracker`. Deploy the starter, then **Edit code**,
   delete the sample, paste all of `worker.js`, and **Deploy**.
2. **Storage & Databases -> D1 -> Create database** (e.g. `unfollow_stats`).
3. Back on the Worker: **Settings -> Bindings -> Add -> D1 database.** Set the
   **Variable name** to exactly `DB` and pick the database. Save.
4. **Settings -> Variables and Secrets -> Add -> Secret.** Name
   `ADMIN_PASSWORD`, value = a strong password. (Optional secret
   `RETENTION_DAYS`, default `400`, to prune raw events.) Save.
5. **Settings -> Triggers -> Cron Triggers -> Add** `0 3 * * *` so old raw
   events are pruned daily. (Optional - the dashboard works without it.)
6. Your Worker URL is shown at the top, e.g.
   `https://x-mass-unfollow-tracker.<your-subdomain>.workers.dev`.

**CLI way (Wrangler):** `npx wrangler d1 create unfollow_stats`, add the binding
to `wrangler.toml` as `DB`, `npx wrangler secret put ADMIN_PASSWORD`, then
`npx wrangler deploy worker.js`.

## Point the extension at it

Open `shared/telemetry.js` in the extension and set the one constant:

```js
const ENDPOINT = "https://x-mass-unfollow-tracker.<your-subdomain>.workers.dev";
```

The shipped `manifest.json` already allows `https://*.workers.dev` in its
`connect-src`, so any `workers.dev` URL works with no other change. If you map
the Worker to a **custom domain** instead (e.g. `https://t.yourdomain.com`), add
that exact origin to `connect-src` in `manifest.json`.

Rebuild the zip and upload the new version. That's it - data starts flowing as
people install and use it.

## See the data

Open `https://<your-worker-url>/admin`. The browser asks for a username and
password: leave the username blank (or type anything) and enter your
`ADMIN_PASSWORD`. The dashboard shows live installs, DAU/WAU/MAU, installs vs
uninstalls over time, unfollows per day, country and version breakdowns, and
uninstall reasons. Pick the date range at the top.

## Endpoints

| Route | Who calls it |
| --- | --- |
| `POST /e` | the extension (anonymous events) |
| `GET /bye` | Chrome, when someone uninstalls (the extension's uninstall URL) |
| `POST /bye` | the uninstall feedback form |
| `GET /admin` | you (password-protected dashboard) |

## Keep it honest

This backend matches what the extension's `PRIVACY_POLICY.md` and the store
listing's data-usage answers say. If you change what it collects, update both,
or the Chrome Web Store can remove the extension for an inaccurate disclosure.
Don't add IP, username, or any per-person field here - that's the line that
keeps this compliant.
