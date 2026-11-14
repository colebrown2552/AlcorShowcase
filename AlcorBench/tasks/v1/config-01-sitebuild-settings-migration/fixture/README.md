# sitebuild

Small static-site builder used for the Brackenmere Rowing Club pages.

Settings live in `site.json`. Since 0.9 the file uses a nested layout marked
with `"schema": 2` (see `examples/current-site.json`); `sitebuild/settings.py`
only reads that layout. Older sites still have the flat v1 layout
(`examples/legacy-site.json`) and need `migrate_settings.py`, which is not
written yet.
