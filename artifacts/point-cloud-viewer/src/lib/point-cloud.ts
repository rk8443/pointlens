import { decode as decodeTiff } from "tiff";

export interface PointCloudData {
  positions: Float32Array;
  colors?: Float32Array;
  intensities?: Float32Array;
  pointCount: number;
  boundingBox: {
    min: [number, number, number];
    max: [number, number, number];
  };
  sourceInfo?: {
    width?: number;
    height?: number;
    channels?: number;
    bitDepth?: number;
  };
  // Regularly-sampled raster grid (only set for raster sources like TIF/PNG).
  // Needed for "fill empty" gap-filling and "surface mesh" triangulation.
  grid?: {
    cols: number;
    rows: number;
    z: Float32Array; // length = cols*rows, NaN marks invalid cells (row-major)
    xOrigin: number; // world X of column 0
    yOrigin: number; // world Y of row 0
    xStep: number; // world units per grid column
    yStep: number; // world units per grid row
  };
}

function buildBoundingBox(positions: Float32Array): PointCloudData["boundingBox"] {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function normalizeChannel(data: ArrayLike<number>, bitDepth: number): Float32Array {
  const maxVal = bitDepth === 32 ? 1.0 : (1 << bitDepth) - 1;
  const out = new Float32Array(data.length);
  if (bitDepth === 32) {
    for (let i = 0; i < data.length; i++) out[i] = (data as Float32Array)[i];
  } else {
    for (let i = 0; i < data.length; i++) out[i] = (data as Uint8Array | Uint16Array)[i] / maxVal;
  }
  return out;
}

export async function parseTiff(buffer: ArrayBuffer, maxPoints = 100_000): Promise<PointCloudData> {
  const ifds = decodeTiff(buffer) as any[];
  if (!ifds || ifds.length === 0) throw new Error("Invalid TIFF file");

  const ifd0 = ifds[0];
  const width: number = ifd0.width;
  const height: number = ifd0.height;

  // bitsPerSample can be a scalar or an array [32,32,32]
  const bpsRaw = ifd0.bitsPerSample ?? 32;
  const bitsPerSample: number = Array.isArray(bpsRaw) ? bpsRaw[0] : bpsRaw;

  const samplesPerPixel: number = ifd0.samplesPerPixel ?? ifd0.components ?? 1;
  const sampleFormat: number = ifd0.sampleFormat ?? 1;
  const isFloat = sampleFormat === 3 || bitsPerSample === 32;
  const maxVal = isFloat ? 1.0 : (1 << Math.min(bitsPerSample, 16)) - 1;

  console.log('[parseTiff]', { width, height, bitsPerSample, samplesPerPixel, sampleFormat, isFloat, numIFDs: ifds.length });

  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / maxPoints)));
  const maxOut = Math.ceil(height / step) * Math.ceil(width / step);

  let xs: Float32Array, ys: Float32Array, zs: Float32Array;

  // --- PLANAR FORMAT: each channel is a separate IFD/page ---
  if (ifds.length >= 3 && samplesPerPixel === 1) {
    console.log('[parseTiff] planar layout — reading 3 separate IFDs');
    const readChannel = (ifd: any): Float32Array => {
      const raw = ifd.data as Float32Array;
      const out = new Float32Array(Math.ceil(height / step) * Math.ceil(width / step));
      let i = 0;
      for (let r = 0; r < height; r += step) {
        for (let c = 0; c < width; c += step) {
          out[i++] = raw[r * width + c];
        }
      }
      return out;
    };
    xs = readChannel(ifds[0]);
    ys = readChannel(ifds[1]);
    zs = readChannel(ifds[2]);

  // --- INTERLEAVED FORMAT: all channels in one IFD ---
  } else {
    console.log('[parseTiff] interleaved layout — samplesPerPixel =', samplesPerPixel);
    const raw = ifd0.data as ArrayLike<number>;
    const ch = samplesPerPixel;
    const n = Math.ceil(height / step) * Math.ceil(width / step);
    xs = new Float32Array(n);
    ys = new Float32Array(n);
    zs = new Float32Array(n);
    let i = 0;

    if (isFloat && ch >= 3) {
      // Float32 3-channel: actual XYZ mm coordinates from LMI calibrated scan
      for (let r = 0; r < height; r += step) {
        for (let c = 0; c < width; c += step) {
          const base = (r * width + c) * ch;
          xs[i] = raw[base];
          ys[i] = raw[base + 1];
          zs[i] = raw[base + 2];
          i++;
        }
      }
    } else {
      // uint8/16 (and float single-ch): LMI range-image format.
      // X = column, Y = row, Z = max value across channels (typically the depth channel).
      // 0 is the LMI "no-data" marker, so skip it.
      const yScale = width / height; // make Y roughly proportional to X scale for very tall scans
      for (let r = 0; r < height; r += step) {
        for (let c = 0; c < width; c += step) {
          const base = (r * width + c) * ch;
          let z = raw[base] ?? 0;
          if (ch > 1) {
            const v1 = raw[base + 1] ?? 0;
            if (Math.abs(v1) > Math.abs(z)) z = v1;
          }
          if (ch > 2) {
            const v2 = raw[base + 2] ?? 0;
            if (Math.abs(v2) > Math.abs(z)) z = v2;
          }
          xs[i] = c;
          ys[i] = r * yScale; // visually balance very tall scans (e.g. 5k × 24k)
          // Scale Z so it's visible at the same order of magnitude as X/Y.
          // For uint16 [0..65535] divided by 65535 then multiplied by max(width, height)/4
          // gives a reasonable z-range.
          const zNorm = isFloat ? z : z / maxVal;
          zs[i] = zNorm * (width / 4);
          if (z === 0) {
            // Mark as NaN so the filter below removes it
            xs[i] = NaN; ys[i] = NaN; zs[i] = NaN;
          }
          i++;
        }
      }
    }
  }

  console.log('[parseTiff] sample ranges X:', xs[0], '…', xs[xs.length - 1],
    'Y:', ys[0], '…', ys[ys.length - 1],
    'Z:', zs[0], '…', zs[zs.length - 1]);

  // Build positions — only filter NaN/Inf, keep all finite points including zeros
  const positions = new Float32Array(xs.length * 3);
  const intensities = new Float32Array(xs.length);
  let pi = 0;

  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i], z = zs[i];
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    positions[pi * 3]     = x;
    positions[pi * 3 + 1] = y;
    positions[pi * 3 + 2] = z;
    intensities[pi] = Math.abs(z);
    pi++;
  }

  console.log('[parseTiff] valid points:', pi);

  const validPos = positions.slice(0, pi * 3);
  const validInt = intensities.slice(0, pi);

  // Build the regular raster grid (cols × rows in stepped coords).
  // The XS/YS arrays were filled row-major above, so reshape them.
  const cols = Math.ceil(width / step);
  const rows = Math.ceil(height / step);
  const gridZ = new Float32Array(cols * rows);
  let xStep = 1;
  let yStep = 1;
  let xOrigin = 0;
  let yOrigin = 0;
  if (xs.length === cols * rows) {
    for (let k = 0; k < xs.length; k++) {
      const z = zs[k];
      gridZ[k] = isFinite(z) && isFinite(xs[k]) && isFinite(ys[k]) ? z : NaN;
    }
    // Use the first finite XY as the origin so calibrated-XYZ TIFFs keep their
    // real-world offset when reconstructed for fill/mesh modes.
    for (let k = 0; k < xs.length; k++) {
      if (isFinite(xs[k]) && isFinite(ys[k])) {
        xOrigin = xs[k] - (k % cols) * 1; // pre-step assumption; refined below
        yOrigin = ys[k] - Math.floor(k / cols) * 1;
        break;
      }
    }
    // Derive XY step from the first row / first column of finite samples.
    for (let k = 1; k < cols; k++) {
      if (isFinite(xs[k]) && isFinite(xs[0])) { xStep = Math.abs(xs[k] - xs[0]) / k || 1; break; }
    }
    for (let k = 1; k < rows; k++) {
      const idx = k * cols;
      if (isFinite(ys[idx]) && isFinite(ys[0])) { yStep = Math.abs(ys[idx] - ys[0]) / k || 1; break; }
    }
    // Recompute origin with the derived step.
    for (let k = 0; k < xs.length; k++) {
      if (isFinite(xs[k]) && isFinite(ys[k])) {
        xOrigin = xs[k] - (k % cols) * xStep;
        yOrigin = ys[k] - Math.floor(k / cols) * yStep;
        break;
      }
    }
  }

  return {
    positions: validPos,
    intensities: validInt,
    pointCount: pi,
    boundingBox: buildBoundingBox(validPos),
    sourceInfo: { width, height, channels: samplesPerPixel, bitDepth: bitsPerSample },
    grid: xs.length === cols * rows ? { cols, rows, z: gridZ, xOrigin, yOrigin, xStep, yStep } : undefined,
  };
}

export async function parsePng(buffer: ArrayBuffer): Promise<PointCloudData> {
  const blob = new Blob([buffer]);
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const pixelCount = width * height;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, width, height);
  const px = imageData.data;

  const positions = new Float32Array(pixelCount * 3);
  const intensities = new Float32Array(pixelCount);

  const scaleX = width;
  const scaleY = height;

  for (let i = 0; i < pixelCount; i++) {
    const r = px[i * 4] / 255;
    const g = px[i * 4 + 1] / 255;
    const b = px[i * 4 + 2] / 255;
    positions[i * 3] = r * scaleX;
    positions[i * 3 + 1] = g * scaleY;
    positions[i * 3 + 2] = b * scaleX;
    intensities[i] = (r + g + b) / 3;
  }

  return {
    positions,
    intensities,
    pointCount: pixelCount,
    boundingBox: buildBoundingBox(positions),
    sourceInfo: { width, height, channels: 3, bitDepth: 8 },
  };
}

export function parseBinary(buffer: ArrayBuffer): PointCloudData {
  const floats = new Float32Array(buffer);
  const pointCount = Math.floor(floats.length / 3);
  const positions = floats.subarray(0, pointCount * 3);
  const intensities = new Float32Array(pointCount).fill(1.0);
  return {
    positions: new Float32Array(positions),
    intensities,
    pointCount,
    boundingBox: buildBoundingBox(new Float32Array(positions)),
  };
}

export function parseCsv(text: string): PointCloudData {
  const lines = text.trim().split('\n');
  const positions: number[] = [];
  const intensities: number[] = [];

  let startIdx = 0;
  if (lines.length > 0 && isNaN(parseFloat(lines[0].split(/[,\s]+/)[0]))) {
    startIdx = 1;
  }

  for (let i = startIdx; i < lines.length; i++) {
    const parts = lines[i].trim().split(/[,\s]+/);
    if (parts.length >= 3) {
      const x = parseFloat(parts[0]);
      const y = parseFloat(parts[1]);
      const z = parseFloat(parts[2]);
      if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
        positions.push(x, y, z);
        intensities.push(parts.length >= 4 ? parseFloat(parts[3]) : 1.0);
      }
    }
  }

  const posArr = new Float32Array(positions);
  return {
    positions: posArr,
    intensities: new Float32Array(intensities),
    pointCount: positions.length / 3,
    boundingBox: buildBoundingBox(posArr),
  };
}

const MAGIC = 0x504c4300;

export async function parseFromServer(
  file: File,
  maxPoints = 100_000,
  onStage?: (msg: string) => void,
): Promise<PointCloudData> {
  const form = new FormData();
  form.append("file", file);

  onStage?.("Uploading to processor…");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000); // 2-min hard timeout

  let res: Response;
  try {
    res = await fetch(`/pc-api/upload?max_points=${maxPoints}`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("Processing timed out (2 min). Try a lower density or a smaller file.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? `Server error ${res.status}`);
  }

  onStage?.("Downloading point data…");
  const buf = await res.arrayBuffer();
  // Parse binary header: 7 x int32
  const header = new Int32Array(buf, 0, 7);
  if (header[0] !== MAGIC) throw new Error("Invalid response from server");
  const pointCount = header[1];
  const width = header[2];
  const height = header[3];
  const channels = header[4];
  const bitDepth = header[5];
  const positions = new Float32Array(buf, 28, pointCount * 3);
  const posArr = new Float32Array(positions); // copy out of buffer
  return {
    positions: posArr,
    pointCount,
    boundingBox: buildBoundingBox(posArr),
    sourceInfo: { width, height, channels, bitDepth },
  };
}

export async function parseFile(
  file: File,
  maxPoints = 100_000,
  onStage?: (msg: string) => void,
): Promise<PointCloudData> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

  if (ext === 'tif' || ext === 'tiff') {
    onStage?.('Reading file…');
    const buf = await file.arrayBuffer();
    onStage?.('Decoding TIFF…');
    try {
      return await parseTiff(buf, maxPoints);
    } catch (clientErr) {
      // If the tiff library can't handle this format, fall back to server
      console.warn('Client-side TIFF parse failed, trying server:', clientErr);
      onStage?.('Falling back to server…');
      return parseFromServer(file, maxPoints, onStage);
    }
  }

  if (ext === 'png') {
    onStage?.('Reading image…');
    const buf = await file.arrayBuffer();
    onStage?.('Decoding PNG…');
    return parsePng(buf);
  }

  if (ext === 'bin' || ext === 'raw' || ext === 'lmi') {
    onStage?.('Reading file…');
    const buf = await file.arrayBuffer();
    return parseBinary(buf);
  }

  onStage?.('Parsing text data…');
  const text = await file.text();
  return parseCsv(text);
}

export function generateDemoCloud(): PointCloudData {
  const pointCount = 100000;
  const positions = new Float32Array(pointCount * 3);
  const intensities = new Float32Array(pointCount);

  for (let i = 0; i < pointCount; i++) {
    const u = Math.random() * Math.PI * 2;
    const v = Math.random() * Math.PI * 2;
    const R = 10, r = 3;
    let x = (R + r * Math.cos(v)) * Math.cos(u);
    let y = (R + r * Math.cos(v)) * Math.sin(u);
    let z = r * Math.sin(v) + Math.sin(u * 5) * 1.5;
    x += (Math.random() - 0.5) * 0.2;
    y += (Math.random() - 0.5) * 0.2;
    z += (Math.random() - 0.5) * 0.2;
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    intensities[i] = Math.random();
  }

  return {
    positions,
    intensities,
    pointCount,
    boundingBox: buildBoundingBox(positions),
  };
}
