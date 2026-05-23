import type { PointCloudData } from "./point-cloud";

// Fill NaN cells in a row-major grid by iteratively averaging their finite
// 4-neighbors. Returns a new array; the input is not mutated. Uses true
// ping-pong buffers to avoid per-pass allocations.
export function fillGridGaps(
  grid: NonNullable<PointCloudData["grid"]>,
  iterations = 4,
): Float32Array {
  const { cols, rows, z } = grid;
  let cur = new Float32Array(z);
  let next = new Float32Array(z); // start as a copy too, so valid cells are present from pass 1

  for (let pass = 0; pass < iterations; pass++) {
    let filled = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const v = cur[idx];
        if (isFinite(v)) {
          next[idx] = v;
          continue;
        }
        let sum = 0;
        let count = 0;
        if (c > 0) { const n = cur[idx - 1]; if (isFinite(n)) { sum += n; count++; } }
        if (c < cols - 1) { const n = cur[idx + 1]; if (isFinite(n)) { sum += n; count++; } }
        if (r > 0) { const n = cur[idx - cols]; if (isFinite(n)) { sum += n; count++; } }
        if (r < rows - 1) { const n = cur[idx + cols]; if (isFinite(n)) { sum += n; count++; } }
        if (count > 0) {
          next[idx] = sum / count;
          filled++;
        } else {
          next[idx] = NaN;
        }
      }
    }
    const tmp = cur;
    cur = next;
    next = tmp;
    if (filled === 0) break;
  }
  return cur;
}

export interface SurfaceMeshBuffers {
  positions: Float32Array; // (cols*rows) * 3
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  validMask: Uint8Array; // 1 if cell had a finite z, 0 otherwise (length = vertexCount)
}

// Triangulate a grid into a mesh, skipping any quad whose corners include
// invalid (NaN) cells. Invalid vertex positions are filled with the centroid
// of all valid cells so they never inflate the bounding sphere — they are
// also never referenced by any triangle so they're effectively hidden.
export function buildSurfaceMesh(
  grid: NonNullable<PointCloudData["grid"]>,
  zArray: Float32Array, // typically grid.z or the gap-filled output
): SurfaceMeshBuffers {
  const { cols, rows, xStep, yStep, xOrigin, yOrigin } = grid;
  const vertexCount = cols * rows;
  const positions = new Float32Array(vertexCount * 3);
  const validMask = new Uint8Array(vertexCount);

  // First pass: write valid vertices, accumulate centroid for sentinels.
  let cxSum = 0, cySum = 0, czSum = 0, validCount = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const z = zArray[idx];
      if (isFinite(z)) {
        const x = xOrigin + c * xStep;
        const y = yOrigin + r * yStep;
        positions[idx * 3] = x;
        positions[idx * 3 + 1] = y;
        positions[idx * 3 + 2] = z;
        validMask[idx] = 1;
        cxSum += x; cySum += y; czSum += z;
        validCount++;
      }
    }
  }
  const cx = validCount > 0 ? cxSum / validCount : 0;
  const cy = validCount > 0 ? cySum / validCount : 0;
  const cz = validCount > 0 ? czSum / validCount : 0;

  // Second pass: fill sentinel cells with the centroid so bbox/boundingSphere
  // are not inflated by spurious z=0 vertices.
  for (let i = 0; i < vertexCount; i++) {
    if (!validMask[i]) {
      positions[i * 3] = cx;
      positions[i * 3 + 1] = cy;
      positions[i * 3 + 2] = cz;
    }
  }

  // Two triangles per cell, skip if any corner is invalid.
  const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let ti = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      if (!validMask[a] || !validMask[b] || !validMask[d] || !validMask[e]) continue;
      indices[ti++] = a;
      indices[ti++] = d;
      indices[ti++] = b;
      indices[ti++] = b;
      indices[ti++] = d;
      indices[ti++] = e;
    }
  }
  return {
    positions,
    indices: indices.slice(0, ti),
    vertexCount,
    triangleCount: ti / 3,
    validMask,
  };
}

// Wrap surface mesh output into a PointCloudData-compatible object so the rest
// of the viewer (color builder, height slider, equalization) keeps working
// uniformly across point and mesh modes. boundingBox is computed from VALID
// cells only — sentinel-filled vertices would otherwise skew it.
export function meshAsPointCloudData(
  buffers: SurfaceMeshBuffers,
  source: PointCloudData,
): PointCloudData {
  const { positions, validMask, vertexCount } = buffers;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const intensities = new Float32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (validMask[i]) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      intensities[i] = Math.abs(z);
    } else {
      intensities[i] = 0;
    }
  }
  if (!isFinite(minX)) { minX = maxX = minY = maxY = minZ = maxZ = 0; }
  return {
    positions: buffers.positions,
    intensities,
    pointCount: vertexCount,
    boundingBox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    sourceInfo: source.sourceInfo,
    grid: source.grid,
  };
}

// Same idea but for the gap-fill-points-only mode: builds a PointCloudData
// from filled grid Z values, one position per cell (skipping cells still NaN).
export function gridToFilledPoints(
  grid: NonNullable<PointCloudData["grid"]>,
  zArray: Float32Array,
  source: PointCloudData,
): PointCloudData {
  const { cols, rows, xStep, yStep, xOrigin, yOrigin } = grid;
  const positions = new Float32Array(cols * rows * 3);
  const intensities = new Float32Array(cols * rows);
  let pi = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const z = zArray[idx];
      if (!isFinite(z)) continue;
      const x = xOrigin + c * xStep;
      const y = yOrigin + r * yStep;
      positions[pi * 3] = x;
      positions[pi * 3 + 1] = y;
      positions[pi * 3 + 2] = z;
      intensities[pi] = Math.abs(z);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      pi++;
    }
  }
  return {
    positions: positions.slice(0, pi * 3),
    intensities: intensities.slice(0, pi),
    pointCount: pi,
    boundingBox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    sourceInfo: source.sourceInfo,
    grid: source.grid,
  };
}
