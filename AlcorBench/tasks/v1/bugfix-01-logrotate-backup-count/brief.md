# Log rotation never keeps the configured number of backups

Reported by ops: our worker writes `worker.log` through `logrot` with
`backup_count=5`. After the service has been running for a few days there are
only four old files on disk (`worker.log.1` to `worker.log.4`); `worker.log.5`
never appears. A colleague tried `backup_count=2` on a test box and only ever
got `worker.log.1`.

The rotation code is in `logrot/rotator.py`; `logrot/cli.py` is the small
command-line wrapper we use from cron. The docstring at the top of
`rotator.py` describes the intended behaviour.

Done means: after enough rotations, exactly `backup_count` backups exist for
any `backup_count`, numbered from `.1` (newest) upwards, each holding the right
generation of the log, and `backup_count=0` still just truncates the log. The
existing tests in `tests/test_rotator.py` must keep passing (run them with
`python3 -m unittest discover -s tests -t .`).
