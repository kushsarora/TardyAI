import io
import json
import re
import time

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
            "roomNumber, name",
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
        }
    return byLabel


def _loadPlans(buildingId):
    res = c3.AnnotatedPlan.fetch(
        {
            "filter": c3.Filter.eq("building.id", buildingId),
            "include": "floorKey, floorLevel, floorName, publicUrl, planImageUrl, c3FileUrl, "
            "imageWidth, imageHeight, annotatedWidth, annotatedHeight, waypointCount, syncedAt",
            "order": "floorLevel",
            "limit": -1,
        }
    )
    plans = []
    for p in res.objs or []:
        plans.append(
            {
                "id": p.id,
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


def _finish(status, startedAt, buildingId, userMessage, normalized, **kwargs):
    """Build the result, log it, and stamp the log row's id onto the result."""
    spec = _visionRoute(status, startedAt, **kwargs)
    spec["queryId"] = _logQuery(buildingId, userMessage, normalized, spec)
    return c3.VisionRoute.make(spec)


def _stepFloorKeysFromSegments(segments, stepCount):
    """A floor key per step, derived from which segment each step index landed in."""
    keys = [None] * stepCount
    for segment in segments:
        for index in segment.get("stepIndexes") or []:
            if 0 <= index < stepCount:
                keys[index] = segment["floorKey"]
    return keys


def _logQuery(buildingId, message, normalized, spec):
    """Persist the request. A logging failure must never turn a good route into an error."""
    try:
        row = c3.RouteQuery.make(
            {
                "building": {"id": buildingId},
                "userMessage": str(message),
                "normalizedMessage": normalized,
                "status": spec.get("status"),
                "routeLabels": [p["label"] for p in spec.get("route") or []],
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
# RoomFinder.findRoute
# ---------------------------------------------------------------------------


def findRoute(cls, buildingId, message, allowFallback):
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
