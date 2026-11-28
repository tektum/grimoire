# Phone-viewport audit of the web client (apps/web), origin/main f3d6ada2

## How it was measured

- Spec: `apps/web/test-e2e/mobile-audit/` (`mobile.spec.ts` with `audit.ts` and `world.ts`; also `overlay.spec.ts`, `scroll-lock.spec.ts`, `debug.spec.ts` for the follow-up checks). All of it runs green in one Chromium run: `E2E_WEB_PORT=4391 bunx playwright test -c playwright.config.ts --project=chromium test-e2e/mobile-audit` gives 49 passed. The spec asserts only that `(pointer: coarse)` matches. Everything else is recorded, not asserted.
- Contexts: `hasTouch: true, isMobile: true`, 390x844 and 320x568, DPR 1, light and dark via `emulateMedia`. The interface font is Liberation Sans, as in the other screenshot specs, because this machine's default sans is monospace.
- Data: the stand-in API helpers (`mockApi`, `adminApi`, `historyApi`, `scriptedSearch`, `scriptedImports`). A shared world has 3 collections (one long name), a 4-deep tree, a page with a 5-column table, a long URL and a code block, and 5 users with long names. The slash menu and selection bubble were tested against an in-process `@hocuspocus/server` that accepts any token. Nothing listens on the default stand-in collab address, so the page screen otherwise shows the saved text, "Connecting…".
- Raw numbers: `.scratch/results/*.json`, one file per route and width plus `surfaces-*` and `overlay-*`. Screenshots: `test-results/shots/mobile-audit/` (160 files; see the end).
- Environment problem found and fixed (not app code): the prepared `apps/web/dist` was broken. Every page threw `Failed to resolve module specifier "@tektum/grimoire-core/version"` and rendered nothing, because `packages/*/dist` had never been built. I ran the root `bun run build` (`tsc -b`, gitignored output), then `bunx vite build --mode e2e`. Port 4173 was held by an orphaned `serve.mjs` from my first, killed run. I killed it and used `E2E_WEB_PORT=4391`.
- Tap-target rule: each visible `a, button, [role=button|menuitem|tab|treeitem|option|radio|checkbox], input, select, textarea, summary` must be at least 44x44 CSS px. A radio, checkbox or file input is measured together with its label. A text field or select counts by its own box. Links inside a sentence of a `<p>` count as inline (exempt under WCAG 2.5.8) and are listed separately. The off-screen skip link is excluded.

## The design review's points (Main), each confirmed or refuted

| # | Claim | Verdict | Numbers |
|---|---|---|---|
| 1 | /admin/groups?group= coverage missing | Covered | `admin-groups-{390,320}-{light,dark}.png`. 0 px overflow at both widths. 17 of 20 targets are under 44 (see table). |
| 2 | Access table likeliest to overflow at 390 | Half confirmed | The page does not scroll sideways: scrollWidth equals clientWidth at both widths. The table is 480 px wide inside `div.admin-scroll` (overflow-x: auto), which is 366 px wide at 390 and 296 px at 320. The Remove column is fully outside the visible box at both widths, with no scrollbar or other cue on a phone. At 320 the "Can" selects are cut to "read a". Columns measure 182/55/141/102 px. |
| 3 | /import (idle, progress, report), /help, history (list, revision, diff), not-found at 390 and 320 | Covered | All have 0 px overflow except the revision screen: 614 px at 390, 683 px at 320 (defect 1). The diff tab wraps and has 0 px overflow. |
| 4 | /collections/new at 390 | Covered | 0 px overflow. "Create collection" is 138x32, "Cancel" 44x21, radio rows 366x36 with their labels, name field 366x42. |
| 5 | Admin users: "Role" on its own line, ~110 px per user, select not aligned with Suspend | Refuted (in this build) | The "Role" word sits on the same row as the select: word top 55, select top 49, height 32. Blocks are 94 px tall, or 119–121 px when the name or email wraps or there is a "Suspended" chip. The centre-line offset between the role select and Suspend/Reinstate is 0 px at 390 and 320. |
| 6 | Admin role select and Suspend/Reinstate ~31 px | Confirmed (32 px) | Role selects are 90x32, Suspend 89x32, Reinstate 93x32. Also under 44 on admin screens: search field 280x39, Search 78x39, Users/Groups tabs 39x21 and 46x21, group links 93x21 and 225x21, Rename 87x32, Delete 74x32, Remove 86x32, Create group 116x39, Find 61x39, access selects 125x32, 136x32, 93x32, 127x32. Every input, select and button on the three admin screens is under 44 px tall. |
| 7 | Trash Restore ~31 px | Confirmed (32 px) | "Restore Plan for May" is 83x32 at 390 and 320. |
| 8 | Reset dialog: buttons ~32 px; no close affordance but Close; fits 320x568? | Confirmed (32 px); fits | "Reset state" 105x32, "Close" 70x32. The dialog has exactly 2 buttons and no corner X (whether Escape closes it was not checked). On a page that fits the phone it fits without scrolling: 294x424 at left 13, top 114, bottom 538 in 320x568, and 359x403 in 390x844. On a page wider than the phone it is pushed off the right edge: 54→412 at 390, 86→380 at 320 (defect 1b). Stale confirmation: Cancel 78x32, "Reset anyway" 122x32. |
| 9 | Collection switcher rows 28 px, no affordance | Height refuted (37 px); affordance confirmed | The rows are `<a>`, 366x37 at 390 and 296x37 at 320, still under 44. Only the current row has a fill (white). The other rows have a transparent background, no underline, border or chevron, so they read as plain text (`collection-390-light.png`). |
| 10 | Palette: two ellipses in the breadcrumb ("Team han… / … / …") | Refuted (in this build) | That trail is the shell breadcrumb behind the palette in the committed shot, not the palette. In the palette, every row has 0 "…": labels and path are not cut, and the path "Runbooks and incident response" wraps under the label. The phone bar already uses the collapsed form (back chevron and parent only; the other parts are 1 px and screen-reader only). Its one segment is cut: 168 of 189 px at 390, 98 of 189 px at 320, and with no visible ellipsis (defect 4). Separately, on the page screen used for the shot the palette sits 26 px off the right edge at 390 (left 50, right 416) and 63 px at 320 (left 83, right 383), because the page behind it is wider than the screen (defect 1b). On a page that fits it is 367 px at left 12 at 390 and 301 px at left 10 at 320. |
| 11 | Page top bar: contents, actions, search each ≥ 44 and no overlap at 320 | Confirmed, with one correction | Contents toggle 44x44 at x 16–60, page actions "···" 44x44, account "Show menu" 44x44, parent link 168x44 at 390 and 98x44 at 320. No pair of controls overlaps at either width (390: 16–60, 87–254, 270–314, 330–374; 320: 16–60, 87–184, 200–244, 260–304). Correction: there is no search button in the phone bar. Search lives in the contents drawer, where `.contents-search` is 44 px tall under coarse pointer, and in the account menu ("Search" link, 41x44). |
| 12 | Routes that scroll sideways at 320 | Measured | Only `/p/:slug` (146 px, from `table`, right edge 466) and `/p/:slug/history/:rev` (683 px, from `a` with the URL, right edge 1003, and `table`, right edge 466). Every other route has 0 px at 320 and 390. |

## Ranked defects (visible and reproducible from the measurements)

1. **Page text wider than the phone: tables and unbroken URLs; the revision view does not wrap URLs.** Routes: `/p/:slug`, `/p/:slug/history/:rev`.
   - Evidence: `/p/:slug` has scrollWidth 466 against 390 and 320 (overflow 76 and 146 px). The cause is a 5-column table (454 px min-content) with no scroll wrapper. `/p/:slug/history/:rev` has scrollWidth 1004 and 1003 (overflow 614 and 683 px). The cause there is the long URL: `a`, 991 px wide, in a `p` 366 px wide; the live page wraps the same URL. The table adds to it on both screens. On first paint the URL and the table run off the right edge (`verify-revision-firstpaint-390-light.png`). The layout viewport grows to 466 and 1004 px (`window.innerWidth`), so the whole screen pans sideways, sticky bar included.
   - Why it matters: it fails WCAG 1.4.10 reflow at 320. Any table of 5 or more short columns triggers it on every page. It also causes 1b.
   - 1b. **On such a page, every overlay and menu breaks the layout.** The dialog library's scroll lock (react-remove-scroll-bar) treats the extra width as a scrollbar. It injects `body[data-scroll-locked] { margin-right: 76px !important }`, i.e. innerWidth 466 − clientWidth 390, recorded in `.scratch/results/390-scroll-lock.json`.
     - Measured effects: with the page-actions menu or reset dialog open, `main` shrinks from 390 to 314 px at 390 and from 320 to 174 px at 320, and the bar wraps to 89 px. On the revision it shrinks to 24 px and the bar becomes 177 px.
     - Where the overlays land: the palette at 50→416 (390) and 83→383 (320); the reset dialog at 54→412 and 86→380; the restore confirmation at 323→681 (390) and 354→649 (320). At 320 the restore confirmation is entirely off-screen (`surface-restore-confirm-320-light.png` shows only the collapsed page; `overlay-wide-restore-390-light.png`).
     - Control: with the same page minus the table and URL (`overlay.spec.ts`, "clean"), every overlay fits at both widths and `main` keeps its width (`overlay-clean-*`).
     - Why it matters: on any page with a wide table, an admin on a phone cannot see Restore or Reset, and any menu turns the page into a one-word-per-line column (`overlay-wide-menu-320-light.png`: "Quarterl / y plan").
2. **Admin access table hides its Remove column off to the right with no affordance.** Route: `/admin/collections/:id/access`.
   - Evidence: table 480 px in a scroll box 366 px (390) or 296 px (320). The Remove buttons sit at x ≥ 390, outside the box; the "Can" selects are cut at 320 ("read a"). `admin-access-{390,320}-light.png`. The page itself does not overflow.
   - Why it matters: removing someone's access needs a sideways swipe on an unmarked region. The column header "Remove" is not visible either.
3. **Sub-44 px touch targets on the main actions of most screens.** All routes. Strict list: the 44 px coarse-pointer rule, non-inline elements only.
   - Admin: everything listed in point 6.
   - Trash: Restore 83x32.
   - History list: "Open" 34x21, the only way to open a version; "Back to Quarterly plan" 139x16.
   - Revision: "All versions" 72x16, "Restore this version" 158x32, tabs Text 62x32 and Changes 90x32.
   - Search: Search button 78x32, field 39; result titles are 16 px tall links (e.g. "Product roadmap" 116x16).
   - New collection: Create 138x32, Cancel 44x21, radio rows 36.
   - Import: Import 74x32, Cancel import 120x32, "Import another file" 147x32, "Download source" 142x32, report disclosures (`summary`) 188x21, collection select 42, file chooser 141x42, radio rows 42.
   - Login: User id / Role / Secret 36, Sign in 39.
   - Not-found: "Go to your collections" 135x16.
   - Collection switcher rows: 37.
   - Contents drawer: collection link "Dev" 40x28.
   - Account menu: Search 41x44, Trash 33x44 (wide enough only in height).
   - Palette rows: "Plan for May" and "See all results" 36 tall.
   - Only the shell bar, the tree rows (44, the row activates the page), the drawer Search button and the bubble buttons (44) meet the rule.
   - Why it matters: the project's own `(pointer: coarse)` rule covers the bar only. Every in-screen control is 32 px (`button` padding) or less.
4. **The bar's parent link is cut mid-word with no ellipsis.** Routes: `/p/:slug`, history, revision at 390 and 320.
   - Evidence: the `a` measures 168 of 189 px at 390 and 98 of 189 px at 320. It has `text-overflow: ellipsis`, but it is `display: inline-flex` (the coarse-pointer and phone rules make it a 44 px flex box), and ellipsis does not apply to a flex container's text.
   - On screen it reads "‹ Runbooks and in" with no "…" (`verify-page-breadcrumb-320-light.png`, 3x crop) and "Runbooks and incident respo" at 390. The DOM check reported "cut with ellipsis" because the property is set; only the screenshot shows it is not drawn.
5. **The slash menu runs off the bottom of a 568 px-tall screen.** Route: `/p/:slug`, live editor, 320x568.
   - Evidence: `div.slash-host` spans top 265 to bottom 585 (320 px tall) against a 568 px viewport, so the last visible row is cut (`surface-slash-menu-320-*.png`). It neither flips above nor shrinks.
   - On a real phone the on-screen keyboard takes another ~250–300 px, so this gets worse [INFERENCE: no keyboard in emulation].
6. **No `scroll-padding-top` for the 45 px sticky bar outside page text.** Routes: `/search`, `/import` report, `/admin/collections/:id/access`, `/help` at 320.
   - Evidence: `scrollIntoView({block:'start'})` on a heading puts its top at 0 to 14 px, under the 45 px bar ("Editing together" 0, "Search" 0, "Access to Dev" 14, "Pages that still hold HTML" 0).
   - Page text has `scroll-margin-top`, so `/p/:slug` is fine (top 225 and 319 against bar 45).
   - Why it matters: focus moving backwards (Shift+Tab), find-in-page and hash links can land a target under the translucent bar (WCAG 2.4.11). It is minor: help has no in-page anchors today.

## Cosmetic nits (visible, not breaking)

- Admin groups at 390: in the "Platform team" row, Rename sits on the name line and Delete wraps alone to the next line. At 320 both buttons share their own row. The wrap point is inconsistent (`admin-groups-390-light.png`).
- Search screen: the field is 39 px tall and the Search button beside it 32 px, so their heights visibly differ (390). The admin search field and button match (39/39).
- The page-actions "···" button always shows the default button border, a 44x44 outlined box, while the contents toggle and avatar beside it are borderless when closed. It reads as pressed in every page shot.
- The account menu has an empty band above "Search / Trash". The links are 13 px text in ink-2 (contrast 7.18 light, 6.7 dark, fine) with no list or row styling, so they look like captions rather than links.
- Opening the account menu while the contents drawer is open leaves both open (`surface-account-menu-*`). The menu overlays the tree.
- The revision screen's breadcrumb shows only "‹ Runbooks and incident response"; the same cut-without-ellipsis as defect 4 applies at 320.
- The skip link is 140x40 when focused (under 44).

## What the DOM checks missed and only the screenshots showed

- Defect 4: the ellipsis property is set but not drawn.
- Defect 1b: no element "overflowed" in the menu-open state (scrollWidth equals clientWidth inside the lock). The collapse shows only in the screenshots and in `main`'s width. The palette's measured box looked plausible until compared with the visual viewport.
- The groups Rename/Delete wrap inconsistency and the "···" border (no metric flags them).
- Light and dark: geometry is identical in every pair (layout does not depend on theme). In the dark shots I found no text that disappears or collides.

## Not testable here

- A real on-screen keyboard: slash menu and bubble placement under it, and `visualViewport` resize on focus.
- Native selection handles and the OS copy/paste toolbar against the bubble. The bubble (236x44, top 226) opens just below the selected line, where Android puts its teardrop handles [INFERENCE].
- iOS Safari (WebKit was not run) and real-device momentum or sideways panning.
- Live collaboration (presence avatars in the bar at 320, remote cursors). The stand-in server has one user, so presence never shows and the bar was measured without avatars. With 2+ people the bar at 320 has 0–16 px to spare (controls end at 304) [INFERENCE].
- The page screen with the real stack's saved/synced states other than "Connecting…" and "Saved".

## Screenshot inventory (test-results/shots/mobile-audit/)

- 68 route shots: 17 visits (every STOPS route; /import as idle, progress and report) × 390/320 × light/dark, named `<slug>-<390|320>-<light|dark>.png`. Full page: a page wider than the phone is captured at its full width (466 or 1004 px).
- 24 phone-control shots: `{page,collection,admin-users}-{contents,menu}-open-*`.
- 40 surface shots: `surface-{contents,palette,account-menu,page-actions,reset-dialog,reset-stale,revision-diff,restore-confirm,slash-menu,selection-bubble}-{390,320}-{light,dark}.png`.
- 20 clean-versus-wide overlay comparisons: `overlay-{clean,wide}-{menu,reset,reset-stale,palette,restore}-{390,320}-light.png`.
- 8 verification captures: `verify-*`, at DPR 3.
- Reviewed by eye: every route and surface at both widths in at least one theme, the dark variant of most, and all overlay and verify captures. The remaining dark copies have the same geometry by measurement.

## Per-route measurements

Overflow = documentElement.scrollWidth − clientWidth. "Offending" lists the outermost visible elements whose box leaves the viewport and that are not clipped by a contained scroll box. "Sticky bar" covers headings under the bar after scrolling 400 px, plus `scrollIntoView` of the first heading below the fold. "Phone controls" gives each toggle's size, whether its panel fits, and the page overflow while it is open.

### login: /login

| vp | overflow px | offending elements | sub-44 targets (non-inline / all) | clipped / scrolling boxes | sticky bar overlap | phone controls |
|---|---|---|---|---|---|---|
| 390 | 0 (sw 390/cw 390) | - | 4/4: User id (308x36); Roleadminmemberviewer (308x36); Secret (308x36); Sign in (308x39) | - | - | contents: absent; menu: absent |
| 320 | 0 (sw 320/cw 320) | - | 4/4: User id (238x36); Roleadminmemberviewer (238x36); Secret (238x36); Sign in (238x39) | - | - | contents: absent; menu: absent |

### home: /

| vp | overflow px | offending elements | sub-44 targets (non-inline / all) | clipped / scrolling boxes | sticky bar overlap | phone controls |
|---|---|---|---|---|---|---|
| 390 | 0 (sw 390/cw 390) | - | 3/6: Dev (366x37); Engineering handbook and runbooks (366x37); Private (366x37) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Dev': top 196 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w390, page overflow 0; menu: 44x44, panel fits w374, page overflow 0 |
| 320 | 0 (sw 320/cw 320) | - | 3/6: Dev (296x37); Engineering handbook and runbooks (296x37); Private (296x37) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Dev': top 196 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w320, page overflow 0; menu: 44x44, panel fits w304, page overflow 0 |

### collections-new: /collections/new

| vp | overflow px | offending elements | sub-44 targets (non-inline / all) | clipped / scrolling boxes | sticky bar overlap | phone controls |
|---|---|---|---|---|---|---|
| 390 | 0 (sw 390/cw 390) | - | 6/9: Name (366x42); Everyone in the workspace can edit (366x36); Everyone in the workspace can read (366x36); Only people you give access to (366x36); Create collection (138x32); Cancel (44x21) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'New collection': top 61 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w390, page overflow 0; menu: 44x44, panel fits w374, page overflow 0 |
| 320 | 0 (sw 320/cw 320) | - | 6/9: Name (296x42); Everyone in the workspace can edit (296x36); Everyone in the workspace can read (296x36); Only people you give access to (296x36); Create collection (138x32); Cancel (44x21) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'New collection': top 61 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w320, page overflow 0; menu: 44x44, panel fits w304, page overflow 0 |

### collection: /c/:collectionId (/c/c1)

| vp | overflow px | offending elements | sub-44 targets (non-inline / all) | clipped / scrolling boxes | sticky bar overlap | phone controls |
|---|---|---|---|---|---|---|
| 390 | 0 (sw 390/cw 390) | - | 3/6: Dev (366x37); Engineering handbook and runbooks (366x37); Private (366x37) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Dev': top 196 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w390, page overflow 0; menu: 44x44, panel fits w374, page overflow 0 |
| 320 | 0 (sw 320/cw 320) | - | 3/6: Dev (296x37); Engineering handbook and runbooks (296x37); Private (296x37) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Dev': top 196 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w320, page overflow 0; menu: 44x44, panel fits w304, page overflow 0 |

### page: /p/:slug (/p/quarterly-plan-abc123)

| vp | overflow px | offending elements | sub-44 targets (non-inline / all) | clipped / scrolling boxes | sticky bar overlap | phone controls |
|---|---|---|---|---|---|---|
| 390 | 76 (sw 466/cw 390) | table 'Owner Area Status Due Notes Al' w454 L12 R466 | 1/7: Quarterly plan (219x36) [+1 inline text links, exempt] | a 'Runbooks and incident respon' cut with ellipsis 168/189; pre 'const result = await client.' scrolls sideways 364/816 | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 1 heading(s) under bar; scrollIntoView 'Notes': top 225 vs bar 45 ok | contents: 44x44, panel fits w390, page overflow 76; menu: 44x44, panel fits w374, page overflow 76 |
| 320 | 146 (sw 466/cw 320) | table 'Owner Area Status Due Notes Al' w454 L12 R466 | 1/7: Quarterly plan (219x36) [+1 inline text links, exempt] | a 'Runbooks and incident respon' cut with ellipsis 98/189; pre 'const result = await client.' scrolls sideways 294/816 | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 1 heading(s) under bar; scrollIntoView 'Notes': top 319 vs bar 45 ok | contents: 44x44, panel fits w320, page overflow 146; menu: 44x44, panel fits w304, page overflow 146 |

### history: /p/:slug/history (/p/quarterly-plan-abc123/history)

| vp | overflow px | offending elements | sub-44 targets (non-inline / all) | clipped / scrolling boxes | sticky bar overlap | phone controls |
|---|---|---|---|---|---|---|
| 390 | 0 (sw 390/cw 390) | - | 4/7: Back to Quarterly plan (139x16); Open this version, 11/21/2026, 4:42:00 P (34x21); Open this version, 11/21/2026, 11:05:00  (34x21); Open this version, 11/20/2026, 2:30:00 P (34x21) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'History of Quarterly': top 94 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w390, page overflow 0; menu: 44x44, panel fits w374, page overflow 0 |
| 320 | 0 (sw 320/cw 320) | - | 4/7: Back to Quarterly plan (139x16); Open this version, 11/21/2026, 4:42:00 P (34x21); Open this version, 11/21/2026, 11:05:00  (34x21); Open this version, 11/20/2026, 2:30:00 P (34x21) | a 'Runbooks and incident respon' cut with ellipsis 142/189 | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'History of Quarterly': top 94 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w320, page overflow 0; menu: 44x44, panel fits w304, page overflow 0 |

### revision: /p/:slug/history/:revisionId (/p/quarterly-plan-abc123/history/r3)

| vp | overflow px | offending elements | sub-44 targets (non-inline / all) | clipped / scrolling boxes | sticky bar overlap | phone controls |
|---|---|---|---|---|---|---|
| 390 | 614 (sw 1004/cw 390) | a 'https://example.invalid/a/very' w991 L12 R1003; table 'Owner Area Status Due Notes Al' w454 L12 R466 | 4/9: All versions (72x16); Restore this version (158x32); Text (62x32); Changes (90x32) [+2 inline text links, exempt] | p 'A long address with no place' text spills out of its box 366/991; pre 'const result = await client.' scrolls sideways 364/816 | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Quarterly plan': top 94 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w390, page overflow 614; menu: 44x44, panel fits w374, page overflow 614 |
| 320 | 683 (sw 1003/cw 320) | a 'https://example.invalid/a/very' w991 L12 R1003; table 'Owner Area Status Due Notes Al' w454 L12 R466 | 4/9: All versions (72x16); Restore this version (158x32); Text (62x32); Changes (90x32) [+2 inline text links, exempt] | a 'Runbooks and incident respon' cut with ellipsis 142/189; p 'A long address with no place' text spills out of its box 296/991; pre 'const result = await client.' scrolls sideways 294/816 | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Deep heading': top 1683 vs bar 45 ok | contents: 44x44, panel fits w320, page overflow 683; menu: 44x44, panel fits w304, page overflow 683 |

### search: /search (/search?q=paragraph)

| vp | overflow px | offending elements | sub-44 targets (non-inline / all) | clipped / scrolling boxes | sticky bar overlap | phone controls |
|---|---|---|---|---|---|---|
| 390 | 0 (sw 390/cw 390) | - | 5/8: Search pages (280x39); Search (78x32); Product roadmap (116x16); Release checklist for the engineering ha (347x37); Handbook (all chapters) (159x16) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Search': top 61 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w390, page overflow 0; menu: 44x44, panel fits w374, page overflow 0 |
| 320 | 0 (sw 320/cw 320) | - | 5/8: Search pages (296x39); Search (78x32); Product roadmap (116x16); Release checklist for the engineering ha (247x37); Handbook (all chapters) (159x16) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 1 heading(s) under bar; scrollIntoView 'Search': top 0 vs bar 45 HIDDEN | contents: 44x44, panel fits w320, page overflow 0; menu: 44x44, panel fits w304, page overflow 0 |

### trash: /trash

| vp | overflow px | offending elements | sub-44 targets (non-inline / all) | clipped / scrolling boxes | sticky bar overlap | phone controls |
|---|---|---|---|---|---|---|
| 390 | 0 (sw 390/cw 390) | - | 2/5: Restore Plan for May (83x32); Restore A page with a very long title th (83x32) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Trash': top 61 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w390, page overflow 0; menu: 44x44, panel fits w374, page overflow 0 |
| 320 | 0 (sw 320/cw 320) | - | 2/5: Restore Plan for May (83x32); Restore A page with a very long title th (83x32) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Trash': top 61 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w320, page overflow 0; menu: 44x44, panel fits w304, page overflow 0 |

### import-idle: /import

| vp | overflow px | offending elements | sub-44 targets (non-inline / all) | clipped / scrolling boxes | sticky bar overlap | phone controls |
|---|---|---|---|---|---|---|
| 390 | 0 (sw 390/cw 390) | - | 5/8: Into the collection (283x42); Choose a .zip file (141x42); An export of Notion (Markdown and CSV fi (311x42); Markdown files (311x42); Import (74x32) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Import': top 61 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w390, page overflow 0; menu: 44x44, panel fits w374, page overflow 0 |
| 320 | 0 (sw 320/cw 320) | - | 5/8: Into the collection (283x42); Choose a .zip file (141x42); An export of Notion (Markdown and CSV fi (296x42); Markdown files (296x42); Import (74x32) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Import': top 61 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w320, page overflow 0; menu: 44x44, panel fits w304, page overflow 0 |

### import-progress: /import (/import?import=imp1)

| vp | overflow px | offending elements | sub-44 targets (non-inline / all) | clipped / scrolling boxes | sticky bar overlap | phone controls |
|---|---|---|---|---|---|---|
| 390 | 0 (sw 390/cw 390) | - | 1/4: Cancel import (120x32) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Import': top 61 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w390, page overflow 0; menu: 44x44, panel fits w374, page overflow 0 |
| 320 | 0 (sw 320/cw 320) | - | 1/4: Cancel import (120x32) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Import': top 61 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w320, page overflow 0; menu: 44x44, panel fits w304, page overflow 0 |

### import-report: /import (/import?import=imp1)

| vp | overflow px | offending elements | sub-44 targets (non-inline / all) | clipped / scrolling boxes | sticky bar overlap | phone controls |
|---|---|---|---|---|---|---|
| 390 | 0 (sw 390/cw 390) | - | 13/16: 2 pages x2 (188x21); 1 page x4 (188x21); First 3 pages (188x21); 3 pages (188x21); First 2 pages (188x21); handbook/guides/setup.md (168x16); handbook/embeds.md (139x16); Download source of handbook/notes/broken (142x32); Import another file (147x32) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Pages that still hol': top 271 vs bar 45 ok | contents: 44x44, panel fits w390, page overflow 0; menu: 44x44, panel fits w374, page overflow 0 |
| 320 | 0 (sw 320/cw 320) | - | 13/16: 2 pages x2 (141x21); 1 page x4 (141x21); First 3 pages (141x21); 3 pages (141x21); First 2 pages (141x21); handbook/guides/setup.md (168x16); handbook/embeds.md (139x16); Download source of handbook/notes/broken (142x32); Import another file (147x32) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Pages that still hol': top 0 vs bar 45 HIDDEN | contents: 44x44, panel fits w320, page overflow 0; menu: 44x44, panel fits w304, page overflow 0 |

### admin-users: /admin/users

| vp | overflow px | offending elements | sub-44 targets (non-inline / all) | clipped / scrolling boxes | sticky bar overlap | phone controls |
|---|---|---|---|---|---|---|
| 390 | 0 (sw 390/cw 390) | - | 14/17: Users (39x21); Groups (46x21); Search users (280x39); Search (78x39); Role of Alice Example (90x32); Suspend Alice Example (89x32); Role of Bob Builder (90x32); Suspend Bob Builder (89x32); Role of Carol Reader (90x32); Reinstate Carol Reader (93x32); Role of Dana Writer-Longsurname (90x32); Suspend Dana Writer-Longsurname (89x32); Role of Evangeline Montgomery-Fitzgerald (90x32); Suspend Evangeline Montgomery-Fitzgerald (89x32) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Users': top 98 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w390, page overflow 0; menu: 44x44, panel fits w374, page overflow 0 |
| 320 | 0 (sw 320/cw 320) | - | 14/17: Users (39x21); Groups (46x21); Search users (210x39); Search (78x39); Role of Alice Example (90x32); Suspend Alice Example (89x32); Role of Bob Builder (90x32); Suspend Bob Builder (89x32); Role of Carol Reader (90x32); Reinstate Carol Reader (93x32); Role of Dana Writer-Longsurname (90x32); Suspend Dana Writer-Longsurname (89x32); Role of Evangeline Montgomery-Fitzgerald (90x32); Suspend Evangeline Montgomery-Fitzgerald (89x32) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 1 heading(s) under bar; scrollIntoView 'Evangeline Montgomer': top 429 vs bar 45 ok | contents: 44x44, panel fits w320, page overflow 0; menu: 44x44, panel fits w304, page overflow 0 |

### admin-groups: /admin/groups (/admin/groups?group=g1)

| vp | overflow px | offending elements | sub-44 targets (non-inline / all) | clipped / scrolling boxes | sticky bar overlap | phone controls |
|---|---|---|---|---|---|---|
| 390 | 0 (sw 390/cw 390) | - | 16/19: Users (37x21); Groups (50x21); New group name (242x39); Create group (116x39); Platform team (93x21); Rename Platform team (87x32); Delete Platform team (74x32); Editors of the engineering handbook (225x21); Rename Editors of the engineering handbo (87x32); Delete Editors of the engineering handbo (74x32); Remove Bob Builder from Platform team (86x32); Remove Carol Reader from Platform team (86x32); Remove Dana Writer-Longsurname from Plat (86x32); Remove Evangeline Montgomery-Fitzgerald  (86x32); +2 more | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Groups': top 98 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w390, page overflow 0; menu: 44x44, panel fits w374, page overflow 0 |
| 320 | 0 (sw 320/cw 320) | - | 16/19: Users (37x21); Groups (50x21); New group name (172x39); Create group (116x39); Platform team (93x21); Rename Platform team (87x32); Delete Platform team (74x32); Editors of the engineering handbook (225x21); Rename Editors of the engineering handbo (87x32); Delete Editors of the engineering handbo (74x32); Remove Bob Builder from Platform team (86x32); Remove Carol Reader from Platform team (86x32); Remove Dana Writer-Longsurname from Plat (86x32); Remove Evangeline Montgomery-Fitzgerald  (86x32); +2 more | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 1 heading(s) under bar; scrollIntoView 'Carol Reader': top 152 vs bar 45 ok | contents: 44x44, panel fits w320, page overflow 0; menu: 44x44, panel fits w304, page overflow 0 |

### admin-access: /admin/collections/:id/access (/admin/collections/c1/access)

| vp | overflow px | offending elements | sub-44 targets (non-inline / all) | clipped / scrolling boxes | sticky bar overlap | phone controls |
|---|---|---|---|---|---|---|
| 390 | 0 (sw 390/cw 390) | - | 15/18: Users (37x21); Groups (46x21); Everyone with an account can (136x32); What Platform team can do (125x32); Remove Platform team (86x32); What Bob Builder can do (125x32); Remove Bob Builder (86x32); What Evangeline Montgomery-Fitzgerald ca (125x32); Remove Evangeline Montgomery-Fitzgerald (86x32); What Editors of the engineering handbook (125x32); Remove Editors of the engineering handbo (86x32); Give access to (93x32); Permission (127x32); Find a person (297x39); +1 more | div.admin-scroll 'Name Type Can Remove Platfor' scrolls sideways 366/480 | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Access to Dev': top 98 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w390, page overflow 0; menu: 44x44, panel fits w374, page overflow 0 |
| 320 | 0 (sw 320/cw 320) | - | 15/18: Users (37x21); Groups (46x21); Everyone with an account can (136x32); What Platform team can do (125x32); Remove Platform team (86x32); What Bob Builder can do (125x32); Remove Bob Builder (86x32); What Evangeline Montgomery-Fitzgerald ca (125x32); Remove Evangeline Montgomery-Fitzgerald (86x32); What Editors of the engineering handbook (125x32); Remove Editors of the engineering handbo (86x32); Give access to (93x32); Permission (127x32); Find a person (227x39); +1 more | div.admin-scroll 'Name Type Can Remove Platfor' scrolls sideways 296/480 | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 1 heading(s) under bar; scrollIntoView 'Access to Dev': top 14 vs bar 45 HIDDEN | contents: 44x44, panel fits w320, page overflow 0; menu: 44x44, panel fits w304, page overflow 0 |

### help: /help

| vp | overflow px | offending elements | sub-44 targets (non-inline / all) | clipped / scrolling boxes | sticky bar overlap | phone controls |
|---|---|---|---|---|---|---|
| 390 | 0 (sw 390/cw 390) | - | 0/3 | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Editing together': top 61 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w390, page overflow 0; menu: 44x44, panel fits w374, page overflow 0 |
| 320 | 0 (sw 320/cw 320) | - | 0/3 | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Editing together': top 0 vs bar 45 HIDDEN | contents: 44x44, panel fits w320, page overflow 0; menu: 44x44, panel fits w304, page overflow 0 |

### not-found: * (/nowhere/at/all)

| vp | overflow px | offending elements | sub-44 targets (non-inline / all) | clipped / scrolling boxes | sticky bar overlap | phone controls |
|---|---|---|---|---|---|---|
| 390 | 0 (sw 390/cw 390) | - | 1/4: Go to your collections (135x16) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Page not found': top 61 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w390, page overflow 0; menu: 44x44, panel fits w374, page overflow 0 |
| 320 | 0 (sw 320/cw 320) | - | 1/4: Go to your collections (135x16) | - | sticky=sticky bg=color(srgb 0.980392 0.968627 0.941176 / 0.8); after 400px: 0 heading(s) under bar; scrollIntoView 'Page not found': top 61 vs bar 45 ok (page does not scroll) | contents: 44x44, panel fits w320, page overflow 0; menu: 44x44, panel fits w304, page overflow 0 |

