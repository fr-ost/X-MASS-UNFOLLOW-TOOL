# X (Twitter) Mass Unfollow Tool – Free & Unlimited

Free & unlimited X (Twitter) mass unfollow tool. Bulk unfollow, clean your
following list, and remove non-followers with ease.

A product of **Unique Labs**. Developed by
**[Shahriar Ahmed](https://www.shahriarahmed.net)**.

## Features

- **One-click scan.** Reads your whole following list and marks who follows you back. Read-only.
- **Unfollow non-followers** in one click, or **unfollow everyone**.
- **Review and pick.** Full dashboard with search, filters (no photo, few posts, few followers, follow-spam, verified, private), sorting, multi-select and CSV export.
- **Whitelist.** Accounts on it are never unfollowed, in any mode. One tap on the shield in the review table.
- **Keep rules.** Keep verified accounts, private accounts, big accounts, or anyone whose name/bio matches a keyword.
- **Import a list.** Unfollow exactly the accounts in a CSV or a pasted list.
- **Safe pacing.** Safe / Balanced / Fast presets or custom numbers: random gaps, regular breaks, and a rolling 24-hour limit that continues automatically.
- **Backs off by itself.** If X says to slow down, the run rests and continues. If X asks you to verify your account, it stops and waits for you.
- **Works in the background.** Switch tabs, close the popup, minimise the window: the run keeps going.
- **History.** Everyone it unfollowed, with CSV export.
- **Light & dark mode.** Follows your system, or flip it with the sun/moon button.
- **Private.** Everything stays in your browser. No analytics. See [PRIVACY_POLICY.md](PRIVACY_POLICY.md).
- **Free forever.** No paid tier. A Donate page (crypto, with QR codes) and a Report-a-bug link are built in.
- **Emergency stop:** <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>.

## How it works

```
popup / dashboard  ──commands──▶  background.js (the engine)
                                     │  state, pacing, rests, retries,
                                     │  all in chrome.storage
                                     ▼
                         content/*.js in any x.com tab
                         (one request at a time, on request)
                                     │
                                     ▼
                     x.com - the same endpoints X's website uses
```

- **The engine lives in the service worker**, not in the page. A page script dies when its tab is hidden, frozen, reloaded or navigated, which is what made earlier versions stop after 20-30 accounts. The worker drives the run step by step and keeps all state in storage, so a killed worker or a reloaded tab picks up exactly where it left off.
- **Reading the list** uses X's own GraphQL `Following` timeline, page by page, with X's per-account "follows you" flag. The query id, feature flags, GET-vs-POST and the `x-client-transaction-id` header are all worked out at runtime from X's own app (`content/txid.js`, `content/xapi.js`). If X rejects that, the engine falls back to scrolling the Following page.
- **Unfollowing** sends the same `friendships/destroy` request X's Unfollow button sends. If X rejects direct requests, the engine switches to **profile mode**: it opens each profile in a background tab and presses Unfollow there.
- **Ads** (AdsOnBread SDK 1.2.0, vendored): a banner in the popup and a card in the dashboard sidebar. One ad per page, never injected into x.com.

## Project layout

| Path | What it is |
| --- | --- |
| `manifest.json` | Manifest V3 |
| `background.js` | The engine: scan, unfollow queue, pacing, tabs, badge, migration from v6 |
| `shared/config.js` | Storage keys, speed presets, settings normalisation, Keep rules |
| `content/txid.js` | `x-client-transaction-id` generator (port of the MIT-licensed x-client-transaction-id project) |
| `content/xapi.js` | X API client: query discovery, self-healing GraphQL reads, unfollow |
| `content/dom.js` | Fallbacks: profile-page unfollow, Following-page scroll scan |
| `content/content.js` | Message router in x.com tabs |
| `popup.*` | Toolbar popup |
| `dashboard.*` | Full dashboard (also the Settings page) |
| `ui/` | Shared design system (light/dark tokens), theme loader, helpers, logo |
| `ui/donate/` | Token logos and donation QR codes |
| `design/` | Icon source + renderer, QR builder, store-graphics builder (not shipped) |
| `store/` | Chrome Web Store screenshots and promo tiles (not shipped) |
| `STORE_LISTING.md` | Store title, summary, SEO description, privacy-tab answers |
| `ads.js`, `vendor/adsonbread-sdk.js` | Ads |
| `tests/e2e/` | End-to-end tests against a mock x.com (see its README) |

## Building the store package

Zip the extension files without `tests/`, the docs, or git data:

```sh
zip -r x-mass-unfollow-7.0.0.zip manifest.json background.js ads.js \
  popup.html popup.css popup.js dashboard.html dashboard.css dashboard.js \
  options.html options.js privacy.html icon16.png icon32.png icon48.png icon128.png \
  content shared ui vendor -x "*.DS_Store"
```

## Rebuilding the graphics

```sh
export PLAYWRIGHT=/path/to/node_modules/playwright
node design/build-icons.mjs        # icon16/32/48/128.png + ui/logo.svg
python3 design/build-qr.py         # donation QR codes (verified by decoding)
node design/store-assets.mjs       # store/ screenshots and promo tiles
```

## Support

Report a bug or ask a question on Telegram: [@igfrostt](https://t.me/igfrostt)
