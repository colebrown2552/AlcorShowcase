# Get rid of the global stock table in `stockroom`

`stockroom/inventory.py` keeps all stock levels and the movement history in
module-level variables, and `stockroom/report.py` and `stockroom/cli.py` reach
into that module. That made sense for the one-shot CLI, but we now want to
run two warehouses in the same process (and test without `reset()` calls
everywhere), which the globals make impossible.

Please refactor to an `Inventory` class in `stockroom/inventory.py` that owns
its own state:

- `Inventory()` starts empty; methods `receive(sku, qty)`, `ship(sku, qty)`,
  `level(sku)`, `all_levels()` and `history()` behave exactly like today's
  module functions of the same names (same return values, same exceptions,
  including `InsufficientStock`);
- `Inventory.from_dict(data)` (a classmethod) and `to_dict()` replace
  `load_state(data)` / `dump_state()` with the same data format;
- `report.low_stock_report(inventory, threshold=5)` takes the inventory to
  report on as its first argument and returns the same text as today.

Update `cli.py` to use the class; the command line itself must not change at
all (same commands, output, exit codes and state file format). Update
`tests/test_inventory.py` to the new API, keeping what each test checks.

Done means: no module in `stockroom/` holds mutable state at module level
(no module-level dicts, lists or sets, no `global` statements), two
`Inventory` objects never affect each other, and everything else behaves as
before. Run the tests with `python3 -m unittest discover -s tests -t .`.
