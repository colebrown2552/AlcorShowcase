# logrot

Tiny size-based log rotation used by our background workers.

    python3 -m logrot.cli worker.log --max-bytes 1048576 --backups 5

rotates `worker.log` if it has reached the size limit.
