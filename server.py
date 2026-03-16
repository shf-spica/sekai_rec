import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import FastAPI, Depends, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
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
    from passlib.context import CryptContext
    from jose import jwt
except ImportError:
    CryptContext = None
    jwt = None

app = FastAPI()

# Auth
JWT_SECRET = os.environ.get("JWT_SECRET", "change-me-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = 24 * 7  # 7 days
pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto") if CryptContext else None
security = HTTPBearer(auto_error=False)

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
    if pwd_ctx is None or jwt is None:
        raise HTTPException(status_code=503, detail="Auth not configured (install passlib and python-jose)")
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
    password_hash = pwd_ctx.hash(password)
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
    if not row or not pwd_ctx.verify(password, row["password_hash"]):
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

