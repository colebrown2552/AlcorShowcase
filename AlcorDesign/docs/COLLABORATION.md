# Collaboration on one local server

Multiple browser sessions connected to the **same AlcorDesign server and data
root** share saved canvas edits and comments. The editor checks the project's
revision every two seconds while visible, shows other session names, selections
and cursors, and reads changed pages through the existing authenticated API.
The single-server data lock and serialized renderer remain authoritative for
writes; this does not synchronize two independent server data directories.

A session's name is a user-selected display label, not an authenticated account.
The server listens on loopback only and every API call needs its per-run token or
session cookie, so collaborators are browser tabs on the same machine. Nothing here
opens a network listener or a tunnel.

## Editing and conflicts

Each canvas edit, insertion, removal, viewport change, undo and redo now requires
`expected_revision` from the last page read. A stale HTTP write returns 409 with
`code: revision_conflict` and the expected/current revisions. This is a deliberate
API contract change: older clients that omit the revision receive an error and
must read the page first. The MCP schemas advertise the required field.

Saved changes propagate to other sessions without resetting their zoom or pan.
Remote changes wait while a user types properties, writes a comment, drags a
layer, performs an operation or keeps a source editor open. The conditions are
checked again after each asynchronous read. A failed conflicting save preserves
its input. Copy input you want to retain, then use **Reset fields** to discard
unsaved properties and receive the latest design before applying a revised edit.
No automatic retry or merge of a failed write occurs. Undo/redo is the shared
page history, not a per-author history.

Presence is temporary server memory, expires after 15 seconds without a
heartbeat, and is bounded to 128 sessions. Closing or hiding a tab sends a
best-effort leave. Hidden tabs stop polling. Connection errors clear stale
presence and retry reads with bounded backoff; a server restart requires reloading
the page to establish its new local session cookie. No edits are replayed.

## Verification and remaining work

Acceptance uses a real isolated Rust server and Chromium browser contexts with
synthetic documents. It exercises shared edits, comments and selections,
same-revision write races, conflict-input retention, reconnects, authorization,
invalid presence inputs and responsive controls. Additional race checks cover
input arriving during an in-flight refresh and presence expiration.

This is saved-state collaboration, not a CRDT/operational-transform document
engine. Character-level simultaneous editing, per-author undo, account roles,
team invitations, document permissions, new-document discovery and shared source
draft presence remain open. GitHub source drafts and live refresh use their
existing separate operations. Full Figma parity is not claimed.

With a separately started server on a disposable data directory, run the browser integrations:

```sh
node tests/collaboration_acceptance.mjs http://127.0.0.1:PORT /absolute/path/to/playwright/index.mjs /absolute/path/to/new-output-directory [CHROME]
node tests/collaboration_edges_acceptance.mjs http://127.0.0.1:PORT /absolute/path/to/playwright/index.mjs /absolute/path/to/another-new-output-directory [CHROME]
```

`PORT` is the port the server printed at start-up. Chrome comes from the optional
last argument or `ALCORDESIGN_CHROME`. The runners create synthetic projects and write
screenshots into the given directories; use a new directory for every attempt.
