import asyncio
import base64
import json
import logging
import os
import secrets
import shutil
import sqlite3
import subprocess
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta, timezone
from functools import partial
from pathlib import Path

def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None or not str(v).strip():
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _configure_logging() -> None:
    """コンソールは常に。ファイルは書けない環境（Windows サービス等）ではスキップして起動を続行。

    force=True は使わない（uvicorn 等が先に付けたルートロガーを消してログや起動順に影響するため）。
    """
    log_path = Path(__file__).resolve().parent / "prsk_ocr.log"
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    try:
        handlers.append(logging.FileHandler(log_path, encoding="utf-8"))
    except OSError as e:
        print(f"[prsk_ocr] WARNING: log file not writable ({log_path}): {e}", flush=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=handlers,
    )


_configure_logging()
logger = logging.getLogger("prsk_ocr")

from fastapi import FastAPI, Depends, File, Header, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import AliasChoices, BaseModel, Field
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


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """Windows サービスで手動再起動するとき、停止直後にポートが残る原因になりやすい OCR 用スレッドを片付ける。"""
    yield
    ex = globals().get("_ocr_executor")
    if ex is not None:
        logger.info("Shutting down OCR thread pool")
        try:
            try:
                ex.shutdown(wait=False, cancel_futures=True)
            except TypeError:
                ex.shutdown(wait=False)
        except Exception as e:
            logger.warning("OCR executor shutdown: %s", e)


app = FastAPI(lifespan=_lifespan)

# マイページ用 SSE: 同一プロセス内のみ有効（複数ワーカーでは各ワーカー別々に購読）
_mypage_sse_subscribers: dict[str, list[asyncio.Queue]] = {}


async def notify_mypage_records_updated(username: str) -> None:
    """記録が変わったユーザーのマイページ購読者へ通知（username は DB のユーザー名と一致すること）。"""
    if not username:
        return
    for q in list(_mypage_sse_subscribers.get(username, [])):
        try:
            q.put_nowait(1)
        except Exception:
            pass


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
        # 既存DBに taken_at カラムがない場合は追加する
        try:
            conn.execute("ALTER TABLE records ADD COLUMN taken_at TEXT")
        except sqlite3.OperationalError:
            pass
        conn.execute("""
            CREATE TABLE IF NOT EXISTS api_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                api_key TEXT UNIQUE NOT NULL,
                created_at TEXT NOT NULL,
                user_id INTEGER
            )
        """)
        try:
            conn.execute("ALTER TABLE api_keys ADD COLUMN user_id INTEGER")
        except sqlite3.OperationalError:
            pass
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ingest_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token TEXT UNIQUE NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        """)
        try:
            conn.execute("ALTER TABLE ingest_tokens ADD COLUMN token_hint TEXT")
        except sqlite3.OperationalError:
            pass


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
    taken_at: str | None = None


class DatasetBody(BaseModel):
    source: str  # "ocr" | "manual"
    image_base64: str | None = None
    raw_text: str | None = None
    browser_raw_text: str | None = None
    paddle_raw_text: str | None = None
    normalized_text: str | None = None
    song_id: int
    song_title: str
    difficulty: str
    perfect: int
    great: int
    good: int
    bad: int
    miss: int
    point: int


class IngestOcrTextBody(BaseModel):
    """iOS 等から OCR 済みテキストを受け取り、既存の ocr-postprocess と同じ解析で記録する。"""

    full_text: str = Field(..., validation_alias=AliasChoices("full_text", "fullText"))
    taken_at: str | None = Field(None, validation_alias=AliasChoices("taken_at", "takenAt"))


_ROOT = Path(__file__).resolve().parent
_PARSE_OCR_CLI = _ROOT / "scripts" / "parse_ocr_cli.mjs"


def _bearer_token(authorization: str | None) -> str | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return authorization[7:].strip() or None


def get_ingest_token_string(
    authorization: str | None = Header(None),
    x_ingest_token: str | None = Header(None, alias="X-Ingest-Token"),
) -> str | None:
    """POST で Authorization がプロキシにより落ちる場合に X-Ingest-Token を使える。"""
    t = _bearer_token(authorization)
    if t:
        return t
    if x_ingest_token and str(x_ingest_token).strip():
        return str(x_ingest_token).strip()
    return None


def _ingest_ocr_json_error(
    status_code: int,
    error_code: str,
    *,
    message: str | None = None,
    parsed: dict | None = None,
    **extra,
) -> JSONResponse:
    """iOS ショートカット向け: error は常に文字列（成功相当は別ルートで \"false\"）。失敗時はエラーコードを error に入れる。"""
    body: dict = {"error": error_code, "http_status": status_code}
    if message is not None:
        body["message"] = message
    if parsed is not None:
        body["parsed"] = parsed
    body.update(extra)
    return JSONResponse(status_code=status_code, content=body)


def _ingest_ocr_from_subprocess_http_exception(exc: HTTPException) -> JSONResponse:
    code = exc.status_code
    d = exc.detail
    if isinstance(d, dict):
        merged = {k: v for k, v in d.items() if k not in ("ok", "error", "error_code", "http_status")}
        if isinstance(d.get("error_code"), str):
            err_str = d["error_code"]
        elif isinstance(d.get("error"), str) and d["error"] != "false":
            err_str = d["error"]
        else:
            err_str = (
                "postprocess_failed"
                if code == 500
                else "node_unavailable"
                if code == 503
                else "postprocess_timeout"
                if code == 504
                else "postprocess_error"
            )
        return JSONResponse(
            status_code=code,
            content={"error": err_str, "http_status": code, **merged},
        )
    err = (
        "postprocess_failed"
        if code == 500
        else "node_unavailable"
        if code == 503
        else "postprocess_timeout"
        if code == 504
        else "postprocess_error"
    )
    return _ingest_ocr_json_error(code, err, message=str(d))


def _resolve_user_id_for_ingest_token(token: str) -> int | None:
    """記録取得用 api_keys とは別テーブル ingest_tokens のみを参照する。"""
    with get_db() as conn:
        row = conn.execute(
            "SELECT user_id FROM ingest_tokens WHERE token = ?",
            (token,),
        ).fetchone()
    if not row:
        return None
    return int(row["user_id"])


_JST = timezone(timedelta(hours=9))


def _normalize_taken_at(raw: str | None) -> str | None:
    """
    iOS ショートカット等からの日時を正規化して DB に保存する文字列にする。
    受け付ける例:
      - yyyy/mm/dd hh:mm（ユーザー指定の主形式）
      - yyyy/mm/dd hh:mm:ss
      - yyyy-mm-dd hh:mm(:ss)
      - ISO 8601（既にタイムゾーン付きならそのまま解釈）
    スラッシュ形式でタイムゾーンが無い場合は日本標準時 (JST) として解釈する。
    """
    if raw is None or not str(raw).strip():
        return None
    s = str(raw).strip().replace("／", "/").replace("－", "-")

    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_JST)
        return dt.isoformat()
    except ValueError:
        pass

    for fmt in ("%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            dt = datetime.strptime(s, fmt)
            return dt.replace(tzinfo=_JST).isoformat()
        except ValueError:
            continue

    raise HTTPException(
        status_code=400,
        detail='taken_at: use "yyyy/mm/dd hh:mm" or ISO 8601 (e.g. 2025-03-23T15:30:00+09:00)',
    )


def _upsert_user_record(conn: sqlite3.Connection, user_id: int, body: RecordBody) -> dict:
    difficulty = (body.difficulty or "").strip().lower() or "master"
    created = datetime.utcnow().isoformat() + "Z"
    existing = conn.execute(
        "SELECT id, perfect, great, good, bad, miss, point FROM records WHERE user_id = ? AND song_id = ? AND difficulty = ?",
        (user_id, body.song_id, difficulty),
    ).fetchone()
    if existing:
        existing_fc = existing["miss"] == 0 and existing["bad"] == 0 and existing["good"] == 0
        new_fc = body.miss == 0 and body.bad == 0 and body.good == 0
        if existing_fc and not new_fc:
            return {"saved": False, "message": "Existing record (FULL COMBO) is preferred over non-FC"}
        if (existing_fc == new_fc) and existing["point"] >= body.point:
            return {"saved": False, "message": "Existing record has higher or equal point"}
        conn.execute(
            """UPDATE records SET perfect=?, great=?, good=?, bad=?, miss=?, point=?, taken_at=?, created_at=?
               WHERE id = ?""",
            (
                body.perfect,
                body.great,
                body.good,
                body.bad,
                body.miss,
                body.point,
                body.taken_at,
                created,
                existing["id"],
            ),
        )
    else:
        conn.execute(
            """INSERT INTO records (user_id, song_id, difficulty, perfect, great, good, bad, miss, point, taken_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                user_id,
                body.song_id,
                difficulty,
                body.perfect,
                body.great,
                body.good,
                body.bad,
                body.miss,
                body.point,
                body.taken_at,
                created,
            ),
        )
    return {"saved": True}


_NODE_BIN = (os.environ.get("NODE_BIN", "node") or "node").strip()


def _resolved_node_executable() -> str:
    cmd = _NODE_BIN
    if os.path.isfile(cmd):
        return cmd
    w = shutil.which(cmd)
    if w:
        return w
    raise HTTPException(
        status_code=503,
        detail="Node.js が見つかりません。サーバーに Node を入れるか、環境変数 NODE_BIN にフルパスを設定してください。",
    )


def _run_parse_ocr_postprocess(full_text: str) -> dict:
    node_cmd = _resolved_node_executable()
    if not _PARSE_OCR_CLI.is_file():
        raise HTTPException(status_code=500, detail="parse_ocr_cli.mjs not found")
    try:
        payload = json.dumps({"fullText": full_text}, ensure_ascii=False)
        proc = subprocess.run(
            [node_cmd, str(_PARSE_OCR_CLI)],
            input=payload,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=120,
            cwd=str(_ROOT),
            env={**os.environ, "NODE_NO_WARNINGS": "1"},
        )
    except subprocess.TimeoutExpired:
        logger.error("parse_ocr_cli timed out after 120s")
        raise HTTPException(
            status_code=504,
            detail="OCR text postprocess timed out (text too long or server overload)",
        ) from None
    except FileNotFoundError as e:
        logger.error("node executable not found: %s", e)
        raise HTTPException(status_code=503, detail=f"Node.js not executable: {node_cmd}") from e
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        logger.error("parse_ocr_cli failed rc=%s: %s", proc.returncode, err[:2000])
        hint = err[:400].replace("\n", " ") if err else "no stderr"
        raise HTTPException(
            status_code=500,
            detail=f"OCR postprocess failed: {hint}",
        )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        logger.error("parse_ocr_cli bad JSON: %s", proc.stdout[:500])
        raise HTTPException(status_code=500, detail="Invalid postprocess output") from e


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
    with get_db() as conn:
        out = _upsert_user_record(conn, user["id"], body)
    if out.get("saved"):
        await notify_mypage_records_updated(user["username"])
    return out


@app.get("/api/ingest/ping")
async def api_ingest_ping_get():
    """TLS・DNS・プロキシの到達テスト（認証なし・即応答）。ショートカットで GET できるか試す用。"""
    return {"error": "false", "http_status": 200}


@app.post("/api/ingest/ping")
async def api_ingest_ping_post(ingest_token: str | None = Depends(get_ingest_token_string)):
    """ingest トークン付き POST が届くかだけ試す（Node や JSON 本文パースは使わない）。"""
    if not ingest_token:
        raise HTTPException(
            status_code=401,
            detail="Authorization: Bearer <ingest_token> またはヘッダー X-Ingest-Token: <ingest_token>",
        )
    if _resolve_user_id_for_ingest_token(ingest_token) is None:
        raise HTTPException(status_code=401, detail="Invalid ingest token")
    return {"error": "false", "http_status": 200}


@app.get("/api/ingest/ocr-text")
async def api_ingest_ocr_text_probe():
    """到達確認用（認証なし）。GET で JSON が返ればリバースプロキシまで届いている。"""
    return {
        "endpoint": "/api/ingest/ocr-text",
        "post_required": True,
        "ping_get": "/api/ingest/ping",
        "ping_post": "/api/ingest/ping",
        "headers": {
            "Authorization": "Bearer <ingest_token>（POST だけ失敗する場合は X-Ingest-Token に同じ値を入れて試す）",
            "X-Ingest-Token": "ingest_token のみ（Authorization の代替。プロキシが Bearer を落とすとき用）",
            "Content-Type": "application/json",
        },
        "body": {
            "fullText": "マスク後OCRの全文（改行含む）",
            "takenAt": "任意 yyyy/mm/dd hh:mm など",
        },
        "response_status_codes": {
            "200": "成功",
            "400": "full_text 空 / taken_at 不正",
            "401": "トークン欠如・無効",
            "404": "曲特定失敗 song_not_identified、または missing_song_id",
            "422": "judgments_invalid / incomplete_judgments / invalid_point / bad_song_id",
            "500": "postprocess 失敗・内部エラー",
            "503": "Node なし",
            "504": "postprocess タイムアウト",
        },
        "response_body_shortcuts": "JSON 先頭レベルに常に error（文字列）と http_status（int）。成功時 error は \"false\"、失敗時はエラーコード文字列。ショートカットはここで分岐可能。",
    }


@app.post("/api/ingest/ocr-text")
async def api_ingest_ocr_text(
    body: IngestOcrTextBody,
    ingest_token: str | None = Depends(get_ingest_token_string),
):
    """
    モバイル取り込み専用トークン（ingest_tokens テーブル）で認証。
    Authorization: Bearer <ingest_token> または X-Ingest-Token: <ingest_token>

    taken_at（任意）: 主に "yyyy/mm/dd hh:mm"（iOS からその形式で来る想定）。ISO 8601 も可。

    レスポンス JSON は先頭レベルに常に error（文字列）・http_status（int）を含む（ショートカットでステータス行が使えない場合用）。
    成功時 error は \"false\"。失敗時 error にエラーコード（例: song_not_identified）。

    返りうる HTTP ステータス（http_status と一致）:
      200 成功（error: \"false\"）
      400 full_text が空、taken_at が解釈不能（error: empty_full_text / bad_taken_at）
      401 トークン（error: missing_token / invalid_token）
      404 曲特定（error: song_not_identified / missing_song_id）
      422 判定など（error: judgments_invalid / incomplete_judgments / invalid_point / bad_song_id）
      500 内部・後処理（error: internal / postprocess_failed 等）
      503 / 504 Node 関連

    リクエスト JSON の形エラーは FastAPI 標準の 422 になり、error フィールドは付かないことがある。
    """
    try:
        if not ingest_token:
            return _ingest_ocr_json_error(
                401,
                "missing_token",
                message="Authorization: Bearer <ingest_token> または X-Ingest-Token: <ingest_token>",
            )
        user_id = _resolve_user_id_for_ingest_token(ingest_token)
        if user_id is None:
            return _ingest_ocr_json_error(401, "invalid_token", message="Invalid ingest token")

        full_text = (body.full_text or "").strip()
        if not full_text:
            return _ingest_ocr_json_error(400, "empty_full_text", message="full_text is empty")

        taken_raw = (body.taken_at or "").strip() or None
        if taken_raw:
            try:
                taken_at = _normalize_taken_at(taken_raw)
            except HTTPException as e:
                return _ingest_ocr_json_error(
                    400,
                    "bad_taken_at",
                    message=str(e.detail),
                )
        else:
            taken_at = None

        try:
            parsed = _run_parse_ocr_postprocess(full_text)
        except HTTPException as e:
            return _ingest_ocr_from_subprocess_http_exception(e)

        if parsed.get("songError"):
            return JSONResponse(
                status_code=404,
                content={
                    "error": "song_not_identified",
                    "http_status": 404,
                    "parsed": parsed,
                },
            )
        if parsed.get("judgmentsSumError"):
            return JSONResponse(
                status_code=422,
                content={
                    "error": "judgments_invalid",
                    "http_status": 422,
                    "parsed": parsed,
                },
            )

        song_id = parsed.get("songId")
        if song_id is None:
            return JSONResponse(
                status_code=404,
                content={
                    "error": "missing_song_id",
                    "http_status": 404,
                    "parsed": parsed,
                },
            )

        try:
            sid = int(song_id)
        except (TypeError, ValueError):
            return JSONResponse(
                status_code=422,
                content={
                    "error": "bad_song_id",
                    "http_status": 422,
                    "songId": song_id,
                    "parsed": parsed,
                },
            )

        j = parsed.get("judgments") or {}
        for k in ("PERFECT", "GREAT", "GOOD", "BAD", "MISS"):
            if not isinstance(j.get(k), int):
                return JSONResponse(
                    status_code=422,
                    content={
                        "error": "incomplete_judgments",
                        "http_status": 422,
                        "parsed": parsed,
                    },
                )

        difficulty = parsed.get("difficulty") or "master"
        if not isinstance(parsed.get("point"), int):
            return JSONResponse(
                status_code=422,
                content={
                    "error": "invalid_point",
                    "http_status": 422,
                    "parsed": parsed,
                },
            )

        rec = RecordBody(
            song_id=sid,
            difficulty=str(difficulty),
            perfect=int(j["PERFECT"]),
            great=int(j["GREAT"]),
            good=int(j["GOOD"]),
            bad=int(j["BAD"]),
            miss=int(j["MISS"]),
            point=int(parsed["point"]),
            taken_at=taken_at,
        )

        with get_db() as conn:
            out = _upsert_user_record(conn, user_id, rec)
            urow = conn.execute("SELECT username FROM users WHERE id = ?", (user_id,)).fetchone()
        if out.get("saved") and urow:
            await notify_mypage_records_updated(urow["username"])
        return JSONResponse(
            status_code=200,
            content={"error": "false", "http_status": 200, **out, "parsed": parsed},
        )
    except Exception as e:
        logger.exception("api_ingest_ocr_text failed")
        return _ingest_ocr_json_error(
            500,
            "internal",
            message=f"{type(e).__name__}: {e}"[:800],
        )


@app.get("/api/ingest-tokens")
async def api_list_ingest_tokens(user=Depends(get_current_user)):
    """発行済み一覧。秘密の代わりに末尾数文字 token_hint のみ返す。"""
    if user is None:
        raise HTTPException(status_code=401, detail="Login required")
    _require_auth()
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, created_at, token_hint FROM ingest_tokens WHERE user_id = ? ORDER BY id DESC",
            (user["id"],),
        ).fetchall()
    return {"tokens": [dict(r) for r in rows]}


@app.post("/api/ingest-tokens")
async def api_create_ingest_token(user=Depends(get_current_user)):
    """1ユーザー1トークン。秘密は X-Ingest-Secret ヘッダーと JSON の s（base64）の両方で返す（中間がヘッダーを落とす対策）。"""
    if user is None:
        raise HTTPException(status_code=401, detail="Login required")
    _require_auth()
    token = secrets.token_urlsafe(48)
    token_hint = token[-10:] if len(token) >= 10 else token
    created = datetime.utcnow().isoformat() + "Z"
    b64 = base64.b64encode(token.encode("ascii")).decode("ascii")
    with get_db() as conn:
        conn.execute("DELETE FROM ingest_tokens WHERE user_id = ?", (user["id"],))
        conn.execute(
            "INSERT INTO ingest_tokens (user_id, token, created_at, token_hint) VALUES (?, ?, ?, ?)",
            (user["id"], token, created, token_hint),
        )
        tid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    return JSONResponse(
        content={"id": tid, "created_at": created, "s": b64},
        headers={"X-Ingest-Secret": token},
    )


@app.delete("/api/ingest-tokens/{token_id}")
async def api_delete_ingest_token(token_id: int, user=Depends(get_current_user)):
    if user is None:
        raise HTTPException(status_code=401, detail="Login required")
    _require_auth()
    with get_db() as conn:
        cur = conn.execute(
            "DELETE FROM ingest_tokens WHERE id = ? AND user_id = ?",
            (token_id, user["id"]),
        )
        deleted = cur.rowcount > 0
    if not deleted:
        raise HTTPException(status_code=404, detail="Token not found")
    return {"deleted": True}


@app.get("/api/records")
async def api_list_records(user=Depends(get_current_user)):
    if user is None:
        raise HTTPException(status_code=401, detail="Login required")
    with get_db() as conn:
        rows = conn.execute(
            "SELECT song_id, difficulty, perfect, great, good, bad, miss, point, taken_at, created_at FROM records WHERE user_id = ? ORDER BY created_at DESC",
            (user["id"],),
        ).fetchall()
    return {"records": [dict(r) for r in rows]}

@app.get("/api/public/records")
async def api_public_records(username: str):
    """公開マイページ用: username のレコード一覧（認証不要）"""
    with get_db() as conn:
        user_row = conn.execute(
            "SELECT id, username FROM users WHERE username = ?", (username,)
        ).fetchone()
        if not user_row:
            raise HTTPException(status_code=404, detail="User not found")
        rows = conn.execute(
            "SELECT song_id, difficulty, perfect, great, good, bad, miss, point, taken_at, created_at "
            "FROM records WHERE user_id = ? ORDER BY created_at DESC",
            (user_row["id"],),
        ).fetchall()
    return {"user": {"id": user_row["id"], "username": user_row["username"]}, "records": [dict(r) for r in rows]}


@app.get("/api/public/records/stream")
async def api_public_records_stream(username: str):
    """
    マイページ用 Server-Sent Events。記録の作成・更新・削除時にイベントを送る。
    同一オリジンのみ想定。Nginx 利用時はプロキシのバッファリング無効化推奨。
    注: 複数 uvicorn ワーカーではプロセス間で通知が共有されない（Redis 等が必要）。
    """
    with get_db() as conn:
        user_row = conn.execute(
            "SELECT username FROM users WHERE username = ?", (username,)
        ).fetchone()
    if not user_row:
        raise HTTPException(status_code=404, detail="User not found")
    canonical = user_row["username"]

    async def event_gen():
        queue: asyncio.Queue = asyncio.Queue()
        subs = _mypage_sse_subscribers.setdefault(canonical, [])
        subs.append(queue)
        try:
            yield f"data: {json.dumps({'type': 'hello'})}\n\n"
            while True:
                try:
                    await asyncio.wait_for(queue.get(), timeout=25.0)
                    yield f"data: {json.dumps({'type': 'records_updated'})}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            try:
                subs.remove(queue)
            except ValueError:
                pass
            if not subs:
                _mypage_sse_subscribers.pop(canonical, None)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _require_admin(user):
    if user is None:
        raise HTTPException(status_code=401, detail="Login required")
    if (user.get("username") or "") != "shf_spica":
        raise HTTPException(status_code=403, detail="Forbidden")
    return True


@app.get("/api/admin/users")
async def api_admin_users(user=Depends(get_current_user)):
    """開発者用: ユーザー一覧（shf_spica のみ）"""
    _require_auth()
    _require_admin(user)
    with get_db() as conn:
        rows = conn.execute("SELECT id, username, created_at FROM users ORDER BY id ASC").fetchall()
    return {"users": [dict(r) for r in rows]}


@app.delete("/api/records")
async def api_delete_record(song_id: int, difficulty: str, user=Depends(get_current_user)):
    if user is None:
        raise HTTPException(status_code=401, detail="Login required")
    difficulty_norm = (difficulty or "").strip().lower()
    with get_db() as conn:
        cur = conn.execute(
            "DELETE FROM records WHERE user_id = ? AND song_id = ? AND difficulty = ?",
            (user["id"], song_id, difficulty_norm),
        )
        deleted = cur.rowcount > 0
    if deleted:
        await notify_mypage_records_updated(user["username"])
    return {"deleted": deleted}


# 外部ツール向け: 任意の username のレコード一覧を、APIキー所持者だけに公開
@app.get("/api/external/records")
async def api_external_records(username: str, api_key: str):
    with get_db() as conn:
        # api_key がホワイトリストに存在するかだけを確認（username とは紐付けない）
        key_row = conn.execute(
            "SELECT id, username FROM api_keys WHERE api_key = ?",
            (api_key,),
        ).fetchone()
        if not key_row:
            raise HTTPException(status_code=401, detail="Invalid api_key")

        user_row = conn.execute(
            "SELECT id, username FROM users WHERE username = ?", (username,)
        ).fetchone()
        if not user_row:
            raise HTTPException(status_code=404, detail="User not found")

        rows = conn.execute(
            "SELECT song_id, difficulty, perfect, great, good, bad, miss, point, taken_at, created_at "
            "FROM records WHERE user_id = ? ORDER BY created_at DESC",
            (user_row["id"],),
        ).fetchall()

    return {
        "user": {"id": user_row["id"], "username": user_row["username"]},
        "records": [dict(r) for r in rows],
    }


# ML用データセット: 入力画像 + 生OCR + 補正後データを保存
_ml_dataset_dir = Path(__file__).resolve().parent / "ml_dataset"
_ml_dataset_images_dir = _ml_dataset_dir / "images"


@app.post("/api/dataset")
async def api_save_dataset(body: DatasetBody):
    """機械学習用に 入力画像・生データ・補正後データ を1件追加"""
    _ml_dataset_dir.mkdir(exist_ok=True)
    _ml_dataset_images_dir.mkdir(exist_ok=True)

    image_path_rel: str | None = None
    image_datetime: str | None = None
    if body.image_base64:
        try:
            import base64
            import uuid
            raw = body.image_base64
            if "," in raw:
                raw = raw.split(",", 1)[1]
            data = base64.b64decode(raw)
            # メタデータ（撮影日時）があれば取得（なければ None）
            try:
                img = Image.open(io.BytesIO(data))
                exif = getattr(img, "_getexif", lambda: None)() or {}
                dt = exif.get(36867) or exif.get(306)  # DateTimeOriginal / DateTime
                if isinstance(dt, str):
                    # "YYYY:MM:DD HH:MM:SS" 形式を ISO ライクに
                    image_datetime = dt.replace(":", "-", 2)
            except Exception:
                image_datetime = None

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
        "image_datetime": image_datetime,
        "raw_text": body.raw_text or "",
        "browser_raw_text": body.browser_raw_text or "",
        "paddle_raw_text": body.paddle_raw_text or "",
        "normalized_text": body.normalized_text or "",
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


# APIキーは create_api_key.py で生成して api_key.txt に書いておく運用

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
    expose_headers=["X-Ingest-Secret"],
)

# GPU の ON/OFF は PRSK_OCR_USE_GPU（1/true/yes/on）。未設定は従来どおり True。
# 二重に PaddleOCR() しない（1回目が失敗しても内部状態が残り、2回目で不安定になることがあるため）。
ocr = PaddleOCR(
    use_angle_cls=True,
    lang="japan",
    use_gpu=_env_bool("PRSK_OCR_USE_GPU", True),
)
_ocr_executor = __import__("concurrent.futures", fromlist=["ThreadPoolExecutor"]).ThreadPoolExecutor(max_workers=1)
_ocr_semaphore = asyncio.Semaphore(1)
_OCR_QUEUE_MAX = 5
_ocr_waiting = 0


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
    global _ocr_waiting
    logger.info("OCR request received (queue: %d/%d)", _ocr_waiting, _OCR_QUEUE_MAX)
    if _ocr_waiting >= _OCR_QUEUE_MAX:
        logger.warning("OCR queue full, returning 503")
        raise HTTPException(status_code=503, detail="OCRキューが満杯です。しばらく待ってから再試行してください。")

    _ocr_waiting += 1
    try:
        data = await file.read()
        logger.info("OCR image read: %d bytes", len(data))
        image_datetime = None
        try:
            img0 = Image.open(io.BytesIO(data))
            exif = getattr(img0, "_getexif", lambda: None)() or {}
            dt = exif.get(36867) or exif.get(306)
            if isinstance(dt, str):
                image_datetime = dt.replace(":", "-", 2)
        except Exception:
            image_datetime = None

        img = _load_image_bgr(data)
        masked = _apply_black_mask(img)

        logger.info("OCR waiting for semaphore...")
        async with _ocr_semaphore:
            start = time.time()
            logger.info("OCR GPU processing started")
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(_ocr_executor, partial(ocr.ocr, masked, cls=True))
            elapsed_ms = int((time.time() - start) * 1000)
            logger.info("OCR GPU done in %dms", elapsed_ms)

        converted = _paddle_to_textblocks(result)
        return JSONResponse(
            {
                "textBlocks": converted["textBlocks"],
                "fullText": converted["fullText"],
                "processingTime": elapsed_ms,
                "imageDateTime": image_datetime,
            }
        )
    except Exception as e:
        logger.exception("OCR error: %s", e)
        raise
    finally:
        _ocr_waiting -= 1


# フロント一式を配信（/ocr は上で定義済みのため優先される）
_static_dir = os.path.dirname(os.path.abspath(__file__))


@app.get("/")
async def mypage_root():
    """トップをマイページとする（未ログイン時は records.html 内で案内）"""
    path = Path(_static_dir) / "records.html"
    if not path.exists():
        raise HTTPException(status_code=404, detail="records.html not found")
    return FileResponse(path)


@app.get("/records/{username}")
async def mypage(username: str):
    """公開マイページ: /records/{username} は records.html を返す"""
    path = Path(_static_dir) / "records.html"
    if not path.exists():
        raise HTTPException(status_code=404, detail="records.html not found")
    return FileResponse(path)


@app.get("/admin/users")
async def admin_users_page():
    """開発者用ページ（認証は JS が /api/admin/users で行う）"""
    path = Path(_static_dir) / "admin-users.html"
    if not path.exists():
        raise HTTPException(status_code=404, detail="admin-users.html not found")
    return FileResponse(path)


@app.get("/records/{username}/")
async def mypage_slash(username: str):
    return await mypage(username)

app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")

