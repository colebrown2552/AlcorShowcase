# AlcorDesign

AlcorDesign is a local design workspace for real websites. It imports a site (or a pasted
HTML page), renders every page in Chromium, and puts the result on a zoomable, Figma-like
canvas where each DOM element is a selectable layer. You change text, styles and layout on
the canvas, comment on it, undo and redo, and export the edited pages as HTML or JSON. A
Rust server owns the project store, editing rules and exports; a small Node worker drives
Chrome for layout; and the same operations are available to AI agents as MCP tools.
Everything runs on your machine and listens on loopback only.

![AlcorDesign editor](screenshots/AlcorDesign-editor.png)

## What works

- **Import** a site by URL (same-origin discovery from WordPress pages and posts, sitemaps
  and links, up to 500 pages), or paste raw HTML. Snapshot scripts never run.
- **Canvas** of real Chromium renders: full-page captures, nested layers with geometry and
  computed CSS, responsive re-rendering at any viewport from 320 to 2,560 px.
- **Edit** text and styles, move layers, insert text or rectangles, delete layers, with
  undo and redo. Every edit names the page revision it was based on.
- **Auto layout**: flex and grid controls for direction, wrapping, gaps, alignment, tracks,
  and per-child grow, shrink, basis, order and grid placement.
- **Comments**: pinned threads with replies, resolve and reopen, kept with the page.
- **Collaboration** between browser tabs on the same server: shared saved edits and
  comments, presence, cursors and selections, with revision-conflict protection.
- **Design index**: searchable page and layer tree, sitemap membership and a compact
  agent-sized index.
- **Live refresh**: recapture pages from the live site without losing comments, with
  archived snapshots you can restore.
- **GitHub source browsing (optional)**: Stylesheet and Files tabs show the CSS and PHP
  behind a page at the commit it was captured from; CSS/PHP drafts can be pushed to a
  dedicated review branch.
- **Exports**: HTML ZIP, JSON and CSS.
- **Agents**: 42 typed MCP tools over stdio, plus a one-shot `call` command, all going
  through the same server state as the UI.

## Run it

You need Rust 1.89 or newer, Node 18 or newer and Chrome or Chromium. Git is only needed
for the optional GitHub features.

```sh
cargo build --locked --release
cd renderer && npm install && cd ..        # installs Playwright for the renderer
./target/release/alcor-design serve
```

The server prints `AlcorDesign listening at http://127.0.0.1:<port>`; open that URL. By
default the operating system picks a free port. On Windows the renderer uses the installed
Chrome; elsewhere it uses Playwright's Chromium (`npx playwright install chromium`) unless
`ALCORDESIGN_CHROME` names a browser. Try it with any public site, for example
`https://alcor-industries.com/`, or paste HTML into the import dialog.

| Variable | Meaning |
| --- | --- |
| `ALCORDESIGN_PORT` | Listen port. Unset or `0` means a free port chosen by the OS. `serve --port N` overrides it. |
| `ALCORDESIGN_DATA_DIR` | Data directory for projects, captures, exports and `runtime.json`. Default: `%LOCALAPPDATA%\AlcorDesign`, else `$XDG_DATA_HOME/AlcorDesign` or `~/.local/share/AlcorDesign`. `serve --data PATH` overrides it. |
| `ALCORDESIGN_GITHUB_REPO` | `owner/repo` to turn on GitHub source browsing. Requires `serve --repo PATH` (a checkout whose `origin` is that repository). `serve --github owner/repo` does the same. |
| `ALCORDESIGN_GITHUB_BASE` | Branch that review branches start from. Default `main`. |
| `ALCORDESIGN_SOURCE_ROOT` | Repository folder that holds the deployed web root, for example `site`. Default: the repository root. |
| `ALCORDESIGN_SITE` | Deployed site used by GitHub imports that do not name `base_url`. |
| `ALCORDESIGN_PLAYWRIGHT` | Path to a Playwright `index.mjs`, if it is not installed in `renderer/`. |
| `ALCORDESIGN_CHROME` | Chrome or Chromium executable for rendering. |
| `ALCORDESIGN_NODE`, `ALCORDESIGN_APP_DIR` | Node executable, and the folder holding `ui/` and `renderer/` when the binary is moved. |

Without `ALCORDESIGN_GITHUB_REPO` the source tabs and GitHub import say they are not
configured, and everything else works.

**MCP.** With the server running, point an MCP client at the same binary:

```json
{ "mcpServers": { "alcor-design": { "command": "/absolute/path/to/alcor-design", "args": ["mcp"] } } }
```

The adapter finds the server through `runtime.json` in the data directory. For a single
call: `alcor-design call design_status '{}'`. See [docs/MCP.md](docs/MCP.md) for the tool list
and the rules agents must follow.

## How it's built

| Module | Role |
| --- | --- |
| `src/main.rs` | Strict CLI parsing (`serve`, `mcp`, `call`, `copy-project`); binds the listener, then builds the app with the bound port. |
| `src/config.rs` | Flags and environment: port, GitHub repository, base branch, web root, default site. |
| `src/app.rs` | Application state, the `App::tool` dispatcher behind every UI, MCP and CLI action, page capture, imports, exports and the axum router with its `guard` middleware. |
| `src/collaboration.rs` | In-memory presence room and the `RevisionConflict` error that becomes HTTP 409. |
| `src/live_refresh.rs` | Guarded recapture from the live site, durable operation receipts and the snapshot archive. |
| `src/design_index.rs` | Paged page and layer search, stylesheet mapping and source provenance. No browser or network. |
| `src/source_edit.rs` | CSS/PHP drafts and review-branch sync through an app-private bare Git cache. |
| `src/mcp.rs` | MCP stdio adapter and one-shot `call`; validates arguments against each tool's schema before sending. |
| `src/data_lock.rs`, `src/data_paths.rs`, `src/project_copy.rs` | Single-server lock on the data directory, data directory discovery, offline project copy. |
| `renderer/worker.mjs` | One JSON request in, one JSON result out: discovery, capture, edits and HTML sanitisation in a fresh headless Chromium context. |
| `ui/` | Vanilla JS editor: canvas and layers (`app.js`), inspectors, auto layout and source tabs (`inspectors.js`), presence (`collaboration.js`), design insights. |

Key design decisions:

- **Revision-aware edits.** Every page carries a `revision`. Edits, inserts, removals,
  re-renders, undo and redo must send the `expected_revision` they read; a mismatch is
  refused with HTTP 409 and the client keeps its input. Nothing is merged silently.
- **Undo is a snapshot stack.** Before each edit the page's sanitised HTML is pushed onto a
  bounded history (30 entries); undo re-renders the previous snapshot in Chromium, so the
  canvas, layer tree and export always come from the same rendered DOM. Layer IDs are stored
  as `data-alcor-design-id` attributes, so selectors survive edits and undo.
- **Source boundary.** The renderer only follows the imported site's own origin plus a few
  font and CDN hosts, refuses any host that resolves to a private address, allows only GET
  and HEAD, and strips scripts, frames, event handlers and form values from snapshots. Source
  reads are limited to tracked web files (HTML, PHP, CSS, JS, SVG) at a pinned commit, never
  hidden or dependency folders, and never the working tree.
- **Authenticated localhost API.** The server binds `127.0.0.1` only. Each run creates a
  random token; the UI gets it as an HttpOnly, SameSite=Strict cookie and agents read it from
  `runtime.json`. The Host header must match the bound port (blocking DNS rebinding) and any
  Origin must be the app itself.
- **Fail closed on writes.** Project files are written to a temp file, fsynced and renamed.
  Effects that leave the machine (pushes, live refreshes) take a `request_id` and leave a
  durable receipt, so an uncertain outcome is reconciled instead of replayed.

## The hard parts worth reading

- `App::tool` and the edit arm for `design_update_node` / `design_undo` in `src/app.rs`: one
  dispatcher for every client, the revision check, history push and the re-render through
  `App::capture`, then `App::update_page`, which restores the in-memory page if the save fails.
- `guard` in `src/app.rs`: Host, Origin and token checks for every request, against the port
  the listener actually bound.
- `guardNetwork`, `verifiedUrl` and `privateAddress` in `renderer/worker.mjs`: the read-only
  import policy, including IPv4-mapped IPv6 addresses and DNS answers that point inward.
- `live_refresh::reserve`, `complete` and `finish` in `src/live_refresh.rs`, with
  `App::refresh_live_page`: a refresh can crash at any point and still be reconciled from its
  receipt; comments added during the capture are merged in, not lost.
- `SourceEdits::sync` and `run_git_command` in `src/source_edit.rs`: pushes from a bare cache
  with hooks disabled, never force-pushes, bounds Git's time and output, and refuses when the
  base and review branch changed the same file.
- `design_index::provenance`: which commit a page's source should be read at, and why.
- `project_copy::copy_project`: copying a frozen project without overwriting anything,
  verifying hashes before the project becomes visible.

## Tests and demo

`python demo/run_demo.py` starts a server, imports a bundled sample page, renders it, edits
it, proves a stale edit is refused, undoes, exports and stops, all offline:

![AlcorDesign demo run](screenshots/demo.svg)

Measured on Linux (aarch64), Rust 1.99, Node 22, Chrome; see the commands below.

| Check | Result |
| --- | --- |
| `cargo test --locked` | 45 passed, 0 failed |
| `node --test ui/editor.test.mjs ui/inspectors.test.mjs renderer/*.test.mjs` | 11 passed, 0 failed (real Chromium) |
| `ui/native-*.test.mjs` against a fresh server (`ALCORDESIGN_URL`) | editor and comments checks pass; the GitHub source check and the read-only inspection of an imported site skip without a repository or site project |
| `python demo/run_demo.py` | every step PASS |
| Acceptance scripts in `tests/` | CLI safety, MCP adapter, data-directory lock, runtime discovery, project copy, collaboration, mobile workspace and six synthetic UI integrations pass; `collaboration_edges_acceptance.mjs` still fails (the app bar intercepts a click on **Reset fields** at the default 1280×720 viewport) |

The demo starts a server on a free loopback port with a throwaway data directory, imports
the bundled fictional page in `demo/sample/index.html`, renders it, applies a text edit and a
style edit, checks that a stale revision is refused, undoes once, exports HTML and JSON and
stops the server. It needs no network:

```text
$ python demo/run_demo.py
[PASS] locate binary - alcor-design
[PASS] start server - loopback only, 0 projects
[PASS] import sample page - job completed
[PASS] render in Chromium - 19 layers, 1280px wide
[PASS] text edit - headline -> 'Fresh loaves every morning'
[PASS] style edit - intro color -> rgb(192, 57, 43)
[PASS] stale revision refused - HTTP 409
[PASS] undo once - intro color rgb(43, 33, 24), headline kept
[PASS] export HTML - 2165 bytes, 3 files
[PASS] export JSON - 32576 bytes, 1 page
[PASS] stop server
RESULT: PASS
```

If no browser can start, the render, edit and undo steps print SKIP. `tests/` holds further
acceptance scripts for the CLI, MCP adapter, data-directory locking, project copy and
browser flows; each file's header says how to run it.

## Limits

This is a working editor for the rendered DOM of existing pages, not Figma.

- No vector pen tool, components or variants, prototyping, or design tokens.
- Collaboration shares saved states between tabs on one server. There is no
  character-level co-editing, per-author undo, accounts or permissions.
- Canvas edits stay in the design; they are not rewritten into PHP or CSS source. Source
  drafts are edited separately and pushed to a review branch, never deployed.
- Snapshots disable JavaScript, so dynamic widgets render as they looked when captured.
  Exported assets keep their original absolute URLs and need the source site to load.
- Captures are bounded: 500 pages per discovery, 24,000 px of height and 2,000 visible
  layers per page by default.
- Data files rely on the data directory's OS permissions; keep it private to your user.
