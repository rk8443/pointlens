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

// ---------------------------------------------------------------------------
// PLY parser — supports ASCII and binary (little/big endian) variants, which
// covers files exported by MeshLab, CloudCompare, Open3D, Blender, etc.
// Only the "vertex" element is consumed; faces and other elements are skipped.
// ---------------------------------------------------------------------------
type PlyType = 'char' | 'uchar' | 'short' | 'ushort' | 'int' | 'uint' | 'float' | 'double';
const PLY_TYPE_ALIAS: Record<string, PlyType> = {
  char: 'char', int8: 'char',
  uchar: 'uchar', uint8: 'uchar',
  short: 'short', int16: 'short',
  ushort: 'ushort', uint16: 'ushort',
  int: 'int', int32: 'int',
  uint: 'uint', uint32: 'uint',
  float: 'float', float32: 'float',
  double: 'double', float64: 'double',
};
const PLY_TYPE_BYTES: Record<PlyType, number> = {
  char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8,
};

function readPlyValue(dv: DataView, offset: number, type: PlyType, le: boolean): number {
  switch (type) {
    case 'char':   return dv.getInt8(offset);
    case 'uchar':  return dv.getUint8(offset);
    case 'short':  return dv.getInt16(offset, le);
    case 'ushort': return dv.getUint16(offset, le);
    case 'int':    return dv.getInt32(offset, le);
    case 'uint':   return dv.getUint32(offset, le);
    case 'float':  return dv.getFloat32(offset, le);
    case 'double': return dv.getFloat64(offset, le);
  }
}

export function parsePly(buffer: ArrayBuffer, maxPoints = 1_000_000): PointCloudData {
  const bytes = new Uint8Array(buffer);

  // Parse ASCII header line-by-line up to "end_header".
  let headerEnd = -1;
  let headerText = '';
  for (let i = 0; i < bytes.length - 10; i++) {
    // Look for "end_header" + (\n or \r\n)
    if (
      bytes[i] === 0x65 && bytes[i + 1] === 0x6e && bytes[i + 2] === 0x64 &&
      bytes[i + 3] === 0x5f && bytes[i + 4] === 0x68 && bytes[i + 5] === 0x65 &&
      bytes[i + 6] === 0x61 && bytes[i + 7] === 0x64 && bytes[i + 8] === 0x65 &&
      bytes[i + 9] === 0x72
    ) {
      let j = i + 10;
      if (bytes[j] === 0x0d) j++; // \r
      if (bytes[j] === 0x0a) j++; // \n
      headerEnd = j;
      headerText = new TextDecoder('ascii').decode(bytes.subarray(0, i + 10));
      break;
    }
  }
  if (headerEnd < 0) throw new Error('PLY: missing end_header');

  const lines = headerText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== 'ply') throw new Error('PLY: missing magic "ply"');

  let format: 'ascii' | 'le' | 'be' | null = null;
  let inVertex = false;
  let vertexCount = 0;
  const vertexProps: Array<{ name: string; type: PlyType; isList: boolean; countType?: PlyType; itemType?: PlyType }> = [];
  const otherElements: Array<{ count: number; props: typeof vertexProps }> = [];
  let currentProps: typeof vertexProps | null = null;
  let currentCount = 0;

  const flushElement = () => {
    if (currentProps && !inVertex) {
      otherElements.push({ count: currentCount, props: currentProps });
    }
  };

  for (let li = 1; li < lines.length; li++) {
    const line = lines[li];
    if (line.startsWith('comment') || line.startsWith('obj_info')) continue;
    if (line.startsWith('format')) {
      const f = line.split(/\s+/)[1];
      if (f === 'ascii') format = 'ascii';
      else if (f === 'binary_little_endian') format = 'le';
      else if (f === 'binary_big_endian') format = 'be';
      else throw new Error(`PLY: unsupported format "${f}"`);
      continue;
    }
    if (line.startsWith('element')) {
      flushElement();
      const parts = line.split(/\s+/);
      const name = parts[1];
      const count = parseInt(parts[2], 10);
      inVertex = name === 'vertex';
      // For the vertex element, point currentProps at vertexProps directly
      // so subsequent `property` lines populate the array we read later.
      // For other elements, use a throwaway array captured by flushElement.
      currentProps = inVertex ? vertexProps : [];
      currentCount = count;
      if (inVertex) vertexCount = count;
      continue;
    }
    if (line.startsWith('property') && currentProps) {
      const parts = line.split(/\s+/);
      if (parts[1] === 'list') {
        const countType = PLY_TYPE_ALIAS[parts[2]];
        const itemType = PLY_TYPE_ALIAS[parts[3]];
        const name = parts[4];
        if (!countType || !itemType) throw new Error(`PLY: bad list types in "${line}"`);
        currentProps.push({ name, type: itemType, isList: true, countType, itemType });
      } else {
        const type = PLY_TYPE_ALIAS[parts[1]];
        const name = parts[2];
        if (!type) throw new Error(`PLY: unknown type "${parts[1]}"`);
        currentProps.push({ name, type, isList: false });
      }
    }
  }
  flushElement();

  if (!format) throw new Error('PLY: missing format line');
  if (vertexCount === 0) throw new Error('PLY: no vertex element');

  const idxX = vertexProps.findIndex((p) => p.name === 'x');
  const idxY = vertexProps.findIndex((p) => p.name === 'y');
  const idxZ = vertexProps.findIndex((p) => p.name === 'z');
  if (idxX < 0 || idxY < 0 || idxZ < 0) throw new Error('PLY: vertex element missing x/y/z');
  const idxR = vertexProps.findIndex((p) => p.name === 'red' || p.name === 'r');
  const idxG = vertexProps.findIndex((p) => p.name === 'green' || p.name === 'g');
  const idxB = vertexProps.findIndex((p) => p.name === 'blue' || p.name === 'b');
  const idxI = vertexProps.findIndex(
    (p) => p.name === 'intensity' || p.name === 'scalar_intensity' || p.name === 'gray',
  );

  // Subsample to maxPoints
  const stride = vertexCount > maxPoints ? Math.ceil(vertexCount / maxPoints) : 1;
  const keptCount = Math.ceil(vertexCount / stride);
  const positions = new Float32Array(keptCount * 3);
  const intensities = new Float32Array(keptCount);
  let kept = 0;

  if (format === 'ascii') {
    // Decode the rest of the file as ASCII and split into tokens line-by-line.
    const body = new TextDecoder('ascii').decode(bytes.subarray(headerEnd));
    const bodyLines = body.split(/\r?\n/);
    let cursor = 0;
    for (let v = 0; v < vertexCount; v++) {
      // Skip blank lines
      while (cursor < bodyLines.length && bodyLines[cursor].trim() === '') cursor++;
      if (cursor >= bodyLines.length) break;
      if (v % stride !== 0) { cursor++; continue; }
      const tokens = bodyLines[cursor].trim().split(/\s+/);
      cursor++;
      const x = parseFloat(tokens[idxX]);
      const y = parseFloat(tokens[idxY]);
      const z = parseFloat(tokens[idxZ]);
      if (isFinite(x) && isFinite(y) && isFinite(z)) {
        positions[kept * 3 + 0] = x;
        positions[kept * 3 + 1] = y;
        positions[kept * 3 + 2] = z;
        let ival = 1.0;
        if (idxI >= 0) {
          const iv = parseFloat(tokens[idxI]);
          if (isFinite(iv)) ival = iv > 1.0 ? iv / 255.0 : iv;
        } else if (idxR >= 0 && idxG >= 0 && idxB >= 0) {
          const r = parseFloat(tokens[idxR]) / 255;
          const g = parseFloat(tokens[idxG]) / 255;
          const b = parseFloat(tokens[idxB]) / 255;
          ival = 0.299 * r + 0.587 * g + 0.114 * b;
        }
        intensities[kept] = ival;
        kept++;
      }
    }
  } else {
    const le = format === 'le';
    // For binary, all vertex properties are fixed-size scalars in practice.
    if (vertexProps.some((p) => p.isList)) {
      throw new Error('PLY: binary vertex lists are not supported');
    }
    const vertexBytes = vertexProps.reduce((s, p) => s + PLY_TYPE_BYTES[p.type], 0);
    const offsets: number[] = [];
    let acc = 0;
    for (const p of vertexProps) { offsets.push(acc); acc += PLY_TYPE_BYTES[p.type]; }

    const expectedEnd = headerEnd + vertexCount * vertexBytes;
    if (expectedEnd > buffer.byteLength) {
      throw new Error(`PLY: file truncated (need ${expectedEnd} bytes, have ${buffer.byteLength})`);
    }
    const dv = new DataView(buffer);
    for (let v = 0; v < vertexCount; v++) {
      if (v % stride !== 0) continue;
      const base = headerEnd + v * vertexBytes;
      const x = readPlyValue(dv, base + offsets[idxX], vertexProps[idxX].type, le);
      const y = readPlyValue(dv, base + offsets[idxY], vertexProps[idxY].type, le);
      const z = readPlyValue(dv, base + offsets[idxZ], vertexProps[idxZ].type, le);
      if (isFinite(x) && isFinite(y) && isFinite(z)) {
        positions[kept * 3 + 0] = x;
        positions[kept * 3 + 1] = y;
        positions[kept * 3 + 2] = z;
        let ival = 1.0;
        if (idxI >= 0) {
          const raw = readPlyValue(dv, base + offsets[idxI], vertexProps[idxI].type, le);
          ival = raw > 1.0 ? raw / 255.0 : raw;
        } else if (idxR >= 0 && idxG >= 0 && idxB >= 0) {
          const r = readPlyValue(dv, base + offsets[idxR], vertexProps[idxR].type, le) / 255;
          const g = readPlyValue(dv, base + offsets[idxG], vertexProps[idxG].type, le) / 255;
          const b = readPlyValue(dv, base + offsets[idxB], vertexProps[idxB].type, le) / 255;
          ival = 0.299 * r + 0.587 * g + 0.114 * b;
        }
        intensities[kept] = ival;
        kept++;
      }
    }
  }

  if (kept === 0) throw new Error('PLY: parsed 0 valid points');

  const finalPos = positions.subarray(0, kept * 3);
  const finalInt = intensities.subarray(0, kept);
  const posArr = new Float32Array(finalPos);
  const intArr = new Float32Array(finalInt);

  console.log('[parsePly]', {
    format, vertexCount, kept, stride,
    hasColor: idxR >= 0 && idxG >= 0 && idxB >= 0,
    hasIntensity: idxI >= 0,
  });

  // Mark unused element count so TS doesn't complain.
  void otherElements;

  return {
    positions: posArr,
    intensities: intArr,
    pointCount: kept,
    boundingBox: buildBoundingBox(posArr),
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

  if (ext === 'ply') {
    onStage?.('Reading PLY…');
    const buf = await file.arrayBuffer();
    onStage?.('Decoding PLY…');
    return parsePly(buf, maxPoints);
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

/**
 * Generates a procedural dotted Earth point cloud — a Fibonacci sphere lattice
 * masked so that dots concentrate inside continent ellipses (in lat/lon space)
 * and thin out over the oceans. Produces a recognizable globe of ~80k points
 * that loads instantly and shows off the viewer's color-by-height (latitude)
 * gradient nicely.
 */
export function generateDemoCloud(): PointCloudData {
  const TARGET_POINTS = 80_000;
  const RADIUS = 10;
  const SAMPLES = 220_000; // oversample, then mask

  // Continents as rough lat/lon ellipses: { latC, lonC, latR, lonR, density }.
  // Coordinates in degrees. Density 0–1 = probability a sample inside the
  // ellipse survives the mask.
  type Cont = { lat: number; lon: number; latR: number; lonR: number; d: number };
  const CONTINENTS: Cont[] = [
    { lat: 50, lon: -100, latR: 25, lonR: 35, d: 0.95 }, // North America
    { lat: -15, lon: -60, latR: 30, lonR: 18, d: 0.9 },  // South America
    { lat: 52, lon: 18, latR: 14, lonR: 30, d: 0.85 },   // Europe
    { lat: 5, lon: 22, latR: 30, lonR: 22, d: 0.92 },    // Africa
    { lat: 45, lon: 95, latR: 25, lonR: 55, d: 0.95 },   // Asia
    { lat: -25, lon: 135, latR: 12, lonR: 18, d: 0.9 },  // Australia
    { lat: -82, lon: 0, latR: 8, lonR: 180, d: 0.7 },    // Antarctica ring
    { lat: 73, lon: -42, latR: 8, lonR: 22, d: 0.7 },    // Greenland
    { lat: 60, lon: -160, latR: 8, lonR: 18, d: 0.5 },   // Alaska tail
    { lat: 30, lon: 50, latR: 12, lonR: 16, d: 0.7 },    // Middle East
    { lat: 20, lon: 80, latR: 12, lonR: 12, d: 0.85 },   // Indian subcontinent
  ];

  const OCEAN_NOISE_DENSITY = 0.015; // sparse stippling so oceans aren't dead

  // Tiny seeded RNG so the globe is identical run-to-run (mulberry32).
  let s = 0x6d2b79f5;
  const rand = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const insideAnyContinent = (lat: number, lon: number) => {
    for (const c of CONTINENTS) {
      // Wrap-around longitude distance.
      let dLon = Math.abs(lon - c.lon);
      if (dLon > 180) dLon = 360 - dLon;
      const nx = dLon / c.lonR;
      const ny = (lat - c.lat) / c.latR;
      if (nx * nx + ny * ny <= 1) {
        // Soften edges: fall off toward the ellipse rim.
        const r2 = nx * nx + ny * ny;
        const falloff = 1 - r2 * 0.4;
        if (rand() < c.d * falloff) return true;
      }
    }
    return false;
  };

  // Fibonacci sphere: i / N stepped golden-ratio rotation gives uniform spread.
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const tmpPositions: number[] = [];
  const tmpIntensities: number[] = [];

  for (let i = 0; i < SAMPLES && tmpPositions.length / 3 < TARGET_POINTS; i++) {
    const yNorm = 1 - (i / (SAMPLES - 1)) * 2; // 1 -> -1
    const radiusAtY = Math.sqrt(1 - yNorm * yNorm);
    const theta = GOLDEN * i;

    const x = Math.cos(theta) * radiusAtY;
    const y = yNorm;
    const z = Math.sin(theta) * radiusAtY;

    // To lat/lon.
    const lat = Math.asin(y) * (180 / Math.PI);
    const lon = Math.atan2(z, x) * (180 / Math.PI);

    const inLand = insideAnyContinent(lat, lon);
    if (!inLand && rand() > OCEAN_NOISE_DENSITY) continue;

    // Tiny surface jitter so it doesn't read as a perfectly mathematical shell.
    const jitter = inLand ? 0.04 : 0.02;
    const r = RADIUS + (rand() - 0.5) * jitter;
    // The viewer uses Z as up by convention — map our y (lat axis) to Z so the
    // height/colormap gradient reads as a rainbow from south pole to north.
    tmpPositions.push(x * r, z * r, y * r);
    // Intensity: brighter on land, dimmer over ocean stippling.
    tmpIntensities.push(inLand ? 0.55 + rand() * 0.45 : 0.05 + rand() * 0.15);
  }

  const pointCount = tmpPositions.length / 3;
  const positions = new Float32Array(tmpPositions);
  const intensities = new Float32Array(tmpIntensities);

  return {
    positions,
    intensities,
    pointCount,
    boundingBox: buildBoundingBox(positions),
  };
}
