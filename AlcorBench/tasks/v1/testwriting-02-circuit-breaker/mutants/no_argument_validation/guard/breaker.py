"""Circuit breaker for calls to flaky dependencies."""
import time

CLOSED, OPEN, HALF_OPEN = "closed", "open", "half_open"


class CircuitOpenError(RuntimeError):
    """Raised by CircuitBreaker.call() when the call is not allowed."""


class CircuitBreaker:
    """Stops calling a failing dependency for a while.

    * The breaker starts ``"closed"``: calls are allowed. Each failure
      recorded while closed adds to a count of consecutive failures; a
      success resets that count to zero. When the count reaches
      ``failure_threshold`` the breaker becomes ``"open"``.
    * While open, ``allow()`` returns False. Once ``reset_timeout`` seconds
      have passed since it opened, the breaker is ``"half_open"``.
    * Half-open, ``allow()`` returns True for exactly one trial call and
      False after that until the trial's outcome is recorded. A recorded
      success closes the breaker (count back to zero); a recorded failure
      opens it again, for a full ``reset_timeout`` counted from that failure.
    * ``call(fn, *args, **kwargs)`` does all of the above: it raises
      CircuitOpenError without calling ``fn`` when the call is not allowed,
      otherwise calls ``fn``, records success or failure, and returns its
      result or re-raises its exception.
    * ``state`` reports ``"closed"``, ``"open"`` or ``"half_open"``.
    * ValueError if ``failure_threshold`` < 1 or ``reset_timeout`` <= 0.

    ``clock`` returns the current time in seconds; pass a fake one in tests.
    """

    def __init__(self, failure_threshold=5, reset_timeout=30.0, clock=time.monotonic):
        self.failure_threshold = failure_threshold
        self.reset_timeout = reset_timeout
        self._clock = clock
        self._state = CLOSED
        self._failures = 0
        self._opened_at = None
        self._trial_in_flight = False

    @property
    def state(self):
        if self._state == OPEN and self._clock() - self._opened_at >= self.reset_timeout:
            self._state = HALF_OPEN
            self._trial_in_flight = False
        return self._state

    def allow(self):
        state = self.state
        if state == CLOSED:
            return True
        if state == HALF_OPEN and not self._trial_in_flight:
            self._trial_in_flight = True
            return True
        return False

    def record_success(self):
        self._state = CLOSED
        self._failures = 0
        self._trial_in_flight = False

    def record_failure(self):
        if self.state == HALF_OPEN:
            self._open()
            return
        self._failures += 1
        if self._failures >= self.failure_threshold:
            self._open()

    def _open(self):
        self._state = OPEN
        self._opened_at = self._clock()
        self._failures = 0
        self._trial_in_flight = False

    def call(self, fn, *args, **kwargs):
        if not self.allow():
            raise CircuitOpenError("circuit open; call not attempted")
        try:
            result = fn(*args, **kwargs)
        except Exception:
            self.record_failure()
            raise
        self.record_success()
        return result
