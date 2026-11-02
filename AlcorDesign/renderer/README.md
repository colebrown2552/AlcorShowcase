# AlcorDesign Chromium renderer

Rust owns the application, document storage and MCP interface. This adapter uses an
isolated, temporary Chromium context to render HTML with the browser's real layout
engine. It does not attach to a user's browser or read saved credentials.

Run `node worker.mjs`, write one JSON object to stdin, then close stdin. The result
is one JSON line on stdout. Failures return `{ "ok": false, "error": "…" }` and
exit code 1. Logs must go to stderr.

Set `ALCORDESIGN_PLAYWRIGHT` to an installed Playwright `index.mjs`, or install
this package's dependency. Windows uses the installed Chrome channel by default.
`ALCORDESIGN_CHROME` may name another existing Chromium executable.

## Discover

```json
{"mode":"discover","url":"https://www.example.com/","max_pages":300,"extra_urls":["/docs/"]}
```

Returns `ok`, `url`, `pages: [{url,title,source,status,error?}]`, `warnings`,
`complete` and `discovered_at`. Discovery combines public WordPress pages/posts,
sitemap indexes and linked same-origin HTML pages. Repository routes can be passed
through `extra_urls`. No finite crawl proves the absence of hidden, unlinked routes;
`complete` means its discovered queue was inspected without hitting its bounds.
It omits login, admin, cart, checkout, search, assets and cross-origin URLs.
Non-200 routes remain visible with their status. Maximum requested page count is 500.

## Capture and edit

```json
{"mode":"capture","url":"https://www.example.com/docs/","width":1440,"height":1000,"output_dir":"/path/to/data-dir/renders"}
```

For an imported or edited document, replace `url` with `html` and `base_url`.
Optional `edits` is an array of `{selector,text?,styles?}`, where styles use CSS
kebab-case property names. Editing text replaces the selected element's text
content. `{action:"insert",selector,tag:"div"|"p"|"h2",text,styles}` appends a new
layer to the selected container. `{action:"remove",selector}` removes a layer.
The default action is `edit`. The CSS property list is limited to visual/layout properties.
Styles containing URLs or script expressions are rejected. Changes are made only
inside the isolated rendering context.

The result includes `title`, `url`, `width`, `height`, `document_height`, absolute
PNG `screenshot`, sanitized `html`, flat `nodes`, `links`, `commit`, HTTP `status`,
applied `edits`, `canvas_snapshots`, `warnings`, `captured_at` and `renderer`.
Each node has `id`, `parent_id`, `selector`, `tag`, `name`, direct `text`, document
coordinates `x/y/width/height`, computed `styles`, original `inline_style`, and selected `attributes`.
Stable `data-alcor-design-id` attributes survive subsequent snapshot edits.

The PNG captures the browser's actual rendered pixels. HTML snapshots preserve
stylesheets, resource URLs, layout and captured canvases while removing scripts,
embedded pages, inline event handlers and form values. Snapshot renders disable
JavaScript. Live imports allow site JavaScript but block HTTP writes and external
navigation. Some dynamic app workflows therefore remain static or unavailable in
the design snapshot. This is recorded in warnings when requests were blocked.

All images and imported HTML belong under a local data directory, outside source
control. `output_dir` must be an absolute path inside `ALCORDESIGN_DATA_DIR` when
that variable is set (the Rust server sets it for the renderer child). Otherwise it
must be inside the user's local application data directory (`LOCALAPPDATA`,
`XDG_DATA_HOME` or `~/.local/share`). The default capture budget is 2,000 visible
layers (maximum 5,000), width 320–2,560 px, and the first 24,000 px of document
height; truncation is explicit. Captures release their browser when finished. Allow
about 45 seconds for a slow capture and 90 seconds for bounded discovery. All
network destinations require HTTP(S); hosts that are or resolve to loopback,
private or reserved addresses are rejected.

A site may report its deployed Git version in the `x-alcor-preview-commit` response
header; the renderer returns it as `commit` in the capture result.

Every screenshot is checked against its PNG header before returning dimensions.

## Tests

`node --test worker.test.mjs header.test.mjs` exercises destination constraints,
discovery URL normalization, output directory confinement, actual Chromium
rendering, persistent layer selectors, text/CSS edits, responsive rendering,
snapshot sanitation and invalid edits. It uses synthetic HTML and stores generated
pixels in a local data directory.
