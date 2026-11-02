/**
 * Real output of AlcorSiteKit/demo/run_demo.py, written by its --json flag.
 * Generated: regenerate it instead of editing it.
 */
// prettier-ignore
window.ALCOR_RUN = {
  "claims": [
    "three one-time codes were minted and shown once",
    "only hashes are stored: no code appears in the approval file",
    "staging serves release 1; the served-files gate passed",
    "production was not touched by a staging land",
    "landing identical content again is refused",
    "promote says not ready: there is no contract receipt yet",
    "the contract is GREEN for release 1",
    "cold read ran end to end and wrote a report",
    "review flags the contact page, which never says what is sold",
    "no code: refused (approval-code-missing)",
    "code, no approval id: refused (approval-id-missing)",
    "nothing was written: the pointer log is empty and production is unchanged",
    "refused (on-hold) and the reason is shown",
    "the refused code was not consumed: 3 unused",
    "production now serves release 1",
    "the legacy page is gone and release 1's pages are live",
    "unrelated host data survived the deploy",
    "the code was burned: 2 unused",
    "staging serves release 2",
    "refused (not-ready): the receipt is for release 1, not release 2",
    "production unchanged, code unspent",
    "the contract is GREEN for release 2",
    "the controller refused the reused code",
    "production still serves release 1, byte for byte",
    "production now serves release 2",
    "one code left",
    "production serves release 1 again",
    "the rollback spent no code",
    "release 3 is on staging (the landing gate only checks bytes)",
    "the contract is RED: it found the missing h1 and the dead link",
    "refused (not-ready) with the failing contract as the reason",
    "production unchanged, fresh code unspent",
    "the pre-controller site is back and names no release",
    "production is byte-identical to how the demo found it",
    "host data intact on both hosts, and still no code spent",
    "the pointer log verifies",
    "editing an old entry is detected by the operator",
    "and by the controller, which acts on none of it",
    "nothing can be appended to a broken log",
    "with the log restored the controller accepts it again",
    "the operator's chain check cannot see an edit to the newest entry",
    "the controller's anchor does, and rejects the log",
    "restored, it carries on"
  ],
  "component": "AlcorSiteKit",
  "controller_decisions": [
    "controller: live e2a5230e",
    "controller: needs-approval 835f1459 approval code missing or not valid; production is unchanged",
    "controller: live 835f1459",
    "controller: live e2a5230e",
    "controller: live initial"
  ],
  "steps": [
    {
      "claims": [
        "three one-time codes were minted and shown once",
        "only hashes are stored: no code appears in the approval file"
      ],
      "commands": [
        {
          "command": "sitekit approve --count 3",
          "exit": 0,
          "output": []
        }
      ],
      "number": 0,
      "title": "Set up: the approver mints one-time codes"
    },
    {
      "claims": [
        "staging serves release 1; the served-files gate passed",
        "production was not touched by a staging land",
        "landing identical content again is refused"
      ],
      "commands": [
        {
          "command": "sitekit land <tmp>\\src\\v1",
          "exit": 0,
          "output": [
            "PUSHED release=e2a5230e files=6",
            "STAGING serves e2a5230e",
            "PASS served-files: 6 files match the release",
            "GATES served=0 suite=0 head=e2a5230e",
            "LANDED"
          ]
        },
        {
          "command": "sitekit land <tmp>\\src\\v1",
          "exit": 8,
          "output": [
            "NOTHING_TO_LAND: staging already serves e2a5230e"
          ]
        }
      ],
      "number": 1,
      "title": "Land release 1 on staging"
    },
    {
      "claims": [
        "promote says not ready: there is no contract receipt yet"
      ],
      "commands": [
        {
          "command": "sitekit promote",
          "exit": 1,
          "output": [
            "ok   staging serves a commit",
            "TODO contract receipt is for that commit - missing or unreadable",
            "TODO contract is GREEN - no contract receipt to read",
            "production now: release (pre-controller), controller no status yet",
            "Not ready."
          ]
        }
      ],
      "number": 2,
      "title": "Promotion needs a contract run first"
    },
    {
      "claims": [
        "the contract is GREEN for release 1"
      ],
      "commands": [
        {
          "command": "sitekit contract",
          "exit": 0,
          "output": [
            "contract: 2 suites against the site (serving e2a5230e)",
            "ok   structure        pass=15 fail=0 rc=0",
            "ok   links            pass=6 fail=0 rc=0",
            "contract GREEN: 21 pass, 0 fail; receipt receipts/contract-<time>/receipt.json"
          ]
        }
      ],
      "number": 3,
      "title": "Run the contract against staging"
    },
    {
      "claims": [
        "cold read ran end to end and wrote a report",
        "review flags the contact page, which never says what is sold"
      ],
      "commands": [
        {
          "command": "sitekit coldread --personas 1",
          "exit": 0,
          "output": [
            "/                      desktop 30s visitor offer=2 aud=1 next=2",
            "/contact/              desktop 30s visitor offer=0 aud=0 next=1",
            "/menu/                 desktop 30s visitor offer=1 aud=0 next=1",
            "wrote coldread/<time>/REPORT.md (2 page(s) flagged)"
          ]
        },
        {
          "command": "sitekit review",
          "exit": 0,
          "output": [
            "review: 2 finding(s) -> review/latest.json",
            "- [coldread] /contact/ @1440: Cold read (desktop, 30s): offer understood 0%, next step 50%.",
            "- [coldread] /menu/ @1440: Cold read (desktop, 30s): offer understood 50%, next step 50%."
          ]
        }
      ],
      "number": 4,
      "title": "Cold read and review (advisory; offline keyword stand-in, no model)"
    },
    {
      "claims": [
        "no code: refused (approval-code-missing)",
        "code, no approval id: refused (approval-id-missing)",
        "nothing was written: the pointer log is empty and production is unchanged"
      ],
      "commands": [
        {
          "command": "sitekit promote --go",
          "exit": 1,
          "output": [
            "ok   staging serves a commit",
            "ok   contract receipt is for that commit",
            "ok   contract is GREEN",
            "production now: release (pre-controller), controller no status yet",
            "refused [approval-code-missing]: --code needs a one-time approval code from the approver."
          ]
        },
        {
          "command": "sitekit promote --go --code <code>",
          "exit": 1,
          "output": [
            "ok   staging serves a commit",
            "ok   contract receipt is for that commit",
            "ok   contract is GREEN",
            "production now: release (pre-controller), controller no status yet",
            "refused [approval-id-missing]: --approved needs the id of the approval record, e.g. APPR-0042."
          ]
        }
      ],
      "number": 5,
      "title": "Promote is refused without an approval code and id"
    },
    {
      "claims": [
        "refused (on-hold) and the reason is shown",
        "the refused code was not consumed: 3 unused"
      ],
      "commands": [
        {
          "command": "sitekit promote --go --approved APPR-0001 --code <code>",
          "exit": 1,
          "output": [
            "ok   staging serves a commit",
            "ok   contract receipt is for that commit",
            "ok   contract is GREEN",
            "HOLD change freeze for the demo",
            "production now: release (pre-controller), controller no status yet",
            "refused [on-hold]: on hold: change freeze for the demo"
          ]
        }
      ],
      "number": 6,
      "title": "A hold file freezes releases, even with a valid code"
    },
    {
      "claims": [
        "production now serves release 1",
        "the legacy page is gone and release 1's pages are live",
        "unrelated host data survived the deploy",
        "the code was burned: 2 unused"
      ],
      "commands": [
        {
          "command": "sitekit promote --go --approved APPR-0001 --code <code>",
          "exit": 0,
          "output": [
            "ok   staging serves a commit",
            "ok   contract receipt is for that commit",
            "ok   contract is GREEN",
            "production now: release (pre-controller), controller no status yet",
            "pointer moved (#1): production -> e2a5230e",
            "controller: live on e2a5230e (header e2a5230e)",
            "contract: 2 suites against the site (serving e2a5230e)",
            "ok   structure        pass=15 fail=0 rc=0",
            "ok   links            pass=6 fail=0 rc=0",
            "contract GREEN: 21 pass, 0 fail; receipt receipts-prod/contract-<time>/receipt.json",
            "PROMOTED e2a5230e"
          ]
        }
      ],
      "number": 7,
      "title": "Promote with a fresh code"
    },
    {
      "claims": [
        "staging serves release 2",
        "refused (not-ready): the receipt is for release 1, not release 2",
        "production unchanged, code unspent"
      ],
      "commands": [
        {
          "command": "sitekit land <tmp>\\src\\v2",
          "exit": 0,
          "output": [
            "PUSHED release=835f1459 files=6",
            "STAGING serves 835f1459",
            "PASS served-files: 6 files match the release",
            "GATES served=0 suite=0 head=835f1459",
            "LANDED"
          ]
        },
        {
          "command": "sitekit promote --go --approved APPR-0002 --code <code>",
          "exit": 1,
          "output": [
            "ok   staging serves a commit",
            "TODO contract receipt is for that commit - receipt is for e2a5230e: run `sitekit contract`",
            "ok   contract is GREEN",
            "production now: release e2a5230e, controller live",
            "refused [not-ready]: not ready (see above)."
          ]
        }
      ],
      "number": 8,
      "title": "Release 2 lands; a stale receipt blocks promotion"
    },
    {
      "claims": [
        "the contract is GREEN for release 2",
        "the controller refused the reused code",
        "production still serves release 1, byte for byte"
      ],
      "commands": [
        {
          "command": "sitekit contract",
          "exit": 0,
          "output": [
            "contract: 2 suites against the site (serving 835f1459)",
            "ok   structure        pass=15 fail=0 rc=0",
            "ok   links            pass=6 fail=0 rc=0",
            "contract GREEN: 21 pass, 0 fail; receipt receipts/contract-<time>/receipt.json"
          ]
        },
        {
          "command": "sitekit promote --go --approved APPR-0002 --code <code>",
          "exit": 1,
          "output": [
            "ok   staging serves a commit",
            "ok   contract receipt is for that commit",
            "ok   contract is GREEN",
            "production now: release e2a5230e, controller live",
            "pointer moved (#2): production -> 835f1459",
            "the controller refused: the approval code is missing or not valid. Production is unchanged."
          ]
        }
      ],
      "number": 9,
      "title": "A used code cannot be used twice"
    },
    {
      "claims": [
        "production now serves release 2",
        "one code left"
      ],
      "commands": [
        {
          "command": "sitekit promote --go --approved APPR-0002 --code <code>",
          "exit": 0,
          "output": [
            "ok   staging serves a commit",
            "ok   contract receipt is for that commit",
            "ok   contract is GREEN",
            "production now: release e2a5230e, controller needs-approval",
            "pointer moved (#3): production -> 835f1459",
            "controller: live on 835f1459 (header 835f1459)",
            "contract: 2 suites against the site (serving 835f1459)",
            "ok   structure        pass=15 fail=0 rc=0",
            "ok   links            pass=6 fail=0 rc=0",
            "contract GREEN: 21 pass, 0 fail; receipt receipts-prod/contract-<time>/receipt.json",
            "PROMOTED 835f1459"
          ]
        }
      ],
      "number": 10,
      "title": "A fresh code ships release 2 (a refusal does not wedge it)"
    },
    {
      "claims": [
        "production serves release 1 again",
        "the rollback spent no code"
      ],
      "commands": [
        {
          "command": "sitekit rollback --why demo",
          "exit": 0,
          "output": [
            "pointer moved (#4): production -> e2a5230e",
            "controller: live on e2a5230e (header e2a5230e)",
            "contract: 2 suites against the site (serving e2a5230e)",
            "ok   structure        pass=15 fail=0 rc=0",
            "ok   links            pass=6 fail=0 rc=0",
            "contract GREEN: 21 pass, 0 fail; receipt receipts-prod/contract-<time>/receipt.json",
            "ROLLED BACK TO e2a5230e"
          ]
        }
      ],
      "number": 11,
      "title": "Roll back: no code is needed for a release that was live before"
    },
    {
      "claims": [
        "release 3 is on staging (the landing gate only checks bytes)",
        "the contract is RED: it found the missing h1 and the dead link",
        "refused (not-ready) with the failing contract as the reason",
        "production unchanged, fresh code unspent"
      ],
      "commands": [
        {
          "command": "sitekit land <tmp>\\src\\v3",
          "exit": 0,
          "output": [
            "PUSHED release=94c2befc files=6",
            "STAGING serves 94c2befc",
            "PASS served-files: 6 files match the release",
            "GATES served=0 suite=0 head=94c2befc",
            "LANDED"
          ]
        },
        {
          "command": "sitekit contract",
          "exit": 1,
          "output": [
            "contract: 2 suites against the site (serving 94c2befc)",
            "FAIL structure        pass=14 fail=2 rc=1",
            "       FAIL /menu/ has exactly one h1 (found 0)",
            "       FAIL /hours/ answers 200 (got 404, linked from /contact/)",
            "FAIL links            pass=6 fail=1 rc=1",
            "       FAIL /hours/ resolves (linked from /contact/; HTTP 404)",
            "contract RED: 20 pass, 3 fail; receipt receipts/contract-<time>/receipt.json"
          ]
        },
        {
          "command": "sitekit promote --go --approved APPR-0003 --code <code>",
          "exit": 1,
          "output": [
            "ok   staging serves a commit",
            "ok   contract receipt is for that commit",
            "TODO contract is GREEN - 3 fails in receipts/contract-<time>",
            "production now: release e2a5230e, controller live",
            "refused [not-ready]: not ready (see above)."
          ]
        }
      ],
      "number": 12,
      "title": "A failing contract blocks promotion"
    },
    {
      "claims": [
        "the pre-controller site is back and names no release",
        "production is byte-identical to how the demo found it",
        "host data intact on both hosts, and still no code spent"
      ],
      "commands": [
        {
          "command": "sitekit rollback --to initial --why demo",
          "exit": 0,
          "output": [
            "pointer moved (#5): production -> initial",
            "controller: live on the pre-controller site (header none)"
          ]
        }
      ],
      "number": 13,
      "title": "Emergency undo: the site as it was before the controller"
    },
    {
      "claims": [
        "the pointer log verifies",
        "editing an old entry is detected by the operator",
        "and by the controller, which acts on none of it",
        "nothing can be appended to a broken log",
        "with the log restored the controller accepts it again",
        "the operator's chain check cannot see an edit to the newest entry",
        "the controller's anchor does, and rejects the log",
        "restored, it carries on"
      ],
      "commands": [
        {
          "command": "sitekit status",
          "exit": 0,
          "output": [
            "staging     http=200 serves=94c2befc",
            "production  http=200 release=(pre-controller) controller=live",
            "pointer     5 entries, head -> initial (chain verified)",
            "contract    RED 20 pass / 3 fail at <time> on 94c2befc",
            "hold        none",
            "jobs        none running"
          ]
        },
        {
          "command": "sitekit status",
          "exit": 0,
          "output": [
            "staging     http=200 serves=94c2befc",
            "production  http=200 release=(pre-controller) controller=log-rejected",
            "pointer     BROKEN: pointer log breaks at line 2",
            "contract    RED 20 pass / 3 fail at <time> on 94c2befc",
            "hold        none",
            "jobs        none running"
          ]
        },
        {
          "command": "sitekit rollback --to initial",
          "exit": 1,
          "output": [
            "error: pointer log breaks at line 2"
          ]
        },
        {
          "command": "sitekit status",
          "exit": 0,
          "output": [
            "staging     http=200 serves=94c2befc",
            "production  http=200 release=(pre-controller) controller=log-rejected",
            "pointer     5 entries, head -> initial (chain verified)",
            "contract    RED 20 pass / 3 fail at <time> on 94c2befc",
            "hold        none",
            "jobs        none running"
          ]
        }
      ],
      "number": 14,
      "title": "The audit log is tamper-evident"
    }
  ]
};
