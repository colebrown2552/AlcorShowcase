# Searchable design index and source inspection

The index reads the saved AlcorDesign document. It does not launch Chromium or
reimport the site. Page IDs remain stable in the existing project. Node IDs and
selectors survive edits and rerenders of saved snapshots; an independent import
creates a separate identity space. The visible DOM capture can be bounded, so
`capture_warnings` and `captured_node_count` describe its actual coverage.

All operations use the authenticated local `/api/tools` envelope and the same
MCP tools. The index exposes compact structure instead of raw HTML documents.

## Project page index

`design_index {project_id, query?, offset?, limit?}`

Limit defaults to 50 and is capped at 100. Search covers page titles/URLs/IDs and
captured node names, text, tags, selectors, HTML IDs and classes. Results contain
`entries`, `total`, `next_offset`, `project_revision`, sitemap metadata and a clear
ID-scope description. Each entry includes both `id` and `page_id`, its URL/path,
nearest imported `parent_page_id`, path depth, direct child count, capture status,
node count, matching node count, and up to three short matching node references.
Parent relationships describe URL hierarchy, not navigation or WordPress ancestry.

The operation borrows the saved project while producing its compact response; it
does not clone every page's HTML or raster data for an index request.

## Page DOM tree

`design_page_tree {project_id, page_id, node_id?, query?, depth?, offset?, limit?}`

The result is a paginated preorder list under `nodes`, with stable IDs, parent IDs,
selectors, tags, names, text excerpts, bounding boxes, depth, child counts and an
ancestor-ID `breadcrumb`. `roots` identifies the top-level captured nodes.
`node_id` scopes expansion to one subtree. Default depth is 3, capped at 20;
default page size is 50, capped at 200. A nonempty query searches every captured
descendant in the selected subtree regardless of the depth display setting.
Responses include the page revision, actual capture warnings and source provenance.

## Stylesheets and repository files

`design_page_sources {project_id, page_id}`

Stylesheet associations come from `<link rel="stylesheet">` in the captured HTML.
Each stylesheet has its original URL and media condition. A stylesheet on the page's
own origin maps to the same path under `ALCORDESIGN_SOURCE_ROOT` in the repository
(for example `/wp-content/a.css` to `site/wp-content/a.css` when the root is `site`),
and is marked available only if that exact path is a tracked blob at the selected commit. External or missing assets have
`available:false` and an explanation; they are not fetched or presented as local
source. A matching row includes `repo_path`, `sha` and Git `blob` ID.

Inline stylesheet blocks include their ID, byte count, preview and source content.
Content is limited to 30,000 characters per block and 120,000 bytes across the
response, with explicit truncation. PHP/HTML files matching route names are listed
as candidates, not as a proven server-side template execution trace.

`design_repo_files {query?, project_id?, page_id?}` and
`design_read_source {path, project_id?, page_id?}` accept the same selected scope.
Page scope requires project scope. Source selection follows this order:

1. The deployed commit the site reported in the `x-alcor-preview-commit` response header, if any.
2. The project's pinned repository commit when no capture commit exists.
3. The workspace commit, explicitly identified as a fallback.

Every response identifies `sha` and `provenance.basis`, distinguishing captured
site source, project source and workspace fallback. A recorded capture commit
that is unavailable locally produces an error; a newer checkout is never silently
substituted. Source comes from the exact Git blob, including its original trailing
newlines, even if the current worktree has changed or removed that file.

Repository source is read-only. Local style/text edits remain in the design
snapshot and exports; reading original CSS does not imply those edits changed Git.

## Sitemap refresh

`design_sync_sitemap {project_id, max_pages?}`

This performs bounded read-only network requests to the selected site's sitemap
indexes and child documents. It saves local discovery metadata, so it is a local
write operation. It neither renders pages nor adds/deletes saved captures.
Maximum discovery is 500 URLs, with a 25-second sitemap time budget. It does not
crawl page links or enumerate WordPress posts during a sitemap-only refresh.

The response records each attempted sitemap URL, HTTP status, kind, location
count, timestamp and any failure. Optional missing endpoint aliases remain visible
without invalidating a successful index; failed referenced child documents make
the result incomplete. Missing or unreadable sitemaps never erase imported pages.

`matched_saved_pages`, `unimported_pages` and `absent_saved_pages` make differences
visible. A page omitted from a sitemap can still be a valid captured page. Metadata
uses `sitemap_status: listed | not_listed | unknown`, preserving original import
provenance. `source.sitemap_sync` is separate from the original full-crawl discovery.

To import the `unimported_pages` into the same project, pass their URLs to
`design_add_pages {project_id, urls, max_pages?}` (see MCP.md). It appends new
captures only; saved pages, their revisions, edits and comment threads stay as they were.

## Verification

Rust tests exercise node-text search, URL ancestry, subtree depth, deep search,
pagination, missing-parent handling, stylesheet associations and bounded inline
CSS. A real local Git fixture captures an old CSS blob, deletes that file at a
newer commit, verifies the old exact bytes are still returned, and confirms an
unavailable capture commit fails instead of falling back to the newer checkout.
