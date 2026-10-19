import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  Box,
  Crosshair,
  Layers,
  Minus,
  Plus,
  RotateCcw,
  Tag,
} from 'lucide-react';
import type { Floor, MapNode, NavRoute } from '@/Interfaces';
import type { PixelPoint } from '@/lib/geoTransform';
import { resolvePlanUrl } from '@/lib/tardyApi';
import {
  floorElevation,
  planToWorld,
  routeIn3D,
  worldToPlan,
  SEPARATED_FLOOR_GAP,
  STACKED_FLOOR_GAP,
  type WorldPoint,
} from '@/lib/building3dGeometry';
import model from '@/assets/grainger-3d.json';

interface Props {
  floors: Floor[];
  nodes: MapNode[];
  activeFloorId: string;
  route: NavRoute | null;
  guiding: boolean;
  start: { floorId: string; point: PixelPoint } | null;
  destination: MapNode | null;
  accuracyRadiusPx: number;
  onFocusFloor: (floorId: string) => void;
  onPlaceStart: (floorId: string, point: PixelPoint) => void;
  onDestinationSelect: (node: MapNode) => void;
  onFallback: () => void;
}
interface Runtime {
  dirty: boolean;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  root: THREE.Group;
  resize: () => void;
  fit: () => void;
  pickables: THREE.Object3D[];
  flow: { dot: THREE.Mesh; path: THREE.CurvePath<THREE.Vector3> } | null;
}

function disposeObject(root: THREE.Object3D) {
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    if (mesh.material)
      for (const material of Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material]) {
        const map = (material as THREE.MeshStandardMaterial).map;
        if (map) textures.add(map);
        material.dispose();
      }
  });
  textures.forEach((texture) => texture.dispose());
}

function shapeFromPixels(
  outline: number[][],
  holes: number[][][],
  floor: Floor,
) {
  const scale = floor.pixelsPerMeter || 12;
  const points = (polygon: number[][]) =>
    polygon.map(
      ([x, y]) =>
        new THREE.Vector2(
          (x - floor.imageWidth / 2) / scale,
          (floor.imageHeight / 2 - y) / scale,
        ),
    );
  const shape = new THREE.Shape(points(outline));
  holes.forEach((hole) => shape.holes.push(new THREE.Path(points(hole))));
  return shape;
}

function labelSprite(
  text: string,
  color: string,
  size: number,
  background = '#ffffff',
) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.font = '600 42px Inter, Arial, sans-serif';
  canvas.width = Math.max(
    128,
    Math.min(720, Math.ceil(context.measureText(text).width + 48)),
  );
  canvas.height = 88;
  context.fillStyle = background;
  context.beginPath();
  context.roundRect(2, 2, canvas.width - 4, 84, 18);
  context.fill();
  context.strokeStyle = color + '55';
  context.lineWidth = 3;
  context.stroke();
  context.font = '600 42px Inter, Arial, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = color;
  context.fillText(text, canvas.width / 2, 45, canvas.width - 40);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      transparent: true,
    }),
  );
  sprite.scale.set(size, (size * canvas.height) / canvas.width, 1);
  sprite.renderOrder = 30;
  return sprite;
}

function addPath(
  group: THREE.Group,
  points: WorldPoint[],
  color: string,
  radius: number,
  depthTest = true,
) {
  const material = new THREE.MeshBasicMaterial({ color, depthTest });
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 1; i < points.length; i++) {
    const a = new THREE.Vector3(...points[i - 1]),
      b = new THREE.Vector3(...points[i]);
    const delta = b.clone().sub(a),
      length = delta.length();
    if (length < 0.001) continue;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, length, 8),
      material,
    );
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(up, delta.normalize());
    if (!depthTest) mesh.renderOrder = 25;
    group.add(mesh);
  }
  // Retain material ownership even for a zero-length route.
  if (points.length < 2) material.dispose();
}

export default function Building3DMap(props: Props) {
  const {
    floors,
    nodes,
    activeFloorId,
    route,
    guiding,
    start,
    destination,
    accuracyRadiusPx,
  } = props;
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [scope, setScope] = useState<'all' | 'floor'>('all');
  const [separated, setSeparated] = useState(true);
  const [labels, setLabels] = useState(true);
  const [failure, setFailure] = useState('');
  const [imageNotice, setImageNotice] = useState(false);
  const [hover, setHover] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const startFloorId = start?.floorId;
  const startX = start?.point.x;
  const startY = start?.point.y;
  const previousFloor = useRef(activeFloorId);
  const floorGap = separated ? SEPARATED_FLOOR_GAP : STACKED_FLOOR_GAP;
  const activeFloor = floors.find((floor) => floor.id === activeFloorId);

  useEffect(() => {
    if (previousFloor.current !== activeFloorId) {
      setScope('floor');
      previousFloor.current = activeFloorId;
    }
  }, [activeFloorId]);

  useEffect(() => {
    if (route?.found) setScope('all');
  }, [route]);

  useEffect(() => {
    if (guiding) setScope('floor');
  }, [guiding, activeFloorId]);

  // Own one renderer for the lifetime of the mounted 3D view. Scene updates do
  // not discard the user's camera or allocate another WebGL context.
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'low-power',
      });
    } catch {
      setFailure(
        '3D graphics are unavailable in this browser. Your directions are still available in 2D.',
      );
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor('#edf1e9');
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = renderer.domElement;
    canvas.setAttribute(
      'aria-label',
      'Interactive 3D Grainger Hall map. Drag to orbit, use two fingers to pan or pinch to zoom. Plus and minus zoom; zero resets. Click a room to select it or click a floor to set your start.',
    );
    canvas.setAttribute('role', 'application');
    canvas.tabIndex = 0;
    container.appendChild(canvas);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#ffffff', '#9bada0', 1.7));
    const sun = new THREE.DirectionalLight('#fff9e9', 1.6);
    sun.position.set(-90, 150, 80);
    scene.add(sun);
    const fill = new THREE.DirectionalLight('#d6e4ed', 0.7);
    fill.position.set(100, 50, -80);
    scene.add(fill);
    const root = new THREE.Group();
    scene.add(root);
    const grid = new THREE.GridHelper(280, 28, '#d4decf', '#e1e8dc');
    grid.position.y = -1.2;
    scene.add(grid);
    const camera = new THREE.OrthographicCamera(
      -150,
      150,
      100,
      -100,
      0.1,
      2000,
    );
    camera.position.set(150, 165, 180);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minZoom = 0.45;
    controls.maxZoom = 14;
    controls.maxPolarAngle = Math.PI / 2 - 0.06;
    controls.minPolarAngle = 0.06;
    controls.target.set(0, 20, 0);
    controls.listenToKeyEvents(canvas);
    let baseHeight = 180;
    const resize = () => {
      const width = container.clientWidth,
        height = container.clientHeight;
      if (!width || !height) return;
      const aspect = width / height,
        half = baseHeight / Math.min(aspect, 1) / 2;
      camera.left = -half * aspect;
      camera.right = half * aspect;
      camera.top = half;
      camera.bottom = -half;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      if (runtime.current) runtime.current.dirty = true;
    };
    const fit = () => {
      const box = new THREE.Box3().setFromObject(root);
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3()),
        sphere = box.getBoundingSphere(new THREE.Sphere());
      baseHeight = Math.max(90, sphere.radius * 1.75);
      const direction = camera.position
        .clone()
        .sub(controls.target)
        .normalize();
      camera.position.copy(center).addScaledVector(direction, 260);
      controls.target.copy(center);
      camera.zoom = 1;
      resize();
      controls.update();
    };
    const state: Runtime = {
      dirty: true,
      scene,
      camera,
      renderer,
      controls,
      root,
      resize,
      fit,
      pickables: [],
      flow: null,
    };
    runtime.current = state;
    const changed = () => {
      state.dirty = true;
    };
    controls.addEventListener('change', changed);
    const raycaster = new THREE.Raycaster(),
      pointer = new THREE.Vector2();
    let down: { x: number; y: number; eligible: boolean } | null = null;
    const pointers = new Set<number>();
    const pick = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(state.pickables, false);
    };
    const pointerDown = (event: PointerEvent) => {
      pointers.add(event.pointerId);
      if (pointers.size > 1) {
        if (down) down.eligible = false;
        return;
      }
      if (event.button === 0)
        down = { x: event.clientX, y: event.clientY, eligible: true };
    };
    const pointerMove = (event: PointerEvent) => {
      if (pointers.size) {
        setHover(null);
        return;
      }
      const hit = pick(event).find((hit) => hit.object.userData.node);
      if (!hit) {
        canvas.style.cursor = 'grab';
        setHover(null);
        return;
      }
      const node = hit.object.userData.node as MapNode;
      const rect = canvas.getBoundingClientRect();
      canvas.style.cursor = 'pointer';
      setHover({
        text: `${node.roomNumber ? `Room ${node.roomNumber}` : node.name || node.kind} · ${node.floor?.name || ''}`,
        x: Math.min(
          event.clientX - rect.left + 12,
          Math.max(8, rect.width - 190),
        ),
        y: event.clientY - rect.top - 32,
      });
    };
    const pointerUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (
        !down?.eligible ||
        Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5
      ) {
        down = null;
        return;
      }
      down = null;
      const hits = pick(event);
      const roomHit = hits.find((hit) => hit.object.userData.node);
      if (roomHit) {
        const node = roomHit.object.userData.node as MapNode;
        if (node.kind === 'stairs' || node.kind === 'elevator')
          callbacks.current.onFocusFloor(node.floor.id);
        else callbacks.current.onDestinationSelect(node);
        return;
      }
      const floorHit = hits.find((hit) => hit.object.userData.floor);
      if (floorHit) {
        const floor = floorHit.object.userData.floor as Floor;
        callbacks.current.onPlaceStart(
          floor.id,
          worldToPlan(
            [floorHit.point.x, floorHit.point.y, floorHit.point.z],
            floor,
          ),
        );
      }
    };
    const cancel = () => {
      down = null;
      pointers.clear();
      setHover(null);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (['+', '=', '-', '0'].includes(event.key)) event.preventDefault();
      if (event.key === '+' || event.key === '=')
        camera.zoom = Math.min(14, camera.zoom * 1.25);
      else if (event.key === '-')
        camera.zoom = Math.max(0.45, camera.zoom / 1.25);
      else if (event.key === '0') fit();
      camera.updateProjectionMatrix();
      state.dirty = true;
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      setFailure(
        'The 3D graphics connection was interrupted. Switch to 2D to continue your route.',
      );
    };
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('pointerleave', cancel);
    canvas.addEventListener('keydown', keyboard);
    canvas.addEventListener('webglcontextlost', contextLost);
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let lastRender = 0;
    const render = (time: number) => {
      controls.update();
      const animateFlow =
        state.flow && !reduceMotion.matches && time - lastRender >= 50;
      if (state.dirty || animateFlow) {
        if (state.flow && !reduceMotion.matches)
          state.flow.dot.position.copy(
            state.flow.path.getPoint((time / 18000) % 1),
          );
        renderer.render(scene, camera);
        state.dirty = false;
        lastRender = time;
      }
      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.removeEventListener('change', changed);
      controls.dispose();
      canvas.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('pointerleave', cancel);
      canvas.removeEventListener('keydown', keyboard);
      canvas.removeEventListener('webglcontextlost', contextLost);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      runtime.current = null;
    };
  }, []);

  useEffect(() => {
    const state = runtime.current;
    if (!state) return;
    let disposed = false;
    const body = new THREE.Group();
    state.root.add(body);
    state.pickables = [];
    state.flow = null;
    const textureResources = new Set<THREE.Texture>();
    const visibleFloors =
      scope === 'all'
        ? floors
        : floors.filter((floor) => floor.id === activeFloorId);
    const floorIds = new Set(visibleFloors.map((floor) => floor.id));
    const palette = ['#dbe6d4', '#d7e5df', '#dbe0ee'];
    for (const floor of visibleFloors) {
      const authored = model.floors.find((item) => item.floorId === floor.id);
      if (!authored) continue;
      const group = new THREE.Group();
      group.position.y = floorElevation(floor, floorGap);
      body.add(group);
      const shape = shapeFromPixels(authored.outline, authored.openings, floor);
      const slabGeometry = new THREE.ExtrudeGeometry(shape, {
        depth: 0.65,
        bevelEnabled: false,
        steps: 1,
        curveSegments: 4,
      });
      slabGeometry.translate(0, 0, -0.65);
      slabGeometry.rotateX(-Math.PI / 2);
      const slab = new THREE.Mesh(
        slabGeometry,
        new THREE.MeshStandardMaterial({
          color: palette[(floor.level - 1) % palette.length],
          roughness: 0.9,
        }),
      );
      group.add(slab);
      slab.userData.floor = floor;
      state.pickables.push(slab);
      const surfaceGeometry = new THREE.ShapeGeometry(shape);
      const vertices = surfaceGeometry.getAttribute('position'),
        uv = new Float32Array(vertices.count * 2);
      const scale = floor.pixelsPerMeter || 12;
      for (let i = 0; i < vertices.count; i++) {
        uv[i * 2] =
          (vertices.getX(i) * scale + floor.imageWidth / 2) / floor.imageWidth;
        uv[i * 2 + 1] =
          (vertices.getY(i) * scale + floor.imageHeight / 2) /
          floor.imageHeight;
      }
      surfaceGeometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      surfaceGeometry.rotateX(-Math.PI / 2);
      const surfaceMaterial = new THREE.MeshStandardMaterial({
        color: '#f7f8f2',
        roughness: 1,
        side: THREE.DoubleSide,
      });
      const surface = new THREE.Mesh(surfaceGeometry, surfaceMaterial);
      surface.position.y = 0.015;
      group.add(surface);
      surface.userData.floor = floor;
      state.pickables.push(surface);
      const url = resolvePlanUrl(floor.planImageUrl);
      if (url) {
        const texture = new THREE.TextureLoader().load(
          url,
          (loaded) => {
            if (disposed) {
              loaded.dispose();
              return;
            }
            loaded.colorSpace = THREE.SRGBColorSpace;
            loaded.anisotropy = Math.min(
              4,
              state.renderer.capabilities.getMaxAnisotropy(),
            );
            surfaceMaterial.map = loaded;
            surfaceMaterial.needsUpdate = true;
            state.dirty = true;
          },
          undefined,
          () => {
            if (!disposed) setImageNotice(true);
          },
        );
        textureResources.add(texture);
      }
      const walls = authored.walls.map((wall) => {
        const geometry = new THREE.ExtrudeGeometry(
          shapeFromPixels(wall.outline, wall.holes, floor),
          {
            depth: model.wallHeightMeters,
            bevelEnabled: false,
            steps: 1,
            curveSegments: 2,
          },
        );
        geometry.rotateX(-Math.PI / 2);
        return geometry;
      });
      if (walls.length) {
        const merged = mergeGeometries(walls, false);
        walls.forEach((geometry) => geometry.dispose());
        if (merged) {
          const wallMesh = new THREE.Mesh(
            merged,
            new THREE.MeshStandardMaterial({
              color: floor.id === activeFloorId ? '#c4d3c5' : '#b9cbbb',
              roughness: 0.95,
            }),
          );
          group.add(wallMesh);
        }
      }
      const floorLabel = labelSprite(`LEVEL ${floor.level}`, '#41644b', 18);
      if (floorLabel) {
        floorLabel.position.set(-84, 1.3, 0);
        group.add(floorLabel);
      }
      for (const node of nodes.filter((node) => node.floor?.id === floor.id)) {
        const isConnector = node.kind === 'stairs' || node.kind === 'elevator';
        const isRoom = ['room', 'entrance', 'restroom'].includes(node.kind);
        if (
          isConnector &&
          scope === 'all' &&
          !route?.legs.some((leg) =>
            leg.points.some((point) => point.nodeId === node.id),
          )
        )
          continue;
        if (!isConnector && !(scope === 'floor' && labels && isRoom)) continue;
        const position = planToWorld(
          { x: node.labelX ?? node.imageX, y: node.labelY ?? node.imageY },
          floor,
          0,
          isConnector ? 2 : 1.2,
        );
        const text = isConnector
          ? node.kind === 'stairs'
            ? 'STAIRS'
            : 'LIFT'
          : node.roomNumber || (node.kind === 'entrance' ? 'ENTRY' : 'WC');
        const sprite = labelSprite(
          text,
          isConnector
            ? node.kind === 'stairs'
              ? '#a47342'
              : '#6e66a6'
            : '#41654e',
          isConnector ? 7 : 6.8,
        );
        if (!sprite) continue;
        sprite.position.set(...position);
        sprite.userData.node = node;
        group.add(sprite);
        // Connector clicks focus their floor; only rooms are destination targets.
        if (isRoom || isConnector) state.pickables.push(sprite);
      }
    }
    const transformed = routeIn3D(route, floors, floorGap);
    const flowPath = new THREE.CurvePath<THREE.Vector3>();
    const appendFlow = (points: WorldPoint[]) => {
      for (let i = 1; i < points.length; i++) {
        const a = new THREE.Vector3(...points[i - 1]),
          b = new THREE.Vector3(...points[i]);
        if (a.distanceTo(b) > 0.001) flowPath.add(new THREE.LineCurve3(a, b));
      }
    };
    transformed.legs.forEach((leg, i) => {
      if (floorIds.has(leg.floorId)) {
        addPath(body, leg.points, '#27745b', 0.45);
        appendFlow(leg.points);
      }
      const transition = transformed.transitions.find(
        (item) => item.fromLegIndex === i,
      );
      if (scope === 'all' && transition) {
        addPath(
          body,
          transition.points,
          transition.kind === 'stairs' ? '#c18a4c' : '#8476bb',
          0.4,
          false,
        );
        appendFlow(transition.points);
        const a = new THREE.Vector3(...transition.points[0]),
          b = new THREE.Vector3(...transition.points[1]);
        const label = labelSprite(
          transition.kind === 'stairs' ? 'TAKE STAIRS' : 'TAKE LIFT',
          transition.kind === 'stairs' ? '#9c6d37' : '#7063a5',
          22,
        );
        if (label) {
          label.position.copy(a).add(b).multiplyScalar(0.5);
          label.position.x += 10;
          body.add(label);
        }
      }
    });
    // Flow bead is a direction cue, not the user's tracked position.
    if (flowPath.curves.length) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.62, 12, 8),
        new THREE.MeshBasicMaterial({ color: '#d3eeb8' }),
      );
      dot.position.copy(flowPath.getPoint(0));
      body.add(dot);
      state.flow = { dot, path: flowPath };
    }
    const marker = (
      floor: Floor,
      point: PixelPoint,
      text: string,
      color: string,
    ) => {
      if (!floorIds.has(floor.id)) return;
      const position = new THREE.Vector3(
        ...planToWorld(point, floor, floorGap, 0.7),
      );
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshBasicMaterial({ color }),
      );
      sphere.position.copy(position);
      body.add(sphere);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.65, 0.23, 6, 32),
        new THREE.MeshBasicMaterial({ color }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.copy(position);
      body.add(ring);
      const label = labelSprite(text, color, 17);
      if (label) {
        label.position.copy(position);
        label.position.y += 5;
        body.add(label);
      }
    };
    const startPoint =
      startX === undefined || startY === undefined
        ? null
        : { x: startX, y: startY };
    const startFloor = floors.find((floor) => floor.id === startFloorId);
    if (startFloor && startPoint) {
      marker(startFloor, startPoint, 'YOU ARE HERE', '#27745b');
      if (accuracyRadiusPx > 0 && floorIds.has(startFloor.id)) {
        const radius = accuracyRadiusPx / (startFloor.pixelsPerMeter || 12);
        const disk = new THREE.Mesh(
          new THREE.CircleGeometry(radius, 48),
          new THREE.MeshBasicMaterial({
            color: '#4c8c75',
            transparent: true,
            opacity: 0.15,
            depthWrite: false,
          }),
        );
        disk.rotation.x = -Math.PI / 2;
        disk.position.set(
          ...planToWorld(startPoint, startFloor, floorGap, 0.1),
        );
        body.add(disk);
      }
    }
    if (destination) {
      const floor = floors.find((floor) => floor.id === destination.floor?.id);
      if (floor)
        marker(
          floor,
          { x: destination.imageX, y: destination.imageY },
          destination.roomNumber
            ? `ROOM ${destination.roomNumber}`
            : destination.name || 'DESTINATION',
          '#bc7954',
        );
    }
    state.fit();
    state.dirty = true;
    return () => {
      disposed = true;
      state.flow = null;
      state.pickables = [];
      state.root.remove(body);
      disposeObject(body);
      textureResources.forEach((texture) => texture.dispose());
    };
  }, [
    floors,
    nodes,
    activeFloorId,
    route,
    startFloorId,
    startX,
    startY,
    destination,
    accuracyRadiusPx,
    floorGap,
    scope,
    labels,
  ]);

  const zoom = (factor: number) => {
    const state = runtime.current;
    if (!state) return;
    state.camera.zoom = Math.max(
      0.45,
      Math.min(14, state.camera.zoom * factor),
    );
    state.camera.updateProjectionMatrix();
    state.dirty = true;
  };
  const reset = () => {
    const state = runtime.current;
    if (!state) return;
    state.camera.position
      .copy(state.controls.target)
      .add(new THREE.Vector3(150, 165, 180));
    state.fit();
  };
  return (
    <div className="building-3d-view">
      <div ref={host} className="building-3d-canvas" />
      <p className="sr-only building-3d-summary" role="status">
        {scope === 'all'
          ? `Showing all ${floors.length} mapped floors in 3D.`
          : `Showing ${activeFloor?.name} in 3D.`}{' '}
        {route?.found
          ? `Route across ${route.floorsTraversed} floors. ${route.stepFree ? 'Step-free route using elevators.' : 'Use the directions panel to follow each floor.'}`
          : 'Choose a starting point and destination to display directions.'}
      </p>
      {failure ? (
        <div className="model-fallback" role="alert">
          <Box size={30} />
          <strong>Keep your journey going.</strong>
          <p>{failure}</p>
          <button className="primary-button" onClick={props.onFallback}>
            Return to 2D map
          </button>
        </div>
      ) : (
        <>
          <div className="model-toolbar">
            <div
              className="model-scope"
              role="group"
              aria-label="3D floor visibility"
            >
              <button
                aria-pressed={scope === 'all'}
                className={scope === 'all' ? 'selected' : ''}
                onClick={() => setScope('all')}
              >
                <Layers size={13} /> All floors
              </button>
              <button
                aria-pressed={scope === 'floor'}
                className={scope === 'floor' ? 'selected' : ''}
                onClick={() => setScope('floor')}
              >
                {activeFloor?.name || 'This floor'}
              </button>
            </div>
            <button
              className={`model-small-control ${separated ? 'selected' : ''}`}
              aria-pressed={separated}
              aria-label="Separate floors in 3D"
              onClick={() => setSeparated((value) => !value)}
            >
              <Layers size={14} />
              <span>{separated ? 'Separated' : 'Stacked'}</span>
            </button>
            <button
              className={`model-small-control ${labels ? 'selected' : ''}`}
              aria-pressed={labels}
              aria-label="Show 3D room labels"
              onClick={() => {
                setLabels((value) => !value);
                setScope('floor');
              }}
            >
              <Tag size={14} />
            </button>
          </div>
          <div className="model-caption">
            <span className="model-caption-icon">
              <Box size={18} />
            </span>
            <span>
              <strong>
                {route?.found
                  ? 'Your route, in a new dimension.'
                  : 'A new perspective on Grainger.'}
              </strong>
              <small>
                {scope === 'all' && separated
                  ? 'Floors separated for clarity. '
                  : ''}
                Drag to orbit · Scroll or pinch to zoom
              </small>
              <small>Plan-derived cutaway · Heights are approximate</small>
            </span>
          </div>
          <div className="model-zoom-controls">
            <button aria-label="Zoom 3D map in" onClick={() => zoom(1.3)}>
              <Plus size={17} />
            </button>
            <button aria-label="Zoom 3D map out" onClick={() => zoom(1 / 1.3)}>
              <Minus size={17} />
            </button>
            <button
              aria-label="Fit 3D building to view"
              onClick={() => runtime.current?.fit()}
            >
              <Crosshair size={17} />
            </button>
            <button aria-label="Reset 3D camera" onClick={reset}>
              <RotateCcw size={15} />
            </button>
          </div>
          {imageNotice && (
            <p className="model-image-notice" role="status">
              Some plan images could not load. The wall model and mapped route
              are still available.
            </p>
          )}
          {hover && (
            <div
              className="model-tooltip"
              style={{ left: hover.x, top: Math.max(55, hover.y) }}
              role="tooltip"
            >
              {hover.text}
            </div>
          )}
        </>
      )}
    </div>
  );
}
