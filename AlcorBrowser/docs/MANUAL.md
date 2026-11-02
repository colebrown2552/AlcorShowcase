# Running AlcorBrowser for real (Windows)

This is the hands-on guide: load the extension, register the native-messaging host, start the
broker and point an MCP client at it. For the design, read the [README](../README.md). For a run
that needs no browser, use `python demo/run_demo.py`.

Everything below was written for Windows 10 or 11 with Chrome 116 or newer. The installer and the
restart lane use the registry and Task Scheduler; the broker and native host are plain Python and
the demo runs wherever Python does, but a real install is only described for Windows.

## 1. What you need

- Python 3.10 or newer on `PATH` (standard library only, nothing to `pip install`).
- Google Chrome (or Edge) with a profile you are happy to let an agent use. Agents act with
  that profile's signed-in sessions, so use a profile whose accounts you would let them touch.
- This folder, checked out anywhere. The commands assume you are in the repository root.

## 2. What you are granting

The extension asks Chrome for these permissions, and each one is used:

| Permission        | Used for                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nativeMessaging` | The only channel to the broker: Chrome starts the registered host for this extension.                                                                                                              |
| `debugger`        | Trusted clicks, keys and text (`Input.*`), screenshots and `browser_eval`. Chrome shows a "started debugging this browser" bar while a tab is attached; the worker detaches after 20 s of silence. |
| `scripting`       | Injecting `page.js` to read the page and to find the element a click should hit.                                                                                                                   |
| `tabs`            | Listing, opening, navigating and closing tabs.                                                                                                                                                     |
| `storage`         | A browser session id (so tab handles survive an extension reload) and a 30-row diary of worker events.                                                                                             |
| `alarms`          | A 30 second wake-up that reconnects a dropped port.                                                                                                                                                |
| `background`      | Lets Chrome start early and stay running after its windows close, so the link survives.                                                                                                            |
| `<all_urls>`      | Agents may act on any site, including ones you are signed in to.                                                                                                                                   |

There is no per-site approval. Anyone who holds an agent token can drive every tab of the profile.
Keep the token files private (section 5) and keep the broker on loopback, which it enforces.

## 3. Install

```powershell
python AlcorBrowser\scripts\install.py install --label work
```

This copies `runtime\` and `extension\` into `%LOCALAPPDATA%\AlcorBrowser`, writes the per-install
`config.js` and `build.json`, creates an `uploads` folder and a starter `config.json`, and prints the
folder to load. `--label` names the browser profile to the broker; use a different label for each
Chrome profile you attach. `--home` installs somewhere else.

## 4. Load the extension and register the host

Chrome only reveals an unpacked extension's id after it has loaded the folder, and the native-messaging
host must name that id, so this is two steps with Chrome in between.

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick the
   `extension_dir` the installer printed (`%LOCALAPPDATA%\AlcorBrowser\extension-agents-work`).
2. Copy the extension's **ID**: 32 letters, a to p. It depends on the folder you loaded, so
   register again if you ever load a different folder.
3. Register the host and save the id (replace `EXTENSION_ID` with the 32 letters you copied):

   ```powershell
   python AlcorBrowser\scripts\install.py register-host --extension-id EXTENSION_ID
   ```

   This writes a host manifest and launcher into `runtime\`, registers them for your user under
   the browser's `NativeMessagingHosts` key (`--browser edge` for Edge), and stores the id in
   `config.json`. The broker accepts upload tickets only from that extension. Nothing is registered
   at login: Chrome starts the host when the extension asks, and the host starts the broker.

4. On the extension's card press the reload arrow. Open the toolbar popup. It should read
   **Connected**, and the icon shows an **A** badge.

Check from a terminal:

```powershell
python $env:LOCALAPPDATA\AlcorBrowser\runtime\companion.py status
```

It prints the operator status as JSON: broker version, attached profiles and update state. It
never contains a token.

## 5. Configure agents and uploads

Edit `%LOCALAPPDATA%\AlcorBrowser\config.json`. Every key is optional;
[`config.example.json`](../config.example.json) shows them all.

| Key                 | Meaning                                                                                           | Default                  |
| ------------------- | ------------------------------------------------------------------------------------------------- | ------------------------ |
| `agents`            | Names that may call `/mcp`. Each gets its own token file. Lowercase letters, digits, `-` and `_`. | `["agent-a", "agent-b"]` |
| `extension_id`      | The one extension allowed to fetch upload tickets. Set by `register-host`.                        | empty (uploads refused)  |
| `upload_dirs`       | Absolute folders `browser_upload` may read from. `[]` turns uploads off.                          | `<home>\uploads`         |
| `update_channel`    | A folder path or an `https://` URL (section 8). Empty means no updates.                           | empty                    |
| `update_interval_s` | Seconds between background update checks.                                                         | `600`                    |

Tokens are created on first start in `%LOCALAPPDATA%\AlcorBrowser\state\agents\<name>.token`
(`extension.token` is the native relay's, `admin.token` guards the status route). They are
random, 64 characters, and the broker never prints or returns them. Treat them like passwords. To
rotate one, stop the broker, delete the file and start again.

Environment variables override the file for a single run:

| Variable                          | Effect                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ALCOR_BROWSER_HOME`              | Broker home (config, state, runtime, extension copies).                                                   |
| `ALCOR_BROWSER_PORT`              | TCP port on `127.0.0.1`. The default is 47800.                                                            |
| `ALCOR_BROWSER_CONFIG`            | Path of a `config.json` to use instead of the one in the home.                                            |
| `ALCOR_BROWSER_EXTENSION_ID`      | Overrides `extension_id`.                                                                                 |
| `ALCOR_BROWSER_CHANNEL`           | Overrides `update_channel`.                                                                               |
| `ALCOR_BROWSER_UPDATE_INTERVAL_S` | Overrides `update_interval_s`.                                                                            |
| `ALCOR_BROWSER_UPDATES`           | Set to `0` to stop the background update timer. Explicit checks (the popup, `browser_restart`) still run. |

If you change the port, set `ALCOR_BROWSER_PORT` before running `register-host` too: the host
launcher pins it.

## 6. Point an MCP client at it

The broker speaks MCP over HTTP at `http://127.0.0.1:PORT/mcp` with JSON responses (no event
stream). `PORT` is what `python ...\runtime\companion.py port` prints. Send the agent's token as a
bearer token. In a client that takes an `mcpServers` block it looks like this:

```json
{
  "mcpServers": {
    "alcor-browser": {
      "type": "http",
      "url": "http://127.0.0.1:PORT/mcp",
      "headers": { "Authorization": "Bearer <contents of state\\agents\\agent-a.token>" }
    }
  }
}
```

Clients that can run a command to obtain headers can use:

```powershell
python $env:LOCALAPPDATA\AlcorBrowser\runtime\companion.py mcp-headers --agent agent-a
```

which starts the broker if needed and prints `{"Authorization": "Bearer ..."}` (that one line is
deliberately the agent's own secret). A request that carries an `Origin` header is refused, so a web
page cannot use the endpoint even if it learned a token.

Try it by hand: ask for `tools/list`, then `browser_open` a page, then `browser_snapshot` it and
act on the refs it returns. `browser_tabs` lists tabs the operator already has open.

## 7. The restart lane (optional)

`browser_restart` and the popup's **Restart** button run a scheduled task, because the restart
stops the broker and so cannot be one of its children. Register it once. The name is fixed:

```powershell
$script = Join-Path $env:LOCALAPPDATA 'AlcorBrowser\runtime\alcorbrowser_restart.ps1'
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Profile Default"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
Register-ScheduledTask -TaskName 'AlcorBrowserRestart' -Action $action -Description 'AlcorBrowser restart lane (on demand)' -Force
```

`-Profile` is the Chrome profile directory to reopen if the browser is closed (the folder name under
`User Data`: `Default`, or the name of the one you use). The task has no trigger, so it only runs
when asked. Run it yourself with `schtasks /Run /TN AlcorBrowserRestart`; the result lands in
`state\restart-last.json`. The script also takes `-BrokerHome` (add it to the arguments if you
installed with `--home`), `-Port`, `-WaitSeconds` and `-NoLaunch` (never start the browser).

## 8. Updates (optional)

An update channel is a folder with a `version.json` and the files it lists. Publish one from a
checkout:

```powershell
python AlcorBrowser\scripts\publish.py --out C:\alcor-channel --note "what changed"
```

Then set `update_channel` to that folder in `config.json` (or to an `https://` URL that serves the
same folder as static files; plain `http` is accepted only for a loopback address, for testing) and
restart the broker. It checks 45 seconds after start and then every `update_interval_s`; the popup's
**Update** button and `browser_restart` with `scope: "update"` check at once.

For each check the broker downloads every file, compares it with the manifest's SHA-256 and size,
and only then backs up and replaces files; any error restores the backup. After a successful
install it asks the extension to reload and exits, and the next native-host launch starts the new
broker. Receipts record `update-start`, `update-staged`, `update-applied` or `update-failed` and
`update-restored`.

**What this does not give you:** the SHA-256 values come from the same channel as the files, so they
catch corruption, truncation and a tampered file, but not a malicious publisher. They are integrity
checks, not signatures. Only point `update_channel` at a location you control, preferably over
https, until the manifest itself is signed.

## 9. Troubleshooting

- **Popup says Offline.** Open `chrome://extensions`, find AlcorBrowser, click _service worker_,
  and in its console run `chrome.storage.local.get('alcorDiag')`. The diary lists worker starts,
  disconnects and errors reported by the host.
- **`Specified native messaging host not found`.** The registration is missing, or its id does not
  match the loaded extension. Run `register-host` again with the id on `chrome://extensions`.
- **`broker-did-not-start` in the diary.** The host could not start or reach the broker. Run
  `python ...\runtime\companion.py serve` in a terminal to see why; "cannot listen" means the port
  is in use, so set `ALCOR_BROWSER_PORT`.
- **`no-browser-connected`.** The profile is closed or the extension is not attached. Open it, or
  run the restart lane.
- **`tab-busy`.** Another call is still running on that tab; retry.
- **`browser-timeout` with `uncertain: true`.** The command was sent but no result came back, so it
  may or may not have run. Take a fresh snapshot and look before you act again.
- **Uploads fail with `upload-path-not-allowed`.** Add the folder to `upload_dirs`, or copy the file
  into one that is already listed.
- **The agent gets 401.** Wrong or missing token, or an agent name that is not in `agents`.

## 10. Uninstall

```powershell
python AlcorBrowser\scripts\install.py unregister-host
Unregister-ScheduledTask -TaskName AlcorBrowserRestart -Confirm:$false   # if you registered it
```

Remove the extension on `chrome://extensions` and delete `%LOCALAPPDATA%\AlcorBrowser`.
