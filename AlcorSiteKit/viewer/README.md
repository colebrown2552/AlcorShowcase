# AlcorSiteKit viewer

A static page that draws the real output of `demo/run_demo.py`: three releases moving through land,
contract, cold read, review and promote, the one-time-code gate (minted, spent, refused), the
pointer-log tamper checks, and the controller's decisions. Click any result to read its CLI output.

- **Open it:** double-click `index.html`, or open it in any browser from disk. No server, no network.
- **Regenerate the data:** `python demo/run_demo.py --json viewer/sample-run.js` from `AlcorSiteKit/`.
  Temp paths, ports and times are normalised by the exporter; approval codes are never recorded.
- The offline demo uses a keyword stand-in for the cold read and runs no browser, so there is no
  visual-baseline stage on the page; it shows only the stages the demo really runs.
