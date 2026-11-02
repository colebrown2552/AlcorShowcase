/**
 * Sample run of the AlcorLang demo, from `python demo/run_demo.py --json`.
 * Generated: regenerate it instead of editing it.
 */
window.ALCOR_RUN = {
 "schema": "alcor.lang.demo-summary.v1",
 "component": "AlcorLang",
 "programs": [
  {
   "file": "quorum_gate.alcor",
   "caption": "Four votes, four verdicts: veto beats everything.",
   "input": "",
   "source": "PROGRAM QuorumGateDemo\nCALL QuorumGate WITH $yes=3 $no=0 $allow_at=3 $refuse_at=2 $veto=0 INTO $first\nEMIT $first\nCALL QuorumGate WITH $yes=4 $no=0 $allow_at=3 $refuse_at=2 $veto=1 INTO $second\nEMIT $second\nCALL QuorumGate WITH $yes=2 $no=1 $allow_at=3 $refuse_at=2 $veto=0 INTO $third\nEMIT $third\nCALL QuorumGate WITH $yes=3 $no=2 $allow_at=3 $refuse_at=2 $veto=0 INTO $fourth\nEMIT $fourth\nEND PROGRAM\n\nPROGRAM QuorumGate\nBRANCH EQ $veto 1 refuse ELSE no_veto\nLABEL no_veto\nBRANCH GE $no $refuse_at refuse ELSE check_allow\nLABEL check_allow\nBRANCH GE $yes $allow_at allow ELSE hold\nLABEL refuse\nRETURN \"REFUSE\"\nLABEL allow\nRETURN \"ALLOW\"\nLABEL hold\nRETURN \"HOLD\"\nEND PROGRAM\n",
   "output": [
    "ALLOW",
    "REFUSE",
    "HOLD",
    "REFUSE"
   ],
   "profile": "default",
   "steps": 62,
   "fuel": 10000000,
   "headroom": 9999938,
   "trap": null,
   "lint": {
    "summary": {
     "error": 0,
     "info": 0,
     "total": 0,
     "warning": 0
    },
    "diagnostics": []
   },
   "trace": [
    {
     "n": 0,
     "pc": 0,
     "op": "CONST",
     "ins": [
      "%1",
      "3"
     ],
     "block": "QuorumGateDemo",
     "cells": {},
     "tape_len": 0
    },
    {
     "n": 1,
     "pc": 1,
     "op": "CONST",
     "ins": [
      "%2",
      "0"
     ],
     "block": "QuorumGateDemo",
     "cells": {},
     "tape_len": 0
    },
    {
     "n": 2,
     "pc": 2,
     "op": "CONST",
     "ins": [
      "%3",
      "3"
     ],
     "block": "QuorumGateDemo",
     "cells": {},
     "tape_len": 0
    },
    {
     "n": 3,
     "pc": 3,
     "op": "CONST",
     "ins": [
      "%4",
      "2"
     ],
     "block": "QuorumGateDemo",
     "cells": {},
     "tape_len": 0
    },
    {
     "n": 4,
     "pc": 4,
     "op": "CONST",
     "ins": [
      "%5",
      "0"
     ],
     "block": "QuorumGateDemo",
     "cells": {},
     "tape_len": 0
    },
    {
     "n": 5,
     "pc": 5,
     "op": "CALL",
     "ins": [
      "QuorumGate",
      "[('yes', '%1'), ('no', '%2'), ('allow_at', '%3'), ('refuse_at', '%4'), ('veto', '%5')]",
      "$first"
     ],
     "block": "QuorumGateDemo",
     "cells": {},
     "tape_len": 0
    },
    {
     "n": 6,
     "pc": 0,
     "op": "CONST",
     "ins": [
      "%1",
      "1"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "0",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 0
    },
    {
     "n": 7,
     "pc": 1,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%2",
      "$veto",
      "%1"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "0",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 0
    },
    {
     "n": 8,
     "pc": 2,
     "op": "JZ",
     "ins": [
      "%2",
      "4"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "0",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 0
    },
    {
     "n": 9,
     "pc": 4,
     "op": "BINOP",
     "ins": [
      "GE",
      "%3",
      "$no",
      "$refuse_at"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "0",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 0
    },
    {
     "n": 10,
     "pc": 5,
     "op": "JZ",
     "ins": [
      "%3",
      "7"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "0",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 0
    },
    {
     "n": 11,
     "pc": 7,
     "op": "BINOP",
     "ins": [
      "GE",
      "%4",
      "$yes",
      "$allow_at"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "0",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 0
    },
    {
     "n": 12,
     "pc": 8,
     "op": "JZ",
     "ins": [
      "%4",
      "14"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "0",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 0
    },
    {
     "n": 13,
     "pc": 9,
     "op": "JMP",
     "ins": [
      "12"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "0",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 0
    },
    {
     "n": 14,
     "pc": 12,
     "op": "CONST",
     "ins": [
      "%6",
      "ALLOW"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "0",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 0
    },
    {
     "n": 15,
     "pc": 13,
     "op": "RET",
     "ins": [
      "%6"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "0",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 0
    },
    {
     "n": 16,
     "pc": 6,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "$first"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW"
     },
     "tape_len": 0
    },
    {
     "n": 17,
     "pc": 7,
     "op": "CONST",
     "ins": [
      "%6",
      "4"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW"
     },
     "tape_len": 1
    },
    {
     "n": 18,
     "pc": 8,
     "op": "CONST",
     "ins": [
      "%7",
      "0"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW"
     },
     "tape_len": 1
    },
    {
     "n": 19,
     "pc": 9,
     "op": "CONST",
     "ins": [
      "%8",
      "3"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW"
     },
     "tape_len": 1
    },
    {
     "n": 20,
     "pc": 10,
     "op": "CONST",
     "ins": [
      "%9",
      "2"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW"
     },
     "tape_len": 1
    },
    {
     "n": 21,
     "pc": 11,
     "op": "CONST",
     "ins": [
      "%10",
      "1"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW"
     },
     "tape_len": 1
    },
    {
     "n": 22,
     "pc": 12,
     "op": "CALL",
     "ins": [
      "QuorumGate",
      "[('yes', '%6'), ('no', '%7'), ('allow_at', '%8'), ('refuse_at', '%9'), ('veto', '%10')]",
      "$second"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW"
     },
     "tape_len": 1
    },
    {
     "n": 23,
     "pc": 0,
     "op": "CONST",
     "ins": [
      "%1",
      "1"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "4",
      "$no": "0",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "1"
     },
     "tape_len": 1
    },
    {
     "n": 24,
     "pc": 1,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%2",
      "$veto",
      "%1"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "4",
      "$no": "0",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "1"
     },
     "tape_len": 1
    },
    {
     "n": 25,
     "pc": 2,
     "op": "JZ",
     "ins": [
      "%2",
      "4"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "4",
      "$no": "0",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "1"
     },
     "tape_len": 1
    },
    {
     "n": 26,
     "pc": 3,
     "op": "JMP",
     "ins": [
      "10"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "4",
      "$no": "0",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "1"
     },
     "tape_len": 1
    },
    {
     "n": 27,
     "pc": 10,
     "op": "CONST",
     "ins": [
      "%5",
      "REFUSE"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "4",
      "$no": "0",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "1"
     },
     "tape_len": 1
    },
    {
     "n": 28,
     "pc": 11,
     "op": "RET",
     "ins": [
      "%5"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "4",
      "$no": "0",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "1"
     },
     "tape_len": 1
    },
    {
     "n": 29,
     "pc": 13,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "$second"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW",
      "$second": "REFUSE"
     },
     "tape_len": 1
    },
    {
     "n": 30,
     "pc": 14,
     "op": "CONST",
     "ins": [
      "%11",
      "2"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW",
      "$second": "REFUSE"
     },
     "tape_len": 2
    },
    {
     "n": 31,
     "pc": 15,
     "op": "CONST",
     "ins": [
      "%12",
      "1"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW",
      "$second": "REFUSE"
     },
     "tape_len": 2
    },
    {
     "n": 32,
     "pc": 16,
     "op": "CONST",
     "ins": [
      "%13",
      "3"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW",
      "$second": "REFUSE"
     },
     "tape_len": 2
    },
    {
     "n": 33,
     "pc": 17,
     "op": "CONST",
     "ins": [
      "%14",
      "2"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW",
      "$second": "REFUSE"
     },
     "tape_len": 2
    },
    {
     "n": 34,
     "pc": 18,
     "op": "CONST",
     "ins": [
      "%15",
      "0"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW",
      "$second": "REFUSE"
     },
     "tape_len": 2
    },
    {
     "n": 35,
     "pc": 19,
     "op": "CALL",
     "ins": [
      "QuorumGate",
      "[('yes', '%11'), ('no', '%12'), ('allow_at', '%13'), ('refuse_at', '%14'), ('veto', '%15')]",
      "$third"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW",
      "$second": "REFUSE"
     },
     "tape_len": 2
    },
    {
     "n": 36,
     "pc": 0,
     "op": "CONST",
     "ins": [
      "%1",
      "1"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "2",
      "$no": "1",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 2
    },
    {
     "n": 37,
     "pc": 1,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%2",
      "$veto",
      "%1"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "2",
      "$no": "1",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 2
    },
    {
     "n": 38,
     "pc": 2,
     "op": "JZ",
     "ins": [
      "%2",
      "4"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "2",
      "$no": "1",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 2
    },
    {
     "n": 39,
     "pc": 4,
     "op": "BINOP",
     "ins": [
      "GE",
      "%3",
      "$no",
      "$refuse_at"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "2",
      "$no": "1",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 2
    },
    {
     "n": 40,
     "pc": 5,
     "op": "JZ",
     "ins": [
      "%3",
      "7"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "2",
      "$no": "1",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 2
    },
    {
     "n": 41,
     "pc": 7,
     "op": "BINOP",
     "ins": [
      "GE",
      "%4",
      "$yes",
      "$allow_at"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "2",
      "$no": "1",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 2
    },
    {
     "n": 42,
     "pc": 8,
     "op": "JZ",
     "ins": [
      "%4",
      "14"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "2",
      "$no": "1",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 2
    },
    {
     "n": 43,
     "pc": 14,
     "op": "CONST",
     "ins": [
      "%7",
      "HOLD"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "2",
      "$no": "1",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 2
    },
    {
     "n": 44,
     "pc": 15,
     "op": "RET",
     "ins": [
      "%7"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "2",
      "$no": "1",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 2
    },
    {
     "n": 45,
     "pc": 20,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "$third"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW",
      "$second": "REFUSE",
      "$third": "HOLD"
     },
     "tape_len": 2
    },
    {
     "n": 46,
     "pc": 21,
     "op": "CONST",
     "ins": [
      "%16",
      "3"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW",
      "$second": "REFUSE",
      "$third": "HOLD"
     },
     "tape_len": 3
    },
    {
     "n": 47,
     "pc": 22,
     "op": "CONST",
     "ins": [
      "%17",
      "2"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW",
      "$second": "REFUSE",
      "$third": "HOLD"
     },
     "tape_len": 3
    },
    {
     "n": 48,
     "pc": 23,
     "op": "CONST",
     "ins": [
      "%18",
      "3"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW",
      "$second": "REFUSE",
      "$third": "HOLD"
     },
     "tape_len": 3
    },
    {
     "n": 49,
     "pc": 24,
     "op": "CONST",
     "ins": [
      "%19",
      "2"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW",
      "$second": "REFUSE",
      "$third": "HOLD"
     },
     "tape_len": 3
    },
    {
     "n": 50,
     "pc": 25,
     "op": "CONST",
     "ins": [
      "%20",
      "0"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW",
      "$second": "REFUSE",
      "$third": "HOLD"
     },
     "tape_len": 3
    },
    {
     "n": 51,
     "pc": 26,
     "op": "CALL",
     "ins": [
      "QuorumGate",
      "[('yes', '%16'), ('no', '%17'), ('allow_at', '%18'), ('refuse_at', '%19'), ('veto', '%20')]",
      "$fourth"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW",
      "$second": "REFUSE",
      "$third": "HOLD"
     },
     "tape_len": 3
    },
    {
     "n": 52,
     "pc": 0,
     "op": "CONST",
     "ins": [
      "%1",
      "1"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "2",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 3
    },
    {
     "n": 53,
     "pc": 1,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%2",
      "$veto",
      "%1"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "2",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 3
    },
    {
     "n": 54,
     "pc": 2,
     "op": "JZ",
     "ins": [
      "%2",
      "4"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "2",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 3
    },
    {
     "n": 55,
     "pc": 4,
     "op": "BINOP",
     "ins": [
      "GE",
      "%3",
      "$no",
      "$refuse_at"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "2",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 3
    },
    {
     "n": 56,
     "pc": 5,
     "op": "JZ",
     "ins": [
      "%3",
      "7"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "2",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 3
    },
    {
     "n": 57,
     "pc": 6,
     "op": "JMP",
     "ins": [
      "10"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "2",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 3
    },
    {
     "n": 58,
     "pc": 10,
     "op": "CONST",
     "ins": [
      "%5",
      "REFUSE"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "2",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 3
    },
    {
     "n": 59,
     "pc": 11,
     "op": "RET",
     "ins": [
      "%5"
     ],
     "block": "QuorumGate",
     "cells": {
      "$yes": "3",
      "$no": "2",
      "$allow_at": "3",
      "$refuse_at": "2",
      "$veto": "0"
     },
     "tape_len": 3
    },
    {
     "n": 60,
     "pc": 27,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "$fourth"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW",
      "$second": "REFUSE",
      "$third": "HOLD",
      "$fourth": "REFUSE"
     },
     "tape_len": 3
    },
    {
     "n": 61,
     "pc": 28,
     "op": "RET",
     "ins": [
      "None"
     ],
     "block": "QuorumGateDemo",
     "cells": {
      "$first": "ALLOW",
      "$second": "REFUSE",
      "$third": "HOLD",
      "$fourth": "REFUSE"
     },
     "tape_len": 4
    }
   ],
   "trace_shown": 62
  },
  {
   "file": "capped_backoff.alcor",
   "caption": "Retry delays that double and stop at a cap.",
   "input": "",
   "source": "PROGRAM CappedBackoffDemo\nCALL CappedBackoff WITH $attempt=0 $base=5 $cap=60 INTO $d0\nEMIT $d0\nCALL CappedBackoff WITH $attempt=1 $base=5 $cap=60 INTO $d1\nEMIT $d1\nCALL CappedBackoff WITH $attempt=2 $base=5 $cap=60 INTO $d2\nEMIT $d2\nCALL CappedBackoff WITH $attempt=3 $base=5 $cap=60 INTO $d3\nEMIT $d3\nCALL CappedBackoff WITH $attempt=4 $base=5 $cap=60 INTO $d4\nEMIT $d4\nCALL CappedBackoff WITH $attempt=9 $base=5 $cap=60 INTO $d9\nEMIT $d9\nEND PROGRAM\n\nPROGRAM CappedBackoff\nBRANCH LE $attempt 0 attempt0 ELSE check1\nLABEL check1\nBRANCH EQ $attempt 1 attempt1 ELSE check2\nLABEL check2\nBRANCH EQ $attempt 2 attempt2 ELSE check3\nLABEL check3\nBRANCH EQ $attempt 3 attempt3 ELSE check4\nLABEL check4\nBRANCH EQ $attempt 4 attempt4 ELSE capped\nLABEL attempt0\nLET $raw $base\nCALL Min WITH $left=$raw $right=$cap INTO $bounded\nRETURN $bounded\nLABEL attempt1\nLET $raw MUL $base 2\nCALL Min WITH $left=$raw $right=$cap INTO $bounded\nRETURN $bounded\nLABEL attempt2\nLET $raw MUL $base 4\nCALL Min WITH $left=$raw $right=$cap INTO $bounded\nRETURN $bounded\nLABEL attempt3\nLET $raw MUL $base 8\nCALL Min WITH $left=$raw $right=$cap INTO $bounded\nRETURN $bounded\nLABEL attempt4\nLET $raw MUL $base 16\nCALL Min WITH $left=$raw $right=$cap INTO $bounded\nRETURN $bounded\nLABEL capped\nRETURN $cap\nEND PROGRAM\n\nPROGRAM Min\nBRANCH LE $left $right take_left ELSE take_right\nLABEL take_left\nRETURN $left\nLABEL take_right\nRETURN $right\nEND PROGRAM\n",
   "output": [
    "5",
    "10",
    "20",
    "40",
    "60",
    "60"
   ],
   "profile": "default",
   "steps": 139,
   "fuel": 10000000,
   "headroom": 9999861,
   "trap": null,
   "lint": {
    "summary": {
     "error": 0,
     "info": 0,
     "total": 0,
     "warning": 0
    },
    "diagnostics": []
   },
   "trace": [
    {
     "n": 0,
     "pc": 0,
     "op": "CONST",
     "ins": [
      "%1",
      "0"
     ],
     "block": "CappedBackoffDemo",
     "cells": {},
     "tape_len": 0
    },
    {
     "n": 1,
     "pc": 1,
     "op": "CONST",
     "ins": [
      "%2",
      "5"
     ],
     "block": "CappedBackoffDemo",
     "cells": {},
     "tape_len": 0
    },
    {
     "n": 2,
     "pc": 2,
     "op": "CONST",
     "ins": [
      "%3",
      "60"
     ],
     "block": "CappedBackoffDemo",
     "cells": {},
     "tape_len": 0
    },
    {
     "n": 3,
     "pc": 3,
     "op": "CALL",
     "ins": [
      "CappedBackoff",
      "[('attempt', '%1'), ('base', '%2'), ('cap', '%3')]",
      "$d0"
     ],
     "block": "CappedBackoffDemo",
     "cells": {},
     "tape_len": 0
    },
    {
     "n": 4,
     "pc": 0,
     "op": "CONST",
     "ins": [
      "%1",
      "0"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "0",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 0
    },
    {
     "n": 5,
     "pc": 1,
     "op": "BINOP",
     "ins": [
      "LE",
      "%2",
      "$attempt",
      "%1"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "0",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 0
    },
    {
     "n": 6,
     "pc": 2,
     "op": "JZ",
     "ins": [
      "%2",
      "4"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "0",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 0
    },
    {
     "n": 7,
     "pc": 3,
     "op": "JMP",
     "ins": [
      "20"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "0",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 0
    },
    {
     "n": 8,
     "pc": 20,
     "op": "MOV",
     "ins": [
      "$raw",
      "$base"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "0",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 0
    },
    {
     "n": 9,
     "pc": 21,
     "op": "CALL",
     "ins": [
      "Min",
      "[('left', '$raw'), ('right', '$cap')]",
      "$bounded"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "0",
      "$base": "5",
      "$cap": "60",
      "$raw": "5"
     },
     "tape_len": 0
    },
    {
     "n": 10,
     "pc": 0,
     "op": "BINOP",
     "ins": [
      "LE",
      "%1",
      "$left",
      "$right"
     ],
     "block": "Min",
     "cells": {
      "$left": "5",
      "$right": "60"
     },
     "tape_len": 0
    },
    {
     "n": 11,
     "pc": 1,
     "op": "JZ",
     "ins": [
      "%1",
      "4"
     ],
     "block": "Min",
     "cells": {
      "$left": "5",
      "$right": "60"
     },
     "tape_len": 0
    },
    {
     "n": 12,
     "pc": 2,
     "op": "JMP",
     "ins": [
      "3"
     ],
     "block": "Min",
     "cells": {
      "$left": "5",
      "$right": "60"
     },
     "tape_len": 0
    },
    {
     "n": 13,
     "pc": 3,
     "op": "RET",
     "ins": [
      "$left"
     ],
     "block": "Min",
     "cells": {
      "$left": "5",
      "$right": "60"
     },
     "tape_len": 0
    },
    {
     "n": 14,
     "pc": 22,
     "op": "RET",
     "ins": [
      "$bounded"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "0",
      "$base": "5",
      "$cap": "60",
      "$raw": "5",
      "$bounded": "5"
     },
     "tape_len": 0
    },
    {
     "n": 15,
     "pc": 4,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "$d0"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5"
     },
     "tape_len": 0
    },
    {
     "n": 16,
     "pc": 5,
     "op": "CONST",
     "ins": [
      "%4",
      "1"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5"
     },
     "tape_len": 1
    },
    {
     "n": 17,
     "pc": 6,
     "op": "CONST",
     "ins": [
      "%5",
      "5"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5"
     },
     "tape_len": 1
    },
    {
     "n": 18,
     "pc": 7,
     "op": "CONST",
     "ins": [
      "%6",
      "60"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5"
     },
     "tape_len": 1
    },
    {
     "n": 19,
     "pc": 8,
     "op": "CALL",
     "ins": [
      "CappedBackoff",
      "[('attempt', '%4'), ('base', '%5'), ('cap', '%6')]",
      "$d1"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5"
     },
     "tape_len": 1
    },
    {
     "n": 20,
     "pc": 0,
     "op": "CONST",
     "ins": [
      "%1",
      "0"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "1",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 1
    },
    {
     "n": 21,
     "pc": 1,
     "op": "BINOP",
     "ins": [
      "LE",
      "%2",
      "$attempt",
      "%1"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "1",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 1
    },
    {
     "n": 22,
     "pc": 2,
     "op": "JZ",
     "ins": [
      "%2",
      "4"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "1",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 1
    },
    {
     "n": 23,
     "pc": 4,
     "op": "CONST",
     "ins": [
      "%3",
      "1"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "1",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 1
    },
    {
     "n": 24,
     "pc": 5,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%4",
      "$attempt",
      "%3"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "1",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 1
    },
    {
     "n": 25,
     "pc": 6,
     "op": "JZ",
     "ins": [
      "%4",
      "8"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "1",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 1
    },
    {
     "n": 26,
     "pc": 7,
     "op": "JMP",
     "ins": [
      "23"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "1",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 1
    },
    {
     "n": 27,
     "pc": 23,
     "op": "CONST",
     "ins": [
      "%11",
      "2"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "1",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 1
    },
    {
     "n": 28,
     "pc": 24,
     "op": "BINOP",
     "ins": [
      "MUL",
      "%12",
      "$base",
      "%11"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "1",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 1
    },
    {
     "n": 29,
     "pc": 25,
     "op": "MOV",
     "ins": [
      "$raw",
      "%12"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "1",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 1
    },
    {
     "n": 30,
     "pc": 26,
     "op": "CALL",
     "ins": [
      "Min",
      "[('left', '$raw'), ('right', '$cap')]",
      "$bounded"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "1",
      "$base": "5",
      "$cap": "60",
      "$raw": "10"
     },
     "tape_len": 1
    },
    {
     "n": 31,
     "pc": 0,
     "op": "BINOP",
     "ins": [
      "LE",
      "%1",
      "$left",
      "$right"
     ],
     "block": "Min",
     "cells": {
      "$left": "10",
      "$right": "60"
     },
     "tape_len": 1
    },
    {
     "n": 32,
     "pc": 1,
     "op": "JZ",
     "ins": [
      "%1",
      "4"
     ],
     "block": "Min",
     "cells": {
      "$left": "10",
      "$right": "60"
     },
     "tape_len": 1
    },
    {
     "n": 33,
     "pc": 2,
     "op": "JMP",
     "ins": [
      "3"
     ],
     "block": "Min",
     "cells": {
      "$left": "10",
      "$right": "60"
     },
     "tape_len": 1
    },
    {
     "n": 34,
     "pc": 3,
     "op": "RET",
     "ins": [
      "$left"
     ],
     "block": "Min",
     "cells": {
      "$left": "10",
      "$right": "60"
     },
     "tape_len": 1
    },
    {
     "n": 35,
     "pc": 27,
     "op": "RET",
     "ins": [
      "$bounded"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "1",
      "$base": "5",
      "$cap": "60",
      "$raw": "10",
      "$bounded": "10"
     },
     "tape_len": 1
    },
    {
     "n": 36,
     "pc": 9,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "$d1"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10"
     },
     "tape_len": 1
    },
    {
     "n": 37,
     "pc": 10,
     "op": "CONST",
     "ins": [
      "%7",
      "2"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10"
     },
     "tape_len": 2
    },
    {
     "n": 38,
     "pc": 11,
     "op": "CONST",
     "ins": [
      "%8",
      "5"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10"
     },
     "tape_len": 2
    },
    {
     "n": 39,
     "pc": 12,
     "op": "CONST",
     "ins": [
      "%9",
      "60"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10"
     },
     "tape_len": 2
    },
    {
     "n": 40,
     "pc": 13,
     "op": "CALL",
     "ins": [
      "CappedBackoff",
      "[('attempt', '%7'), ('base', '%8'), ('cap', '%9')]",
      "$d2"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10"
     },
     "tape_len": 2
    },
    {
     "n": 41,
     "pc": 0,
     "op": "CONST",
     "ins": [
      "%1",
      "0"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "2",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 2
    },
    {
     "n": 42,
     "pc": 1,
     "op": "BINOP",
     "ins": [
      "LE",
      "%2",
      "$attempt",
      "%1"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "2",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 2
    },
    {
     "n": 43,
     "pc": 2,
     "op": "JZ",
     "ins": [
      "%2",
      "4"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "2",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 2
    },
    {
     "n": 44,
     "pc": 4,
     "op": "CONST",
     "ins": [
      "%3",
      "1"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "2",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 2
    },
    {
     "n": 45,
     "pc": 5,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%4",
      "$attempt",
      "%3"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "2",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 2
    },
    {
     "n": 46,
     "pc": 6,
     "op": "JZ",
     "ins": [
      "%4",
      "8"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "2",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 2
    },
    {
     "n": 47,
     "pc": 8,
     "op": "CONST",
     "ins": [
      "%5",
      "2"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "2",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 2
    },
    {
     "n": 48,
     "pc": 9,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%6",
      "$attempt",
      "%5"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "2",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 2
    },
    {
     "n": 49,
     "pc": 10,
     "op": "JZ",
     "ins": [
      "%6",
      "12"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "2",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 2
    },
    {
     "n": 50,
     "pc": 11,
     "op": "JMP",
     "ins": [
      "28"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "2",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 2
    },
    {
     "n": 51,
     "pc": 28,
     "op": "CONST",
     "ins": [
      "%13",
      "4"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "2",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 2
    },
    {
     "n": 52,
     "pc": 29,
     "op": "BINOP",
     "ins": [
      "MUL",
      "%14",
      "$base",
      "%13"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "2",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 2
    },
    {
     "n": 53,
     "pc": 30,
     "op": "MOV",
     "ins": [
      "$raw",
      "%14"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "2",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 2
    },
    {
     "n": 54,
     "pc": 31,
     "op": "CALL",
     "ins": [
      "Min",
      "[('left', '$raw'), ('right', '$cap')]",
      "$bounded"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "2",
      "$base": "5",
      "$cap": "60",
      "$raw": "20"
     },
     "tape_len": 2
    },
    {
     "n": 55,
     "pc": 0,
     "op": "BINOP",
     "ins": [
      "LE",
      "%1",
      "$left",
      "$right"
     ],
     "block": "Min",
     "cells": {
      "$left": "20",
      "$right": "60"
     },
     "tape_len": 2
    },
    {
     "n": 56,
     "pc": 1,
     "op": "JZ",
     "ins": [
      "%1",
      "4"
     ],
     "block": "Min",
     "cells": {
      "$left": "20",
      "$right": "60"
     },
     "tape_len": 2
    },
    {
     "n": 57,
     "pc": 2,
     "op": "JMP",
     "ins": [
      "3"
     ],
     "block": "Min",
     "cells": {
      "$left": "20",
      "$right": "60"
     },
     "tape_len": 2
    },
    {
     "n": 58,
     "pc": 3,
     "op": "RET",
     "ins": [
      "$left"
     ],
     "block": "Min",
     "cells": {
      "$left": "20",
      "$right": "60"
     },
     "tape_len": 2
    },
    {
     "n": 59,
     "pc": 32,
     "op": "RET",
     "ins": [
      "$bounded"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "2",
      "$base": "5",
      "$cap": "60",
      "$raw": "20",
      "$bounded": "20"
     },
     "tape_len": 2
    },
    {
     "n": 60,
     "pc": 14,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "$d2"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10",
      "$d2": "20"
     },
     "tape_len": 2
    },
    {
     "n": 61,
     "pc": 15,
     "op": "CONST",
     "ins": [
      "%10",
      "3"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10",
      "$d2": "20"
     },
     "tape_len": 3
    },
    {
     "n": 62,
     "pc": 16,
     "op": "CONST",
     "ins": [
      "%11",
      "5"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10",
      "$d2": "20"
     },
     "tape_len": 3
    },
    {
     "n": 63,
     "pc": 17,
     "op": "CONST",
     "ins": [
      "%12",
      "60"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10",
      "$d2": "20"
     },
     "tape_len": 3
    },
    {
     "n": 64,
     "pc": 18,
     "op": "CALL",
     "ins": [
      "CappedBackoff",
      "[('attempt', '%10'), ('base', '%11'), ('cap', '%12')]",
      "$d3"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10",
      "$d2": "20"
     },
     "tape_len": 3
    },
    {
     "n": 65,
     "pc": 0,
     "op": "CONST",
     "ins": [
      "%1",
      "0"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 3
    },
    {
     "n": 66,
     "pc": 1,
     "op": "BINOP",
     "ins": [
      "LE",
      "%2",
      "$attempt",
      "%1"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 3
    },
    {
     "n": 67,
     "pc": 2,
     "op": "JZ",
     "ins": [
      "%2",
      "4"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 3
    },
    {
     "n": 68,
     "pc": 4,
     "op": "CONST",
     "ins": [
      "%3",
      "1"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 3
    },
    {
     "n": 69,
     "pc": 5,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%4",
      "$attempt",
      "%3"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 3
    },
    {
     "n": 70,
     "pc": 6,
     "op": "JZ",
     "ins": [
      "%4",
      "8"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 3
    },
    {
     "n": 71,
     "pc": 8,
     "op": "CONST",
     "ins": [
      "%5",
      "2"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 3
    },
    {
     "n": 72,
     "pc": 9,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%6",
      "$attempt",
      "%5"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 3
    },
    {
     "n": 73,
     "pc": 10,
     "op": "JZ",
     "ins": [
      "%6",
      "12"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 3
    },
    {
     "n": 74,
     "pc": 12,
     "op": "CONST",
     "ins": [
      "%7",
      "3"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 3
    },
    {
     "n": 75,
     "pc": 13,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%8",
      "$attempt",
      "%7"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 3
    },
    {
     "n": 76,
     "pc": 14,
     "op": "JZ",
     "ins": [
      "%8",
      "16"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 3
    },
    {
     "n": 77,
     "pc": 15,
     "op": "JMP",
     "ins": [
      "33"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 3
    },
    {
     "n": 78,
     "pc": 33,
     "op": "CONST",
     "ins": [
      "%15",
      "8"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 3
    },
    {
     "n": 79,
     "pc": 34,
     "op": "BINOP",
     "ins": [
      "MUL",
      "%16",
      "$base",
      "%15"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 3
    },
    {
     "n": 80,
     "pc": 35,
     "op": "MOV",
     "ins": [
      "$raw",
      "%16"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 3
    },
    {
     "n": 81,
     "pc": 36,
     "op": "CALL",
     "ins": [
      "Min",
      "[('left', '$raw'), ('right', '$cap')]",
      "$bounded"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60",
      "$raw": "40"
     },
     "tape_len": 3
    },
    {
     "n": 82,
     "pc": 0,
     "op": "BINOP",
     "ins": [
      "LE",
      "%1",
      "$left",
      "$right"
     ],
     "block": "Min",
     "cells": {
      "$left": "40",
      "$right": "60"
     },
     "tape_len": 3
    },
    {
     "n": 83,
     "pc": 1,
     "op": "JZ",
     "ins": [
      "%1",
      "4"
     ],
     "block": "Min",
     "cells": {
      "$left": "40",
      "$right": "60"
     },
     "tape_len": 3
    },
    {
     "n": 84,
     "pc": 2,
     "op": "JMP",
     "ins": [
      "3"
     ],
     "block": "Min",
     "cells": {
      "$left": "40",
      "$right": "60"
     },
     "tape_len": 3
    },
    {
     "n": 85,
     "pc": 3,
     "op": "RET",
     "ins": [
      "$left"
     ],
     "block": "Min",
     "cells": {
      "$left": "40",
      "$right": "60"
     },
     "tape_len": 3
    },
    {
     "n": 86,
     "pc": 37,
     "op": "RET",
     "ins": [
      "$bounded"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "3",
      "$base": "5",
      "$cap": "60",
      "$raw": "40",
      "$bounded": "40"
     },
     "tape_len": 3
    },
    {
     "n": 87,
     "pc": 19,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "$d3"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10",
      "$d2": "20",
      "$d3": "40"
     },
     "tape_len": 3
    },
    {
     "n": 88,
     "pc": 20,
     "op": "CONST",
     "ins": [
      "%13",
      "4"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10",
      "$d2": "20",
      "$d3": "40"
     },
     "tape_len": 4
    },
    {
     "n": 89,
     "pc": 21,
     "op": "CONST",
     "ins": [
      "%14",
      "5"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10",
      "$d2": "20",
      "$d3": "40"
     },
     "tape_len": 4
    },
    {
     "n": 90,
     "pc": 22,
     "op": "CONST",
     "ins": [
      "%15",
      "60"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10",
      "$d2": "20",
      "$d3": "40"
     },
     "tape_len": 4
    },
    {
     "n": 91,
     "pc": 23,
     "op": "CALL",
     "ins": [
      "CappedBackoff",
      "[('attempt', '%13'), ('base', '%14'), ('cap', '%15')]",
      "$d4"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10",
      "$d2": "20",
      "$d3": "40"
     },
     "tape_len": 4
    },
    {
     "n": 92,
     "pc": 0,
     "op": "CONST",
     "ins": [
      "%1",
      "0"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 93,
     "pc": 1,
     "op": "BINOP",
     "ins": [
      "LE",
      "%2",
      "$attempt",
      "%1"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 94,
     "pc": 2,
     "op": "JZ",
     "ins": [
      "%2",
      "4"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 95,
     "pc": 4,
     "op": "CONST",
     "ins": [
      "%3",
      "1"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 96,
     "pc": 5,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%4",
      "$attempt",
      "%3"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 97,
     "pc": 6,
     "op": "JZ",
     "ins": [
      "%4",
      "8"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 98,
     "pc": 8,
     "op": "CONST",
     "ins": [
      "%5",
      "2"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 99,
     "pc": 9,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%6",
      "$attempt",
      "%5"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 100,
     "pc": 10,
     "op": "JZ",
     "ins": [
      "%6",
      "12"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 101,
     "pc": 12,
     "op": "CONST",
     "ins": [
      "%7",
      "3"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 102,
     "pc": 13,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%8",
      "$attempt",
      "%7"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 103,
     "pc": 14,
     "op": "JZ",
     "ins": [
      "%8",
      "16"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 104,
     "pc": 16,
     "op": "CONST",
     "ins": [
      "%9",
      "4"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 105,
     "pc": 17,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%10",
      "$attempt",
      "%9"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 106,
     "pc": 18,
     "op": "JZ",
     "ins": [
      "%10",
      "43"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 107,
     "pc": 19,
     "op": "JMP",
     "ins": [
      "38"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 108,
     "pc": 38,
     "op": "CONST",
     "ins": [
      "%17",
      "16"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 109,
     "pc": 39,
     "op": "BINOP",
     "ins": [
      "MUL",
      "%18",
      "$base",
      "%17"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 110,
     "pc": 40,
     "op": "MOV",
     "ins": [
      "$raw",
      "%18"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 4
    },
    {
     "n": 111,
     "pc": 41,
     "op": "CALL",
     "ins": [
      "Min",
      "[('left', '$raw'), ('right', '$cap')]",
      "$bounded"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60",
      "$raw": "80"
     },
     "tape_len": 4
    },
    {
     "n": 112,
     "pc": 0,
     "op": "BINOP",
     "ins": [
      "LE",
      "%1",
      "$left",
      "$right"
     ],
     "block": "Min",
     "cells": {
      "$left": "80",
      "$right": "60"
     },
     "tape_len": 4
    },
    {
     "n": 113,
     "pc": 1,
     "op": "JZ",
     "ins": [
      "%1",
      "4"
     ],
     "block": "Min",
     "cells": {
      "$left": "80",
      "$right": "60"
     },
     "tape_len": 4
    },
    {
     "n": 114,
     "pc": 4,
     "op": "RET",
     "ins": [
      "$right"
     ],
     "block": "Min",
     "cells": {
      "$left": "80",
      "$right": "60"
     },
     "tape_len": 4
    },
    {
     "n": 115,
     "pc": 42,
     "op": "RET",
     "ins": [
      "$bounded"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "4",
      "$base": "5",
      "$cap": "60",
      "$raw": "80",
      "$bounded": "60"
     },
     "tape_len": 4
    },
    {
     "n": 116,
     "pc": 24,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "$d4"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10",
      "$d2": "20",
      "$d3": "40",
      "$d4": "60"
     },
     "tape_len": 4
    },
    {
     "n": 117,
     "pc": 25,
     "op": "CONST",
     "ins": [
      "%16",
      "9"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10",
      "$d2": "20",
      "$d3": "40",
      "$d4": "60"
     },
     "tape_len": 5
    },
    {
     "n": 118,
     "pc": 26,
     "op": "CONST",
     "ins": [
      "%17",
      "5"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10",
      "$d2": "20",
      "$d3": "40",
      "$d4": "60"
     },
     "tape_len": 5
    },
    {
     "n": 119,
     "pc": 27,
     "op": "CONST",
     "ins": [
      "%18",
      "60"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10",
      "$d2": "20",
      "$d3": "40",
      "$d4": "60"
     },
     "tape_len": 5
    },
    {
     "n": 120,
     "pc": 28,
     "op": "CALL",
     "ins": [
      "CappedBackoff",
      "[('attempt', '%16'), ('base', '%17'), ('cap', '%18')]",
      "$d9"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10",
      "$d2": "20",
      "$d3": "40",
      "$d4": "60"
     },
     "tape_len": 5
    },
    {
     "n": 121,
     "pc": 0,
     "op": "CONST",
     "ins": [
      "%1",
      "0"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "9",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 5
    },
    {
     "n": 122,
     "pc": 1,
     "op": "BINOP",
     "ins": [
      "LE",
      "%2",
      "$attempt",
      "%1"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "9",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 5
    },
    {
     "n": 123,
     "pc": 2,
     "op": "JZ",
     "ins": [
      "%2",
      "4"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "9",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 5
    },
    {
     "n": 124,
     "pc": 4,
     "op": "CONST",
     "ins": [
      "%3",
      "1"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "9",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 5
    },
    {
     "n": 125,
     "pc": 5,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%4",
      "$attempt",
      "%3"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "9",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 5
    },
    {
     "n": 126,
     "pc": 6,
     "op": "JZ",
     "ins": [
      "%4",
      "8"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "9",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 5
    },
    {
     "n": 127,
     "pc": 8,
     "op": "CONST",
     "ins": [
      "%5",
      "2"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "9",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 5
    },
    {
     "n": 128,
     "pc": 9,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%6",
      "$attempt",
      "%5"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "9",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 5
    },
    {
     "n": 129,
     "pc": 10,
     "op": "JZ",
     "ins": [
      "%6",
      "12"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "9",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 5
    },
    {
     "n": 130,
     "pc": 12,
     "op": "CONST",
     "ins": [
      "%7",
      "3"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "9",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 5
    },
    {
     "n": 131,
     "pc": 13,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%8",
      "$attempt",
      "%7"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "9",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 5
    },
    {
     "n": 132,
     "pc": 14,
     "op": "JZ",
     "ins": [
      "%8",
      "16"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "9",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 5
    },
    {
     "n": 133,
     "pc": 16,
     "op": "CONST",
     "ins": [
      "%9",
      "4"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "9",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 5
    },
    {
     "n": 134,
     "pc": 17,
     "op": "BINOP",
     "ins": [
      "EQ",
      "%10",
      "$attempt",
      "%9"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "9",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 5
    },
    {
     "n": 135,
     "pc": 18,
     "op": "JZ",
     "ins": [
      "%10",
      "43"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "9",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 5
    },
    {
     "n": 136,
     "pc": 43,
     "op": "RET",
     "ins": [
      "$cap"
     ],
     "block": "CappedBackoff",
     "cells": {
      "$attempt": "9",
      "$base": "5",
      "$cap": "60"
     },
     "tape_len": 5
    },
    {
     "n": 137,
     "pc": 29,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "$d9"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10",
      "$d2": "20",
      "$d3": "40",
      "$d4": "60",
      "$d9": "60"
     },
     "tape_len": 5
    },
    {
     "n": 138,
     "pc": 30,
     "op": "RET",
     "ins": [
      "None"
     ],
     "block": "CappedBackoffDemo",
     "cells": {
      "$d0": "5",
      "$d1": "10",
      "$d2": "20",
      "$d3": "40",
      "$d4": "60",
      "$d9": "60"
     },
     "tape_len": 6
    }
   ],
   "trace_shown": 139
  },
  {
   "file": "backoff_v3.alcor",
   "caption": "v3 syntax, input 3: lowered to the same core.",
   "input": "3",
   "source": "ALCOR 3\nINPUT $line\n$tries = int($line)\n$delay = 5\nFOR $i FROM 1 TO 4\n  IF $i <= $tries THEN\n    $delay = $delay * 2\n  END IF\nEND FOR\nPRINT \"attempt \" ++ $line ++ \": wait \" ++ str($delay) ++ \"s\"\n",
   "output": [
    "attempt 3: wait 40s"
   ],
   "profile": "default",
   "steps": 48,
   "fuel": 10000000,
   "headroom": 9999952,
   "trap": null,
   "lint": {
    "summary": {
     "error": 0,
     "info": 0,
     "total": 0,
     "warning": 0
    },
    "diagnostics": []
   },
   "trace": [
    {
     "n": 0,
     "pc": 0,
     "op": "IO",
     "ins": [
      "read_line",
      "$line",
      "None"
     ],
     "block": "Program",
     "cells": {},
     "tape_len": 0
    },
    {
     "n": 1,
     "pc": 1,
     "op": "UNOP",
     "ins": [
      "INT",
      "%1",
      "$line"
     ],
     "block": "Program",
     "cells": {
      "$line": "3"
     },
     "tape_len": 0
    },
    {
     "n": 2,
     "pc": 2,
     "op": "MOV",
     "ins": [
      "$tries",
      "%1"
     ],
     "block": "Program",
     "cells": {
      "$line": "3"
     },
     "tape_len": 0
    },
    {
     "n": 3,
     "pc": 3,
     "op": "CONST",
     "ins": [
      "%2",
      "5"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3"
     },
     "tape_len": 0
    },
    {
     "n": 4,
     "pc": 4,
     "op": "MOV",
     "ins": [
      "$delay",
      "%2"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3"
     },
     "tape_len": 0
    },
    {
     "n": 5,
     "pc": 5,
     "op": "CONST",
     "ins": [
      "%3",
      "1"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "5"
     },
     "tape_len": 0
    },
    {
     "n": 6,
     "pc": 6,
     "op": "MOV",
     "ins": [
      "$i",
      "%3"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "5"
     },
     "tape_len": 0
    },
    {
     "n": 7,
     "pc": 7,
     "op": "BINOP",
     "ins": [
      "LE",
      "%4",
      "$i",
      "$tries"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "5",
      "$i": "1"
     },
     "tape_len": 0
    },
    {
     "n": 8,
     "pc": 8,
     "op": "JZ",
     "ins": [
      "%4",
      "14"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "5",
      "$i": "1"
     },
     "tape_len": 0
    },
    {
     "n": 9,
     "pc": 9,
     "op": "JMP",
     "ins": [
      "10"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "5",
      "$i": "1"
     },
     "tape_len": 0
    },
    {
     "n": 10,
     "pc": 10,
     "op": "CONST",
     "ins": [
      "%5",
      "2"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "5",
      "$i": "1"
     },
     "tape_len": 0
    },
    {
     "n": 11,
     "pc": 11,
     "op": "BINOP",
     "ins": [
      "MUL",
      "%6",
      "$delay",
      "%5"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "5",
      "$i": "1"
     },
     "tape_len": 0
    },
    {
     "n": 12,
     "pc": 12,
     "op": "MOV",
     "ins": [
      "$delay",
      "%6"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "5",
      "$i": "1"
     },
     "tape_len": 0
    },
    {
     "n": 13,
     "pc": 13,
     "op": "JMP",
     "ins": [
      "14"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "10",
      "$i": "1"
     },
     "tape_len": 0
    },
    {
     "n": 14,
     "pc": 14,
     "op": "CONST",
     "ins": [
      "%7",
      "2"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "10",
      "$i": "1"
     },
     "tape_len": 0
    },
    {
     "n": 15,
     "pc": 15,
     "op": "MOV",
     "ins": [
      "$i",
      "%7"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "10",
      "$i": "1"
     },
     "tape_len": 0
    },
    {
     "n": 16,
     "pc": 16,
     "op": "BINOP",
     "ins": [
      "LE",
      "%8",
      "$i",
      "$tries"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "10",
      "$i": "2"
     },
     "tape_len": 0
    },
    {
     "n": 17,
     "pc": 17,
     "op": "JZ",
     "ins": [
      "%8",
      "23"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "10",
      "$i": "2"
     },
     "tape_len": 0
    },
    {
     "n": 18,
     "pc": 18,
     "op": "JMP",
     "ins": [
      "19"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "10",
      "$i": "2"
     },
     "tape_len": 0
    },
    {
     "n": 19,
     "pc": 19,
     "op": "CONST",
     "ins": [
      "%9",
      "2"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "10",
      "$i": "2"
     },
     "tape_len": 0
    },
    {
     "n": 20,
     "pc": 20,
     "op": "BINOP",
     "ins": [
      "MUL",
      "%10",
      "$delay",
      "%9"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "10",
      "$i": "2"
     },
     "tape_len": 0
    },
    {
     "n": 21,
     "pc": 21,
     "op": "MOV",
     "ins": [
      "$delay",
      "%10"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "10",
      "$i": "2"
     },
     "tape_len": 0
    },
    {
     "n": 22,
     "pc": 22,
     "op": "JMP",
     "ins": [
      "23"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "20",
      "$i": "2"
     },
     "tape_len": 0
    },
    {
     "n": 23,
     "pc": 23,
     "op": "CONST",
     "ins": [
      "%11",
      "3"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "20",
      "$i": "2"
     },
     "tape_len": 0
    },
    {
     "n": 24,
     "pc": 24,
     "op": "MOV",
     "ins": [
      "$i",
      "%11"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "20",
      "$i": "2"
     },
     "tape_len": 0
    },
    {
     "n": 25,
     "pc": 25,
     "op": "BINOP",
     "ins": [
      "LE",
      "%12",
      "$i",
      "$tries"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "20",
      "$i": "3"
     },
     "tape_len": 0
    },
    {
     "n": 26,
     "pc": 26,
     "op": "JZ",
     "ins": [
      "%12",
      "32"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "20",
      "$i": "3"
     },
     "tape_len": 0
    },
    {
     "n": 27,
     "pc": 27,
     "op": "JMP",
     "ins": [
      "28"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "20",
      "$i": "3"
     },
     "tape_len": 0
    },
    {
     "n": 28,
     "pc": 28,
     "op": "CONST",
     "ins": [
      "%13",
      "2"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "20",
      "$i": "3"
     },
     "tape_len": 0
    },
    {
     "n": 29,
     "pc": 29,
     "op": "BINOP",
     "ins": [
      "MUL",
      "%14",
      "$delay",
      "%13"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "20",
      "$i": "3"
     },
     "tape_len": 0
    },
    {
     "n": 30,
     "pc": 30,
     "op": "MOV",
     "ins": [
      "$delay",
      "%14"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "20",
      "$i": "3"
     },
     "tape_len": 0
    },
    {
     "n": 31,
     "pc": 31,
     "op": "JMP",
     "ins": [
      "32"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "40",
      "$i": "3"
     },
     "tape_len": 0
    },
    {
     "n": 32,
     "pc": 32,
     "op": "CONST",
     "ins": [
      "%15",
      "4"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "40",
      "$i": "3"
     },
     "tape_len": 0
    },
    {
     "n": 33,
     "pc": 33,
     "op": "MOV",
     "ins": [
      "$i",
      "%15"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "40",
      "$i": "3"
     },
     "tape_len": 0
    },
    {
     "n": 34,
     "pc": 34,
     "op": "BINOP",
     "ins": [
      "LE",
      "%16",
      "$i",
      "$tries"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "40",
      "$i": "4"
     },
     "tape_len": 0
    },
    {
     "n": 35,
     "pc": 35,
     "op": "JZ",
     "ins": [
      "%16",
      "41"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "40",
      "$i": "4"
     },
     "tape_len": 0
    },
    {
     "n": 36,
     "pc": 41,
     "op": "CONST",
     "ins": [
      "%19",
      "5"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "40",
      "$i": "4"
     },
     "tape_len": 0
    },
    {
     "n": 37,
     "pc": 42,
     "op": "MOV",
     "ins": [
      "$i",
      "%19"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "40",
      "$i": "4"
     },
     "tape_len": 0
    },
    {
     "n": 38,
     "pc": 43,
     "op": "CONST",
     "ins": [
      "%20",
      "attempt "
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "40",
      "$i": "5"
     },
     "tape_len": 0
    },
    {
     "n": 39,
     "pc": 44,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%21",
      "%20",
      "$line"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "40",
      "$i": "5"
     },
     "tape_len": 0
    },
    {
     "n": 40,
     "pc": 45,
     "op": "CONST",
     "ins": [
      "%22",
      ": wait "
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "40",
      "$i": "5"
     },
     "tape_len": 0
    },
    {
     "n": 41,
     "pc": 46,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%23",
      "%21",
      "%22"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "40",
      "$i": "5"
     },
     "tape_len": 0
    },
    {
     "n": 42,
     "pc": 47,
     "op": "UNOP",
     "ins": [
      "STR",
      "%24",
      "$delay"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "40",
      "$i": "5"
     },
     "tape_len": 0
    },
    {
     "n": 43,
     "pc": 48,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%25",
      "%23",
      "%24"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "40",
      "$i": "5"
     },
     "tape_len": 0
    },
    {
     "n": 44,
     "pc": 49,
     "op": "CONST",
     "ins": [
      "%26",
      "s"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "40",
      "$i": "5"
     },
     "tape_len": 0
    },
    {
     "n": 45,
     "pc": 50,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%27",
      "%25",
      "%26"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "40",
      "$i": "5"
     },
     "tape_len": 0
    },
    {
     "n": 46,
     "pc": 51,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "%27"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "40",
      "$i": "5"
     },
     "tape_len": 0
    },
    {
     "n": 47,
     "pc": 52,
     "op": "RET",
     "ins": [
      "None"
     ],
     "block": "Program",
     "cells": {
      "$line": "3",
      "$tries": "3",
      "$delay": "40",
      "$i": "5"
     },
     "tape_len": 1
    }
   ],
   "trace_shown": 48
  },
  {
   "file": "runaway.alcor",
   "caption": "A loop with no exit, stopped only by fuel.",
   "input": "",
   "source": "PROGRAM Eater WITH profile=complete authority=conformance fuel=1200\nLET $round 0\nLET $bite 1\nLET $eaten 0\n\nEMIT \"an energy eater. it has no stopping condition. read that again.\"\nEMIT \"the default profile could not host this: LOOP and backward JUMP are\"\nEMIT \"compile errors there, so a default program's halting is decided before\"\nEMIT \"it runs. this one is complete-profile, and the only thing between it\"\nEMIT \"and forever is fuel.\"\n\nLABEL feed\nLET $round ADD $round 1\nLET $bite ADD $bite 1\nLET $eaten ADD $eaten $bite\nEMIT CAT CAT CAT \"round \" STR $round \" -- eaten \" STR $eaten\nJUMP feed\n\nEMIT \"unreachable. if you ever see this line, the machine is lying.\"\nEND PROGRAM\n",
   "output": [
    "an energy eater. it has no stopping condition. read that again.",
    "the default profile could not host this: LOOP and backward JUMP are",
    "compile errors there, so a default program's halting is decided before",
    "it runs. this one is complete-profile, and the only thing between it",
    "and forever is fuel.",
    "round 1 -- eaten 2",
    "round 2 -- eaten 5",
    "round 3 -- eaten 9",
    "round 4 -- eaten 14",
    "round 5 -- eaten 20",
    "round 6 -- eaten 27",
    "round 7 -- eaten 35",
    "round 8 -- eaten 44",
    "round 9 -- eaten 54",
    "round 10 -- eaten 65",
    "round 11 -- eaten 77",
    "round 12 -- eaten 90",
    "round 13 -- eaten 104",
    "round 14 -- eaten 119",
    "round 15 -- eaten 135",
    "round 16 -- eaten 152",
    "round 17 -- eaten 170",
    "round 18 -- eaten 189",
    "round 19 -- eaten 209",
    "round 20 -- eaten 230",
    "round 21 -- eaten 252",
    "round 22 -- eaten 275",
    "round 23 -- eaten 299",
    "round 24 -- eaten 324",
    "round 25 -- eaten 350",
    "round 26 -- eaten 377",
    "round 27 -- eaten 405",
    "round 28 -- eaten 434",
    "round 29 -- eaten 464",
    "round 30 -- eaten 495",
    "round 31 -- eaten 527",
    "round 32 -- eaten 560",
    "round 33 -- eaten 594",
    "round 34 -- eaten 629",
    "round 35 -- eaten 665",
    "round 36 -- eaten 702",
    "round 37 -- eaten 740",
    "round 38 -- eaten 779",
    "round 39 -- eaten 819",
    "round 40 -- eaten 860",
    "round 41 -- eaten 902",
    "round 42 -- eaten 945",
    "round 43 -- eaten 989",
    "round 44 -- eaten 1034",
    "round 45 -- eaten 1080",
    "round 46 -- eaten 1127",
    "round 47 -- eaten 1175",
    "round 48 -- eaten 1224",
    "round 49 -- eaten 1274",
    "round 50 -- eaten 1325",
    "round 51 -- eaten 1377",
    "round 52 -- eaten 1430",
    "round 53 -- eaten 1484",
    "round 54 -- eaten 1539",
    "round 55 -- eaten 1595",
    "round 56 -- eaten 1652",
    "round 57 -- eaten 1710",
    "round 58 -- eaten 1769",
    "round 59 -- eaten 1829",
    "round 60 -- eaten 1890",
    "round 61 -- eaten 1952",
    "round 62 -- eaten 2015",
    "round 63 -- eaten 2079",
    "round 64 -- eaten 2144",
    "round 65 -- eaten 2210",
    "round 66 -- eaten 2277",
    "round 67 -- eaten 2345",
    "round 68 -- eaten 2414",
    "round 69 -- eaten 2484",
    "TRAP fuel_exhausted"
   ],
   "profile": "complete",
   "steps": 1201,
   "fuel": 1200,
   "headroom": 0,
   "trap": "fuel_exhausted",
   "lint": {
    "summary": {
     "error": 0,
     "info": 0,
     "total": 1,
     "warning": 1
    },
    "diagnostics": [
     {
      "rule": "profile/conformance-authority",
      "severity": "warning",
      "line": 1,
      "column": 1,
      "message": "authority=conformance is sandbox-only and is not portable to hosted execution",
      "hint": "keep this program in test/sandbox scope; the host supplies real authority"
     }
    ]
   },
   "trace": [
    {
     "n": 0,
     "pc": 0,
     "op": "CONST",
     "ins": [
      "%1",
      "0"
     ],
     "block": "Eater",
     "cells": {},
     "tape_len": 0
    },
    {
     "n": 1,
     "pc": 1,
     "op": "MOV",
     "ins": [
      "$round",
      "%1"
     ],
     "block": "Eater",
     "cells": {},
     "tape_len": 0
    },
    {
     "n": 2,
     "pc": 2,
     "op": "CONST",
     "ins": [
      "%2",
      "1"
     ],
     "block": "Eater",
     "cells": {
      "$round": "0"
     },
     "tape_len": 0
    },
    {
     "n": 3,
     "pc": 3,
     "op": "MOV",
     "ins": [
      "$bite",
      "%2"
     ],
     "block": "Eater",
     "cells": {
      "$round": "0"
     },
     "tape_len": 0
    },
    {
     "n": 4,
     "pc": 4,
     "op": "CONST",
     "ins": [
      "%3",
      "0"
     ],
     "block": "Eater",
     "cells": {
      "$round": "0",
      "$bite": "1"
     },
     "tape_len": 0
    },
    {
     "n": 5,
     "pc": 5,
     "op": "MOV",
     "ins": [
      "$eaten",
      "%3"
     ],
     "block": "Eater",
     "cells": {
      "$round": "0",
      "$bite": "1"
     },
     "tape_len": 0
    },
    {
     "n": 6,
     "pc": 6,
     "op": "CONST",
     "ins": [
      "%4",
      "an energy eater. it has no stopping condition. read that again."
     ],
     "block": "Eater",
     "cells": {
      "$round": "0",
      "$bite": "1",
      "$eaten": "0"
     },
     "tape_len": 0
    },
    {
     "n": 7,
     "pc": 7,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "%4"
     ],
     "block": "Eater",
     "cells": {
      "$round": "0",
      "$bite": "1",
      "$eaten": "0"
     },
     "tape_len": 0
    },
    {
     "n": 8,
     "pc": 8,
     "op": "CONST",
     "ins": [
      "%5",
      "the default profile could not host this: LOOP and backward JUMP are"
     ],
     "block": "Eater",
     "cells": {
      "$round": "0",
      "$bite": "1",
      "$eaten": "0"
     },
     "tape_len": 1
    },
    {
     "n": 9,
     "pc": 9,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "%5"
     ],
     "block": "Eater",
     "cells": {
      "$round": "0",
      "$bite": "1",
      "$eaten": "0"
     },
     "tape_len": 1
    },
    {
     "n": 10,
     "pc": 10,
     "op": "CONST",
     "ins": [
      "%6",
      "compile errors there, so a default program's halting is decided before"
     ],
     "block": "Eater",
     "cells": {
      "$round": "0",
      "$bite": "1",
      "$eaten": "0"
     },
     "tape_len": 2
    },
    {
     "n": 11,
     "pc": 11,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "%6"
     ],
     "block": "Eater",
     "cells": {
      "$round": "0",
      "$bite": "1",
      "$eaten": "0"
     },
     "tape_len": 2
    },
    {
     "n": 12,
     "pc": 12,
     "op": "CONST",
     "ins": [
      "%7",
      "it runs. this one is complete-profile, and the only thing between it"
     ],
     "block": "Eater",
     "cells": {
      "$round": "0",
      "$bite": "1",
      "$eaten": "0"
     },
     "tape_len": 3
    },
    {
     "n": 13,
     "pc": 13,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "%7"
     ],
     "block": "Eater",
     "cells": {
      "$round": "0",
      "$bite": "1",
      "$eaten": "0"
     },
     "tape_len": 3
    },
    {
     "n": 14,
     "pc": 14,
     "op": "CONST",
     "ins": [
      "%8",
      "and forever is fuel."
     ],
     "block": "Eater",
     "cells": {
      "$round": "0",
      "$bite": "1",
      "$eaten": "0"
     },
     "tape_len": 4
    },
    {
     "n": 15,
     "pc": 15,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "%8"
     ],
     "block": "Eater",
     "cells": {
      "$round": "0",
      "$bite": "1",
      "$eaten": "0"
     },
     "tape_len": 4
    },
    {
     "n": 16,
     "pc": 16,
     "op": "CONST",
     "ins": [
      "%9",
      "1"
     ],
     "block": "Eater",
     "cells": {
      "$round": "0",
      "$bite": "1",
      "$eaten": "0"
     },
     "tape_len": 5
    },
    {
     "n": 17,
     "pc": 17,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%10",
      "$round",
      "%9"
     ],
     "block": "Eater",
     "cells": {
      "$round": "0",
      "$bite": "1",
      "$eaten": "0"
     },
     "tape_len": 5
    },
    {
     "n": 18,
     "pc": 18,
     "op": "MOV",
     "ins": [
      "$round",
      "%10"
     ],
     "block": "Eater",
     "cells": {
      "$round": "0",
      "$bite": "1",
      "$eaten": "0"
     },
     "tape_len": 5
    },
    {
     "n": 19,
     "pc": 19,
     "op": "CONST",
     "ins": [
      "%11",
      "1"
     ],
     "block": "Eater",
     "cells": {
      "$round": "1",
      "$bite": "1",
      "$eaten": "0"
     },
     "tape_len": 5
    },
    {
     "n": 20,
     "pc": 20,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%12",
      "$bite",
      "%11"
     ],
     "block": "Eater",
     "cells": {
      "$round": "1",
      "$bite": "1",
      "$eaten": "0"
     },
     "tape_len": 5
    },
    {
     "n": 21,
     "pc": 21,
     "op": "MOV",
     "ins": [
      "$bite",
      "%12"
     ],
     "block": "Eater",
     "cells": {
      "$round": "1",
      "$bite": "1",
      "$eaten": "0"
     },
     "tape_len": 5
    },
    {
     "n": 22,
     "pc": 22,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%13",
      "$eaten",
      "$bite"
     ],
     "block": "Eater",
     "cells": {
      "$round": "1",
      "$bite": "2",
      "$eaten": "0"
     },
     "tape_len": 5
    },
    {
     "n": 23,
     "pc": 23,
     "op": "MOV",
     "ins": [
      "$eaten",
      "%13"
     ],
     "block": "Eater",
     "cells": {
      "$round": "1",
      "$bite": "2",
      "$eaten": "0"
     },
     "tape_len": 5
    },
    {
     "n": 24,
     "pc": 24,
     "op": "CONST",
     "ins": [
      "%14",
      "round "
     ],
     "block": "Eater",
     "cells": {
      "$round": "1",
      "$bite": "2",
      "$eaten": "2"
     },
     "tape_len": 5
    },
    {
     "n": 25,
     "pc": 25,
     "op": "UNOP",
     "ins": [
      "STR",
      "%15",
      "$round"
     ],
     "block": "Eater",
     "cells": {
      "$round": "1",
      "$bite": "2",
      "$eaten": "2"
     },
     "tape_len": 5
    },
    {
     "n": 26,
     "pc": 26,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%16",
      "%14",
      "%15"
     ],
     "block": "Eater",
     "cells": {
      "$round": "1",
      "$bite": "2",
      "$eaten": "2"
     },
     "tape_len": 5
    },
    {
     "n": 27,
     "pc": 27,
     "op": "CONST",
     "ins": [
      "%17",
      " -- eaten "
     ],
     "block": "Eater",
     "cells": {
      "$round": "1",
      "$bite": "2",
      "$eaten": "2"
     },
     "tape_len": 5
    },
    {
     "n": 28,
     "pc": 28,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%18",
      "%16",
      "%17"
     ],
     "block": "Eater",
     "cells": {
      "$round": "1",
      "$bite": "2",
      "$eaten": "2"
     },
     "tape_len": 5
    },
    {
     "n": 29,
     "pc": 29,
     "op": "UNOP",
     "ins": [
      "STR",
      "%19",
      "$eaten"
     ],
     "block": "Eater",
     "cells": {
      "$round": "1",
      "$bite": "2",
      "$eaten": "2"
     },
     "tape_len": 5
    },
    {
     "n": 30,
     "pc": 30,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%20",
      "%18",
      "%19"
     ],
     "block": "Eater",
     "cells": {
      "$round": "1",
      "$bite": "2",
      "$eaten": "2"
     },
     "tape_len": 5
    },
    {
     "n": 31,
     "pc": 31,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "%20"
     ],
     "block": "Eater",
     "cells": {
      "$round": "1",
      "$bite": "2",
      "$eaten": "2"
     },
     "tape_len": 5
    },
    {
     "n": 32,
     "pc": 32,
     "op": "JMP",
     "ins": [
      "16"
     ],
     "block": "Eater",
     "cells": {
      "$round": "1",
      "$bite": "2",
      "$eaten": "2"
     },
     "tape_len": 6
    },
    {
     "n": 33,
     "pc": 16,
     "op": "CONST",
     "ins": [
      "%9",
      "1"
     ],
     "block": "Eater",
     "cells": {
      "$round": "1",
      "$bite": "2",
      "$eaten": "2"
     },
     "tape_len": 6
    },
    {
     "n": 34,
     "pc": 17,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%10",
      "$round",
      "%9"
     ],
     "block": "Eater",
     "cells": {
      "$round": "1",
      "$bite": "2",
      "$eaten": "2"
     },
     "tape_len": 6
    },
    {
     "n": 35,
     "pc": 18,
     "op": "MOV",
     "ins": [
      "$round",
      "%10"
     ],
     "block": "Eater",
     "cells": {
      "$round": "1",
      "$bite": "2",
      "$eaten": "2"
     },
     "tape_len": 6
    },
    {
     "n": 36,
     "pc": 19,
     "op": "CONST",
     "ins": [
      "%11",
      "1"
     ],
     "block": "Eater",
     "cells": {
      "$round": "2",
      "$bite": "2",
      "$eaten": "2"
     },
     "tape_len": 6
    },
    {
     "n": 37,
     "pc": 20,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%12",
      "$bite",
      "%11"
     ],
     "block": "Eater",
     "cells": {
      "$round": "2",
      "$bite": "2",
      "$eaten": "2"
     },
     "tape_len": 6
    },
    {
     "n": 38,
     "pc": 21,
     "op": "MOV",
     "ins": [
      "$bite",
      "%12"
     ],
     "block": "Eater",
     "cells": {
      "$round": "2",
      "$bite": "2",
      "$eaten": "2"
     },
     "tape_len": 6
    },
    {
     "n": 39,
     "pc": 22,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%13",
      "$eaten",
      "$bite"
     ],
     "block": "Eater",
     "cells": {
      "$round": "2",
      "$bite": "3",
      "$eaten": "2"
     },
     "tape_len": 6
    },
    {
     "n": 40,
     "pc": 23,
     "op": "MOV",
     "ins": [
      "$eaten",
      "%13"
     ],
     "block": "Eater",
     "cells": {
      "$round": "2",
      "$bite": "3",
      "$eaten": "2"
     },
     "tape_len": 6
    },
    {
     "n": 41,
     "pc": 24,
     "op": "CONST",
     "ins": [
      "%14",
      "round "
     ],
     "block": "Eater",
     "cells": {
      "$round": "2",
      "$bite": "3",
      "$eaten": "5"
     },
     "tape_len": 6
    },
    {
     "n": 42,
     "pc": 25,
     "op": "UNOP",
     "ins": [
      "STR",
      "%15",
      "$round"
     ],
     "block": "Eater",
     "cells": {
      "$round": "2",
      "$bite": "3",
      "$eaten": "5"
     },
     "tape_len": 6
    },
    {
     "n": 43,
     "pc": 26,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%16",
      "%14",
      "%15"
     ],
     "block": "Eater",
     "cells": {
      "$round": "2",
      "$bite": "3",
      "$eaten": "5"
     },
     "tape_len": 6
    },
    {
     "n": 44,
     "pc": 27,
     "op": "CONST",
     "ins": [
      "%17",
      " -- eaten "
     ],
     "block": "Eater",
     "cells": {
      "$round": "2",
      "$bite": "3",
      "$eaten": "5"
     },
     "tape_len": 6
    },
    {
     "n": 45,
     "pc": 28,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%18",
      "%16",
      "%17"
     ],
     "block": "Eater",
     "cells": {
      "$round": "2",
      "$bite": "3",
      "$eaten": "5"
     },
     "tape_len": 6
    },
    {
     "n": 46,
     "pc": 29,
     "op": "UNOP",
     "ins": [
      "STR",
      "%19",
      "$eaten"
     ],
     "block": "Eater",
     "cells": {
      "$round": "2",
      "$bite": "3",
      "$eaten": "5"
     },
     "tape_len": 6
    },
    {
     "n": 47,
     "pc": 30,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%20",
      "%18",
      "%19"
     ],
     "block": "Eater",
     "cells": {
      "$round": "2",
      "$bite": "3",
      "$eaten": "5"
     },
     "tape_len": 6
    },
    {
     "n": 48,
     "pc": 31,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "%20"
     ],
     "block": "Eater",
     "cells": {
      "$round": "2",
      "$bite": "3",
      "$eaten": "5"
     },
     "tape_len": 6
    },
    {
     "n": 49,
     "pc": 32,
     "op": "JMP",
     "ins": [
      "16"
     ],
     "block": "Eater",
     "cells": {
      "$round": "2",
      "$bite": "3",
      "$eaten": "5"
     },
     "tape_len": 7
    },
    {
     "n": 50,
     "pc": 16,
     "op": "CONST",
     "ins": [
      "%9",
      "1"
     ],
     "block": "Eater",
     "cells": {
      "$round": "2",
      "$bite": "3",
      "$eaten": "5"
     },
     "tape_len": 7
    },
    {
     "n": 51,
     "pc": 17,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%10",
      "$round",
      "%9"
     ],
     "block": "Eater",
     "cells": {
      "$round": "2",
      "$bite": "3",
      "$eaten": "5"
     },
     "tape_len": 7
    },
    {
     "n": 52,
     "pc": 18,
     "op": "MOV",
     "ins": [
      "$round",
      "%10"
     ],
     "block": "Eater",
     "cells": {
      "$round": "2",
      "$bite": "3",
      "$eaten": "5"
     },
     "tape_len": 7
    },
    {
     "n": 53,
     "pc": 19,
     "op": "CONST",
     "ins": [
      "%11",
      "1"
     ],
     "block": "Eater",
     "cells": {
      "$round": "3",
      "$bite": "3",
      "$eaten": "5"
     },
     "tape_len": 7
    },
    {
     "n": 54,
     "pc": 20,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%12",
      "$bite",
      "%11"
     ],
     "block": "Eater",
     "cells": {
      "$round": "3",
      "$bite": "3",
      "$eaten": "5"
     },
     "tape_len": 7
    },
    {
     "n": 55,
     "pc": 21,
     "op": "MOV",
     "ins": [
      "$bite",
      "%12"
     ],
     "block": "Eater",
     "cells": {
      "$round": "3",
      "$bite": "3",
      "$eaten": "5"
     },
     "tape_len": 7
    },
    {
     "n": 56,
     "pc": 22,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%13",
      "$eaten",
      "$bite"
     ],
     "block": "Eater",
     "cells": {
      "$round": "3",
      "$bite": "4",
      "$eaten": "5"
     },
     "tape_len": 7
    },
    {
     "n": 57,
     "pc": 23,
     "op": "MOV",
     "ins": [
      "$eaten",
      "%13"
     ],
     "block": "Eater",
     "cells": {
      "$round": "3",
      "$bite": "4",
      "$eaten": "5"
     },
     "tape_len": 7
    },
    {
     "n": 58,
     "pc": 24,
     "op": "CONST",
     "ins": [
      "%14",
      "round "
     ],
     "block": "Eater",
     "cells": {
      "$round": "3",
      "$bite": "4",
      "$eaten": "9"
     },
     "tape_len": 7
    },
    {
     "n": 59,
     "pc": 25,
     "op": "UNOP",
     "ins": [
      "STR",
      "%15",
      "$round"
     ],
     "block": "Eater",
     "cells": {
      "$round": "3",
      "$bite": "4",
      "$eaten": "9"
     },
     "tape_len": 7
    },
    {
     "n": 60,
     "pc": 26,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%16",
      "%14",
      "%15"
     ],
     "block": "Eater",
     "cells": {
      "$round": "3",
      "$bite": "4",
      "$eaten": "9"
     },
     "tape_len": 7
    },
    {
     "n": 61,
     "pc": 27,
     "op": "CONST",
     "ins": [
      "%17",
      " -- eaten "
     ],
     "block": "Eater",
     "cells": {
      "$round": "3",
      "$bite": "4",
      "$eaten": "9"
     },
     "tape_len": 7
    },
    {
     "n": 62,
     "pc": 28,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%18",
      "%16",
      "%17"
     ],
     "block": "Eater",
     "cells": {
      "$round": "3",
      "$bite": "4",
      "$eaten": "9"
     },
     "tape_len": 7
    },
    {
     "n": 63,
     "pc": 29,
     "op": "UNOP",
     "ins": [
      "STR",
      "%19",
      "$eaten"
     ],
     "block": "Eater",
     "cells": {
      "$round": "3",
      "$bite": "4",
      "$eaten": "9"
     },
     "tape_len": 7
    },
    {
     "n": 64,
     "pc": 30,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%20",
      "%18",
      "%19"
     ],
     "block": "Eater",
     "cells": {
      "$round": "3",
      "$bite": "4",
      "$eaten": "9"
     },
     "tape_len": 7
    },
    {
     "n": 65,
     "pc": 31,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "%20"
     ],
     "block": "Eater",
     "cells": {
      "$round": "3",
      "$bite": "4",
      "$eaten": "9"
     },
     "tape_len": 7
    },
    {
     "n": 66,
     "pc": 32,
     "op": "JMP",
     "ins": [
      "16"
     ],
     "block": "Eater",
     "cells": {
      "$round": "3",
      "$bite": "4",
      "$eaten": "9"
     },
     "tape_len": 8
    },
    {
     "n": 67,
     "pc": 16,
     "op": "CONST",
     "ins": [
      "%9",
      "1"
     ],
     "block": "Eater",
     "cells": {
      "$round": "3",
      "$bite": "4",
      "$eaten": "9"
     },
     "tape_len": 8
    },
    {
     "n": 68,
     "pc": 17,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%10",
      "$round",
      "%9"
     ],
     "block": "Eater",
     "cells": {
      "$round": "3",
      "$bite": "4",
      "$eaten": "9"
     },
     "tape_len": 8
    },
    {
     "n": 69,
     "pc": 18,
     "op": "MOV",
     "ins": [
      "$round",
      "%10"
     ],
     "block": "Eater",
     "cells": {
      "$round": "3",
      "$bite": "4",
      "$eaten": "9"
     },
     "tape_len": 8
    },
    {
     "n": 70,
     "pc": 19,
     "op": "CONST",
     "ins": [
      "%11",
      "1"
     ],
     "block": "Eater",
     "cells": {
      "$round": "4",
      "$bite": "4",
      "$eaten": "9"
     },
     "tape_len": 8
    },
    {
     "n": 71,
     "pc": 20,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%12",
      "$bite",
      "%11"
     ],
     "block": "Eater",
     "cells": {
      "$round": "4",
      "$bite": "4",
      "$eaten": "9"
     },
     "tape_len": 8
    },
    {
     "n": 72,
     "pc": 21,
     "op": "MOV",
     "ins": [
      "$bite",
      "%12"
     ],
     "block": "Eater",
     "cells": {
      "$round": "4",
      "$bite": "4",
      "$eaten": "9"
     },
     "tape_len": 8
    },
    {
     "n": 73,
     "pc": 22,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%13",
      "$eaten",
      "$bite"
     ],
     "block": "Eater",
     "cells": {
      "$round": "4",
      "$bite": "5",
      "$eaten": "9"
     },
     "tape_len": 8
    },
    {
     "n": 74,
     "pc": 23,
     "op": "MOV",
     "ins": [
      "$eaten",
      "%13"
     ],
     "block": "Eater",
     "cells": {
      "$round": "4",
      "$bite": "5",
      "$eaten": "9"
     },
     "tape_len": 8
    },
    {
     "n": 75,
     "pc": 24,
     "op": "CONST",
     "ins": [
      "%14",
      "round "
     ],
     "block": "Eater",
     "cells": {
      "$round": "4",
      "$bite": "5",
      "$eaten": "14"
     },
     "tape_len": 8
    },
    {
     "n": 76,
     "pc": 25,
     "op": "UNOP",
     "ins": [
      "STR",
      "%15",
      "$round"
     ],
     "block": "Eater",
     "cells": {
      "$round": "4",
      "$bite": "5",
      "$eaten": "14"
     },
     "tape_len": 8
    },
    {
     "n": 77,
     "pc": 26,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%16",
      "%14",
      "%15"
     ],
     "block": "Eater",
     "cells": {
      "$round": "4",
      "$bite": "5",
      "$eaten": "14"
     },
     "tape_len": 8
    },
    {
     "n": 78,
     "pc": 27,
     "op": "CONST",
     "ins": [
      "%17",
      " -- eaten "
     ],
     "block": "Eater",
     "cells": {
      "$round": "4",
      "$bite": "5",
      "$eaten": "14"
     },
     "tape_len": 8
    },
    {
     "n": 79,
     "pc": 28,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%18",
      "%16",
      "%17"
     ],
     "block": "Eater",
     "cells": {
      "$round": "4",
      "$bite": "5",
      "$eaten": "14"
     },
     "tape_len": 8
    },
    {
     "n": 80,
     "pc": 29,
     "op": "UNOP",
     "ins": [
      "STR",
      "%19",
      "$eaten"
     ],
     "block": "Eater",
     "cells": {
      "$round": "4",
      "$bite": "5",
      "$eaten": "14"
     },
     "tape_len": 8
    },
    {
     "n": 81,
     "pc": 30,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%20",
      "%18",
      "%19"
     ],
     "block": "Eater",
     "cells": {
      "$round": "4",
      "$bite": "5",
      "$eaten": "14"
     },
     "tape_len": 8
    },
    {
     "n": 82,
     "pc": 31,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "%20"
     ],
     "block": "Eater",
     "cells": {
      "$round": "4",
      "$bite": "5",
      "$eaten": "14"
     },
     "tape_len": 8
    },
    {
     "n": 83,
     "pc": 32,
     "op": "JMP",
     "ins": [
      "16"
     ],
     "block": "Eater",
     "cells": {
      "$round": "4",
      "$bite": "5",
      "$eaten": "14"
     },
     "tape_len": 9
    },
    {
     "n": 84,
     "pc": 16,
     "op": "CONST",
     "ins": [
      "%9",
      "1"
     ],
     "block": "Eater",
     "cells": {
      "$round": "4",
      "$bite": "5",
      "$eaten": "14"
     },
     "tape_len": 9
    },
    {
     "n": 85,
     "pc": 17,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%10",
      "$round",
      "%9"
     ],
     "block": "Eater",
     "cells": {
      "$round": "4",
      "$bite": "5",
      "$eaten": "14"
     },
     "tape_len": 9
    },
    {
     "n": 86,
     "pc": 18,
     "op": "MOV",
     "ins": [
      "$round",
      "%10"
     ],
     "block": "Eater",
     "cells": {
      "$round": "4",
      "$bite": "5",
      "$eaten": "14"
     },
     "tape_len": 9
    },
    {
     "n": 87,
     "pc": 19,
     "op": "CONST",
     "ins": [
      "%11",
      "1"
     ],
     "block": "Eater",
     "cells": {
      "$round": "5",
      "$bite": "5",
      "$eaten": "14"
     },
     "tape_len": 9
    },
    {
     "n": 88,
     "pc": 20,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%12",
      "$bite",
      "%11"
     ],
     "block": "Eater",
     "cells": {
      "$round": "5",
      "$bite": "5",
      "$eaten": "14"
     },
     "tape_len": 9
    },
    {
     "n": 89,
     "pc": 21,
     "op": "MOV",
     "ins": [
      "$bite",
      "%12"
     ],
     "block": "Eater",
     "cells": {
      "$round": "5",
      "$bite": "5",
      "$eaten": "14"
     },
     "tape_len": 9
    },
    {
     "n": 90,
     "pc": 22,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%13",
      "$eaten",
      "$bite"
     ],
     "block": "Eater",
     "cells": {
      "$round": "5",
      "$bite": "6",
      "$eaten": "14"
     },
     "tape_len": 9
    },
    {
     "n": 91,
     "pc": 23,
     "op": "MOV",
     "ins": [
      "$eaten",
      "%13"
     ],
     "block": "Eater",
     "cells": {
      "$round": "5",
      "$bite": "6",
      "$eaten": "14"
     },
     "tape_len": 9
    },
    {
     "n": 92,
     "pc": 24,
     "op": "CONST",
     "ins": [
      "%14",
      "round "
     ],
     "block": "Eater",
     "cells": {
      "$round": "5",
      "$bite": "6",
      "$eaten": "20"
     },
     "tape_len": 9
    },
    {
     "n": 93,
     "pc": 25,
     "op": "UNOP",
     "ins": [
      "STR",
      "%15",
      "$round"
     ],
     "block": "Eater",
     "cells": {
      "$round": "5",
      "$bite": "6",
      "$eaten": "20"
     },
     "tape_len": 9
    },
    {
     "n": 94,
     "pc": 26,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%16",
      "%14",
      "%15"
     ],
     "block": "Eater",
     "cells": {
      "$round": "5",
      "$bite": "6",
      "$eaten": "20"
     },
     "tape_len": 9
    },
    {
     "n": 95,
     "pc": 27,
     "op": "CONST",
     "ins": [
      "%17",
      " -- eaten "
     ],
     "block": "Eater",
     "cells": {
      "$round": "5",
      "$bite": "6",
      "$eaten": "20"
     },
     "tape_len": 9
    },
    {
     "n": 96,
     "pc": 28,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%18",
      "%16",
      "%17"
     ],
     "block": "Eater",
     "cells": {
      "$round": "5",
      "$bite": "6",
      "$eaten": "20"
     },
     "tape_len": 9
    },
    {
     "n": 97,
     "pc": 29,
     "op": "UNOP",
     "ins": [
      "STR",
      "%19",
      "$eaten"
     ],
     "block": "Eater",
     "cells": {
      "$round": "5",
      "$bite": "6",
      "$eaten": "20"
     },
     "tape_len": 9
    },
    {
     "n": 98,
     "pc": 30,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%20",
      "%18",
      "%19"
     ],
     "block": "Eater",
     "cells": {
      "$round": "5",
      "$bite": "6",
      "$eaten": "20"
     },
     "tape_len": 9
    },
    {
     "n": 99,
     "pc": 31,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "%20"
     ],
     "block": "Eater",
     "cells": {
      "$round": "5",
      "$bite": "6",
      "$eaten": "20"
     },
     "tape_len": 9
    },
    {
     "n": 100,
     "pc": 32,
     "op": "JMP",
     "ins": [
      "16"
     ],
     "block": "Eater",
     "cells": {
      "$round": "5",
      "$bite": "6",
      "$eaten": "20"
     },
     "tape_len": 10
    },
    {
     "n": 101,
     "pc": 16,
     "op": "CONST",
     "ins": [
      "%9",
      "1"
     ],
     "block": "Eater",
     "cells": {
      "$round": "5",
      "$bite": "6",
      "$eaten": "20"
     },
     "tape_len": 10
    },
    {
     "n": 102,
     "pc": 17,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%10",
      "$round",
      "%9"
     ],
     "block": "Eater",
     "cells": {
      "$round": "5",
      "$bite": "6",
      "$eaten": "20"
     },
     "tape_len": 10
    },
    {
     "n": 103,
     "pc": 18,
     "op": "MOV",
     "ins": [
      "$round",
      "%10"
     ],
     "block": "Eater",
     "cells": {
      "$round": "5",
      "$bite": "6",
      "$eaten": "20"
     },
     "tape_len": 10
    },
    {
     "n": 104,
     "pc": 19,
     "op": "CONST",
     "ins": [
      "%11",
      "1"
     ],
     "block": "Eater",
     "cells": {
      "$round": "6",
      "$bite": "6",
      "$eaten": "20"
     },
     "tape_len": 10
    },
    {
     "n": 105,
     "pc": 20,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%12",
      "$bite",
      "%11"
     ],
     "block": "Eater",
     "cells": {
      "$round": "6",
      "$bite": "6",
      "$eaten": "20"
     },
     "tape_len": 10
    },
    {
     "n": 106,
     "pc": 21,
     "op": "MOV",
     "ins": [
      "$bite",
      "%12"
     ],
     "block": "Eater",
     "cells": {
      "$round": "6",
      "$bite": "6",
      "$eaten": "20"
     },
     "tape_len": 10
    },
    {
     "n": 107,
     "pc": 22,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%13",
      "$eaten",
      "$bite"
     ],
     "block": "Eater",
     "cells": {
      "$round": "6",
      "$bite": "7",
      "$eaten": "20"
     },
     "tape_len": 10
    },
    {
     "n": 108,
     "pc": 23,
     "op": "MOV",
     "ins": [
      "$eaten",
      "%13"
     ],
     "block": "Eater",
     "cells": {
      "$round": "6",
      "$bite": "7",
      "$eaten": "20"
     },
     "tape_len": 10
    },
    {
     "n": 109,
     "pc": 24,
     "op": "CONST",
     "ins": [
      "%14",
      "round "
     ],
     "block": "Eater",
     "cells": {
      "$round": "6",
      "$bite": "7",
      "$eaten": "27"
     },
     "tape_len": 10
    },
    {
     "n": 110,
     "pc": 25,
     "op": "UNOP",
     "ins": [
      "STR",
      "%15",
      "$round"
     ],
     "block": "Eater",
     "cells": {
      "$round": "6",
      "$bite": "7",
      "$eaten": "27"
     },
     "tape_len": 10
    },
    {
     "n": 111,
     "pc": 26,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%16",
      "%14",
      "%15"
     ],
     "block": "Eater",
     "cells": {
      "$round": "6",
      "$bite": "7",
      "$eaten": "27"
     },
     "tape_len": 10
    },
    {
     "n": 112,
     "pc": 27,
     "op": "CONST",
     "ins": [
      "%17",
      " -- eaten "
     ],
     "block": "Eater",
     "cells": {
      "$round": "6",
      "$bite": "7",
      "$eaten": "27"
     },
     "tape_len": 10
    },
    {
     "n": 113,
     "pc": 28,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%18",
      "%16",
      "%17"
     ],
     "block": "Eater",
     "cells": {
      "$round": "6",
      "$bite": "7",
      "$eaten": "27"
     },
     "tape_len": 10
    },
    {
     "n": 114,
     "pc": 29,
     "op": "UNOP",
     "ins": [
      "STR",
      "%19",
      "$eaten"
     ],
     "block": "Eater",
     "cells": {
      "$round": "6",
      "$bite": "7",
      "$eaten": "27"
     },
     "tape_len": 10
    },
    {
     "n": 115,
     "pc": 30,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%20",
      "%18",
      "%19"
     ],
     "block": "Eater",
     "cells": {
      "$round": "6",
      "$bite": "7",
      "$eaten": "27"
     },
     "tape_len": 10
    },
    {
     "n": 116,
     "pc": 31,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "%20"
     ],
     "block": "Eater",
     "cells": {
      "$round": "6",
      "$bite": "7",
      "$eaten": "27"
     },
     "tape_len": 10
    },
    {
     "n": 117,
     "pc": 32,
     "op": "JMP",
     "ins": [
      "16"
     ],
     "block": "Eater",
     "cells": {
      "$round": "6",
      "$bite": "7",
      "$eaten": "27"
     },
     "tape_len": 11
    },
    {
     "n": 118,
     "pc": 16,
     "op": "CONST",
     "ins": [
      "%9",
      "1"
     ],
     "block": "Eater",
     "cells": {
      "$round": "6",
      "$bite": "7",
      "$eaten": "27"
     },
     "tape_len": 11
    },
    {
     "n": 119,
     "pc": 17,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%10",
      "$round",
      "%9"
     ],
     "block": "Eater",
     "cells": {
      "$round": "6",
      "$bite": "7",
      "$eaten": "27"
     },
     "tape_len": 11
    },
    {
     "n": 120,
     "pc": 18,
     "op": "MOV",
     "ins": [
      "$round",
      "%10"
     ],
     "block": "Eater",
     "cells": {
      "$round": "6",
      "$bite": "7",
      "$eaten": "27"
     },
     "tape_len": 11
    },
    {
     "n": 121,
     "pc": 19,
     "op": "CONST",
     "ins": [
      "%11",
      "1"
     ],
     "block": "Eater",
     "cells": {
      "$round": "7",
      "$bite": "7",
      "$eaten": "27"
     },
     "tape_len": 11
    },
    {
     "n": 122,
     "pc": 20,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%12",
      "$bite",
      "%11"
     ],
     "block": "Eater",
     "cells": {
      "$round": "7",
      "$bite": "7",
      "$eaten": "27"
     },
     "tape_len": 11
    },
    {
     "n": 123,
     "pc": 21,
     "op": "MOV",
     "ins": [
      "$bite",
      "%12"
     ],
     "block": "Eater",
     "cells": {
      "$round": "7",
      "$bite": "7",
      "$eaten": "27"
     },
     "tape_len": 11
    },
    {
     "n": 124,
     "pc": 22,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%13",
      "$eaten",
      "$bite"
     ],
     "block": "Eater",
     "cells": {
      "$round": "7",
      "$bite": "8",
      "$eaten": "27"
     },
     "tape_len": 11
    },
    {
     "n": 125,
     "pc": 23,
     "op": "MOV",
     "ins": [
      "$eaten",
      "%13"
     ],
     "block": "Eater",
     "cells": {
      "$round": "7",
      "$bite": "8",
      "$eaten": "27"
     },
     "tape_len": 11
    },
    {
     "n": 126,
     "pc": 24,
     "op": "CONST",
     "ins": [
      "%14",
      "round "
     ],
     "block": "Eater",
     "cells": {
      "$round": "7",
      "$bite": "8",
      "$eaten": "35"
     },
     "tape_len": 11
    },
    {
     "n": 127,
     "pc": 25,
     "op": "UNOP",
     "ins": [
      "STR",
      "%15",
      "$round"
     ],
     "block": "Eater",
     "cells": {
      "$round": "7",
      "$bite": "8",
      "$eaten": "35"
     },
     "tape_len": 11
    },
    {
     "n": 128,
     "pc": 26,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%16",
      "%14",
      "%15"
     ],
     "block": "Eater",
     "cells": {
      "$round": "7",
      "$bite": "8",
      "$eaten": "35"
     },
     "tape_len": 11
    },
    {
     "n": 129,
     "pc": 27,
     "op": "CONST",
     "ins": [
      "%17",
      " -- eaten "
     ],
     "block": "Eater",
     "cells": {
      "$round": "7",
      "$bite": "8",
      "$eaten": "35"
     },
     "tape_len": 11
    },
    {
     "n": 130,
     "pc": 28,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%18",
      "%16",
      "%17"
     ],
     "block": "Eater",
     "cells": {
      "$round": "7",
      "$bite": "8",
      "$eaten": "35"
     },
     "tape_len": 11
    },
    {
     "n": 131,
     "pc": 29,
     "op": "UNOP",
     "ins": [
      "STR",
      "%19",
      "$eaten"
     ],
     "block": "Eater",
     "cells": {
      "$round": "7",
      "$bite": "8",
      "$eaten": "35"
     },
     "tape_len": 11
    },
    {
     "n": 132,
     "pc": 30,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%20",
      "%18",
      "%19"
     ],
     "block": "Eater",
     "cells": {
      "$round": "7",
      "$bite": "8",
      "$eaten": "35"
     },
     "tape_len": 11
    },
    {
     "n": 133,
     "pc": 31,
     "op": "IO",
     "ins": [
      "emit",
      "None",
      "%20"
     ],
     "block": "Eater",
     "cells": {
      "$round": "7",
      "$bite": "8",
      "$eaten": "35"
     },
     "tape_len": 11
    },
    {
     "n": 134,
     "pc": 32,
     "op": "JMP",
     "ins": [
      "16"
     ],
     "block": "Eater",
     "cells": {
      "$round": "7",
      "$bite": "8",
      "$eaten": "35"
     },
     "tape_len": 12
    },
    {
     "n": 135,
     "pc": 16,
     "op": "CONST",
     "ins": [
      "%9",
      "1"
     ],
     "block": "Eater",
     "cells": {
      "$round": "7",
      "$bite": "8",
      "$eaten": "35"
     },
     "tape_len": 12
    },
    {
     "n": 136,
     "pc": 17,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%10",
      "$round",
      "%9"
     ],
     "block": "Eater",
     "cells": {
      "$round": "7",
      "$bite": "8",
      "$eaten": "35"
     },
     "tape_len": 12
    },
    {
     "n": 137,
     "pc": 18,
     "op": "MOV",
     "ins": [
      "$round",
      "%10"
     ],
     "block": "Eater",
     "cells": {
      "$round": "7",
      "$bite": "8",
      "$eaten": "35"
     },
     "tape_len": 12
    },
    {
     "n": 138,
     "pc": 19,
     "op": "CONST",
     "ins": [
      "%11",
      "1"
     ],
     "block": "Eater",
     "cells": {
      "$round": "8",
      "$bite": "8",
      "$eaten": "35"
     },
     "tape_len": 12
    },
    {
     "n": 139,
     "pc": 20,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%12",
      "$bite",
      "%11"
     ],
     "block": "Eater",
     "cells": {
      "$round": "8",
      "$bite": "8",
      "$eaten": "35"
     },
     "tape_len": 12
    },
    {
     "n": 140,
     "pc": 21,
     "op": "MOV",
     "ins": [
      "$bite",
      "%12"
     ],
     "block": "Eater",
     "cells": {
      "$round": "8",
      "$bite": "8",
      "$eaten": "35"
     },
     "tape_len": 12
    },
    {
     "n": 141,
     "pc": 22,
     "op": "BINOP",
     "ins": [
      "ADD",
      "%13",
      "$eaten",
      "$bite"
     ],
     "block": "Eater",
     "cells": {
      "$round": "8",
      "$bite": "9",
      "$eaten": "35"
     },
     "tape_len": 12
    },
    {
     "n": 142,
     "pc": 23,
     "op": "MOV",
     "ins": [
      "$eaten",
      "%13"
     ],
     "block": "Eater",
     "cells": {
      "$round": "8",
      "$bite": "9",
      "$eaten": "35"
     },
     "tape_len": 12
    },
    {
     "n": 143,
     "pc": 24,
     "op": "CONST",
     "ins": [
      "%14",
      "round "
     ],
     "block": "Eater",
     "cells": {
      "$round": "8",
      "$bite": "9",
      "$eaten": "44"
     },
     "tape_len": 12
    },
    {
     "n": 144,
     "pc": 25,
     "op": "UNOP",
     "ins": [
      "STR",
      "%15",
      "$round"
     ],
     "block": "Eater",
     "cells": {
      "$round": "8",
      "$bite": "9",
      "$eaten": "44"
     },
     "tape_len": 12
    },
    {
     "n": 145,
     "pc": 26,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%16",
      "%14",
      "%15"
     ],
     "block": "Eater",
     "cells": {
      "$round": "8",
      "$bite": "9",
      "$eaten": "44"
     },
     "tape_len": 12
    },
    {
     "n": 146,
     "pc": 27,
     "op": "CONST",
     "ins": [
      "%17",
      " -- eaten "
     ],
     "block": "Eater",
     "cells": {
      "$round": "8",
      "$bite": "9",
      "$eaten": "44"
     },
     "tape_len": 12
    },
    {
     "n": 147,
     "pc": 28,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%18",
      "%16",
      "%17"
     ],
     "block": "Eater",
     "cells": {
      "$round": "8",
      "$bite": "9",
      "$eaten": "44"
     },
     "tape_len": 12
    },
    {
     "n": 148,
     "pc": 29,
     "op": "UNOP",
     "ins": [
      "STR",
      "%19",
      "$eaten"
     ],
     "block": "Eater",
     "cells": {
      "$round": "8",
      "$bite": "9",
      "$eaten": "44"
     },
     "tape_len": 12
    },
    {
     "n": 149,
     "pc": 30,
     "op": "BINOP",
     "ins": [
      "CAT",
      "%20",
      "%18",
      "%19"
     ],
     "block": "Eater",
     "cells": {
      "$round": "8",
      "$bite": "9",
      "$eaten": "44"
     },
     "tape_len": 12
    }
   ],
   "trace_shown": 150
  }
 ],
 "conformance": {
  "referee": "MILESTONE M4: 31/31",
  "selftest": {
   "passed": 57,
   "total": 57
  }
 },
 "sections": [
  {
   "title": "Policy programs (default profile: every one provably halts)",
   "checks": [
    {
     "label": "quorum_gate.alcor prints 'ALLOW REFUSE HOLD REFUSE'",
     "ok": true
    },
    {
     "label": "capped_backoff.alcor prints '5 10 20 40 60 60'",
     "ok": true
    },
    {
     "label": "kernel scenario 'nothing wrong, keep going'",
     "ok": true
    },
    {
     "label": "kernel scenario 'claim with a red check is pushed back'",
     "ok": true
    },
    {
     "label": "kernel scenario 'wrong request schema is refused'",
     "ok": true
    }
   ]
  },
  {
   "title": "v3 syntax lowers to the same core",
   "checks": [
    {
     "label": "the lowered program has no LOOP and no backward jump",
     "ok": true
    },
    {
     "label": "backoff_v3 with input 0 prints 'attempt 0: wait 5s'",
     "ok": true
    },
    {
     "label": "backoff_v3 with input 3 prints 'attempt 3: wait 40s'",
     "ok": true
    },
    {
     "label": "the top-level API runs a v3 source directly",
     "ok": true
    }
   ]
  },
  {
   "title": "Halting is decided before the program runs",
   "checks": [
    {
     "label": "a default-profile loop is rejected at compile time",
     "ok": true
    },
    {
     "label": "complete without authority parses but run() refuses",
     "ok": true
    },
    {
     "label": "an unbounded loop is stopped by fuel",
     "ok": true
    },
    {
     "label": "a fuel override stays local to its call",
     "ok": true
    }
   ]
  },
  {
   "title": "Lint: stable rule ids",
   "checks": [
    {
     "label": "a parse failure carries the rule id parse/error and exits 1",
     "ok": true
    },
    {
     "label": "warning profile/conformance-authority is advisory (exit 0) ...",
     "ok": true
    },
    {
     "label": "... and fails with --strict (exit 1)",
     "ok": true
    },
    {
     "label": "the shipped examples have no lint errors",
     "ok": true
    }
   ]
  },
  {
   "title": "Lowering: one program, three backends, identical output",
   "checks": [
    {
     "label": "quorum_gate.alcor: the lowered script (python -I) matches the interpreter",
     "ok": true
    },
    {
     "label": "capped_backoff.alcor: the lowered script (python -I) matches the interpreter",
     "ok": true
    },
    {
     "label": "C lowering produces a translation unit with main()",
     "ok": true
    },
    {
     "label": "the native binary matches the interpreter",
     "ok": true
    },
    {
     "label": "a native build refuses a complete-profile program",
     "ok": true
    }
   ]
  },
  {
   "title": "Effects never run inside the language",
   "checks": [
    {
     "label": "the program ran to the end",
     "ok": true
    },
    {
     "label": "the effect left a refusal receipt, not a file",
     "ok": true
    },
    {
     "label": "the receipt hashes its own contents",
     "ok": true
    }
   ]
  },
  {
   "title": "Hosted run: verified authority, replay and UNKNOWN",
   "checks": [
    {
     "label": "an authorised effect completes through the gate",
     "ok": true
    },
    {
     "label": "the same idempotency key replays the stored receipt and does not call the gate again",
     "ok": true
    },
    {
     "label": "without verified authority nothing runs and the gate is never called",
     "ok": true
    },
    {
     "label": "a gate that dies mid-call yields UNKNOWN, not success",
     "ok": true
    },
    {
     "label": "the effect may have happened, so ATTEMPTED is never replayed: the retry is UNKNOWN",
     "ok": true
    },
    {
     "label": "... and the retry calls the gate zero times",
     "ok": true
    }
   ]
  },
  {
   "title": "Conformance: the corpus is the ground truth",
   "checks": [
    {
     "label": "the referee passes every conformance test",
     "ok": true
    },
    {
     "label": "the in-process selftest passes",
     "ok": true
    },
    {
     "label": "the referee can say no: a stub that is wrong on every axis fails every test",
     "ok": true
    }
   ]
  },
  {
   "title": "Self-hosting: an interpreter written in AlcorLang",
   "checks": [
    {
     "label": "its string library is an exact copy of selfhost/alcorstr.alcor",
     "ok": true
    },
    {
     "label": "no program disagrees between the two interpreters",
     "ok": true
    },
    {
     "label": "the sampled operator sweep has zero mismatches",
     "ok": true
    },
    {
     "label": "the halting rule holds when the interpreter is itself an AlcorLang program",
     "ok": true
    },
    {
     "label": "effects are refused out loud, never faked",
     "ok": true
    }
   ]
  }
 ]
};
