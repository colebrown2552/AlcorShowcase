# Job queue blows up with TypeError on busy days

Since we started submitting the nightly thumbnail jobs at the same priority as
the report jobs, the scheduler process dies with

    TypeError: '<' not supported between instances of 'Job' and 'Job'

It does not happen every time; it seems to depend on how many jobs are
waiting. It can also happen when a failed job is put back on the queue by the
worker, and listing pending jobs from the admin page crashes the same way.

The code is in the `jobq` package: `jobq/job.py` (the `Job` record),
`jobq/queue.py` (`JobQueue`: `submit`, `pop`, `peek`, `cancel`, `pending`,
`len()`), and `jobq/worker.py` (runs jobs and re-queues failures).

Done means: any number of jobs can share a priority without errors anywhere
in `JobQueue` or the worker. Lower priority numbers still come out first, and
jobs with the same priority come out in the order they were submitted (first
in, first out), including in `peek()` and `pending()`. A job that the worker
re-queues counts as newly submitted. Cancelled jobs must still never be
returned. Keep the public API as it is; `tests/test_queue.py` must keep passing
(`python3 -m unittest discover -s tests -t .`).
