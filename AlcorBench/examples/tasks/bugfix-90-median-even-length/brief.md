Our `median` in `numstat/center.py` gives the wrong answer for lists with an even
number of items. For `[1, 2, 3, 4]` it returns `3`; it should return `2.5`, the mean of
the two middle values.

Please fix it. Odd-length lists must keep working, an empty list must still raise
`ValueError`, and the caller's list must not be modified. The existing tests run with
`python3 -m unittest`; leave them as they are.
