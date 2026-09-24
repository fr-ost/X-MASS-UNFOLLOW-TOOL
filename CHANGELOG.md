# X Unfollow Manager Pro

## v6.28.0 — One scroll per batch, not one per unfollow

Unfollow All exposed something the last release only half-fixed.

### Why it scrolled after every unfollow

Before clicking, the engine scrolled the row into view. I had already changed
that from `center` to `nearest`, which stops it repositioning rows that are
already on screen - and I assumed that was enough. It was not. Walking down a
list means most rows are *below* the fold, so `nearest` still scrolled a
little for nearly every one. The page crept downward after each action.

In Unfollow All this is at its worst, because nothing is skipped: every single
row is acted on, so every single row scrolls.

The reference extension does not scroll before clicking at all. It is right
not to: a button can be clicked whether or not it is on screen, because the
click event is dispatched directly and does not depend on the viewport.

So that scroll is gone. It survives only as a fallback - if the confirm dialog
fails to open, the row is scrolled in and tried once more, which costs a
scroll on the rare failure instead of on every action.

### Rows are now taken as a batch

The engine also re-queried the whole DOM after every action. It now takes a
snapshot of the currently-loaded rows and works through it, only going back to
the DOM once the batch is drained. Rows are re-verified as they come off the
batch, so a row that X has recycled or that has already been unfollowed is
skipped rather than acted on.

Measured over 100 unfollows with 15 rows loaded at a time: **107 scroll events
before, 7 after** - exactly one per batch. The page now sits still while it
works through what is on screen, then moves once to fetch more.

All of v6.27.0's behaviour is retained and re-verified: document order, no
viewport filtering, continuous mode off by default, and no reloading outside
continuous mode.

## v6.27.0 — Predictable scrolling, no surprise refreshes

I studied the reference extension you sent (X (Twitter) Mass Unfollow, v1.2.3).
Its content script is 427 lines; this one had grown to roughly 3,300 across
about twenty rounds of bug-fixing. Two of its design choices were plainly
better than mine, and both map directly onto what you reported.

### "Sometimes it scrolls, sometimes it doesn't"

The engine picked the next account by **distance from the middle of the
viewport**. I added that to reduce scrolling, and measured only the total
pixels moved - which did improve. What I never checked was the *order* it
produced.

Simulated over twenty loaded accounts, the old order was:

    10, 11, 9, 12, 8, 13, 7, 14, 6, 5, 4, 3, 2, 1, 0, 15, 18, 17, 19, 16

It fans outward from wherever the page happens to sit, then doubles back.
Which account came next depended on the exact scroll position, so the same
list produced different movement every run. That is the wandering you were
seeing - and it was my optimisation, not X.

Now it goes in document order, plain top to bottom:

    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19

Fewer jumps as well - 8 down to 3 in the same simulation.

The reference also never checks whether a row is on screen before clicking it,
and it is right not to. A rendered row can be clicked whether or not it is
visible. My visibility requirement was hiding perfectly actionable accounts
from the engine, which then scrolled off hunting for more while they were
already loaded. That check is gone; only genuinely unusable nodes (detached,
`display:none`) are skipped now.

### "Refreshes automatically"

The reference never reloads the page mid-run - only optionally when you stop
it. Mine reloaded to get past X's pagination ceiling, which is a real
capability, but it had become the default experience.

**Continuous mode is now off by default**, including a one-time switch-off for
installs that a previous version had already turned it on for. With it off,
a run works through the list and then stops and tells you it is done. Nothing
reloads underneath you.

While checking this I also found the two paths had drifted apart: the
non-continuous path still reloaded on exhaustion, so switching continuous mode
off would not actually have stopped the refreshing. Reloading is now
exclusively a continuous-mode behaviour, verified by test.

Continuous mode remains available in Settings, with honest wording about what
it does. Turn it on if you want to sweep past X's pagination limit and accept
the page reloading to do it.

### What I did not copy

Techniques and structure only - no code was taken from the reference, which
ships without a licence granting reuse. Its follows-you detection turned out
to use the same `userFollowIndicator` selector this extension already used.

## v6.26.0 — Found the actual reload-to-top bug

The pattern you described — unfollow, jump to top, unfollow, jump to top —
was a real bug, and it was mine. Traced and reproduced against the shipped
code rather than guessed at.

### The mechanism

When the visible batch of loaded accounts runs dry (a normal, frequent event
on any account with more mutuals than non-followers - most of what renders
gets skipped, not acted on), the engine probes for new content, then reloads
the page to fetch more once it's confident nothing new is coming. Reloading
always lands back at the top of the list - that part is normal browser
behaviour, not a bug.

The bug was in how long it waited before reloading. The code checked whether
you'd unfollowed *anything at all* this cycle, and if so, skipped the wait
almost entirely - about one second. But reaching that check already meant a
couple of minutes of fruitless probing had just happened, and "anything at
all" was satisfied by a single early unfollow in an otherwise-exhausted
batch. So once you'd unfollowed even one account, every later exhaustion
reloaded almost instantly.

Simulated against the real constants in the shipped code: this reloaded to
the top roughly **every 87 seconds**, doing **13 aggressive full-page scroll
jumps** in that window each time. Over a 30-minute session, that's **20
separate jumps back to the top** - which matches "not scrolling properly,
just scanning and unfollowing and going to the top" exactly.

### The fix

- **A real minimum pause before any reload** - 90 seconds, always, regardless
  of this cycle's count. A productive cycle still reloads sooner than a
  genuinely dry one, but "sooner" is now a visible pause, never near-instant.
- **The violent full-page jump is now a later resort.** It used to kick in
  after just 2 failed gentle scrolls; it now takes 16, so most stalls resolve
  with plain scrolling instead of the jarring bottom-jump-jiggle-bottom
  motion.
- **More patience before concluding the batch is exhausted at all** - raised
  from 14 confirming attempts to 22, so ordinary batch turnover on a
  high-mutual account is far less likely to be mistaken for genuine
  exhaustion in the first place.

Re-simulated against the same real code: reload-to-top interval goes from 87
seconds to **212 seconds**, aggressive jumps per cycle from 13 to **7**, and
top-jumps over a 30-minute session from 20 down to **8**.

Every reload now also logs its exact trigger to the console (probing
attempts, how many were unfollowed this cycle, the wait applied) so if
anything about this still looks wrong, it's provable rather than another
round of guessing.


## v6.25.0 — The scrolling, properly this time

My last attempt at this fixed a condition that was not actually happening. The
real causes were three, and all of them were scrolls the engine chose to make
rather than scrolls it needed.

### 1. It repositioned the page before every single unfollow

Before clicking, the engine scrolled the row to the centre of the screen. That
is unconditional: it moves the page even when the row is already fully
visible. Every unfollow therefore began with a jump, which is exactly the
"it scrolls, then unfollows" you described.

It now scrolls only when the row is not already on screen. Measured over six
consecutive rows: **940px of avoidable movement before, 0px now.**

### 2. After fetching, it jumped back to the top

Candidates were taken in document order. So after a fetch scrolled down the
list, the next account to act on was often near the top - the page snapped up,
acted, then snapped back down on the next fetch.

Candidates are now taken in order of distance from where the page already is.
In the same situation that produced a **2300px** jump, the new order moves
**180px.**

### 3. Fetching teleported to the bottom of the list

Loading more accounts drove the scroller to its full height - a **5400px**
jump in a moderate list - because that is what was needed to get past X's
pagination ceiling.

That is still there, but it is no longer the first thing tried. An ordinary
fetch now nudges down about **one screen**; the full-height jump is kept in
reserve for when two gentle fetches in a row have produced nothing new. The
ceiling fix is retained without paying for it on every fetch.


## v6.24.0 — Limit values actually stick now

v6.23.0 made the engine treat 0 as "no limit", but the settings page was still
rewriting your input before it ever reached the engine. Three separate places
were doing it, which is why the value kept coming back as 400 or 0:

- **The clamp table** still had `dailyLimit: [1, 400]`, `maxActions: [1, 400]`,
  `windowLimit: [1, 50]` and `maxSessionMinutes: [5, 480]`. A floor of 1
  rewrote "no limit" to "one action" - which is why the fields showed 1, 1 and
  5, the minimum of each range - and the ceilings pulled anything larger back
  down. The value was never rejected, just quietly changed.
- **The number inputs** carried the same `min` and `max` in the HTML.
- **A cross-field rule** reduced the session cap to match the daily budget.
  With the daily budget at 0 that rewrote *any* session cap to 0.

All three are gone. The cross-field rule is now a note after saving rather
than an edit: if your session cap is above your daily budget you are told the
day will run out first, and your number is kept.

The settings page also had its own copy of the defaults, still on the old
40/100/25/120, so an unset field loaded an old number back and the clamp used
it as a fallback. It now mirrors the engine.

Verified by round-trip - set, save, reload, read back - for 0, 400, 999, 2000,
5000, 9999 and 100000 across all four budgets. Every value survives.

Saving an unlimited budget now says so, so "no limit" is visibly deliberate
rather than looking like a field you forgot to fill in.


## v6.23.0 — Your limits, no standby, no wasted scrolling

### Limits are yours now

Daily, 15-minute and per-session caps can all be set to **0 for no limit**.
Anything above 0 is still enforced exactly as before, so a number you choose
yourself is respected. Existing installs still sitting on the old built-in
numbers are moved to unlimited; a number you set by hand is left alone.

In place of a hard stop there are warnings, at 400, 700, 1000 and 1500 actions
in a rolling day - the volumes where X has historically started limiting
accounts. Each fires once, with a beep, and the run carries on.

The reactive halts are unchanged and still on: a verification prompt, an
explicit rate-limit, or several failures in a row still stop the session. They
are not volume caps - they are X telling you it has noticed, and continuing
through them is what turns a temporary limit into a locked account. If you
want them off too, **Stop when X shows a challenge** in Settings does it.

### No more standby

Background pausing is gone entirely, and so is its setting - a hidden tab now
changes nothing. That path also had a real bug: when it did trigger it
re-queued the account and looped with no delay at all.

The deeper cause of runs dying while minimised was never in the page: Chrome
**discards or freezes backgrounded tabs** to reclaim memory, which tears down
the engine. No in-page code can prevent that or recover from it, because the
page is gone.

So liveness moved to the background worker. Once a minute it checks whether a
run claims to be live and whether its heartbeat is still fresh. A stale
heartbeat means the page died without the session ending, so the tab is
reloaded and the existing auto-resume picks the run back up. It will not fight
a deliberate safety halt, and the list engine now beats its heartbeat every
seven seconds so a six-minute cooldown is never mistaken for a dead page.

### Unfollow All no longer scrolls past loaded accounts

The engine only considered rows inside the viewport. Accounts that were
already loaded but sitting just off-screen were invisible to it, so it decided
there was nothing left to do and scrolled to fetch more - with actionable
accounts already on the page.

Measured on ten loaded rows with three on screen: it acted on three and then
scrolled. It now works through all ten before fetching anything.

### Sponsor slot

The opt-out control has been removed.


## v6.22.0 — Sponsor slot (AdsOnBread)

A single small ad renders at the bottom of the console, below every control.

### Where it appears, and where it never does

Only in the extension's own panels - the popup and the side panel. **Nothing
is injected into x.com.** Putting ads into a page the extension does not own
is ad injection: a Chrome Web Store violation, and one that gets an extension
removed rather than warned. The content scripts that run on x.com contain no
ad code at all.

The slot sits below the controls, so it never comes between you and a button.

### Behaviour

- Hidden until an ad actually renders. A no-fill leaves no empty box and no
  gap in the layout.
- Follows the console's light/dark theme, and re-renders when you switch it.
- A failure to load can never affect the console - the whole path is wrapped
  and silent.
- **Settings > Show sponsor message** turns it off.

### The SDK is vendored, and was read before shipping

`vendor/adsonbread-sdk.js` ships inside the package rather than being fetched
at runtime, because Manifest V3 forbids remotely hosted code.

It was audited before bundling, since it runs in a panel belonging to an
extension that can reach your X session. What it does: one POST to
`edge.adsonbread.com/ad` carrying the publisher key, UI language, placement,
SDK version, and a rotating random token. What it does not do: no `eval`, no
`new Function`, no injected scripts, no cookie access, no page content, no
browsing history. The ad is built with `createElement` and `textContent`, and
its link carries `rel="noopener noreferrer sponsored"`.

The identifier is a random token with an expiry that rotates rather than a
permanent ID.


## v6.21.0 — Reads the inline Moni badge, no hovering

### Why the last fix still missed

v6.20.0 looked for the badge by finding a link whose text was exactly
"@handle" and searching that link's parent. In X's actual markup the display
name and the handle sit inside the **same** anchor, so a link whose text is
just the handle usually does not exist. The lookup fell back to the handle's
immediate parent, which is too tight to contain the badge Moni injects beside
it. So the score read as absent, and the run behaved as if no scores existed.

### Found by position, the way you find it

The badge is identified the same way a person identifies it on screen: it is
the number on the **same visual line as the handle**. The reader now compares
element positions rather than guessing at DOM shape, which is why it survives
X or Moni restructuring their markup - the badge stays where it looks.

Everything that is not the badge is excluded first: X's follower and following
counts (always links, which Moni's badge never is), the follow button, and the
bio. If two different numbers share the handle's line, the score is treated as
unreadable and the account is skipped - a misread score unfollows somebody you
meant to keep, and that cannot be undone.

Verified against X's real cell structure, with the name and handle inside one
anchor: the six accounts from your list read 13, 0, 22, 0, 0 and 21 correctly,
including both handles that contain digits, and scores of **0** - which must
never be mistaken for "no score".

### Hovering is off

Moni shows the score inline now, so there is no reason to hover each row - and
hovering was what made a session look like it was scrolling around
aimlessly. A row with no inline score is simply skipped.

### Moni check

The button beside Diagnostics now reports, per row, every number it found,
which of them sit on the handle's line, the score it settled on, and the
decision it would make at your threshold.


## v6.20.0 — Moni score read correctly, or not at all

### Why it unfollowed the wrong accounts

The score reader searched the **whole row** for a bare number, and matched
Moni's badge by looking for any element whose class merely contained "moni".

Both were unsafe. X's class names are obfuscated hashes, so the class test
could match one of X's own elements and then pull the first integer out of
anywhere inside it. And the whole-row search meant the display name, the bio,
and the handle itself were all fair game - so an account like **@Anis0504** or
**@Maksudu3343071** could have digits from its own handle read as its score.
A wrong score means the wrong account gets unfollowed, which is exactly what
was happening.

Three changes:

- **The search is anchored to the handle line.** Moni puts its badge next to
  the @handle, so that is the only place worth looking. The scope is taken
  from the handle link itself rather than by climbing upward until the text
  looks long enough - which was the old rule, and which swallowed short bios.
- **A labelled Moni node is only trusted when its own text is just the
  number.** No more pulling an integer out of a large container that happened
  to match a class substring.
- **Ambiguity now means refusal.** If two different numbers sit on the handle
  line, the score is unreadable and the account is skipped. An unread score
  costs you one skipped account; a misread score unfollows somebody you meant
  to keep. Only one of those can be undone.

Verified against reconstructions of the rows in the list, including the two
handles that contain digits, scores of **0** (which must not read as "no
score"), X's own follower-count links, and a bio consisting only of digits.

### Moni check

A new **Moni check** button next to Diagnostics dumps what the extension reads
for every visible row - the score, the candidate numbers it saw, the handle
line text, and the decision it would make at your threshold. If a score still
looks wrong, that block says exactly why instead of leaving it to guesswork.


## v6.19.0 — Fixes the list run sitting at 0/N doing nothing

### Why nothing happened

Two bugs that combined into a dead stop.

**The navigation guard refused to move.** Before visiting a profile, the
engine checked whether the current page was one it recognised - a profile,
the site root, or a follow list. Anything else failed every branch and it
returned having done nothing. Tested against real X pages, it refused to
navigate from seven of them: settings, messages, bookmarks, communities, the
compose screen and the login flow among them.

**And nothing ever tried again.** The only thing that re-invoked the engine
was a page load. So one refusal was permanent: the console kept reporting
"Running 0/1928" while the run was, in fact, finished for good.

Both are fixed. An active run now navigates from wherever it is - you pressed
Start, and this script only ever runs on x.com - with one exception: it will
not navigate away from a verification screen, where moving is the worst
possible response.

### The run now repairs itself

A ticker re-invokes the engine every few seconds while a run is active. Every
early return - wrong page, budget spent, a delay still owed, a transient
error - is now a pause rather than an ending. The step function is idempotent
and interlocked, so a tick arriving mid-step does nothing rather than
double-acting.

This is the structural fix. The specific guard bug is gone, but the reason it
was fatal was that a single early return could strand the run. It no longer
can.

### A latent crash removed

The skipped counter was being written as a number in one place and as a list
of handles in another. The first time both paths ran in the same session it
would have thrown mid-run and stopped the list. Standardised on the list, with
old numeric values from previous versions read safely.


## v6.18.0 — List run now paced and protected like the main engine

### Why it still ran flat out

Two separate causes, and the second one was doing most of the damage.

**The delay was going to the wrong branch.** A full delay was only paid when
an unfollow reported success. On a profile page, X frequently does not confirm
the change in a way the extension can verify, even though the unfollow went
through - so action after action fell into the "nothing happened, take a short
hop" branch and got 3-7 seconds instead of 22-55. The account was being
unfollowed at roughly the speed of a page load.

An unconfirmed result now pays the **full** delay. The click went through; the
account was touched; X saw an action. Treating that as a no-op is exactly
backwards, because it speeds the run up at the precise moment it should be
slowing down.

**And an in-memory wait was the wrong mechanism.** This engine moves by
navigating. Any wait held only in the page's memory is lost the instant the
page navigates, reloads, or gets discarded - so the next profile was actioned
immediately.

The delay is now a **timestamp written to storage**: the earliest moment the
next account may be touched. It survives navigation, reload, tab discard and
a browser restart. If a wait is interrupted, the next page picks up the
remainder instead of skipping it. The delay cannot be lost.

### Same protections as the Following-page engine

The list run now carries all of them:

- Your minimum and maximum delay between accounts
- Human pacing - a 14% chance of a much longer pause, so the rhythm is never
  machine-regular, using the same rule and odds as the main engine
- Your batch cooldown, with the gate pushed out for the whole rest, so it is
  enforced even if the page goes away mid-cooldown
- The shared daily budget and 15-minute rolling window
- The per-session action cap
- Halt on a verification prompt from X
- **Immediate halt on an explicit rate-limit**, rather than continuing into it
- Halt after repeated failures
- The 45-minute safety lock after any halt

Measured over a simulated hundred-account run: an average gap of about 80
seconds and roughly 2.25 hours end to end, against a few minutes before.

Genuine skips - already unfollowed, suspended, unavailable - still take only a
short hop, because nothing was done to the account. Never zero, though, or a
long run of skips would machine-gun page loads.


## v6.17.0 — List pacing fixed, dedup database, dead engine removed

### Why the list run had no gaps

`countdown()` decides whether to keep waiting by asking whether the run is
still alive, and its default test is the Following-page engine's `running`
flag. A list run never sets that flag. So the test failed on the very first
tick, every wait broke immediately, and the list ran flat out with no delay
at all.

The list engine now supplies its own liveness test. Verified against the real
code path: with the old default the wait measured **0 seconds**; it now runs
the full 22-55s delay and the full 6-minute cooldown, and Stop still cuts a
wait short. The Following-page engine's behaviour is unchanged.

Pacing now matches the main engine exactly - your delay range between
accounts, your cooldown after every batch, the shared daily and 15-minute
budgets, and the same halt on a verification prompt. A skipped account gets a
short 3-7s hop instead of a full delay, because a skip costs your account
nothing - but never zero, or a long run of skips would machine-gun page loads.

### Dedup database

Accounts you have already unfollowed are now remembered in a dedicated index
and filtered out of a list before it starts.

This deliberately does *not* use the profile archive. That archive keeps a
full record per account and is capped, dropping its **oldest** rows once full -
so on a large cleanup the earliest names silently fall off and would be
visited a second time. The index stores handles only, holds 50,000 of them,
and both engines write to it, so a list run never revisits somebody the
Following-page engine removed, and vice versa.

On import you are told how many entries were dropped as already unfollowed.
During a run, an account that turns out to be already unfollowed is recorded
and counted as **Skipped** rather than **Failed**, so a stale CSV is harmless.
Your existing unfollow history is imported into the index automatically on
first run of this version.

### A duplicate engine removed

The build contained a second, unfinished list runner that nothing called. It
used its own storage key and its own data shape. Nothing referenced it, so it
was doing no harm today - but a duplicate of a live feature is how two engines
end up running at once later. It is gone; the working engine is untouched.

### Fixed

- Buttons marked hidden could still show, because the key styling set its own
  `display` and beat the `hidden` attribute. This affected the list transport
  keys and the scan Stop button.
- Suspended and unavailable accounts in a list are now recognised and skipped
  rather than retried to the failure limit.
- An exception mid-list no longer wedges the run; it backs off and retries.


## v6.16.0 — Unfollow from a list, CSV import, scan limits

Everything from previous versions is unchanged. The Following-page engine,
continuous mode, sidebar, scan and export all work exactly as before. This
adds a second, separate way to work.

### Unfollow from a list

A new panel takes a fixed list of accounts and works through it by visiting
each profile in turn and unfollowing there. It is deliberately separate from
the Following-page modes: those scroll your list and decide as they go, this
one is handed names and executes.

Pacing is the same as everywhere else — your delay range between accounts,
your cooldown after each batch, the same daily and 15-minute budgets, and the
same automatic halt on a verification prompt or repeated failures.

Because each step navigates to a new page, the run's position is kept in
storage rather than memory. Closing the tab, reloading, or Chrome discarding
it costs the current step and nothing else — the run picks up where it was.

Accounts you have already unfollowed are detected and skipped rather than
counted as failures, so re-running a stale list is harmless.

### Two ways to load a list

**Import CSV** accepts the export from this extension, a spreadsheet you have
edited, or a plain one-column list of names. Handles, @handles and full
profile URLs all work, quoted fields and embedded commas are handled, entries
are de-duplicated case-insensitively, and anything unusable is counted and
skipped rather than silently dropped.

**Load these into unfollow list** appears after a scan and moves the
non-followers straight across without going through a file.

### Scan limits

The scan panel now has a cap: 500, 1,000, 5,000, or everyone. Useful on large
accounts where a full read takes a while or brushes against X's read limits.
The choice is remembered.

### Fixed

Buttons marked hidden could still appear, because the key styling set its own
`display` and quietly beat the `hidden` attribute — which left Start and Pause
both on screen during a run.


## v6.15.0 — Full-list scan through X's own data endpoint

### Why scrolling was the wrong way to read the list

Every difficult bug in this extension's history came from reading the
following list by scrolling it. X virtualizes that list: rows are deleted from
the page once they scroll out of view, so page height and row count go flat
while hundreds of accounts remain. On top of that, X only paginates so deep
per page load. Together those produced the runs that stopped at 22, then 48,
and the reload-and-continue machinery built to work around them.

X's own web app doesn't read the list that way. It calls an internal endpoint
with cursor pagination. This build does the same.

### Scan non-followers

A new button in the console reads your **entire** following list in one pass
and reports exactly who doesn't follow you back. Typical lists finish in
under a minute instead of hours of scroll-and-reload.

It is strictly read-only. Nobody is unfollowed by a scan.

What you get:

- Exact totals — accounts you follow, how many are mutual, how many aren't
- An authoritative `followed_by` flag per account, rather than sniffing a
  "Follows you" badge out of the DOM, which was always a guess
- Follower counts, post counts, verified and protected status, and bio for
  every non-follower
- CSV export, so you can sort and decide outside the extension

The result is stored, so closing the popup doesn't lose it.

### Credentials stay in your browser

The scan runs in the page, on the session you're already signed into. Nothing
is sent anywhere except x.com itself.

This is precisely why it isn't built on a third-party API. Reading a private
following list, and unfollowing, require acting *as* the account owner. Any
external service offering that would need your session cookies handed over —
which is account-takeover capability, not an API integration. The official X
API is not an option either: X moved the follows endpoints to Enterprise-only
access in April 2026.

### Built to survive X changing its app

The endpoint is undocumented, and three things about it rotate. Each is
resolved at runtime rather than hardcoded:

- The API token and the operation's query id are read from X's own JS bundles
  on demand, and cached for a day
- The required feature flags heal themselves: when X rejects a call for
  omitting a flag, it names the flag, and the scan adds it and retries

If any of that fails, the scan reports why and the unfollow engine falls back
to the existing DOM path — so a change at X degrades this to the old behaviour
instead of breaking the extension.

Rate limits are respected: if X throttles a scan mid-way, the accounts already
read are kept and the console tells you how long to wait.


## v6.14.0 — The 40-50 ceiling, continuous mode, sidebar and handbook

### Why it stopped at 40-50

Your 15-minute window limit is 48, and that turned out to be fatal in a way
that had nothing to do with pacing.

When a run reloads the page to fetch more accounts, auto-resume calls the
launcher again. The launcher checked the budget and, if the 15-minute window
was spent, returned a refusal. Auto-resume threw that refusal away. So the
page reloaded, the resume was silently declined, and the session was dead —
permanently, at roughly 48 unfollows.

A resumed run now waits for the window to clear and carries on. A rolling
window is a pacing device, not a reason to abandon a session.

Also fixed on the way in: `recycleForInfinite` was called by both watchdogs
and never actually defined anywhere. That is a crash at precisely the moment
the run is meant to rescue itself.

### Continuous mode (on by default)

The run no longer ends on its own. No session cap, no time limit, no
"end of list" finish. When the list runs dry it waits, reloads and sweeps
again. When a daily or window limit is reached it rests until the limit frees
and then continues. It stops when you press Stop.

Three things that used to quietly end a run now recycle the page instead: the
iteration ceiling, the no-progress watchdog, and an empty-list state (X shows
that transiently after a reload, so treating it as the end was wrong).

Two safety halts remain, deliberately: a verification prompt from X, and
several failed actions in a row. Those are X telling you it has noticed.
Driving through them is how a rate limit becomes a locked account.

### Reload backoff

Continuous reloading needs a brake. If X goes down or the list stops
rendering, an unguarded design would reload every twenty-five seconds forever
from your own session. Cycles that produce no unfollow now back off — 30s, 1m,
2m, 4m, 8m, capped at 15m — which works out to about eight reloads in an hour
of total failure rather than a hundred and forty. Any successful unfollow
resets it to zero, so a healthy run never waits at all.

### Sidebar

The console now opens in Chrome's side panel, from the button under the
archive row. Worth being precise about what this does and does not do: it
does not keep the unfollow engine alive, because that engine lives in the X
page and no panel can stop Chrome discarding a tab.

What it does fix is watching a long run. Continuous mode reloads the page
repeatedly, and the popup closes on every single reload. The sidebar doesn't,
so it is the only practical way to keep an eye on a session that runs for
hours.

### Handbook

A Tutorial button in the footer opens an operating handbook: the procedure in
seven steps, what every setting does, and what to do when something stops. It
opens once on first install, and never on an update.

### Smaller fixes

- Page-change detection now compares paths loosely. X rewrites URLs across
  reloads — a trailing slash appears, handle casing shifts — and an exact
  string match read that as you navigating away and killed healthy runs.
- The settings version badge reads from the manifest instead of being
  hardcoded. It had been stuck on v6.10.0 for four releases.
- The window-budget meter no longer starts life showing a stale "0 / 25".


## v6.13.0 — Pushing past X's follow-list pagination limit

The 6.12.0 stop report was decisive and showed two separate problems.

**Problem 1 — a 36-minute spin.** The run went 45 minutes but the "looking for
more" counter reached **338**, never stopping at the intended 14. The end-of-run
check also required being "at the bottom" of the scroller — and X reports a huge
virtual scroll height that is *never* at the bottom, so that condition could
never be met. The run just span until the idle watchdog finally killed it. The
bottom check is removed; end-of-list is now decided purely on whether new
accounts are still appearing, so it concludes in ~90 seconds instead of 36
minutes.

**Problem 2 — the real ceiling.** After **19 unfollowed + 90 skipped (they follow
you) = 109 accounts**, with zero failures and no loading spinner, X simply
**stopped serving more of the following list**. The first 109 loaded in about
nine minutes and then nothing new came, ever. X only paginates a follow list so
deep per page-load, especially while you are actively unfollowing.

Two fixes address the ceiling:

- **Reach the true bottom to trigger loading.** The load-more nudge now drives
  the scroller all the way to its full height (not just to the last rendered
  row, which sat above X's virtual spacer and never tripped the loader), then
  jiggles the sentinel so X fetches the next page.
- **Reload-and-continue.** When X genuinely stops serving more — and the run has
  removed at least one account this pass — the extension reloads the list and
  continues automatically. Reloading drops the accounts you already unfollowed,
  so the next batch shifts into the range X *will* serve. It keeps cycling until
  a full pass removes nobody (the list is truly exhausted), your daily limit is
  reached, or a safety cap of 60 reload cycles. This rides on the existing
  resume system, so it survives the reloads without losing your place or
  exceeding the daily quota.

Practically: instead of stopping at ~20, a run now walks the whole following
list in batches and keeps going until it runs out of non-followers or hits your
daily limit. Keep one list tab open and let it run.

The stop report is still in this build and now also includes the **scroller
geometry and reload-cycle count**, so if anything still ends a run early, the
report says exactly where it stood.


## v6.12.0 — The real cause: virtualized list read as "ended" too early

The stop report settled it. A run ended with **"Finished. Unfollowed 22 of
22"**, zero failures, no challenge — a clean stop. The last lines showed it
went `Loading more accounts` → `Checking for more accounts (1/8 … 8/8)` →
`Reached the end of the list`, on an account that follows far more than 22.

So none of the earlier theories were right. X was not throttling; the budgets
were not the limit. **The end-of-list check was wrong.** It decided the list
had ended when page height and row count stopped growing — but X *virtualizes*
the follow list: rows that scroll out of view are deleted from the DOM, so
height and count go flat while hundreds of accounts still remain. After
clearing the ~40 rows it had loaded (22 unfollowed + 20 skipped as
"follows-you"), those flat signals tripped the eight end-of-list probes in
about sixteen seconds and the run stopped.

Two changes fix it:

- **End-of-list is now judged on whether new *accounts* are still appearing**,
  by unique user ID, not on page height. A user ID never un-sees itself, so
  this signal cannot be fooled by row recycling. The run only concludes the
  list is done after many vigorous fetches in a row each surface zero new
  accounts (~a minute of genuinely trying), so a slow page after unfollowing
  is never mistaken for the end.
- **A stronger "load more" nudge.** Instead of a passive scroll, it pulls the
  last rendered row fully into view — which is what trips X's lazy loader —
  then jiggles up and back down so the bottom sentinel re-fires. This works
  regardless of whether the window or an inner container is the thing that
  scrolls.

Net effect: the run now walks the entire following list and keeps going until
it genuinely runs out of accounts or hits your daily limit, instead of quitting
at the first virtualized-render boundary.

The diagnostic **stop report** from 6.11.1 is still in this build. If anything
still ends a run early, open the X-tab console, copy the `XUMP STOP REPORT`
block, and it will say exactly why.


## v6.11.0 — Runs to the daily limit without stalling at ~25

### Why it kept stopping around 25-30 unfollows

Three defaults were fighting the thing you actually wanted:

- **The 15-minute window cap was 25.** The moment 25 actions landed inside a
  rolling 15-minute window, the loop dropped into a rate-rest and then only
  released one action per freed slot. That trickle is exactly what "stops
  after 25-30" looks like. The window cap is raised to 48, so the real
  governor is now your pacing delays and the six-minute cooldown — never this
  cap — and the run flows straight through to the daily limit.
- **The per-session cap was 40.** A session could never reach a daily limit
  of 100 because it capped itself at 40 first. It now equals the daily limit.
- **The wall clock was 120 minutes.** A full hundred-action run with cooldowns
  runs close to two hours, so the clock could cut it off. Raised to 240.

If you'd previously left these at their old values, an update-time migration
bumps them for you — but only if they still match the old defaults, so any
number you set yourself is untouched.

### The background is now genuinely stable

The real cause of "the background is not stable" was not the loop — it was
Chrome **discarding or freezing the tab** (Memory Saver, or the OS reclaiming
memory). That tears down the whole page, kills the timer, and loses the run.
No keepalive can stop a tab discard.

So the run is now written to storage as it goes, and when a fresh page loads
onto the same list it **picks the session back up where it left off**. Because
unfollowed accounts no longer carry an unfollow button and the 24-hour ledger
is persisted, resuming can neither act on anyone twice nor exceed the daily
budget. It only resumes a session whose heartbeat is recent, on the same list,
with budget left and no safety lock — so it never surprises you by starting on
its own. (Keep a single list tab open for a run; two open lists could both try
to resume.)

### Two smaller safety-net fixes

- **Every deliberate wait is now credited to the stall watchdog**, including
  the backoff waits that weren't before. A slow patch right after a cooldown
  can no longer be mistaken for a stuck run.
- **Transient click failures back off instead of racing to a halt.** A one-off
  DOM timing miss (the row recycled before the dialog opened) recovers on the
  next pass; only a real rate-limit signal, or six failures in a row, stops the
  session.


## v6.9.1 — Runs no longer kill themselves during a cooldown

### The session dying after a dozen or so unfollows

This was my bug from v6.7.0. The stall watchdog added there ended a run after
2.5 minutes without progress, measured on the wall clock. But the default
cooldown is **6 minutes** and fires after 12 unfollows, and a human-paced
delay can reach nearly 3 minutes on its own. So a perfectly healthy run went
into its first cooldown and the watchdog executed it mid-rest. The safety net
was shorter than the thing it was supposed to sit above.

The watchdog now measures only unexplained time. Every deliberate wait, a
cooldown, a pacing gap, a rate rest, is credited back, so none of them count
as being stuck. The budget is also raised to four minutes. Working through
the list, resolving a score and skipping an account all now count as
progress, not just completing an unfollow.

Genuine stalls are still caught. There are two tests: nine unfollows across
repeated six-minute cooldowns must all complete, and a list that yields
nothing must still end the run.

### The badge is now visible from every tab

It was being set per tab, so it only appeared while you were looking at the
X tab. A run belongs to the browser as far as you are concerned, so the
counter now shows on the toolbar whichever tab you are on.

The work itself still happens in the X tab, and that tab must stay open. An
extension cannot unfollow without a page to do it on.

### Unreadable button text in light mode

The primary button was black text on a black background. Two colour rules
were keyed to the system dark setting rather than the theme actually
selected, so forcing light mode on a machine set to dark left the background
dark while the text was forced dark too. Foreground colours are now theme
variables, so the system preference can no longer contradict your choice.

Every button was measured across all four combinations of system setting and
manual theme. The worst case is now 5.9 to 1, comfortably past the
accessibility threshold; the button in the screenshot went from unreadable to
15.24 to 1. The reds in both themes were adjusted slightly to clear the same
bar.

### Also

The allowance gauge now updates during a run. Progress messages carried no
budget, so it sat at zero while unfollows were happening, which is exactly
what the screenshot showed.

Suite is 87 checks, plus 18 in the worker simulation.

---

## v6.9.0 — Lifetime unfollow totals

Adds **Total unfollowed in lifetime** to the telemetry dashboard: how many
accounts every user has unfollowed since installing, summed across the whole
userbase.

**Why it is not simply the archive count.** The popup's "profiles archived"
figure comes from the local archive, which is capped at 5,000 entries and is
emptied by the Clear button. Using it as a lifetime total would fall whenever
someone cleared their history or crossed the cap.

So the extension keeps a separate counter that only ever increases. It is
seeded from each user's existing archive the first time it is touched, so
people with history already do not restart from zero. The server takes the
higher of the stored and incoming value on every ping, which means a cleared
archive, a reinstall, or a late-arriving ping can never reduce the figure.

**On the dashboard:** a headline tile with the total across all users and the
average each, plus a panel showing how lifetime totals are distributed
(none yet, 1 to 10, 11 to 50, 51 to 200, 201 to 1000, over 1000) and the
highest single total. That distribution is more useful than a leaderboard,
since the identifiers are random and anonymous.

**Privacy policy updated** to list the new field. It is a count only, with no
record of which accounts were unfollowed.

Nothing else changed.

Server tests are now 44, including the case that matters: a user whose
reported figure drops does not reduce the stored total, while a higher figure
still updates it. Extension behaviour suite remains 82, worker simulation 18.

---

## v6.8.0 — Telemetry endpoint baked in, and a way to see failures

The server URL is now hardcoded, so no per-build editing is needed:
`https://unfollow-telemetry-production.up.railway.app`

### The likely reason nothing was arriving

Reporting was armed only inside the install handler, and that handler bailed
out immediately when no endpoint was configured. So an extension that was
installed BEFORE the URL was set stayed silent permanently: no heartbeat
alarm, no uninstall hook, no pings, and nothing anywhere to indicate why.
Editing the URL afterwards changed nothing unless the extension happened to
fire a fresh install event.

Reporting is now armed whenever the service worker wakes and on any message
it receives, so it recovers by itself.

### Opening the popup now sends a ping

Previously the first report after configuring the server could take up to
thirty minutes, however long the heartbeat alarm took to fire. Opening the
popup now reports activity immediately, which also keeps "using right now"
honest.

### Test connection button

Settings, under Privacy, has a **Test connection** button. It performs a real
round trip and reports exactly what happened: the HTTP status and timing on
success, or a specific reason on failure, with 401, 404, 429 and network
errors each explained separately. Previously a misconfigured endpoint failed
completely silently.

### Failures are no longer swallowed

- A failure to load `telemetry.js` was caught and discarded, which meant
  reporting could be dead with no trace. It is now logged to the service
  worker console.
- The result of every send is recorded, so a persistent failure is
  inspectable rather than invisible.

Verified with a new simulation that loads the real service worker code and
fires the actual lifecycle events: 18 checks covering install, heartbeat,
session reporting, offline queueing, and that no account data appears in any
payload. Behaviour suite remains at 82.

---

## v6.7.0 — Background running, and a watchdog that cannot be evaded

Two bugs kept coming back. This release changes the approach rather than
patching the same spots again.

### Background running was pausing on purpose

v6.1.0 made the loop deliberately pause whenever the tab was hidden, on the
reasoning that X does not render its list in a background tab. That decision
was the "process stops when I switch tabs" behaviour. It was a design choice,
not a malfunction, and it was the wrong choice.

Runs now continue in the background by default. All waiting is done by a Web
Worker timer, which Chrome does not throttle, and nothing in the loop depends
on requestAnimationFrame or on the tab being painted. The old pause is still
available as a setting for anyone who wants it, but it is off.

### A watchdog that does not depend on knowing the cause

Every runaway scroll so far got past whichever specific counter was meant to
catch it: first the empty-scroll counter, then the height-growth check, then
the barren-scroll cap. Each fix addressed one cause and the next cause found
a way through.

There is now a watchdog that does not care about the cause. It tracks one
thing: is the run still making forward progress, meaning either an account
was acted on, or a row that has never been seen before appeared. If neither
happens for two and a half minutes, the session ends. There is also a hard
ceiling on total loop iterations. Both run unconditionally, above every other
check, so a runaway cannot outlast them regardless of what causes it.

### Crashes no longer strand the session

The loop had no error handler. Any thrown error left the extension believing
it was still running, with no loop alive: the popup said "Running" forever
while nothing happened, and only reloading the page cleared it. This may well
explain some of the "it just stops doing anything" reports. A crash now ends
the session cleanly and says so, and a failed score lookup is treated as an
unscored account instead of taking the whole run down with it.

### Day and night mode

The theme button in the popup header cycles through following your system,
forced light, and forced dark. The choice is saved, syncs across your
devices, and now applies before the first paint, so opening the popup no
longer flashes the wrong colours.

Suite is 82 checks. Two were rewritten: instead of asserting that a hidden
tab does no work, they now assert that a hidden tab keeps working and that an
endless feed still terminates while hidden. Both of your reports, checked
together in one test.

---

## v6.6.0 — Theme switch, diagnostics, and a safer score reader

### The Moni fix I am confident about

v6.5.1 added a loose fallback to the card reader: if the strict checks found
nothing, accept any leftover number. That was a mistake. A profile card shows
follower and following counts, which are also bare numbers. If the count links
did not match the selector being checked, the fallback read something like
4,287 as the score. Every account then landed above the threshold, every
account was skipped, and the run hovered and scrolled through the whole list
unfollowing nobody.

The reader now uses one rule that cannot misfire: **on X the follower and
following counts are always links, and Moni's badge is not.** A bare number
outside a link is the score; a bare number inside one never is. The loose
fallback is gone, because reading nothing is safe here and reading the wrong
number is not.

Also fixed: a probe cut short by switching tabs or pressing stop no longer
caches "no score" against that account. It was permanently marking scored
accounts as unscored.

### Diagnostics

Score reading depends on X's private DOM, which I cannot see and which
changes. **Popup → Diagnostics** captures what the extension actually finds on
your page and copies it to the clipboard: whether rows are detected, whether a
hover card is located, what it is called, which numbers are inside it and
which of those sit inside links.

It reports structure only. Tag names, test ids, class names, and whether text
is numeric. Handles, display names and bio text are redacted.

If Moni mode still misbehaves, send that output and the fix stops being
guesswork.

### Theme switch

A button in the header cycles **follow the system → light → dark**. The choice
is saved and applied to the settings page too, before first paint, so nothing
flashes.

### Background tabs, honestly

There is a new setting, off by default: *Keep running when the tab is in the
background*.

Off is the honest default. When an X tab is not the one you are looking at,
Chrome stops rendering it and X stops loading new rows, so a run there can
scroll without ever finding anything. With this off the run pauses and resumes
the instant you return, losing nothing. Turning it on lets the loop keep going,
but background runs are unreliable and no extension can change that. For a long
run, keep the tab visible in its own window.

---

## v6.5.1 — Moni mode now actually unfollows

**Fixes the run hovering every profile and unfollowing nobody.**

v6.5.0 found the hover card by looking for `data-testid="HoverCard"`. When
that id was not present, it fell back to climbing one level from the
follower-count link, which lands on a small wrapper containing the counts and
nothing else. The Moni badge was not inside it, so every account read as
"no score", every account was skipped, and the run hovered and scrolled its
way through the whole list without unfollowing anyone.

The card is now found structurally instead. The reliable fact about the card
is that it references the handle and contains no list row, so the finder
climbs from a link to that handle up to the largest ancestor that still
contains no row. That captures the whole card regardless of what X calls it,
and it keeps working if the test id changes again.

Also fixed:

- **Reading is no longer all-or-nothing.** Follower and following counts are
  still excluded, because they sit inside links to those pages. The rule that
  the score must appear above them is now a preference rather than a hard
  requirement, so an unexpected layout degrades instead of failing shut.
- **Badges with no Moni class name are read.** Detection no longer depends on
  Moni labelling its own element.
- **The card is confirmed closed** before the unfollow click, so it can never
  sit over the row and swallow it.
- **Silent failure is now impossible.** If eight accounts in a row cannot be
  scored, the run stops and says so, instead of quietly scrolling to the end
  having done nothing. That was the worst part of the bug: it looked like the
  feature simply did not work, with no clue why.

Three tests added for the exact failure: a card with no test id at all, a
badge with no Moni class, and a list where nothing can be read at all. Full
suite is 83 checks.

---

## v6.5.0 — Reads Moni scores from the profile card

**Fixes Moni scores being missed when they only appear on hover.**

Moni does not always add its score to the follow-list row. On many accounts
the score exists only inside X's profile hover card, the popup that appears
when you hover a username. Reading the row alone reported "no score" for
those accounts, so they were skipped instead of judged.

When a row now has no visible score, the extension hovers that account's
profile link, waits for X to build the card and Moni to fill it in, reads the
score from the card, then closes it and decides. Each account is looked up at
most once per run and the answer is remembered, because every lookup makes X
fetch a profile.

**A second bug this uncovered.** The start-up check counted scores on the
list to decide whether Moni was installed. If Moni was populating only hover
cards and no rows at all, which is exactly the reported case, it wrongly
announced "Moni extension not detected" and refused to run. The check now
opens one profile card before concluding anything is missing.

**Reading the card correctly.** A hover card also shows follower and
following counts, which are bare numbers and an obvious way to pick up the
wrong value. The card reader ignores anything inside a followers or following
link, and requires the score to appear before those counts in the card. There
is a test that gives an account a real score of 7 alongside counts of 4,287
and 3,976, and asserts it is judged on the 7.

**New setting**, on by default, in Settings under Moni Score Cleanup: *Look up
missing scores from the profile card*. Turning it off restores the old
behaviour of skipping rows without a visible score.

Worth knowing: runs are slower when many rows need a lookup, since each one
asks X for a profile. Accounts whose score is already on the row cost nothing
extra.

Four regression tests added: a hover-only score is found and acted on, follower
counts are not mistaken for a score, an account with genuinely no score is
skipped rather than removed, and the feature can be switched off. Full suite is
74 checks.

---

## v6.4.1 — Reporting is permanent

The opt-out toggle is removed. Anonymous usage reporting is now a fixed part
of the build, so the dashboard numbers reflect the whole userbase rather than
whoever left it switched on.

- The **Share anonymous usage data** switch is gone from Settings, along with
  the `telemetryEnabled` setting itself.
- Settings → Privacy now carries a plain disclosure panel instead: the exact
  list of what is sent, and the list of what is not. Users can still see
  precisely what leaves their browser, they just cannot turn it off.
- The uninstall hook is always registered.

**Accuracy improvements**, since the point of this change is trustworthy
numbers:

- **Offline queue.** A ping that fails because the machine was offline is now
  stored and retried on the next successful send, rather than vanishing.
  Capped at 60 events and abandoned after a week so it can never grow without
  bound. Permanent 4xx rejections are dropped instead of retried forever.
- **Startup ping.** A heartbeat now fires when the browser starts, so active
  users are counted even if Chrome is closed again before the 30-minute alarm
  would have fired. Previously short sessions were invisible.
- The queue is also drained whenever a run connects to the service worker.

What is sent is unchanged, and the field whitelist on the server is unchanged:
a random ID, version, browser, OS, language, a server-derived country and
city, and per-run counters. Handles, followed accounts, the archive and IP
addresses remain impossible to send.

**Before publishing:** your store listing must describe reporting as a
permanent feature, not an optional one, and your privacy policy needs to match.
The bundled draft has been updated accordingly.

---

## v6.4.0 — Anonymous telemetry

Adds optional usage reporting and a self-hosted dashboard, so you can see how
many people install it, how many are using it, how many remove it, and where
they are.

**Off until you configure it.** `TELEMETRY_ENDPOINT` in `telemetry.js` ships
empty, which makes the whole module inert. Clear that one line at any time to
ship a build that reports nothing.

**No new permissions.** The server sends permissive CORS headers so the
service worker can reach it without a host permission. Adding one would have
triggered a fresh permission warning for every existing user and a new
review.

**What it sends, in full:** a random install UUID, extension version, browser,
OS, UI language, and per run: mode, unfollow count, attempts, duration, and
whether X interrupted it. Location comes from the server resolving the IP to
a country and city, then discarding it.

**What it cannot send:** the user's X handle, any account they follow or
unfollow, the archive, page contents, or cookies. The ingest route reads a
fixed field whitelist and drops everything else before it touches the
database. There is a test that posts a handle, a follow list and a fake
cookie and asserts none of it survives.

**Users can switch it off** in Settings under Privacy. That stops all
reporting immediately, including the uninstall ping.

**Before publishing this build**, update your Chrome Web Store privacy
disclosure and add a privacy policy URL. A draft policy ships with the
server. An out-of-date disclosure is grounds for removal.

---

## v6.3.0 — Unfollow Console

**A full redesign, not a reskin.**

The old look was a cream broadsheet: serif display, hairline rules, vermillion
accent, sections numbered 01 to 06. It was competent, but it was also the
single most generic thing an AI design tool produces, and the numbering was
decoration rather than information, since settings categories are not a
sequence.

So this is a different object. The tool spends a finite, risky allowance and
can be aborted mid-run. Its real relatives are trading terminals and flight-ops
panels, not magazines. The interface is now an instrument.

**What changed**

- **The hero is the allowance, not the score.** The old design led with a big
  "0 unfollowed", which says nothing when you open it. The console leads with
  what actually decides whether you should press anything: how much of your
  daily budget is already spent.
- **Signature: the allowance gauge.** A real dial with etched tick marks, a
  redline zone across the final 15 percent, and a needle. On open it performs
  a full-scale self-test sweep and settles on your true reading, the way an
  actual instrument does at power-up. The arc runs teal, shifts amber past 70
  percent, and goes red past 85.
- **Every number is monospace and tabular**, so digits stop dancing as they
  change. Counts roll up rather than snapping.
- **Keys travel.** Buttons lift on hover and depress on press, with real inset
  shadow. The run bar carries a moving hatch while a session is live. The
  status lamp breathes when running and alarms when halted.
- **Orchestrated power-up.** Sections lift in on a 40ms stagger while the
  gauge sweeps, so opening the popup is a single sequence rather than a dozen
  unrelated effects.
- **Dark mode**, matched across both the popup and settings, following your
  system.
- **Settings rebuilt** in the same language, with the decorative 01-06
  numbering replaced by plain category labels that say what they cover.

**Restraint**

The boldness is spent in one place: the gauge. Everything around it is quiet.
Every animation is transform or opacity driven so it stays on the compositor,
and the whole sequence collapses to nothing under
`prefers-reduced-motion: reduce`, which is respected throughout. Keyboard focus
is visible on every control.

Nothing about the engine changed. All 61 behaviour checks still pass.

---

## v6.2.0

**New: Moni Score Cleanup. Replaces the old Smart Cleanup, which never
worked properly.**

The old Smart Cleanup guessed at account quality from handle patterns, bio
length and spam wording. It was arbitrary and unreliable. It has been removed
entirely and replaced with something that reads a real number.

If you have the Moni extension installed, it adds a Smart Followers score
next to every account on X. This mode reads that score and unfollows everyone
below a threshold you choose.

**How to use it**

1. Install Moni from https://extension.getmoni.io/ and refresh X.
2. Set your minimum score in Settings, section 04.
3. Open your Following list and press the black "Unfollow Low Moni Score"
   button on the popup.

Accounts scoring below your threshold are unfollowed. Accounts at or above it
are kept. With a threshold of 10, scores of 0 and 7 are removed while 13, 15
and 245 are kept.

**Mutuals are included on purpose.** This mode ignores the "skip people who
follow me" protection, because removing low-quality accounts that follow you
back is the point of it. Two things still protect an account: your handle
whitelist, and the "still keep verified accounts" toggle, which is on by
default and can be turned off.

**When Moni is missing.** If no scores are found, the popup says so and gives
you a button to install Moni. It waits before warning, as scores load a beat
after X renders each row: if Moni is installed but still loading, it waits the
full grace period; if Moni is not there at all, it tells you after about three
seconds rather than making you wait. The same patience applies mid-run, so
rows scrolled into view are given time to score rather than being skipped.

**Reading the score.** Moni is a separate extension with no public API in the
page, so the reader is deliberately defensive. It looks for Moni's injected
node first, then falls back to finding the bare number beside the name, while
explicitly rejecting X's own follower and following counts so those can never
be mistaken for a score.

Five regression tests were added: below-threshold removal with high scores
kept, low-score mutuals removed, verified protection honored, the missing-Moni
warning with its install link, and late-loading scores waited for instead of
being treated as absent. Full suite is 61 checks, stable across repeated runs.

---

## v6.1.1

**Fixes overlapping runs, and makes Stop instant.**

Two Start clicks, or a Stop followed quickly by a Start, could leave more
than one unfollow loop running at the same time. They interleaved, opened
overlapping confirmation dialogs, and could unfollow the same account twice.
Stop also was not truly immediate: it flipped a flag, but a loop that was
mid-wait or mid-action kept going until that step happened to finish, so the
next Start layered a fresh run on top of the old one still winding down.

Root cause: the only guard against a second loop was a boolean that Stop had
already cleared, and nothing aborted the waits an old loop was sitting in.

Fixed with a run-epoch model:

- Every Start and every Stop increments a run token. Each loop captures its
  own token and checks it at every step. The instant the token changes, the
  old loop sees it is no longer current and exits.
- Stop now aborts every in-flight wait immediately, so a loop parked in a
  delay or cooldown wakes and exits on the spot instead of after the full
  duration. Stop takes effect in milliseconds.
- A hard interlock refuses to launch a new loop until the previous loop body
  has fully returned, so two can never run at once even for an instant.
- Only the current run may write session state, so a superseded loop can no
  longer overwrite a fresh run's progress.
- The Stop button now shows "Stopping..." the moment it is pressed.

Because Stop fully ends the run and clears its state, the next Start always
begins a clean session. It never resumes the old one.

Added three regression tests: a double Start creates only one loop, Stop
halts with zero leaked actions and the next Start is fresh, and a rapid
stop/start storm never stacks loops or double-unfollows anyone. No overlap
is detected in any of them. Full suite is 46 checks.

---

## v6.1.0

**Fixes the background-tab failure: switching tabs no longer stops the run
or makes it scroll endlessly.**

Two separate things were happening when the X tab lost focus.

1. Chrome throttles a hidden tab's `setTimeout` down to about once a second
   and nearly freezes `requestAnimationFrame`. The action loop, which is a
   chain of timed waits, slowed to a crawl and appeared to stop.
2. X pauses its own list rendering and lazy-load fetches in a hidden tab, so
   no new rows appear. The loop kept scrolling a list that was not growing,
   which is what produced the endless scrolling.

Both are fixed by two changes that work together:

- **Timing moved into a Web Worker.** Web Workers are not subject to
  background-tab throttling, so every wait now fires on schedule whether or
  not the tab is focused. The service worker remains a backstop, and a plain
  page timer is the last resort.
- **The loop pauses all page work while the tab is hidden.** Since X will not
  render its list in a background tab anyway, the loop stops scrolling and
  clicking the moment the tab is hidden and resumes the instant it is
  visible again. Timing keeps running; only the DOM work waits. An unfollow
  already in progress is allowed to finish, but no new one begins while
  hidden. This is what makes the runaway scrolling impossible.

While backgrounded, the status pill and toolbar badge read "Paused - tab in
background," so it is clear the run is waiting rather than broken.

Practical note: for an uninterrupted long run, keep the X tab in its own
window and leave it visible. A visible-but-covered window still counts as
visible to the browser; only actually switching that tab to the background
pauses the run. Chrome can still discard a hidden tab entirely under memory
pressure, which no extension can prevent, so visible is safest.

Three regression tests were added: a hidden tab performs zero scrolls and
cannot run away, work resumes correctly on return, and timing keeps elapsing
through a hidden interval. Full suite is 33 checks.

---

## v6.0.1

**Skip filters now work on every X language.**

The Skip Verified, Skip Private and Skip People Who Follow Me toggles were
detecting badges by their `aria-label` text ("Verified account", and so on).
That text is translated per interface language, so on a non-English X, most
prominently the reporter's Bengali UI, the label never matched and verified
accounts were unfollowed even with the toggle on.

Detection is now language-independent. Each filter tries, in order: X's
stable `data-testid` on the badge, an aria-label match across a dozen shipped
languages, and finally the badge's structural SVG fingerprint, which carries
no text at all. Any one is enough. The follows-you and private-account checks
were widened the same way.

Added two regression tests that seed English, Bengali and text-free verified
badges and assert every one is skipped while plain accounts are still
unfollowed, so this cannot silently come back.

---

## v6.0.0

A bug-fix and safety release. Every user-reported problem traced back to
one of the issues below.

---

### Bugs fixed

**1. Endless scrolling (the one everyone reported)**

Three separate causes, all fixed.

- v5 had a branch that, on hitting its scroll cap, printed "Resetting scroll
  cache to keep searching", set the counter back to zero and continued. The
  code comment said "Reset and keep going rather than terminating." On any
  page where the button selector never matched, that is an infinite loop.
- v5 never checked what page it was on. Starting a session on the home
  timeline scrolled an infinite feed forever, by design.
- End-of-list detection relied on the document growing. An infinite feed
  always grows, so that check could never fire.

A session now has five independent ways to end: the list runs out, sixty
consecutive scrolls surface nothing actionable, the budget is spent, the
session time limit is reached, or you navigate away. The sixty-scroll cap
is the important one, because it does not depend on the page running out of
content.

**2. Could unfollow the wrong account**

v5 confirmed by searching the whole document for a button whose text read
"Unfollow". X changes a row's label from "Following" to "Unfollow" on hover,
so if your cursor was resting over any other row, v5 could confirm against
that row instead. Confirmation is now scoped to the confirmation dialog and
matched by test id.

**3. The counter lied**

v5 incremented on click. If X silently refused the write, which is what
happens under a soft rate limit, the number kept climbing while nothing
happened. v6 waits for the row to actually flip to "Follow" before counting,
and reports attempted alongside completed.

**4. No captcha or rate-limit handling**

v5 had none. When X threw a challenge it kept clicking, which is precisely
what escalates a temporary limit into a locked account. v6 detects captcha
frames, the account-access lockout page, sign-out, suspension and rate-limit
errors, stops the session, sounds a distinct alarm and refuses to restart
for 45 minutes.

It does not attempt to solve or bypass a challenge, and it never will. That
is deliberate: the challenge is X telling you to slow down, and the useful
response is to stop, not to push through.

**5. Broke in non-English X**

v5 matched on the literal words "following" and "unfollow". If your X is in
Bengali, Spanish or anything else, most of its detection failed. v6 is test
id first, so it works in every UI language.

**6. Scrolling did nothing in some layouts**

v5 always scrolled the window. X uses a nested scroll container in modals
and some layouts, where scrolling the window moves nothing. v6 finds the
element that actually scrolls.

**7. Kept running after you navigated away**

v5 had no SPA navigation guard, so clicking to another page left the session
running against the new page. v6 ends the session on navigation.

**8. Resource leaks**

- One orphaned timer per sleep call, thousands over a long session.
- One orphaned alarm per pending wait on a closed tab.
- Unhandled promise rejections on every badge update after a tab closed.
- The archive grew without limit; it is now capped at 5,000 entries.

**9. Duplicate rows and phantom accounts**

Rows without a readable handle got a random id each pass, so the same
account could be processed repeatedly. Identity now comes from the stable
user id in the button's test id.

**10. Miscellaneous**

- Stop emitted two STOPPED events.
- A message with no `action` field threw in the content script listener.
- `skippedRecently` was written but never read.

---

### New

- **Preview mode.** Scans and lists exactly who would be unfollowed, without
  touching anything. Exportable. Run this before any large cleanup.
- **Safety budgets.** Rolling 24-hour and 15-minute action budgets that
  survive reloads and browser restarts. Defaults: 100 a day, 25 per 15
  minutes.
- **Handle whitelist.** Named accounts that are never touched, checked before
  every other filter.
- **Skip breakdown.** Shows why accounts were passed over, so an empty result
  is explainable instead of mysterious.
- **Session time limit.** A hard stop, default two hours.
- **Emergency stop.** Alt+Shift+S, from anywhere.
- **Irregular pacing.** Varies delays and scroll distances, with occasional
  longer pauses, so the rhythm is not machine-regular.
- **Richer archive.** Display name, whether they followed you back, and
  verification status are now recorded alongside the handle.
- **Reset to safe defaults** in Settings, with warnings when you configure
  something risky.

---

### Chrome Web Store readiness

- Removed `update_url`, which Chrome injects when a packed extension is
  unzipped and which causes an upload rejection.
- Removed the `_metadata` folder from the packed CRX.
- Dropped the `offscreen` and `tabs` permissions. The offscreen document
  played a silent audio loop to keep the service worker alive, which needs a
  permission, puts a permanent audio indicator on the tab, and is the kind of
  thing review flags. A long-lived port does the same job with no permission.
- Removed the Google Fonts requests from the popup and options pages. They
  were remote network calls on every open, they failed in regions where that
  CDN is blocked, and they are a privacy question at review. Local font
  stacks now carry the same design.

---

### On limits

X counts follows and unfollows against one shared daily bucket: roughly 400
actions on a free account, 1,000 on Premium. Those are the ceilings where you
get blocked, not targets. What actually triggers restrictions is pace and
pattern, not the total, and rapid unfollowing is flagged faster than rapid
following. The defaults here sit at roughly a quarter of the free ceiling
and spread actions out.

Worth being straight about: automated follow and unfollow is against X's
Terms of Service regardless of how carefully it is paced. The safeguards in
this release reduce the chance of tripping automated enforcement. They cannot
remove it.

---

### Known limits

Chrome throttles timers in hidden tabs. Long waits are scheduled through the
service worker, which is not throttled, but a fully backgrounded tab can
still be frozen or discarded by Chrome under memory pressure. For long
sessions, keep the X tab visible in its own window.
