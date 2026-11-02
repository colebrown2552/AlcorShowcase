/**
 * Sample run of the AlcorCLI demo, from `python demo/run_demo.py --json`.
 * Generated: regenerate it instead of editing it.
 */
window.ALCOR_RUN = {
 "schema": "alcor.cli.demo-summary.v1",
 "component": "AlcorCLI",
 "chain": {
  "ok": true,
  "count": 31
 },
 "tamper": {
  "detected": true,
  "reason": "row 4: content-hash-mismatch"
 },
 "counts": {
  "admitted": 16,
  "refused": 8,
  "waiting": 2,
  "recorded": 5,
  "receipts": 31
 },
 "steps": [
  {
   "n": 1,
   "title": "A .alcor program decides, and the decision is bound to its inputs",
   "checks": [
    {
     "label": "the program denied a path outside the workspace",
     "ok": true
    },
    {
     "label": "the receipt hashes the exact program bytes",
     "ok": true
    },
    {
     "label": "the receipt grants no authority",
     "ok": true
    },
    {
     "label": "a decision edited after the fact no longer matches its receipt",
     "ok": true
    },
    {
     "label": "a cell value with a line break is refused, not run",
     "ok": true
    }
   ]
  },
  {
   "n": 2,
   "title": "A model call is routed, sent over loopback, and receipted",
   "checks": [
    {
     "label": "cli.alcor chose the only reachable lane",
     "ok": true
    },
    {
     "label": "the request asked the provider not to think",
     "ok": true
    },
    {
     "label": "the answer is advice, not a verified result",
     "ok": true
    },
    {
     "label": "a model.call receipt and an ask receipt were written",
     "ok": true
    }
   ]
  },
  {
   "n": 3,
   "title": "The transport is strict about what comes back",
   "checks": [
    {
     "label": "refused: a chunked reply cut off before its terminator",
     "ok": true
    },
    {
     "label": "refused: an object with a repeated key",
     "ok": true
    },
    {
     "label": "refused: a redirect",
     "ok": true
    },
    {
     "label": "refused: a body larger than the limit allows",
     "ok": true
    },
    {
     "label": "a stalled request is cancelled promptly by the guard",
     "ok": true
    },
    {
     "label": "exactly one module in the package can open an outbound connection",
     "ok": true
    }
   ]
  },
  {
   "n": 4,
   "title": "Refusals carry reason codes",
   "checks": [
    {
     "label": "a non-loopback endpoint is refused before any byte is sent",
     "ok": true
    },
    {
     "label": "with every lane down the program refuses",
     "ok": true
    },
    {
     "label": "a path outside the workspace is denied",
     "ok": true
    },
    {
     "label": "...and nothing was written",
     "ok": true
    },
    {
     "label": "a forbidden command pattern is denied outright",
     "ok": true
    },
    {
     "label": "an owner-class effect waits for the operator",
     "ok": true
    },
    {
     "label": "...and runs once enabled, against a target that only records it",
     "ok": true
    },
    {
     "label": "a protected input is read-only",
     "ok": true
    },
    {
     "label": "unavailable is deny: a call nobody could judge does not run",
     "ok": true
    },
    {
     "label": "the operator's STOP file halts the turn before the model is called",
     "ok": true
    }
   ]
  },
  {
   "n": 5,
   "title": "An admitted effect is read back and receipted",
   "checks": [
    {
     "label": "the hash in the result is the hash of the bytes on disk",
     "ok": true
    },
    {
     "label": "a tool.decision (allow) precedes the effect.write receipt",
     "ok": true
    },
    {
     "label": "the effect receipt carries hashes, not the file text",
     "ok": true
    }
   ]
  },
  {
   "n": 6,
   "title": "The agent loop: refusals are data, and DONE is checked",
   "checks": [
    {
     "label": "the first write was refused and the model carried on",
     "ok": true
    },
    {
     "label": "DONE over an unread write was pushed back once",
     "ok": true
    },
    {
     "label": "after the read-back the claim was accepted",
     "ok": true
    }
   ]
  },
  {
   "n": 7,
   "title": "Memory admits a row by where its claim came from",
   "checks": [
    {
     "label": "evidence stamps the row with the file's hash",
     "ok": true
    },
    {
     "label": "a claimed result with no evidence is refused",
     "ok": true
    },
    {
     "label": "a row that echoes what someone said is testimony, attributed",
     "ok": true
    },
    {
     "label": "a proposed lesson is staged and is not in memory",
     "ok": true
    },
    {
     "label": "only the operator's admit command moves it into memory",
     "ok": true
    }
   ]
  },
  {
   "n": 8,
   "title": "A goal finishes only by its own check",
   "checks": [
    {
     "label": "a stalled approach is told to change, not to try harder",
     "ok": true
    },
    {
     "label": "asking to finish while the check fails is refused",
     "ok": true
    },
    {
     "label": "when the check passes the goal is finished",
     "ok": true
    }
   ]
  },
  {
   "n": 9,
   "title": "The fallback lane is coordination only",
   "checks": [
    {
     "label": "with every lane down the fallback names three data-only operations",
     "ok": true
    },
    {
     "label": "it never becomes a model or effect authority",
     "ok": true
    },
    {
     "label": "any live lane suppresses the fallback",
     "ok": true
    }
   ]
  },
  {
   "n": 10,
   "title": "The receipt chain verifies, and an edited row is found",
   "checks": [
    {
     "label": "31 receipts chain from the first to the last",
     "ok": true
    },
    {
     "label": "an edited row breaks the chain at that row",
     "ok": true
    }
   ]
  },
  {
   "n": 11,
   "title": "The HTTP endpoint refuses an unauthenticated non-loopback bind",
   "checks": [
    {
     "label": "binding a routable address without a token is refused",
     "ok": true
    },
    {
     "label": "a loopback bind needs no token and serves the program list",
     "ok": true
    }
   ]
  }
 ],
 "receipts": [
  {
   "seq": 1,
   "kind": "model.call",
   "actor": "ask()",
   "outcome": "admitted",
   "subject": "fast",
   "reason": "",
   "step": 2,
   "id": "ad88bdd63292bc5ca6c818d93baf58bb7550b9282bb513e6b0665c0cb5fd2d27",
   "prev": "",
   "body": {
    "elapsed_ms": 32,
    "finish_reason": "stop",
    "lane": "fast",
    "message_count": 2,
    "model": "demo-model",
    "request_sha256": "85d70a577cc129c857122c2466d4ebf59b7db331ee0581150d5139a297abdffd",
    "response_sha256": "bb8e46bc840ac9edb463b7749c634d003a3a79bb8ce834b7b15052788e878db8",
    "task_verified": false,
    "usage": {
     "completion_tokens": 8,
     "prompt_tokens": 40,
     "total_tokens": 48
    }
   }
  },
  {
   "seq": 2,
   "kind": "ask",
   "actor": "ask()",
   "outcome": "admitted",
   "subject": "fast",
   "reason": "simple-task-to-fast-lane",
   "step": 2,
   "id": "d6d4df3a255bf04e6eee1bda991a093a104805a9f769b747b045257f994eb61b",
   "prev": "ad88bdd63292bc5ca6c818d93baf58bb7550b9282bb513e6b0665c0cb5fd2d27",
   "body": {
    "answer_sha256": "557be7eca214f1889cdb6dfa348eb7c937648c9d6be72bfc1b8204adf7552a43",
    "elapsed_ms": 32,
    "lane_states": {
     "deep": "lane-not-configured",
     "fast": "up",
     "flash": "lane-not-configured"
    },
    "memory_used": false,
    "prompt_sha256": "115049a298532be2f181edb03f766770c0db84c22aff39003fec340deaec7545",
    "reason": "simple-task-to-fast-lane",
    "route": "fast",
    "routing_policy": {
     "decision_sha256": "4081ad7dec10b04466dd3ec43b7e8a313e2a901a29317a9833f6ce75b25334b1",
     "effect_authority": false,
     "input_sha256": "8450def9d153214dcbf515ebaa733f5008e169d55b34b6f25e273a7283df44dc",
     "program": "alcorcli/programs/cli.alcor",
     "program_scope": "repository",
     "program_sha256": "5f6c30459b200ce6ec341d4664d41a1180494687bc1f3fa4100e4767c3a7cdda",
     "schema": "alcor.program.decision-receipt.v1"
    },
    "task_verified": false,
    "thread": ""
   }
  },
  {
   "seq": 3,
   "kind": "model.refused",
   "actor": "ask()",
   "outcome": "refused",
   "subject": "direct",
   "reason": "endpoint-must-be-http-loopback",
   "step": 4,
   "id": "02153afb90595bfcebc6d2dc01bd333768ef61386fc13f6d096bdf3d972c7c1d",
   "prev": "d6d4df3a255bf04e6eee1bda991a093a104805a9f769b747b045257f994eb61b",
   "body": {
    "endpoint_sha256": "cdcd2dc43b675da231fe422036efda301ea26f6c9488d4aade8f5707050dc3f4",
    "reason": "endpoint-must-be-http-loopback",
    "route": "direct"
   }
  },
  {
   "seq": 4,
   "kind": "model.refused",
   "actor": "ask()",
   "outcome": "refused",
   "subject": "none",
   "reason": "no-reachable-lane",
   "step": 4,
   "id": "daed0c4d399d2b47e77fe7ef1e5f4267d84a17f091ba0d92101a392fcf6a5029",
   "prev": "02153afb90595bfcebc6d2dc01bd333768ef61386fc13f6d096bdf3d972c7c1d",
   "body": {
    "lane_states": {
     "deep": "lane-not-configured",
     "fast": "lane-not-configured",
     "flash": "lane-not-configured"
    },
    "policy_receipt": {
     "decision_sha256": "a5e05fe5cddb97ffaa7c5d75266a7c7e7ef68f283c3529cd078db120531ebfdf",
     "effect_authority": false,
     "input_sha256": "dcdab863a8dc64a7383ebc33f6e154be1eac34d653f22da82211df7d04cdd340",
     "program": "alcorcli/programs/cli.alcor",
     "program_scope": "repository",
     "program_sha256": "5f6c30459b200ce6ec341d4664d41a1180494687bc1f3fa4100e4767c3a7cdda",
     "schema": "alcor.program.decision-receipt.v1"
    },
    "reason": "no-reachable-lane",
    "route": "none"
   }
  },
  {
   "seq": 5,
   "kind": "tool.decision",
   "actor": "tool gate",
   "outcome": "refused",
   "subject": "write_file",
   "reason": "the-path-leaves-the-allowed-roots",
   "step": 4,
   "id": "07eef1ee159456e98d470ebdc13606fafe1580fff308167e306357cb57af6d2d",
   "prev": "daed0c4d399d2b47e77fe7ef1e5f4267d84a17f091ba0d92101a392fcf6a5029",
   "body": {
    "args_sha256": "759bd0b7b62289e338843c85c4afea36dc0c92357df029b5688a583a9b8f8bb9",
    "cells": {
     "effect_class": "write",
     "forbidden_pattern": "no",
     "inside_root": "no",
     "owner_verdict": "proceed",
     "protected_input": "no",
     "tool_kind": "write"
    },
    "policy_receipt": {
     "decision_sha256": "6e8a05d70c81772d7dac772d5c6c944963ae7913a62cf9ed0fd66a2809a803c0",
     "effect_authority": false,
     "input_sha256": "b6ffc586dcac20194d511f83a53da65823d933a899b5d642afd7a3693617e09b",
     "program": "alcorcli/programs/tool.alcor",
     "program_scope": "repository",
     "program_sha256": "1dcd17c8602e56c81908c7cb8ccc4d195c96b1e5b9d9bba3a1273d98035e796f",
     "schema": "alcor.program.decision-receipt.v1"
    },
    "reason": "the-path-leaves-the-allowed-roots",
    "tool": "write_file",
    "verdict": "deny"
   }
  },
  {
   "seq": 6,
   "kind": "tool.decision",
   "actor": "tool gate",
   "outcome": "refused",
   "subject": "shell",
   "reason": "forbidden-pattern",
   "step": 4,
   "id": "415e65a3c922d860d6aa7262a7de32dc6fd53b200505eea0cf837c378e609456",
   "prev": "07eef1ee159456e98d470ebdc13606fafe1580fff308167e306357cb57af6d2d",
   "body": {
    "args_sha256": "2f3b94579f43fb59e8df8ecf8d8a231a288b641d262c4c425043c107e8e72b82",
    "cells": {
     "effect_class": "shell",
     "forbidden_pattern": "yes",
     "inside_root": "yes",
     "owner_verdict": "proceed",
     "protected_input": "no",
     "tool_kind": "shell"
    },
    "policy_receipt": {
     "decision_sha256": "bde5a84f42587a8d6e84c7a09f20ec93794245271f269b74e7133ac330cbdb1e",
     "effect_authority": false,
     "input_sha256": "5a4d5851712cc54c302846486c5674e49b7739a0b36037b21ba289c86a0f5d4d",
     "program": "alcorcli/programs/tool.alcor",
     "program_scope": "repository",
     "program_sha256": "1dcd17c8602e56c81908c7cb8ccc4d195c96b1e5b9d9bba3a1273d98035e796f",
     "schema": "alcor.program.decision-receipt.v1"
    },
    "reason": "forbidden-pattern",
    "tool": "shell",
    "verdict": "deny"
   }
  },
  {
   "seq": 7,
   "kind": "tool.decision",
   "actor": "tool gate",
   "outcome": "waiting",
   "subject": "shell",
   "reason": "this-effect-waits-for-owner-enablement",
   "step": 4,
   "id": "ad5293041aa56a602ae9a7dc6e1fe3a00322816171b8f423c1a0be4b9027df98",
   "prev": "415e65a3c922d860d6aa7262a7de32dc6fd53b200505eea0cf837c378e609456",
   "body": {
    "args_sha256": "af1b4b3c17d3e4650d609c72472402dd9874f9d1a13aeab9e2988a25d88d6f97",
    "cells": {
     "effect_class": "owner",
     "forbidden_pattern": "no",
     "inside_root": "yes",
     "owner_verdict": "ask",
     "protected_input": "no",
     "tool_kind": "shell"
    },
    "policy_receipt": {
     "decision_sha256": "a386a3f36c32b922db0a8d54edc370dc1a047540b4a5775e820d1d6597000623",
     "effect_authority": false,
     "input_sha256": "9033ad16b10066dfe681892bd98bd2fbc47bc97dfeffbe5660dfbaaff595cf7f",
     "program": "alcorcli/programs/tool.alcor",
     "program_scope": "repository",
     "program_sha256": "1dcd17c8602e56c81908c7cb8ccc4d195c96b1e5b9d9bba3a1273d98035e796f",
     "schema": "alcor.program.decision-receipt.v1"
    },
    "reason": "this-effect-waits-for-owner-enablement",
    "tool": "shell",
    "verdict": "ask_owner"
   }
  },
  {
   "seq": 8,
   "kind": "tool.decision",
   "actor": "tool gate",
   "outcome": "admitted",
   "subject": "shell",
   "reason": "owner-class-effect-the-owner-enabled",
   "step": 4,
   "id": "4196aa92c62ff6490fce9aafe8ba7c6a8e9276654d68f270c55bf6a51198d949",
   "prev": "ad5293041aa56a602ae9a7dc6e1fe3a00322816171b8f423c1a0be4b9027df98",
   "body": {
    "args_sha256": "af1b4b3c17d3e4650d609c72472402dd9874f9d1a13aeab9e2988a25d88d6f97",
    "cells": {
     "effect_class": "owner",
     "forbidden_pattern": "no",
     "inside_root": "yes",
     "owner_verdict": "proceed",
     "protected_input": "no",
     "tool_kind": "shell"
    },
    "policy_receipt": {
     "decision_sha256": "a5ef447e92568d60fc1b6e686e985d09412f4cd71e14456342e318083cde00cb",
     "effect_authority": false,
     "input_sha256": "cf6a184a7acbe78abba43c1e503751f0ce5d9dd9a52a923a1642eb418d44ed2f",
     "program": "alcorcli/programs/tool.alcor",
     "program_scope": "repository",
     "program_sha256": "1dcd17c8602e56c81908c7cb8ccc4d195c96b1e5b9d9bba3a1273d98035e796f",
     "schema": "alcor.program.decision-receipt.v1"
    },
    "reason": "owner-class-effect-the-owner-enabled",
    "tool": "shell",
    "verdict": "allow"
   }
  },
  {
   "seq": 9,
   "kind": "tool.decision",
   "actor": "tool gate",
   "outcome": "refused",
   "subject": "write_file",
   "reason": "protected-input-is-read-only-write-your-output-elsewhere",
   "step": 4,
   "id": "48fa861fd52ee808a5e809ffaa6e23e42c6125dc4be20b6141834466c54d6732",
   "prev": "4196aa92c62ff6490fce9aafe8ba7c6a8e9276654d68f270c55bf6a51198d949",
   "body": {
    "args_sha256": "ca09212a8987f6fc264d1cf80fc91209b5072fb366fb4d6e5f3db836cdea44af",
    "cells": {
     "effect_class": "write",
     "forbidden_pattern": "no",
     "inside_root": "yes",
     "owner_verdict": "proceed",
     "protected_input": "yes",
     "tool_kind": "write"
    },
    "policy_receipt": {
     "decision_sha256": "7e9562e4403d052e2e96b6007f329c1f2d00b28b905ec9967d73940dcd2fd4bc",
     "effect_authority": false,
     "input_sha256": "c0a50a862ed655c387d4cd53442b5f2f496b7cc7093f60bcc549800ab3a94b64",
     "program": "alcorcli/programs/tool.alcor",
     "program_scope": "repository",
     "program_sha256": "1dcd17c8602e56c81908c7cb8ccc4d195c96b1e5b9d9bba3a1273d98035e796f",
     "schema": "alcor.program.decision-receipt.v1"
    },
    "reason": "protected-input-is-read-only-write-your-output-elsewhere",
    "tool": "write_file",
    "verdict": "deny"
   }
  },
  {
   "seq": 10,
   "kind": "tool.decision",
   "actor": "tool gate",
   "outcome": "refused",
   "subject": "write_file",
   "reason": "tool-program-unavailable: program-unavailable",
   "step": 4,
   "id": "84556160ac709b6df474920d5a54b8daac5b7999d076db54a024769b8bd90d2d",
   "prev": "48fa861fd52ee808a5e809ffaa6e23e42c6125dc4be20b6141834466c54d6732",
   "body": {
    "args_sha256": "171892c9dfca8134018b875bd5e8a3b52044fb8900f573745a237957dce2ec19",
    "cells": {
     "effect_class": "write",
     "forbidden_pattern": "no",
     "inside_root": "yes",
     "owner_verdict": "proceed",
     "protected_input": "no",
     "tool_kind": "write"
    },
    "policy_receipt": {},
    "reason": "tool-program-unavailable: program-unavailable",
    "tool": "write_file",
    "verdict": "deny"
   }
  },
  {
   "seq": 11,
   "kind": "tool.decision",
   "actor": "tool gate",
   "outcome": "admitted",
   "subject": "write_file",
   "reason": "inside-the-root-and-below-the-owner-line",
   "step": 5,
   "id": "9e56853c96043d189a592b7ffc460125024f76aa3658c9beac859ce9afce9a9d",
   "prev": "84556160ac709b6df474920d5a54b8daac5b7999d076db54a024769b8bd90d2d",
   "body": {
    "args_sha256": "404263b4ea32839845bdf85d064311953554b8e011f75b777d6143d90bc3c6de",
    "cells": {
     "effect_class": "write",
     "forbidden_pattern": "no",
     "inside_root": "yes",
     "owner_verdict": "proceed",
     "protected_input": "no",
     "tool_kind": "write"
    },
    "policy_receipt": {
     "decision_sha256": "f3c2160a19c75014133eacc57207c0662a72c36b623e8a2c55e151df5fe596f7",
     "effect_authority": false,
     "input_sha256": "a2b03fe0c6a47d8928817537b24d23e8eb5b2c8ca7d0863718f5753a68aa5e98",
     "program": "alcorcli/programs/tool.alcor",
     "program_scope": "repository",
     "program_sha256": "1dcd17c8602e56c81908c7cb8ccc4d195c96b1e5b9d9bba3a1273d98035e796f",
     "schema": "alcor.program.decision-receipt.v1"
    },
    "reason": "inside-the-root-and-below-the-owner-line",
    "tool": "write_file",
    "verdict": "allow"
   }
  },
  {
   "seq": 12,
   "kind": "effect.write",
   "actor": "tool gate",
   "outcome": "admitted",
   "subject": "notes/plan.txt",
   "reason": "",
   "step": 5,
   "id": "f32c6b1195e477d077d1c562cccfedf4e88e00a3597a54f340ecbd8c38ff17e5",
   "prev": "9e56853c96043d189a592b7ffc460125024f76aa3658c9beac859ce9afce9a9d",
   "body": {
    "action": "write",
    "bytes": 9,
    "ok": true,
    "path": "notes/plan.txt",
    "sha256_after": "01d9ce8aac0721c818d37abfa09ffc02a03a1d8ef572cfaf255bb9d29a468a98",
    "sha256_before": null
   }
  },
  {
   "seq": 13,
   "kind": "model.call",
   "actor": "ask()",
   "outcome": "admitted",
   "subject": "fast",
   "reason": "",
   "step": 6,
   "id": "7ec9d5b4362724046a206591803e245d7b8353a9a26fe8f11f996f7785c76c3e",
   "prev": "f32c6b1195e477d077d1c562cccfedf4e88e00a3597a54f340ecbd8c38ff17e5",
   "body": {
    "elapsed_ms": 16,
    "finish_reason": "tool_calls",
    "lane": "fast",
    "message_count": 2,
    "model": "demo-model",
    "request_sha256": "a30d3a9ef9f1fa0fbc535b430fefd23bea48f59314b50d5aaf3bfc2f2c8ebfc8",
    "response_sha256": "57ff4f61affbb2d7272ca9052c999100e487f4c9e30684c39c00593f85996636",
    "task_verified": false,
    "usage": {
     "completion_tokens": 1,
     "prompt_tokens": 48,
     "total_tokens": 49
    }
   }
  },
  {
   "seq": 14,
   "kind": "tool.decision",
   "actor": "agent loop",
   "outcome": "refused",
   "subject": "write_file",
   "reason": "the-path-leaves-the-allowed-roots",
   "step": 6,
   "id": "7c46dc180d11b8dc0619327631ae472ae8d9e53f2280513df3b74fee987b2139",
   "prev": "7ec9d5b4362724046a206591803e245d7b8353a9a26fe8f11f996f7785c76c3e",
   "body": {
    "args_sha256": "6473bd492cafce630eb11cdc1963b3ac605e49ad00453d4ebd33730c5c982e55",
    "cells": {
     "effect_class": "write",
     "forbidden_pattern": "no",
     "inside_root": "no",
     "owner_verdict": "proceed",
     "protected_input": "no",
     "tool_kind": "write"
    },
    "policy_receipt": {
     "decision_sha256": "6e8a05d70c81772d7dac772d5c6c944963ae7913a62cf9ed0fd66a2809a803c0",
     "effect_authority": false,
     "input_sha256": "b6ffc586dcac20194d511f83a53da65823d933a899b5d642afd7a3693617e09b",
     "program": "alcorcli/programs/tool.alcor",
     "program_scope": "repository",
     "program_sha256": "1dcd17c8602e56c81908c7cb8ccc4d195c96b1e5b9d9bba3a1273d98035e796f",
     "schema": "alcor.program.decision-receipt.v1"
    },
    "reason": "the-path-leaves-the-allowed-roots",
    "tool": "write_file",
    "verdict": "deny"
   }
  },
  {
   "seq": 15,
   "kind": "model.call",
   "actor": "ask()",
   "outcome": "admitted",
   "subject": "fast",
   "reason": "",
   "step": 6,
   "id": "b7e0aa22e2c2b96f023b2e14fcdef9417290027a812e54c0426146d211fb31bd",
   "prev": "7c46dc180d11b8dc0619327631ae472ae8d9e53f2280513df3b74fee987b2139",
   "body": {
    "elapsed_ms": 46,
    "finish_reason": "tool_calls",
    "lane": "fast",
    "message_count": 5,
    "model": "demo-model",
    "request_sha256": "2318b1eb40cc2a8ceddd47e6a2a06aa66e7c827641504d79cfd8bccf9e229da3",
    "response_sha256": "d740d0df6e601d8a9141ad91d29663d646844ff8776f272d6b7c4a5b016cbcca",
    "task_verified": false,
    "usage": {
     "completion_tokens": 1,
     "prompt_tokens": 106,
     "total_tokens": 107
    }
   }
  },
  {
   "seq": 16,
   "kind": "tool.decision",
   "actor": "agent loop",
   "outcome": "admitted",
   "subject": "write_file",
   "reason": "inside-the-root-and-below-the-owner-line",
   "step": 6,
   "id": "441397967d7dd18c968133a8b50db388cd3599eb5d2200051622631ade9bf8c4",
   "prev": "b7e0aa22e2c2b96f023b2e14fcdef9417290027a812e54c0426146d211fb31bd",
   "body": {
    "args_sha256": "5082364d5e19b879e39fac832b9df85902c4de5c5ea3aee3fdd1b2d3304b097f",
    "cells": {
     "effect_class": "write",
     "forbidden_pattern": "no",
     "inside_root": "yes",
     "owner_verdict": "proceed",
     "protected_input": "no",
     "tool_kind": "write"
    },
    "policy_receipt": {
     "decision_sha256": "f3c2160a19c75014133eacc57207c0662a72c36b623e8a2c55e151df5fe596f7",
     "effect_authority": false,
     "input_sha256": "a2b03fe0c6a47d8928817537b24d23e8eb5b2c8ca7d0863718f5753a68aa5e98",
     "program": "alcorcli/programs/tool.alcor",
     "program_scope": "repository",
     "program_sha256": "1dcd17c8602e56c81908c7cb8ccc4d195c96b1e5b9d9bba3a1273d98035e796f",
     "schema": "alcor.program.decision-receipt.v1"
    },
    "reason": "inside-the-root-and-below-the-owner-line",
    "tool": "write_file",
    "verdict": "allow"
   }
  },
  {
   "seq": 17,
   "kind": "effect.write",
   "actor": "tool gate",
   "outcome": "admitted",
   "subject": "plan.txt",
   "reason": "",
   "step": 6,
   "id": "7a7dd968ac0fcef3c5b7b8c641ae73f3dbc9943d3ca403ea19cb735cda4a912f",
   "prev": "441397967d7dd18c968133a8b50db388cd3599eb5d2200051622631ade9bf8c4",
   "body": {
    "action": "write",
    "bytes": 9,
    "ok": true,
    "path": "plan.txt",
    "sha256_after": "01d9ce8aac0721c818d37abfa09ffc02a03a1d8ef572cfaf255bb9d29a468a98",
    "sha256_before": null
   }
  },
  {
   "seq": 18,
   "kind": "model.call",
   "actor": "ask()",
   "outcome": "admitted",
   "subject": "fast",
   "reason": "",
   "step": 6,
   "id": "498375a9d9645e89ef1d0434a64425ee6ef7324f2f9d5b19009d64c01b1a41c7",
   "prev": "7a7dd968ac0fcef3c5b7b8c641ae73f3dbc9943d3ca403ea19cb735cda4a912f",
   "body": {
    "elapsed_ms": 31,
    "finish_reason": "stop",
    "lane": "fast",
    "message_count": 6,
    "model": "demo-model",
    "request_sha256": "7b39046071195986a8b6fc3d2db31d10c8012ba25d7f1cac5b6295c35036008d",
    "response_sha256": "87e87d1b9775256fd3864844ef891fe3b775d5ccb7ee50281309dff76c111f56",
    "task_verified": false,
    "usage": {
     "completion_tokens": 2,
     "prompt_tokens": 132,
     "total_tokens": 134
    }
   }
  },
  {
   "seq": 19,
   "kind": "model.call",
   "actor": "ask()",
   "outcome": "admitted",
   "subject": "fast",
   "reason": "",
   "step": 6,
   "id": "7088f5d5679b6504cedf92c5feadfd2b267f933e482b06aa4e6f011b1669754d",
   "prev": "498375a9d9645e89ef1d0434a64425ee6ef7324f2f9d5b19009d64c01b1a41c7",
   "body": {
    "elapsed_ms": 30,
    "finish_reason": "tool_calls",
    "lane": "fast",
    "message_count": 8,
    "model": "demo-model",
    "request_sha256": "bcf30d713f94743e6305ed73d1acb885f69f9b0cd4939ceb75637b56ad016764",
    "response_sha256": "54f66a14b9e606eb778b18716bb45734a6fb318d6de1cd8b751b7fbed8819cc5",
    "task_verified": false,
    "usage": {
     "completion_tokens": 1,
     "prompt_tokens": 171,
     "total_tokens": 172
    }
   }
  },
  {
   "seq": 20,
   "kind": "tool.decision",
   "actor": "agent loop",
   "outcome": "admitted",
   "subject": "read_file",
   "reason": "inside-the-root-and-below-the-owner-line",
   "step": 6,
   "id": "84b2b79976df17824f3bd3d38537644ee94d460e95d643a915a6a7fc4fd880b4",
   "prev": "7088f5d5679b6504cedf92c5feadfd2b267f933e482b06aa4e6f011b1669754d",
   "body": {
    "args_sha256": "ae296b16dee83eb3adec6b85ce4a4764b7beb2df1323426397bd6b5e57f49391",
    "cells": {
     "effect_class": "read",
     "forbidden_pattern": "no",
     "inside_root": "yes",
     "owner_verdict": "proceed",
     "protected_input": "no",
     "tool_kind": "read"
    },
    "policy_receipt": {
     "decision_sha256": "f3c2160a19c75014133eacc57207c0662a72c36b623e8a2c55e151df5fe596f7",
     "effect_authority": false,
     "input_sha256": "1f805e629a90a3caba77231368318d9b271863ccc36587e1a71b0307cf32806d",
     "program": "alcorcli/programs/tool.alcor",
     "program_scope": "repository",
     "program_sha256": "1dcd17c8602e56c81908c7cb8ccc4d195c96b1e5b9d9bba3a1273d98035e796f",
     "schema": "alcor.program.decision-receipt.v1"
    },
    "reason": "inside-the-root-and-below-the-owner-line",
    "tool": "read_file",
    "verdict": "allow"
   }
  },
  {
   "seq": 21,
   "kind": "model.call",
   "actor": "ask()",
   "outcome": "admitted",
   "subject": "fast",
   "reason": "",
   "step": 6,
   "id": "8f2a87a097f5ab4ba5dbd9ea9904b9cf6d40c7cfcac658a72b67ce8b36866e43",
   "prev": "84b2b79976df17824f3bd3d38537644ee94d460e95d643a915a6a7fc4fd880b4",
   "body": {
    "elapsed_ms": 15,
    "finish_reason": "stop",
    "lane": "fast",
    "message_count": 9,
    "model": "demo-model",
    "request_sha256": "5bd89b8306e9b82d965e08dc72aa2bd62647e79f741741f819e24c58ee0c2fa8",
    "response_sha256": "b8fd3a44058326abebc6de78862c4d55942365bd8371408e6ef69275764be3b5",
    "task_verified": false,
    "usage": {
     "completion_tokens": 2,
     "prompt_tokens": 137,
     "total_tokens": 139
    }
   }
  },
  {
   "seq": 22,
   "kind": "agent.turn",
   "actor": "agent loop",
   "outcome": "recorded",
   "subject": "demo",
   "reason": "model_finished",
   "step": 6,
   "id": "49e9573f99432aad22238f277110b4bc79381df780d2eb7d47a372f9d7cdf02f",
   "prev": "8f2a87a097f5ab4ba5dbd9ea9904b9cf6d40c7cfcac658a72b67ce8b36866e43",
   "body": {
    "ended_because": "model_finished",
    "failure_class": null,
    "ok": true,
    "reply_sha256": "283e91eb85d58ffc2ad922884b644c41b54140660f6d1fda3c403d543eedd839",
    "thread_id": "demo",
    "tool_calls": 3,
    "tool_rounds": 3,
    "verify_pushbacks": 1
   }
  },
  {
   "seq": 23,
   "kind": "memory.admitted",
   "actor": "memory",
   "outcome": "admitted",
   "subject": "",
   "reason": "stamped",
   "step": 7,
   "id": "c9100108d20aa87c654b7cc59731d7281506b9801b45319b9cb4aa2623ee7e74",
   "prev": "49e9573f99432aad22238f277110b4bc79381df780d2eb7d47a372f9d7cdf02f",
   "body": {
    "admission": "stamped",
    "entries_after": 1,
    "evidence_sha256": "01d9ce8aac0721c818d37abfa09ffc02a03a1d8ef572cfaf255bb9d29a468a98",
    "id": "e86711bae3b814e150514a69bebba7b233bee0a7b52140623d5b3bfae48258c6",
    "text_sha256": "8f7f33de7f0e0393ed36d28731af7af2e06eb29572f4d97105bd283e721c5e49"
   }
  },
  {
   "seq": 24,
   "kind": "memory.refused",
   "actor": "memory",
   "outcome": "refused",
   "subject": "",
   "reason": "a-result-claimed-without-evidence-is-not-admitted-cite-the-check",
   "step": 7,
   "id": "abc9341892f502cfe5994631c9997f11ff903219b0f515be5ce5cde321a14b0c",
   "prev": "c9100108d20aa87c654b7cc59731d7281506b9801b45319b9cb4aa2623ee7e74",
   "body": {
    "reason": "a-result-claimed-without-evidence-is-not-admitted-cite-the-check",
    "topic": ""
   }
  },
  {
   "seq": 25,
   "kind": "memory.admitted",
   "actor": "memory",
   "outcome": "admitted",
   "subject": "",
   "reason": "testimony",
   "step": 7,
   "id": "429b426d1602abf8599c34fcfa39612e17c1afc2071c4e029f4c83242289dee0",
   "prev": "abc9341892f502cfe5994631c9997f11ff903219b0f515be5ce5cde321a14b0c",
   "body": {
    "admission": "testimony",
    "entries_after": 2,
    "evidence_sha256": null,
    "id": "327d6d6024b85e4adb31281fcf2e912f26afd3199db73a32b7f5322bacc3aec2",
    "text_sha256": "b3dc7ddc0302a18efa6c12da80ea715de56c54719f8320b7dfe665ff29316e59"
   }
  },
  {
   "seq": 26,
   "kind": "memory.lesson-staged",
   "actor": "memory",
   "outcome": "waiting",
   "subject": "p-56efad9ecf",
   "reason": "",
   "step": 7,
   "id": "0b094deef33f11ecb77ad5120b014b48c38c4a03dc315bd0997bfbecabaab374",
   "prev": "429b426d1602abf8599c34fcfa39612e17c1afc2071c4e029f4c83242289dee0",
   "body": {
    "id": "p-56efad9ecf",
    "owner_action": "review-pending-lesson"
   }
  },
  {
   "seq": 27,
   "kind": "memory.lesson-admitted",
   "actor": "memory",
   "outcome": "admitted",
   "subject": "p-56efad9ecf",
   "reason": "",
   "step": 7,
   "id": "15bc7db2471944e244f327a42e511430eb96ea34e5fa2aa2d6b05f2be50bb55d",
   "prev": "0b094deef33f11ecb77ad5120b014b48c38c4a03dc315bd0997bfbecabaab374",
   "body": {
    "id": "p-56efad9ecf",
    "ledger_id": "8e6f4fcefbae54519b22dc40c72d14560019a73d477d65aa4bbfdb65e35814a7"
   }
  },
  {
   "seq": 28,
   "kind": "goal.created",
   "actor": "goal store",
   "outcome": "recorded",
   "subject": "demo-goal",
   "reason": "",
   "step": 8,
   "id": "db40f626c2813f4aa698de7b20dafabe6e526ac3ccd5cba76db652ab43546bac",
   "prev": "15bc7db2471944e244f327a42e511430eb96ea34e5fa2aa2d6b05f2be50bb55d",
   "body": {
    "id": "demo-goal",
    "objective_sha256": "3da5c67af32e3d8461bc959a0925a66eddd70146878b6c75da6c179ccc5db05d",
    "owner": "operator"
   }
  },
  {
   "seq": 29,
   "kind": "goal.decision",
   "actor": "goal store",
   "outcome": "recorded",
   "subject": "demo-goal",
   "reason": "the-approach-is-moving-the-goal-and-has-not-been-refuted",
   "step": 8,
   "id": "be6d245ec62d2157038df21baba4f0bd2945d2bda809e79165659d794d8763f1",
   "prev": "db40f626c2813f4aa698de7b20dafabe6e526ac3ccd5cba76db652ab43546bac",
   "body": {
    "id": "demo-goal",
    "policy_receipt": {
     "decision_sha256": "25760e455cc0e55efa807ccbae8852b02e158e34587a0fa42b8e70b8d410d097",
     "effect_authority": false,
     "input_sha256": "9ac4b6a7b2bd600d2d6e6ff549a4e452f4f1a168cb0788ec7546508afaa630a0",
     "program": "alcorcli/programs/goal.alcor",
     "program_scope": "repository",
     "program_sha256": "62b369b9f414a9b4834ffb65023851f7beb4f33881c6691c673fa6ba46484ef2",
     "schema": "alcor.program.decision-receipt.v1"
    },
    "progress": "advancing",
    "reason": "the-approach-is-moving-the-goal-and-has-not-been-refuted",
    "satisfaction": "failing",
    "verdict": "pursue"
   }
  },
  {
   "seq": 30,
   "kind": "goal.decision",
   "actor": "goal store",
   "outcome": "recorded",
   "subject": "demo-goal",
   "reason": "repeating-an-approach-that-is-not-moving-the-goal-is-not-persistence-it-is-a-loop",
   "step": 8,
   "id": "71736c6bc3dd4544426bb23ce8525cd67f7a145fd9858c3359c6c60c9e7a6fcd",
   "prev": "be6d245ec62d2157038df21baba4f0bd2945d2bda809e79165659d794d8763f1",
   "body": {
    "id": "demo-goal",
    "policy_receipt": {
     "decision_sha256": "e556a90c62d92bf7b8e3668d38e422040b27672e63770351bbcf5b3827ff8700",
     "effect_authority": false,
     "input_sha256": "3b9e8f85bc28e05331dcf6228a75f1afd73b4a81764fae7adf507eb517df35d1",
     "program": "alcorcli/programs/goal.alcor",
     "program_scope": "repository",
     "program_sha256": "62b369b9f414a9b4834ffb65023851f7beb4f33881c6691c673fa6ba46484ef2",
     "schema": "alcor.program.decision-receipt.v1"
    },
    "progress": "stalled",
    "reason": "repeating-an-approach-that-is-not-moving-the-goal-is-not-persistence-it-is-a-loop",
    "satisfaction": "failing",
    "verdict": "change-approach"
   }
  },
  {
   "seq": 31,
   "kind": "goal.satisfied",
   "actor": "goal store",
   "outcome": "recorded",
   "subject": "demo-goal",
   "reason": "",
   "step": 8,
   "id": "03f66a126c618d2442b96660131627cde329ecbb342b9396ff6b1483f025c485",
   "prev": "71736c6bc3dd4544426bb23ce8525cd67f7a145fd9858c3359c6c60c9e7a6fcd",
   "body": {
    "attempts": 5,
    "id": "demo-goal"
   }
  }
 ]
};
