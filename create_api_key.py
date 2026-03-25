#!/usr/bin/env python3
"""
GET /api/external/records（任意ユーザーの記録一覧・読み取り専用）用の API キーを1つ生成し、
DB の api_keys に登録して api_key.txt に書き出す。

モバイルからの記録の取り込み（POST /api/ingest/ocr-text）には使わない。
取り込み用は create_ingest_token.py を使う。

使い方: API_KEY_USERNAME=表示用ラベル python create_api_key.py
（username カラムはキーのメモ用。外部 API ではクエリの username と一致させる必要はない）
"""
import os
import sqlite3
import secrets
from datetime import datetime
from pathlib import Path

_db_path = Path(__file__).resolve().parent / "prsk_ocr.db"
_out_path = Path(__file__).resolve().parent / "api_key.txt"


def main():
    api_key = secrets.token_urlsafe(32)
    username = os.environ.get("API_KEY_USERNAME", "default")
    created = datetime.utcnow().isoformat() + "Z"

    with sqlite3.connect(_db_path) as conn:
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
        conn.execute(
            "INSERT INTO api_keys (username, api_key, created_at) VALUES (?, ?, ?)",
            (username, api_key, created),
        )

    _out_path.write_text(api_key.strip() + "\n", encoding="utf-8")
    print(f"API key written to {_out_path}")
    print(f"Key: {api_key}")


if __name__ == "__main__":
    main()
