# Chrome Web Store listing - X (Twitter) Mass Unfollow Tool – Free & Unlimited

Copy-paste kit for the Developer Dashboard. Written for search: the phrases
people actually type ("mass unfollow", "unfollow non-followers", "who doesn't
follow me back", "bulk unfollow Twitter", "unfollow everyone on X") appear
naturally in the title, the summary and the first lines of the description,
which is what the store's search weighs most. It deliberately avoids keyword
lists and repetition: the Web Store's spam policy rejects or demotes listings
that stuff keywords.

---

## Title (49 / 75 characters)

```
X (Twitter) Mass Unfollow Tool – Free & Unlimited
```

## Summary (126 / 132 characters - same as the manifest)

```
Free & unlimited X (Twitter) mass unfollow tool. Bulk unfollow, clean your following list, and remove non-followers with ease.
```

## Category

**Social Networking** (secondary fit: Tools)

## Language

English

---

## Detailed description

```
The free and unlimited way to mass unfollow on X (Twitter). See who doesn't follow you back, then bulk unfollow non-followers - or unfollow everyone - in a few clicks. No subscription, no paywall, no sign-up.

Cleaning up a following list one click at a time takes hours. X Mass Unfollow scans your whole following list, shows exactly who isn't following you back, and unfollows them for you at a safe, human pace while you get on with your day.

★ WHY PEOPLE SWITCH TO IT
• 100% free and unlimited - every feature, no "premium" tier
• Finds every non-follower in about a minute, even on large accounts
• Keeps working in the background - switch tabs or close the popup
• Built-in safety: random delays, short breaks, a daily limit and automatic backing off when X asks you to slow down
• Your data never leaves your browser - no tracking, no analytics

★ FEATURES
• One-click scan: reads your full following list and marks who follows you back
• Unfollow non-followers: remove everyone who doesn't follow you back in one go
• Unfollow everyone: start fresh with a clean following list
• Review & pick: a full dashboard with search, filters and sorting - no profile photo, few posts, few followers, follow-spam accounts, verified, private
• Whitelist: protect friends, clients and favourite creators - they are never unfollowed
• Keep rules: automatically keep verified accounts, private accounts, big accounts or anyone matching your keywords
• Import a list: unfollow exactly the accounts in a CSV or a pasted list
• Export to CSV: download your non-followers, your selection or your full unfollow history
• Unfollow history: see who you unfollowed and when
• Speed presets: Safe, Balanced or Fast - or set your own delays and daily limit
• Live progress with a countdown, pause, resume and stop
• Light and dark mode
• Emergency stop: Alt + Shift + S

★ HOW TO USE
1. Sign in to x.com in Chrome.
2. Click the extension icon and press "Scan my following".
3. Press "Unfollow non-followers" - or open the dashboard to review and pick exactly who goes.
That's it. The run continues in the background and pauses itself if X needs your attention.

★ SAFE BY DESIGN
X limits accounts that follow or unfollow too quickly. X Mass Unfollow sends the same requests as X's own Unfollow button, one at a time, with randomised gaps, regular breaks and a rolling daily limit you control. If X says to slow down, it rests and continues on its own. If X asks you to verify your account, it stops and waits for you - it never clicks through X's checks.

★ PRIVATE BY DESIGN
Everything runs inside your own signed-in browser. Your password, your following list, your whitelist and your history stay on your computer. The extension has no servers and collects no analytics.

★ FREQUENTLY ASKED
• Is it really free and unlimited? Yes. There is no paid plan and no cap on how many accounts you can unfollow. The daily limit is a safety setting you can change or switch off.
• Will it unfollow people who follow me back? Not in "Unfollow non-followers" mode. Mutuals are only included if you choose "Unfollow everyone", and your whitelist is always respected.
• Does it work with large accounts? Yes - it reads the list page by page and keeps going for as long as it takes.
• Can I see who I unfollowed? Yes, in History, with CSV export.

Love it? It's free because people chip in. Donations, a 5-star review or sharing it with a friend all help keep it that way.

A product of Unique Labs. Developed by Shahriar Ahmed - www.shahriarahmed.net
Support and bug reports: https://t.me/igfrostt

X and Twitter are trademarks of X Corp. This extension is independent and is not affiliated with or endorsed by X Corp.
```

---

## Screenshot captions (upload in this order)

1. `01-unfollow-non-followers.png` - Find everyone who doesn't follow you back and unfollow them in one click
2. `02-review-and-pick.png` - Review your whole following list with search, filters and multi-select
3. `03-runs-in-background.png` - Safe pacing that keeps working in the background
4. `04-dark-mode.png` - Beautiful light and dark mode
5. `05-free-and-private.png` - Free, unlimited and private - whitelist, history and CSV export

Promo tiles: `promo-small-440x280.png`, `promo-marquee-1400x560.png`.

---

## Privacy practices tab

**Single purpose**

```
Helps users unfollow accounts on X (Twitter) in bulk - for example everyone who doesn't follow them back - and manage their following list.
```

**Permission justifications**

| Permission | Justification |
| --- | --- |
| Host: x.com, twitter.com | Reads the signed-in user's following list and sends unfollow requests on x.com, in the user's own session, when the user starts a scan or a run. |
| Host: abs.twimg.com | Reads X's own web-app JavaScript files to find the request formats X's website currently uses. Nothing is executed from these files. |
| storage, unlimitedStorage | Saves settings, the whitelist, the last scan and unfollow history locally. Large following lists need more than the default quota. |
| alarms | Schedules the next unfollow, breaks and daily-limit pauses so a run survives the background worker being stopped. |
| scripting | Starts the extension's own content script in x.com tabs that were already open when the extension was installed or updated, so users don't have to reload X. |

**Remote code:** No. All code is in the package.

**Data usage**

- The extension itself sends nothing to the developer: the following list, whitelist and history stay in local storage.
- The AdsOnBread ad SDK receives ad impressions and clicks, a pseudonymous 24-hour token and the browser language. If you want to be strict, tick **User activity** (used only to deliver and bill ads).
- Tick all three certifications: no selling to third parties, no use unrelated to the single purpose, no use for creditworthiness or lending.

AdsOnBread note for the disclosure field (required by AdsOnBread):

```
This extension uses AdsOnBread to display contextual ads. The SDK stores a random pseudonymous token and a 24-hour expiration time in local extension storage and transmits the unexpired token, browser language, impressions, and clicks to AdsOnBread for frequency capping, billing accuracy, and fraud prevention. An expired storage record is replaced the next time the SDK runs and can also be removed by clearing extension storage or uninstalling. AdsOnBread also derives coarse country from the network request. This information is not used for behavioral advertising or cross-site profiling.
```

**Privacy policy URL:** host `PRIVACY_POLICY.md` publicly (for example on www.shahriarahmed.net) and paste that URL.

---

## Website snippet (www.shahriarahmed.net landing page)

For Google search, put this in the `<head>` of the extension's page on your
site and link to the store listing from it:

```html
<title>X (Twitter) Mass Unfollow Tool – Free & Unlimited Chrome Extension</title>
<meta name="description" content="Free and unlimited X (Twitter) mass unfollow tool for Chrome. See who doesn't follow you back, bulk unfollow non-followers safely and clean up your following list in minutes.">
<link rel="canonical" href="https://www.shahriarahmed.net/x-mass-unfollow">
<meta property="og:type" content="website">
<meta property="og:title" content="X (Twitter) Mass Unfollow Tool – Free & Unlimited">
<meta property="og:description" content="Find who doesn't follow you back on X and bulk unfollow them safely. 100% free, no limits, private.">
<meta property="og:image" content="https://www.shahriarahmed.net/x-mass-unfollow/promo-marquee-1400x560.png">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "X (Twitter) Mass Unfollow Tool – Free & Unlimited",
  "applicationCategory": "BrowserApplication",
  "operatingSystem": "Chrome",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "description": "Free and unlimited X (Twitter) mass unfollow tool. Bulk unfollow, clean your following list, and remove non-followers with ease.",
  "author": { "@type": "Person", "name": "Shahriar Ahmed", "url": "https://www.shahriarahmed.net" },
  "publisher": { "@type": "Organization", "name": "Unique Labs" }
}
</script>
```
