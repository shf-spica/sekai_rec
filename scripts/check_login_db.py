#!/usr/bin/env python3
"""prsk_ocr.db と bcrypt でログイン相当の検証のみ行う（1行貼り付け不要）。"""
from __future__ import annotations

import getpass
import sqlite3
import sys
from pathlib import Path

try:
    import bcrypt
except ImportError:
    print("bcrypt が入っていません: pip install bcrypt", file=sys.stderr)
    sys.exit(2)


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    db_path = root / "prsk_ocr.db"
    if not db_path.is_file():
        print(f"DB が見つかりません: {db_path}", file=sys.stderr)
        sys.exit(2)

    username = (sys.argv[1] if len(sys.argv) > 1 else input("username: ")).strip()
    password = getpass.getpass("password: ")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT id, username, password_hash FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    conn.close()

    if not row:
        print("DB: その username の行はありません（大文字小文字・別DBを確認）")
        sys.exit(1)

    ph = row["password_hash"]
    if isinstance(ph, str):
        ph = ph.encode("utf-8")
    p = (password or "").encode("utf-8")[:72]
    ok = bcrypt.checkpw(p, ph)
    print(f"DB: ユーザー id={row['id']} username={row['username']!r}")
    print(f"bcrypt.checkpw: {ok}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
