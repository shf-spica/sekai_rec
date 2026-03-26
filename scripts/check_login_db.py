#!/usr/bin/env python3
"""prsk_ocr.db と bcrypt でログイン相当の検証のみ行う（1行貼り付け不要）。"""
from __future__ import annotations

import getpass
import sqlite3
import sys
import traceback
from pathlib import Path

try:
    import bcrypt
except ImportError:
    print("bcrypt が入っていません: pip install bcrypt", file=sys.stderr)
    sys.exit(2)


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    db_path = (root / "prsk_ocr.db").resolve()
    if not db_path.is_file():
        print(f"DB が見つかりません: {db_path}", file=sys.stderr)
        sys.exit(2)

    print(f"開いているファイル（絶対パス）:\n  {db_path}\n")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    # まず中身の骨格を必ず表示（一覧が出ない原因の切り分け用）
    try:
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
        names = [t[0] for t in tables]
        print(f"この DB 内のテーブル ({len(names)} 個): {names!r}\n")
    except sqlite3.Error as e:
        print(f"テーブル一覧の取得に失敗: {e}", file=sys.stderr)
        traceback.print_exc()
        conn.close()
        sys.exit(2)

    if "users" not in names:
        print("users テーブルがありません。このファイルは prsk_ocr の DB ではない可能性があります。")
        conn.close()
        sys.exit(2)

    try:
        n = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()[0]
        print(f"users の行数: {n}\n")
    except sqlite3.Error as e:
        print(f"users の件数取得に失敗: {e}", file=sys.stderr)
        traceback.print_exc()
        conn.close()
        sys.exit(2)

    if n > 0:
        try:
            all_users = conn.execute(
                "SELECT id, username FROM users ORDER BY id"
            ).fetchall()
            print("登録されている username（repr）:")
            for r in all_users:
                print(f"  id={r['id']}  {r['username']!r}")
            print()
        except sqlite3.Error as e:
            print(f"ユーザー一覧の取得に失敗: {e}", file=sys.stderr)
            traceback.print_exc()
            conn.close()
            sys.exit(2)

    username = (sys.argv[1] if len(sys.argv) > 1 else input("username: ")).strip()
    password = getpass.getpass("password: ")

    try:
        row = conn.execute(
            "SELECT id, username, password_hash FROM users WHERE username = ?",
            (username,),
        ).fetchone()
    except sqlite3.Error as e:
        print(f"ユーザー検索に失敗: {e}", file=sys.stderr)
        traceback.print_exc()
        conn.close()
        sys.exit(2)

    conn.close()

    if not row:
        print(f"入力した username（repr）: {username!r}")
        print("上記と完全一致する行は users にありません。")
        if n == 0:
            print("（users は 0 件のため、一覧も出ません。新規登録が必要です。）")
        sys.exit(1)

    ph = row["password_hash"]
    if isinstance(ph, str):
        ph = ph.encode("utf-8")
    p = (password or "").encode("utf-8")[:72]
    ok = bcrypt.checkpw(p, ph)
    print(f"該当ユーザー: id={row['id']} username={row['username']!r}")
    print(f"bcrypt.checkpw: {ok}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
