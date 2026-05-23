import { useRef, useEffect } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PointCloudData } from "../lib/point-cloud";

interface PointCloudCanvasProps {
  data: PointCloudData | null;
  pointSize: number;
  colorMode: "height" | "intensity" | "uniform";
  onResetCamera?: (fn: () => void) => void;
}

function buildColors(data: PointCloudData, colorMode: "height" | "intensity" | "uniform"): Float32Array {
  const colors = new Float32Array(data.pointCount * 3);
  const color = new THREE.Color();
  const { min, max } = data.boundingBox;
  const zRange = max[2] - min[2];

  for (let i = 0; i < data.pointCount; i++) {
    if (colorMode === "height") {
      const z = data.positions[i * 3 + 2];
      const t = zRange === 0 ? 0.5 : (z - min[2]) / zRange;
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

export function PointCloudCanvas({ data, pointSize, colorMode, onResetCamera }: PointCloudCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const pointsRef = useRef<THREE.Points | null>(null);
  const frameRef = useRef<number>(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || mountedRef.current) return;
    mountedRef.current = true;

    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(0x080d14);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 200000);
    camera.position.set(0, -30, 30);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controlsRef.current = controls;

    const axesHelper = new THREE.AxesHelper(5);
    scene.add(axesHelper);

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      if (!container) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(frameRef.current);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, []);

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
    const colors = buildColors(data, colorMode);
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeBoundingBox();
    const center = new THREE.Vector3();
    geo.boundingBox!.getCenter(center);
    geo.translate(-center.x, -center.y, -center.z);

    const mat = new THREE.PointsMaterial({
      size: pointSize,
      vertexColors: true,
      sizeAttenuation: false,
    });

    const points = new THREE.Points(geo, mat);
    scene.add(points);
    pointsRef.current = points;

    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (camera && controls) {
      geo.computeBoundingSphere();
      const radius = (geo.boundingSphere?.radius ?? 0) > 0 ? geo.boundingSphere!.radius : 20;
      console.log('[canvas] bounding radius=', radius, 'box=', geo.boundingBox);
      camera.position.set(0, -radius * 2.2, radius * 1.6);
      camera.lookAt(0, 0, 0);
      controls.target.set(0, 0, 0);
      camera.near = Math.max(0.01, radius / 10000);
      camera.far = Math.max(20000, radius * 50);
      camera.updateProjectionMatrix();
      controls.update();
    }
  }, [data, colorMode]);

  useEffect(() => {
    if (!pointsRef.current) return;
    ((pointsRef.current.material) as THREE.PointsMaterial).size = pointSize;
  }, [pointSize]);

  useEffect(() => {
    if (onResetCamera) {
      onResetCamera(() => {
        const camera = cameraRef.current;
        const controls = controlsRef.current;
        const geo = pointsRef.current?.geometry;
        if (!camera || !controls) return;
        const r = geo?.boundingSphere?.radius ?? 0;
        const radius = r > 0 ? r : 20;
        camera.position.set(0, -radius * 2.2, radius * 1.6);
        camera.lookAt(0, 0, 0);
        controls.target.set(0, 0, 0);
        controls.update();
      });
    }
  }, [onResetCamera]);

  return <div ref={containerRef} className="w-full h-full" />;
}
