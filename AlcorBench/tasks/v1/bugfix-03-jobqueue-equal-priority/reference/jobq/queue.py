"""In-memory priority queue of jobs. Lower priority numbers are served first."""
import heapq
import itertools


class JobQueue:
    def __init__(self):
        self._heap = []          # entries: (priority, sequence, job)
        self._live = {}          # job_id -> job, for jobs not yet popped or cancelled
        self._sequence = itertools.count()

    def submit(self, job):
        if job.job_id in self._live:
            raise ValueError(f"job {job.job_id} is already queued")
        # The sequence number breaks ties in submission order, so Job objects
        # are never compared with each other.
        heapq.heappush(self._heap, (job.priority, next(self._sequence), job))
        self._live[job.job_id] = job

    def cancel(self, job_id):
        """Cancel a queued job. Returns True if it was queued."""
        return self._live.pop(job_id, None) is not None

    def _drop_dead_head(self):
        while self._heap and self._live.get(self._heap[0][2].job_id) is not self._heap[0][2]:
            heapq.heappop(self._heap)

    def peek(self):
        self._drop_dead_head()
        if not self._heap:
            raise IndexError("peek at empty JobQueue")
        return self._heap[0][2]

    def pop(self):
        self._drop_dead_head()
        if not self._heap:
            raise IndexError("pop from empty JobQueue")
        _, _, job = heapq.heappop(self._heap)
        del self._live[job.job_id]
        return job

    def pending(self):
        """Queued jobs in the order they will be served."""
        return [job for _, _, job in sorted(self._heap) if self._live.get(job.job_id) is job]

    def __len__(self):
        return len(self._live)
