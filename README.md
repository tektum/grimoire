# Grimoire

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
