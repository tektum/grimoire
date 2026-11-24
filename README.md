# Grimoire

[![codecov](https://codecov.io/gh/tektum/grimoire/graph/badge.svg)](https://codecov.io/gh/tektum/grimoire)

Grimoire is a collaborative documentation tool. People write and read pages together in a WYSIWYG editor, and every page is stored as Markdown. It is being built by Tektum to replace the team's current documentation tool. It is meant for the staff of a single company, from about 100 to 1,000 people, who sign in through the company login.

## Status

Grimoire is in development. It is not deployed anywhere, and it has no web client yet. The web client is a later milestone.

Built and tested so far:

- the server skeleton;
- the live collaboration back end (Yjs through Hocuspocus), with limits and abuse protection;
- conversion of pages to Markdown, checked against a regression corpus, and saving pages together with their Markdown;
- sign-in verification (Descope tokens are verified on the server);
- users and access rules, with read-only access enforced by the server;
- access re-checks on connections that are already open.

Planned next: the HTTP API, file uploads, the web client, search, an importer for Markdown and CSV exports from other tools, hardening and a first deployment.

This repository is being opened step by step. The code arrives through small pull requests, so for now there is little to run.

## What it is and is not

- Markdown is the durable format for pages.
- Pages are edited together in real time, with a page tree, page history, and images and files inside pages.
- Search is full-text plus semantic (meaning-based) search. The embeddings are computed locally, and they are used only for search.
- There are no AI product features: no assistants, chat or text generation.
- There are no database features (tables as data, boards, relations, formulas), and no calendar or mail.
- Sign-in goes through Descope. There are no local accounts or passwords.
- Dependencies must have permissive licences.
- The first version is for one company. It has no external guests and no public pages.

## What it looks like

Screenshots of the web client, in the light theme (it follows your system setting).

![The sign-in page](docs/screenshots/m6-t02/login-dev-form-light.png)

The sign-in page (the local development form).

![The list of collections](docs/screenshots/m6-t03/collection-list-light.png)

The collections you can open.

![A collection with its contents tree](docs/screenshots/m6-t03/contents-tree-light.png)

A collection and the contents tree beside it.

![A page with the contents tree beside it](docs/screenshots/m6-t03/page-with-contents-light.png)

A page with the tree beside it.

![The live editor open on a page](docs/screenshots/m6-t04/live-editor-light.png)

The live editor.

![Lists in a page: bullets, numbers and task boxes](docs/screenshots/m6-t04/lists-light.png)

Lists in a page: bullets, numbered steps and task boxes.

![Headings one to six in the page text](docs/screenshots/m6-t04/page-text-headings-after-light.png)

Headings, one to six, in the page's reading font.

![Two people in one page: each sees the other's cursor and selection with a name label](docs/screenshots/m6-t04/cursors-seen-by-bob-light.png)

Two people in one page: each sees the other's cursor and selection, with the name from the directory.

![Two people with their cursor on the same character](docs/screenshots/m6-t04/cursors-same-place-light.png)

Two cursors on the same character: both carets and both name labels stay visible.

![A page opened read-only](docs/screenshots/m6-t04/read-only-page-light.png)

A page opened read-only.

![Raw HTML in a page, shown as text with an Edit source button](docs/screenshots/m6-t11/raw-html-block-light.png)

Raw HTML in a page is shown as inert text, with an Edit source button.

![The same raw HTML block in the dark theme](docs/screenshots/m6-t11/raw-html-block-dark.png)

The same block in the dark theme.

![A page that was reset while you had unsent changes](docs/screenshots/m6-t04/reset-notice-light.png)

A page that was reset under a tab with unsent changes: the notice, and the copy to download or copy.

![A page for an administrator: History, and Reset saved state](docs/screenshots/m6-t04/admin-reset-action-light.png)

An administrator's page: a History link, and the Reset saved state action (it opens the reset dialog shown further down).

![The Move to dialog](docs/screenshots/m6-t03/move-to-dialog-light.png)

Moving a page with Move to.

![The trash](docs/screenshots/m6-t03/trash-light.png)

The trash.

![The not-found screen](docs/screenshots/m6-t03/not-found-light.png)

A page that does not exist.

![The reset-state dialog](docs/screenshots/m6-t12/reset-dialog-light.png)

Administrators: resetting a page's saved state, with an optional replacement text.

![The warning when the saved text is older](docs/screenshots/m6-t12/reset-stale-light.png)

The second question when the saved text is older than the page.

![The users screen for administrators](docs/screenshots/m6-t12/users-light.png)

Administrators: people, their roles, and who is suspended.

![A group with its members](docs/screenshots/m6-t12/group-light.png)

Administrators: a group and its members.

![Who has access to a collection](docs/screenshots/m6-t12/access-light.png)

Administrators: who may read and write a collection.

![The versions of a page](docs/screenshots/m6-t07/list-light.png)

The versions of a page, with when each was kept, why, and who edited.

![One version of a page](docs/screenshots/m6-t07/revision-light.png)

One version, drawn as the page would show it.

![The changes between a version and the page](docs/screenshots/m6-t07/diff-light.png)

The line diff between a version and the page as it is now.

![Confirming a restore](docs/screenshots/m6-t07/restore-confirm-light.png)

Restoring a version asks first.

![The page is still being saved](docs/screenshots/m6-t07/restore-stale-light.png)

A restore is refused while the page's last edits are still being saved.

![A viewer's view of a version](docs/screenshots/m6-t07/viewer-light.png)

A viewer can read a version and its changes, but has no Restore button.

![The outline of headings beside a page](docs/screenshots/m6-t05b/outline-light.png)

On a wide window, the headings of the page are listed in the right margin, with the one you are in marked.

![The same page on a narrower window, with no outline](docs/screenshots/m6-t05b/no-outline-light.png)

On a window narrower than 1,200 pixels the outline is left out.

![A table with its controls](docs/screenshots/m6-t05a/table-controls-light.png)

In a table, the controls to add or delete a row or a column sit right under it, and the cell you are in is marked.

![The language picker of a code block](docs/screenshots/m6-t05a/code-language-light.png)

In a code block, a select below it sets the language written after the fence.

In the dark theme:

![A page with the contents tree beside it, dark theme](docs/screenshots/m6-t03/page-with-contents-dark.png)

![A page that was reset while you had unsent changes, dark theme](docs/screenshots/m6-t04/reset-notice-dark.png)

## How it is built

- TypeScript on Node.
- Hono for the HTTP API.
- Yjs with Hocuspocus for live collaboration.
- PostgreSQL with pgvector.
- An S3-compatible file store.
- Milkdown for the editor.
- Descope for sign-in.
- Docker Compose for the local development environment.

## Roadmap

1. Repository, local environment and the collaboration server proof: done.
2. Markdown conversion and saving: done.
3. Sign-in, permissions and access re-checks: nearly done.
4. Database schema, migrations and the HTTP API: planned.
5. File storage and attachments: planned.
6. The web client: planned.
7. Search, background jobs and the importer for exports from other tools: planned.
8. Hardening, operations and the first deployment: planned.

## Known limits

If one person splits, joins or list-wraps a paragraph while another person is editing that same paragraph at the same instant, the collaboration library can lose, move or double text. If two people type at exactly the same position at the same instant, it can scramble their words; nothing is lost. Both screens still agree afterwards, so nothing signals it. Guard rails for both are planned after the first version.

## Security

Grimoire is not yet deployed or audited. Please report vulnerabilities privately, using "Report a vulnerability" on this repository's Security tab once it is enabled.

## Contributing

Grimoire is developed in the open. Issues are welcome. Pull requests from outside are welcome later, but the maintainers are not yet set up to review them promptly.

## Licence

Grimoire is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
