"""Windows 用: どの import で落ちるか %TEMP%\\prsk_ocr_diag.txt に追記する。
  py -3 scripts/prsk_diag_imports.py
  またはリポジトリルートで: python scripts/prsk_diag_imports.py
"""
from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path


def main() -> int:
    log = Path(os.environ.get("TEMP", os.environ.get("TMP", "."))) / "prsk_ocr_diag.txt"

    def append(msg: str) -> None:
        try:
            with log.open("a", encoding="utf-8") as f:
                f.write(msg + "\n")
        except OSError:
            pass

    append("---")
    append(f"argv={sys.argv}")
    append(f"cwd={os.getcwd()}")
    append(f"executable={sys.executable}")

    steps = [
        ("numpy", lambda: __import__("numpy")),
        ("cv2", lambda: __import__("cv2")),
        ("PIL", lambda: __import__("PIL.Image")),
        ("fastapi", lambda: __import__("fastapi")),
        ("import server (paddleocr は遅延)", lambda: __import__("server")),
    ]
    for name, fn in steps:
        append(f"TRY {name}")
        try:
            fn()
            append(f"OK  {name}")
        except BaseException:
            append(f"FAIL {name}\n{traceback.format_exc()}")
            print(f"FAILED at: {name} — see {log}", file=sys.stderr)
            return 1

    append("ALL OK")
    print(f"All steps OK — {log}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
