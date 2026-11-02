# Vendored MapLibre GL JS

- Package: `maplibre-gl@6.6.0`
- Registry tarball: `https://registry.npmjs.org/maplibre-gl/-/maplibre-gl-6.6.0.tgz`
- npm integrity: `sha512-EQql6eZYPhbHvJpqY4AwoiuLkUfXFRBHk67S8mDtzNo1F/jAo7xAxunIzO7gJ1vwTcPMgrK9b64dqKHvnkTlDQ==`
- License: BSD-3-Clause; see `LICENSE.txt`.

SHA-256:

- `maplibre-gl.mjs`: `d84cb65fa75f07a972616cb4ee1902829ca053beae28f7be9b0889131c497afd`
- `maplibre-gl-shared.mjs`: `34c2cb0330cec92e81c4fa7344e7008451442bbb9cca1da3465db4041a934073`
- `maplibre-gl-worker.mjs`: `b081c9b3d0691d9d85552b5624f2601f69f24ed37573959d279d322e98e4ee2f`
- `maplibre-gl.css`: `8e2dbbab312dc57656fbb76e9fa5308c75c9d7c7ba5808a7d55bcdb64cc813fa`
- `LICENSE.txt`: `ee5fc05a0677eaf69601d2c7db0d9ecd6cc27c3abc1d0733bc9ed34707cf8ef2`

The ESM entry, shared module, same-origin module worker, and CSS were copied from `dist/`. Re-vendor
deliberately; do not replace them with a floating CDN dependency. The same-origin v6 worker path does
not require a blob-worker CSP allowance.
