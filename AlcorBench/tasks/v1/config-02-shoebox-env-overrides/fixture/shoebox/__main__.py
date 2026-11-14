"""python3 -m shoebox [CONFIG_INI]: print the effective settings as JSON."""
import json
import sys

from shoebox.config import ConfigError, load_config


def main(argv):
    try:
        config = load_config(argv[1] if len(argv) > 1 else None)
    except ConfigError as exc:
        print("shoebox: %s" % exc, file=sys.stderr)
        return 1
    print(json.dumps(config, indent=2, sort_keys=True))
    return 0


sys.exit(main(sys.argv))
