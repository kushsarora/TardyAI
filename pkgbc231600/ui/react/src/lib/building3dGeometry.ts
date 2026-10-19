import type { Floor, NavRoute } from '@/Interfaces';
import type { PixelPoint } from './geoTransform';

export type WorldPoint = [number, number, number];
export const STACKED_FLOOR_GAP = 4.2;
export const SEPARATED_FLOOR_GAP = 26;
export const ROUTE_LIFT = 0.45;

export function floorElevation(floor: Floor, floorGap: number): number {
  return (floor.level - 1) * floorGap;
}

/** Image +Y points down; world +Y points up and +Z points toward the south. */
export function planToWorld(
  point: PixelPoint,
  floor: Floor,
  floorGap: number,
  lift = 0,
): WorldPoint {
  const scale = floor.pixelsPerMeter || 12;
  return [
    (point.x - floor.imageWidth / 2) / scale,
    floorElevation(floor, floorGap) + lift,
    (point.y - floor.imageHeight / 2) / scale,
  ];
}

export function worldToPlan(point: WorldPoint, floor: Floor): PixelPoint {
  const scale = floor.pixelsPerMeter || 12;
  return {
    x: Math.max(
      0,
      Math.min(floor.imageWidth, point[0] * scale + floor.imageWidth / 2),
    ),
    y: Math.max(
      0,
      Math.min(floor.imageHeight, point[2] * scale + floor.imageHeight / 2),
    ),
  };
}

export function routeIn3D(
  route: NavRoute | null,
  floors: Floor[],
  floorGap: number,
) {
  const byId = new Map(floors.map((floor) => [floor.id, floor]));
  const legs = (route?.found ? route.legs : []).flatMap((leg, sourceIndex) => {
    const floor = byId.get(leg.floorId);
    if (!floor || !leg.points.length) return [];
    // Keep every turn. Never smooth or shortcut routing geometry to make the model prettier.
    const points = leg.points.map((point) =>
      planToWorld(point, floor, floorGap, ROUTE_LIFT),
    );
    return [
      {
        sourceIndex,
        floorId: leg.floorId,
        points,
        exitConnectorKey: leg.exitConnectorKey,
        exitKind: leg.points.at(-1)?.kind,
      },
    ];
  });
  const transitions: {
    fromLegIndex: number;
    fromFloorId: string;
    toFloorId: string;
    connectorKey: string;
    kind: 'stairs' | 'elevator';
    points: WorldPoint[];
  }[] = [];
  for (let i = 1; i < legs.length; i++) {
    const previous = legs[i - 1],
      next = legs[i];
    if (
      previous.sourceIndex + 1 !== next.sourceIndex ||
      previous.floorId === next.floorId ||
      !previous.exitConnectorKey
    )
      continue;
    transitions.push({
      fromLegIndex: i - 1,
      fromFloorId: previous.floorId,
      toFloorId: next.floorId,
      connectorKey: previous.exitConnectorKey,
      kind: previous.exitKind === 'stairs' ? 'stairs' : 'elevator',
      points: [previous.points.at(-1)!, next.points[0]],
    });
  }
  return { legs, transitions };
}
