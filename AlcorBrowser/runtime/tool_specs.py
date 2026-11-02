"""The MCP tool catalogue: names, argument schemas and hints, and nothing else.

``broker.py`` validates a call against ``TOOL_SPECS`` (required arguments, known properties) and
then routes it; the schemas here are what an agent sees in ``tools/list``. Keeping the catalogue
apart from the routing means a tool's contract can be read, and reviewed, without the machinery.

Every tool except ``browser_status``, ``browser_restart``, ``browser_open`` and ``browser_tabs``
acts on one tab named by a handle such as ``t3``.
"""

from __future__ import annotations

_TAB = {"type": "string", "description": "Tab handle, e.g. 't3' (browser_open or browser_tabs)."}
_REF = {
    "type": "string",
    "description": "Element ref from the latest browser_snapshot, e.g. 'e12'.",
}
_SNAP = {"type": "string", "description": "snapshot_id of the snapshot the ref came from."}
_SEL = {"type": "string", "description": "CSS selector, instead of ref+snapshot_id."}
_TARGET = {"ref": _REF, "snapshot_id": _SNAP, "selector": _SEL}

#: Tool name -> {"properties", "required", "read_only", "description"}.
TOOL_SPECS: dict[str, dict] = {
    "browser_status": {
        "properties": {},
        "read_only": True,
        "description": "Connected browsers, broker version and update-channel state.",
    },
    "browser_restart": {
        "properties": {
            "scope": {
                "type": "string",
                "enum": ["all", "extension", "update"],
                "description": (
                    "all (default): restart the broker and its native hosts, and reopen the "
                    "browser profile if it is closed; extension: reload the extension only; "
                    "update: check the update channel now and install a verified newer build."
                ),
            }
        },
        "read_only": False,
        "description": "Restart lane: use when the browser stops answering or after an update.",
    },
    "browser_tabs": {
        "properties": {},
        "read_only": True,
        "description": (
            "Every tab in the browser with its handle, title and URL. Any handle can be driven."
        ),
    },
    "browser_open": {
        "properties": {
            "url": {"type": "string"},
            "focus": {
                "type": "boolean",
                "description": "Make it the active tab (default false: opens in the background).",
            },
            "profile": {
                "type": "string",
                "description": "Profile label when several browsers are connected.",
            },
        },
        "required": ["url"],
        "read_only": False,
        "description": (
            "Open a URL in a new tab of the operator's signed-in browser. Returns its handle."
        ),
    },
    "browser_focus": {
        "properties": {"tab": _TAB},
        "required": ["tab"],
        "read_only": False,
        "description": (
            "Bring a tab to the front (some pages only render or screenshot while visible)."
        ),
    },
    "browser_navigate": {
        "properties": {
            "tab": _TAB,
            "url": {"type": "string"},
            "direction": {"type": "string", "enum": ["back", "forward", "reload"]},
        },
        "required": ["tab"],
        "read_only": False,
        "description": "Load a URL in a tab, or go back/forward/reload.",
    },
    "browser_snapshot": {
        "properties": {
            "tab": _TAB,
            "max_elements": {
                "type": "integer",
                "minimum": 10,
                "maximum": 1000,
                "description": "Default 150.",
            },
            "text_limit": {
                "type": "integer",
                "minimum": 0,
                "maximum": 200000,
                "description": "Page text characters (default 3000; 0 = none).",
            },
            "all": {
                "type": "boolean",
                "description": "Include offscreen elements (default: viewport only).",
            },
        },
        "required": ["tab"],
        "read_only": True,
        "description": (
            "Read the page: one line per interactive element ('e12 button \"Send\" disabled') "
            "plus page text."
        ),
    },
    "browser_screenshot": {
        "properties": {
            "tab": _TAB,
            "full_page": {"type": "boolean"},
            "max_width": {
                "type": "integer",
                "minimum": 320,
                "maximum": 1920,
                "description": "Default 1024.",
            },
        },
        "required": ["tab"],
        "read_only": True,
        "description": "JPEG screenshot of a tab.",
    },
    "browser_click": {
        "properties": {
            "tab": _TAB,
            **_TARGET,
            "x": {"type": "number"},
            "y": {"type": "number"},
            "double": {"type": "boolean"},
        },
        "required": ["tab"],
        "read_only": False,
        "description": "Click an element (ref or selector) or viewport x,y with real mouse events.",
    },
    "browser_type": {
        "properties": {
            "tab": _TAB,
            **_TARGET,
            "text": {"type": "string"},
            "clear": {
                "type": "boolean",
                "description": "Replace the field's content (default true).",
            },
            "submit": {"type": "boolean", "description": "Press Enter afterwards."},
        },
        "required": ["tab", "text"],
        "read_only": False,
        "description": (
            "Type into an input, textarea or rich-text editor with real keyboard input. "
            "Refuses password fields."
        ),
    },
    "browser_press": {
        "properties": {
            "tab": _TAB,
            "key": {
                "type": "string",
                "description": (
                    "Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, "
                    "PageUp, PageDown, Space, or one character."
                ),
            },
            "modifiers": {
                "type": "array",
                "items": {"type": "string", "enum": ["ctrl", "shift", "alt", "meta"]},
            },
        },
        "required": ["tab", "key"],
        "read_only": False,
        "description": (
            "Press a key in the tab's focused element. Characters are refused while a password "
            "field has focus."
        ),
    },
    "browser_select": {
        "properties": {"tab": _TAB, **_TARGET, "value": {"type": "string"}},
        "required": ["tab", "value"],
        "read_only": False,
        "description": "Choose an option (by value or visible text) in a <select>.",
    },
    "browser_scroll": {
        "properties": {
            "tab": _TAB,
            "dy": {"type": "number", "description": "Pixels, positive = down."},
            **_TARGET,
        },
        "required": ["tab"],
        "read_only": False,
        "description": "Scroll by dy pixels, or bring an element into view.",
    },
    "browser_wait": {
        "properties": {
            "tab": _TAB,
            "text": {"type": "string"},
            "gone_text": {"type": "string"},
            "timeout_ms": {"type": "integer", "minimum": 0, "maximum": 120000},
        },
        "required": ["tab"],
        "read_only": True,
        "description": "Wait until text appears (or gone_text disappears) or the page settles.",
    },
    "browser_eval": {
        "properties": {
            "tab": _TAB,
            "expression": {
                "type": "string",
                "description": (
                    "JavaScript; the value of the last expression is returned (promises awaited)."
                ),
            },
            "timeout_ms": {"type": "integer", "minimum": 100, "maximum": 60000},
        },
        "required": ["tab", "expression"],
        "read_only": False,
        "description": (
            "Run JavaScript in the page's main world (not limited by the page's CSP). "
            "Outside the password and CAPTCHA floors."
        ),
    },
    "browser_chatgpt": {
        "properties": {
            "tab": {
                "type": "string",
                "description": "ChatGPT tab handle; omit to open a new chat.",
            },
            "text": {
                "type": "string",
                "description": "Message to send; omit to just read the latest reply.",
            },
            "url": {
                "type": "string",
                "description": (
                    "With no tab: open this ChatGPT URL (a thread or project), not a new chat."
                ),
            },
            "wait": {"type": "boolean", "description": "Wait for the reply (default true)."},
            "wait_ms": {
                "type": "integer",
                "minimum": 5000,
                "maximum": 300000,
                "description": (
                    "How long one call waits for the reply (default 45000). A longer reply returns "
                    "pending: true; call again with the tab and no text to keep waiting."
                ),
            },
        },
        "required": [],
        "read_only": False,
        "description": (
            "Send a ChatGPT message and get the reply in one call. "
            "Returns tab, url (the thread) and reply text."
        ),
    },
    "browser_close": {
        "properties": {"tab": _TAB},
        "required": ["tab"],
        "read_only": False,
        "description": "Close a tab.",
    },
    "browser_upload": {
        "properties": {
            "tab": _TAB,
            "path": {
                "type": "string",
                "description": "Absolute path of a local file inside an allowed upload folder.",
            },
            "ref": {
                "type": "string",
                "description": "Optional file-input ref (fN) or upload button / drop zone ref.",
            },
            "snapshot_id": _SNAP,
            "method": {"type": "string", "enum": ["input", "drop"]},
        },
        "required": ["tab", "path"],
        "read_only": False,
        "description": (
            "Put a local file into the page's file input (or drop it on a drop zone). "
            "Only files inside the operator's upload folders are accepted."
        ),
    },
}

#: The ``tools`` array returned by ``tools/list``.
TOOLS = [
    {
        "name": name,
        "title": name.replace("browser_", "Browser ").replace("_", " "),
        "description": spec["description"],
        "inputSchema": {
            "type": "object",
            "properties": spec["properties"],
            "required": spec.get("required", []),
            "additionalProperties": False,
        },
        "annotations": {
            "readOnlyHint": spec["read_only"],
            "destructiveHint": not spec["read_only"],
            "idempotentHint": spec["read_only"],
            "openWorldHint": True,
        },
    }
    for name, spec in TOOL_SPECS.items()
]
