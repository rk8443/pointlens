import type { PointCloudData } from "./point-cloud";

// Robust outlier rejection. Returns a copy of zArray with cells whose value
// is more than `sigmaFactor` robust standard deviations from the median set
// to NaN. Catches saturated LMI sensor pixels (huge spikes that aren't
// already 0) so they don't leak into fill/smooth/mesh as ghost geometry.
export function markOutliers(
  zArray: Float32Array,
  sigmaFactor = 6,
): Float32Array {
  const total = zArray.length;
  const target = 4000;
  const stride = Math.max(1, Math.floor(total / target));
  const samples: number[] = [];
  for (let i = 0; i < total; i += stride) {
    const v = zArray[i];
    if (isFinite(v)) samples.push(v);
  }
  if (samples.length < 20) return zArray;
  samples.sort((a, b) => a - b);
  const median = samples[samples.length >>> 1];
  const devs = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) devs[i] = Math.abs(samples[i] - median);
  const devArr = Array.from(devs);
  devArr.sort((a, b) => a - b);
  const mad = devArr[devArr.length >>> 1];
  if (!isFinite(mad)) return zArray;
  let sigma = mad * 1.4826; // MAD -> approx. stddev for normal data
  // Flat/quantized scans collapse MAD to 0. Fall back to the smallest
  // non-zero deviation (or, failing that, the 95th-percentile deviation)
  // so a single saturated outlier still gets caught.
  if (sigma === 0) {
    let firstNonZero = 0;
    for (let i = 0; i < devArr.length; i++) {
      if (devArr[i] > 0) { firstNonZero = devArr[i]; break; }
    }
    if (firstNonZero === 0) {
      const p95 = devArr[Math.min(devArr.length - 1, Math.floor(devArr.length * 0.95))];
      firstNonZero = p95;
    }
    if (firstNonZero === 0) return zArray; // truly all identical -> nothing to do
    sigma = firstNonZero;
  }
  const low = median - sigmaFactor * sigma;
  const high = median + sigmaFactor * sigma;
  const out = new Float32Array(zArray);
  for (let i = 0; i < total; i++) {
    const v = out[i];
    if (isFinite(v) && (v < low || v > high)) out[i] = NaN;
  }
  return out;
}

// Fill NaN cells in a row-major grid by iteratively averaging their finite
// 4-neighbors. Returns a new array; the input is not mutated. Uses true
// ping-pong buffers to avoid per-pass allocations.
//
// Default = 1 pass: only fills holes that have at least one valid neighbor
// on each side (i.e. single-pixel pinholes). Higher values let the fill bleed
// into bigger gaps, which can create ghost geometry, so keep this conservative.
export function fillGridGaps(
  grid: NonNullable<PointCloudData["grid"]>,
  zArray: Float32Array = grid.z,
  iterations = 1,
): Float32Array {
  const { cols, rows } = grid;
  let cur = new Float32Array(zArray);
  let next = new Float32Array(zArray); // start as a copy too, so valid cells are present from pass 1

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

// Smooth a row-major grid Z with `passes` rounds of a 3x3 box blur. NaN cells
// stay NaN; valid cells average only their finite neighbors so the smoothing
// does not bleed across gaps. Returns a new array; input is not mutated.
export function smoothGrid(
  grid: NonNullable<PointCloudData["grid"]>,
  zArray: Float32Array,
  passes: number,
): Float32Array {
  if (passes <= 0) return zArray;
  const { cols, rows } = grid;
  let cur = new Float32Array(zArray);
  let next = new Float32Array(zArray.length);
  for (let p = 0; p < passes; p++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const v = cur[idx];
        if (!isFinite(v)) {
          next[idx] = NaN;
          continue;
        }
        let sum = 0, count = 0;
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= rows) continue;
          for (let dc = -1; dc <= 1; dc++) {
            const cc = c + dc;
            if (cc < 0 || cc >= cols) continue;
            const nv = cur[rr * cols + cc];
            if (isFinite(nv)) { sum += nv; count++; }
          }
        }
        next[idx] = count > 0 ? sum / count : v;
      }
    }
    const tmp = cur; cur = next; next = tmp;
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

// Estimate a Z-edge tolerance from the median |Δz| between horizontally
// adjacent valid cells. Edges with a larger jump than `factor * median`
// indicate a real depth discontinuity (a cliff in the scan) and should not be
// triangulated across. Sampled, so it stays cheap on huge grids.
function estimateEdgeTolerance(
  grid: NonNullable<PointCloudData["grid"]>,
  zArray: Float32Array,
  factor: number,
): number {
  const { cols, rows } = grid;
  const total = cols * rows;
  const target = 4000;
  const stride = Math.max(1, Math.floor(total / target));
  const samples: number[] = [];
  for (let idx = 0; idx + 1 < total; idx += stride) {
    if ((idx + 1) % cols === 0) continue; // crossing into the next row
    const a = zArray[idx];
    const b = zArray[idx + 1];
    if (isFinite(a) && isFinite(b)) samples.push(Math.abs(a - b));
  }
  if (samples.length < 20) return Infinity;
  samples.sort((a, b) => a - b);
  const median = samples[samples.length >>> 1];
  // Guard against a flat scan (median 0) — use the 90th percentile instead.
  if (median === 0) {
    const p90 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.9))];
    if (p90 === 0) return Infinity;
    return p90 * factor;
  }
  return median * factor;
}

// Triangulate a grid into a mesh, skipping any quad whose corners include
// invalid (NaN) cells OR whose edges span a real depth discontinuity (a
// jump much larger than the typical neighbor-to-neighbor Z delta). Invalid
// vertex positions are pinned to the centroid of valid cells so they don't
// inflate the bounding sphere — they're also unreferenced by any triangle
// so they stay hidden.
export function buildSurfaceMesh(
  grid: NonNullable<PointCloudData["grid"]>,
  zArray: Float32Array, // typically grid.z or the gap-filled output
  edgeFactor = 8, // skip edges longer than `edgeFactor * median |Δz|`
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

  // Edge tolerance prevents triangles from bridging across depth cliffs.
  const edgeTol = estimateEdgeTolerance(grid, zArray, edgeFactor);

  // Two triangles per cell, skip if any corner is invalid OR any of the five
  // unique edges (a-b, a-d, b-e, d-e, b-d) jumps further than the tolerance.
  const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let ti = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      if (!validMask[a] || !validMask[b] || !validMask[d] || !validMask[e]) continue;
      const za = zArray[a], zb = zArray[b], zd = zArray[d], ze = zArray[e];
      if (
        Math.abs(za - zb) > edgeTol ||
        Math.abs(za - zd) > edgeTol ||
        Math.abs(zb - ze) > edgeTol ||
        Math.abs(zd - ze) > edgeTol ||
        Math.abs(zb - zd) > edgeTol
      ) continue;
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
