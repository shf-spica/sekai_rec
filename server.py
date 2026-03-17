import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import FastAPI, Depends, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
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

try:
    import bcrypt
    from jose import jwt
except ImportError:
    bcrypt = None
    jwt = None

app = FastAPI()

# Auth
JWT_SECRET = os.environ.get("JWT_SECRET", "change-me-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = 24 * 7  # 7 days
security = HTTPBearer(auto_error=False)


def _hash_password(password: str) -> str:
    """bcrypt は 72 バイトまで。バイト列で切り詰めてからハッシュする。"""
    p = (password or "").encode("utf-8")[:72]
    return bcrypt.hashpw(p, bcrypt.gensalt()).decode("utf-8")


def _verify_password(password: str, password_hash: str) -> bool:
    p = (password or "").encode("utf-8")[:72]
    return bcrypt.checkpw(p, password_hash.encode("utf-8"))

# SQLite
_db_path = Path(__file__).resolve().parent / "prsk_ocr.db"


@contextmanager
def get_db():
    conn = sqlite3.connect(_db_path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                song_id INTEGER NOT NULL,
                difficulty TEXT NOT NULL,
                perfect INTEGER NOT NULL,
                great INTEGER NOT NULL,
                good INTEGER NOT NULL,
                bad INTEGER NOT NULL,
                miss INTEGER NOT NULL,
                point INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(user_id, song_id, difficulty),
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        """)


init_db()


def _require_auth():
    if bcrypt is None or jwt is None:
        raise HTTPException(status_code=503, detail="Auth not configured (install bcrypt and python-jose)")
    return True


class RegisterBody(BaseModel):
    username: str
    password: str


class LoginBody(BaseModel):
    username: str
    password: str


class RecordBody(BaseModel):
    song_id: int
    difficulty: str
    perfect: int
    great: int
    good: int
    bad: int
    miss: int
    point: int


class DatasetBody(BaseModel):
    source: str  # "ocr" | "manual"
    image_base64: str | None = None
    raw_text: str | None = None
    song_id: int
    song_title: str
    difficulty: str
    perfect: int
    great: int
    good: int
    bad: int
    miss: int
    point: int


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    _require_auth()
    if not credentials:
        return None
    try:
        payload = jwt.decode(credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id = payload.get("sub")
        if not user_id:
            return None
        with get_db() as conn:
            row = conn.execute(
                "SELECT id, username FROM users WHERE id = ?", (int(user_id),)
            ).fetchone()
        if row:
            return {"id": row["id"], "username": row["username"]}
    except Exception:
        pass
    return None


@app.post("/api/auth/register")
async def api_register(body: RegisterBody):
    _require_auth()
    username = (body.username or "").strip()
    password = body.password or ""
    if len(username) < 2:
        raise HTTPException(status_code=400, detail="Username too short")
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    password_hash = _hash_password(password)
    created = datetime.utcnow().isoformat() + "Z"
    try:
        with get_db() as conn:
            conn.execute(
                "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
                (username, password_hash, created),
            )
            user_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        token = jwt.encode(
            {"sub": str(user_id), "exp": datetime.utcnow() + timedelta(hours=JWT_EXPIRE_HOURS)},
            JWT_SECRET,
            algorithm=JWT_ALGORITHM,
        )
        return {"access_token": token, "user": {"id": user_id, "username": username}}
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="Username already taken")


@app.post("/api/auth/login")
async def api_login(body: LoginBody):
    _require_auth()
    username = (body.username or "").strip()
    password = body.password or ""
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, username, password_hash FROM users WHERE username = ?", (username,)
        ).fetchone()
    if not row or not _verify_password(password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    token = jwt.encode(
        {"sub": str(row["id"]), "exp": datetime.utcnow() + timedelta(hours=JWT_EXPIRE_HOURS)},
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )
    return {"access_token": token, "user": {"id": row["id"], "username": row["username"]}}


@app.get("/api/auth/me")
async def api_me(user=Depends(get_current_user)):
    if user is None:
        return {"user": None}
    return {"user": user}


@app.post("/api/records")
async def api_save_record(body: RecordBody, user=Depends(get_current_user)):
    if user is None:
        raise HTTPException(status_code=401, detail="Login required")
    _require_auth()
    user_id = user["id"]
    difficulty = (body.difficulty or "").strip().lower() or "master"
    created = datetime.utcnow().isoformat() + "Z"
    with get_db() as conn:
        existing = conn.execute(
            "SELECT id, point FROM records WHERE user_id = ? AND song_id = ? AND difficulty = ?",
            (user_id, body.song_id, difficulty),
        ).fetchone()
        if existing and existing["point"] >= body.point:
            return {"saved": False, "message": "Existing record has higher or equal point"}
        if existing:
            conn.execute(
                """UPDATE records SET perfect=?, great=?, good=?, bad=?, miss=?, point=?, created_at=?
                   WHERE id = ?""",
                (body.perfect, body.great, body.good, body.bad, body.miss, body.point, created, existing["id"]),
            )
        else:
            conn.execute(
                """INSERT INTO records (user_id, song_id, difficulty, perfect, great, good, bad, miss, point, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (user_id, body.song_id, difficulty, body.perfect, body.great, body.good, body.bad, body.miss, body.point, created),
            )
    return {"saved": True}


@app.get("/api/records")
async def api_list_records(user=Depends(get_current_user)):
    if user is None:
        raise HTTPException(status_code=401, detail="Login required")
    with get_db() as conn:
        rows = conn.execute(
            "SELECT song_id, difficulty, perfect, great, good, bad, miss, point, created_at FROM records WHERE user_id = ? ORDER BY created_at DESC",
            (user["id"],),
        ).fetchall()
    return {"records": [dict(r) for r in rows]}


# ML用データセット: 入力画像 + 生OCR + 補正後データを保存
_ml_dataset_dir = Path(__file__).resolve().parent / "ml_dataset"
_ml_dataset_images_dir = _ml_dataset_dir / "images"


@app.post("/api/dataset")
async def api_save_dataset(body: DatasetBody):
    """機械学習用に 入力画像・生データ・補正後データ を1件追加"""
    _ml_dataset_dir.mkdir(exist_ok=True)
    _ml_dataset_images_dir.mkdir(exist_ok=True)

    image_path_rel: str | None = None
    if body.image_base64:
        try:
            import base64
            import uuid
            raw = body.image_base64
            if "," in raw:
                raw = raw.split(",", 1)[1]
            data = base64.b64decode(raw)
            ext = "webp" if data[:4] == b"RIFF" else "jpg"
            name = f"{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}.{ext}"
            path = _ml_dataset_images_dir / name
            path.write_bytes(data)
            image_path_rel = f"images/{name}"
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid image_base64: {e}")

    entry = {
        "created_at": datetime.utcnow().isoformat() + "Z",
        "source": body.source,
        "image": image_path_rel,
        "raw_text": body.raw_text or "",
        "song_id": body.song_id,
        "song_title": body.song_title,
        "difficulty": (body.difficulty or "").strip().lower(),
        "perfect": body.perfect,
        "great": body.great,
        "good": body.good,
        "bad": body.bad,
        "miss": body.miss,
        "point": body.point,
    }
    jsonl_path = _ml_dataset_dir / "data.jsonl"
    with open(jsonl_path, "a", encoding="utf-8") as f:
        f.write(__import__("json").dumps(entry, ensure_ascii=False) + "\n")
    return {"saved": True, "path": image_path_rel}


JACKET_BASE_URL = "https://storage.sekai.best/sekai-jp-assets/music/jacket/jacket_s_{id}/jacket_s_{id}.webp"
_jacket_cache_dir = Path(__file__).resolve().parent / "jacket_cache"


def _jacket_cache_path(sid: str, gray: bool = False) -> Path:
    _jacket_cache_dir.mkdir(exist_ok=True)
    return _jacket_cache_dir / f"{sid}_gray.webp" if gray else _jacket_cache_dir / f"{sid}.webp"


def _ensure_color_jacket(sid: str) -> Path:
    """カラー画像を取得してキャッシュし、パスを返す"""
    path = _jacket_cache_path(sid, gray=False)
    if path.exists():
        return path
    url = JACKET_BASE_URL.format(id=sid)
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "prsk-ocr/1.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        path.write_bytes(resp.read())
    return path


def _jacket_to_grayscale_bytes(color_path: Path) -> bytes:
    """カラー画像をモノクロ化して WebP バイト列で返す"""
    img = Image.open(color_path).convert("RGB")
    gray = img.convert("L")
    buf = io.BytesIO()
    gray.save(buf, format="WEBP", quality=85)
    return buf.getvalue()


@app.get("/api/jacket/{song_id}")
async def api_jacket(song_id: str, gray: int = 0):
    """ジャケット画像をプロキシして返す（サーバー側でキャッシュ）。gray=1 でモノクロ（記録なし用）"""
    try:
        sid = str(int(song_id)).zfill(3)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid song_id")

    use_gray = gray == 1
    cache_path = _jacket_cache_path(sid, gray=use_gray)

    if cache_path.exists():
        return Response(content=cache_path.read_bytes(), media_type="image/webp")

    if use_gray:
        color_path = _ensure_color_jacket(sid)
        data = _jacket_to_grayscale_bytes(color_path)
        cache_path.write_bytes(data)
        return Response(content=data, media_type="image/webp")

    try:
        color_path = _ensure_color_jacket(sid)
        return Response(content=color_path.read_bytes(), media_type="image/webp")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch jacket: {e}")


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

