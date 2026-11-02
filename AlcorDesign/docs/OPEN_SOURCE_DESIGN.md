# Design insights and open-source design tools

AlcorDesign is its own Rust-backed capture and source-editing workspace. Its design insights panel
borrows product ideas from open-source design tools without using their editor engines or document
models.

Penpot is the closest team-design comparison: its architecture guide describes a ClojureScript/React
single-page app, a Clojure backend and PostgreSQL storage, under MPL-2.0. OpenPencil is a
code-oriented alternative: it describes `.fig` support, an inspectable scene graph, token extraction,
a headless Vue SDK and CLI/MCP workflows, under MIT. Both stacks are larger than, and different from,
AlcorDesign's native Rust service and browser UI.

`ui/design-insights.js` aggregates the values present in the selected page's `node.styles`, shows
the flex and grid declarations it observed, and copies a CSS handoff. These are computed styles
captured from the page; original token names and source rules are not available, and the panel never
invents source locations or token definitions. The palette swatch is a browser CSS preview, not a
color-normalizing algorithm.

No upstream code was copied. OpenPencil's helpers are tied to its TypeScript color pipeline, while
this panel needs only DOM aggregation and clipboard access. Licenses:
[Penpot MPL-2.0](https://github.com/penpot/penpot/blob/develop/LICENSE) and
[OpenPencil MIT](https://github.com/open-pencil/open-pencil/blob/master/LICENSE).
