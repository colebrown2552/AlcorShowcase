"""Read the plain-text habit journal: one `YYYY-MM-DD habit-name` entry per line."""
import datetime


def parse_journal(text):
    """{habit: set of dates it was done}. Blank lines and `#` comments are skipped."""
    done = {}
    for number, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            day_text, habit = line.split(None, 1)
            day = datetime.date.fromisoformat(day_text)
        except ValueError:
            raise ValueError("line %d: expected 'YYYY-MM-DD habit'" % number) from None
        done.setdefault(habit.strip(), set()).add(day)
    return done
