# Privacy Policy - X (Twitter) Mass Unfollow Tool – Free & Unlimited

_Last updated: 9 October 2026 (version 7.1.0)_

This policy explains, in plain language, what the X Mass Unfollow browser
extension does with information.

## What the extension does

The extension helps you find accounts on X (formerly Twitter) that don't
follow you back and unfollow them. It works inside your own browser, using the
X session you are already signed into. It never asks for your password, never
signs in on your behalf, and never sends your X account data to the developer
or to any other third party.

To read your following list and to unfollow accounts, the extension sends
requests **only to X itself** (x.com, and abs.twimg.com for X's own app
files) - the same requests X's website makes when you use it.

## Information stored on your device

The following is stored in your browser's local extension storage only. It is
never transmitted to the developer:

- **Your settings** - speed, daily limit, Keep rules.
- **Your whitelist** - handles you never want unfollowed.
- **Your last scan** - the accounts you follow and whether they follow you back.
- **Scanner results** - when each account you follow last posted (read from X in your own session), so it isn't read twice.
- **Your unfollow history** - accounts the extension unfollowed, and when.
- **A daily counter** - timestamps of recent unfollows, to enforce your daily limit.

You can delete all of it at any time from **Dashboard -> Settings -> Delete
all extension data**, or by removing the extension.

## Anonymous usage statistics

To understand how many people use the extension and to catch bugs, the
extension sends a small, **anonymous** signal to the developer's own server:

- a **random install ID** - generated on your device, not derived from you or
  your computer, and reset whenever you clear extension data;
- the **extension version**;
- an **install** event, a once-a-day **active** ping, and an **uninstall** event;
- with the daily ping, an **aggregate count** of how many unfollows happened in
  the last 24 hours (just a number);
- **coarse country**, derived on the server from the network request. The IP
  address itself is **not stored**.

This signal **never** includes your IP address, your X/Twitter username or
account, your following list, your whitelist, or your history. It cannot be
used to identify you, and it is never sold or shared for advertising.

You can turn it off at any time in **Dashboard -> Settings -> Privacy ->
Anonymous usage stats**. When it is off, nothing is sent and the uninstall
signal is removed.

## Advertising

This extension uses AdsOnBread to display contextual ads. The SDK stores a
random pseudonymous token and a 24-hour expiration time in local extension
storage and transmits the unexpired token, browser language, impressions, and
clicks to AdsOnBread for frequency capping, billing accuracy, and fraud
prevention. An expired storage record is replaced the next time the SDK runs
and can also be removed by clearing extension storage or uninstalling.
AdsOnBread also derives coarse country from the network request. This
information is not used for behavioral advertising or cross-site profiling.

Ads appear only inside the extension's own popup and dashboard. Nothing is
ever injected into x.com or any other website. AdsOnBread never receives your
X account, your following list, your whitelist or your history. See the
[AdsOnBread privacy policy](https://adsonbread.com/privacy) for its
server-side retention schedule.

## Permissions and why they are needed

- **x.com, twitter.com** - to read your following list and unfollow accounts in your own signed-in session.
- **abs.twimg.com** - to read X's own app files, which describe how X's website talks to X.
- **storage, unlimitedStorage** - to keep your settings, scan and history on your device (large following lists need more than the default space).
- **alarms** - to schedule the next unfollow, breaks and daily-limit pauses.
- **scripting** - to start working in an x.com tab that was already open, without making you reload it.

## Children

The extension is not directed at children under 13 and does not knowingly
collect information from anyone.

## Changes

If what the extension stores or shares ever changes, this page and the Chrome
Web Store listing will be updated to match. The date at the top shows the
current version.

## Contact

Telegram: [@igfrostt](https://t.me/igfrostt)
