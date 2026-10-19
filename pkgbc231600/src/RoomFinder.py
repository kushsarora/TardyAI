import enum
import io
import json
import re
import time
from dataclasses import dataclass
from typing import Optional

_COMPLETION_CONFIG_KEY = "default-completions"
# Generous, because the model spends output tokens reasoning about the images before it answers;
# observed answers run 1000-1500 tokens. Too low a ceiling truncates the JSON mid-object, which
# costs a retry and reads as a model failure.
_MAX_OUTPUT_TOKENS = 3000
_MAX_ROUTE_LABELS = 40
_HTTP_TIMEOUT_SECONDS = 30
_UI_SERVICE_PORT = 9000

_SYSTEM_PROMPT = """You are an indoor wayfinding assistant for a single building. You are given a
short page of building facts and one annotated floor plan image per mapped floor.

Every navigable point on each plan is drawn as a coloured dot with its LABEL printed beside it.
The labels are the only vocabulary you may use.

LABEL GRAMMAR
- <floor>-W<n>   a corridor or hallway junction, e.g. "2-W4". Numbered roughly west to east.
- <number>       a room, e.g. "2210". The first digit is the floor.
- S<n>           a stairwell, e.g. "S1".
- E<n>           an elevator, e.g. "E3".
- ENT-<compass>  a building entrance, e.g. "ENT-W".
- <floor>-WC     the restrooms on that floor.

HARD RULES
1. Output ONLY labels that you can actually read printed on one of the images. Never invent,
   extrapolate or guess a label. If you are unsure a label exists, do not use it.
2. Never output pixel coordinates, distances in metres, or compass bearings as route points. The
   route is a list of labels and nothing else.
3. Build the route as an ordered list, starting at the user's current position and ending at their
   destination. Walk along corridor labels between rooms - do not jump from one room straight to
   another unless their dots are adjacent on the plan.
4. CHANGING FLOORS: a stair or elevator label (S<n> / E<n>) is printed at the same shaft on every
   floor it serves. Emit that shaft label ONCE at the point where the route leaves a floor. The
   label immediately after it must be on the destination floor. Example of a correct floor change:
   ["2210", "2-W4", "2-W3", "S1", "1-W8", "1170"].
5. The only legal way to move between floors is through a shaft label. Two consecutive labels must
   otherwise be on the same floor.
6. Keep the route to at most 12 labels. Prefer the shaft nearest to both ends of the trip.
7. If the user mentions a wheelchair, crutches, a stroller, luggage, or asks to avoid stairs, use an
   elevator (E<n>) and never a stairwell.
8. If you cannot tell where the user is starting from, or which room they mean, or the floor they
   want is not among the images, answer with status "clarify" and one short question. A clarifying
   question is always better than a guessed route.

OUTPUT
Reply with a single JSON object and no prose or markdown fences:

{
  "status": "ok" | "clarify",
  "route": ["<label>", "<label>", ...],
  "steps": [{"floor": "<floor key>", "text": "<one short imperative instruction>"}],
  "question": "<only when status is clarify, otherwise null>"
}

For status "ok": "route" has at least two labels, and "steps" describes the journey in 3 to 6
entries, in order. Each step's "floor" is the floor key that step is walked on.

Steps are written for a person who cannot see the plan, so write one step per LEG of the journey -
setting off, each change of direction or corridor, each floor change, and arriving - and NOT one
step per corridor label. "Head east along the main corridor to the elevators" is one step even if
the route passes four hallway labels on the way. Name the room or place, mention the stair or
elevator by label, and say which way a floor change goes ("down to floor 1"). Do not number the
steps and do not pad them.

For status "clarify": "route" and "steps" are empty arrays and "question" is a single sentence."""

_RETRY_PREFIX = """Your previous answer was rejected by the building database.

Reason: %s

Correct it and reply with the same JSON object. Re-read the labels printed on the images and use
only labels you can see there. Remember that the only legal way to change floors is a stair or
elevator label that is printed at the same shaft on both floors. If you cannot produce a valid
route, answer with status "clarify" and a question instead of guessing."""

_CLARIFY_FALLBACK_QUESTION = (
    "Which floor are you on right now, and which room or place are you trying to reach?"
)


# ---------------------------------------------------------------------------
# small shared helpers
# ---------------------------------------------------------------------------


def _normalizedMessage(text):
    return " ".join(str(text or "").lower().split())


def _normalizeLabel(raw):
    """Clean one label as the model wrote it. Returns "" when nothing usable is left."""
    if raw is None:
        return ""
    s = str(raw)
    s = re.sub(r"\([^)]*\)", " ", s)
    s = re.sub(r"[\"'`*\[\]]", " ", s)
    s = re.sub(r"^\s*(?:floor|level|fl)\s*[0-9A-Za-z]+\s+", " ", s, flags=re.IGNORECASE)
    s = re.sub(r"\s*-\s*", "-", s.strip())
    s = re.sub(r"\s+", "", s)
    s = s.strip(".,;:-")
    return s.upper()


def _labelAlternatives(label):
    """Other spellings worth trying when `label` is not in the vocabulary."""
    out = []
    m = re.match(r"^([SE])-(\d+)$", label)
    if m:
        out.append(m.group(1) + m.group(2))
    m = re.match(r"^(.+?)-F?(?:LOOR)?\d+$", label)
    if m:
        out.append(m.group(1))
    m = re.match(r"^F(\w+)-(W.*)$", label)
    if m:
        out.append(m.group(1) + "-" + m.group(2))
    m = re.match(r"^(\w+)-W-?C\d*$", label)
    if m:
        out.append(m.group(1) + "-WC")
    m = re.match(r"^ENT-?([A-Z]+)$", label)
    if m:
        out.append("ENT-" + m.group(1)[:1])
    m = re.match(r"^(\d{3,4})[A-Z]$", label)
    if m:
        out.append(m.group(1))
    return [o for o in out if o and o != label]


def _normalizeFloorKey(value, knownFloorKeys):
    if value is None:
        return None
    s = str(value).strip()
    if s in knownFloorKeys:
        return s
    m = re.search(r"(\d+|[A-Za-z])", s)
    if m and m.group(1) in knownFloorKeys:
        return m.group(1)
    return None


def _defaultUiServiceBaseUrl():
    """Derive the pod-local UI service base URL from the default file system mount.

    The mount looks like `<scheme>://<bucket>/<tenant>/<tag>/fs/`, and the UI service for that
    tenant and tag is served from `http://localhost:<port>/<tenant>/<tag>/uiservice`.
    """
    mount = str(c3.FileSystem.mounts()["/"] or "")
    body = re.sub(r"^[A-Za-z0-9+.\-]+://", "", mount)
    parts = [p for p in body.split("/") if p]
    if len(parts) < 3:
        raise ValueError(
            "Cannot derive the UI service base URL from mount '%s'. "
            "Pass uiServiceBaseUrl explicitly." % mount
        )
    return "http://localhost:%d/%s/%s/uiservice" % (_UI_SERVICE_PORT, parts[1], parts[2])


# ---------------------------------------------------------------------------
# loading the building's vocabulary, plans and facts
# ---------------------------------------------------------------------------


def _loadWaypoints(buildingId):
    """label -> {floorKey -> point dict}. A shaft label has one entry per floor it serves."""
    res = c3.Waypoint.fetch(
        {
            "filter": c3.Filter.eq("building.id", buildingId),
            "include": "label, floorKey, floorLevel, kind, imageX, imageY, connectorKey, "
            "roomNumber, name, searchAliases, sourceNode",
            "order": "floorLevel, label",
            "limit": -1,
        }
    )
    byLabel = {}
    for w in res.objs or []:
        byLabel.setdefault(w.label, {})[w.floorKey] = {
            "label": w.label,
            "floorKey": w.floorKey,
            "floorLevel": int(w.floorLevel or 0),
            "kind": w.kind,
            "imageX": float(w.imageX or 0.0),
            "imageY": float(w.imageY or 0.0),
            "connectorKey": w.connectorKey,
            "roomNumber": w.roomNumber,
            "name": w.name,
            "searchAliases": [str(a) for a in (w.searchAliases or []) if a],
            "sourceNode": w.sourceNode,
        }
    return byLabel


def _loadPlans(buildingId):
    res = c3.AnnotatedPlan.fetch(
        {
            "filter": c3.Filter.eq("building.id", buildingId),
            "include": "floor.id, floorKey, floorLevel, floorName, publicUrl, planImageUrl, "
            "c3FileUrl, imageWidth, imageHeight, annotatedWidth, annotatedHeight, waypointCount, "
            "syncedAt",
            "order": "floorLevel",
            "limit": -1,
        }
    )
    plans = []
    for p in res.objs or []:
        plans.append(
            {
                "id": p.id,
                "floorId": p.floor.id if p.floor is not None else None,
                "floorKey": p.floorKey,
                "floorLevel": int(p.floorLevel or 0),
                "floorName": p.floorName,
                "publicUrl": p.publicUrl,
                "planImageUrl": p.planImageUrl,
                "c3FileUrl": p.c3FileUrl,
                "imageWidth": int(p.imageWidth or 0),
                "imageHeight": int(p.imageHeight or 0),
                "waypointCount": int(p.waypointCount or 0),
                "syncedAt": p.syncedAt,
            }
        )
    return plans


def _loadFacts(buildingId):
    res = c3.BuildingFacts.fetch(
        {
            "filter": c3.Filter.eq("building.id", buildingId),
            "include": "facts, demoRoutes",
            "limit": 1,
        }
    )
    objs = res.objs or []
    return objs[0] if objs else None


def _encodedPlanImage(plan):
    """Read one plan out of the C3 Filesystem as a `data:` URL, or None if it is not there."""
    try:
        f = c3.FileSystem.makeFile(plan["c3FileUrl"])
        if not f.exists():
            return None
        return c3.GenaiCore.ImageUtil.encodedImageFromPath(f.url, "image/png")
    except Exception:
        return None


# ---------------------------------------------------------------------------
# prompt assembly
# ---------------------------------------------------------------------------


def _buildMessages(facts, plans, userMessage):
    """System prompt, then the cached prefix (facts + every floor image), then the request.

    The `cache_control` breakpoint sits on the final image block, so the provider caches
    everything up to and including the images. That prefix is byte identical on every request for
    a building; only the trailing request text changes.
    """
    content = [{"type": "text", "text": "BUILDING FACTS\n\n" + str(facts or "").strip()}]
    for i, plan in enumerate(plans):
        content.append(
            {
                "type": "text",
                "text": "ANNOTATED FLOOR PLAN - floor %s (%s), %d labelled waypoints"
                % (plan["floorKey"], plan["floorName"] or "", plan["waypointCount"]),
            }
        )
        block = {"type": "image_url", "image_url": {"url": plan["dataUrl"]}}
        if i == len(plans) - 1:
            block["cache_control"] = {"type": "ephemeral"}
        content.append(block)
    content.append({"type": "text", "text": "USER REQUEST\n\n" + str(userMessage)})
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": content},
    ]


# ---------------------------------------------------------------------------
# response reading
# ---------------------------------------------------------------------------


def _responseContent(response):
    try:
        return response["choices"][0]["message"]["content"]
    except Exception:
        pass
    try:
        return response.choices[0].message.content
    except Exception:
        return None


def _wasTruncated(response):
    """True when the model ran into the output ceiling and its JSON is therefore incomplete."""
    for getter in (
        lambda: response["choices"][0]["finish_reason"],
        lambda: response.choices[0].finish_reason,
        lambda: response["choices"][0]["stop_reason"],
    ):
        try:
            reason = getter()
        except Exception:
            continue
        if reason and str(reason).lower() in ("length", "max_tokens"):
            return True
    return False


def _parseJsonContent(content):
    if content is None:
        return None
    if isinstance(content, dict):
        return content
    s = str(content).strip()
    if s.startswith("```"):
        s = re.sub(r"^```[A-Za-z]*\s*", "", s)
        s = re.sub(r"\s*```$", "", s)
    try:
        parsed = json.loads(s)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        pass
    start, end = s.find("{"), s.rfind("}")
    if start >= 0 and end > start:
        try:
            parsed = json.loads(s[start : end + 1])
            return parsed if isinstance(parsed, dict) else None
        except Exception:
            return None
    return None


def _usageValue(usage, names):
    for name in names:
        value = None
        try:
            value = usage[name]
        except Exception:
            try:
                value = getattr(usage, name)
            except Exception:
                value = None
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return int(value)
        if isinstance(value, dict):
            for inner in ("cached_tokens", "cache_read_input_tokens", "cached_read"):
                innerValue = value.get(inner)
                if isinstance(innerValue, (int, float)) and not isinstance(innerValue, bool):
                    return int(innerValue)
    return 0


def _addUsage(total, response):
    usage = None
    try:
        usage = response["usage"]
    except Exception:
        try:
            usage = response.usage
        except Exception:
            usage = None
    if usage is None:
        return total
    total["promptTokens"] += _usageValue(usage, ("prompt_tokens", "promptTokens", "input_tokens"))
    total["completionTokens"] += _usageValue(
        usage, ("completion_tokens", "completionTokens", "output_tokens")
    )
    total["cachedTokens"] += _usageValue(
        usage,
        (
            "cached_read",
            "cache_read_input_tokens",
            "cached_tokens",
            "prompt_tokens_details",
            "promptTokensDetails",
        ),
    )
    return total


def _modelName(response, client):
    for name in ("model", "modelName"):
        try:
            value = response[name]
        except Exception:
            try:
                value = getattr(response, name)
            except Exception:
                value = None
        if value:
            return str(value)
    try:
        return str(client.model.model)
    except Exception:
        return None


def _splitSteps(raw, knownFloorKeys):
    steps, floorKeys = [], []
    for item in raw or []:
        if isinstance(item, dict):
            text = item.get("text") or item.get("step") or item.get("instruction")
            if text is None:
                continue
            steps.append(str(text).strip())
            floorKeys.append(
                _normalizeFloorKey(item.get("floor") or item.get("floorKey"), knownFloorKeys)
            )
        else:
            text = str(item or "").strip()
            if text:
                steps.append(text)
                floorKeys.append(None)
    return steps, floorKeys


# ---------------------------------------------------------------------------
# validation and resolution - the part that keeps a line off a wall
# ---------------------------------------------------------------------------


def _resolveLabel(byLabel, label):
    if label in byLabel:
        return label, byLabel[label]
    for alt in _labelAlternatives(label):
        if alt in byLabel:
            return alt, byLabel[alt]
    return None, None


def _resolveRoute(byLabel, rawLabels):
    """Turn the model's labels into placed points, or explain why they are not acceptable.

    Returns `(points, error)`. Exactly one of the two is set. `points` is the journey expanded so
    that a shaft used for a floor change appears twice - once on the floor it is entered from and
    once on the floor it arrives at - which is what lets each floor's polyline start somewhere.
    """
    labels = []
    for raw in rawLabels or []:
        label = _normalizeLabel(raw)
        if not label:
            continue
        if labels and labels[-1] == label:
            continue
        labels.append(label)

    if len(labels) < 2:
        return None, (
            "A route needs at least two different waypoint labels; the answer had %d."
            % len(labels)
        )
    if len(labels) > _MAX_ROUTE_LABELS:
        return None, (
            "The route had %d labels, which is more than the %d allowed. Give a direct route."
            % (len(labels), _MAX_ROUTE_LABELS)
        )

    resolved = []
    for label in labels:
        canonical, floors = _resolveLabel(byLabel, label)
        if canonical is None:
            return None, (
                'Unknown waypoint label "%s" - it is not printed on any of the floor plans. '
                "Use only labels you can read on the images." % label
            )
        resolved.append((canonical, floors))

    # Choose a floor for each position. Labels that exist on exactly one floor are anchors;
    # shaft labels take the floor of whichever neighbour is already decided.
    chosen = [None] * len(resolved)
    for i, (_canonical, floors) in enumerate(resolved):
        if len(floors) == 1:
            chosen[i] = next(iter(floors))
    for _pass in range(len(resolved)):
        changed = False
        for i, (_canonical, floors) in enumerate(resolved):
            if chosen[i] is not None:
                continue
            for j in (i - 1, i + 1):
                if 0 <= j < len(resolved) and chosen[j] in floors:
                    chosen[i] = chosen[j]
                    changed = True
                    break
        if not changed:
            break
    for i, (_canonical, floors) in enumerate(resolved):
        if chosen[i] is None:
            chosen[i] = sorted(floors.keys(), key=lambda k: floors[k]["floorLevel"])[0]

    # Every transition is either within one floor, or through a shaft printed on both floors.
    for i in range(len(resolved) - 1):
        aLabel, aFloors = resolved[i]
        bLabel, bFloors = resolved[i + 1]
        aKey, bKey = chosen[i], chosen[i + 1]
        if aKey == bKey:
            continue
        aIsShaft = bool(aFloors[aKey].get("connectorKey")) and bKey in aFloors
        bIsShaft = bool(bFloors[bKey].get("connectorKey")) and aKey in bFloors
        if aIsShaft or bIsShaft:
            continue
        return None, (
            'Illegal floor change from "%s" (floor %s) to "%s" (floor %s): neither is a stair or '
            "elevator printed on both floors. Change floors only through a shaft label such as "
            "S1, E1, E2 or E3." % (aLabel, aKey, bLabel, bKey)
        )

    points = []
    for i, (_canonical, floors) in enumerate(resolved):
        points.append(dict(floors[chosen[i]]))
        if i + 1 >= len(resolved):
            continue
        nextKey = chosen[i + 1]
        if nextKey == chosen[i]:
            continue
        if nextKey in floors:
            points.append(dict(floors[nextKey]))
        elif chosen[i] in resolved[i + 1][1]:
            points.append(dict(resolved[i + 1][1][chosen[i]]))

    for point in points:
        point["isFloorChange"] = False
        point["role"] = "via"
    for i in range(len(points) - 1):
        if points[i]["floorKey"] == points[i + 1]["floorKey"]:
            continue
        points[i]["isFloorChange"] = True
        points[i]["role"] = "connector"
        points[i + 1]["role"] = "connector"
    points[0]["role"] = "start"
    points[-1]["role"] = "end"
    return points, None


def _stepIndexesForRuns(runs, stepFloorKeys, stepCount):
    """Which `VisionRoute#steps` indices belong to each floor visit."""
    result = [[] for _ in runs]
    if any(stepFloorKeys):
        byFloor = {}
        for i, floorKey in enumerate(stepFloorKeys):
            if floorKey:
                byFloor.setdefault(floorKey, []).append(i)
        visits = {}
        for ri, run in enumerate(runs):
            visits.setdefault(run["floorKey"], []).append(ri)
        for floorKey, indexes in byFloor.items():
            targets = visits.get(floorKey) or []
            total = len(targets)
            for k, ri in enumerate(targets):
                lo = (len(indexes) * k) // total
                hi = (len(indexes) * (k + 1)) // total
                result[ri] = indexes[lo:hi]
        if any(result):
            return result
    total = len(runs)
    if total and stepCount:
        for ri in range(total):
            lo = (stepCount * ri) // total
            hi = (stepCount * (ri + 1)) // total
            result[ri] = list(range(lo, hi))
    return result


def _buildSegments(points, plansByFloor, stepFloorKeys, stepCount):
    runs = []
    for point in points:
        if runs and runs[-1]["floorKey"] == point["floorKey"]:
            runs[-1]["points"].append(point)
        else:
            runs.append({"floorKey": point["floorKey"], "points": [point]})
    stepIndexes = _stepIndexesForRuns(runs, stepFloorKeys, stepCount)
    segments = []
    for ri, run in enumerate(runs):
        plan = plansByFloor.get(run["floorKey"]) or {}
        segments.append(
            {
                "floorKey": run["floorKey"],
                "floorLevel": run["points"][0]["floorLevel"],
                "floorName": plan.get("floorName"),
                "planImageUrl": plan.get("planImageUrl"),
                "annotatedUrl": plan.get("publicUrl"),
                "imageWidth": plan.get("imageWidth") or 0,
                "imageHeight": plan.get("imageHeight") or 0,
                "points": [_routeWaypoint(p) for p in run["points"]],
                "stepIndexes": stepIndexes[ri],
            }
        )
    return segments


def _routeWaypoint(point):
    return {
        "label": point["label"],
        "floorKey": point["floorKey"],
        "floorLevel": point["floorLevel"],
        "imageX": point["imageX"],
        "imageY": point["imageY"],
        "kind": point["kind"],
        "name": point.get("name"),
        "roomNumber": point.get("roomNumber"),
        "isFloorChange": bool(point.get("isFloorChange")),
        "role": point.get("role") or "via",
        "nodeId": point.get("nodeId"),
    }


# ---------------------------------------------------------------------------
# result construction and logging
# ---------------------------------------------------------------------------


def _visionRoute(status, startedAt, **kwargs):
    spec = {
        "status": status,
        "drawable": False,
        "route": [],
        "segments": [],
        "steps": [],
        "stepFloorKeys": [],
        "rawLabels": [],
        "retried": False,
        "source": "llm",
        "latencyMs": int(round((time.time() - startedAt) * 1000.0)),
        "promptTokens": 0,
        "cachedTokens": 0,
        "completionTokens": 0,
    }
    spec.update(kwargs)
    return spec


def _finish(status, startedAt, buildingId, userMessage, normalized, replayLabels=None, **kwargs):
    """Build the result, log it, and stamp the log row's id onto the result.

    `replayLabels`, when given, is what the log row stores as its route labels instead of the
    labels of every drawn point - see `_visionRouteFromNavRoute` for why a router answer needs it.
    """
    spec = _visionRoute(status, startedAt, **kwargs)
    spec["queryId"] = _logQuery(buildingId, userMessage, normalized, spec, replayLabels)
    return c3.VisionRoute.make(spec)


def _stepFloorKeysFromSegments(segments, stepCount):
    """A floor key per step, derived from which segment each step index landed in."""
    keys = [None] * stepCount
    for segment in segments:
        for index in segment.get("stepIndexes") or []:
            if 0 <= index < stepCount:
                keys[index] = segment["floorKey"]
    return keys


def _logQuery(buildingId, message, normalized, spec, routeLabels=None):
    """Persist the request. A logging failure must never turn a good route into an error."""
    if routeLabels is None:
        routeLabels = [p["label"] for p in spec.get("route") or []]
    try:
        row = c3.RouteQuery.make(
            {
                "building": {"id": buildingId},
                "userMessage": str(message),
                "normalizedMessage": normalized,
                "status": spec.get("status"),
                "routeLabels": list(routeLabels),
                "steps": spec.get("steps") or [],
                "question": spec.get("question"),
                "drawable": bool(spec.get("drawable")),
                "retried": bool(spec.get("retried")),
                "validationError": spec.get("validationError"),
                "latencyMs": spec.get("latencyMs"),
                "modelName": spec.get("modelName"),
                "promptTokens": spec.get("promptTokens"),
                "cachedTokens": spec.get("cachedTokens"),
                "completionTokens": spec.get("completionTokens"),
                "isPinned": False,
            }
        ).create()
        return row.id
    except Exception:
        return None


def _pinnedAnswer(buildingId, normalized, byLabel, plansByFloor, startedAt, note):
    """Replay a curated answer for this exact message, when there is one."""
    if not normalized:
        return None
    try:
        res = c3.RouteQuery.fetch(
            {
                "filter": c3.Filter.eq("building.id", buildingId)
                .and_(c3.Filter.eq("normalizedMessage", normalized))
                .and_(c3.Filter.eq("isPinned", True))
                .and_(c3.Filter.eq("status", "ok")),
                "include": "routeLabels, steps, modelName",
                "limit": 1,
            }
        )
        rows = res.objs or []
    except Exception:
        return None
    if not rows:
        return None
    row = rows[0]
    labels = list(row.routeLabels or [])
    steps = list(row.steps or [])
    points, error = _resolveRoute(byLabel, labels)
    if error:
        return None
    segments = _buildSegments(points, plansByFloor, [None] * len(steps), len(steps))
    return c3.VisionRoute.make(
        _visionRoute(
            "ok",
            startedAt,
            message=note,
            drawable=True,
            route=[_routeWaypoint(p) for p in points],
            segments=segments,
            steps=steps,
            stepFloorKeys=_stepFloorKeysFromSegments(segments, len(steps)),
            rawLabels=labels,
            source="cache",
            modelName=row.modelName,
            queryId=row.id,
        )
    )


# ---------------------------------------------------------------------------
# the vision-model path, kept for buildings with no nav graph
# ---------------------------------------------------------------------------


def _findRouteByVision(cls, buildingId, message, allowFallback):
    """The original vision-model route finder: the model reads the annotated plans and picks
    every waypoint label. Used only for a building whose waypoints have no nav graph behind them
    (no `Waypoint.sourceNode`), because there `NavRouter` has nothing to search."""
    startedAt = time.time()
    allowFallback = True if allowFallback is None else bool(allowFallback)
    normalized = _normalizedMessage(message)

    byLabel = _loadWaypoints(buildingId)
    plans = _loadPlans(buildingId)
    facts = _loadFacts(buildingId)
    plansByFloor = {p["floorKey"]: p for p in plans}

    # Setup problems are reported but not logged - they are not route attempts.
    missing = []
    if not byLabel:
        missing.append("no waypoints are loaded")
    if not plans:
        missing.append("no annotated floor plans are loaded")
    if facts is None:
        missing.append("the building facts are missing")
    if missing:
        return c3.VisionRoute.make(
            _visionRoute(
                "error",
                startedAt,
                message="Building '%s' is not set up for the route finder: %s."
                % (buildingId, ", ".join(missing)),
            )
        )

    usablePlans, unavailable = [], []
    for plan in plans:
        dataUrl = _encodedPlanImage(plan)
        if dataUrl:
            usablePlans.append(dict(plan, dataUrl=dataUrl))
        else:
            unavailable.append(plan["floorKey"])
    if not usablePlans:
        return c3.VisionRoute.make(
            _visionRoute(
                "error",
                startedAt,
                message="No floor plan images are available to the server yet. Run "
                "RoomFinder.syncPlanImages('%s') once to copy them into the C3 Filesystem."
                % buildingId,
            )
        )
    note = None
    if unavailable:
        note = "Floor %s is not available to the route finder, so it was left out." % ", ".join(
            unavailable
        )

    def fallback(reason):
        if not allowFallback:
            return None
        return _pinnedAnswer(buildingId, normalized, byLabel, plansByFloor, startedAt, reason)

    try:
        client = c3.GenaiCore.Llm.Completion.Client.forConfigKey(_COMPLETION_CONFIG_KEY)
        clientError = None
    except Exception as error:
        client = None
        clientError = str(error)
    if client is None:
        cached = fallback("Showing a saved answer - the routing model is unavailable.")
        if cached is not None:
            return cached
        return _finish(
            "error",
            startedAt,
            buildingId,
            message,
            normalized,
            message="The routing model is not available: %s"
            % (clientError or "no completion client is configured"),
        )

    knownFloorKeys = set(plansByFloor.keys())
    messages = _buildMessages(facts.facts, usablePlans, message)
    options = {"returnJson": True, "max_tokens": _MAX_OUTPUT_TOKENS}
    usage = {"promptTokens": 0, "cachedTokens": 0, "completionTokens": 0}
    modelName = None
    retried = False
    validationError = None

    for attempt in (1, 2):
        try:
            response = client.completion(messages=messages, options=options)
        except Exception as error:
            cached = fallback("Showing a saved answer - the routing model could not be reached.")
            if cached is not None:
                return cached
            return _finish(
                "error",
                startedAt,
                buildingId,
                message,
                normalized,
                message="The routing model could not be reached. %s" % error,
                retried=retried,
                validationError=validationError,
                modelName=modelName,
                **usage
            )

        rawContent = _responseContent(response)
        usage = _addUsage(usage, response)
        modelName = _modelName(response, client) or modelName
        parsed = _parseJsonContent(rawContent)

        failure = None
        points = None
        steps, stepFloorKeys, rawLabels = [], [], []

        if parsed is None:
            failure = (
                "Your answer was cut off before the JSON was complete because it was too long. "
                "Reply again with the same JSON object but fewer and shorter steps, and no "
                "reasoning outside the JSON."
                if _wasTruncated(response)
                else "The answer was not a single JSON object."
            )
        else:
            modelStatus = str(parsed.get("status") or "ok").strip().lower()
            rawLabels = [str(x) for x in (parsed.get("route") or []) if x is not None]
            steps, stepFloorKeys = _splitSteps(parsed.get("steps"), knownFloorKeys)
            if modelStatus == "clarify":
                return _finish(
                    "clarify",
                    startedAt,
                    buildingId,
                    message,
                    normalized,
                    question=str(parsed.get("question") or _CLARIFY_FALLBACK_QUESTION).strip(),
                    message=note,
                    rawLabels=rawLabels,
                    retried=retried,
                    validationError=validationError,
                    modelName=modelName,
                    **usage
                )
            if modelStatus != "ok":
                failure = 'Unexpected status "%s"; use "ok" or "clarify".' % modelStatus
            else:
                points, failure = _resolveRoute(byLabel, rawLabels)

        if failure is None:
            segments = _buildSegments(points, plansByFloor, stepFloorKeys, len(steps))
            return _finish(
                "ok",
                startedAt,
                buildingId,
                message,
                normalized,
                message=note,
                drawable=True,
                route=[_routeWaypoint(p) for p in points],
                segments=segments,
                steps=steps,
                stepFloorKeys=stepFloorKeys,
                rawLabels=rawLabels,
                retried=retried,
                validationError=validationError,
                modelName=modelName,
                **usage
            )

        validationError = failure
        if attempt == 1:
            retried = True
            messages = messages + [
                {"role": "assistant", "content": str(rawContent or "")},
                {"role": "user", "content": _RETRY_PREFIX % failure},
            ]
            continue

        # Second failure: keep whatever instructions the model wrote, and draw nothing.
        if steps:
            return _finish(
                "ok",
                startedAt,
                buildingId,
                message,
                normalized,
                message="I could not place this route on the plans, so here are the directions "
                "in words only.",
                drawable=False,
                steps=steps,
                stepFloorKeys=stepFloorKeys,
                rawLabels=rawLabels,
                retried=True,
                validationError=failure,
                modelName=modelName,
                **usage
            )

        cached = fallback("Showing a saved answer - the live one did not check out.")
        if cached is not None:
            return cached
        return _finish(
            "error",
            startedAt,
            buildingId,
            message,
            normalized,
            message="I could not work out a route I trust for that. Try naming the room number "
            "you are near and the room you want.",
            rawLabels=rawLabels,
            retried=True,
            validationError=failure,
            modelName=modelName,
            **usage
        )


# ---------------------------------------------------------------------------
# routing through NavRouter - the model reads the sentence, the graph picks the path
# ---------------------------------------------------------------------------

# Small, text only: the extraction answer is a few dozen tokens of JSON.
_EXTRACTION_MAX_TOKENS = 300
_MAX_SUGGESTIONS = 3
_ROUTER_SOURCE = "router"

_EXTRACTION_PROMPT = """You read one message from a person inside a building and pull out where
they are and where they want to go. You do not plan the route and you never name a path.

Reply with a single JSON object and no prose or markdown fences:

{
  "start": {"text": "<their words for where they are>", "floor": "<floor digits>" or null} or null,
  "destination": {"text": "<their words for where they are going>", "floor": "<floor digits>" or null} or null,
  "stepFree": true | false
}

RULES
1. "text" is the room number or place name as the person wrote it, e.g. "1270", "rm 3335",
   "the west entrance", "elevator c". Never correct, complete or guess a room number.
2. "floor" only when the person says it for that place: "floor one", "level 2" and "second floor"
   become "1", "2", "2". Otherwise null. Never infer it from a room number.
3. "start" is null when the message does not say where they are now.
4. "destination" is null when the message does not say where they want to go.
5. "stepFree" is true when they mention a wheelchair, crutches, a stroller, luggage, an injury, or
   avoiding stairs. Otherwise false."""

_EXTRACTION_RETRY = """Your previous answer could not be used.

Reason: %s

Reply again with only the JSON object described in the instructions."""

_ASK_FOR_START = "Where are you starting from? Tell me a room number or an entrance."
_ASK_FOR_DESTINATION = "Where do you want to go? Tell me a room number or a place."

# Waypoint kinds a person can name as a place. Hallway junctions ("1-W5") are plan labels, not
# places anyone types, so they never match a request.
_NAMEABLE_KINDS = frozenset(["room", "entrance", "stairs", "elevator", "restroom"])
# Offered, in this order, when a non-numeric place is not found.
_LANDMARK_KINDS = ("entrance", "stairs", "elevator")
# Kinds that move a route between floors, and so mark a `connector` point at a leg boundary.
_CONNECTOR_KINDS = frozenset(["stairs", "elevator"])

_ROOM_PREFIX = re.compile(r"^(?:ROOM|RM\.?|NO\.?|NUMBER|#)\s*")
_LETTERED_ROOM = re.compile(r"^(\d{3,4})([A-Z])$")
_LEADING_DIGITS = re.compile(r"^\d+")


class _Role(enum.Enum):
    """Which end of the journey an endpoint is; phrases the clarifying question."""

    START = "start"
    DESTINATION = "destination"


@dataclass(frozen=True)
class _Endpoint:
    """One end of the request as the person described it. `text` is never blank."""

    text: str
    floorKey: Optional[str]


@dataclass(frozen=True)
class _Extraction:
    """The model's validated reading of the message. A missing end is None, never a blank."""

    start: Optional[_Endpoint]
    destination: Optional[_Endpoint]
    stepFree: bool


@dataclass(frozen=True)
class _Resolved:
    """The endpoint is exactly one waypoint, and therefore exactly one MapNode."""

    waypoint: dict


@dataclass(frozen=True)
class _NotFound:
    """Nothing on the plans matches; `suggestions` are real names or room numbers, maybe none."""

    text: str
    isRoomNumber: bool
    suggestions: tuple


@dataclass(frozen=True)
class _Ambiguous:
    """A named place exists on several floors and nothing said which one."""

    text: str
    floorKeys: tuple


@dataclass(frozen=True)
class _ExtractionOutcome:
    """Result of the one model call (plus its retry). Exactly one of `extraction` and `failure`
    is set; `unreachable` says the failure was the transport, not the answer."""

    extraction: Optional[_Extraction]
    failure: Optional[str]
    unreachable: bool
    retried: bool
    validationError: Optional[str]
    modelName: Optional[str]
    usage: dict


class _RouteMappingError(Exception):
    """The router's answer names a floor the plans do not cover, or has an empty leg."""


def _field(obj, name):
    """Read `name` off a plain dict or a C3 object alike. Missing reads as None."""
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _joinOr(items):
    """"a", "a or b", "a, b or c"."""
    items = list(items)
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " or " + items[-1]


def _normalizeRoomText(text):
    """Canonical room-number spelling of what someone typed: upper case, no spaces, and no
    "rm" / "room" / "#" / "no." prefix. "rm 1270" and " #1270 " both give "1270"; "1270 a" gives
    "1270A". Never fails; text that is not a room number just will not match one."""
    s = " ".join(str(text).upper().split())
    previous = None
    while previous != s:
        previous = s
        s = _ROOM_PREFIX.sub("", s).strip()
    return re.sub(r"\s+", "", s)


def _nameKey(text):
    """Lower case, no leading "the", punctuation folded to spaces: "The West Entrance." gives
    "west entrance"."""
    s = re.sub(r"[^a-z0-9]+", " ", str(text).lower()).strip()
    s = re.sub(r"^the\s+", "", s)
    return " ".join(s.split())


def _nameKeysFor(waypoint):
    """Every spelling a person might use for this waypoint's name: its name, its name without a
    parenthetical ("Elevator C (east)" -> "elevator c"), its aliases and its plan label."""
    keys = set()
    for raw in [waypoint.get("name"), waypoint.get("label")] + list(
        waypoint.get("searchAliases") or []
    ):
        if not raw:
            continue
        keys.add(_nameKey(raw))
        keys.add(_nameKey(re.sub(r"\([^)]*\)", " ", str(raw))))
    keys.discard("")
    return keys


def _editDistance(a, b):
    """Optimal string alignment distance: insert, delete, substitute or swap two neighbours,
    each costing 1. So "1207" -> "1270" is 1, a single transposition."""
    rows = [list(range(len(b) + 1))]
    for i in range(1, len(a) + 1):
        row = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            row[j] = min(rows[i - 1][j] + 1, row[j - 1] + 1, rows[i - 1][j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                row[j] = min(row[j], rows[i - 2][j - 2] + 1)
        rows.append(row)
    return rows[len(a)][len(b)]


def _nearbyRooms(text, roomNumbers, limit=_MAX_SUGGESTIONS):
    """Up to `limit` existing room numbers someone typing `text` most likely meant, best first.

    Ranked by: a typo away (edit distance 1, e.g. a swapped pair of digits), then the same floor
    (first digit), then numeric closeness, then the plain number before its lettered sub-rooms.
    A lettered sub-room ("1210A") is offered only when its plain number does not exist. Returns
    [] when `text` has no leading digits, so a place name never gets room numbers as suggestions.
    Deterministic for a given input.
    """
    key = _normalizeRoomText(text)
    digits = _LEADING_DIGITS.match(key)
    if digits is None:
        return []
    wanted = int(digits.group(0))
    plain = {r for r in roomNumbers if not _LETTERED_ROOM.match(r)}
    candidates = []
    for room in set(roomNumbers):
        if room == key:
            continue
        lettered = _LETTERED_ROOM.match(room)
        if lettered and lettered.group(1) in plain:
            continue
        roomDigits = _LEADING_DIGITS.match(room)
        if roomDigits is None:
            continue
        candidates.append(
            (
                0 if _editDistance(key, room) <= 1 else 1,
                0 if room[:1] == key[:1] else 1,
                abs(int(roomDigits.group(0)) - wanted),
                len(room),
                room,
            )
        )
    candidates.sort()
    return [c[-1] for c in candidates[:limit]]


def _landmarkNames(candidates, limit=_MAX_SUGGESTIONS):
    """Distinct names of the building's entrances, stairs and elevators, in that order."""
    names = []
    for kind in _LANDMARK_KINDS:
        for name in sorted({w["name"] for w in candidates if w["kind"] == kind and w.get("name")}):
            if name not in names:
                names.append(name)
    return names[:limit]


def _resolveEndpoint(endpoint, candidates, preferredFloorKey):
    """Turn one described place into exactly one waypoint, or say why it cannot be.

    `candidates` are waypoints that have a `sourceNode`. Order: exact room number (ignoring case,
    spaces and an "rm"/"room"/"#" prefix), then the same number without a trailing letter
    ("1270A" -> "1270"), then a name, alias or label of any nameable place. A room number is
    unique in a building, so the floor is ignored for it. A named place on several floors (the
    West Stairs) is narrowed by the endpoint's own floor, then by `preferredFloorKey` (the other
    end's floor); still several is `_Ambiguous`. No match is `_NotFound` with suggestions.
    Never raises.
    """
    rooms = [w for w in candidates if w["kind"] == "room" and w.get("roomNumber")]
    key = _normalizeRoomText(endpoint.text)
    byNumber = {}
    for w in rooms:
        byNumber.setdefault(str(w["roomNumber"]).upper(), []).append(w)
    tries = [key]
    lettered = _LETTERED_ROOM.match(key)
    if lettered:
        tries.append(lettered.group(1))
    for number in tries:
        if number in byNumber:
            return _pickOne(endpoint, byNumber[number], preferredFloorKey)

    nameKey = _nameKey(endpoint.text)
    named = [
        w for w in candidates if w["kind"] in _NAMEABLE_KINDS and nameKey in _nameKeysFor(w)
    ]
    if named:
        return _pickOne(endpoint, named, preferredFloorKey)

    if _LEADING_DIGITS.match(key):
        return _NotFound(
            key, True, tuple(_nearbyRooms(key, [str(w["roomNumber"]).upper() for w in rooms]))
        )
    return _NotFound(endpoint.text.strip(), False, tuple(_landmarkNames(candidates)))


def _pickOne(endpoint, matches, preferredFloorKey):
    if len(matches) == 1:
        return _Resolved(matches[0])
    for floorKey in (endpoint.floorKey, preferredFloorKey):
        onFloor = [w for w in matches if floorKey is not None and w["floorKey"] == floorKey]
        if len(onFloor) == 1:
            return _Resolved(onFloor[0])
    return _Ambiguous(
        endpoint.text.strip(),
        tuple(sorted({w["floorKey"] for w in matches}, key=lambda k: (len(k), k))),
    )


def _questionFor(resolution, role):
    """The clarifying question for an endpoint that did not resolve to one place."""
    if isinstance(resolution, _Ambiguous):
        return "Which floor is the %s you mean: %s?" % (
            resolution.text,
            _joinOr(resolution.floorKeys),
        )
    where = ("room %s" % resolution.text) if resolution.isRoomNumber else ('"%s"' % resolution.text)
    question = "I can't find %s on these plans." % where
    if resolution.suggestions:
        question += " Did you mean %s?" % _joinOr(resolution.suggestions)
    elif role is _Role.START:
        question += " Where are you starting from? Tell me a room number or an entrance."
    else:
        question += " Tell me a room number or a place."
    return question


def _parseEndpoint(raw, fieldName, knownFloorKeys):
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError('"%s" must be an object or null.' % fieldName)
    text = raw.get("text")
    if isinstance(text, bool) or not isinstance(text, (str, int, type(None))):
        raise ValueError('"%s.text" must be a string or null.' % fieldName)
    text = "" if text is None else str(text).strip()
    if not text:
        return None
    floor = raw.get("floor")
    if isinstance(floor, bool) or not isinstance(floor, (str, int, type(None))):
        raise ValueError('"%s.floor" must be a string of digits or null.' % fieldName)
    return _Endpoint(text, _normalizeFloorKey(floor, knownFloorKeys))


def _parseExtraction(parsed, knownFloorKeys):
    """Validate the model's extraction JSON into an `_Extraction`.

    Raises ValueError, with a reason fit to send back to the model, when `parsed` is not an
    object, lacks the "start" or "destination" key, or holds a field of the wrong type. A null
    or blank end is a missing end (None), not an error. A floor the building does not have
    becomes None. "stepFree" null or absent means False.
    """
    if not isinstance(parsed, dict):
        raise ValueError("The answer was not a single JSON object.")
    for key in ("start", "destination"):
        if key not in parsed:
            raise ValueError('The answer has no "%s" key; use null when it is not given.' % key)
    stepFree = parsed.get("stepFree")
    if stepFree is None:
        stepFree = False
    if not isinstance(stepFree, bool):
        raise ValueError('"stepFree" must be true or false.')
    return _Extraction(
        _parseEndpoint(parsed["start"], "start", knownFloorKeys),
        _parseEndpoint(parsed["destination"], "destination", knownFloorKeys),
        stepFree,
    )


def _extractEndpoints(client, message, knownFloorKeys):
    """Ask the model what the message's start and destination are. One retry on a bad answer.

    Never raises: a client exception gives an outcome with `unreachable` True (no retry, since
    the transport is down rather than the answer wrong); two unusable answers give `failure` set.
    """
    messages = [
        {"role": "system", "content": _EXTRACTION_PROMPT},
        {"role": "user", "content": str(message)},
    ]
    options = {"returnJson": True, "max_tokens": _EXTRACTION_MAX_TOKENS}
    usage = {"promptTokens": 0, "cachedTokens": 0, "completionTokens": 0}
    modelName = None
    validationError = None
    for attempt in (1, 2):
        try:
            response = client.completion(messages=messages, options=options)
        except Exception as error:
            return _ExtractionOutcome(
                None, str(error), True, attempt > 1, validationError, modelName, usage
            )
        usage = _addUsage(usage, response)
        modelName = _modelName(response, client) or modelName
        rawContent = _responseContent(response)
        try:
            extraction = _parseExtraction(_parseJsonContent(rawContent), knownFloorKeys)
            return _ExtractionOutcome(
                extraction, None, False, attempt > 1, validationError, modelName, usage
            )
        except ValueError as error:
            validationError = str(error)
        messages = messages + [
            {"role": "assistant", "content": str(rawContent or "")},
            {"role": "user", "content": _EXTRACTION_RETRY % validationError},
        ]
    return _ExtractionOutcome(None, validationError, False, True, validationError, modelName, usage)


def _waypointsByNode(byLabel):
    """sourceNode -> waypoint, for every waypoint that has a MapNode behind it."""
    out = {}
    for floors in byLabel.values():
        for point in floors.values():
            if point.get("sourceNode"):
                out[point["sourceNode"]] = point
    return out


def _visionRouteFromNavRoute(nav, waypointsByNode, plansByFloorId):
    """Map a found `NavRoute` onto the `VisionRoute` fields the Room Finder UI draws.

    `nav` is a NavRoute with `found` true, as a C3 object or a plain dict. One segment per leg.
    Point coordinates are the router's floor-plan pixels, untouched; they are in the same
    1980x1530 space as `imageWidth`/`imageHeight`, so no scaling. A point's label is its
    Waypoint label when it has one, else its node id (door nodes have no Waypoint). Steps are
    every leg's `steps[].text` in order (a leg with no steps contributes its `instruction`), and
    each step's floor key is its leg's, exactly.

    Returns a dict with route, segments, steps, stepFloorKeys, totalSeconds, totalMeters and
    replayLabels: the labels of the points that have a Waypoint, which is what a pinned replay
    can resolve through `_resolveRoute` later.

    Raises _RouteMappingError if a leg is on a floor with no AnnotatedPlan or has no points.
    """
    legs = list(_field(nav, "legs") or [])
    segments, steps, stepFloorKeys, route, replayLabels = [], [], [], [], []
    for li, leg in enumerate(legs):
        floorId = _field(leg, "floorId")
        plan = plansByFloorId.get(floorId)
        if plan is None:
            raise _RouteMappingError("The route crosses floor %s, which has no floor plan." % floorId)
        rawPoints = list(_field(leg, "points") or [])
        if not rawPoints:
            raise _RouteMappingError("The route has an empty leg on floor %s." % floorId)

        legSteps = [str(_field(s, "text")) for s in list(_field(leg, "steps") or [])]
        if not legSteps and _field(leg, "instruction"):
            legSteps = [str(_field(leg, "instruction"))]
        stepIndexes = list(range(len(steps), len(steps) + len(legSteps)))
        steps.extend(legSteps)
        stepFloorKeys.extend([plan["floorKey"]] * len(legSteps))

        points = []
        for pi, raw in enumerate(rawPoints):
            nodeId = str(_field(raw, "nodeId"))
            waypoint = waypointsByNode.get(nodeId)
            kind = _field(raw, "kind") or (waypoint["kind"] if waypoint else "hallway")
            atLegEdge = (pi == 0 and li > 0) or (pi == len(rawPoints) - 1 and li < len(legs) - 1)
            point = {
                "label": waypoint["label"] if waypoint else nodeId,
                "floorKey": plan["floorKey"],
                "floorLevel": int(_field(leg, "floorLevel") or plan["floorLevel"]),
                "imageX": float(_field(raw, "x")),
                "imageY": float(_field(raw, "y")),
                "kind": kind,
                "name": waypoint.get("name") if waypoint else None,
                "roomNumber": waypoint.get("roomNumber") if waypoint else None,
                "isFloorChange": pi == len(rawPoints) - 1 and li < len(legs) - 1,
                "role": "connector" if atLegEdge and kind in _CONNECTOR_KINDS else "via",
                "nodeId": nodeId,
            }
            points.append(point)
            if waypoint:
                replayLabels.append(waypoint["label"])
        if li == 0:
            points[0]["role"] = "start"
        if li == len(legs) - 1:
            points[-1]["role"] = "end"

        drawn = [_routeWaypoint(p) for p in points]
        route.extend(drawn)
        segments.append(
            {
                "floorKey": plan["floorKey"],
                "floorLevel": drawn[0]["floorLevel"],
                "floorName": _field(leg, "floorName") or plan.get("floorName"),
                "planImageUrl": plan.get("planImageUrl"),
                "annotatedUrl": plan.get("publicUrl"),
                "imageWidth": plan.get("imageWidth") or 0,
                "imageHeight": plan.get("imageHeight") or 0,
                "points": drawn,
                "stepIndexes": stepIndexes,
            }
        )
    return {
        "route": route,
        "segments": segments,
        "steps": steps,
        "stepFloorKeys": stepFloorKeys,
        "totalSeconds": float(_field(nav, "totalSeconds") or 0.0),
        "totalMeters": float(_field(nav, "totalMeters") or 0.0),
        "replayLabels": replayLabels,
    }


# ---------------------------------------------------------------------------
# RoomFinder.findRoute
# ---------------------------------------------------------------------------


def findRoute(cls, buildingId, message, allowFallback):
    startedAt = time.time()
    allowFallback = True if allowFallback is None else bool(allowFallback)
    normalized = _normalizedMessage(message)

    byLabel = _loadWaypoints(buildingId)
    waypointsByNode = _waypointsByNode(byLabel)
    if byLabel and not waypointsByNode:
        return _findRouteByVision(cls, buildingId, message, allowFallback)

    plans = _loadPlans(buildingId)
    missing = []
    if not byLabel:
        missing.append("no waypoints are loaded")
    if not plans:
        missing.append("no annotated floor plans are loaded")
    if missing:
        # Setup problems are reported but not logged - they are not route attempts.
        return c3.VisionRoute.make(
            _visionRoute(
                "error",
                startedAt,
                source=_ROUTER_SOURCE,
                message="Building '%s' is not set up for the route finder: %s."
                % (buildingId, ", ".join(missing)),
            )
        )
    plansByFloor = {p["floorKey"]: p for p in plans}
    plansByFloorId = {p["floorId"]: p for p in plans if p.get("floorId")}
    candidates = list(waypointsByNode.values())

    def finish(status, **kwargs):
        return _finish(status, startedAt, buildingId, message, normalized, **kwargs)

    def fallbackOr(reason, errorMessage, **kwargs):
        if allowFallback:
            cached = _pinnedAnswer(buildingId, normalized, byLabel, plansByFloor, startedAt, reason)
            if cached is not None:
                return cached
        kwargs.setdefault("source", _ROUTER_SOURCE)
        return finish("error", message=errorMessage, **kwargs)

    try:
        client = c3.GenaiCore.Llm.Completion.Client.forConfigKey(_COMPLETION_CONFIG_KEY)
        clientError = None
    except Exception as error:
        client = None
        clientError = str(error)
    if client is None:
        return fallbackOr(
            "Showing a saved answer - the routing model is unavailable.",
            "The routing model is not available: %s"
            % (clientError or "no completion client is configured"),
        )

    outcome = _extractEndpoints(client, message, set(plansByFloor.keys()))
    common = dict(
        source=_ROUTER_SOURCE,
        retried=outcome.retried,
        validationError=outcome.validationError,
        modelName=outcome.modelName,
        **outcome.usage
    )
    if outcome.extraction is None:
        if outcome.unreachable:
            return fallbackOr(
                "Showing a saved answer - the routing model could not be reached.",
                "The routing model could not be reached. %s" % outcome.failure,
                **common
            )
        return fallbackOr(
            "Showing a saved answer - the live one did not check out.",
            "I could not read where you are and where you are going from that. Try "
            '"I\'m in 1310, how do I get to 1270".',
            **common
        )
    extraction = outcome.extraction

    if extraction.start is None:
        return finish("clarify", question=_ASK_FOR_START, suggestions=[], **common)
    start = _resolveEndpoint(extraction.start, candidates, None)
    if not isinstance(start, _Resolved):
        return finish(
            "clarify",
            question=_questionFor(start, _Role.START),
            suggestions=list(getattr(start, "suggestions", ())),
            **common
        )
    if extraction.destination is None:
        return finish("clarify", question=_ASK_FOR_DESTINATION, suggestions=[], **common)
    destination = _resolveEndpoint(
        extraction.destination, candidates, start.waypoint["floorKey"]
    )
    if not isinstance(destination, _Resolved):
        return finish(
            "clarify",
            question=_questionFor(destination, _Role.DESTINATION),
            suggestions=list(getattr(destination, "suggestions", ())),
            **common
        )

    startNode = start.waypoint["sourceNode"]
    destNode = destination.waypoint["sourceNode"]
    if startNode == destNode:
        return finish(
            "clarify",
            question="You're already at %s. Where do you want to go?" % destination.waypoint["label"],
            suggestions=[],
            **common
        )

    nav = c3.NavRouter.findRoute(startNode, destNode, extraction.stepFree)
    if not _field(nav, "found"):
        return finish(
            "error",
            message=str(_field(nav, "message") or "No walkable route was found."),
            **common
        )
    try:
        mapped = _visionRouteFromNavRoute(nav, waypointsByNode, plansByFloorId)
    except _RouteMappingError as error:
        return finish("error", message=str(error), **common)
    replayLabels = mapped.pop("replayLabels")
    return finish(
        "ok", drawable=True, suggestions=[], replayLabels=replayLabels, **dict(common, **mapped)
    )


# ---------------------------------------------------------------------------
# RoomFinder.syncPlanImages
# ---------------------------------------------------------------------------


def syncPlanImages(cls, buildingId, uiServiceBaseUrl):
    import urllib.request

    base = str(uiServiceBaseUrl or _defaultUiServiceBaseUrl()).rstrip("/")
    plans = c3.AnnotatedPlan.fetch(
        {
            "filter": c3.Filter.eq("building.id", buildingId),
            "include": "publicUrl, c3FileUrl, floorKey",
            "order": "floorLevel",
            "limit": -1,
        }
    ).objs or []

    synced = 0
    updates = []
    for plan in plans:
        if not plan.publicUrl or not plan.c3FileUrl:
            continue
        url = base + "/" + str(plan.publicUrl).lstrip("/")
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "c3-roomfinder-sync"})
            with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT_SECONDS) as response:
                data = response.read()
        except Exception:
            continue
        if not data or not data.startswith(b"\x89PNG"):
            continue
        destination = c3.FileSystem.makeFile(plan.c3FileUrl)
        c3.FileSystem.uploadFile(io.BytesIO(data), destination.url)
        updates.append(c3.AnnotatedPlan.make({"id": plan.id, "syncedAt": c3.DateTime.now()}))
        synced += 1

    if updates:
        c3.AnnotatedPlan.mergeBatch(updates)
    return synced


# ---------------------------------------------------------------------------
# RoomFinder.pinRoute
# ---------------------------------------------------------------------------


def pinRoute(cls, queryId, pinned):
    pinned = True if pinned is None else bool(pinned)
    rows = c3.RouteQuery.fetch(
        {
            "filter": c3.Filter.eq("id", queryId),
            "include": "status, drawable",
            "limit": 1,
        }
    ).objs or []
    if not rows:
        return False
    row = rows[0]
    if pinned and (row.status != "ok" or not row.drawable):
        return False
    c3.RouteQuery.make({"id": queryId, "isPinned": pinned}).merge()
    return True


# ---------------------------------------------------------------------------
# RoomFinder.diagnostics
# ---------------------------------------------------------------------------


def diagnostics(cls, buildingId):
    problems = []

    byLabel = _loadWaypoints(buildingId)
    labelCount = len(byLabel)
    waypointCount = sum(len(v) for v in byLabel.values())
    if not waypointCount:
        problems.append(
            "No Waypoint rows for building '%s'. Load data/Waypoint via upsertSeedData."
            % buildingId
        )

    plans = _loadPlans(buildingId)
    if not plans:
        problems.append(
            "No AnnotatedPlan rows for building '%s'. Load data/AnnotatedPlan via upsertSeedData."
            % buildingId
        )

    floors = []
    unreadable = []
    for plan in plans:
        readable = _encodedPlanImage(plan) is not None
        if not readable:
            unreadable.append(plan["floorKey"])
        floors.append(
            {
                "floorKey": plan["floorKey"],
                "floorLevel": plan["floorLevel"],
                "waypointCount": plan["waypointCount"],
                "imageReadable": readable,
                "syncedAt": str(plan["syncedAt"]) if plan["syncedAt"] else None,
            }
        )
    if unreadable:
        problems.append(
            "Floor %s has no image in the C3 Filesystem. Run RoomFinder.syncPlanImages('%s')."
            % (", ".join(unreadable), buildingId)
        )

    facts = _loadFacts(buildingId)
    if facts is None:
        problems.append(
            "No BuildingFacts row for building '%s'. Load data/BuildingFacts via upsertSeedData."
            % buildingId
        )

    clientReady = False
    supportsVision = False
    try:
        client = c3.GenaiCore.Llm.Completion.Client.forConfigKey(_COMPLETION_CONFIG_KEY)
        clientReady = client is not None
        if clientReady:
            try:
                supportsVision = bool(client.supportsVision())
            except Exception:
                supportsVision = False
    except Exception as error:
        problems.append(
            "Completion client '%s' is not available: %s" % (_COMPLETION_CONFIG_KEY, error)
        )
    if clientReady and not supportsVision:
        problems.append(
            "Completion client '%s' does not report vision support; routes will fail."
            % _COMPLETION_CONFIG_KEY
        )

    pinnedCount = 0
    try:
        pinnedCount = len(
            c3.RouteQuery.fetch(
                {
                    "filter": c3.Filter.eq("building.id", buildingId).and_(
                        c3.Filter.eq("isPinned", True)
                    ),
                    "include": "id",
                    "limit": -1,
                }
            ).objs
            or []
        )
    except Exception:
        pinnedCount = 0

    return {
        "buildingId": buildingId,
        "ready": not problems,
        "waypointCount": waypointCount,
        "distinctLabelCount": labelCount,
        "planCount": len(plans),
        "readablePlanCount": len(plans) - len(unreadable),
        "factsPresent": facts is not None,
        "factsLength": len(facts.facts or "") if facts is not None else 0,
        "demoRouteCount": len(facts.demoRoutes or []) if facts is not None else 0,
        "pinnedAnswerCount": pinnedCount,
        "completionClient": _COMPLETION_CONFIG_KEY,
        "completionClientReady": clientReady,
        "supportsVision": supportsVision,
        "floors": floors,
        "problems": problems,
    }
