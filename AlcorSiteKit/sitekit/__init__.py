"""sitekit: land a change on staging, prove it with a contract, ship it through a strict gate.

The package is one release pipeline split along the line where trust changes:

Operator side (runs wherever the person or agent driving a release sits)
    ``cli``          the ``sitekit`` command and its verbs
    ``gate``         the promote gate: the one place that decides whether production may move
    ``contract``     runs the standing suites against a deployed site and writes a sealed receipt
    ``coldread``     "stranger test" of the pages, behind a swappable model interface
    ``transport``    how a release reaches staging (an interface plus a directory implementation)

Host side (runs where production lives)
    ``controller``   applies the release the pointer log names, if an approval code allows it
    ``deploy``       verify, swap, read back, smoke-check, restore (staging and production)
    ``approvals``    one-time codes, stored only as hashes

Shared
    ``release``, ``repo``, ``receipts``, ``fsutil``, ``net``, ``sitescan``, ``config``, ``jobs``

``mock_transport`` is an offline stand-in for a deploy host; ``demo/run_demo.py`` drives the real
CLI against it.
"""

__version__ = "0.1.0"
