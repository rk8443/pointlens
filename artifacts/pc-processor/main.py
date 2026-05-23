import os
import io
import struct
import numpy as np
import tifffile
from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_FILE_MB = 500
DEFAULT_MAX_POINTS = 500_000
HARD_MAX_POINTS = 2_000_000


def downsample(positions: np.ndarray, max_pts: int) -> np.ndarray:
    """Uniform stride downsample — keeps spatial distribution."""
    n = positions.shape[0]
    if n <= max_pts:
        return positions
    step = max(1, n // max_pts)
    return positions[::step]


def clean_positions(xs: np.ndarray, ys: np.ndarray, zs: np.ndarray) -> np.ndarray:
    """Stack and remove NaN, Inf, and all-zero rows."""
    positions = np.stack([xs, ys, zs], axis=-1).astype(np.float32)
    # Remove NaN or Inf
    valid = np.isfinite(positions).all(axis=1)
    # Remove all-zero rows (masked/invalid pixels)
    valid &= ~((positions[:, 0] == 0) & (positions[:, 1] == 0) & (positions[:, 2] == 0))
    return positions[valid]


def read_tif(data: bytes, max_pts: int) -> tuple[np.ndarray, dict]:
    """
    Read LMI 3-channel TIFF using tifffile.
    Handles (H,W), (H,W,C), (C,H,W) layouts.
    Returns (positions: Nx3 float32, meta: dict)
    """
    with tifffile.TiffFile(io.BytesIO(data)) as tif:
        page = tif.pages[0]
        bits = page.dtype.itemsize * 8

        # Read the first series — use level=0 for large images
        try:
            arr = tif.asarray()
        except Exception as e:
            raise ValueError(f"Could not decode TIFF: {e}")

        arr = arr.astype(np.float32)

        # Normalise shape to (H, W, C)
        if arr.ndim == 2:
            H, W = arr.shape
            # Depth map: X=column, Y=row, Z=value
            # Downsample spatially before building coordinate arrays
            step = max(1, int(np.sqrt((H * W) / max_pts)))
            arr_ds = arr[::step, ::step]
            H2, W2 = arr_ds.shape
            col_idx = np.tile(np.arange(W2, dtype=np.float32) * step, H2)
            row_idx = np.repeat(np.arange(H2, dtype=np.float32) * step, W2)
            zs = arr_ds.ravel()
            positions = clean_positions(col_idx, row_idx, zs)
            ch = 1
        elif arr.ndim == 3:
            # Detect (C, H, W) vs (H, W, C)
            if arr.shape[0] <= 4 and arr.shape[0] < arr.shape[1] and arr.shape[0] < arr.shape[2]:
                arr = np.moveaxis(arr, 0, -1)  # → (H, W, C)
            H, W, C = arr.shape
            ch = C

            # Spatial downsample before extraction
            step = max(1, int(np.sqrt((H * W) / max_pts)))
            arr_ds = arr[::step, ::step, :]

            if C == 1:
                H2, W2 = arr_ds.shape[:2]
                col_idx = np.tile(np.arange(W2, dtype=np.float32) * step, H2)
                row_idx = np.repeat(np.arange(H2, dtype=np.float32) * step, W2)
                zs = arr_ds[:, :, 0].ravel()
                positions = clean_positions(col_idx, row_idx, zs)
            elif C == 2:
                xs = arr_ds[:, :, 0].ravel()
                ys = arr_ds[:, :, 1].ravel()
                zs = np.zeros_like(xs)
                positions = clean_positions(xs, ys, zs)
            else:
                # 3+ channels → X, Y, Z
                xs = arr_ds[:, :, 0].ravel()
                ys = arr_ds[:, :, 1].ravel()
                zs = arr_ds[:, :, 2].ravel()
                positions = clean_positions(xs, ys, zs)
        else:
            raise ValueError(f"Unsupported TIFF array shape: {arr.shape}")

    meta = {
        "width": int(W) if "W" in dir() else 0,
        "height": int(H) if "H" in dir() else 0,
        "channels": int(ch),
        "bitDepth": int(bits),
        "pointCount": int(positions.shape[0]),
    }
    return positions, meta


def read_png(data: bytes, max_pts: int) -> tuple[np.ndarray, dict]:
    """Read PNG as 3-channel image → point cloud (R=X, G=Y, B=Z)."""
    from PIL import Image
    img = Image.open(io.BytesIO(data)).convert("RGB")
    W, H = img.size

    # Resize if too large
    scale = min(1.0, (max_pts / (W * H)) ** 0.5)
    if scale < 1.0:
        W2, H2 = max(1, int(W * scale)), max(1, int(H * scale))
        img = img.resize((W2, H2), Image.BILINEAR)
    else:
        W2, H2 = W, H

    arr = np.array(img, dtype=np.float32) / 255.0  # (H2, W2, 3)
    xs = (arr[:, :, 0] * W).ravel()
    ys = (arr[:, :, 1] * H).ravel()
    zs = (arr[:, :, 2] * W).ravel()
    positions = clean_positions(xs, ys, zs)
    meta = {"width": W, "height": H, "channels": 3, "bitDepth": 8, "pointCount": int(positions.shape[0])}
    return positions, meta


def encode_response(positions: np.ndarray, meta: dict) -> bytes:
    """
    Binary wire format:
      Header  7 × int32 (28 bytes):
        [0] magic = 0x504C4300
        [1] point_count
        [2] original_width
        [3] original_height
        [4] channels
        [5] bit_depth
        [6] reserved
      Body: float32[N*3] interleaved X, Y, Z
    """
    N = positions.shape[0]
    header = struct.pack(
        "<7i",
        0x504C4300,
        N,
        meta.get("width", 0),
        meta.get("height", 0),
        meta.get("channels", 3),
        meta.get("bitDepth", 32),
        0,
    )
    return header + positions.astype(np.float32).tobytes()


@app.get("/pc-api/healthz")
def healthz():
    return {"status": "ok"}


@app.post("/pc-api/upload")
async def upload_file(
    file: UploadFile = File(...),
    max_points: int = Query(default=DEFAULT_MAX_POINTS, ge=1000, le=HARD_MAX_POINTS),
):
    # Size guard
    data = await file.read()
    size_mb = len(data) / (1024 * 1024)
    if size_mb > MAX_FILE_MB:
        raise HTTPException(status_code=413, detail=f"File too large ({size_mb:.0f} MB). Max {MAX_FILE_MB} MB.")

    filename = (file.filename or "").lower()

    try:
        if filename.endswith(".tif") or filename.endswith(".tiff"):
            positions, meta = read_tif(data, max_points)
        elif filename.endswith(".png"):
            positions, meta = read_png(data, max_points)
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported format. Upload a TIF or PNG file.")
    except HTTPException:
        raise
    except MemoryError:
        raise HTTPException(status_code=507, detail="File too large to process. Try a smaller file or lower max_points.")
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Parse error: {str(e)}")

    if positions.shape[0] == 0:
        raise HTTPException(status_code=422, detail="No valid points found. The file may be empty or fully masked.")

    payload = encode_response(positions, meta)
    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={
            "X-Point-Count": str(positions.shape[0]),
            "X-Image-Width": str(meta.get("width", 0)),
            "X-Image-Height": str(meta.get("height", 0)),
        },
    )


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 7891))
    uvicorn.run(app, host="0.0.0.0", port=port, timeout_keep_alive=120)
