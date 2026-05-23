import { useRef, useEffect, useMemo } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ViewportGizmo } from "three-viewport-gizmo";
import { PointCloudData } from "../lib/point-cloud";
import {
  fillGridGaps,
  buildSurfaceMesh,
  meshAsPointCloudData,
  gridToFilledPoints,
  SurfaceMeshBuffers,
} from "../lib/surface";

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
  heightMap?: "linear" | "equalized"; // how to map Z within heightRange to a hue
  fillGaps?: boolean; // interpolate NaN cells in the scan raster
  showSurface?: boolean; // render as triangulated surface mesh instead of points
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
  heightMap: "linear" | "equalized" = "equalized",
): Float32Array {
  const colors = new Float32Array(data.pointCount * 3);
  const color = new THREE.Color();
  const { min, max } = data.boundingBox;
  const [zLo, zHi] = heightRange ?? [min[2], max[2]];
  const zSpan = zHi - zLo;

  // Pre-build the equalization table only when needed.
  const qTable =
    colorMode === "height" && heightMap === "equalized"
      ? buildZQuantileTable(data, zLo, zHi)
      : null;

  for (let i = 0; i < data.pointCount; i++) {
    if (colorMode === "height") {
      const z = data.positions[i * 3 + 2];
      let t: number;
      if (z <= zLo) t = 0;
      else if (z >= zHi) t = 1;
      else if (qTable) t = quantileOf(qTable, z);
      else t = zSpan === 0 ? 0.5 : (z - zLo) / zSpan;
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

export function PointCloudCanvas({
  data,
  pointSize,
  colorMode,
  heightRange,
  clipEnabled,
  heightMap,
  fillGaps,
  showSurface,
  onReady,
}: PointCloudCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const gizmoRef = useRef<ViewportGizmo | null>(null);
  // Currently-attached scene object — Points or Mesh depending on showSurface.
  const sceneObjRef = useRef<THREE.Object3D | null>(null);
  const centerZRef = useRef<number>(0); // world-Z offset applied to geometry on load
  const clipUniformRef = useRef<{ value: THREE.Vector2 } | null>(null);
  const frameRef = useRef<number>(0);
  const mountedRef = useRef(false);

  // Derive a working PointCloudData based on fill/surface toggles. When the
  // dataset has no grid (CSV/BIN/PNG), the toggles are no-ops and we fall back
  // to the raw point cloud.
  const { workData, meshBuffers } = useMemo<{
    workData: PointCloudData | null;
    meshBuffers: SurfaceMeshBuffers | null;
  }>(() => {
    if (!data) return { workData: null, meshBuffers: null };
    if (!data.grid || (!fillGaps && !showSurface)) {
      return { workData: data, meshBuffers: null };
    }
    const zArr = fillGaps ? fillGridGaps(data.grid) : data.grid.z;
    if (showSurface) {
      const buffers = buildSurfaceMesh(data.grid, zArr);
      return { workData: meshAsPointCloudData(buffers, data), meshBuffers: buffers };
    }
    return { workData: gridToFilledPoints(data.grid, zArr, data), meshBuffers: null };
  }, [data, fillGaps, showSurface]);

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

    // Lights for the surface-mesh path. Points are unlit so these are no-ops
    // there.
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
    keyLight.position.set(1, -1, 1).normalize();
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xb6ccff, 0.35);
    fillLight.position.set(-1, 1, 0.3).normalize();
    scene.add(fillLight);

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
    const currentGeo = (): THREE.BufferGeometry | undefined => {
      const obj = sceneObjRef.current as (THREE.Points | THREE.Mesh) | null;
      return obj?.geometry as THREE.BufferGeometry | undefined;
    };
    fitView.current = () => {
      const geo = currentGeo();
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
      const geo = currentGeo();
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

  // Rebuild geometry when the (possibly transformed) dataset or mode changes.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (sceneObjRef.current) {
      const obj = sceneObjRef.current as THREE.Points | THREE.Mesh;
      (obj.geometry as THREE.BufferGeometry).dispose();
      (obj.material as THREE.Material).dispose();
      scene.remove(obj);
      sceneObjRef.current = null;
    }

    if (!workData) return;

    // IMPORTANT: copy positions for the GPU before centering so the source
    // positions stay in WORLD coords. Other code paths (buildColors,
    // height-range slider, clip uniform) compare against world-space Z and
    // would silently break if positions were mutated in place.
    const centered = new Float32Array(workData.positions);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(centered, 3));
    const colors = buildColors(workData, colorMode, heightRange, heightMap);
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    if (meshBuffers) {
      geo.setIndex(new THREE.BufferAttribute(meshBuffers.indices, 1));
    }
    geo.computeBoundingBox();
    const center = new THREE.Vector3();
    geo.boundingBox!.getCenter(center);
    geo.translate(-center.x, -center.y, -center.z); // only mutates `centered`
    if (meshBuffers) geo.computeVertexNormals();
    geo.computeBoundingSphere();
    centerZRef.current = center.z;

    // Inject a GPU-side Z-range clip. The geometry is in centered space; we
    // discard fragments whose Z is outside [uClipZ.x, .y]. The same shader
    // patch works for PointsMaterial and MeshStandardMaterial since both go
    // through the standard chunk includes.
    const clipUniform = { value: new THREE.Vector2(-1e9, 1e9) };
    clipUniformRef.current = clipUniform;
    const patchShader = (mat: THREE.Material) => {
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
    };

    let obj: THREE.Object3D;
    if (meshBuffers) {
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        flatShading: false,
        roughness: 0.85,
        metalness: 0.05,
      });
      patchShader(mat);
      obj = new THREE.Mesh(geo, mat);
    } else {
      const mat = new THREE.PointsMaterial({
        size: pointSize,
        vertexColors: true,
        sizeAttenuation: false,
      });
      patchShader(mat);
      obj = new THREE.Points(geo, mat);
    }
    scene.add(obj);
    sceneObjRef.current = obj;

    fitView.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workData, meshBuffers]);

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
  }, [clipEnabled, heightRange?.[0], heightRange?.[1], workData]);

  // Re-color in place when color mode or height range changes (no re-fit).
  useEffect(() => {
    const obj = sceneObjRef.current as (THREE.Points | THREE.Mesh) | null;
    if (!obj || !workData) return;
    const colors = buildColors(workData, colorMode, heightRange, heightMap);
    const attr = (obj.geometry as THREE.BufferGeometry).getAttribute("color") as THREE.BufferAttribute;
    attr.array.set(colors);
    attr.needsUpdate = true;
  }, [workData, colorMode, heightMap, heightRange?.[0], heightRange?.[1]]);

  useEffect(() => {
    const obj = sceneObjRef.current;
    if (!obj || !(obj instanceof THREE.Points)) return;
    (obj.material as THREE.PointsMaterial).size = pointSize;
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
