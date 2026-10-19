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
