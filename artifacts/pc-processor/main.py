import os
import gc
import io
import struct
import logging
import numpy as np
import tifffile
from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_FILE_MB = 500
DEFAULT_MAX_POINTS = 100_000
HARD_MAX_POINTS = 2_000_000


def clean_positions(xs: np.ndarray, ys: np.ndarray, zs: np.ndarray) -> np.ndarray:
    positions = np.column_stack([
        xs.ravel().astype(np.float32),
        ys.ravel().astype(np.float32),
        zs.ravel().astype(np.float32),
    ])
    valid = np.isfinite(positions).all(axis=1)
    valid &= ~((positions[:, 0] == 0) & (positions[:, 1] == 0) & (positions[:, 2] == 0))
    return np.ascontiguousarray(positions[valid])


def read_tif(data: bytes, max_pts: int) -> tuple[np.ndarray, dict]:
    with tifffile.TiffFile(io.BytesIO(data)) as tif:
        page = tif.pages[0]
        dtype = page.dtype
        bits = dtype.itemsize * 8
        shape = page.shape
        log.info(f"TIFF shape={shape} dtype={dtype}")

        # Determine H, W, C before loading any pixel data
        if len(shape) == 2:
            H, W, C = shape[0], shape[1], 1
        elif len(shape) == 3:
            # Could be (H,W,C) or (C,H,W) — detect by smallest first dim
            if shape[0] <= 4 and shape[0] < shape[1] and shape[0] < shape[2]:
                C, H, W = shape
            else:
                H, W, C = shape
        else:
            raise ValueError(f"Unexpected TIFF shape: {shape}")

        step = max(1, int(np.sqrt(H * W / max_pts)))
        log.info(f"H={H} W={W} C={C} step={step} → ~{(H//step)*(W//step)} pts")

        # Load the raw data — releases file handle on exit
        raw = tif.asarray()

    # ---- outside the TiffFile context — file handle closed ----

    raw = raw.astype(np.float32)  # convert in-place-ish

    if raw.ndim == 2:
        arr_ds = raw[::step, ::step]
        del raw; gc.collect()
        H2, W2 = arr_ds.shape
        xs = np.tile(np.arange(W2, dtype=np.float32) * step, H2)
        ys = np.repeat(np.arange(H2, dtype=np.float32) * step, W2)
        zs = arr_ds.ravel()
        del arr_ds; gc.collect()

    elif raw.ndim == 3:
        # Normalise to (H, W, C) without copying if possible
        if raw.shape[0] <= 4 and raw.shape[0] < raw.shape[1]:
            raw = np.moveaxis(raw, 0, -1)   # (C,H,W) → (H,W,C)
        H2_pre, W2_pre, C = raw.shape
        arr_ds = np.ascontiguousarray(raw[::step, ::step, :])
        del raw; gc.collect()
        H2, W2 = arr_ds.shape[:2]

        if C >= 3:
            xs = arr_ds[:, :, 0].ravel()
            ys = arr_ds[:, :, 1].ravel()
            zs = arr_ds[:, :, 2].ravel()
        elif C == 2:
            xs = arr_ds[:, :, 0].ravel()
            ys = arr_ds[:, :, 1].ravel()
            zs = np.zeros(H2 * W2, dtype=np.float32)
        else:  # 1 channel — depth map
            xs = np.tile(np.arange(W2, dtype=np.float32) * step, H2)
            ys = np.repeat(np.arange(H2, dtype=np.float32) * step, W2)
            zs = arr_ds[:, :, 0].ravel()
        del arr_ds; gc.collect()

    else:
        raise ValueError(f"Unexpected array ndim after load: {raw.ndim}")

    positions = clean_positions(xs, ys, zs)
    del xs, ys, zs; gc.collect()

    log.info(f"Returning {positions.shape[0]} points")
    return positions, {
        "width": W, "height": H, "channels": C,
        "bitDepth": bits, "pointCount": positions.shape[0],
    }


def read_png(data: bytes, max_pts: int) -> tuple[np.ndarray, dict]:
    from PIL import Image
    img = Image.open(io.BytesIO(data)).convert("RGB")
    W_orig, H_orig = img.size
    scale = min(1.0, (max_pts / (W_orig * H_orig)) ** 0.5)
    if scale < 1.0:
        img = img.resize((max(1, int(W_orig * scale)), max(1, int(H_orig * scale))), Image.BILINEAR)
    arr = np.array(img, dtype=np.float32) / 255.0
    del img; gc.collect()
    xs = (arr[:, :, 0] * W_orig).ravel()
    ys = (arr[:, :, 1] * H_orig).ravel()
    zs = (arr[:, :, 2] * W_orig).ravel()
    del arr; gc.collect()
    positions = clean_positions(xs, ys, zs)
    return positions, {"width": W_orig, "height": H_orig, "channels": 3, "bitDepth": 8}


def encode_response(positions: np.ndarray, meta: dict) -> bytes:
    N = positions.shape[0]
    header = struct.pack(
        "<7i", 0x504C4300, N,
        meta.get("width", 0), meta.get("height", 0),
        meta.get("channels", 3), meta.get("bitDepth", 32), 0,
    )
    return header + np.ascontiguousarray(positions, dtype=np.float32).tobytes()


@app.get("/pc-api/healthz")
def healthz():
    return {"status": "ok"}


@app.post("/pc-api/upload")
async def upload_file(
    file: UploadFile = File(...),
    max_points: int = Query(default=DEFAULT_MAX_POINTS, ge=1000, le=HARD_MAX_POINTS),
):
    data = await file.read()
    size_mb = len(data) / (1024 * 1024)
    log.info(f"Received {file.filename!r} size={size_mb:.1f} MB max_points={max_points}")

    if size_mb > MAX_FILE_MB:
        raise HTTPException(413, f"File too large ({size_mb:.0f} MB). Max {MAX_FILE_MB} MB.")

    filename = (file.filename or "").lower()
    try:
        if filename.endswith((".tif", ".tiff")):
            positions, meta = read_tif(data, max_points)
        elif filename.endswith(".png"):
            positions, meta = read_png(data, max_points)
        else:
            raise HTTPException(400, "Upload a .tif, .tiff, or .png file.")
    except HTTPException:
        raise
    except MemoryError:
        gc.collect()
        raise HTTPException(507, "Not enough memory to process this file. Try a smaller file.")
    except Exception as e:
        log.exception("Parse error")
        raise HTTPException(422, f"Parse error: {e}")
    finally:
        del data; gc.collect()

    if positions.shape[0] == 0:
        raise HTTPException(422, "No valid points found — file may be fully masked or all-zero.")

    payload = encode_response(positions, meta)
    n = positions.shape[0]
    del positions; gc.collect()

    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={"X-Point-Count": str(n)},
    )


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 7891))
    uvicorn.run(app, host="0.0.0.0", port=port, timeout_keep_alive=300)
