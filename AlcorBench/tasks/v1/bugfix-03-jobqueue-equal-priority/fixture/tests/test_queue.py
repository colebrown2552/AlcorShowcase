import unittest

from jobq.job import Job
from jobq.queue import JobQueue
from jobq.worker import run_all


class QueueTests(unittest.TestCase):
    def test_lower_priority_number_first(self):
        q = JobQueue()
        q.submit(Job("a", "report", priority=5))
        q.submit(Job("b", "report", priority=1))
        q.submit(Job("c", "report", priority=3))
        self.assertEqual([q.pop().job_id for _ in range(3)], ["b", "c", "a"])

    def test_empty_queue_raises(self):
        q = JobQueue()
        with self.assertRaises(IndexError):
            q.pop()
        with self.assertRaises(IndexError):
            q.peek()

    def test_cancel(self):
        q = JobQueue()
        q.submit(Job("a", "report", priority=2))
        q.submit(Job("b", "report", priority=1))
        self.assertTrue(q.cancel("b"))
        self.assertFalse(q.cancel("b"))
        self.assertEqual(len(q), 1)
        self.assertEqual(q.peek().job_id, "a")

    def test_duplicate_submit_rejected(self):
        q = JobQueue()
        q.submit(Job("a", "report"))
        with self.assertRaises(ValueError):
            q.submit(Job("a", "report"))

    def test_worker_retries_then_fails(self):
        q = JobQueue()
        q.submit(Job("x", "boom", priority=1, max_attempts=2))

        def boom(payload):
            raise RuntimeError("nope")

        log = run_all(q, {"boom": boom})
        self.assertEqual(log, [("x", "retry"), ("x", "failed")])


if __name__ == "__main__":
    unittest.main()
