import os

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from paddleocr import PaddleOCR
import numpy as np
import cv2
import io
from PIL import Image
import time

try:
    import python_multipart  # noqa: F401
except ImportError:
    raise RuntimeError(
        'Form data requires "python-multipart". Install with: pip install python-multipart'
    ) from None

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ocr = PaddleOCR(use_angle_cls=True, lang="japan", use_gpu=True)


def _load_image_bgr(data: bytes) -> np.ndarray:
    img = Image.open(io.BytesIO(data)).convert("RGB")
    arr = np.array(img)
    return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)


def _apply_black_mask(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    masked = img.copy()
    masked[h // 4 : h // 2, 0:w] = 0
    masked[h // 2 : h, w // 3 : w] = 0
    masked[0:h // 4, w // 2 : w] = 0
    return masked


def _paddle_to_textblocks(result) -> dict:
    if isinstance(result, list) and result and isinstance(result[0], list):
        lines = result[0]
    else:
        lines = result

    text_blocks = []
    full_lines = []
    order = 1

    for item in lines:
        box, (text, score) = item
        if not text or not text.strip():
            continue

        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        x_min, x_max = min(xs), max(xs)
        y_min, y_max = min(ys), max(ys)

        text_blocks.append(
            {
                "text": text,
                "x": float(x_min),
                "y": float(y_min),
                "width": float(x_max - x_min),
                "height": float(y_max - y_min),
                "confidence": float(score),
                "readingOrder": order,
            }
        )
        full_lines.append(text)
        order += 1

    return {
        "textBlocks": text_blocks,
        "fullText": "\n".join(full_lines),
    }


@app.post("/ocr")
async def ocr_image(file: UploadFile = File(...)):
    start = time.time()
    data = await file.read()
    img = _load_image_bgr(data)
    masked = _apply_black_mask(img)
    result = ocr.ocr(masked, cls=True)
    converted = _paddle_to_textblocks(result)
    elapsed_ms = int((time.time() - start) * 1000)
    return JSONResponse(
        {
            "textBlocks": converted["textBlocks"],
            "fullText": converted["fullText"],
            "processingTime": elapsed_ms,
        }
    )


# フロント一式を配信（/ocr は上で定義済みのため優先される）
_static_dir = os.path.dirname(os.path.abspath(__file__))
app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")

