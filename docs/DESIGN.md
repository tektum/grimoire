# Grimoire visual design

Status: the agreed visual system for the web client, built in the stages below. It follows the direction in [design.md](design.md) (principles, words, layout, editing behaviour). The screens are in [screenshots/redesign](screenshots/redesign/) (1440 x 900, and 390 x 844 for the phone).

## Problem

The web client works, but it looks like a sketch. The tokens in `apps/web/src/ui/tokens.css` are placeholders, the fonts are system stacks that differ on every machine, the shell is a header with links over a bordered sidebar, and menus, dialogs and the palette are plain boxes. There is no type scale, no elevation, no motion rule beyond "none", and the reading column, which is the product, gets the same weight as the chrome around it. The result reads as unfinished and does not yet feel like a book you would want to read in.

## Goals

- Make reading a page the best thing about the product: a real text face, a 68 character measure, calm chrome.
- One coherent system of tokens (colour, type, space, radius, elevation, motion) that every screen uses.
- Light and true dark, both measured: text at WCAG AA or better, controls and focus at 3:1 or better.
- Other people visible but quiet, with colours that colour-blind readers can tell apart and always a name.
- Fonts self-hosted under permissive licences; nothing loaded from another origin (the CSP forbids it).

## Non-goals

- A logo, illustrations or empty-state art. Version 1 has none.
- New features. Sharing, comments and the structure lock are not part of this work.
- Changing the eight collaborator colours. They are a cross-client contract; this work only adds per-theme caret values and checks.
- A component library rewrite. Radix, cmdk, react-arborist, Milkdown and sonner stay; only their looks change.
- Changing existing copy or accessible names. The only new words are the palette's "Recent" group and its empty and no-result lines.

## The system

A well-bound reference book lit from within: warm paper, one ink, one pen colour, and chrome that behaves like a margin.

- **Type:** page text and page titles in Literata (OFL 1.1), optical sizes on; interface in Inter (OFL 1.1) with `tnum` on times and counts and `case` in the breadcrumb; code in IBM Plex Mono (OFL 1.1), which has no code ligatures, with `font-variant-ligatures: none` set anyway. Fallbacks are the current system stacks with `size-adjust` so the swap does not move the layout.
- **Interface scale (Inter):** 12, 13 (default chrome), 14 (inputs and menus), 16 (palette input). Weights 400, 500 and 600 only.
- **Page scale (Literata):** body 18 on a 30px line; H1 34/40 weight 600 with -0.01em tracking; H2 24/32 weight 600; H3 20/28; H4 18 semibold; H5 and H6 13px Inter in `--ink-2`. Never 700: Literata turns blunt at 700 and the page looks like a blog. Measure 68ch. `text-wrap: balance` on headings, `pretty` on paragraphs, `hanging-punctuation: first`, old-style figures in text, lining tabular figures in tables.
- **Space:** 4px base: 4, 8, 12, 16, 24, 32, 48, 72. The 72 is the space above the title. Chrome is compact (28px tree and menu rows, 32px controls, 44px top bar); under `pointer: coarse` every target grows to 44px. The page itself is spacious.
- **Radius:** 6 for controls and menu items, 10 for menus and popovers, 14 for the palette and dialogs. A nested radius is the outer radius minus the padding.
- **Elevation:** three levels. Flat paper separated by hairlines; popovers on `--paper-raised` with a 1px hairline and `0 1px 2px rgb(0 0 0 / .06), 0 8px 24px rgb(0 0 0 / .10)`; the palette and dialogs the same with `0 24px 64px rgb(0 0 0 / .18)` over a scrim of ink at 20% in light and black at 50% in dark. In dark, a 1px inner top highlight (`rgb(255 255 255 / .06)`) and the raised colour replace the shadows, and selected or hovered rows get lighter, never darker (`--fill-selected`). The one material is the sticky top bar: paper at 80% with `backdrop-filter: blur(20px) saturate(1.4)`, solid under `prefers-reduced-transparency` and `forced-colors`.
- **Motion:** 120ms for hover and press, 180ms for popovers (scale from 0.97 at the trigger), 240ms for the palette and the contents panel; easing `cubic-bezier(.2, 0, 0, 1)`; exits at 70% of the enter time; opacity and transform only. Reduced motion: opacity only, 80ms. Never animated: text reflow, typing, and remote carets moving (they fade in at the new place).
- **Focus:** one rule everywhere: 2px accent, 2px offset, the gap in the paper colour; inset on tree rows (full row, the same shape as the selected pill) and menu items. The separate amber focus colour goes; indigo on paper is 7.5:1. The editor surface gets no ring: the caret is its focus, and a control in the editor (the block handle) shows a ring only when it has the focus itself, so there is never a caret and a ring at once.
- **Icons:** Lucide (ISC), inlined as SVG, 16px at 1.5 stroke in `currentColor`; never without an accessible name and a tooltip. No emoji in the interface.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#faf7f0` | `#121110` | Page ground |
| `--paper-raised` | `#ffffff` | `#1d1b18` | Menus, palette, dialogs |
| `--paper-sunken` | `#f2eee4` | `#0c0b0a` | Contents panel, code, table heads |
| `--ink` | `#1c1a16` | `#e9e4d9` | Text |
| `--ink-2` | `#5c574d` | `#a8a193` | Secondary text |
| `--ink-3` | `#6e685d` | `#8a8478` | Metadata, placeholders |
| `--hairline` | `#e4ded0` | `#2e2b26` | Decorative dividers only |
| `--control-border` | `#8a8373` | `#787266` | Edges of inputs and buttons |
| `--accent` | `#2b4c9b` | `#9db4f5` | Links, caret, selection, focus, primary button |
| `--on-accent` | `#ffffff` | `#121110` | Text on the accent |
| `--fill-selected` | `rgb(28 26 22 / 0.06)` | `rgb(255 255 255 / 0.08)` | Hovered and selected rows in menus, the palette and the tree |
| `--warn` | `#8a5a00` | `#e0b252` | Offline and warnings, always with a word |
| `--danger` | `#b3261e` | `#f2857c` | Destructive actions and errors only |
| `--ok` | `#2f6b3f` | `#7fc292` | Success text, always with a word (not the Saved tick, which is `--ink-3`) |
| selection | `#ccd1dd` | `#434a60` | Accent at 22% (light) or 35% (dark) over paper |

Contrast, measured:

| Pair | Needs | Light | Dark |
|---|---|---|---|
| Body text (`--ink` on `--paper`) | 4.5:1 | 16.2 | 14.9 |
| Body text on contents (`--ink` on `--paper-sunken`) | 4.5:1 | 15.0 | 15.5 |
| Secondary text (ink-2) (`--ink-2` on `--paper`) | 4.5:1 | 6.7 | 7.4 |
| Secondary text on contents (`--ink-2` on `--paper-sunken`) | 4.5:1 | 6.2 | 7.7 |
| Metadata (ink-3) (`--ink-3` on `--paper`) | 4.5:1 | 5.2 | 5.1 |
| Metadata on menus (`--ink-3` on `--paper-raised`) | 4.5:1 | 5.5 | 4.6 |
| Metadata on contents (`--ink-3` on `--paper-sunken`) | 4.5:1 | 4.8 | 5.3 |
| Link (`--accent` on `--paper`) | 4.5:1 | 7.5 | 9.2 |
| Text on accent (`--on-accent` on `--accent`) | 4.5:1 | 8.0 | 9.2 |
| Code text (`--ink` on `--paper-sunken`) | 4.5:1 | 15.0 | 15.5 |
| Warning text (`--warn` on `--paper`) | 4.5:1 | 5.5 | 9.6 |
| Danger text (`--danger` on `--paper`) | 4.5:1 | 6.1 | 7.6 |
| Control border on paper (`--control-border` on `--paper`) | 3:1 | 3.5 | 3.9 |
| Control border on contents (`--control-border` on `--paper-sunken`) | 3:1 | 3.3 | 4.1 |
| Control border on menus (`--control-border` on `--paper-raised`) | 3:1 | 3.8 | 3.6 |
| Focus ring on paper (`--accent`, the focus colour, on `--paper`) | 3:1 | 7.5 | 9.2 |
| Focus ring on contents (`--accent`, the focus colour, on `--paper-sunken`) | 3:1 | 6.9 | 9.6 |
| Focus ring on menus (`--accent`, the focus colour, on `--paper-raised`) | 3:1 | 8.0 | 8.4 |
| Text on selection | 4.5:1 | 11.4 | 6.9 |
| Text on a selected menu row (`--ink` on `--fill-selected` over `--paper-raised`) | 4.5:1 | 15.4 | 10.8 |
| Path and hint on a selected row (`--ink-2`; `--ink-3` would be 3.7:1 in dark) | 4.5:1 | 6.4 | 5.4 |

Screens:

- **Reading.** A 44px sticky top bar with no border at the top of the page: the breadcrumb at the left (13px, `--ink-2`, current page in `--ink`), the save status after it, and presence, History and the page menu at the right; a hairline appears only once the page has scrolled. The contents panel is 264px on `--paper-sunken` with 28px rows and no page icons. Leaves reserve the chevron's slot, so all labels at one depth share an x. The current page is a `--paper-raised` pill with weight 500 and a 2px by 12px rounded accent bar inside its leading edge, so it is not shown by colour alone. Search sits at the top of the panel as a quiet button (`--paper-raised`, a hairline, text in `--ink-3`; its label identifies it, so it needs no 3:1 edge) that opens the palette. The column is centred in the space left, 72px below the bar; the title has no rule under it, and a 13px Inter line in `--ink-3` gives the last edit. Links are accent with a 1px underline at 0.18em, 2px on hover, and no visited colour. Code blocks are sunken with a hairline; quotes are Literata italic with a 2px ink rule; tables are Inter 14 with horizontal rules only. The outline sits in the right margin from 1280px up (Inter 12, `--ink-3`, the current heading in `--ink` with an accent tick), with the baseline of "On this page" on the title's first baseline; below 1280px it is hidden, not folded into a button.
- **Phone.** The top bar holds the contents button, the parent page with a leading back chevron (it reads as "up to On-call", not as a title), presence, the page menu and search; targets are 44px. The save status has its own reserved line under the metadata, so "Offline: changes kept in this tab" never pushes the text down.
- **Editing with another person.** It looks the same as reading; no chrome dims or fades (see "Rules"). While keys are going, only the hover affordances (the block handle, row actions) hide; they come back on pointer movement. Your caret is the native one (`caret-color` in the accent). A remote caret is 2px in the person's colour, does not blink, and carries an Inter 11 name flag that shows for 2 seconds after it moves and on hover, then shrinks to a 6px dot. The flag sits above the line with 2px clearance, and flips below the line when a heading is directly above or the line is at the top of the viewport. A remote selection is the person's colour at 18%, under your own selection. Presence is a stack of 24px initials discs with a 2px paper ring, at most 4 and then "+2"; each is a button named after the person (and the name is its tooltip) that jumps to their place, and when 2 or fewer people are here and the bar has room their first names are shown in words beside the discs ("Tomás, Priya"). Joining and leaving is one polite, debounced announcement. The block handle is a 6-dot grip in the left gutter in `--ink-3`, shown on hover and on keyboard focus inside the block, and is a real button ("Block menu") with a shortcut. The slash menu and selection bubble use popover elevation, a 10px radius, 28px rows, `--fill-selected` on the active row and the Markdown shortcut right-aligned in `--ink-3`; there is no key-hint footer in the slash menu (that belongs to the palette). The bubble appears 120ms after the pointer is released, never mid-drag.
- **Save status.** Inter 12 in `--ink-3`, tick included (not green), after the breadcrumb, in one `role="status"` region with its width reserved. "Saving" shows only when a save takes longer than 400ms, with no spinner. "Saved" stays at full `--ink-3`; it never fades. "Offline: changes kept in this tab" uses `--warn` with an icon and stays. The three strings do not change.
- **Search.** The palette opens at 14vh, 640px wide, 14px radius, over the scrim. The input row is 52px, Inter 16, with a search icon, no border, and the placeholder "Search, go to, or do" (the same as its accessible name). Groups, in order: "Pages" (title matches from the contents, at most 5, no snippet), "Search results" (body matches, with a snippet), "Collections", "Go to" (Search, Trash, Admin), "Actions" (with "New page", its label unchanged), and "Recent" on an empty query. Every command today's palette offers stays, under the same words. Group labels are sentence case, Inter 12 weight 600 in `--ink-3`. Rows are at least 36px: icon, title in `--ink`, the parent or collection in `--ink-3`; a body match adds the snippet in Literata 14 roman in `--ink-2`, clamped to 2 lines. Matched words are weight 600 with no highlight colour. The selected row is `--fill-selected` at 6px radius with a trailing return glyph; on a selected row the path and any hint step up to `--ink-2`, because `--ink-3` on the dark selected fill is only 3.7:1. A footer shows the keys to move, open and close as keycaps (arrow and return glyphs, with the words as their accessible text). No results says "No pages match" with the query and offers "New page" with the query as its title; while a search runs, the previous results stay at full contrast with a thin progress line in `--accent` under the input, instead of flashing empty.

## Collaborator colours

The eight values stay as they are (contracts section 9, `apps/web/src/ui/collab.ts`): the name label uses the colour itself with black or white text, whichever is higher. Four of the eight are under 3:1 against light paper, so a caret drawn in them would be hard to see. Each theme therefore gets a caret value: the same hue moved in OKLCH lightness until it reaches 3:1 against that theme's paper. The label keeps the fixed colour, so a person keeps one colour everywhere. Values:

| Name | Label (fixed) | Label text | Caret, light | Caret, dark |
|---|---|---|---|---|
| Blue | `#0072B2` | `#ffffff` (5.2:1) | `#0072b2` (4.8:1) | `#0072b2` (3.6:1) |
| Vermilion | `#D55E00` | `#000000` (5.4:1) | `#d55e00` (3.6:1) | `#d55e00` (4.9:1) |
| Green | `#009E73` | `#000000` (6.1:1) | `#009e73` (3.2:1) | `#009e73` (5.5:1) |
| Pink | `#CC79A7` | `#000000` (6.9:1) | `#c774a2` (3.0:1) | `#cc79a7` (6.2:1) |
| Sky | `#56B4E9` | `#000000` (9.1:1) | `#3698cb` (3.0:1) | `#56b4e9` (8.2:1) |
| Orange | `#E69F00` | `#000000` (9.3:1) | `#c68100` (3.0:1) | `#e69f00` (8.4:1) |
| Wine | `#882255` | `#ffffff` (8.7:1) | `#882255` (8.2:1) | `#a23b6c` (3.0:1) |
| Teal | `#44AA99` | `#000000` (7.5:1) | `#379f8e` (3.0:1) | `#44aa99` (6.7:1) |

## Rules

- **Chrome while typing.** No dimming and no fade-out: dimming would drop secondary text below AA, and a fade hides presence (principle 4) and strands anyone looking for a control. While keys are going, only the hover affordances hide (block handle, row actions). A focus mode may come later as an explicit toggle.
- **"Saved".** Full `--ink-3`, permanently, with the tick in `--ink-3` too (not green). No fade and no tick-only state: the word reassures, and a tick alone would change the width.
- **Palette placeholder.** "Search, go to, or do": three verbs for its three jobs, the same as the accessible name (WCAG 2.5.3).
- **Palette groups.** "Pages" for title matches (at most 5, no snippet) and "Search results" for body matches with snippets, then "Collections", "Go to" and "Actions" as today, and "Recent" on an empty query. Labels in sentence case, not capitals.
- **Heading weight.** Title and H2 at 600, never 700; the title at -0.01em.
- **Edges and search entry.** Control edges use `--control-border` (3:1 or better on every surface). Search has an entry at the top of the contents panel (a quiet button) and an icon in the phone's top bar. The outline shows from 1280px up.
- **Selection in dark.** Selected and hovered rows in menus, the palette and the tree use `--fill-selected` (ink at 6% in light, white at 8% in dark), so a selected row is lighter than its surface in dark, never darker.

## Platform interface guidelines on the web

The established desktop and mobile interface guidelines are written for native apps; we take their principles, not a platform's look.

Adopt:

- Clarity, deference and depth: content first, chrome quiet, depth only where it means something (popovers, the palette).
- Semantic colour roles in tiers (text, secondary text, metadata; fill; separator), never raw values in components.
- Text that scales with the reader's settings: all sizes in rem, layouts that survive 200% text and 400% zoom (320 CSS pixels wide) without sideways scrolling.
- Sidebar, content and inspector: contents, page, outline; the contents panel collapses and remembers its width.
- Standard shortcuts shown in menus and the palette.
- Undo over confirmation where possible, as a notice with Undo; where a confirmation is needed, it names the object and uses a verb ("Move to Trash", not "OK").
- Translucency only on bars; one focus ring everywhere; honour reduced motion, increased contrast (`prefers-contrast: more` promotes hairlines to `--control-border` and `--ink-2` to `--ink`) and reduced transparency.
- Writing: sentence case, plain verbs, an action keeps its name through the flow.

Deliberately not:

- A platform's system typefaces and symbol set. Their licences allow use only in native apps on that platform, not on the web. Inter, Literata and IBM Plex Mono stand in for them, and Lucide (already a dependency) for the symbols.
- Platform blue as the accent.
- Imitation window controls, native tab bars, large collapsing titles, sheets and rubber-banding.
- Translucent sidebars: text over blur fails contrast unpredictably.
- Hover-only disclosure: every hover affordance has a keyboard and touch route.

## Accessibility rules

- Text at 4.5:1 or better against every surface it sits on, in both themes; controls, focus rings and carets at 3:1 or better. The tables above are the measurements; any new token needs a row.
- Never colour alone: the current tree row has a bar and weight, a remote caret has a name, statuses have a word and an icon, search matches are bold.
- One focus ring, visible on every control, never removed without a replacement; inset where a ring would be clipped. Sticky bars must not hide the focused element (`scroll-margin-top` on headings and focusable rows).
- Every control has an accessible name; icon buttons also have a tooltip. Presence discs are buttons named after the person, with the name as tooltip, and first names shown in words when 2 or fewer people are here.
- Targets at least 24 x 24px everywhere and 44 x 44px under `pointer: coarse`.
- Full keyboard operation: tree, menus, palette, block handle (by shortcut), and a documented way out of the editor; the key for it is not settled yet and the help page must state it.
- One polite live region for the save status and one for presence changes, debounced; the palette announces result counts politely.
- `prefers-reduced-motion`: opacity only at 80ms (B), not a blanket "none", so state changes are still seen. `forced-colors`: system colours, borders kept, the top bar solid.
- No layout shift: reserved width for the save status, `size-adjust` on fallback fonts, the outline present from first paint at wide sizes, images with dimensions.
- The editor is tested with a screen reader before the redesign of the editing screen ships; rich-text editors commonly fail here.

## How the build is staged

Small pull requests, each releasable on its own:

1. **Tokens and fonts.** (Done, #528.) Replace the values in `tokens.css` with the system's tokens (keeping the old names as the variables the CSS already uses, then renaming in the same PR), add the self-hosted woff2 files and `@font-face` rules with `size-adjust` fallbacks, the type and space scales, radii, shadows and motion variables. No layout change.
2. **Shell.** (Done, #530.) Top bar (breadcrumb, save status, presence, History, page menu), contents panel (search field, collection, tree rows, New page, Trash), focus ring, reduced-transparency and forced-colours rules.
3. **Reading screen.** (Done, #531.) The page column, page text styles, outline.
4. **Editing screen.** (Done, #533.) Carets and flags, presence stack, block handle, slash menu, selection bubble, save-status timing.
5. **Palette and search screen.** (Done, #534.) Palette layout, result rows and snippets, empty and no-result states, the search screen to match.
6. **Everything else.** (Done, #535.) History, Trash, Collections, Import, Admin, Login, Not found, dialogs and notices.

All six stages are built and merged. What was left out on purpose, and is still open:

- **A Search icon in the phone's top bar.** The contents button and the avatar menu still reach search, and every accessible name that holds "Search" is used by existing tests, so the icon needs a name that none of them match (or those tests scoped first).
- **The "Edited ... ago by ..." line under the page title.** The page record has `lastEditedBy` (an id) and `lastEditedAt`; the line needs the name from the users directory (as the presence names use) and a relative-time format, and was not built in the reading stage.

Tests: keep accessible names, roles and visible copy stable so Playwright's role, label and text selectors keep working. The suite also has about 191 locators that select by CSS (class names and element paths) and 18 assertions on class names; each stage migrates the ones its screens touch to role, label or test-id selectors before it changes the markup, in the same PR. No pixel-diff assertions: each stage's pull request attaches screenshots of its screens in light and dark at 1440 and 390 wide, per the visuals rule.

## Decisions

1. **Parent name on search rows.** The client resolves the collection name from the collections it already holds. No change to the search response.
2. **Font size budget.** About 290 KB of Latin-only woff2 is accepted. Browsers fetch a face only when text uses it, so Literata italic already loads only when italic text is on screen.
3. **Remote flag timing.** 2 seconds, then a dot. Checked in two real editing sessions during the editing stage, adjusted there if needed.
4. **Flag below the line.** Accepted: it covers part of the next line for 2 seconds only, and only when a heading sits directly above.
5. **"Recent" in the palette.** The pages this person opened last, kept in the browser (local storage, per user, at most 8). No server change.
