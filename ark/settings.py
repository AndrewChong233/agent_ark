"""进程内模型配置；密钥不会写入磁盘或返回前端。"""

from dataclasses import dataclass, field
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class ModelSettings:
    base_url: str = ""
    model: str = ""
    api_key: str = field(default="", repr=False)

    @classmethod
    def from_environment(cls):
        load_dotenv(ROOT / ".env", override=False)
        return cls(
            os.getenv("MODEL_BASE_URL", ""),
            os.getenv("MODEL_NAME", ""),
            os.getenv("MODEL_API_KEY", ""),
        )

    def public(self):
        return {"baseUrl": self.base_url, "model": self.model, "hasKey": bool(self.api_key)}


def validate_model_settings(data, existing_key=""):
    if not isinstance(data, dict):
        raise ValueError("配置格式不正确")
    base = data.get("baseUrl", "")
    model = data.get("model", "")
    key = data.get("apiKey", "")
    if not all(isinstance(value, str) for value in (base, model, key)):
        raise ValueError("配置字段必须为文本")
    base, model, key = base.strip().rstrip("/"), model.strip(), key.strip() or existing_key
    try:
        url = urlsplit(base)
        port = url.port
        valid_host = bool(url.hostname) and not any(c.isspace() for c in url.netloc)
    except ValueError:
        raise ValueError("请输入有效的模型服务地址") from None
    if not valid_host or port == 0 or len(base) > 2000 or any(ord(c) < 32 for c in base):
        raise ValueError("请输入有效的模型服务地址")
    if url.username or url.password or url.query or url.fragment:
        raise ValueError("服务地址不能包含账号、密码、查询参数或锚点")
    if url.scheme != "https" and not (
        url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"}
    ):
        raise ValueError("使用 HTTPS 地址，本机模型可使用 HTTP")
    if re.search(r"/chat/completions/?$", url.path):
        raise ValueError("地址不要包含 /chat/completions，通常填写到 /v1")
    if not model or len(model) > 200:
        raise ValueError("请填写有效的模型名称")
    if not key or len(key) > 4096 or any(ord(c) < 32 or ord(c) > 126 for c in key):
        raise ValueError("请填写有效的 API 密钥")
    return ModelSettings(base, model, key)
