# Grimoire design direction (draft)

Status: draft direction. None of it comes from user research. The web client is not built yet, so everything below is planned unless it says otherwise. The typefaces, colours and final screens are not chosen.

## The idea

A grimoire is a working book: bound pages that people consult and add to. Grimoire should feel like a well-made reference book that happens to be editable by everyone at once. Calm, legible, quick to find things in.

The name is used with restraint. The book metaphor shapes structure and tone; there are no runes, spell names or fantasy typefaces.

## Principles

1. **The page is the interface.** Reading and editing look the same. Chrome fades while you type.
2. **Markdown you never have to see.** Typing `#`, `-`, `>` or backticks works for those who know it; everyone else uses a small menu. Syntax is not shown.
3. **Finding beats filing.** Search and the contents tree are always one keystroke away.
4. **Other people are visible, not noisy.** You can see who is on the page and where, without their cursors competing with your text.
5. **Nothing is lost.** Every page has history, and the product says plainly when something cannot be done.

## Words

| Concept | Word in the product | Not |
|---|---|---|
| A document | Page | Spell, scroll |
| Top-level grouping | Collection | Tome, shelf |
| The page tree | Contents | Sidebar |
| Search | Search | Index, scry |
| Version history | History | Chronicle |
| Deleted pages | Trash | Graveyard |

Plain words throughout. The one place the name shows personality is the logo and the empty states. Neither is part of version 1.

## Layout

- **Left:** contents tree for the current collection, collapsible.
- **Centre:** the page, in a single reading column of about 70 characters, with generous margins.
- **Right margin:** an outline of headings on wide screens; comments, if added, would live here.
- **Top:** breadcrumb, who is here and history. No toolbar by default. A share control is not in version 1.
- **Command palette:** one shortcut opens search, navigation and actions together.

## Type and colour

- **Page text:** a serif or humanist face chosen for long reading, at a comfortable size.
- **Interface:** a quiet sans-serif.
- **Code:** a monospaced face with ligatures off.
- **Colour:** warm off-white paper and near-black ink in light mode; a true dark mode. One accent colour, used for links, the caret and selection.
- **Collaborator colours:** a fixed set chosen to be distinguishable for colour-blind readers, each paired with the person's name.

Specific typefaces and colour values are not chosen yet. They should be picked against real page content and checked for contrast.

## Editing behaviour

- **Slash menu** for inserting blocks; **selection bubble** for inline formatting.
- **Block handle** on hover for moving a block or changing its kind.
- **Structure lock (planned for after the first version):** when someone else's cursor is in a block, its kind cannot be changed, and Enter, Backspace, Delete and list wrapping are held back. The handle or a short hint shows their name and why (spec R3.14 and R3.25). The lock cannot cover a race of less than one network round trip, and the help text will say so.
- **Raw HTML blocks** from imported pages appear as a quiet, non-editable block with an "edit source" action.
- **Saving** is automatic. A small status reads "Saved", "Saving" or "Offline: changes kept in this tab" (unsent edits live in the open tab only and are lost if it is closed).

## Accessibility

- Full keyboard operation, including the menus and the contents tree.
- Visible focus, and screen-reader names for every control.
- Text contrast meeting WCAG AA.
- Motion kept small, and removed when the system asks for reduced motion.

The editor's accessibility has to be tested with a screen reader once built; rich-text editors commonly fail here.

## Next steps

1. Pick two or three typeface and colour candidates and show them on a real imported page.
2. Draw the three core screens: reading a page, editing with another person present, and search.
3. Record the chosen system in a `DESIGN.md` for the build.

## Core collaboration transport

The core is deliberately Node-hosted: its collaboration port uses `IncomingMessage` from `node:http` and `Duplex` from `node:stream`. These are port types only, not an adapter import or a web-framework dependency; changing transport requires changing the port contract. The imports are at the top of `packages/core/src/ports/collaboration-host.ts`.
