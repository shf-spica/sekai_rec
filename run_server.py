"""
ASGI app を import 文字列で指定せず起動する。server:app をコード内で参照する。
"""
import uvicorn
from server import app

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
