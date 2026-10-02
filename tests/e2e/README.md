# End-to-end tests

Runs the real unpacked extension in Chromium against a mock of x.com.

The mock is strict in the same places X is: the Following timeline needs
POST, a valid `x-client-transaction-id` header, and every feature flag it
asks for. The transaction-id check uses an animation key computed by the
independent Python reference implementation (`assets.json`, made by
`gen_assets.py`), so the extension's generator is checked against it.

The mock binds port 443 on 127.0.0.1 (run as root, or in a container), and
Chromium resolves x.com, abs.twimg.com, pbs.twimg.com and edge.adsonbread.com
to it.

```sh
npm i -g playwright            # or set PLAYWRIGHT=/path/to/playwright
node tests/e2e/t1_core.mjs          # scan + unfollow, 429 rest, cooldown, whitelist, ads
node tests/e2e/t2_resilience.mjs    # fallbacks, frozen tab, killed worker, halts, daily cap
node tests/e2e/t3_dashboard.mjs     # dashboard: review table, whitelist, history, settings, import
node tests/e2e/t4_popup_states.mjs  # every popup state fits without scrolling
```

Screenshots land in `tests/e2e/out/`.
