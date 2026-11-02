"""Observation binding, freshness and browser-point translation of the click controller."""

from __future__ import annotations

import unittest

from alcor_click.control import AlcorClickController


class FakeProvider:
    def __init__(self) -> None:
        self.clicks: list[tuple[int, int]] = []
        self.keys: list[str] = []
        self.typed: list[str] = []
        self.focused: list[int] = []
        self.window = {
            "hwnd": 7,
            "pid": 42,
            "title": "Test",
            "bounds": {"x": 10, "y": 20, "width": 300, "height": 200},
            "cursor": {"x": 20, "y": 30},
            "coordinate_space": "windows_physical_screen_pixels",
            "exe": r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        }

    def observe(self, screenshot_path=None):
        value = dict(self.window)
        if screenshot_path is not None:
            value["screenshot"] = {"path": str(screenshot_path), "private": True}
        return value

    def click(self, expected, x: int, y: int):
        self.clicks.append((x, y))
        return dict(self.window)

    def key(self, expected, key: str):
        self.keys.append(key)
        return dict(self.window)

    def type_text(self, expected, text: str):
        self.typed.append(text)
        return dict(self.window)

    def focus(self, hwnd: int):
        self.focused.append(hwnd)
        return dict(self.window)


class ClickControlTests(unittest.TestCase):
    def test_observe_then_click_consumes_binding(self) -> None:
        fake = FakeProvider()
        now = [100.0]
        ctl = AlcorClickController(fake, monotonic=lambda: now[0], wall_time=lambda: 123.0)
        observed = ctl.get_window(screenshot=False)
        self.assertTrue(observed["ok"])
        receipt = ctl.click(50, 60, observed["observation_id"])
        self.assertTrue(receipt["ok"])
        self.assertEqual(fake.clicks, [(50, 60)])
        replay = ctl.click(50, 60, observed["observation_id"])
        self.assertEqual(replay["reason_code"], "fresh_observation_required")

    def test_focus_key_and_type_use_same_bounded_provider(self) -> None:
        fake = FakeProvider()
        ctl = AlcorClickController(fake)
        focus = ctl.focus(7)
        self.assertTrue(focus["ok"])
        self.assertEqual(fake.focused, [7])
        observed = ctl.get_window(screenshot=False)
        self.assertTrue(ctl.key("ctrl+tab", observed["observation_id"])["ok"])
        observed = ctl.get_window(screenshot=False)
        self.assertTrue(ctl.type_text("example.org", observed["observation_id"])["ok"])
        self.assertEqual(fake.keys, ["ctrl+tab"])
        self.assertEqual(fake.typed, ["example.org"])

    def test_browser_resolve_translates_then_clicks_same_binding(self) -> None:
        fake = FakeProvider()
        fake.window["bounds"] = {"x": -10, "y": -10, "width": 1020, "height": 820}
        ctl = AlcorClickController(fake)
        observed = ctl.get_window(screenshot=False)
        resolved = {
            "ok": True,
            "ref": "7",
            "center": {"x": 100, "y": 50},
            "metrics": {
                "innerWidth": 980,
                "innerHeight": 700,
                "outerWidth": 1000,
                "outerHeight": 800,
                "screenX": 0,
                "screenY": 0,
                "devicePixelRatio": 1,
                "visualViewport": {"scale": 1},
            },
        }
        point = ctl.browser_point(resolved, observed["observation_id"])
        self.assertTrue(point["ok"])
        self.assertEqual(point["point"], {"x": 110, "y": 140})
        receipt = ctl.click_browser(resolved, observed["observation_id"])
        self.assertTrue(receipt["ok"])
        self.assertEqual(fake.clicks, [(110, 140)])
        self.assertEqual(receipt["browser_ref"], "7")

    def test_browser_resolve_rejects_wrong_window_geometry(self) -> None:
        fake = FakeProvider()
        ctl = AlcorClickController(fake)
        observed = ctl.get_window(screenshot=False)
        resolved = {
            "ok": True,
            "ref": "9",
            "center": {"x": 20, "y": 20},
            "metrics": {
                "innerWidth": 280,
                "innerHeight": 150,
                "outerWidth": 300,
                "outerHeight": 200,
                "screenX": 5000,
                "screenY": 0,
                "devicePixelRatio": 1,
                "visualViewport": {"scale": 1},
            },
        }
        result = ctl.click_browser(resolved, observed["observation_id"])
        self.assertEqual(result["reason_code"], "browser_window_mismatch")
        self.assertEqual(fake.clicks, [])

    def test_stale_observation_never_reaches_provider(self) -> None:
        fake = FakeProvider()
        now = [5.0]
        ctl = AlcorClickController(fake, ttl_seconds=10, monotonic=lambda: now[0])
        observed = ctl.get_window(screenshot=False)
        now[0] = 16.0
        receipt = ctl.click(50, 60, observed["observation_id"])
        self.assertEqual(receipt["reason_code"], "observation_stale")
        self.assertEqual(fake.clicks, [])


if __name__ == "__main__":
    unittest.main()
