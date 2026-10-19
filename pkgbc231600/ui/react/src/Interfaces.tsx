/*
 * Copyright 2009-2025 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 * This material, including without limitation any software, is the confidential trade secret and proprietary
 * information of C3 and its licensors. Reproduction, use and/or distribution of this material in any form is
 * strictly prohibited except as set forth in a written license agreement with C3 and/or its authorized distributors.
 * This material may be covered by one or more patents or pending patent applications.
 */

import { ReactElement } from 'react';

export interface User {
  id: string;
  name: string;
  email: string;
  lastName: string;
  firstName: string;
}

export interface UserGroup {
  id: string;
  name: string;
  description: string;
}

export interface SnackbarMessage {
  message: ReactElement;
  key: number;
  severity?: 'success' | 'info' | 'warning' | 'error';
  error?: boolean;
}

/** Sample / API document row (examples + fetchDocuments). */
export interface Document {
  documentName: string;
  program: string;
  owner: string;
  checklistApplied: string;
  attachments: number;
  uploadedBy: string;
  uploadedAt: string;
}

export interface ProgramDocument {
  documentName: string;
  owner: string;
  status: string;
  uploadedAt: string;
}

/** Program row with optional nested documents (examples + fetchPrograms). */
export interface Program {
  id: string;
  program: string;
  totalDocuments: number;
  passed: number;
  failed: number;
  pending: number;
  documents?: ProgramDocument[];
}

export interface DocumentTemplate {
  id: string;
  name: string;
  description: string;
  estimatedTime: string;
}

/* ------------------------------------------------------------------------- *
 * TardyAI — indoor navigation
 *
 * These mirror the C3 types in `src/`. Optional (`?`) marks a field the
 * backend declares nullable, or one that is only present when the UI asked
 * for it in a FetchSpec `include`.
 * ------------------------------------------------------------------------- */

/** One lat/lon ↔ pixel ground control point. Mirrors `CalibrationPoint`. */
export interface CalibrationPoint {
  label?: string;
  lat: number;
  lon: number;
  imageX: number;
  imageY: number;
}

/** Control points used to turn a GPS fix into a suggested pin. Mirrors `GeoCalibration`. */
export interface GeoCalibration {
  points: CalibrationPoint[];
}

/** Mirrors the `Building` entity type. */
export interface Building {
  id: string;
  name: string;
  campus?: string;
  address?: string;
  defaultFloorLevel?: number;
  centroidLat?: number;
  centroidLon?: number;
}

/**
 * Mirrors the `Floor` entity type.
 *
 * `imageWidth` / `imageHeight` define the pixel coordinate space that every
 * {@link MapNode} and {@link RoutePoint} on this floor is expressed in, with
 * the origin at the top-left and +Y pointing down.
 */
export interface Floor {
  id: string;
  level: number;
  name: string;
  planImageUrl?: string;
  imageWidth: number;
  imageHeight: number;
  pixelsPerMeter?: number;
  calibration?: GeoCalibration;
  building?: { id: string };
}

/** The kinds of vertex the navigation graph contains. Mirrors `MapNode#kind`. */
export type MapNodeKind = 'room' | 'hallway' | 'door' | 'stairs' | 'elevator' | 'entrance' | 'restroom';

/** Mirrors the `MapNode` entity type — one vertex of the navigation graph. */
export interface MapNode {
  id: string;
  kind: MapNodeKind;
  roomNumber?: string;
  name?: string;
  imageX: number;
  imageY: number;
  /** Printed label center; room routing coordinates stay at its mapped access point. */
  labelX?: number;
  labelY?: number;
  /** Shared across floors by nodes in the same shaft; see `MapNode#connectorKey`. */
  connectorKey?: string;
  stepFree?: boolean;
  searchAliases?: string;
  floor?: Floor;
}

/** Mirrors the `NavEdge` entity type — a walkable, same-floor connection. */
export interface NavEdge {
  id: string;
  fromNode?: { id: string };
  toNode?: { id: string };
  edgeType: 'hallway' | 'door' | 'stair' | 'elevator' | 'ramp';
  seconds: number;
  meters?: number;
  stepFree: boolean;
}

/** Return shape of `NavRouter.graphForBuilding`. Mirrors `NavGraphSnapshot`. */
export interface NavGraphSnapshot {
  routingRevision?: string;
  buildingId: string;
  nodes: MapNode[];
  edges: NavEdge[];
  nodeCount: number;
  edgeCount: number;
}

/** One vertex of a drawn route polyline, in floor pixel space. Mirrors `RoutePoint`. */
export interface RoutePoint {
  nodeId: string;
  x: number;
  y: number;
  kind?: string;
}

/** The portion of a route that happens on a single floor. Mirrors `RouteLeg`. */
export interface RouteLeg {
  floorId: string;
  floorLevel: number;
  floorName?: string;
  points: RoutePoint[];
  seconds: number;
  meters?: number;
  instruction: string;
  /** The shaft to board on leaving this floor; null on the final leg. */
  exitConnectorKey?: string | null;
}

/**
 * Return shape of `NavRouter.findRoute` / `routeToRoom`. Mirrors `NavRoute`.
 *
 * An unroutable request is a *value*, not an error: `found` is false and
 * `message` explains why, so the UI must always check `found` before reading
 * `legs`.
 */
export interface NavRoute {
  routingRevision?: string;
  found: boolean;
  message?: string | null;
  legs: RouteLeg[];
  totalSeconds: number;
  totalMeters?: number;
  floorsTraversed: number;
  startNodeId?: string | null;
  destNodeId?: string | null;
  stepFree: boolean;
}

/* ------------------------------------------------------------------------- *
 * Room Finder — vision-LLM wayfinding
 *
 * These mirror the C3 types backing `RoomFinder.findRoute`. The model answers
 * with waypoint *labels*, which the server resolves against the database into
 * the pixel positions below — so everything here has already been validated
 * and is safe to draw.
 * ------------------------------------------------------------------------- */

/** The plain-text brief the model is given about a building. Mirrors `BuildingFacts`. */
export interface BuildingFacts {
  id: string;
  facts: string;
  /** Curated example questions, shown as one-tap chips. */
  demoRoutes?: string[];
  building?: { id: string };
}

/** What a point is doing in the journey. Mirrors `RouteWaypoint#role`. */
export type RouteWaypointRole = 'start' | 'via' | 'connector' | 'end';

/**
 * One resolved point of a vision route, in floor pixel space. Mirrors `RouteWaypoint`.
 *
 * `imageX` / `imageY` are in the same coordinate space as {@link MapNode} — the
 * original plan raster, NOT the downscaled annotated render the model reads.
 */
export interface RouteWaypoint {
  label: string;
  floorKey: string;
  floorLevel: number;
  imageX: number;
  imageY: number;
  kind: string;
  name?: string | null;
  roomNumber?: string | null;
  /** True on the point where the user leaves this floor, i.e. boards a stair or lift. */
  isFloorChange: boolean;
  role: RouteWaypointRole;
}

/**
 * The part of a vision route walked on one floor. Mirrors `RouteFloorSegment`.
 *
 * One segment per floor *visit*, in travel order. A shaft appears in both
 * adjacent segments — once as the point walked to, once as the point arrived at.
 */
export interface RouteFloorSegment {
  floorKey: string;
  floorLevel: number;
  floorName?: string | null;
  /** Root-relative path of the clean plan; pass through `resolvePlanUrl` before use. */
  planImageUrl?: string | null;
  /** Root-relative path of the labelled plan the model was shown. */
  annotatedUrl?: string | null;
  imageWidth: number;
  imageHeight: number;
  points: RouteWaypoint[];
  /** Indices into {@link VisionRoute.steps} belonging to this floor. */
  stepIndexes?: number[];
}

/** Outcome of a vision route request. Mirrors `VisionRoute#status`. */
export type VisionRouteStatus = 'ok' | 'clarify' | 'error';

/**
 * Return shape of `RoomFinder.findRoute`. Mirrors `VisionRoute`.
 *
 * Branch on `status` before reading anything else, and note the degraded
 * fourth case: `status: 'ok'` with `drawable: false` means the written steps
 * are usable but a label did not resolve, so `segments` is empty and nothing
 * may be drawn.
 */
export interface VisionRoute {
  status: VisionRouteStatus;
  message?: string | null;
  question?: string | null;
  drawable: boolean;
  route: RouteWaypoint[];
  segments: RouteFloorSegment[];
  steps: string[];
  /** Parallel to `steps`; the floor each instruction applies to. */
  stepFloorKeys?: (string | null)[];
  /** Labels exactly as the model emitted them, before normalization. */
  rawLabels?: string[];
  retried: boolean;
  validationError?: string | null;
  /** `llm` for a live call, `cache` for a replayed pinned answer. */
  source: 'llm' | 'cache';
  latencyMs?: number;
  modelName?: string | null;
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  queryId?: string | null;
}
