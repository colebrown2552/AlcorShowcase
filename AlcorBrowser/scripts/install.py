"""Install AlcorBrowser on this machine and register its native-messaging host (Windows).

Two steps, with Chrome's "Load unpacked" between them, because Chrome only reveals the extension's
id after it has loaded the folder::

    python scripts/install.py install --label work
        copies runtime/ and extension/ into the broker home, writes the per-install config.js and
        build.json, and prints the extension folder to load.
    python scripts/install.py register-host --extension-id <id from chrome://extensions>
        writes the host manifest and launcher and registers them for the current user, and saves
        the id in config.json so the broker only accepts that extension.

``unregister-host`` removes the registration. Nothing is registered at login: Chrome starts the
host when the extension asks for it, and the host starts the broker.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "runtime"))

import update_channel  # noqa: E402  (needs the path line above)
from settings import ConfigError, check_extension_id, default_home  # noqa: E402

NATIVE_HOST = "com.alcor.browser"
_LABEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,31}")
_BROWSER_KEYS = {
    "chrome": r"Software\Google\Chrome\NativeMessagingHosts",
    "edge": r"Software\Microsoft\Edge\NativeMessagingHosts",
}


def install_tree(source: Path, home: Path, label: str) -> str:
    """Copy a build into a broker home and write the per-install files.

    The extension copy is replaced wholesale; ``config.json`` is created only if absent, so a
    re-install keeps the operator's settings.

    Args:
        source: A folder holding ``extension/`` and ``runtime/``.
        home: The broker home to install into.
        label: Names the browser profile (``profile_label``); one connection per label.

    Returns:
        The build id of the installed extension.

    Raises:
        ValueError: If ``label`` is not letters, digits, '-' or '_'.
    """
    if not _LABEL.fullmatch(label):
        raise ValueError("label: use letters, digits, '-' and '_' (max 32)")
    collected = update_channel.collect(source)
    build = update_channel.build_id(entry for entry, _ in collected)
    runtime = home / "runtime"
    extension = home / f"extension-agents-{label}"
    runtime.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(extension, ignore_errors=True)
    extension.mkdir(parents=True)
    for entry, data in collected:
        (runtime if entry.kind == "runtime" else extension).joinpath(entry.name).write_bytes(data)
    config = {
        "host": NATIVE_HOST,
        "profile_label": label,
        "build": build,
        "install_dir": str(extension),
    }
    (extension / "config.js").write_text(
        "globalThis.ALCOR_BROWSER_CONFIG = " + json.dumps(config, indent=2) + ";\n",
        encoding="utf-8",
    )
    (extension / "build.json").write_text(json.dumps({"build": build}) + "\n", encoding="utf-8")
    (home / "uploads").mkdir(exist_ok=True)
    settings_file = home / "config.json"
    if not settings_file.exists():
        starter = {"agents": ["agent-a", "agent-b"], "extension_id": "", "update_channel": ""}
        settings_file.write_text(json.dumps(starter, indent=2) + "\n", encoding="utf-8")
    return build


def register_host(home: Path, extension_id: str, browser: str, host_name: str) -> Path:
    """Write the host manifest and launcher and register them for the current Windows user.

    Chrome only starts the host for the extension ids in ``allowed_origins``, which is why the id
    is needed here and why it is also saved to ``config.json``.

    Args:
        home: The broker home that was installed into.
        extension_id: The id shown on chrome://extensions after loading the extension.
        browser: ``chrome`` or ``edge``.
        host_name: The native-messaging host name; must match ``host`` in the extension's config.js.

    Returns:
        The path of the host manifest that was registered.

    Raises:
        OSError: On a platform without a registry.
        ConfigError: If the id is malformed.
    """
    if os.name != "nt":
        raise OSError("registering a native-messaging host through the registry needs Windows")
    import winreg

    extension_id = check_extension_id(extension_id)
    if not extension_id:
        raise ConfigError("extension_id: required")
    runtime = home / "runtime"
    # The launcher pins this install's home, so the host finds the right broker whatever the
    # environment Chrome starts it in; the port is pinned too if it was customised.
    pinned = {"ALCOR_BROWSER_HOME": str(home)}
    if os.environ.get("ALCOR_BROWSER_PORT"):
        pinned["ALCOR_BROWSER_PORT"] = os.environ["ALCOR_BROWSER_PORT"]
    lines = "".join(f'set "{key}={value}"\r\n' for key, value in pinned.items())
    launcher = runtime / f"{host_name}.cmd"
    launcher.write_bytes(
        f'@echo off\r\n{lines}"{sys.executable}" -B "{runtime / "native_host.py"}" %*\r\n'.encode()
    )
    manifest = runtime / f"{host_name}.json"
    manifest.write_text(
        json.dumps(
            {
                "name": host_name,
                "description": "AlcorBrowser agent channel",
                "path": str(launcher),
                "type": "stdio",
                "allowed_origins": [f"chrome-extension://{extension_id}/"],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    with winreg.CreateKey(
        winreg.HKEY_CURRENT_USER, f"{_BROWSER_KEYS[browser]}\\{host_name}"
    ) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest))
    settings_file = home / "config.json"
    saved = json.loads(settings_file.read_text(encoding="utf-8")) if settings_file.is_file() else {}
    saved["extension_id"] = extension_id
    settings_file.write_text(json.dumps(saved, indent=2) + "\n", encoding="utf-8")
    return manifest


def unregister_host(browser: str, host_name: str) -> None:
    """Remove the registry entry for a host; a missing entry is fine."""
    if os.name != "nt":
        return
    import winreg

    with contextlib.suppress(FileNotFoundError):
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, f"{_BROWSER_KEYS[browser]}\\{host_name}")


def main(argv: list[str] | None = None) -> int:
    """Run the installer command line; prints a JSON summary and returns the exit code."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--home", type=Path, default=None, help="broker home (default: per-user)")
    sub = parser.add_subparsers(dest="command", required=True)
    install = sub.add_parser("install")
    install.add_argument(
        "--label", default="default", help="profile label, one per browser profile"
    )
    install.add_argument("--source", type=Path, default=ROOT)
    for name in ("register-host", "unregister-host"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--browser", choices=sorted(_BROWSER_KEYS), default="chrome")
        cmd.add_argument("--host-name", default=NATIVE_HOST)
        if name == "register-host":
            cmd.add_argument("--extension-id", required=True)
    args = parser.parse_args(argv)
    home = args.home or default_home()
    try:
        if args.command == "install":
            build = install_tree(args.source, home, args.label)
            result = {
                "status": "installed",
                "home": str(home),
                "extension_dir": str(home / f"extension-agents-{args.label}"),
                "build": build[:12],
                "next": "chrome://extensions -> Developer mode -> Load unpacked -> extension_dir, "
                "then register-host with the id Chrome shows",
            }
        elif args.command == "register-host":
            manifest = register_host(home, args.extension_id, args.browser, args.host_name)
            result = {"status": "registered", "host": args.host_name, "manifest": str(manifest)}
        else:
            unregister_host(args.browser, args.host_name)
            result = {"status": "unregistered", "host": args.host_name}
    except (ValueError, OSError, ConfigError, update_channel.ChannelError) as exc:
        print(f"failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
