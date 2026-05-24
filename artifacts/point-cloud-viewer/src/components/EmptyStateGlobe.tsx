import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

/**
 * Small rainbow-colored dotted globe for the empty viewport state.
 * - Fibonacci-lattice sphere (~1800 points) so the dots are evenly spaced.
 * - Per-vertex HSL rainbow so each axis tumble reveals new color.
 * - Tumbles on X, Y, and Z so the rotation reads as "all directions".
 * - Transparent canvas — sits over the page background.
 * - Falls back to a CSS rainbow disc if WebGL is unavailable.
 */
export function EmptyStateGlobe({ size = 280 }: { size?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 3.2);

    // Fibonacci-lattice sphere — uniform spacing, no polar clustering.
    const POINTS = 1800;
    const positions = new Float32Array(POINTS * 3);
    const colors = new Float32Array(POINTS * 3);
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    const c = new THREE.Color();
    for (let i = 0; i < POINTS; i++) {
      const y = 1 - (i / (POINTS - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const t = GOLDEN * i;
      positions[i * 3] = Math.cos(t) * r;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(t) * r;
      // Rainbow hue along latitude; full saturation, mid lightness.
      c.setHSL((y + 1) / 2, 0.95, 0.6);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.PointsMaterial({
      size: 0.05,
      vertexColors: true,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.95,
    });
    const points = new THREE.Points(geo, mat);
    scene.add(points);

    let raf = 0;
    const start = performance.now();
    const tick = () => {
      const t = (performance.now() - start) / 1000;
      // Tumble on multiple axes — globe rotates in "all directions".
      points.rotation.y = t * 0.35;
      points.rotation.x = Math.sin(t * 0.2) * 0.6;
      points.rotation.z = Math.cos(t * 0.15) * 0.25;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      geo.dispose();
      mat.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [size]);

  if (failed) {
    // CSS rainbow disc fallback when WebGL is unavailable.
    return (
      <div
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background:
            "conic-gradient(from 0deg, #ff3b30, #ff9500, #ffcc00, #34c759, #007aff, #5856d6, #af52de, #ff2d55, #ff3b30)",
          filter: "blur(2px)",
          opacity: 0.7,
        }}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
