# Accessibility of the web client (M6-T10)

What was checked, how, and what is left for a person with the tools. The automated passes are Playwright specifications in `apps/web/test-e2e/a11y/`; the screen reader pass (R11.21) needs a person with those tools and is a manual table below.

## The automated passes

| Pass | Specification | What it holds |
|---|---|---|
| axe on every route | `tour.spec.ts` | Every route of the route table, the editor with its slash menu, bubble, link editor and block menu open, the dialogs and the admin screens, in the light and the dark scheme: no serious or critical violation (WCAG 2 A and AA). A route with no stop in `routes.ts` fails the run. |
| keyboard only | `keyboard.spec.ts` | The primary action of each screen, reached and used with the keyboard alone; every page counts its pointer events and a walk expects none. |
| reduced motion | `reduced-motion.spec.ts` | With reduced motion asked for, no element has a transition or animation that lasts. |
| zoom and reflow | `reflow.spec.ts` | At 200% (640 CSS pixels) and 400% (320 CSS pixels) no route scrolls sideways. |
| forced colours | `forced-colors.spec.ts` | With forced colours on, every route shows where the focus is and has no serious or critical violation. |
| this report | `proof.spec.ts` | Both manual sections are here, and every `fail` row has a task id. |

The tour runs in Chromium in the job; Firefox and WebKit are the exit test's (M6-T13). The search results, the palette and the import screen are on the tour now that their screens have landed (M6-T09, M6-T12a); a screen that is not built yet is named on the tour as pending, with its task, until it lands.

## Findings of the automated passes

| Finding | Where | Result |
|---|---|---|
| The editor took the focus with no ring (its outline was none; the caret was the only sign) | the page | fixed: a ring of the focus token when the focus came by Tab (`ui/input-modality.ts`, `page.css`); a click keeps the plain look |
| In forced colours (high contrast) the primary button had its authored paper text on a white face (contrast 1.06): the contents head, the history actions and every confirm dialog | the shell's buttons | fixed: under `@media (forced-colors: active)` it names the system colours (`ButtonFace`, `ButtonText`, a 2px border) |
| At 320 CSS pixels (400% zoom) every route scrolled sideways: the header did not wrap, the contents sat beside the page, the search form and the access table did not shrink | the shell, collections, admin | fixed: the header wraps, the contents go above the page under 40rem, the forms wrap, and the access table, a data table whose controls need their whole width, scrolls sideways inside its own region (a stop of the Tab order) while nothing else on the page does |

## NVDA with Firefox

not run: needs the owner's machine

## VoiceOver with Safari

not run: needs the owner's machine

## How to do the manual pass

For each target, walk these four screens with the screen reader and the keyboard, and write one row per screen in the table of its section (the columns are `Target`, `Result` and `Task`; the result is `pass`, `fail` or `not run`; a `fail` row names the task that fixes it, like `M6-T03`):

| Target | What to walk |
|---|---|
| the editor | open a page, type, make a heading from the slash menu, select a word and bold it, move into a block another person is in and try to make it a list |
| the contents tree | arrow through the rows, open a page, move a page with the row menu |
| the palette | open it, search, open a result (when the palette lands) |
| the history | open the list, open a version, read the changes, restore |

Replace the line `not run: needs the owner's machine` of a section by its table once the pass is done. The release gate (M8-T07) treats a section that still says `not run` as open.
