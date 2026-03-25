#!/usr/bin/env python3
"""
モバイル取り込み（POST /api/ingest/ocr-text）専用の長期トークンを1つ発行する。

通常はマイページ（/records/{username}）にログインした状態で
「新しいトークンを発行」からブラウザで発行する運用で足りる。

CLI が必要なとき:
  INGEST_USERNAME=あなたのログインユーザー名 python create_ingest_token.py

GET /api/external/records 用の api_keys とは別テーブル（ingest_tokens）。

発行したトークンは ingest_token.txt にも書き出す（.gitignore 済み）。
"""
import os
import sqlite3
import secrets
import sys
from datetime import datetime
from pathlib import Path

_db_path = Path(__file__).resolve().parent / "prsk_ocr.db"
_out_path = Path(__file__).resolve().parent / "ingest_token.txt"


def main() -> None:
    username = (os.environ.get("INGEST_USERNAME") or "").strip()
    if not username:
        print("INGEST_USERNAME に users テーブルと同じユーザー名を指定してください。", file=sys.stderr)
        sys.exit(1)

    token = secrets.token_urlsafe(48)
    created = datetime.utcnow().isoformat() + "Z"

    with sqlite3.connect(_db_path) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ingest_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token TEXT UNIQUE NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        """)
        row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            print(f"ユーザーが見つかりません: {username}", file=sys.stderr)
            sys.exit(1)
        user_id = int(row[0])
        conn.execute("DELETE FROM ingest_tokens WHERE user_id = ?", (user_id,))
        conn.execute(
            "INSERT INTO ingest_tokens (user_id, token, created_at) VALUES (?, ?, ?)",
            (user_id, token, created),
        )

    _out_path.write_text(token + "\n", encoding="utf-8")
    print(f"Ingest token written to {_out_path}")
    print(f"Token: {token}")


if __name__ == "__main__":
    main()
