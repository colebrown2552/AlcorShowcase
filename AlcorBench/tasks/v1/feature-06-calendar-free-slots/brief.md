The front desk wants a "when is this room free?" view. Please add a function to `roomcal/calendar.py` and export it from the `roomcal` package:

**Signature:** `free_slots(bookings, room, day_start="08:00", day_end="18:00", min_minutes=0) -> list[tuple[str, str]]`

It returns the free intervals of `room` within the window `[day_start, day_end)` as `(start, end)` pairs of `"HH:MM"` strings (zero-padded, same format `from_minutes` produces), sorted by start time.

Rules:

- Only bookings whose `room` equals `room` count. `bookings` may be in any order and may overlap each other (double bookings happen; they're reported separately by `conflicts`).
- A booking covers `[start, end)`. Bookings that touch (one ends at `10:00`, the next starts at `10:00`) leave no gap between them, and overlapping or touching bookings never produce zero-length or negative slots.
- Bookings that start before `day_start` or end after `day_end` are clipped to the window; bookings entirely outside the window are ignored.
- Adjacent free time is never split: each returned slot runs from the end of one busy stretch to the start of the next (or to the window edge).
- Only slots at least `min_minutes` long are returned (`min_minutes=0` keeps every non-empty slot).
- A room with no bookings is free for the whole window; a fully booked window gives `[]`.
- Raise `ValueError` if `day_start` is not strictly before `day_end`, if `min_minutes` is negative, or if a time string is malformed (`to_minutes` already raises for that).

Example: with Atlas booked 09:00-10:00 and 13:30-15:00, `free_slots(bookings, "Atlas")` is `[("08:00", "09:00"), ("10:00", "13:30"), ("15:00", "18:00")]`.

Keep the existing functions as they are; `tests/test_rooms.py` must keep passing (don't change it).
