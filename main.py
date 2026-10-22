"""PyCharm: 选择项目 .venv 解释器，直接运行这个文件。"""

import os

import uvicorn

from ark.web import create_app

app = create_app()

if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "3000"))
    if host not in {"localhost", "127.0.0.1", "::1"}:
        raise SystemExit("当前开发版本仅支持本机访问，请将 HOST 设置为 127.0.0.1")
    print(f"ARK Python 已启动：http://{host}:{port}", flush=True)
    uvicorn.run(app, host=host, port=port, proxy_headers=False)
