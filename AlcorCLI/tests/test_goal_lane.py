"""A goal that outlives the agent's memory, and progress it cannot talk itself into.

Ported from the goal lane's own self-test. A scripted "world" stands in for the two probe commands:
the satisfaction check (exit zero means finished) and the progress probe (its output changes when
the world moves).
"""

from __future__ import annotations

import pytest

from alcorcli.goal import MANY, GoalStore


class World:
    """A tiny world the probes can read: a counter, and whether the goal is done."""

    def __init__(self):
        self.n = 0
        self.done = False

    def __call__(self, command: str) -> dict:
        if command == "SAT":
            return {"rc": 0 if self.done else 1, "out": "", "ran": True}
        if command == "PROG":
            return {"rc": 0, "out": str(self.n), "ran": True}
        if command == "BROKEN":
            return {"rc": None, "out": "", "ran": False}
        if command == "NEVER":
            return {"rc": 1, "out": "", "ran": True}  # a check that simply has not passed yet
        return {"rc": 0, "out": "", "ran": True}


@pytest.fixture()
def world():
    return World()


@pytest.fixture()
def store(tmp_path, policy, world, receipts):
    return GoalStore(tmp_path / "goals", policy, runner=world, receipts=receipts)


@pytest.mark.parametrize(
    "fields",
    [{"satisfaction": ""}, {"progress": ""}, {"objective": ""}],
    ids=["no-satisfaction", "no-progress", "no-objective"],
)
def test_a_goal_without_a_check_is_refused(store, fields):
    arguments = {"objective": "reach the thing", "satisfaction": "SAT", "progress": "PROG"}
    arguments.update(fields)
    objective = arguments.pop("objective")
    with pytest.raises(ValueError):
        store.create(objective, **arguments)


def test_a_stated_goal_is_told_to_decompose_before_it_is_pursued(store):
    goal = store.create("reach the thing", satisfaction="SAT", progress="PROG")
    assert store.decide(goal)["verdict"] == "decompose"


def test_the_whole_pursuit(store, world):
    goal = store.create("reach the thing", satisfaction="SAT", progress="PROG")
    goal = store.decompose(goal["id"], ["go east", "go north", "ask the operator"])
    assert goal["approach"] == "go east"

    world.n = 1
    out = store.attempt(goal["id"], lambda: setattr(world, "n", world.n + 1))
    assert out["moved"] is True
    assert (out["before"], out["after"]) == ("1", "2"), (
        "the reading is the probe's, not the agent's"
    )
    assert store.decide(store.load(goal["id"]))["verdict"] == "pursue"

    # The anti-loop: attempts that change nothing must stop being repeated.
    for _ in range(MANY):
        store.attempt(goal["id"], lambda: None)
    stalled = store.decide(store.load(goal["id"]))
    assert stalled["verdict"] == "change-approach", "told to CHANGE APPROACH, not to try harder"
    assert stalled["cells"]["approach_attempts"] == "many", "the count came from the record"

    goal = store.change_approach(goal["id"])
    assert "go east" in goal["approaches_tried"]
    assert goal["approach"] == "go north"
    assert goal["last_progress"] is None, "a new approach is not condemned by the old one's stall"

    # Exhaust the alternatives.
    store.change_approach(goal["id"])
    goal = store.change_approach(goal["id"])
    for _ in range(MANY):
        store.attempt(goal["id"], lambda: None)
    assert store.decide(store.load(goal["id"]))["verdict"] == "escalate"

    # Satisfaction is the only way to finish.
    assert store.finish(goal["id"])["ok"] is False
    world.done = True
    assert store.finish(goal["id"])["ok"] is True
    assert store.decide(store.load(goal["id"]))["verdict"] == "satisfied"

    # The whole pursuit survives a reload.
    reloaded = store.load(goal["id"])
    assert reloaded["approaches_tried"]
    assert len(reloaded["attempts"]) > MANY


def test_a_goal_whose_satisfaction_cannot_be_checked_halts(store):
    goal = store.create("unmeasurable", satisfaction="BROKEN", progress="PROG")
    assert store.decide(goal)["verdict"] == "halt"


def test_a_goal_whose_progress_cannot_be_measured_halts(store):
    goal = store.create("blind", satisfaction="NEVER", progress="BROKEN")
    goal = store.decompose(goal["id"], ["try"])
    assert store.decide(goal)["verdict"] == "halt"


def test_an_abandoned_goal_refuses_to_resume_on_its_own(store):
    goal = store.create("dropped", satisfaction="SAT", progress="PROG")
    goal = store.abandon(goal["id"], "the operator said stop")
    assert store.decide(goal)["verdict"] == "refuse"
