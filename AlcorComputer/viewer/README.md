# AlcorComputer viewer

A static page that draws the real output of `demo/run_demo.py`: the observed window, each action the
demo proposed with the authority's verdict (allowed, refused, stale, replay blocked), the mediator's
staging cases, and the sanitized receipt for the selected action.

- **Open it:** double-click `index.html`, or open it in any browser from disk. No server, no network.
- **Regenerate the data:** `python AlcorComputer/demo/run_demo.py --json AlcorComputer/viewer/sample-run.js`
  from the repo root. Temp paths become `<tmp>` and per-run random ids become `<random-id>`.
- **Try it:** click a row in the action list; `index.html#5` opens with action 5 selected.
- The demo's fake app exposes only a window frame and click points, so those are all the page draws.
