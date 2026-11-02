# Attribution

The bounded reflex executor in `alcor_computer/reflex_executor.py` adapts architectural ideas from
**shhivv/arc-cua** (https://github.com/shhivv/arc-cua), which is released under the MIT License.

The ideas are: planner-defined subtasks with literal inputs, a legal action space derived from the
current observation, planner-owned text, revalidation just before an effect, runtime-owned UI settling,
stall detection, and explicit `SUBTASK_COMPLETE` / `BLOCKED` / `NEEDS_AGENT` outcomes.

No source file, actuator, daemon or service from that project is included here. The implementation is
original and sends every effect through this package's own `AppController`, so no upstream license text
needs to ship with the code.
