# AlcorLedger viewer

A static page that draws the real output of `demo/run_demo.py`: the hash chain as linked blocks,
the entry the privacy gate refused, the two it redacted, the verify result, and the tamper cases.

- **Open it:** double-click `index.html`, or open it in any browser from disk. No server, no network.
- **Regenerate the data:** `python AlcorLedger/demo/run_demo.py --json AlcorLedger/viewer/sample-run.js`
  from the repo root. Temporary paths are replaced by `<tmp>` by the exporter itself.
- **Try it:** the buttons above the chain show the edited, forged and truncated ledgers; `index.html#edit`
  opens on one of them.
- The browser only checks that each block's previous hash matches the block before it. Recomputing the
  hashes is the CLI's job, and the page shows that result from the demo run.
