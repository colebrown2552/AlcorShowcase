from dataclasses import dataclass, field


@dataclass
class Job:
    job_id: str
    kind: str
    priority: int = 5            # lower runs sooner
    payload: dict = field(default_factory=dict)
    attempts: int = 0
    max_attempts: int = 3
    last_error: str = ""

    def can_retry(self):
        return self.attempts < self.max_attempts
