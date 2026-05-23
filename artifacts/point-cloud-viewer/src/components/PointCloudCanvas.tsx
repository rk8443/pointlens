import { useRef, useEffect } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ViewportGizmo } from "three-viewport-gizmo";
import { PointCloudData } from "../lib/point-cloud";

export type ViewPreset = "iso" | "front" | "back" | "left" | "right" | "top" | "bottom";

export interface ViewController {
  fit: () => void;
  setView: (preset: ViewPreset) => void;
}

interface PointCloudCanvasProps {
  data: PointCloudData | null;
  pointSize: number;
  colorMode: "height" | "intensity" | "uniform";
  heightRange?: [number, number]; // [zMin, zMax] world-space for height coloring
  clipEnabled?: boolean; // when true, hide points whose Z is outside heightRange
  onReady?: (ctrl: ViewController) => void;
}

// Build a sorted sample of Z values inside [zLo, zHi]. Used to histogram-equalize
// the height color map: every hue bucket gets ~equal point count, so the rainbow
// shows up even for distributions that cluster heavily around the mean (very
// common with LMI flat-surface scans).
function buildZQuantileTable(data: PointCloudData, zLo: number, zHi: number): Float32Array {
  const n = data.pointCount;
  const maxSamples = 4000;
  const stride = Math.max(1, Math.floor(n / maxSamples));
  const buf: number[] = [];
  for (let i = 0; i < n; i += stride) {
    const z = data.positions[i * 3 + 2];
    if (z >= zLo && z <= zHi) buf.push(z);
  }
  if (buf.length < 2) return new Float32Array([zLo, zHi]);
  buf.sort((a, b) => a - b);
  return Float32Array.from(buf);
}

// Binary search: fraction of `table` entries <= z, in [0,1].
function quantileOf(table: Float32Array, z: number): number {
  let lo = 0;
  let hi = table.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (table[mid] < z) lo = mid + 1;
    else hi = mid;
  }
  return lo / (table.length - 1);
}

function buildColors(
  data: PointCloudData,
  colorMode: "height" | "intensity" | "uniform",
  heightRange?: [number, number],
): Float32Array {
  const colors = new Float32Array(data.pointCount * 3);
  const color = new THREE.Color();
  const { min, max } = data.boundingBox;
  const [zLo, zHi] = heightRange ?? [min[2], max[2]];

  // Pre-build the equalization table once for the whole point cloud (only for
  // height mode). This stretches the rainbow across the actual point density,
  // not the raw Z span.
  const qTable = colorMode === "height" ? buildZQuantileTable(data, zLo, zHi) : null;

  for (let i = 0; i < data.pointCount; i++) {
    if (colorMode === "height" && qTable) {
      const z = data.positions[i * 3 + 2];
      let t: number;
      if (z <= zLo) t = 0;
      else if (z >= zHi) t = 1;
      else t = quantileOf(qTable, z);
      color.setHSL(0.7 - t * 0.7, 1.0, 0.5);
    } else if (colorMode === "intensity" && data.intensities) {
      const v = data.intensities[i];
      color.setRGB(v, v, v);
    } else {
      color.setHex(0x00e5ff);
    }
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  return colors;
}

export function PointCloudCanvas({ data, pointSize, colorMode, heightRange, clipEnabled, onReady }: PointCloudCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const gizmoRef = useRef<ViewportGizmo | null>(null);
  const pointsRef = useRef<THREE.Points | null>(null);
  const centerZRef = useRef<number>(0); // world-Z offset applied to geometry on load
  const clipUniformRef = useRef<{ value: THREE.Vector2 } | null>(null);
  const frameRef = useRef<number>(0);
  const mountedRef = useRef(false);

  // -------- view controller helpers (stable refs used by buttons) --------
  const fitView = useRef<() => void>(() => {});
  const setView = useRef<(p: ViewPreset) => void>(() => {});

  useEffect(() => {
    const container = containerRef.current;
    if (!container || mountedRef.current) return;
    mountedRef.current = true;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(0x080d14);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 200000);
    camera.up.set(0, 0, 1); // Z is up — matches engineering / SolidWorks convention
    camera.position.set(40, -40, 30);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controlsRef.current = controls;

    const axesHelper = new THREE.AxesHelper(5);
    scene.add(axesHelper);

    // SolidWorks-style view gizmo in the bottom-right corner.
    const gizmo = new ViewportGizmo(camera, renderer, {
      type: "cube",
      size: 110,
      placement: "bottom-right",
      offset: { right: 12, bottom: 12 },
      background: { enabled: true, color: 0x1a2230, opacity: 0.85, hover: { color: 0x2a3850, opacity: 1 } },
      corners: { enabled: true, color: 0x3a4860 },
      font: { family: "ui-monospace, monospace", weight: 600 },
    });
    gizmo.attachControls(controls);
    gizmoRef.current = gizmo;

    // ---- view controller implementations ----
    fitView.current = () => {
      const geo = pointsRef.current?.geometry as THREE.BufferGeometry | undefined;
      if (!geo || !geo.boundingSphere) return;
      const radius = geo.boundingSphere.radius || 20;
      const fov = (camera.fov * Math.PI) / 180;
      // distance so the sphere fits, with a small margin
      const dist = (radius / Math.sin(fov / 2)) * 1.05;
      const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
      if (dir.lengthSq() === 0) dir.set(1, -1, 0.8).normalize();
      camera.position.copy(controls.target).addScaledVector(dir, dist);
      camera.near = Math.max(0.01, radius / 10000);
      camera.far = Math.max(20000, radius * 50);
      camera.updateProjectionMatrix();
      controls.update();
      gizmo.update();
    };

    setView.current = (preset: ViewPreset) => {
      const geo = pointsRef.current?.geometry as THREE.BufferGeometry | undefined;
      const radius = (geo?.boundingSphere?.radius ?? 0) > 0 ? geo!.boundingSphere!.radius : 20;
      const fov = (camera.fov * Math.PI) / 180;
      const dist = (radius / Math.sin(fov / 2)) * 1.05;
      const dirs: Record<ViewPreset, [number, number, number]> = {
        iso: [1, -1, 0.9],
        front: [0, -1, 0],
        back: [0, 1, 0],
        left: [-1, 0, 0],
        right: [1, 0, 0],
        top: [0, 0, 1],
        bottom: [0, 0, -1],
      };
      const [x, y, z] = dirs[preset];
      const dir = new THREE.Vector3(x, y, z).normalize();
      controls.target.set(0, 0, 0);
      camera.position.copy(controls.target).addScaledVector(dir, dist);
      camera.lookAt(controls.target);
      controls.update();
      gizmo.update();
    };

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
      gizmo.render();
    };
    animate();

    const onResize = () => {
      if (!container) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
      gizmo.update();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(frameRef.current);
      ro.disconnect();
      gizmo.dispose();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Rebuild geometry only when the dataset changes.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (pointsRef.current) {
      (pointsRef.current.geometry as THREE.BufferGeometry).dispose();
      ((pointsRef.current.material) as THREE.PointsMaterial).dispose();
      scene.remove(pointsRef.current);
      pointsRef.current = null;
    }

    if (!data) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    const colors = buildColors(data, colorMode, heightRange);
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeBoundingBox();
    const center = new THREE.Vector3();
    geo.boundingBox!.getCenter(center);
    geo.translate(-center.x, -center.y, -center.z);
    geo.computeBoundingSphere();
    centerZRef.current = center.z;

    // Inject a GPU-side Z-range clip into PointsMaterial. The geometry is in
    // centered space; we discard fragments whose Z is outside [uClipZ.x, .y].
    // When clipping is disabled the parent sets a very wide range.
    const clipUniform = { value: new THREE.Vector2(-1e9, 1e9) };
    clipUniformRef.current = clipUniform;
    const mat = new THREE.PointsMaterial({
      size: pointSize,
      vertexColors: true,
      sizeAttenuation: false,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uClipZ = clipUniform;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying float vZ;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvZ = position.z;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nuniform vec2 uClipZ;\nvarying float vZ;",
        )
        .replace(
          "#include <clipping_planes_fragment>",
          "if (vZ < uClipZ.x || vZ > uClipZ.y) discard;\n#include <clipping_planes_fragment>",
        );
    };

    const points = new THREE.Points(geo, mat);
    scene.add(points);
    pointsRef.current = points;

    fitView.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Update the GPU clip range whenever the slider or toggle changes.
  useEffect(() => {
    const u = clipUniformRef.current;
    if (!u) return;
    if (clipEnabled && heightRange) {
      const cz = centerZRef.current;
      u.value.set(heightRange[0] - cz, heightRange[1] - cz);
    } else {
      u.value.set(-1e9, 1e9);
    }
  }, [clipEnabled, heightRange?.[0], heightRange?.[1], data]);

  // Re-color in place when color mode or height range changes (no re-fit).
  useEffect(() => {
    const points = pointsRef.current;
    if (!points || !data) return;
    const colors = buildColors(data, colorMode, heightRange);
    const attr = (points.geometry as THREE.BufferGeometry).getAttribute("color") as THREE.BufferAttribute;
    attr.array.set(colors);
    attr.needsUpdate = true;
  }, [data, colorMode, heightRange?.[0], heightRange?.[1]]);

  useEffect(() => {
    if (!pointsRef.current) return;
    ((pointsRef.current.material) as THREE.PointsMaterial).size = pointSize;
  }, [pointSize]);

  // Hand the controller to the parent exactly once.
  useEffect(() => {
    if (!onReady) return;
    onReady({
      fit: () => fitView.current(),
      setView: (p) => setView.current(p),
    });
  }, [onReady]);

  return <div ref={containerRef} className="w-full h-full" />;
}
