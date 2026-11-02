# AlcorLang viewer

A static page that shows four real AlcorLang programs beside their execution: the highlighted
source, the interpreter's own step trace with the cells each step left, the output tape, steps
and fuel headroom, how the run ended (halted or a fuel TRAP) and the lint result. Use the tabs to
switch program, and click a trace row or press the arrow keys to step through it.

Open `viewer/index.html` in a browser. It needs no server, build step or network.

The data is real: it comes from `run_metered`, `run_traced` and `alcorlang lint`. To regenerate it,
run `python demo/run_demo.py --json viewer/sample-run.js` from `AlcorLang`. A `.js` path is written
as `window.ALCOR_RUN = {...};`, and the exporter refuses to write if a private-looking path remains.
