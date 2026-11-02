# AlcorCLI viewer

A static page that shows one recorded run of the AlcorCLI policy gate: every receipt in the chain
(who asked, which rule decided, admitted, refused or waiting for the owner), the counters, and the
checks the demo makes. Click a row, or use the arrow keys, to see its receipt in the side panel.

Open `viewer/index.html` in a browser. It needs no server, build step or network.

The data is real: `demo/run_demo.py` drives the gate against a fake model on loopback and writes its
own receipt log. To regenerate it, run `python demo/run_demo.py --json viewer/sample-run.js` from
`AlcorCLI`. A `.js` path is written as `window.ALCOR_RUN = {...};`; the exporter replaces temporary
paths with `<tmp>` and refuses to write if a private-looking path remains. Receipt ids change from
run to run because they hash the temporary workspace.
