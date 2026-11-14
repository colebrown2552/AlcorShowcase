"""Drain a JobQueue, dispatching each job to a handler by kind."""


def run_all(queue, handlers, log=None):
    """Run jobs until the queue is empty.

    ``handlers`` maps job kind -> callable(payload). A handler that raises
    marks the attempt failed; the job is re-queued (behind jobs of the same
    priority) until it runs out of attempts. Returns a list of
    (job_id, outcome) tuples in execution order, outcome being "ok",
    "retry" or "failed".
    """
    log = [] if log is None else log
    while len(queue):
        job = queue.pop()
        job.attempts += 1
        try:
            handlers[job.kind](job.payload)
        except Exception as exc:  # noqa: BLE001 - any handler error is a job failure
            job.last_error = f"{type(exc).__name__}: {exc}"
            if job.can_retry():
                log.append((job.job_id, "retry"))
                queue.submit(job)
            else:
                log.append((job.job_id, "failed"))
            continue
        log.append((job.job_id, "ok"))
    return log
