import os
import io
import struct
import numpy as np
import tifffile
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def read_tif(data: bytes) -> tuple[np.ndarray, dict]:
    """
    Read LMI 3-channel TIFF using tifffile.
    Returns (positions: Nx3 float32 array, meta: dict)
    """
    with tifffile.TiffFile(io.BytesIO(data)) as tif:
        # Read all pages/series
        arr = tif.asarray()  # shape: (H, W) or (H, W, C) or (C, H, W)
        
        page = tif.pages[0]
        bits = page.dtype.itemsize * 8
        sample_format = str(page.dtype)

        # Normalise to (H, W, C)
        if arr.ndim == 2:
            # Single-channel — treat as Z/depth map, X=col, Y=row
            H, W = arr.shape
            xs = np.tile(np.arange(W, dtype=np.float32), H)
            ys = np.repeat(np.arange(H, dtype=np.float32), W)
            zs = arr.ravel().astype(np.float32)
            ch = 1
        elif arr.ndim == 3:
            if arr.shape[0] in (1, 2, 3, 4) and arr.shape[0] < arr.shape[1]:
                # (C, H, W) → (H, W, C)
                arr = np.moveaxis(arr, 0, -1)
            H, W, C = arr.shape
            ch = C
            if C == 1:
                xs = np.tile(np.arange(W, dtype=np.float32), H)
                ys = np.repeat(np.arange(H, dtype=np.float32), W)
                zs = arr[:, :, 0].ravel().astype(np.float32)
            elif C == 2:
                xs = arr[:, :, 0].ravel().astype(np.float32)
                ys = arr[:, :, 1].ravel().astype(np.float32)
                zs = np.zeros(H * W, dtype=np.float32)
            else:
                # 3 or more channels: treat as X, Y, Z
                xs = arr[:, :, 0].ravel().astype(np.float32)
                ys = arr[:, :, 1].ravel().astype(np.float32)
                zs = arr[:, :, 2].ravel().astype(np.float32)
        else:
            raise ValueError(f"Unexpected array shape: {arr.shape}")

        # Filter out zero/invalid points (rows where all coords are 0)
        mask = ~((xs == 0) & (ys == 0) & (zs == 0))
        xs, ys, zs = xs[mask], ys[mask], zs[mask]

        positions = np.stack([xs, ys, zs], axis=-1)  # (N, 3) float32

        meta = {
            "width": int(W) if arr.ndim >= 2 else 0,
            "height": int(H) if arr.ndim >= 2 else 0,
            "channels": int(ch),
            "bitDepth": int(bits),
            "sampleFormat": sample_format,
            "pointCount": int(positions.shape[0]),
        }
        return positions, meta


def read_png(data: bytes) -> tuple[np.ndarray, dict]:
    """Read PNG as 3-channel image → point cloud (R=X, G=Y, B=Z)."""
    from PIL import Image
    img = Image.open(io.BytesIO(data)).convert("RGB")
    arr = np.array(img, dtype=np.float32)  # (H, W, 3)
    H, W, _ = arr.shape
    arr_norm = arr / 255.0
    xs = arr_norm[:, :, 0].ravel() * W
    ys = arr_norm[:, :, 1].ravel() * H
    zs = arr_norm[:, :, 2].ravel() * W
    mask = ~((xs == 0) & (ys == 0) & (zs == 0))
    positions = np.stack([xs[mask], ys[mask], zs[mask]], axis=-1)
    meta = {"width": W, "height": H, "channels": 3, "bitDepth": 8, "pointCount": int(positions.shape[0])}
    return positions, meta


def encode_response(positions: np.ndarray, meta: dict) -> bytes:
    """
    Binary response format:
      Header (7 x int32 = 28 bytes):
        [0] magic = 0x504C4300
        [1] point_count
        [2] width
        [3] height
        [4] channels
        [5] bit_depth
        [6] reserved = 0
      Body: float32 array of interleaved X, Y, Z (N*3 floats)
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
    body = positions.astype(np.float32).tobytes()
    return header + body


@app.get("/pc-api/healthz")
def healthz():
    return {"status": "ok"}


@app.post("/pc-api/upload")
async def upload_file(file: UploadFile = File(...)):
    data = await file.read()
    filename = (file.filename or "").lower()

    try:
        if filename.endswith(".tif") or filename.endswith(".tiff"):
            positions, meta = read_tif(data)
        elif filename.endswith(".png"):
            positions, meta = read_png(data)
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported format: {filename}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to parse file: {str(e)}")

    if positions.shape[0] == 0:
        raise HTTPException(status_code=422, detail="No valid points found in file")

    payload = encode_response(positions, meta)
    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={"X-Point-Count": str(positions.shape[0])},
    )


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 7891))
    uvicorn.run(app, host="0.0.0.0", port=port)
