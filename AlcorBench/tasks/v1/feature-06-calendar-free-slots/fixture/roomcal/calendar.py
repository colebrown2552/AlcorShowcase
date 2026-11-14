"""Room bookings for a single day."""
from dataclasses import dataclass

from .clock import to_minutes


@dataclass(frozen=True)
class Booking:
    room: str
    start: str  # "HH:MM"
    end: str    # "HH:MM", exclusive

    def __post_init__(self):
        if to_minutes(self.end) <= to_minutes(self.start):
            raise ValueError("booking must end after it starts")

    @property
    def span(self):
        return to_minutes(self.start), to_minutes(self.end)


def bookings_for(bookings, room):
    """The bookings for one room, sorted by start time."""
    return sorted((b for b in bookings if b.room == room), key=lambda b: b.span)


def conflicts(bookings):
    """Pairs of bookings in the same room whose times overlap."""
    found = []
    by_room = {}
    for booking in bookings:
        by_room.setdefault(booking.room, []).append(booking)
    for room in sorted(by_room):
        items = bookings_for(by_room[room], room)
        for i, first in enumerate(items):
            for second in items[i + 1:]:
                if second.span[0] < first.span[1]:
                    found.append((first, second))
    return found
