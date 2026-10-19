"""Room Finder routes through NavRouter (milestone 5).

Runs src/RoomFinder.py offline. The file expects the platform to inject a global
`c3`, so it is exec'd into a namespace whose `c3` is the fake below. The fake
serves the real seed data from data/, returns only the fields a fetch asks for in
its `include` (so a forgotten include fails here, not in Studio), and answers
`NavRouter.findRoute` by running the real src/NavRouter.js through
router_oracle.js. Only the completion client is scripted per test.

Run: python3 -I -m unittest discover -s pkgbc231600/test/py -t pkgbc231600/test/py
"""

import copy
import functools
import json
import subprocess
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE.parents[1]
ROOM_FINDER = PKG / "src" / "RoomFinder.py"
ORACLE = HERE / "router_oracle.js"
DATA = PKG / "data"
BUILDING = "grainger"
DIRECTIONS_ONLY = "Directions only"
WORDS_ONLY = "directions in words only"


def _seed(name):
    return json.loads((DATA / name / ("%s.json" % name)).read_text())


WAYPOINTS = _seed("Waypoint")
PLANS = json.loads((DATA / "AnnotatedPlan" / "AnnotatedPlan.json").read_text())
ROOM_NUMBERS = {w["roomNumber"] for w in WAYPOINTS if w["kind"] == "room"}


@functools.lru_cache(maxsize=None)
def _oracle_json(start, dest, step_free):
    out = subprocess.run(
        ["node", str(ORACLE), start, dest, "true" if step_free else "false"],
        check=True,
        capture_output=True,
        text=True,
    )
    return out.stdout


def real_route(start, dest, step_free):
    """NavRouter.findRoute's answer on the seed data, as plain JSON."""
    return json.loads(_oracle_json(start, dest, step_free))


# ---------------------------------------------------------------------------
# the fake platform
# ---------------------------------------------------------------------------


class Obj:
    """A C3-object stand-in: attribute access, and an unset field reads as None."""

    def __init__(self, fields):
        for k, v in fields.items():
            setattr(self, k, v)

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return None


def to_obj(value):
    if isinstance(value, dict):
        return Obj({k: to_obj(v) for k, v in value.items()})
    if isinstance(value, list):
        return [to_obj(v) for v in value]
    return value


def get_path(row, dotted):
    for key in dotted.split("."):
        if not isinstance(row, dict):
            return None
        row = row.get(key)
    return row


def project(row, include):
    """Only the fields named in `include` (plus id), as a C3 fetch returns them."""
    out = {"id": row.get("id")}
    for path in [p.strip() for p in include.split(",") if p.strip()]:
        head, _, rest = path.partition(".")
        if head not in row:
            continue
        if rest:
            out.setdefault(head, {})
            if isinstance(row[head], dict) and rest in row[head]:
                out[head][rest] = row[head][rest]
        else:
            out[head] = copy.deepcopy(row[head])
    return to_obj(out)


class Cond:
    def __init__(self, terms):
        self.terms = terms

    def and_(self, other):
        return Cond(self.terms + other.terms)

    def matches(self, row):
        return all(get_path(row, p) == v for p, v in self.terms)


class Filter:
    @staticmethod
    def eq(path, value):
        return Cond([(path, value)])


class Table:
    def __init__(self, rows):
        self.rows = rows

    def fetch(self, spec):
        rows = [r for r in self.rows if spec["filter"].matches(r)]
        if spec.get("limit", -1) > 0:
            rows = rows[: spec["limit"]]
        return Obj({"objs": [project(r, spec["include"]) for r in rows]})


class RouteQueryTable(Table):
    def make(self, spec):
        table = self

        class Row:
            def create(self_inner):
                row = dict(copy.deepcopy(spec), id="rq-%d" % (len(table.rows) + 1))
                table.rows.append(row)
                return Obj({"id": row["id"]})

        return Row()


class FakeClient:
    """Scripted completion client. Each script item is a reply (dict or str) or an Exception."""

    def __init__(self, *script):
        self.script = list(script)
        self.calls = []

    def completion(self, messages, options):
        self.calls.append({"messages": copy.deepcopy(messages), "options": dict(options)})
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        content = item if isinstance(item, str) else json.dumps(item)
        return {
            "choices": [{"message": {"content": content}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 30},
            "model": "fake-extractor",
        }


class FakeRouter:
    """Forwards to the real router; counts calls so tests can assert none were made."""

    def __init__(self, override=None):
        self.calls = []
        self.override = override

    def findRoute(self, start, dest, step_free):
        self.calls.append((start, dest, step_free))
        if self.override is not None:
            return to_obj(self.override)
        return to_obj(real_route(start, dest, bool(step_free)))


class FakeC3:
    def __init__(self, client, waypoints=WAYPOINTS, router=None):
        self.Filter = Filter
        self.Waypoint = Table(copy.deepcopy(waypoints))
        self.AnnotatedPlan = Table(copy.deepcopy(PLANS))
        self.BuildingFacts = Table([{"building": {"id": BUILDING}, "facts": "Grainger Hall."}])
        self.RouteQuery = RouteQueryTable([])
        self.NavRouter = router or FakeRouter()
        self.VisionRoute = Obj({"make": lambda spec: copy.deepcopy(spec)})
        self.client = client

        def for_config_key(_key):
            if isinstance(self.client, Exception):
                raise self.client
            return self.client

        def make_file(_url):
            raise OSError("no C3 Filesystem offline")

        self.GenaiCore = Obj(
            {"Llm": Obj({"Completion": Obj({"Client": Obj({"forConfigKey": for_config_key})})})}
        )
        self.FileSystem = Obj({"makeFile": make_file})


def load_room_finder(fake):
    ns = {"__name__": "RoomFinder", "c3": fake}
    exec(compile(ROOM_FINDER.read_text(), str(ROOM_FINDER), "exec"), ns)
    return ns


def extraction(start, dest, start_floor=None, step_free=False):
    return {
        "start": None if start is None else {"text": start, "floor": start_floor},
        "destination": None if dest is None else {"text": dest, "floor": None},
        "stepFree": step_free,
    }


def ask(reply_script, message="route me", allow_fallback=True, fake=None):
    """Run RoomFinder.findRoute with the given scripted model replies. Returns (result, fake)."""
    fake = fake or FakeC3(FakeClient(*reply_script))
    if fake.client is not None and not isinstance(fake.client, Exception) and reply_script:
        fake.client.script = list(reply_script)
    rf = load_room_finder(fake)
    return rf["findRoute"](None, BUILDING, message, allow_fallback), fake


def router_node_ids(nav):
    return [p["nodeId"] for leg in nav["legs"] for p in leg["points"]]


def drawn_node_ids(result):
    return [p["nodeId"] for seg in result["segments"] for p in seg["points"]]


# ---------------------------------------------------------------------------
# the tests
# ---------------------------------------------------------------------------


class RoutesAreTheRoutersRoute(unittest.TestCase):
    """Acceptance 1-3: a placed route whose node sequence is NavRouter.findRoute's."""

    def assert_same_as_router(self, result, start, dest, step_free):
        nav = real_route(start, dest, step_free)
        self.assertTrue(nav["found"], "seed router cannot route %s -> %s" % (start, dest))
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["drawable"])
        self.assertEqual(result["source"], "router")
        self.assertEqual(drawn_node_ids(result), router_node_ids(nav))
        self.assertEqual([p["nodeId"] for p in result["route"]], router_node_ids(nav))
        return nav

    def test_the_user_report_1310_to_1270(self):
        result, fake = ask(
            [extraction("1310", "1270", start_floor="1")],
            "I'm on floor one in 1310, how do i get to 1270",
        )
        self.assert_same_as_router(result, "n-f1-r1310", "n-f1-r1270", False)
        self.assertEqual(fake.NavRouter.calls, [("n-f1-r1310", "n-f1-r1270", False)])
        self.assertNotIn(DIRECTIONS_ONLY, json.dumps(result))
        self.assertNotIn(WORDS_ONLY, json.dumps(result))

    def test_1310_to_1170(self):
        result, _ = ask([extraction("1310", "1170")])
        self.assert_same_as_router(result, "n-f1-r1310", "n-f1-r1170", False)

    def test_west_entrance_to_3335_is_two_floors(self):
        result, _ = ask([extraction("the west entrance", "3335")], "from the west entrance to 3335")
        self.assert_same_as_router(result, "n-f1-entrance-w", "n-f3-r3335", False)
        self.assertEqual([s["floorKey"] for s in result["segments"]], ["1", "3"])
        self.assertEqual(result["route"][0]["role"], "start")
        self.assertEqual(result["route"][-1]["role"], "end")
        self.assertEqual(result["route"][-1]["roomNumber"], "3335")
        # The shaft ends floor 1's polyline and starts floor 3's.
        first, second = result["segments"]
        self.assertTrue(first["points"][-1]["isFloorChange"])
        self.assertEqual(first["points"][-1]["role"], "connector")
        self.assertEqual(second["points"][0]["role"], "connector")
        self.assertFalse(second["points"][0]["isFloorChange"])

    def test_cross_floor_room_to_room_step_free(self):
        result, fake = ask(
            [extraction("1310", "Room 3335", step_free=True)],
            "I'm in a wheelchair in 1310, need 3335",
        )
        self.assert_same_as_router(result, "n-f1-r1310", "n-f3-r3335", True)
        self.assertEqual(fake.NavRouter.calls[0][2], True)
        kinds = {p["kind"] for p in result["route"]}
        self.assertIn("elevator", kinds)
        self.assertNotIn("stairs", kinds)

    def test_geometry_and_steps_are_the_routers_untouched(self):
        result, _ = ask([extraction("the west entrance", "3335")])
        nav = real_route("n-f1-entrance-w", "n-f3-r3335", False)
        for seg, leg in zip(result["segments"], nav["legs"]):
            self.assertEqual((seg["imageWidth"], seg["imageHeight"]), (1980, 1530))
            self.assertEqual(
                [(p["imageX"], p["imageY"]) for p in seg["points"]],
                [(float(p["x"]), float(p["y"])) for p in leg["points"]],
            )
        flat = [s["text"] for leg in nav["legs"] for s in leg["steps"]]
        self.assertEqual(result["steps"], flat)
        self.assertEqual(len(result["stepFloorKeys"]), len(result["steps"]))
        covered = sorted(i for seg in result["segments"] for i in seg["stepIndexes"])
        self.assertEqual(covered, list(range(len(result["steps"]))))
        for seg in result["segments"]:
            for i in seg["stepIndexes"]:
                self.assertEqual(result["stepFloorKeys"][i], seg["floorKey"])
        self.assertAlmostEqual(result["totalSeconds"], nav["totalSeconds"])
        self.assertAlmostEqual(result["totalMeters"], nav["totalMeters"])

    def test_typed_room_forms_resolve_to_the_same_room(self):
        for typed in ["1270", "rm 1270", "Room 1270", "#1270", " 1270 ", "1270A", "1270a", "RM1270"]:
            with self.subTest(typed=typed):
                result, _ = ask([extraction("1310", typed)])
                self.assertEqual(result["status"], "ok")
                self.assertEqual(result["route"][-1]["nodeId"], "n-f1-r1270")

    def test_a_real_lettered_room_is_not_stripped(self):
        result, _ = ask([extraction("1310", "1210A")])
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["route"][-1]["roomNumber"], "1210A")


class UnknownOrMissingEndsAsk(unittest.TestCase):
    """Acceptance 4-5: never "Directions only", never an error, and no router call."""

    def assert_clarify_with_suggestions(self, typed):
        result, fake = ask([extraction("1310", typed)], "get to %s" % typed)
        self.assertEqual(result["status"], "clarify")
        self.assertFalse(result["drawable"])
        self.assertEqual(result["steps"], [])
        self.assertNotIn(DIRECTIONS_ONLY, json.dumps(result))
        self.assertGreaterEqual(len(result["suggestions"]), 1)
        self.assertLessEqual(len(result["suggestions"]), 3)
        for room in result["suggestions"]:
            self.assertIn(room, ROOM_NUMBERS)
            self.assertIn(room, result["question"])
        self.assertIn("I can't find room %s" % typed, result["question"])
        self.assertEqual(fake.NavRouter.calls, [])
        return result

    def test_unknown_room_9999(self):
        self.assert_clarify_with_suggestions("9999")

    def test_typo_1207_suggests_1270_first(self):
        result = self.assert_clarify_with_suggestions("1207")
        self.assertEqual(result["suggestions"][0], "1270")

    def test_unknown_start_room_is_named(self):
        result, fake = ask([extraction("1999", "1270")])
        self.assertEqual(result["status"], "clarify")
        self.assertIn("1999", result["question"])
        self.assertEqual(fake.NavRouter.calls, [])

    def test_unknown_place_name_offers_real_places(self):
        result, _ = ask([extraction("the north door", "1270")])
        self.assertEqual(result["status"], "clarify")
        self.assertIn("West Entrance", result["suggestions"])

    def test_missing_start_asks_where_they_are(self):
        result, fake = ask([extraction(None, "1270")], "how do I get to 1270")
        self.assertEqual(result["status"], "clarify")
        self.assertIn("Where are you starting from", result["question"])
        self.assertEqual(fake.NavRouter.calls, [])

    def test_missing_destination_asks_where_to(self):
        result, _ = ask([extraction("1310", None)], "I'm in 1310")
        self.assertEqual(result["status"], "clarify")
        self.assertIn("Where do you want to go", result["question"])

    def test_same_place_twice_does_not_route(self):
        result, fake = ask([extraction("1270", "rm 1270")])
        self.assertEqual(result["status"], "clarify")
        self.assertEqual(fake.NavRouter.calls, [])

    def test_a_landmark_on_every_floor_needs_a_floor(self):
        result, _ = ask([extraction("the west stairs", "3335")])
        self.assertEqual(result["status"], "clarify")
        self.assertIn("Which floor", result["question"])
        result, _ = ask([extraction("west stairs", "3335", start_floor="2")])
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["route"][0]["nodeId"], "n-f2-stair-w")

    def test_router_failure_is_an_error_with_its_reason(self):
        failed = {
            "found": False,
            "message": "No step-free route to 3335.",
            "legs": [],
            "totalSeconds": 0,
            "totalMeters": 0,
        }
        fake = FakeC3(FakeClient(), router=FakeRouter(override=failed))
        result, _ = ask([extraction("1310", "3335", step_free=True)], fake=fake)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["message"], "No step-free route to 3335.")
        self.assertNotIn(WORDS_ONLY, json.dumps(result))


class TheModelOnlyExtracts(unittest.TestCase):
    """Acceptance 7 and the narrow model contract."""

    def test_the_model_call_is_text_only_and_small(self):
        result, fake = ask([extraction("1310", "1270")], "I'm in 1310, how do I get to 1270")
        self.assertEqual(result["status"], "ok")
        (call,) = fake.client.calls
        self.assertLessEqual(call["options"]["max_tokens"], 500)
        for msg in call["messages"]:
            self.assertIsInstance(msg["content"], str, "no image blocks in the extraction call")
        self.assertEqual(call["messages"][-1]["content"], "I'm in 1310, how do I get to 1270")
        self.assertEqual(result["modelName"], "fake-extractor")
        self.assertEqual(result["promptTokens"], 120)

    def test_one_bad_answer_is_retried(self):
        result, fake = ask(["not json at all", extraction("1310", "1270")])
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["retried"])
        self.assertTrue(result["validationError"])
        self.assertEqual(len(fake.client.calls), 2)

    def test_wrong_shape_twice_is_an_error_without_fallback(self):
        result, fake = ask([{"from": "1310"}, "```json\n{\"start\": 5}\n```"], allow_fallback=False)
        self.assertEqual(result["status"], "error")
        self.assertTrue(result["message"])
        self.assertNotIn(WORDS_ONLY, json.dumps(result))
        self.assertEqual(fake.NavRouter.calls, [])

    def test_raising_client_is_an_error_without_fallback(self):
        result, fake = ask([RuntimeError("rate limited")], allow_fallback=False)
        self.assertEqual(result["status"], "error")
        self.assertIn("rate limited", result["message"])
        self.assertEqual(len(fake.client.calls), 1)

    def test_missing_client_is_an_error_without_fallback(self):
        fake = FakeC3(RuntimeError("no config"))
        result, _ = ask([], allow_fallback=False, fake=fake)
        self.assertEqual(result["status"], "error")
        self.assertIn("no config", result["message"])

    def test_a_pinned_router_answer_replays_when_the_model_is_down(self):
        message = "from the west entrance to 3335"
        live, fake = ask([extraction("the west entrance", "3335")], message)
        self.assertEqual(live["status"], "ok")
        (row,) = fake.RouteQuery.rows
        self.assertEqual(row["id"], live["queryId"])
        row["isPinned"] = True

        fake.client = FakeClient(RuntimeError("model down"))
        replay, _ = ask([], message, allow_fallback=True, fake=fake)
        self.assertEqual(replay["status"], "ok")
        self.assertEqual(replay["source"], "cache")
        self.assertTrue(replay["drawable"])
        self.assertEqual([s["floorKey"] for s in replay["segments"]], ["1", "3"])
        self.assertEqual(replay["route"][-1]["label"], "3335")
        self.assertEqual(replay["steps"], live["steps"])

        fake.client = FakeClient(RuntimeError("model down"))
        refused, _ = ask([], message, allow_fallback=False, fake=fake)
        self.assertEqual(refused["status"], "error")


class BuildingsWithoutAGraph(unittest.TestCase):
    def test_waypoints_with_no_nodes_use_the_vision_path(self):
        bare = [{k: v for k, v in w.items() if k != "sourceNode"} for w in WAYPOINTS]
        fake = FakeC3(FakeClient(), waypoints=bare)
        result, _ = ask([], fake=fake)
        # The vision path needs plan images; offline there are none, and it says so.
        self.assertEqual(result["status"], "error")
        self.assertIn("syncPlanImages", result["message"])
        self.assertEqual(fake.NavRouter.calls, [])
        self.assertEqual(fake.client.calls, [])


if __name__ == "__main__":
    unittest.main()
