/**
 * Real output of AlcorComputer/demo/run_demo.py, written by its --json flag.
 * Generated: regenerate it instead of editing it.
 */
// prettier-ignore
window.ALCOR_RUN = {
  "checks": [
    {
      "detail": "",
      "label": "the lane completed prepared -> search -> read -> completed",
      "ok": true
    },
    {
      "detail": "",
      "label": "the mediator is ready only because the pin matches the live authority contract",
      "ok": true
    },
    {
      "detail": "",
      "label": "validate accepts the bound pair without consuming it",
      "ok": true
    },
    {
      "detail": "",
      "label": "stage consumes the proposal once and fires no input",
      "ok": true
    },
    {
      "detail": "replay",
      "label": "a replay with a fresh bundle nonce is refused",
      "ok": true
    },
    {
      "detail": "1 hash",
      "label": "the ledger holds only SHA-256 hashes",
      "ok": true
    },
    {
      "detail": "",
      "label": "chain the authority never registered: forged_observe_click",
      "ok": true
    },
    {
      "detail": "",
      "label": "scope that already expired: stale_scope",
      "ok": true
    },
    {
      "detail": "",
      "label": "two candidates on screen: projection_failure",
      "ok": true
    },
    {
      "detail": "",
      "label": "bundle with an unknown field: unknown_field",
      "ok": true
    },
    {
      "detail": "",
      "label": "bundle asking to type, not click: invalid_value",
      "ok": true
    },
    {
      "detail": "",
      "label": "bundle written for another mediator contract: mediator_contract_mismatch",
      "ok": true
    },
    {
      "detail": "readlane_chain_mismatch",
      "label": "the authority itself will not register an ambiguous chain",
      "ok": true
    },
    {
      "detail": "shell_app_target_forbidden",
      "label": "a terminal emulator can never be the target",
      "ok": true
    },
    {
      "detail": "",
      "label": "a click with a fresh observation reaches the fake host",
      "ok": true
    },
    {
      "detail": "fresh_observation_required",
      "label": "the consumed observation cannot be replayed",
      "ok": true
    },
    {
      "detail": "owner_grant_action_denied",
      "label": "a key press is outside the grant",
      "ok": true
    },
    {
      "detail": "pointer_outside_target_window",
      "label": "a click outside the window is refused by the backend",
      "ok": true
    },
    {
      "detail": "observation_stale",
      "label": "an observation older than 2 s is stale",
      "ok": true
    },
    {
      "detail": "",
      "label": "typing reaches the fake host",
      "ok": true
    },
    {
      "detail": "",
      "label": "the receipt carries a length and hash, not the text",
      "ok": true
    },
    {
      "detail": "",
      "label": "the third event is still inside the budget",
      "ok": true
    },
    {
      "detail": "owner_grant_event_limit_reached",
      "label": "the grant's event budget is exhausted",
      "ok": true
    },
    {
      "detail": "['click', 'type', 'click']",
      "label": "the fake host saw exactly click, type, click",
      "ok": true
    },
    {
      "detail": "",
      "label": "every effect wrote a pending record before the terminal one",
      "ok": true
    },
    {
      "detail": "",
      "label": "the durable file never contains the typed text",
      "ok": true
    },
    {
      "detail": "",
      "label": "receipts name no paths or hosts",
      "ok": true
    },
    {
      "detail": "",
      "label": "no real OS call was attempted (subprocess and CDLL tripwires)",
      "ok": true
    }
  ],
  "component": "AlcorComputer",
  "failures": [],
  "mediator": {
    "authority_refusal": {
      "label": "ambiguous chain (2 candidates)",
      "reason": "readlane_chain_mismatch"
    },
    "cases": [
      {
        "input_fired": false,
        "label": "click bound to the observation (validate)",
        "ok": true,
        "reason": "accepted"
      },
      {
        "input_fired": false,
        "label": "same click, staged once",
        "ok": true,
        "reason": "staged_no_input"
      },
      {
        "input_fired": false,
        "label": "replay with a fresh bundle nonce",
        "ok": false,
        "reason": "replay"
      },
      {
        "input_fired": false,
        "label": "chain the authority never registered",
        "ok": false,
        "reason": "forged_observe_click"
      },
      {
        "input_fired": false,
        "label": "scope that already expired",
        "ok": false,
        "reason": "stale_scope"
      },
      {
        "input_fired": false,
        "label": "two candidates on screen",
        "ok": false,
        "reason": "projection_failure"
      },
      {
        "input_fired": false,
        "label": "bundle with an unknown field",
        "ok": false,
        "reason": "unknown_field"
      },
      {
        "input_fired": false,
        "label": "bundle asking to type, not click",
        "ok": false,
        "reason": "invalid_value"
      },
      {
        "input_fired": false,
        "label": "bundle written for another mediator contract",
        "ok": false,
        "reason": "mediator_contract_mismatch"
      }
    ],
    "lane_receipts": [
      {
        "contract_sha256_prefix": "bf174e33c7ab",
        "extends": "alcor.authority.receipt.v1",
        "live_state_touched": false,
        "ok": true,
        "operator_turns": 1,
        "path_glob_count": 1,
        "phase": "prepared",
        "reason_code": "prepared",
        "schema": "alcor.authority.readlane.v1",
        "scope_authenticated": true,
        "verb_count": 2
      },
      {
        "body_truncated_to_cap": true,
        "body_was_truncated": false,
        "content_sha256_prefix": "d55429606638",
        "contract_sha256_prefix": "bf174e33c7ab",
        "extends": "alcor.authority.receipt.v1",
        "live_state_touched": false,
        "ok": true,
        "phase": "search",
        "reason_code": "validated_observation",
        "result_count": 1,
        "schema": "alcor.authority.readlane.v1"
      },
      {
        "body_truncated_to_cap": true,
        "body_was_truncated": false,
        "content_sha256_prefix": "d55429606638",
        "contract_sha256_prefix": "bf174e33c7ab",
        "extends": "alcor.authority.receipt.v1",
        "live_state_touched": false,
        "ok": true,
        "phase": "read",
        "reason_code": "validated_observation",
        "result_count": 1,
        "schema": "alcor.authority.readlane.v1"
      },
      {
        "chain_sha256_prefix": "76586c93f899",
        "contract_sha256_prefix": "bf174e33c7ab",
        "extends": "alcor.authority.receipt.v1",
        "live_state_touched": false,
        "ok": true,
        "operator_completed_step": false,
        "phase": "completed",
        "reason_code": "typed_code_completed",
        "receipt_count": 4,
        "schema": "alcor.authority.readlane.v1",
        "typed_code_completed": true
      }
    ],
    "observation": {
      "path": "screen/dialog.txt",
      "text": "Save button, lower right of the dialog"
    },
    "projection": {
      "candidate_count": 1,
      "screen_height": 600,
      "screen_width": 800,
      "target_ref": "button.save",
      "x": 640,
      "y": 420
    },
    "replay_ledger_hashes": 1,
    "status": {
      "actuation_backend_present": false,
      "network_access_present": false,
      "validation_ready": true
    }
  },
  "session": {
    "grant": {
      "allowed_actions": [
        "focus",
        "click",
        "type"
      ],
      "max_events": 3,
      "max_observation_age_ms": 2000,
      "target": "com.example.DemoApp",
      "ttl_seconds": 120
    },
    "observation": {
      "host_input_fired": false,
      "schema": "alcor.app-control.observation.v1",
      "target": {
        "bundle_id": "com.example.DemoApp",
        "frontmost": true,
        "pid": 4242,
        "process": "DemoApp",
        "window_bounds": {
          "height": 600,
          "width": 800,
          "x": 0,
          "y": 0
        },
        "window_title": "Demo window"
      }
    },
    "receipts_on_disk": [
      {
        "action": {
          "kind": "click",
          "x": 640,
          "y": 420
        },
        "effect_id": "<random-id>",
        "event_limit": 5,
        "events_used": 1,
        "expected_observation_id": "<random-id>",
        "grant_sha256": "aab2725f4a3a02ec1ab8457c81ffaf402c2dcaf6530c389ba28b9965d8d33989",
        "host_input_fired": false,
        "next_observation_id": null,
        "ok": false,
        "phase": "pending",
        "public_rationale": "Press the Save button.",
        "reason_code": "effect_pending",
        "retryable": false,
        "schema": "alcor.app-control.receipt.v1",
        "target_bundle_id": "com.example.DemoApp",
        "typed_text_redacted": true,
        "utc": "2026-10-01T12:00:00Z"
      },
      {
        "action": {
          "kind": "click",
          "x": 640,
          "y": 420
        },
        "effect_id": "<random-id>",
        "event_limit": 5,
        "events_used": 1,
        "expected_observation_id": "<random-id>",
        "grant_sha256": "aab2725f4a3a02ec1ab8457c81ffaf402c2dcaf6530c389ba28b9965d8d33989",
        "host_input_fired": true,
        "next_observation_id": "<random-id>",
        "ok": true,
        "phase": "terminal",
        "public_rationale": "Press the Save button.",
        "reason_code": "performed",
        "retryable": false,
        "schema": "alcor.app-control.receipt.v1",
        "target_bundle_id": "com.example.DemoApp",
        "typed_text_redacted": true,
        "utc": "2026-10-01T12:00:00Z"
      },
      {
        "action": {
          "key": "enter",
          "kind": "key"
        },
        "effect_id": null,
        "event_limit": 5,
        "events_used": 1,
        "expected_observation_id": "<random-id>",
        "grant_sha256": "aab2725f4a3a02ec1ab8457c81ffaf402c2dcaf6530c389ba28b9965d8d33989",
        "host_input_fired": false,
        "next_observation_id": null,
        "ok": false,
        "phase": "refusal",
        "public_rationale": "Confirm the dialog.",
        "reason_code": "owner_grant_action_denied",
        "schema": "alcor.app-control.receipt.v1",
        "target_bundle_id": "com.example.DemoApp",
        "typed_text_redacted": true,
        "utc": "2026-10-01T12:00:00Z"
      },
      {
        "action": {
          "kind": "click",
          "x": 900,
          "y": 700
        },
        "effect_id": null,
        "event_limit": 5,
        "events_used": 1,
        "expected_observation_id": "<random-id>",
        "grant_sha256": "aab2725f4a3a02ec1ab8457c81ffaf402c2dcaf6530c389ba28b9965d8d33989",
        "host_input_fired": false,
        "next_observation_id": null,
        "ok": false,
        "phase": "refusal",
        "public_rationale": "Click off the window.",
        "reason_code": "pointer_outside_target_window",
        "schema": "alcor.app-control.receipt.v1",
        "target_bundle_id": "com.example.DemoApp",
        "typed_text_redacted": true,
        "utc": "2026-10-01T12:00:00Z"
      },
      {
        "action": {
          "kind": "type",
          "text_length": 45,
          "text_sha256": "d44db1abe586c786f7ad8fe226a3ebb21a89997c1921c862655d75adf2612b69"
        },
        "effect_id": "<random-id>",
        "event_limit": 5,
        "events_used": 2,
        "expected_observation_id": "<random-id>",
        "grant_sha256": "aab2725f4a3a02ec1ab8457c81ffaf402c2dcaf6530c389ba28b9965d8d33989",
        "host_input_fired": false,
        "next_observation_id": null,
        "ok": false,
        "phase": "pending",
        "public_rationale": "Fill the name field.",
        "reason_code": "effect_pending",
        "retryable": false,
        "schema": "alcor.app-control.receipt.v1",
        "target_bundle_id": "com.example.DemoApp",
        "typed_text_redacted": true,
        "utc": "2026-10-01T12:00:00Z"
      },
      {
        "action": {
          "kind": "type",
          "text_length": 45,
          "text_sha256": "d44db1abe586c786f7ad8fe226a3ebb21a89997c1921c862655d75adf2612b69"
        },
        "effect_id": "<random-id>",
        "event_limit": 5,
        "events_used": 2,
        "expected_observation_id": "<random-id>",
        "grant_sha256": "aab2725f4a3a02ec1ab8457c81ffaf402c2dcaf6530c389ba28b9965d8d33989",
        "host_input_fired": true,
        "next_observation_id": "<random-id>",
        "ok": true,
        "phase": "terminal",
        "public_rationale": "Fill the name field.",
        "reason_code": "performed",
        "retryable": false,
        "schema": "alcor.app-control.receipt.v1",
        "target_bundle_id": "com.example.DemoApp",
        "typed_text_redacted": true,
        "utc": "2026-10-01T12:00:00Z"
      },
      {
        "action": {
          "kind": "click",
          "x": 640,
          "y": 420
        },
        "effect_id": "<random-id>",
        "event_limit": 5,
        "events_used": 3,
        "expected_observation_id": "<random-id>",
        "grant_sha256": "aab2725f4a3a02ec1ab8457c81ffaf402c2dcaf6530c389ba28b9965d8d33989",
        "host_input_fired": false,
        "next_observation_id": null,
        "ok": false,
        "phase": "pending",
        "public_rationale": "Press Save again.",
        "reason_code": "effect_pending",
        "retryable": false,
        "schema": "alcor.app-control.receipt.v1",
        "target_bundle_id": "com.example.DemoApp",
        "typed_text_redacted": true,
        "utc": "2026-10-01T12:00:00Z"
      },
      {
        "action": {
          "kind": "click",
          "x": 640,
          "y": 420
        },
        "effect_id": "<random-id>",
        "event_limit": 5,
        "events_used": 3,
        "expected_observation_id": "<random-id>",
        "grant_sha256": "aab2725f4a3a02ec1ab8457c81ffaf402c2dcaf6530c389ba28b9965d8d33989",
        "host_input_fired": true,
        "next_observation_id": "<random-id>",
        "ok": true,
        "phase": "terminal",
        "public_rationale": "Press Save again.",
        "reason_code": "performed",
        "retryable": false,
        "schema": "alcor.app-control.receipt.v1",
        "target_bundle_id": "com.example.DemoApp",
        "typed_text_redacted": true,
        "utc": "2026-10-01T12:00:00Z"
      },
      {
        "action": {
          "kind": "click",
          "x": 640,
          "y": 420
        },
        "effect_id": null,
        "event_limit": 5,
        "events_used": 3,
        "expected_observation_id": "<random-id>",
        "grant_sha256": "aab2725f4a3a02ec1ab8457c81ffaf402c2dcaf6530c389ba28b9965d8d33989",
        "host_input_fired": false,
        "next_observation_id": null,
        "ok": false,
        "phase": "refusal",
        "public_rationale": "One click too many.",
        "reason_code": "owner_grant_event_limit_reached",
        "schema": "alcor.app-control.receipt.v1",
        "target_bundle_id": "com.example.DemoApp",
        "typed_text_redacted": true,
        "utc": "2026-10-01T12:00:00Z"
      }
    ],
    "steps": [
      {
        "action": null,
        "events_used": 0,
        "input_fired": false,
        "intent": "start a session aimed at a terminal emulator",
        "ok": false,
        "phase": "refusal",
        "reason": "shell_app_target_forbidden",
        "verb": "target com.apple.Terminal"
      },
      {
        "action": {
          "kind": "click",
          "x": 640,
          "y": 420
        },
        "events_used": 1,
        "input_fired": true,
        "intent": "Press the Save button.",
        "ok": true,
        "phase": "terminal",
        "reason": "performed",
        "verb": "click"
      },
      {
        "action": {
          "kind": "click",
          "x": 640,
          "y": 420
        },
        "events_used": 1,
        "input_fired": false,
        "intent": "Press it again.",
        "note": "same observation id as the click above",
        "ok": false,
        "phase": "refusal",
        "reason": "fresh_observation_required",
        "verb": "click"
      },
      {
        "action": {
          "key": "enter",
          "kind": "key"
        },
        "events_used": 1,
        "input_fired": false,
        "intent": "Confirm the dialog.",
        "key": "enter",
        "ok": false,
        "phase": "refusal",
        "reason": "owner_grant_action_denied",
        "verb": "key"
      },
      {
        "action": {
          "kind": "click",
          "x": 900,
          "y": 700
        },
        "events_used": 1,
        "input_fired": false,
        "intent": "Click off the window.",
        "ok": false,
        "phase": "refusal",
        "reason": "pointer_outside_target_window",
        "verb": "click"
      },
      {
        "action": {
          "kind": "type",
          "text_length": 1,
          "text_sha256": "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"
        },
        "events_used": 1,
        "input_fired": false,
        "intent": "Type with an old view.",
        "note": "observation taken 3 s earlier; the limit is 2 s",
        "ok": false,
        "phase": "refusal",
        "reason": "observation_stale",
        "verb": "type"
      },
      {
        "action": {
          "kind": "type",
          "text_length": 45,
          "text_sha256": "d44db1abe586c786f7ad8fe226a3ebb21a89997c1921c862655d75adf2612b69"
        },
        "events_used": 2,
        "input_fired": true,
        "intent": "Fill the name field.",
        "ok": true,
        "phase": "terminal",
        "reason": "performed",
        "verb": "type"
      },
      {
        "action": {
          "kind": "click",
          "x": 640,
          "y": 420
        },
        "events_used": 3,
        "input_fired": true,
        "intent": "Press Save again.",
        "ok": true,
        "phase": "terminal",
        "reason": "performed",
        "verb": "click"
      },
      {
        "action": {
          "kind": "click",
          "x": 640,
          "y": 420
        },
        "events_used": 3,
        "input_fired": false,
        "intent": "One click too many.",
        "ok": false,
        "phase": "refusal",
        "reason": "owner_grant_event_limit_reached",
        "verb": "click"
      }
    ]
  }
};
