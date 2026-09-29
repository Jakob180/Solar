import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './SolarHouse3D.css';

export interface SolarHouse3DProps {
  /** Dachausrichtung: 0° = Nord, 90° = Ost, 180° = Süd. */
  roofAzimuthDeg?: number;
  /** Dachneigung in Grad. */
  roofTiltDeg?: number;
  /** Konfigurierte Module; bis zu 36 werden als Instanzen gezeichnet. */
  panelCount?: number;
  /** Installierte Anlagenleistung. */
  installedKwp?: number;
  /** Momentanleistung steuert Leuchten und Geschwindigkeit des Energieflusses. */
  currentPowerKw?: number;
  /** Sonnenhöhe; unter 0° werden direkte Sonne und Strahlungsfluss ausgeblendet. */
  sunElevationDeg?: number;
  /** Sonnenazimut: 0° = Nord, 90° = Ost, 180° = Süd. */
  sunAzimuthDeg?: number;
  locationName?: string;
  /** Unterscheidet die animierte Vorschau von berechneten Ergebnisdaten. */
  hasResult?: boolean;
  loading?: boolean;
  className?: string;
}

interface SceneValues {
  roofAzimuthDeg: number;
  roofTiltDeg: number;
  panelCount: number;
  installedKwp: number;
  currentPowerKw?: number;
  sunElevationDeg: number;
  sunAzimuthDeg: number;
  hasResult: boolean;
  loading: boolean;
  reducedMotion: boolean;
}

interface SceneRuntime {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  houseRoot: THREE.Group;
  roofLeft: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  roofRight: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  gableGeometry: THREE.BufferGeometry;
  panels: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshPhysicalMaterial>;
  panelMaterial: THREE.MeshPhysicalMaterial;
  sun: THREE.Group;
  sunLight: THREE.DirectionalLight;
  hemisphereLight: THREE.HemisphereLight;
  directionArrow: THREE.ArrowHelper;
  radiationLines: Array<THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>>;
  radiationPoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  radiationPointPositions: Float32Array;
  radiationTargets: THREE.Vector3[];
  sunPosition: THREE.Vector3;
  values: SceneValues;
  roofAngle: number;
  ridgeHeight: number;
  elapsed: number;
  lastFrameTime: number;
  frameId: number | null;
  documentVisible: boolean;
  elementVisible: boolean;
  contextLost: boolean;
  disposed: boolean;
  start: () => void;
  stop: () => void;
  renderOnce: () => void;
}

const MAX_VISIBLE_PANELS = 36;
const HOUSE_WIDTH = 4.8;
const HOUSE_DEPTH = 3.6;
const WALL_HEIGHT = 2.05;
const HOUSE_FLOOR_Y = 0.1;
const ROOF_OVERHANG = 0.28;
const SUN_RADIUS = 8.2;
const RADIATION_LINE_COUNT = 3;
const PARTICLES_PER_LINE = 7;

const numberFormatter = new Intl.NumberFormat('de-AT', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const integerFormatter = new Intl.NumberFormat('de-AT', {
  maximumFractionDigits: 0,
});

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

const normalizeDegrees = (value: number) => ((value % 360) + 360) % 360;

const directionLabel = (azimuth: number) => {
  const directions = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
  return directions[Math.round(normalizeDegrees(azimuth) / 45) % directions.length];
};

const makeSceneValues = (
  roofAzimuthDeg: number,
  roofTiltDeg: number,
  panelCount: number,
  installedKwp: number | undefined,
  currentPowerKw: number | undefined,
  sunElevationDeg: number,
  sunAzimuthDeg: number,
  hasResult: boolean,
  loading: boolean,
  reducedMotion: boolean,
): SceneValues => {
  const safePanelCount = Math.max(0, Math.floor(Number.isFinite(panelCount) ? panelCount : 0));
  const fallbackKwp = safePanelCount * 0.45;
  return {
    roofAzimuthDeg: normalizeDegrees(roofAzimuthDeg),
    roofTiltDeg: clamp(roofTiltDeg, 0, 90),
    panelCount: safePanelCount,
    installedKwp:
      installedKwp !== undefined && Number.isFinite(installedKwp)
        ? Math.max(0, installedKwp)
        : fallbackKwp,
    currentPowerKw:
      currentPowerKw !== undefined && Number.isFinite(currentPowerKw)
        ? Math.max(0, currentPowerKw)
        : undefined,
    sunElevationDeg: clamp(sunElevationDeg, -90, 90),
    sunAzimuthDeg: normalizeDegrees(sunAzimuthDeg),
    hasResult,
    loading,
    reducedMotion,
  };
};

const sunVector = (azimuthDeg: number, elevationDeg: number) => {
  const azimuth = THREE.MathUtils.degToRad(normalizeDegrees(azimuthDeg));
  const elevation = THREE.MathUtils.degToRad(clamp(elevationDeg, -90, 90));
  const horizontal = Math.cos(elevation);
  // World convention: +X east, +Z north, +Y up.
  return new THREE.Vector3(
    horizontal * Math.sin(azimuth),
    Math.sin(elevation),
    horizontal * Math.cos(azimuth),
  );
};

const updateGableGeometry = (geometry: THREE.BufferGeometry, ridgeHeight: number) => {
  const halfWidth = HOUSE_WIDTH / 2;
  const halfDepth = HOUSE_DEPTH / 2;
  const wallTop = WALL_HEIGHT + HOUSE_FLOOR_Y;
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  positions.setXYZ(0, -halfWidth, wallTop, halfDepth);
  positions.setXYZ(1, halfWidth, wallTop, halfDepth);
  positions.setXYZ(2, 0, ridgeHeight, halfDepth);
  positions.setXYZ(3, halfWidth, wallTop, -halfDepth);
  positions.setXYZ(4, -halfWidth, wallTop, -halfDepth);
  positions.setXYZ(5, 0, ridgeHeight, -halfDepth);
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
};

const updateRoofAndPanels = (runtime: SceneRuntime) => {
  const { values, houseRoot, roofLeft, roofRight, panels } = runtime;
  // Very steep roofs are capped visually so the model remains useful; the HUD
  // continues to display the exact configured value up to 90°.
  const visualTilt = THREE.MathUtils.degToRad(Math.min(values.roofTiltDeg, 55));
  const halfWidth = HOUSE_WIDTH / 2;
  const roofRun = halfWidth + ROOF_OVERHANG;
  const ridgeRise = Math.min(Math.tan(visualTilt) * halfWidth, 3.5);
  const roofAngle = Math.atan2(ridgeRise, halfWidth);
  const ridgeHeight = WALL_HEIGHT + HOUSE_FLOOR_Y + ridgeRise;
  const roofSlopeLength = roofRun / Math.max(0.2, Math.cos(roofAngle));
  const roofDepth = HOUSE_DEPTH + ROOF_OVERHANG * 2;
  const centerDistance = roofSlopeLength / 2;

  runtime.roofAngle = roofAngle;
  runtime.ridgeHeight = ridgeHeight;
  updateGableGeometry(runtime.gableGeometry, ridgeHeight);

  roofRight.scale.set(roofSlopeLength, 1, roofDepth);
  roofRight.rotation.set(0, 0, -roofAngle);
  roofRight.position.set(
    centerDistance * Math.cos(roofAngle),
    ridgeHeight - centerDistance * Math.sin(roofAngle),
    0,
  );

  roofLeft.scale.set(roofSlopeLength, 1, roofDepth);
  roofLeft.rotation.set(0, 0, roofAngle);
  roofLeft.position.set(
    -centerDistance * Math.cos(roofAngle),
    ridgeHeight - centerDistance * Math.sin(roofAngle),
    0,
  );

  // Local +X is the normal direction of the occupied roof side. Rotating the
  // whole house maps it to the configured compass azimuth.
  houseRoot.rotation.y = THREE.MathUtils.degToRad(values.roofAzimuthDeg - 90);

  const visibleCount = Math.min(values.panelCount, MAX_VISIBLE_PANELS);
  panels.count = visibleCount;
  if (visibleCount > 0) {
    const columns = Math.min(6, Math.max(1, Math.ceil(Math.sqrt(visibleCount * 1.45))));
    const rows = Math.max(1, Math.ceil(visibleCount / columns));
    const usableDepth = roofDepth - 0.48;
    const usableSlope = Math.max(0.4, roofSlopeLength - 0.58);
    const depthSlot = usableDepth / columns;
    const slopeSlot = usableSlope / rows;
    const roofNormal = new THREE.Vector3(Math.sin(roofAngle), Math.cos(roofAngle), 0);
    const dummy = new THREE.Object3D();

    for (let index = 0; index < visibleCount; index += 1) {
      const row = Math.floor(index / columns);
      const indexInRow = index % columns;
      const panelsInRow = Math.min(columns, visibleCount - row * columns);
      const slopeDistance = 0.29 + (row + 0.5) * slopeSlot;
      const z = (indexInRow - (panelsInRow - 1) / 2) * depthSlot;
      dummy.position.set(
        slopeDistance * Math.cos(roofAngle) + roofNormal.x * 0.105,
        ridgeHeight - slopeDistance * Math.sin(roofAngle) + roofNormal.y * 0.105,
        z,
      );
      dummy.rotation.set(0, 0, -roofAngle);
      dummy.scale.set(slopeSlot * 0.79, 0.075, depthSlot * 0.82);
      dummy.updateMatrix();
      panels.setMatrixAt(index, dummy.matrix);
    }
    panels.instanceMatrix.needsUpdate = true;
    panels.computeBoundingSphere();
  }

  const direction = new THREE.Vector3(
    Math.sin(THREE.MathUtils.degToRad(values.roofAzimuthDeg)),
    0,
    Math.cos(THREE.MathUtils.degToRad(values.roofAzimuthDeg)),
  );
  runtime.directionArrow.setDirection(direction.normalize());

  houseRoot.updateMatrixWorld(true);
  const targetSlopeDistance = Math.min(roofSlopeLength * 0.58, roofSlopeLength - 0.2);
  const targetNormal = new THREE.Vector3(Math.sin(roofAngle), Math.cos(roofAngle), 0);
  const targetDepths = [-roofDepth * 0.28, 0, roofDepth * 0.28];
  runtime.radiationTargets = targetDepths.map((z) => {
    const localPoint = new THREE.Vector3(
      targetSlopeDistance * Math.cos(roofAngle) + targetNormal.x * 0.14,
      ridgeHeight - targetSlopeDistance * Math.sin(roofAngle) + targetNormal.y * 0.14,
      z,
    );
    return houseRoot.localToWorld(localPoint);
  });
};

const setRadiationEndpoints = (runtime: SceneRuntime) => {
  runtime.radiationLines.forEach((line, index) => {
    const target = runtime.radiationTargets[index] ?? runtime.radiationTargets[0];
    const positions = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    positions.setXYZ(0, runtime.sunPosition.x, runtime.sunPosition.y, runtime.sunPosition.z);
    positions.setXYZ(1, target.x, target.y, target.z);
    positions.needsUpdate = true;
    line.computeLineDistances();
  });
};

const updateSun = (
  runtime: SceneRuntime,
  azimuthDeg = runtime.values.sunAzimuthDeg,
  elevationDeg = runtime.values.sunElevationDeg,
) => {
  const daylight = elevationDeg > 0;
  const vector = sunVector(azimuthDeg, elevationDeg);
  runtime.sunPosition.copy(vector.multiplyScalar(SUN_RADIUS));
  runtime.sunPosition.y += 0.35;
  runtime.sun.position.copy(runtime.sunPosition);
  runtime.sun.visible = daylight;
  runtime.sunLight.visible = daylight;
  runtime.sunLight.position.copy(runtime.sunPosition);
  runtime.sunLight.intensity = daylight
    ? 1.15 + clamp(elevationDeg / 90, 0, 1) * 1.15
    : 0;
  runtime.hemisphereLight.intensity = daylight ? 1.35 : 0.5;
  setRadiationEndpoints(runtime);
};

const updateRadiationAppearance = (runtime: SceneRuntime) => {
  const { values } = runtime;
  const daylight = values.sunElevationDeg > 0;
  const hasPower = values.currentPowerKw === undefined || values.currentPowerKw > 0.01;
  const flowVisible = daylight && values.panelCount > 0 && hasPower;
  const powerRatio =
    values.currentPowerKw === undefined
      ? 0.58
      : clamp(values.currentPowerKw / Math.max(values.installedKwp, 0.1), 0, 1.2);

  runtime.panelMaterial.emissiveIntensity = flowVisible ? 0.08 + powerRatio * 0.5 : 0.02;
  runtime.radiationLines.forEach((line) => {
    line.visible = flowVisible;
    line.material.opacity = 0.2 + powerRatio * 0.42;
  });
  runtime.radiationPoints.visible = flowVisible;
  runtime.radiationPoints.material.opacity = 0.35 + powerRatio * 0.62;
  runtime.radiationPoints.material.size = 0.075 + powerRatio * 0.085;
};

const hasVisibleRadiation = (values: SceneValues) =>
  values.sunElevationDeg > 0 &&
  values.panelCount > 0 &&
  (values.currentPowerKw === undefined || values.currentPowerKw > 0.01);

const needsContinuousAnimation = (values: SceneValues) =>
  !values.reducedMotion && (!values.hasResult || hasVisibleRadiation(values));

const updateRadiationParticles = (runtime: SceneRuntime, animate: boolean) => {
  const positions = runtime.radiationPointPositions;
  const speed = runtime.values.currentPowerKw === undefined
    ? 0.28
    : 0.18 + clamp(runtime.values.currentPowerKw / Math.max(runtime.values.installedKwp, 0.1), 0, 1.2) * 0.28;
  const point = new THREE.Vector3();
  let particleIndex = 0;

  runtime.radiationTargets.forEach((target, lineIndex) => {
    for (let index = 0; index < PARTICLES_PER_LINE; index += 1) {
      const phase = index / PARTICLES_PER_LINE + lineIndex * 0.11;
      const progress = animate ? (runtime.elapsed * speed + phase) % 1 : phase;
      point.lerpVectors(runtime.sunPosition, target, progress);
      const baseIndex = particleIndex * 3;
      positions[baseIndex] = point.x;
      positions[baseIndex + 1] = point.y;
      positions[baseIndex + 2] = point.z;
      particleIndex += 1;
    }
  });
  const attribute = runtime.radiationPoints.geometry.getAttribute('position') as THREE.BufferAttribute;
  attribute.needsUpdate = true;
};

const applySceneValues = (runtime: SceneRuntime, values: SceneValues) => {
  runtime.values = values;
  runtime.controls.autoRotate = !values.reducedMotion && !values.hasResult;
  runtime.controls.enableDamping = needsContinuousAnimation(values);
  runtime.controls.autoRotateSpeed = 0.34;
  updateRoofAndPanels(runtime);
  updateSun(runtime);
  updateRadiationAppearance(runtime);
  updateRadiationParticles(runtime, false);

  if (needsContinuousAnimation(values)) {
    runtime.start();
  } else {
    runtime.stop();
    runtime.renderOnce();
  }
};

const createGlowTexture = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const gradient = context.createRadialGradient(64, 64, 5, 64, 64, 62);
  gradient.addColorStop(0, 'rgba(255, 247, 176, 1)');
  gradient.addColorStop(0.25, 'rgba(239, 179, 38, 0.72)');
  gradient.addColorStop(1, 'rgba(239, 179, 38, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

const disposeScene = (scene: THREE.Scene) => {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  scene.traverse((object) => {
    const renderable = object as THREE.Mesh | THREE.Line | THREE.Points;
    if (renderable.geometry instanceof THREE.BufferGeometry) geometries.add(renderable.geometry);
    const objectMaterial = (renderable as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!objectMaterial) return;
    const materialList = Array.isArray(objectMaterial) ? objectMaterial : [objectMaterial];
    materialList.forEach((material) => {
      materials.add(material);
      Object.values(material).forEach((value) => {
        if (value instanceof THREE.Texture) textures.add(value);
      });
    });
  });

  textures.forEach((texture) => texture.dispose());
  materials.forEach((material) => material.dispose());
  geometries.forEach((geometry) => geometry.dispose());
};

function SolarHouse3DComponent({
  roofAzimuthDeg = 180,
  roofTiltDeg = 35,
  panelCount = 12,
  installedKwp,
  currentPowerKw,
  sunElevationDeg = 38,
  sunAzimuthDeg = 180,
  locationName,
  hasResult = false,
  loading = false,
  className = '',
}: SolarHouse3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const [webglError, setWebglError] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const descriptionId = `solar-house-${useId().replace(/:/g, '')}`;

  const safeAzimuth = normalizeDegrees(roofAzimuthDeg);
  const safeTilt = clamp(roofTiltDeg, 0, 90);
  const safePanelCount = Math.max(0, Math.floor(Number.isFinite(panelCount) ? panelCount : 0));
  const safeElevation = clamp(sunElevationDeg, -90, 90);
  const safeKwp =
    installedKwp !== undefined && Number.isFinite(installedKwp)
      ? Math.max(0, installedKwp)
      : safePanelCount * 0.45;
  const daylight = safeElevation > 0;
  const powerActive = daylight && (currentPowerKw === undefined || currentPowerKw > 0.01);
  const statusText = loading
    ? 'Modell wird aktualisiert'
    : !hasResult
      ? 'Animierte Konfigurationsvorschau'
      : powerActive
        ? 'Solarertrag aktiv'
        : daylight
          ? 'Sonnenlicht verfügbar'
          : 'Sonne unter dem Horizont';
  const accessibleLabel = [
    `Interaktives 3D-Solarmodell mit ${safePanelCount} Modulen`,
    `Dachausrichtung ${directionLabel(safeAzimuth)} bei ${integerFormatter.format(safeAzimuth)} Grad`,
    `Dachneigung ${integerFormatter.format(safeTilt)} Grad`,
    `Sonnenhöhe ${numberFormatter.format(safeElevation)} Grad`,
    `${statusText}.`,
  ].join('. ');

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setReducedMotion(mediaQuery.matches);
    updatePreference();
    mediaQuery.addEventListener('change', updatePreference);
    return () => mediaQuery.removeEventListener('change', updatePreference);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let renderer: THREE.WebGLRenderer | null = null;
    let controls: OrbitControls | null = null;
    let sceneForCleanup: THREE.Scene | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let intersectionObserver: IntersectionObserver | null = null;
    let runtime: SceneRuntime | null = null;

    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.08;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.className = 'solar-house-3d__canvas';
      renderer.domElement.setAttribute('aria-hidden', 'true');
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      sceneForCleanup = scene;
      scene.fog = new THREE.Fog(0xf2f5e9, 15, 29);

      const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 80);
      camera.position.set(8.7, 6.3, 9.7);

      controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(0, 1.35, 0);
      controls.enableZoom = true;
      controls.enablePan = true;
      controls.screenSpacePanning = true;
      controls.minDistance = 6.4;
      controls.maxDistance = 18;
      controls.minPolarAngle = THREE.MathUtils.degToRad(24);
      controls.maxPolarAngle = THREE.MathUtils.degToRad(83);
      controls.minTargetRadius = 0;
      controls.maxTargetRadius = 1.6;
      controls.saveState();

      const hemisphereLight = new THREE.HemisphereLight(0xfff8d9, 0x526150, 1.35);
      scene.add(hemisphereLight);
      const fillLight = new THREE.DirectionalLight(0xcde1ff, 0.55);
      fillLight.position.set(-6, 7, -5);
      scene.add(fillLight);

      const sunLight = new THREE.DirectionalLight(0xffe29a, 2.1);
      sunLight.castShadow = true;
      sunLight.shadow.mapSize.set(1024, 1024);
      sunLight.shadow.camera.near = 1;
      sunLight.shadow.camera.far = 25;
      sunLight.shadow.camera.left = -7;
      sunLight.shadow.camera.right = 7;
      sunLight.shadow.camera.top = 7;
      sunLight.shadow.camera.bottom = -7;
      sunLight.target.position.set(0, 1.2, 0);
      scene.add(sunLight, sunLight.target);

      const ground = new THREE.Mesh(
        new THREE.CylinderGeometry(6.7, 6.9, 0.16, 72),
        new THREE.MeshStandardMaterial({ color: 0xcad8b9, roughness: 0.93 }),
      );
      ground.position.y = -0.12;
      ground.receiveShadow = true;
      scene.add(ground);

      const grid = new THREE.GridHelper(12.6, 18, 0x839578, 0xaebda1);
      grid.position.y = -0.025;
      const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
      gridMaterials.forEach((material) => {
        material.transparent = true;
        material.opacity = 0.18;
      });
      scene.add(grid);

      const compassRing = new THREE.Mesh(
        new THREE.RingGeometry(0.72, 0.75, 48),
        new THREE.MeshBasicMaterial({ color: 0x66745e, transparent: true, opacity: 0.42, side: THREE.DoubleSide }),
      );
      compassRing.rotation.x = -Math.PI / 2;
      compassRing.position.set(-4.25, 0.015, 3.35);
      scene.add(compassRing);
      const northMarker = new THREE.Mesh(
        new THREE.ConeGeometry(0.1, 0.34, 12),
        new THREE.MeshBasicMaterial({ color: 0x4f5d49 }),
      );
      northMarker.rotation.x = Math.PI / 2;
      northMarker.position.set(-4.25, 0.08, 4.15);
      scene.add(northMarker);

      const directionArrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 0, -1),
        new THREE.Vector3(-4.25, 0.09, 3.35),
        0.62,
        0xca8e00,
        0.2,
        0.13,
      );
      scene.add(directionArrow);

      const houseRoot = new THREE.Group();
      scene.add(houseRoot);

      const foundation = new THREE.Mesh(
        new THREE.BoxGeometry(HOUSE_WIDTH + 0.14, 0.18, HOUSE_DEPTH + 0.14),
        new THREE.MeshStandardMaterial({ color: 0xb8b7aa, roughness: 0.94 }),
      );
      foundation.position.y = 0.03;
      foundation.receiveShadow = true;
      foundation.castShadow = true;
      houseRoot.add(foundation);

      const walls = new THREE.Mesh(
        new THREE.BoxGeometry(HOUSE_WIDTH, WALL_HEIGHT, HOUSE_DEPTH),
        new THREE.MeshStandardMaterial({ color: 0xf1edda, roughness: 0.9 }),
      );
      walls.position.y = WALL_HEIGHT / 2 + 0.1;
      walls.castShadow = true;
      walls.receiveShadow = true;
      houseRoot.add(walls);

      const gableGeometry = new THREE.BufferGeometry();
      gableGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(18), 3).setUsage(THREE.DynamicDrawUsage),
      );
      const gables = new THREE.Mesh(
        gableGeometry,
        new THREE.MeshStandardMaterial({ color: 0xe4dfcc, roughness: 0.9, side: THREE.DoubleSide }),
      );
      gables.castShadow = true;
      houseRoot.add(gables);

      const roofGeometry = new THREE.BoxGeometry(1, 0.12, 1);
      const roofRight = new THREE.Mesh(
        roofGeometry,
        new THREE.MeshStandardMaterial({ color: 0x25362d, roughness: 0.78, metalness: 0.02 }),
      );
      const roofLeft = new THREE.Mesh(
        roofGeometry,
        new THREE.MeshStandardMaterial({ color: 0x34483c, roughness: 0.8, metalness: 0.02 }),
      );
      [roofRight, roofLeft].forEach((roof) => {
        roof.castShadow = true;
        roof.receiveShadow = true;
        houseRoot.add(roof);
      });

      const panelMaterial = new THREE.MeshPhysicalMaterial({
        color: 0x173647,
        roughness: 0.34,
        metalness: 0.28,
        clearcoat: 0.62,
        clearcoatRoughness: 0.25,
        emissive: 0x174b62,
        emissiveIntensity: 0.16,
      });
      const panels = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        panelMaterial,
        MAX_VISIBLE_PANELS,
      );
      panels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      panels.castShadow = true;
      panels.receiveShadow = true;
      houseRoot.add(panels);

      const doorMaterial = new THREE.MeshStandardMaterial({ color: 0x765a40, roughness: 0.78 });
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.45, 0.09), doorMaterial);
      door.position.set(0.72, 0.82, HOUSE_DEPTH / 2 + 0.055);
      door.castShadow = true;
      houseRoot.add(door);
      const handle = new THREE.Mesh(
        new THREE.SphereGeometry(0.045, 10, 10),
        new THREE.MeshStandardMaterial({ color: 0xe0ba55, metalness: 0.65, roughness: 0.3 }),
      );
      handle.position.set(1.02, 0.83, HOUSE_DEPTH / 2 + 0.12);
      houseRoot.add(handle);

      const windowMaterial = new THREE.MeshPhysicalMaterial({
        color: 0x9bc6d5,
        roughness: 0.14,
        metalness: 0.08,
        transparent: true,
        opacity: 0.82,
      });
      const frontWindow = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.78, 0.08), windowMaterial);
      frontWindow.position.set(-1.03, 1.18, HOUSE_DEPTH / 2 + 0.055);
      houseRoot.add(frontWindow);
      const sideWindow = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.78, 1.08), windowMaterial);
      sideWindow.position.set(HOUSE_WIDTH / 2 + 0.055, 1.18, 0.45);
      houseRoot.add(sideWindow);

      const sun = new THREE.Group();
      const sunSphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.39, 24, 24),
        new THREE.MeshBasicMaterial({ color: 0xffd958 }),
      );
      sun.add(sunSphere);
      const glowTexture = createGlowTexture();
      if (glowTexture) {
        const glow = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: glowTexture,
            color: 0xffdc68,
            transparent: true,
            opacity: 0.82,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        glow.scale.set(2.45, 2.45, 1);
        sun.add(glow);
      }
      scene.add(sun);

      const radiationLines: SceneRuntime['radiationLines'] = [];
      for (let index = 0; index < RADIATION_LINE_COUNT; index += 1) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
        const material = new THREE.LineDashedMaterial({
          color: 0xf0b52c,
          transparent: true,
          opacity: 0.55,
          dashSize: 0.18,
          gapSize: 0.16,
          depthWrite: false,
        });
        const line = new THREE.Line(geometry, material);
        line.frustumCulled = false;
        radiationLines.push(line);
        scene.add(line);
      }

      const radiationPointPositions = new Float32Array(
        RADIATION_LINE_COUNT * PARTICLES_PER_LINE * 3,
      );
      const radiationPointGeometry = new THREE.BufferGeometry();
      radiationPointGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(radiationPointPositions, 3),
      );
      const radiationPoints = new THREE.Points(
        radiationPointGeometry,
        new THREE.PointsMaterial({
          color: 0xffc947,
          size: 0.12,
          sizeAttenuation: true,
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      radiationPoints.frustumCulled = false;
      scene.add(radiationPoints);

      const initialValues = makeSceneValues(
        roofAzimuthDeg,
        roofTiltDeg,
        panelCount,
        installedKwp,
        currentPowerKw,
        sunElevationDeg,
        sunAzimuthDeg,
        hasResult,
        loading,
        reducedMotion,
      );

      runtime = {
        scene,
        camera,
        renderer,
        controls,
        houseRoot,
        roofLeft,
        roofRight,
        gableGeometry,
        panels,
        panelMaterial,
        sun,
        sunLight,
        hemisphereLight,
        directionArrow,
        radiationLines,
        radiationPoints,
        radiationPointPositions,
        radiationTargets: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
        sunPosition: new THREE.Vector3(),
        values: initialValues,
        roofAngle: 0,
        ridgeHeight: WALL_HEIGHT,
        elapsed: 0,
        lastFrameTime: performance.now(),
        frameId: null,
        documentVisible: !document.hidden,
        elementVisible: true,
        contextLost: false,
        disposed: false,
        start: () => undefined,
        stop: () => undefined,
        renderOnce: () => undefined,
      };

      const renderFrame = (time: number) => {
        if (
          !runtime || runtime.disposed || !runtime.documentVisible || !runtime.elementVisible ||
          !needsContinuousAnimation(runtime.values)
        ) {
          if (runtime) runtime.frameId = null;
          return;
        }

        const delta = Math.min(0.05, Math.max(0, (time - runtime.lastFrameTime) / 1000));
        runtime.lastFrameTime = time;
        runtime.elapsed += delta;

        if (!runtime.values.reducedMotion) {
          if (!runtime.values.hasResult) {
            const idleAzimuth = runtime.values.sunAzimuthDeg + Math.sin(runtime.elapsed * 0.19) * 16;
            const idleElevation = runtime.values.sunElevationDeg + Math.sin(runtime.elapsed * 0.27) * 4;
            updateSun(runtime, idleAzimuth, idleElevation);
          }
          updateRadiationParticles(runtime, true);
          runtime.controls.update(delta);
        }

        runtime.renderer.render(runtime.scene, runtime.camera);
        runtime.frameId = needsContinuousAnimation(runtime.values)
          ? window.requestAnimationFrame(renderFrame)
          : null;
      };

      runtime.start = () => {
        if (
          !runtime || runtime.disposed || !needsContinuousAnimation(runtime.values) ||
          !runtime.documentVisible || !runtime.elementVisible || runtime.contextLost || runtime.frameId !== null
        ) return;
        runtime.lastFrameTime = performance.now();
        runtime.frameId = window.requestAnimationFrame(renderFrame);
      };
      runtime.stop = () => {
        if (!runtime || runtime.frameId === null) return;
        window.cancelAnimationFrame(runtime.frameId);
        runtime.frameId = null;
      };
      runtime.renderOnce = () => {
        if (
          !runtime || runtime.disposed || runtime.contextLost ||
          !runtime.documentVisible || !runtime.elementVisible
        ) return;
        runtime.controls.update(0);
        runtime.renderer.render(runtime.scene, runtime.camera);
      };

      runtimeRef.current = runtime;
      applySceneValues(runtime, initialValues);

      const resize = () => {
        if (!runtime || runtime.disposed) return;
        const { width, height } = host.getBoundingClientRect();
        if (width <= 0 || height <= 0) return;
        runtime.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        runtime.renderer.setSize(Math.round(width), Math.round(height), false);
        runtime.camera.aspect = width / height;
        runtime.camera.updateProjectionMatrix();
        runtime.renderOnce();
      };
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
      resize();

      const handleControlsChange = () => {
        if (
          !runtime || runtime.frameId !== null || runtime.disposed || runtime.contextLost ||
          !runtime.documentVisible || !runtime.elementVisible
        ) return;
        // OrbitControls dispatches `change` from inside update(). Calling
        // renderOnce() here would call update() again and recurse indefinitely.
        runtime.renderer.render(runtime.scene, runtime.camera);
      };
      controls.addEventListener('change', handleControlsChange);

      const handleVisibility = () => {
        if (!runtime) return;
        runtime.documentVisible = !document.hidden;
        if (!runtime.documentVisible) {
          runtime.stop();
        } else if (needsContinuousAnimation(runtime.values)) {
          runtime.start();
        } else {
          runtime.renderOnce();
        }
      };
      document.addEventListener('visibilitychange', handleVisibility);

      if ('IntersectionObserver' in window) {
        intersectionObserver = new IntersectionObserver(
          ([entry]) => {
            if (!runtime) return;
            runtime.elementVisible = entry?.isIntersecting ?? true;
            if (!runtime.elementVisible) {
              runtime.stop();
            } else if (needsContinuousAnimation(runtime.values)) {
              runtime.start();
            } else {
              runtime.renderOnce();
            }
          },
          { rootMargin: '120px' },
        );
        intersectionObserver.observe(host);
      }

      const handleContextLost = (event: Event) => {
        event.preventDefault();
        if (runtime) {
          runtime.contextLost = true;
          runtime.stop();
        }
        setWebglError('Der 3D-Grafikkontext wurde unterbrochen. Laden Sie die Seite neu, um die Ansicht wiederherzustellen.');
      };
      renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
      setWebglError(null);

      return () => {
        if (!runtime) return;
        runtime.disposed = true;
        runtime.stop();
        resizeObserver?.disconnect();
        intersectionObserver?.disconnect();
        document.removeEventListener('visibilitychange', handleVisibility);
        controls?.removeEventListener('change', handleControlsChange);
        renderer?.domElement.removeEventListener('webglcontextlost', handleContextLost);
        controls?.dispose();
        disposeScene(scene);
        renderer?.dispose();
        if (renderer?.domElement.parentElement === host) host.removeChild(renderer.domElement);
        if (runtimeRef.current === runtime) runtimeRef.current = null;
      };
    } catch (error) {
      controls?.dispose();
      if (sceneForCleanup) disposeScene(sceneForCleanup);
      renderer?.dispose();
      if (renderer?.domElement.parentElement === host) host.removeChild(renderer.domElement);
      const detail = error instanceof Error ? error.message : 'Unbekannter Grafikfehler';
      setWebglError(`WebGL ist auf diesem Gerät nicht verfügbar (${detail}).`);
      return undefined;
    }
    // Three is deliberately initialized once. Live props are handled below.
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    applySceneValues(
      runtime,
      makeSceneValues(
        roofAzimuthDeg,
        roofTiltDeg,
        panelCount,
        installedKwp,
        currentPowerKw,
        sunElevationDeg,
        sunAzimuthDeg,
        hasResult,
        loading,
        reducedMotion,
      ),
    );
  }, [
    currentPowerKw,
    hasResult,
    installedKwp,
    loading,
    panelCount,
    reducedMotion,
    roofAzimuthDeg,
    roofTiltDeg,
    sunAzimuthDeg,
    sunElevationDeg,
  ]);

  const resetView = () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.controls.reset();
    runtime.renderOnce();
  };

  const focusSceneOnPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.focus({ preventScroll: true });
  };

  const handleSceneKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.contextLost || event.altKey || event.ctrlKey || event.metaKey) return;

    const rotationStep = THREE.MathUtils.degToRad(7.5);
    const panStep = 22;
    let handled = true;

    switch (event.key) {
      case 'ArrowLeft':
        if (event.shiftKey) runtime.controls.pan(panStep, 0);
        else runtime.controls.rotateLeft(rotationStep);
        break;
      case 'ArrowRight':
        if (event.shiftKey) runtime.controls.pan(-panStep, 0);
        else runtime.controls.rotateLeft(-rotationStep);
        break;
      case 'ArrowUp':
        if (event.shiftKey) runtime.controls.pan(0, panStep);
        else runtime.controls.rotateUp(rotationStep);
        break;
      case 'ArrowDown':
        if (event.shiftKey) runtime.controls.pan(0, -panStep);
        else runtime.controls.rotateUp(-rotationStep);
        break;
      case '+':
      case '=':
      case 'Add':
        runtime.controls.dollyIn(0.86);
        break;
      case '-':
      case '_':
      case 'Subtract':
        runtime.controls.dollyOut(0.86);
        break;
      case 'Home':
        runtime.controls.reset();
        break;
      default:
        handled = false;
    }

    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
    runtime.controls.update(0);
    if (
      runtime.frameId === null && runtime.documentVisible &&
      runtime.elementVisible && !runtime.disposed
    ) {
      runtime.renderer.render(runtime.scene, runtime.camera);
    }
  };

  return (
    <figure
      className={`solar-house-3d ${loading ? 'solar-house-3d--loading' : ''} ${className}`.trim()}
      role="group"
      aria-label={accessibleLabel}
      aria-describedby={descriptionId}
      aria-busy={loading}
    >
      <div className="solar-house-3d__viewport">
        <div
          ref={hostRef}
          className="solar-house-3d__canvas-host"
          role="application"
          tabIndex={webglError ? -1 : 0}
          aria-label="Interaktive 3D-Hausansicht"
          aria-describedby={descriptionId}
          aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight = - Home"
          onKeyDown={handleSceneKeyDown}
          onPointerDown={focusSceneOnPointerDown}
        />

        {webglError && (
          <div className="solar-house-3d__fallback" role="status">
            <div className="solar-house-3d__fallback-picture" aria-hidden="true">
              <i className="solar-house-3d__fallback-sun" />
              <i className="solar-house-3d__fallback-roof"><b /><b /><b /></i>
              <i className="solar-house-3d__fallback-home" />
            </div>
            <strong>3D-Ansicht nicht verfügbar</strong>
            <span>{webglError}</span>
            <small>Die Berechnung und alle Kennzahlen funktionieren weiterhin.</small>
          </div>
        )}

        <div className="solar-house-3d__topline" aria-hidden="true">
          <span className="solar-house-3d__live"><i /> {hasResult ? 'Live-Modell' : 'Vorschau'}</span>
          {locationName && <span className="solar-house-3d__location">{locationName}</span>}
        </div>

        {!webglError && (
          <button
            type="button"
            className="solar-house-3d__reset"
            onClick={resetView}
            aria-label="3D-Ansicht auf Ausgangsposition zurücksetzen"
            title="Ansicht zurücksetzen"
          >
            <span aria-hidden="true">↺</span> Ansicht
          </button>
        )}

        <div className="solar-house-3d__metrics" aria-hidden="true">
          <span><small>Ausrichtung</small><strong>{directionLabel(safeAzimuth)} · {integerFormatter.format(safeAzimuth)}°</strong></span>
          <span><small>Dachneigung</small><strong>{integerFormatter.format(safeTilt)}°</strong></span>
          <span><small>PV-Anlage</small><strong>{numberFormatter.format(safeKwp)} kWp</strong></span>
          {currentPowerKw !== undefined && Number.isFinite(currentPowerKw) && (
            <span className="solar-house-3d__power"><small>Jetzt</small><strong>{numberFormatter.format(Math.max(0, currentPowerKw))} kW</strong></span>
          )}
        </div>

        {safePanelCount > MAX_VISIBLE_PANELS && (
          <span className="solar-house-3d__panel-note" aria-hidden="true">
            {MAX_VISIBLE_PANELS} von {safePanelCount} Modulen schematisch
          </span>
        )}
        <span className="solar-house-3d__status" aria-hidden="true">
          <i className={powerActive ? 'is-active' : ''} /> {statusText}
        </span>
        {!webglError && (
          <span className="solar-house-3d__controls-hint" aria-hidden="true">
            <span className="solar-house-3d__desktop-hint">Maus: drehen/zoomen · Tastatur: Pfeile, +/−, Shift+Pfeile, Home</span>
            <span className="solar-house-3d__touch-hint">Ziehen: drehen · Zwei Finger: zoomen</span>
          </span>
        )}
      </div>
      <figcaption id={descriptionId} className="solar-house-3d__sr-only">
        {accessibleLabel} Maus oder Finger bewegen die Ansicht. Zoomen ist mit Mausrad oder Zwei-Finger-Geste möglich.
        Tastatur: Pfeiltasten drehen die Ansicht, Plus und Minus zoomen, Umschalttaste mit Pfeiltasten verschiebt die Ansicht,
        Home oder Pos1 setzt die Ansicht zurück.
      </figcaption>
    </figure>
  );
}

export const SolarHouse3D = memo(SolarHouse3DComponent);
export default SolarHouse3D;
