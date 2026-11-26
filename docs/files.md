# Files and attachments

How an uploaded file travels, what the server checks, and what it does not do. The routes are in `docs/api-surface.txt`; the settings are `GRIMOIRE_FILES_*` and the file store settings.

## The path of an upload

1. `POST /v1/attachments` with the page, the file name, the type and the exact size. The caller must be able to write the page. The type must be on the allowed list and the size at most the largest upload (default 25 MiB); a user may leave at most 10 uploads waiting. The answer holds a signed `PUT` address, valid for 10 minutes, that accepts exactly that size and type and cannot overwrite an object, and the path to put in the page.
2. The browser sends the bytes straight to the file store.
3. `POST /v1/attachments/{id}/complete`. The server checks that the object exists with the declared size and, for PNG, JPEG, GIF, WebP, AVIF and PDF, that its first 512 bytes show the declared type. A mismatch removes the object and the row.
4. A reader gets a download link from `GET /v1/attachments/{id}` or, for many at once, `POST /v1/attachments/urls`. The caller must be able to read the page.

An upload that is not completed within an hour expires. Retrying the first step with the same `Idempotency-Key` signs a fresh address for the same row while it is still waiting; the address itself is never stored.

## The two store addresses

The server talks to the file store at `GRIMOIRE_S3_ENDPOINT` (the name the server reaches it by, for example a Compose service) and signs every link for `GRIMOIRE_S3_PUBLIC_ENDPOINT`, because a signature covers the host. **The public endpoint must be an address the browser can reach**, and the store's CORS rule must allow the application's origin (`make files-setup` applies `GRIMOIRE_ALLOWED_ORIGINS`). When it is not set, links carry the internal address: that works where the two coincide (a hosted store) and fails in a browser where they do not (a store reached by a Compose service name), for uploads and downloads alike. Nothing refuses that configuration at start, because the server cannot know what the browser can reach; `GET /v1/config` shows the origin the browser is told to use (`fileStoreOrigin`).

## How files are served

- Files are private: every download is a signed link that works for 300 seconds.
- A PNG, JPEG, GIF, WebP or AVIF image is shown in the page under its own type; when a download is asked for, it is an attachment under its own type. Every other type is always an attachment of type `application/octet-stream`, whatever was asked, so no browser shows it or guesses its type. SVG and HTML are therefore always downloads.
- A file name is cleaned (no path or control characters, at most 255 bytes, an extension that a browser could run gets `.txt`), and the object's key never contains it.

## Limits

These are the limits of the first version, stated so that nobody has to find them out.

1. **There is no malware or virus scan of uploads.** The type check looks at the first bytes only; it does not look inside a file.
2. **Images keep any hidden data they were uploaded with**, such as the place a phone recorded in a photo. Nothing is removed from an image.
3. **There is no storage quota**, per user or in total. The limits are the size of one file and the number of uploads waiting.
4. **A PDF is always downloaded, never shown in the page.**
5. **Uploads that are never completed are removed by a clean-up that is not scheduled yet.** The code that removes them exists; until a job runs it, they stay in the store beyond their hour.
6. **A download link keeps working for up to 300 seconds after the reader loses access to the page.** The access check happens when the link is issued, not when it is used.

Also:

- An import is held to limits of its own, not to these: a file of its zip may be as large as `GRIMOIRE_IMPORT_MAX_ENTRY_BYTES` (2 GiB by default) and is sent to the store as a stream, and the zips an import holds in the store count against a quota of staged bytes for the workspace (`GRIMOIRE_IMPORT_STAGED_QUOTA_BYTES`, 150 GiB) until the import ends. Spec R6.39, R10.3.
- A file pasted into a page of another collection keeps the access of its first page; a reader who cannot read that page does not get the file.
- A page that is purged removes its files from the store first. If the store fails part-way, the attachments whose objects were already removed are marked deleted (`deleted_at`) and are not served, so restoring the page never shows a file that is gone.
- The address of the file store in the browser's content security policy comes from the headers of the web server that serves the client, not from this server.
