"""
Hand-authored corridor plan of Grainger Hall, read off the rendered floor plans.

Data only: `build_graph.py` turns it into MapNode/NavEdge rows. Coordinates are
pixels on `ui/react/public/plans/floor_p{1,2,3}.png` (1980x1530, y grows down).

Per floor:

- `points`: corridor points by local id. Put them on the open-floor centreline
  of a corridor, at every junction and bend. The ids `stair-w`, `elev-wa`,
  `elev-wb`, `elev-e` and `entrance-w` are the vertical connectors and the
  entrance (see CONNECTORS/ENTRANCES in build_graph.py); keep them, their
  connectorKeys tie the floors together.
- `corridors`: chains of point ids, "a b c" links a-b and b-c. A point named
  in two chains is a junction.
- `rooms`: every room number printed on the plan, at its label (or, for a room
  whose label is far from its doorway, a spot inside the room near it). The
  generator puts the room's door on the nearest corridor; `door` is a hint
  point used instead of the room position when the nearest corridor is the
  wrong one (across a wall).
- `restroom`: the one restroom node per floor that Room Finder labels <n>-WC.

`not_mapped` lists printed numbers deliberately left out, with the reason.
"""

from __future__ import annotations

from typing import NamedTuple

Point = tuple[float, float]


class RoomRow(NamedTuple):
    number: str
    x: float
    y: float
    name: str | None = None
    door: Point | None = None
    aliases: str | None = None


class FloorPlan(NamedTuple):
    points: dict[str, Point]
    corridors: tuple[str, ...]
    rooms: tuple[RoomRow, ...]
    restroom: RoomRow | None
    not_mapped: dict[str, str]


R = RoomRow

# ---------------------------------------------------------------------------
# Level 1
# ---------------------------------------------------------------------------
# Main hall: two lanes, y=786 (south) and y=660 (north), either side of the
# elevator/restroom islands. West strip x=126, south corridor y=1216, and the
# two north-south corridors x=453 / x=567 either side of the 1070/1080 column.

L1 = FloorPlan(
    points={
        # West entrance hall, then south onto the main hall.
        "entrance-w": (165, 725),
        "we1": (250, 725),
        # Main hall, south lane (y=786), west to east.
        "m126": (126, 786),
        "m250": (250, 786),
        "m400": (400, 786),
        "elev-wa": (400, 748),
        "m453": (453, 786),
        "hall-wmid": (512, 786),
        "stair-w": (512, 828),
        "m567": (567, 786),
        "m615": (615, 786),
        "elev-wb": (615, 748),
        "m1140": (1140, 786),
        "m1320": (1320, 786),
        "m1390": (1390, 786),
        # Main hall, north lane (y=660), and the corridor east of the MBA suite.
        "n512": (512, 660),
        "n1140": (1140, 660),
        "n1180": (1180, 660),
        "e1180": (1180, 300),
        # North lobby and the north corridor past the auditorium.
        "nl512": (512, 462),
        "nl440": (440, 462),
        "nl585": (585, 462),
        "nc512": (512, 350),
        "nc100": (100, 350),
        # Rotunda lobby around the Plenary, with Elevator C off its west side.
        "lb728": (1320, 728),
        "elev-e": (1397, 728),
        "lb660": (1320, 660),
        "lb560": (1320, 560),
        "lb450": (1360, 450),
        "lb-ne": (1470, 460),
        "lb-e": (1520, 560),
        # West strip, south corridor, and the corridors either side of 1070/1080.
        "s126": (126, 1216),
        "s453": (453, 1216),
        "s567": (567, 1205),
        "s700": (700, 1205),
    },
    corridors=(
        "entrance-w we1 m250",
        "m126 m250 m400 m453 hall-wmid m567 m615 m1140 m1320 m1390",
        "m400 elev-wa",
        "hall-wmid stair-w",
        "m615 elev-wb",
        "hall-wmid n512 nl512 nc512 nc100",
        "nl440 nl512 nl585",
        "n512 n1140 n1180 e1180",
        "m1140 n1140",
        "m1320 lb728 lb660 lb560 lb450",
        "n1180 lb660",
        "lb728 elev-e",
        "lb450 lb-ne lb-e",
        "m126 s126 s453 m453",
        "m567 s567 s700",
    ),
    rooms=(
        R("1100", 284, 215, "Morgridge Auditorium", aliases="auditorium,lecture"),
        R("1110", 158, 298),
        R("1140", 251, 570, "Class Room 1140", door=(250, 725)),
        R("1145", 150, 560),
        R("1149", 120, 636, "Multi-Media Center"),
        R("1170", 210, 872, "Class Room 1170"),
        R("1175", 349, 872, "Class Room 1175"),
        R("1180", 210, 1000, "Class Room 1180"),
        R("1185", 349, 1000, "Class Room 1185"),
        R("1190", 210, 1127, "Class Room 1190"),
        R("1195", 349, 1127, "Class Room 1195"),
        R("1070", 510, 993, "Class Room 1070"),
        R("1080", 510, 1102, "Class Room 1080"),
        # Huber lab suite: 1210 wraps 1210C on the north lobby side.
        R("1210", 690, 350, "Huber Undergrad Computer Lab", door=(585, 462), aliases="computer lab,huber"),
        R("1210A", 658, 600, "Huber Lab South"),
        R("1210B", 790, 500, "Finance & Analytics Lab"),
        R("1210C", 628, 420, door=(585, 462)),
        R("1230", 1048, 570, "MBA & Master's Lounge"),
        R("1238", 1132, 624),
        R("1250", 852, 940, "Undergraduate Lounge", aliases="lounge"),
        R("1266", 1055, 872, "Private Dining"),
        R("1270", 679, 872, "Class Room 1270"),
        R("1280", 679, 1001, "Class Room 1280"),
        R("1290", 734, 1115, "Small Business Development Center"),
        R("1290A", 810, 1096),
        R("1290B", 810, 1155),
        R("1290C", 782, 1225),
        R("1293", 638, 1146, "Lab 1293"),
        R("1295", 720, 1360, "Class Room 1295", door=(650, 1205)),
        R("1301", 1508, 411),
        R("1305", 1451, 543),
        R("1310", 1358, 300, "Plenary Room", door=(1360, 450), aliases="plenary"),
        R("1320", 1295, 452, "MBA&M Study"),
        R("1323", 1061, 430, "MBA&M Student Org Offices"),
        R("1324", 1243, 417),
        R("1325", 1061, 315, "MBA & Master's Club Room"),
        R("1327", 1131, 451),
        R("1329", 1131, 394, "MBA&M Study"),
        R("1405", 1530, 740, door=(1390, 786)),
        R("1411", 1592, 590, "Facilities Services"),
        R("1413", 1552, 575),
        R("1414", 1541, 612),
        R("1424", 1425, 912),
        R("1425", 1505, 890),
        R("1450", 1296, 906, "Dining Commons", aliases="dining,food"),
    ),
    restroom=R("WC", 790, 725),
    not_mapped={
        "1210E": "inside the 1210 lab suite, more than 15 m from any open corridor",
        "1210F": "inside the 1210 lab suite, more than 15 m from any open corridor",
        "1210G": "inside the 1210 lab suite, more than 15 m from any open corridor",
        "1430": "inside the 1405 suite, more than 15 m from any open corridor",
        "1435": "inside the 1405 suite, more than 15 m from any open corridor",
        "1505": "Capital Cafe sits inside the hatched dining commons; no corridor within 15 m",
        "1520": "Capital Cafe Dining sits inside the hatched dining commons; no corridor within 15 m",
    },
)

# ---------------------------------------------------------------------------
# Level 2
# ---------------------------------------------------------------------------
# The hatched block x 430-595, y 505-940 is open to the level-1 lobby below, so
# the main hall (y=786) is cut in two there. The west half reaches the east
# half by the walkway at the top of the West Stairs (y=960) or the south
# corridor (y=1215), each joined by the corridors x=405 and x=618. North: the
# y=488 corridor between the lecture hall and the 2130s, and the window strip
# x=118. East: the lobby south of 2315-2318, the walkway x=1365 along the
# atrium rail, and the MBA suite's corridor (curving at y~640, then x=1540).

L2 = FloorPlan(
    points={
        # North corridor (y=488) and the window strip up past 2111-2117.
        "w118n": (118, 280),
        "w118": (118, 488),
        "n405": (405, 488),
        "n635": (635, 488),
        # Corridor y=660 south of the 2130s, to the passage west of Elevator A.
        "c110": (110, 660),
        "c365": (365, 660),
        "c405": (405, 660),
        "e365": (365, 725),
        "elev-wa": (378, 725),
        # Main hall, west half.
        "m125": (125, 786),
        "m365": (365, 786),
        "m405": (405, 786),
        # Stair-top walkway and the corridors either side of 2080.
        "w960": (405, 960),
        "hall-wmid": (512, 960),
        "stair-w": (512, 942),
        "e960": (618, 960),
        "s125": (125, 1215),
        "s405": (405, 1215),
        "s618": (618, 1215),
        "s618s": (618, 1380),
        # Main hall, east half.
        "m618": (618, 786),
        "m655": (655, 786),
        "elev-wb": (655, 725),
        "m1300": (1300, 786),
        "m1365": (1365, 786),
        # East lobby south of 2315-2318.
        "l1170": (1170, 520),
        "l1300": (1300, 520),
        # Walkway along the atrium rail (x=1365), north into the rotunda.
        "r200": (1360, 200),
        "r250": (1380, 250),
        "r330": (1370, 330),
        "r520": (1365, 520),
        "r645": (1365, 645),
        "lb728": (1365, 728),
        "elev-e": (1380, 728),
        "r1060": (1365, 1060),
        "r1258": (1365, 1258),
        "r1430": (1365, 1430),
        # MBA suite corridor.
        "c1450": (1450, 643),
        "c1510": (1510, 628),
        "c1540": (1540, 615),
        "x1540m": (1540, 780),
        "x1540s": (1540, 1060),
    },
    corridors=(
        "w118n w118 n405 n635",
        "n405 c405 c365 c110",
        "c365 e365 m365",
        "e365 elev-wa",
        "m125 m365 m405",
        "m405 w960 s405",
        "w960 hall-wmid e960",
        "hall-wmid stair-w",
        "m125 s125 s405 s618",
        "m618 e960 s618 s618s",
        "m618 m655 m1300 m1365",
        "m655 elev-wb",
        "m1300 l1300",
        "l1170 l1300 r520",
        "r200 r250 r330 r520 r645 lb728 m1365 r1060 r1258 r1430",
        "lb728 elev-e",
        "r645 c1450 c1510 c1540 x1540m x1540s",
    ),
    rooms=(
        R("2111", 165, 282),
        R("2113", 167, 327),
        R("2115", 167, 383),
        R("2117", 165, 440),
        R("2120", 308, 420, "Jack F Keller Lecture Hall", aliases="lecture hall,keller"),
        R("2020", 510, 360, "Undergraduate Admissions", aliases="admissions"),
        R("2020B", 577, 440),
        R("2020C", 577, 404),
        R("2020D", 577, 355),
        R("2020H", 444, 341),
        R("2020I", 444, 388),
        R("2020J", 450, 434),
        R("2130", 350, 527),
        R("2132", 350, 566),
        R("2131", 175, 533),
        R("2133", 175, 575),
        R("2135", 176, 620),
        R("2165", 286, 725, "Class Room 2165"),
        R("2167", 162, 725, "TA Space"),
        R("2170", 222, 870, "Class Room 2170"),
        R("2175", 333, 870, "Class Room 2175"),
        R("2180", 222, 1000, "Class Room 2180"),
        R("2185", 333, 1000, "Class Room 2185"),
        R("2190", 222, 1127, "Class Room 2190"),
        R("2195", 333, 1127, "Class Room 2195"),
        R("2080", 510, 1080, "Nicholas Lecture Hall", aliases="lecture hall,nicholas"),
        R("2210", 690, 488, "Learning Commons", door=(600, 488), aliases="library,study,commons"),
        R("2210A", 708, 397),
        R("2210N", 1085, 467, "Class Room 2210N"),
        R("2210R", 1020, 700, "Class Room 2210R"),
        R("2210S", 920, 700, "Class Room 2210S"),
        R("2210U", 767, 625, "Class Room 2210U", door=(767, 786)),
        R("2200K", 640, 615, door=(625, 488)),
        R("2250", 840, 900, "Multicultural Center Lounge"),
        R("2256", 943, 868, "Multicultural Center"),
        R("2266", 1100, 852, "FES/FMO Services"),
        R("2266A", 1188, 832),
        R("2266B", 1175, 913),
        R("2266C", 1110, 913),
        R("2266D", 1058, 913),
        R("2270", 715, 870, "Class Room 2270"),
        R("2280", 715, 1000, "Class Room 2280"),
        R("2290", 745, 1125, "Computer Classroom 2290"),
        R("2294", 745, 1270, "Computer Classroom 2294"),
        R("2296", 760, 1440),
        R("2310", 1240, 395, "Eve/Exec/Prof MBA", door=(1370, 400)),
        R("2311", 1283, 331),
        R("2312", 1240, 340),
        R("2313", 1205, 335),
        R("2315", 1180, 466),
        R("2316", 1227, 466),
        R("2317", 1268, 466),
        R("2318", 1312, 466),
        R("2325", 1258, 210, "Eve/Exec/Prof MBA Study"),
        R("2327", 1330, 178),
        R("2329", 1316, 142),
        R("2335", 1487, 180, "Class Room 2335"),
        R("2339", 1487, 380, "Class Room 2339"),
        R("2401", 1400, 620),
        R("2402", 1406, 672),
        R("2403", 1438, 613),
        R("2404", 1440, 672),
        R("2405", 1472, 608),
        R("2406", 1476, 668),
        R("2407", 1507, 596),
        R("2408", 1513, 664),
        R("2411", 1567, 575),
        R("2415", 1585, 618),
        R("2417", 1585, 660),
        R("2419", 1585, 703),
        R("2421", 1508, 722),
        R("2423", 1585, 745),
        R("2425", 1585, 808),
        R("2427", 1585, 872),
        R("2429", 1585, 914),
        R("2431", 1585, 957),
        R("2434", 1490, 977),
        R("2435", 1585, 999),
        R("2436", 1410, 1017),
        R("2437", 1585, 1043),
        R("2450", 1460, 780, "MBA & Master's Programs", aliases="mba"),
        R("2451", 1450, 750),
        R("2455", 1445, 712),
        R("2456", 1510, 810),
        R("2462", 1410, 872),
        R("2471", 1312, 968),
        R("2473", 1240, 970),
        R("2475", 1265, 1012),
        R("2477", 1312, 1037),
        R("2510", 1487, 1158, "Class Room 2510"),
        R("2515", 1385, 1253),
        R("2520", 1487, 1368, "Class Room 2520"),
        R("2525", 1362, 1463, "MBA&M Study"),
    ),
    restroom=R("WC", 760, 725),
    not_mapped={
        "2020E": "inside the 2020 Admissions suite, more than 15 m from any open corridor",
        "2020F": "inside the 2020 Admissions suite, more than 15 m from any open corridor",
        "2020G": "inside the 2020 Admissions suite, more than 15 m from any open corridor",
        "2210D": "inside the 2210 Learning Commons (drawn filled), more than 15 m from any open corridor",
        "2210E": "inside the 2210 Learning Commons (drawn filled), more than 15 m from any open corridor",
        "2210G": "inside the 2210 Learning Commons (drawn filled), more than 15 m from any open corridor",
        "2210H": "inside the 2210 Learning Commons (drawn filled), more than 15 m from any open corridor",
        "2210J": "inside the 2210 Learning Commons (drawn filled), more than 15 m from any open corridor",
        "2210K": "inside the 2210 Learning Commons (drawn filled), more than 15 m from any open corridor",
        "2210L": "inside the 2210 Learning Commons (drawn filled), more than 15 m from any open corridor",
        "2210M": "inside the 2210 Learning Commons (drawn filled), more than 15 m from any open corridor",
    },
)

# ---------------------------------------------------------------------------
# Level 3
# ---------------------------------------------------------------------------
# Main hall y=786 from the 3150 suite to the east lounges. West wing: the
# corridor x=335 and the arc past 3102-3112. South-west: corridors x=405 and
# x=618 either side of 3070/3081-3085, joined at y=995. North: the skylit
# corridor y=628 south of the Learning Commons, reached from the east lobby
# (x=1250). East: the walkway x=1365 from the rotunda hub (3320) south past
# the atrium. The MBA suites east of it (3415-3547 along the east wall) open
# only onto their own corridors behind the filled lounges 3432/3434.

L3 = FloorPlan(
    points={
        # West wing arc and corridor x=335.
        "a200": (200, 130),
        "a240": (240, 135),
        "a280": (280, 145),
        "a310": (310, 165),
        "a330": (330, 200),
        "w335n": (335, 250),
        "w335s": (335, 640),
        "c365": (365, 660),
        # Main hall.
        "m365": (365, 786),
        "m405": (405, 786),
        "elev-wa": (405, 772),
        "hall-wmid": (512, 786),
        "stair-w": (512, 772),
        "m618": (618, 786),
        "elev-wb": (618, 772),
        "m1250": (1250, 786),
        "m1365": (1365, 786),
        "m1455": (1455, 786),
        # South-west corridors.
        "c405": (405, 995),
        "s405": (405, 1230),
        "c618": (618, 995),
        "s618": (618, 1105),
        # North corridor south of the Learning Commons.
        "n1250": (1250, 628),
        "n660": (660, 628),
        # Walkway x=1365 and the rotunda hub.
        "lb725": (1365, 725),
        "elev-e": (1380, 725),
        "hub-c": (1365, 300),
        "hub-n": (1365, 230),
        "hub-ne": (1425, 240),
        "hub-w": (1325, 245),
        "hub-e": (1440, 305),
        "hub-sw": (1300, 320),
        "r1030": (1365, 1030),
        "r1320": (1365, 1320),
        "r1420": (1365, 1420),
    },
    corridors=(
        "a200 a240 a280 a310 a330 w335n w335s c365 m365",
        "m365 m405 hall-wmid m618 m1250 m1365 m1455",
        "m405 elev-wa",
        "hall-wmid stair-w",
        "m618 elev-wb",
        "m405 c405 s405",
        "c405 c618",
        "m618 c618 s618",
        "m1250 n1250 n660",
        "m1365 lb725 hub-c hub-n hub-ne",
        "lb725 elev-e",
        "hub-c hub-w",
        "hub-c hub-e",
        "hub-c hub-sw",
        "m1365 r1030 r1320 r1420",
    ),
    rooms=(
        R("3102", 210, 80),
        R("3104", 250, 90),
        R("3106", 292, 110),
        R("3108", 337, 138),
        R("3110", 367, 178),
        R("3111", 242, 208, "Conference Room 3111"),
        R("3112", 388, 235),
        R("3114", 395, 282),
        R("3116", 395, 322),
        R("3118", 395, 362),
        R("3120", 388, 406),
        R("3122", 388, 447),
        R("3124", 388, 484),
        R("3115", 250, 366),
        R("3115A", 215, 278),
        R("3115B", 280, 278),
        R("3150", 258, 718, "Undergraduate Program Office"),
        R("3150E", 200, 778),
        R("3150F", 290, 634),
        R("3150G", 215, 619),
        R("3150H", 290, 594),
        R("3150J", 215, 575),
        R("3150K", 290, 553),
        R("3150L", 215, 533),
        R("3150M", 290, 511),
        R("3150N", 215, 490),
        R("3150P", 290, 467),
        R("3150Q", 215, 448),
        R("3160", 290, 815),
        R("3161", 216, 826),
        R("3162", 322, 863),
        R("3163", 217, 877),
        R("3164", 322, 911),
        R("3165", 232, 916),
        R("3180", 279, 996, "Conference Room 3180"),
        R("3190", 279, 1125, "Conference Room 3190"),
        R("3070", 511, 872, "Conference Room 3070"),
        R("3081", 452, 965),
        R("3083", 511, 965),
        R("3085", 571, 965),
        R("3210", 900, 560, "Learning Commons", aliases="library,study,commons"),
        R("3210A", 617, 545),
        R("3251", 910, 728),
        R("3253", 993, 728),
        R("3259", 1117, 737),
        R("3259A", 1175, 710),
        R("3259B", 1065, 710),
        R("3260", 1130, 880, "Alumni Relations"),
        R("3260A", 1179, 832),
        R("3260B", 1190, 910),
        R("3260C", 1075, 911),
        R("3260D", 1067, 838),
        R("3260E", 1023, 911),
        R("3260F", 1013, 838),
        R("3260G", 972, 911),
        R("3260H", 970, 848),
        R("3260I", 919, 898),
        R("3260J", 922, 833),
        R("3262", 880, 835),
        R("3264", 765, 877),
        R("3264A", 848, 911),
        R("3264B", 836, 872),
        R("3270", 681, 865, "Conference Room 3270"),
        R("3290", 757, 975, "Undergraduate Program Office", door=(618, 975)),
        R("3290A", 674, 1055),
        R("3295", 632, 1180, "Undergraduate Interview Center"),
        R("3301", 1315, 654),
        R("3303", 1315, 613),
        R("3305", 1315, 573),
        R("3307", 1315, 531),
        R("3309", 1315, 488),
        R("3311", 1315, 446),
        R("3315", 1318, 405),
        R("3317", 1281, 380),
        R("3319", 1257, 345),
        R("3325", 1317, 175, "Class Room 3325"),
        R("3335", 1478, 180, "Class Room 3335"),
        R("3337", 1570, 250, "MBA&M Study"),
        R("3339", 1538, 325, "Class Room 3339"),
        R("3340", 1405, 450, "Bolz Center for Arts Admin"),
        R("3341", 1465, 425),
        R("3342", 1433, 492),
        R("3343", 1487, 452),
        R("3344", 1520, 400),
        R("3346", 1418, 368),
        R("3350", 1475, 547),
        R("3410", 1413, 622, "Center for Brand & Product Management"),
        R("3412", 1457, 634),
        R("3413", 1470, 601),
        R("3414", 1508, 632),
        R("3420", 1447, 671, "A. C. Nielsen Marketing Analytics & Insights"),
        R("3422", 1449, 705),
        R("3423", 1515, 668),
        R("3424", 1500, 703),
        R("3427", 1585, 703),
        R("3432", 1527, 754),
        R("3434", 1583, 851, "MBA & Master's Student Lounge Areas"),
        R("3442", 1410, 872),
        R("3447", 1300, 990),
        R("3450", 1438, 959),
        R("3452", 1475, 913),
        R("3453", 1465, 880),
        R("3460", 1413, 1013, "Strategic Human Resource Management"),
        R("3462", 1408, 1045),
        R("3464", 1457, 1045),
        R("3468", 1507, 1030),
        R("3510", 1415, 1098, "Erdman Center for Ops & Tech Management"),
        R("3512", 1408, 1154),
        R("3514", 1475, 1142),
        R("3515", 1503, 1076),
        R("3540", 1455, 1305),
        R("3541", 1456, 1210, "MBA&M Student Lounge"),
        R("3549", 1543, 1357),
        R("3550", 1380, 1328),
        R("3560", 1456, 1413, "Seminar Room 3560"),
        R("3565", 1363, 1463),
    ),
    restroom=R("WC", 770, 725),
    not_mapped={
        "3150B": "inside the 3150 suite, more than 15 m from any open corridor",
        "3150C": "inside the 3150 suite, more than 15 m from any open corridor",
        "3150D": "inside the 3150 suite, more than 15 m from any open corridor",
        "3415": "MBA suite office on the east wall, reached through the filled 3432/3434 lounges; more than 15 m from any open corridor",
        "3417": "MBA suite office on the east wall, reached through the filled 3432/3434 lounges; more than 15 m from any open corridor",
        "3425": "MBA suite office on the east wall, reached through the filled 3432/3434 lounges; more than 15 m from any open corridor",
        "3455": "MBA suite office on the east wall, reached through the filled 3432/3434 lounges; more than 15 m from any open corridor",
        "3457": "MBA suite office on the east wall, reached through the filled 3432/3434 lounges; more than 15 m from any open corridor",
        "3467": "MBA suite office on the east wall, reached through the filled 3432/3434 lounges; more than 15 m from any open corridor",
        "3469": "MBA suite office on the east wall, reached through the filled 3432/3434 lounges; more than 15 m from any open corridor",
        "3519": "MBA suite office on the east wall, reached through the filled 3432/3434 lounges; more than 15 m from any open corridor",
        "3521": "MBA suite office on the east wall, reached through the filled 3432/3434 lounges; more than 15 m from any open corridor",
        "3525": "MBA suite office on the east wall, reached through the filled 3432/3434 lounges; more than 15 m from any open corridor",
        "3545": "MBA suite office on the east wall, reached through the filled 3432/3434 lounges; more than 15 m from any open corridor",
        "3547": "MBA suite office on the east wall, reached through the filled 3432/3434 lounges; more than 15 m from any open corridor",
        "3210B": "inside the 3210 Learning Commons (drawn filled), more than 15 m from any open corridor",
        "3210C": "inside the 3210 Learning Commons (drawn filled), more than 15 m from any open corridor",
        "3210D": "inside the 3210 Learning Commons (drawn filled), more than 15 m from any open corridor",
        "3210E": "inside the 3210 Learning Commons (drawn filled), more than 15 m from any open corridor",
        "3210F": "inside the 3210 Learning Commons (drawn filled), more than 15 m from any open corridor",
        "3210G": "inside the 3210 Learning Commons (drawn filled), more than 15 m from any open corridor",
        "3210H": "inside the 3210 Learning Commons (drawn filled), more than 15 m from any open corridor",
        "3299": "at the far end of the 3295 carrel arc, more than 15 m from any open corridor",
        "2080": "upper level of Nicholas Lecture Hall; mapped once, on level 2",
    },
)

FLOOR_PLANS = {1: L1, 2: L2, 3: L3}
