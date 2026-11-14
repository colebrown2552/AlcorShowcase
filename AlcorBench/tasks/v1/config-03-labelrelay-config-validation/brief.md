`python3 -m labelrelay check CONFIG_JSON` is supposed to catch config mistakes before the relay is deployed to the lab, but right now it only checks that the file is JSON, and `validate()` in `labelrelay/validate.py` is an empty stub. Last week a printer entry with `"port": "9100"` (a string) got through and the relay crashed at startup.

Please implement validation according to `docs/config-schema.md` (don't edit that document; it is the agreed contract).

`validate(config)`:
- Takes the parsed JSON value and returns a list of error message strings, an empty list when the config is valid.
- Reports every problem it finds, not just the first. The order of the messages does not matter.
- Messages must be exactly the ones the schema document gives, with the paths filled in, e.g. `printers[1].port: must be an integer between 1 and 65535` or `printers[2].name: duplicate name 'bench-a'`.
- If the value is not a JSON object at all, return `["config: must be an object"]`.

`python3 -m labelrelay check CONFIG_JSON`:
- Valid config: print `ok` to stdout, exit 0.
- Invalid config: print each error message on its own line to stderr, exit 1.
- File that can't be read or isn't valid JSON: print `CONFIG_JSON: invalid JSON` (the path as given) to stderr, exit 1.

`relay.json` is the config currently deployed and should pass. Done means the checker reports exactly the problems in a config, with the right messages, and nothing for a valid one.
