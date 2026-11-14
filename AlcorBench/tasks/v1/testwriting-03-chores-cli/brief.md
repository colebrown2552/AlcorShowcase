# End-to-end tests for the `chores` CLI

`chores` is a small household to-do tool (`python3 -m chores ...`). Its
behaviour is described in `README.md`; the code is `chores/cli.py`,
`chores/store.py` and `chores/__main__.py`. There are no tests at all. We
want to restructure the code soon, so we need tests that treat it as a black
box: run the real command in a subprocess and check its output, exit code and
saved data, rather than calling internal functions.

Please add `tests/test_cli.py` using `unittest`, runnable with

    python3 -m unittest discover -s tests -t .

The tool is believed correct; do not change it. The tests must never read or
write the user's real chores file: give every test its own temporary data
file (the README shows how to point the tool at one), and use
`sys.executable` to run Python.

Done means: the tests pin down what the README promises, with concrete
expected output: adding chores and the ids they get, marking them done
(including an id that does not exist and one that is already done), what
`list` shows with and without `--all` and in which order, and that data
survives between separate runs. If someone later breaks any of those, the
suite should fail.
