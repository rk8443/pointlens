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
      // X = column, Y = row (TRUE pixel coords, no squishing — preserves aspect).
      // Auto-detect the depth channel: pick whichever channel has the most
      // non-zero samples in a quick scan of the image. Different LMI exports
      // store depth in different channels (sometimes 0, sometimes 2).
      let zChan = 0;
      if (ch > 1) {
        const scanCount = Math.min(20000, width * height);
        const scanStride = Math.max(1, Math.floor((width * height) / scanCount));
        const nonZero = new Array(ch).fill(0);
        for (let p = 0; p < width * height; p += scanStride) {
          for (let k = 0; k < ch; k++) {
            if ((raw[p * ch + k] ?? 0) !== 0) nonZero[k]++;
          }
        }
        let best = 0;
        for (let k = 1; k < ch; k++) if (nonZero[k] > nonZero[best]) best = k;
        zChan = best;
        console.log('[parseTiff] non-zero counts per channel:', nonZero, '→ picked Z channel', zChan);
      }
      // Match Z's display range to ~20% of the larger surface dimension. That
      // keeps height visible without exaggerating it the way `width/4` did.
      const zVisualScale = Math.max(width, height) / 5;
      for (let r = 0; r < height; r += step) {
        for (let c = 0; c < width; c += step) {
          const base = (r * width + c) * ch;
          const z = raw[base + zChan] ?? 0;
          xs[i] = c;
          ys[i] = r;
          const zNorm = isFloat ? z : z / maxVal;
          zs[i] = zNorm * zVisualScale;
          if (z === 0) {
            // No-data pixel — mark for filter below
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

/**
 * Parse a Keyence BMP point cloud (VR-3000/VR-5000 series and similar).
 * Keyence exports height-maps as 24-bit BMP where each pixel's RGB encodes
 * a 24-bit unsigned height: z = R*65536 + G*256 + B. 0 is the no-data marker.
 * For plain grayscale BMPs (R==G==B), we fall back to single-channel height.
 */
export async function parseKeyenceBmp(buffer: ArrayBuffer, maxPoints = 100_000): Promise<PointCloudData> {
  const blob = new Blob([buffer], { type: "image/bmp" });
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context for BMP decode");
  ctx.drawImage(bitmap, 0, 0);
  const px = ctx.getImageData(0, 0, width, height).data;

  // Detect encoding: scan a sample of non-zero pixels — if nearly all of them
  // have R==G==B, it's grayscale; otherwise treat as 24-bit packed height.
  // We MUST exclude zero pixels: Keyence packed-RGB heightmaps often have
  // huge no-data regions of (0,0,0), which would falsely satisfy R==G==B and
  // misclassify the entire file as grayscale.
  const sampleN = Math.min(5000, width * height);
  const sampleStride = Math.max(1, Math.floor((width * height) / sampleN));
  let grayCount = 0, nonZeroSamples = 0;
  for (let p = 0; p < width * height; p += sampleStride) {
    const r = px[p * 4], g = px[p * 4 + 1], b = px[p * 4 + 2];
    if (r === 0 && g === 0 && b === 0) continue; // skip no-data
    nonZeroSamples++;
    if (r === g && g === b) grayCount++;
  }
  // Require strong evidence (>=98% of valid samples) AND enough samples.
  // Fall back to packed-RGB on insufficient evidence — safer default for
  // Keyence files where misclassifying packed-RGB as grayscale destroys depth.
  const isGrayscale = nonZeroSamples >= 100 && (grayCount / nonZeroSamples) >= 0.98;

  // For packed-RGB encoding, decide between RGB (z = R<<16|G<<8|B) and
  // BGR (z = B<<16|G<<8|R) byte order. The wrong order makes the height
  // jump by ~65536 whenever the true value crosses a 256 boundary, which
  // appears as parallel "layered" planes in the cloud. We pick whichever
  // encoding produces fewer big jumps between horizontally-adjacent pixels.
  let useBgr = false;
  if (!isGrayscale) {
    const JUMP = 32768;
    let rgbJumps = 0, bgrJumps = 0, comparisons = 0;
    const stride = Math.max(1, Math.floor((width * height) / 5000));
    for (let p = 0; p + 1 < width * height; p += stride) {
      const o1 = p * 4, o2 = (p + 1) * 4;
      const r1 = px[o1], g1 = px[o1 + 1], b1 = px[o1 + 2];
      const r2 = px[o2], g2 = px[o2 + 1], b2 = px[o2 + 2];
      if ((r1 | g1 | b1) === 0 || (r2 | g2 | b2) === 0) continue;
      const zRgb1 = (r1 << 16) | (g1 << 8) | b1;
      const zRgb2 = (r2 << 16) | (g2 << 8) | b2;
      const zBgr1 = (b1 << 16) | (g1 << 8) | r1;
      const zBgr2 = (b2 << 16) | (g2 << 8) | r2;
      if (Math.abs(zRgb1 - zRgb2) > JUMP) rgbJumps++;
      if (Math.abs(zBgr1 - zBgr2) > JUMP) bgrJumps++;
      comparisons++;
    }
    useBgr = bgrJumps < rgbJumps;
    console.log('[parseKeyenceBmp] byte-order test:', { rgbJumps, bgrJumps, comparisons, chose: useBgr ? 'BGR' : 'RGB' });
  }

  console.log('[parseKeyenceBmp]', {
    width, height, isGrayscale, useBgr, nonZeroSamples,
    grayRatio: nonZeroSamples > 0 ? (grayCount / nonZeroSamples).toFixed(3) : 'n/a',
  });

  // Subsample to honor maxPoints budget
  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / maxPoints)));
  const cols = Math.ceil(width / step);
  const rows = Math.ceil(height / step);
  const cap = cols * rows;

  const xs = new Float32Array(cap);
  const ys = new Float32Array(cap);
  const zsRaw = new Float32Array(cap); // raw height before scaling
  let i = 0;
  let zMin = Infinity, zMax = -Infinity;

  for (let r = 0; r < height; r += step) {
    for (let c = 0; c < width; c += step) {
      const o = (r * width + c) * 4;
      const R = px[o], G = px[o + 1], B = px[o + 2];
      let z: number;
      if (isGrayscale) {
        z = R; // 0..255
      } else {
        // 24-bit packed height. Byte order auto-detected above.
        // 0 = no-data per Keyence convention.
        z = useBgr ? ((B << 16) | (G << 8) | R) : ((R << 16) | (G << 8) | B);
      }
      xs[i] = c;
      ys[i] = r;
      if (z === 0) {
        zsRaw[i] = NaN;
      } else {
        zsRaw[i] = z;
        if (z < zMin) zMin = z;
        if (z > zMax) zMax = z;
      }
      i++;
    }
  }

  // Scale Z to a sensible visual range using min-max normalization.
  // Note: parseTiff (LMI) divides by maxVal (full type range) instead. We
  // diverge here because Keyence packed-RGB heights typically occupy a tiny
  // fraction of the 24-bit range (0..16M); dividing by 0xFFFFFF would flatten
  // the cloud almost to a plane. Min-max gives a usable default presentation.
  const zRange = zMax - zMin;
  const zVisualScale = Math.max(width, height) / 5;
  const positions = new Float32Array(cap * 3);
  const intensities = new Float32Array(cap);
  let pi = 0;
  for (let k = 0; k < cap; k++) {
    const zRaw = zsRaw[k];
    if (!isFinite(zRaw)) continue;
    const zNorm = zRange > 0 ? (zRaw - zMin) / zRange : 0;
    const z = zNorm * zVisualScale;
    positions[pi * 3]     = xs[k];
    positions[pi * 3 + 1] = ys[k];
    positions[pi * 3 + 2] = z;
    intensities[pi] = zNorm;
    pi++;
  }

  console.log('[parseKeyenceBmp] valid points:', pi, 'raw Z range:', zMin, '…', zMax);

  if (pi === 0) {
    throw new Error(
      "No valid depth points found in BMP. All pixels are (0,0,0) — " +
      "this may not be a Keyence height-map BMP, or the file may be empty."
    );
  }

  const validPos = positions.slice(0, pi * 3);
  const validInt = intensities.slice(0, pi);
  return {
    positions: validPos,
    intensities: validInt,
    pointCount: pi,
    boundingBox: buildBoundingBox(validPos),
    sourceInfo: { width, height, channels: isGrayscale ? 1 : 3, bitDepth: isGrayscale ? 8 : 24 },
  };
}

/**
 * Best-effort parser for Cognex .cdb 3D image files (proprietary, undocumented).
 *
 * Reverse-engineered from a single sample captured on a Cognex A5030 sensor:
 *  - Magic `88 44 22 11` at offset 4
 *  - Header field at 0x2D = image width as BE u32 (was 2048 for A5030)
 *  - Data section starts after a fixed prelude + ~16 KB of `0x30` padding
 *  - Depth samples are stored as u16 big-endian in row-major order
 *  - 0 and 0xFFFF are no-data markers
 *  - Trailer (~1 KB) holds .NET BinaryFormatter calibration metadata
 *
 * Caveats: tested on ONE file. Width auto-detection falls back to a smoothness
 * heuristic over candidate widths if the header field isn't plausible.
 * Values are unscaled depth counts (mm conversion would require the
 * Cog3DCoordinateSpaceTree transform we can't decode here).
 */
export async function parseCognexCdb(buffer: ArrayBuffer, maxPoints = 100_000): Promise<PointCloudData> {
  const dv = new DataView(buffer);
  if (buffer.byteLength < 0x100) throw new Error("File too small to be a Cognex .cdb");
  const magic = dv.getUint32(4, false);
  if (magic !== 0x88442211) {
    throw new Error(`Not a Cognex .cdb file (magic ${magic.toString(16)}, expected 88442211)`);
  }

  // Width hint from header offset 0x2D (off-aligned, big-endian u32). Validate
  // it's a plausible image width; otherwise we'll auto-detect from row smoothness.
  let widthHint = dv.getUint32(0x2d, false);
  if (widthHint < 64 || widthHint > 8192) widthHint = 0;

  // Data section starts at 0x10ee (skip chunk header 12 bytes, then 16 KB padding).
  // These offsets are empirically determined from the one sample; if a future
  // file disagrees we'd need a smarter scanner.
  const DATA_START = 0x10ee + 12 + 0x4000;
  const TRAILER_BYTES = 1100; // .NET metadata at the end
  const dataEnd = buffer.byteLength - TRAILER_BYTES;
  if (DATA_START >= dataEnd) throw new Error("Cognex .cdb data section is too small");

  const usableBytes = (dataEnd - DATA_START) & ~1;
  const totalSamples = usableBytes >>> 1;
  const samples = new Uint16Array(totalSamples);
  // Manually read BE u16s — Uint16Array is host-endian.
  for (let i = 0; i < totalSamples; i++) {
    samples[i] = dv.getUint16(DATA_START + i * 2, false);
  }
  console.log('[parseCognexCdb] decoded u16 BE samples:', totalSamples);

  // Width auto-detect: try the hint and a list of common Cognex widths,
  // pick the one with smallest median row-to-row diff (smoothest layout).
  const candidates = Array.from(new Set([widthHint, 2048, 1920, 1536, 1280, 1024, 800, 768, 640, 512].filter(w => w > 0)));
  let bestW = widthHint || 2048;
  let bestScore = Infinity;
  for (const W of candidates) {
    const rows = Math.floor(totalSamples / W);
    if (rows < 50) continue;
    const sampleRows = Math.min(rows - 1, 200);
    const rowStep = Math.max(1, Math.floor((rows - 1) / sampleRows));
    const diffs: number[] = [];
    for (let r = 0; r < rows - 1; r += rowStep) {
      let acc = 0, n = 0;
      const stride = Math.max(1, Math.floor(W / 100));
      for (let c = 0; c < W; c += stride) {
        const a = samples[r * W + c];
        const b = samples[(r + 1) * W + c];
        if (a === 0 || a === 0xffff || b === 0 || b === 0xffff) continue;
        acc += Math.abs(a - b);
        n++;
      }
      if (n > 5) diffs.push(acc / n);
    }
    if (diffs.length === 0) continue;
    diffs.sort((a, b) => a - b);
    const median = diffs[diffs.length >> 1];
    if (median < bestScore) { bestScore = median; bestW = W; }
  }
  const W = bestW;
  const H = Math.floor(totalSamples / W);
  console.log('[parseCognexCdb] picked width:', W, 'height:', H, 'row-smoothness:', bestScore.toFixed(1), 'widthHint was:', widthHint);

  // First — full scan for valid samples and Z range. Cheap (one pass over u16[]).
  // We do the FULL scan (not subsampled) so we don't miss sparse valid pixels.
  let zMin = Infinity, zMax = -Infinity;
  let validTotal = 0;
  for (let i = 0; i < samples.length; i++) {
    const z = samples[i];
    if (z === 0 || z === 0xffff) continue;
    validTotal++;
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  console.log('[parseCognexCdb] full scan: validTotal=', validTotal, 'of', samples.length, `(${(validTotal/samples.length*100).toFixed(2)}%)`);

  // If the file has essentially no depth data, surface that clearly rather
  // than silently returning empty or throwing a generic error.
  if (validTotal < 100) {
    throw new Error(
      `This Cognex .cdb file contains almost no valid depth data ` +
      `(${validTotal} valid pixels out of ${samples.length}, ${(validTotal/samples.length*100).toFixed(3)}%). ` +
      `The scan may have failed, missed the target, or this may be a blank/calibration capture. ` +
      `Try a different file.`
    );
  }

  // Subsample so we don't exceed maxPoints
  const step = Math.max(1, Math.ceil(Math.sqrt((W * H) / maxPoints)));
  const cap = Math.ceil(W / step) * Math.ceil(H / step);
  const positions = new Float32Array(cap * 3);
  const intensities = new Float32Array(cap);
  let pi = 0;

  const zRange = zMax - zMin;
  const zVisualScale = Math.max(W, H) / 5;
  for (let r = 0; r < H; r += step) {
    for (let c = 0; c < W; c += step) {
      const z = samples[r * W + c];
      if (z === 0 || z === 0xffff) continue;
      const zNorm = zRange > 0 ? (z - zMin) / zRange : 0;
      positions[pi * 3]     = c;
      positions[pi * 3 + 1] = r;
      positions[pi * 3 + 2] = zNorm * zVisualScale;
      intensities[pi] = zNorm;
      pi++;
    }
  }

  console.log('[parseCognexCdb] valid points:', pi, 'raw Z range:', zMin, '…', zMax);
  if (pi === 0) throw new Error("No valid depth samples found in Cognex .cdb");

  const validPos = positions.slice(0, pi * 3);
  return {
    positions: validPos,
    intensities: intensities.slice(0, pi),
    pointCount: pi,
    boundingBox: buildBoundingBox(validPos),
    sourceInfo: { width: W, height: H, channels: 1, bitDepth: 16 },
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

  if (ext === 'bmp') {
    onStage?.('Reading Keyence BMP…');
    const buf = await file.arrayBuffer();
    onStage?.('Decoding BMP…');
    return parseKeyenceBmp(buf, maxPoints);
  }

  if (ext === 'cdb') {
    onStage?.('Reading Cognex CDB…');
    const buf = await file.arrayBuffer();
    onStage?.('Decoding Cognex 3D image (experimental)…');
    return parseCognexCdb(buf, maxPoints);
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
