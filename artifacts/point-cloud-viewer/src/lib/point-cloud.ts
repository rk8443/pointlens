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
  const ifds = decodeTiff(buffer);
  if (!ifds || ifds.length === 0) throw new Error("Invalid TIFF file");

  const ifd = ifds[0] as any;
  const width: number = ifd.width;
  const height: number = ifd.height;
  const bitsPerSample: number = ifd.bitsPerSample ?? 8;
  const samplesPerPixel: number = ifd.samplesPerPixel ?? ifd.components ?? 1;
  const sampleFormat: number = ifd.sampleFormat ?? 1;
  const raw: ArrayLike<number> = ifd.data;

  if (!raw) throw new Error("TIFF contains no pixel data");

  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / maxPoints)));
  const cols = Math.ceil(width / step);
  const rows = Math.ceil(height / step);
  const maxOut = cols * rows;

  const chStride = samplesPerPixel;
  const isFloat = sampleFormat === 3;
  const maxVal = isFloat ? 1.0 : (1 << Math.min(bitsPerSample, 16)) - 1;

  const positions = new Float32Array(maxOut * 3);
  const intensities = new Float32Array(maxOut);
  let pi = 0;

  for (let row = 0; row < height; row += step) {
    for (let col = 0; col < width; col += step) {
      const base = (row * width + col) * chStride;
      const r0 = (raw as Float32Array)[base] ?? 0;
      const r1 = chStride > 1 ? (raw as Float32Array)[base + 1] ?? 0 : 0;
      const r2 = chStride > 2 ? (raw as Float32Array)[base + 2] ?? 0 : 0;

      const x = isFloat ? r0 : r0 / maxVal;
      const y = isFloat ? r1 : r1 / maxVal;
      const z = isFloat ? r2 : r2 / maxVal;

      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
      if (x === 0 && y === 0 && z === 0) continue;

      positions[pi * 3]     = isFloat ? x : x * width;
      positions[pi * 3 + 1] = isFloat ? y : y * height;
      positions[pi * 3 + 2] = isFloat ? z : z * width;
      intensities[pi] = (Math.abs(x) + Math.abs(y) + Math.abs(z)) / 3;
      pi++;
    }
  }

  const validPos = positions.slice(0, pi * 3);
  const validInt = intensities.slice(0, pi);

  return {
    positions: validPos,
    intensities: validInt,
    pointCount: pi,
    boundingBox: buildBoundingBox(validPos),
    sourceInfo: { width, height, channels: samplesPerPixel, bitDepth: bitsPerSample },
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
