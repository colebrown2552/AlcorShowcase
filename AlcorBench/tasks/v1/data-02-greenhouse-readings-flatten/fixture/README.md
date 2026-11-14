# greenhouse-readings

The bench controllers in the Marrowby greenhouses push one JSON object per
reading to a JSON Lines file. The growers want the same data as a spreadsheet,
so `flatten_readings.py` turns a `.jsonl` file into a CSV table.

    python3 flatten_readings.py readings.jsonl readings.csv

Different controller firmware versions send different fields, so the table has
to cope with records that don't share the same keys.
