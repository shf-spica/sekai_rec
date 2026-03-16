"""
ASGI app を import 文字列で指定せず起動する。server:app をコード内で参照する。
起動前に: pip install -r requirements.txt
"""
import sys

try:
    import uvicorn
    from server import app
except ModuleNotFoundError as e:
    print("Missing dependency:", e.name, file=sys.stderr)
    print("Install with: pip install -r requirements.txt", file=sys.stderr)
    sys.exit(1)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
