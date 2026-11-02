/**
 * Real output of AlcorLedger/demo/run_demo.py, written by its --json flag.
 * Generated: regenerate it instead of editing it.
 */
// prettier-ignore
window.ALCOR_RUN = {
  "append_after_tamper": "refusing to append to invalid ledger: line 2: entry_hash mismatch",
  "chain": [
    {
      "confidence": 1.0,
      "created_at": "2026-01-01T09:00:00Z",
      "entry_hash": "4766c134dfa6816925e82fe7b91d30c34a5d0e37d6376723718d2f75606207b3",
      "expires_at": null,
      "id": "decision-1",
      "kind": "decision",
      "metadata": {},
      "previous_hash": "0000000000000000000000000000000000000000000000000000000000000000",
      "provenance": {
        "type": "analysis"
      },
      "schema_version": 1,
      "statement": "Receipts outrank narrative confidence.",
      "status": "accepted",
      "supersedes": [],
      "tags": [
        "policy"
      ]
    },
    {
      "confidence": 0.9,
      "created_at": "2026-01-01T09:05:00Z",
      "entry_hash": "006b642ce69fe40f474cf2a4b067dcddb5d896aaab52a9aa27b8c5a86087f701",
      "expires_at": null,
      "id": "obs-1",
      "kind": "observation",
      "metadata": {},
      "previous_hash": "4766c134dfa6816925e82fe7b91d30c34a5d0e37d6376723718d2f75606207b3",
      "provenance": {
        "type": "runtime"
      },
      "schema_version": 1,
      "statement": "The nightly export finished in 41 seconds.",
      "status": "open",
      "supersedes": [],
      "tags": []
    },
    {
      "confidence": 0.5,
      "created_at": "2026-01-01T09:10:00Z",
      "entry_hash": "804d645ef0d55a26da7e5c80d4b55deacca65533ea8590753c21196e06f8d5a2",
      "expires_at": null,
      "id": "wish-1",
      "kind": "wishlist",
      "metadata": {},
      "previous_hash": "006b642ce69fe40f474cf2a4b067dcddb5d896aaab52a9aa27b8c5a86087f701",
      "provenance": {
        "type": "analysis"
      },
      "schema_version": 1,
      "statement": "Add a replay tool for state transitions.",
      "status": "proposed",
      "supersedes": [],
      "tags": []
    },
    {
      "confidence": 0.5,
      "created_at": "2026-01-01T09:15:00Z",
      "entry_hash": "6185be712b5393f9c1f9a6b3f1cae057c27bdeefd43f1698b779dad83d70e2f6",
      "expires_at": null,
      "id": "obs-2",
      "kind": "observation",
      "metadata": {},
      "previous_hash": "804d645ef0d55a26da7e5c80d4b55deacca65533ea8590753c21196e06f8d5a2",
      "provenance": {
        "type": "analysis"
      },
      "schema_version": 1,
      "statement": "Page the on-call engineer at <REDACTED:EMAIL> if the export fails.",
      "status": "open",
      "supersedes": [],
      "tags": []
    },
    {
      "confidence": 0.5,
      "created_at": "2026-01-01T09:20:00Z",
      "entry_hash": "b89673b63e5e7b5599857f7da02d34e8954ca5b6ce1e4838cbccfa6336ec9c2c",
      "expires_at": null,
      "id": "obs-3",
      "kind": "observation",
      "metadata": {
        "api_key": "<REDACTED:SENSITIVE-KEY:API_KEY>",
        "region": "eu-west"
      },
      "previous_hash": "6185be712b5393f9c1f9a6b3f1cae057c27bdeefd43f1698b779dad83d70e2f6",
      "provenance": {
        "type": "analysis"
      },
      "schema_version": 1,
      "statement": "Service credentials were rotated after the review.",
      "status": "open",
      "supersedes": [],
      "tags": []
    }
  ],
  "claims": [
    "the first entry points at the all-zero hash",
    "every other entry stores the hash of the entry before it",
    "an entry containing an email address is refused",
    "nothing was written to the ledger",
    "the error and the findings describe the value but never contain it",
    "neither original value appears anywhere in the file",
    "only the sensitive key was replaced; harmless metadata is kept",
    "an untouched ledger verifies",
    "line 2 now says 4 seconds instead of 41 seconds",
    "verify exits 1 and names the line and the reason",
    "append refuses to extend a ledger that fails verification",
    "line 2 is now self-consistent, but line 3 still points at the old hash",
    "a ledger shortened from the end still verifies",
    "comparing against a head hash kept elsewhere does detect it (pin the head)",
    "init lays out four ledgers and a local-state marker",
    "a clean entry is appended",
    "a secret is refused with exit code 2",
    "list streams entries and honours --limit",
    "scan exits 1 and reports the category, not the value",
    "three identical cold reconstructions agree, and turn 3 ran in a distinct process",
    "a recorded cache use fails closed",
    "reconstruction refuses a ledger that fails verify"
  ],
  "cli": [
    {
      "command": "continuity init state",
      "exit": 0,
      "result": "5 paths created"
    },
    {
      "command": "continuity append (clean statement)",
      "exit": 0,
      "result": "appended cli-1"
    },
    {
      "command": "continuity append (contains email)",
      "exit": 2,
      "result": "SensitiveDataError"
    },
    {
      "command": "continuity list --limit 1",
      "exit": 0,
      "result": "cli-1"
    },
    {
      "command": "continuity scan notes.txt",
      "exit": 1,
      "result": "email finding, length 17"
    }
  ],
  "component": "AlcorLedger",
  "forgery": {
    "forged_hash": "5eb4708f62a82eefeb86b766f01869919f3fb2566d5f8d8553d883f8ee139427",
    "verify": {
      "entries": 5,
      "errors": [
        "line 3: previous_hash mismatch"
      ],
      "exit": 1,
      "ok": false,
      "path": "ledger.jsonl"
    }
  },
  "reconstruction": {
    "receipt": {
      "cache_used": false,
      "completion_receipts_present": true,
      "ledger_entries": 3,
      "ok": true,
      "pass_count": 3,
      "pass_k": true,
      "quarantined_request_retried": false,
      "schema": "alcor.continuity.three_turn.receipt.v1",
      "state_digest": "3f89f7f09657571e7b9f10df9c6e82b16e575fdcc4cd6f7e3d38ec397c3a13dc",
      "terminal_result_count_each": 1,
      "thread_id_hash": "8b983fb92d2eb12751695722fdb4e498211e50d79e72d25f44764b6a77f6348d",
      "turn_count": 3,
      "turn_three_process_distinct": true
    }
  },
  "reconstruction_cache_failure": "cache-use-not-proven-false",
  "reconstruction_chain_failure": "ledger-chain-invalid",
  "redacted_ids": [
    "obs-2",
    "obs-3"
  ],
  "refusal": {
    "entry_id": "obs-2",
    "findings": [
      {
        "end": 46,
        "fingerprint": "ff8d9819fc0e",
        "label": "email",
        "length": 17,
        "location": "$.statement",
        "start": 29
      }
    ],
    "message": "entry contains blocked data categories: email"
  },
  "tamper": {
    "after": "4 seconds",
    "before": "41 seconds",
    "line": 2,
    "verify": {
      "entries": 5,
      "errors": [
        "line 2: entry_hash mismatch"
      ],
      "exit": 1,
      "ok": false,
      "path": "ledger.jsonl"
    }
  },
  "truncation": {
    "head_after": "6185be712b5393f9c1f9a6b3f1cae057c27bdeefd43f1698b779dad83d70e2f6",
    "pinned_head": "b89673b63e5e7b5599857f7da02d34e8954ca5b6ce1e4838cbccfa6336ec9c2c",
    "verify": {
      "entries": 4,
      "errors": [],
      "exit": 0,
      "ok": true,
      "path": "ledger.jsonl"
    }
  },
  "verify_clean": {
    "entries": 5,
    "errors": [],
    "exit": 0,
    "ok": true,
    "path": "ledger.jsonl"
  },
  "zero_hash": "0000000000000000000000000000000000000000000000000000000000000000"
};
