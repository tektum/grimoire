# Port finding: can the collaboration host share the API's port?

shared-port: yes

Established on Node v26.13.1 with `@hocuspocus/server` 4.8.0 (the `Hocuspocus` class, not `Server`), `crossws` 0.4.17, `@hocuspocus/provider` 4.8.0, `@hono/node-server` 2.1.9.

The server's own `upgrade` listener routes `/collab` to the host; every other path gets 404 and a closed socket; while draining it answers 503.

Shown by (`apps/server/test/collab/collab.int.test.ts`, real built process against the Compose database):
- "two clients converge, a third joining later receives the state; /healthz and /readyz answer while sockets are open; other paths are 404": one process, one port, WebSockets open while the API routes answer.
- "GRIMOIRE_COLLAB_PORT serves /collab on that port and 404s on the main port; role api 404s": the second-port fallback also works, so no rework would be needed had the finding been "no".
- "SIGTERM with unsaved edits stores them before exit 0, and clients are closed with going-away (1001)": the shared server shuts down in order.
