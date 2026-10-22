"""兼容既有网页的 API。当前仅供本机开发，设置在单进程内共享。"""

import asyncio
from dataclasses import replace
import json
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse

from .engine import ModelError, run_agent
from .settings import ROOT, ModelSettings, validate_model_settings

MAX_BODY = 100000
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    "Cache-Control": "no-store",
}


async def read_json(request):
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > MAX_BODY:
            raise ValueError("请求过大")
    try:
        data = json.loads(content)
    except (ValueError, UnicodeError):
        raise ValueError("请求不是有效的 JSON") from None
    if not isinstance(data, dict):
        raise ValueError("请求需要是 JSON 对象")
    return data


def read_config():
    return json.loads((ROOT / "agent.config.json").read_text(encoding="utf-8-sig"))


def create_app(settings=None):
    app = FastAPI(title="ARK Agent", version="0.2.0", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings if settings is not None else ModelSettings.from_environment()
    app.state.busy = 0

    @app.middleware("http")
    async def boundary(request: Request, call_next):
        async def dispatch():
            host = request.headers.get("host", "")
            try:
                parsed = urlsplit("http://" + host)
                _ = parsed.port
                valid_host = parsed.hostname in {"localhost", "127.0.0.1", "::1"} and not (parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment)
            except ValueError:
                valid_host = False
            if not valid_host:
                return JSONResponse({"error": "当前开发版本只支持本机访问"}, 403)
            if request.method == "POST":
                origin = request.headers.get("origin")
                if origin and origin != "http://" + host:
                    return JSONResponse({"error": "不允许跨站请求"}, 403)
                if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                    return JSONResponse({"error": "需要 application/json"}, 415)
                length = request.headers.get("content-length")
                if length:
                    try:
                        size = int(length)
                        if size < 0 or size > MAX_BODY:
                            return JSONResponse({"error": "请求过大"}, 413)
                    except ValueError:
                        return JSONResponse({"error": "请求长度不正确"}, 400)
            try:
                return await call_next(request)
            except Exception:
                # 不把路径、模型响应或带凭据的异常文本直接传给客户端。
                return JSONResponse({"error": "请求处理失败，请检查配置或服务端状态"}, 500)

        response = await dispatch()
        response.headers.update(SECURITY_HEADERS)
        return response

    @app.exception_handler(ValueError)
    async def validation_error(_request, error):
        return JSONResponse({"error": str(error)}, 400)

    @app.exception_handler(ModelError)
    async def model_error(_request, error):
        return JSONResponse({"error": str(error)}, 502)

    @app.get("/api/health")
    async def health():
        return {"status": "ok", "backend": "python", "version": "0.2.0"}

    @app.get("/api/config")
    async def config():
        data = read_config()
        return {**{key: data[key] for key in ("name", "theme", "description", "welcome", "starters", "enabledTools")}, "mode": "live" if app.state.settings.api_key else "demo"}

    @app.get("/api/model")
    async def get_model():
        return app.state.settings.public()

    @app.post("/api/model")
    async def set_model(request: Request):
        if not request.client or request.client.host not in {"127.0.0.1", "::1", "::ffff:127.0.0.1"}:
            return JSONResponse({"error": "模型配置只允许本机修改"}, 403)
        data = await read_json(request)
        if app.state.busy:
            return JSONResponse({"error": "请等待当前对话完成再修改模型"}, 409)
        if data.get("action") == "demo":
            app.state.settings = replace(app.state.settings, api_key="")
        else:
            app.state.settings = validate_model_settings(data, app.state.settings.api_key)
        return app.state.settings.public()

    @app.post("/api/chat")
    async def chat(request: Request):
        data = await read_json(request)
        if app.state.busy >= 3:
            return JSONResponse({"error": "当前任务较多，请稍后再试"}, 429)
        # 检查、计数和配置快照之间没有 await，单事件循环下保持原子性。
        app.state.busy += 1
        settings_snapshot = app.state.settings
        try:
            async with asyncio.timeout(120):
                return await run_agent(messages=data.get("messages"), config=read_config(), settings=settings_snapshot)
        except TimeoutError:
            return JSONResponse({"error": "任务超过两分钟，请缩小范围后重试"}, 504)
        finally:
            app.state.busy -= 1

    @app.get("/")
    async def index():
        return FileResponse(ROOT / "public" / "index.html", media_type="text/html")

    @app.get("/app.js")
    async def javascript():
        return FileResponse(ROOT / "public" / "app.js", media_type="text/javascript")

    @app.get("/style.css")
    async def stylesheet():
        return FileResponse(ROOT / "public" / "style.css", media_type="text/css")

    # 只映射上面的静态资源，不开放项目根目录或 .env。
    @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
    async def missing(path: str):
        return JSONResponse({"error": "页面不存在"}, 404)

    return app
