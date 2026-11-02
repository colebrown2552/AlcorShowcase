# Open-source design editor patterns

AlcorDesign remains its own Rust-backed capture and source-editing workspace. This small inspector addition borrows product ideas from open design tools without importing their editor engines or document models.

Penpot is the closest team-design comparison: its official architecture guide describes a ClojureScript/React SPA, Clojure backend, and PostgreSQL persistence. The project license is MPL-2.0. OpenPencil is a code-oriented alternative: its project describes `.fig` support, an inspectable scene graph, token extraction, a headless Vue SDK, and CLI/MCP workflows; its repository license is MIT. Those stacks are materially larger and different from this app’s native Rust service and browser UI.

The new `ui/design-insights.js` independently aggregates values present in the selected page’s `node.styles`, exposes observed flex/grid declarations, and copies a CSS handoff. These are computed styles captured from the page; original token names and source rules are not retained. The panel never synthesizes source locations or token definitions. The palette swatch is a browser CSS preview, not a parsed or normalized color algorithm.

No upstream implementation code was copied. The candidate upstream helpers are coupled to OpenPencil’s TypeScript/color pipeline, while this feature needs only DOM aggregation and clipboard access. Repository license references: [Penpot MPL-2.0](https://github.com/penpot/penpot/blob/develop/LICENSE) and [OpenPencil MIT](https://github.com/open-pencil/open-pencil/blob/master/LICENSE). Confirm notices and file-level terms before any later code reuse.
