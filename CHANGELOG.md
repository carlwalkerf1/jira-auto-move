# Changelog

All notable changes to the **CSUP Auto-Move** userscript. Newest first.
The version here matches the `@version` in `jira-auto-move.user.js`; bumping it is
what triggers Tampermonkey to auto-update everyone.

## Docs — 2026-08-26 (no version bump, page only)
- Documented a known limitation: **images embedded in PSE comments don’t carry over**
  into PSE Notes after a move (text/links do). Confirmed on FE-37231 — the comment’s
  media IDs weren’t attached to the destination issue, so Jira shows “Preview
  unavailable.” Description images are unaffected (those are issue attachments, which
  do move). Added to the rules page’s “Possible future features” as a long shot.

## v3.21 — 2026-09-02
- **Reporter fallback to self on an unassigned CSUP.** If the CSUP had no assignee (the
  PSE forgot to assign it to themselves before moving), Reporter on the destination now
  falls back to whoever ran Auto-Move, instead of being left unset. Applies to both the
  FE and CLOUD/Operations routes. Toggle: `REPORTER_FALLBACK_TO_SELF`.

## v3.20 — 2026-09-02
- **Re-enabled stamping the "Original Ticket" field** on FE-bound moves (disabled since
  v3.16). Restores the queryable source-ticket link, and doubles as an invisible signal
  for adoption tracking — no visible label needed.

## v3.19 — 2026-08-24
- **Field-fix banners now open the PSE tab.** When a move is blocked because a required field
  is missing — Bug or Customer Impact (any FE move), or Bug on a Mobile/EEM CSUP — Auto-Move now
  jumps you to the PSE tab so you can fill it in, matching the blank/PLT/Infosec/unlisted cases.

## v3.18 — 2026-08-21
- **"Keep this tab focused" guard.** Switching browser tabs mid-move can stall the wizard
  (browsers throttle background tabs and block focus), sometimes with no visible error. The
  progress badge now reminds you to stay on the tab while a move runs, and a breadcrumb
  records if the tab was backgrounded during a move (so a failure report shows it). Added a
  matching tip to the rules page.

## v3.17 — 2026-08-21
- **"Move Back" cleanup tool (private, maintainer-only).** A hotkey (`Ctrl+Shift+B`) on an FE
  issue moves it back to a CSUP as "Customer Issue - Dynamic" (fewest required fields), after a
  confirm — for re-testing/cleaning up test tickets without creating new CSUPs. It's **account-
  gated**, so it's invisible and inert for everyone else (no button; hotkey only). Deletion of
  the resulting CSUP stays manual.

## v3.16 — 2026-08-21
- **Stopped stamping the "Original Ticket" field.** Jira already keeps the pre-move
  CSUP key as a permanent redirect and in the issue history, and nobody queries the
  field — so it was redundant. (`STAMP_ORIGINAL_TICKET` is now `false`.)

## v3.15 — 2026-08-21
- **Bug and Customer Impact are now required *before* an FE-bound move.** If either is
  empty on the CSUP, the move is blocked with a banner asking you to fill them in first
  (previously they were nagged about *after* the move). Post-move reminder is now just
  Escalated? and Regression.
- **EEM / Mobile issue-type mapping:** Bug = **Yes or TBD → Bug**; only Bug = **No → Non-Deploy**
  (TBD used to go to Non-Deploy).

## v3.14 — 2026-08-21
- **"Customer Issue - Dynamic" (Signal) CSUPs are not supported.** The Auto-Move button is
  hidden on them, and the keyboard shortcut refuses with a note. Everything assumes the
  "Customer Issue - Firstup" type.

## v3.13 — 2026-08-20
- **Stability / diagnostics.** Added a breadcrumb trail of what the tool did (and why it
  bailed), folded into the "Send to Carl" failure report so previously-silent hiccups are
  diagnosable. Added a "page is still loading — try again" banner when triggered before the
  issue view is ready, instead of silently doing nothing.

## v3.12 — 2026-08-19
- Friendlier, PLT-specific and unlisted-team banner copy (dropped the appended "supported
  teams" list).

## v3.11 — 2026-08-19
- Friendlier blank-team, EEM/Bug-blank, and Infosec-specific banner copy. Added a
  "Guidance & error messages" table to the rules page.

## v3.10 — 2026-08-19
- **CLOUD / Operations route** now sets the Reporter to the previous assignee, then
  unassigns (after IT granted the Reporter permission on Cloud Operations).

## Earlier (pre-3.10, summarized)
- Began as a one-click **CSUP → Firstup Engineering / Bug** move for the classic Jira Move
  wizard, plus a `Ctrl+Shift+M` shortcut and a floating button shown only on CSUP issues.
- Grew into a **routing engine** keyed on **Primary Engineering Domain Team**: standard
  teams → FE/Bug with field auto-populate; **Operations** → Cloud Operations / Story;
  **EEM** → FE Bug or Non-Deploy (by the Bug field); **PLT / Infosec / blank / unknown** →
  guidance banners (and the PSE tab).
- Post-move field population via the Jira REST API as the current user; copies the
  description into the "CSUP ticket" field; captures PSE-restricted comments before the
  move and offers them for "PSE Notes" after.
- Distribution via **github.com/carlwalkerf1/jira-auto-move** (Tampermonkey auto-updates on
  a `@version` bump) with a public GitHub Pages rules page.
