# semverlite

Tiny semantic-version helper used by our release scripts.

```python
from semverlite import parse, compare
v = parse("1.4.0-rc.2+build.7")
v.major, v.minor, v.patch, v.prerelease, v.build   # 1, 4, 0, "rc.2", "build.7"
compare(parse("1.0.0-alpha"), parse("1.0.0"))      # -1
```

Run the tests with `python3 -m unittest discover -s tests`.
