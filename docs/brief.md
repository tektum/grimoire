# Grimoire product brief

Status: product brief for version 1, kept in line with the decisions log. Items marked **Assumption** are not yet confirmed. Each item in scope is marked **Built**, **Partly built** or **Planned**, as of today: the collaboration server, Markdown conversion and saving, sign-in verification and the access rules exist; the HTTP API, web client, files, search, history screens and importer do not.

## What Grimoire is

A tool for writing and reading an organisation's documentation, replacing an existing team wiki. People edit pages together in real time in a WYSIWYG editor, and the content is Markdown.

## Who it is for

- Staff of one organisation, signed in through its own identity provider.
- **Scale:** 100 to 1,000 people. The application runs on one machine. Running on more than one machine is not ruled out, because storage, database, sign-in and job handling sit behind small interfaces, but it is not planned.
- **Assumption:** no external guests and no public pages in v1.

## In scope for v1

- **Pages:** a nested page tree, with create, rename, move and delete. *Planned* (the data model and access rules exist; the HTTP API does not).
- **Editor:** WYSIWYG editing of Markdown content: headings, lists, task lists, tables, code blocks, quotes, links, images. *Partly built*: the Markdown conversion exists; the web client does not.
- **Live co-editing:** several people in one page, with visible cursors. *Partly built*: the collaboration server exists; the client side, including cursors, is planned.
- **History:** page history with who changed what. *Planned.*
- **Search:** full-text search across pages, plus semantic (meaning-based) search using embeddings computed locally. *Planned.*
- **Attachments:** images and files inside pages. *Planned.*
- **Import:** a one-off importer for Markdown and CSV exports from the tool being replaced. *Planned.*
- **Sign-in:** Descope with SAML single sign-on. No local accounts or passwords. *Partly built*: the server validates session tokens; the sign-in screens are planned.
- **Permissions:** workspace roles plus access per collection. *Partly built*: the access rules exist; the screens to manage them are planned.

## Out of scope

- **AI product features:** agents, chat, text generation, and assistants. Machine-learning embeddings used only to improve search are allowed and are in version 1.
- Database features: tables-as-data, boards, kanban, relations, formulas. The app may still use a database server behind the scenes.
- Calendar and mail.
- **Assumption:** no canvases or whiteboards, no native desktop or mobile apps, no PDF or DOCX export, no end-user scripting or plugins in v1.

## Sign-in

- Sign-in uses the official Descope SDKs on the server and in the web client. Grimoire applies its own token policy on top (a lifetime cap and allowed email domains). The server side exists today on the official Descope Node SDK; the web client side is planned.
- Descope owns the sign-in screens and sessions and handles SAML single sign-on with the organisation's identity provider behind it.
- No local accounts or passwords.
- A user account is created on first successful sign-in, with the role `member`. The first administrators come from a configured list of email addresses.
- Groups and roles are managed inside Grimoire in version 1. Descope groups and roles are not read (proposed, not yet confirmed).
- The session lifetime, claim names and error shapes of Descope are not yet checked against a real project.

## Import

Planned. The importer is a one-off tool that reads Markdown and CSV exports of the tool being replaced. It is not built.

What it will do:

- Walk the exported files: one page per Markdown file, folder nesting becomes the page tree, images and other assets become attachments.
- Apply three rules: tables exported as CSV (Grimoire has no databases), callouts exported as HTML, and links between pages.

Open assumptions, to be checked against a real export before the importer is written:

- **Not verified:** how exported files are named and how page-to-page links are written.
- **Assumption:** CSV tables are imported as a plain Markdown table on one page, and each row's page as a normal subpage.
- **Assumption:** comments and page permissions from the old tool are not imported.

## Decisions and open items

1. **Permissions (decided):** workspace roles plus access per collection.
2. **Hosting (decided):** the application runs as a single container on one machine, started with Docker Compose. The database (PostgreSQL) and file storage (through the S3 API) are managed services on Google Cloud. The code is not tied to one provider: databases, storage, sign-in and background jobs sit behind small interfaces.
3. **Live editing (decided):** Hocuspocus, inside the application container.
4. **Editor (decided):** Milkdown.
5. **Document structure:** the first version documents the limits below. A block-level lock in the editor and other guard rails come after the first version.
6. **Package and repository naming (open):** `grimoire` is taken on npm, so a scope or prefix is needed.

## Known limits

- Two people changing the structure of one paragraph at the same moment (splitting it, joining it with a neighbour, wrapping it in a list) can lose or duplicate text. The first version documents this limit. A structure lock and other guard rails are planned for after it, and cannot close the gap completely.
- Two people typing several characters at the exact same spot can have their words interleave. No text is lost or repeated, and the result is the same for both. This is documented, and guard rails for it are planned after the first usable version (decision 147).

## What success looks like

- A team can move its existing pages in and stop using the old tool for documentation.
- A page exported from Grimoire is clean Markdown that reads correctly in any other Markdown tool.
- Two people typing in the same paragraph do not lose each other's text. The known exceptions are listed under Known limits.
