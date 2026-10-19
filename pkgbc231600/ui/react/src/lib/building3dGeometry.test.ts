import {
  floorElevation,
  planToWorld,
  routeIn3D,
  worldToPlan,
  ROUTE_LIFT,
} from './building3dGeometry';
import type { Floor, NavRoute } from '@/Interfaces';
const floor1: Floor = {
  id: 'f1',
  level: 1,
  name: 'Level 1',
  imageWidth: 1980,
  imageHeight: 1530,
  pixelsPerMeter: 12,
};
const floor3: Floor = { ...floor1, id: 'f3', level: 3, name: 'Level 3' };
const route: NavRoute = {
  found: true,
  stepFree: false,
  totalSeconds: 100,
  floorsTraversed: 2,
  legs: [
    {
      floorId: 'f1',
      floorLevel: 1,
      seconds: 20,
      instruction: 'Take stairs',
      exitConnectorKey: 'stairs',
      points: [
        { nodeId: 'a', x: 600, y: 400 },
        { nodeId: 'b', x: 600, y: 660 },
        { nodeId: 's1', x: 680, y: 660, kind: 'stairs' },
      ],
    },
    {
      floorId: 'f3',
      floorLevel: 3,
      seconds: 20,
      instruction: 'Arrive',
      points: [
        { nodeId: 's3', x: 680, y: 660, kind: 'stairs' },
        { nodeId: 'c', x: 925, y: 660 },
        { nodeId: 'd', x: 925, y: 455 },
      ],
    },
  ],
};

test('plan/world conversion preserves pin positions and vertical floor separation', () => {
  const point = { x: 567.3, y: 825.6 };
  for (const floor of [floor1, floor3])
    for (const gap of [4.2, 26]) {
      const world = planToWorld(point, floor, gap);
      const restored = worldToPlan(world, floor);
      expect(restored.x).toBeCloseTo(point.x);
      expect(restored.y).toBeCloseTo(point.y);
      expect(world[1]).toBeCloseTo(floorElevation(floor, gap));
    }
});

test('3D routes preserve every hallway bend with no diagonal shortcuts', () => {
  const model = routeIn3D(route, [floor1, floor3], 26);
  route.legs.forEach((leg, i) => {
    expect(model.legs[i].points).toHaveLength(leg.points.length);
    leg.points.forEach((point, j) => {
      const floor = i === 0 ? floor1 : floor3;
      const position = model.legs[i].points[j];
      expect(worldToPlan(position, floor)).toEqual({ x: point.x, y: point.y });
      expect(position[1]).toBe(floorElevation(floor, 26) + ROUTE_LIFT);
    });
  });
});

test('vertical transitions join the exact exit and arrival points on their own floors', () => {
  const model = routeIn3D(route, [floor1, floor3], 26);
  expect(model.transitions).toHaveLength(1);
  expect(model.transitions[0].kind).toBe('stairs');
  expect(model.transitions[0].points).toEqual([
    model.legs[0].points.at(-1),
    model.legs[1].points[0],
  ]);
  expect(
    model.transitions[0].points[1][1] - model.transitions[0].points[0][1],
  ).toBe(52);
});

test('missing or unfound routes never draw a connection between floors', () => {
  expect(routeIn3D(null, [floor1, floor3], 26).transitions).toEqual([]);
  expect(
    routeIn3D({ ...route, found: false }, [floor1, floor3], 26).legs,
  ).toEqual([]);
  const sameFloor = {
    ...route,
    legs: [route.legs[0], { ...route.legs[0], exitConnectorKey: null }],
  };
  expect(routeIn3D(sameFloor, [floor1], 26).transitions).toEqual([]);
});

test('an unavailable intervening floor never produces a fabricated vertical shortcut', () => {
  const missingLeg = { ...route.legs[0], floorId: 'not-loaded', floorLevel: 2 };
  const malformed = {
    ...route,
    legs: [route.legs[0], missingLeg, route.legs[1]],
  };
  expect(routeIn3D(malformed, [floor1, floor3], 26).transitions).toEqual([]);
});
