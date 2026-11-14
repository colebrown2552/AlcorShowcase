# Candidate tasks

Tasks that are written but not yet part of a versioned set. A candidate uses the same format as
`tasks/v1/` and must pass `python3 -m alcorbench validate tasks/candidate/<task-id>` before it
is promoted. Promotion copies it into the next version folder unchanged; a task already in a
released version is never edited, because saved runs refer to it by content hash.

Before promoting, the author also runs the validation loop by hand: the check fails on the
untouched fixture, passes with the reference laid over it, and gives the same result on two
more runs.

This folder may be empty.
