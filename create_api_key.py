#!/usr/bin/env python3
"""
APIキーを1つ生成し、DBに登録して api_key.txt に書き出す。
使い方: python create_api_key.py
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
                created_at TEXT NOT NULL
            )
        """)
        conn.execute(
            "INSERT INTO api_keys (username, api_key, created_at) VALUES (?, ?, ?)",
            (username, api_key, created),
        )

    _out_path.write_text(api_key.strip() + "\n", encoding="utf-8")
    print(f"API key written to {_out_path}")
    print(f"Key: {api_key}")


if __name__ == "__main__":
    main()
