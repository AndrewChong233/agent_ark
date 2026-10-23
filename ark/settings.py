"""本机模型配置；持久化到被 Git 忽略的 .env，不回传密钥。"""

from dataclasses import dataclass, field
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import dotenv_values, set_key

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class ModelSettings:
    base_url: str = ""
    model: str = ""
    api_key: str = field(default="", repr=False)

    @classmethod
    def from_environment(cls, path=None):
        values = dotenv_values(path or ROOT / '.env', interpolate=False)
        for key in ('HOST', 'PORT'):
            if values.get(key):
                os.environ.setdefault(key, values[key])
        return cls(
            values.get('MODEL_BASE_URL', os.getenv("MODEL_BASE_URL", "")) or '',
            values.get('MODEL_NAME', os.getenv("MODEL_NAME", "")) or '',
            values.get('MODEL_API_KEY', os.getenv("MODEL_API_KEY", "")) or '',
        )

    def public(self):
        return {"baseUrl": self.base_url, "model": self.model, "hasKey": bool(self.api_key)}


def persist_model_settings(settings, path):
    """先完成文件替换再更新运行配置；失败时保留原文件。"""
    path = Path(path)
    if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
        raise ValueError('配置文件不能是链接')
    temporary = None
    try:
        existing = path.read_text(encoding='utf-8-sig') if path.exists() else ''
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, prefix='.env-save-', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(existing)
        for key, value in {'MODEL_BASE_URL':settings.base_url, 'MODEL_NAME':settings.model, 'MODEL_API_KEY':settings.api_key}.items():
            set_key(str(temporary), key, value, quote_mode='always')
        os.replace(temporary, path)
    except OSError:
        raise ValueError('无法保存本机配置，请检查项目目录写入权限；原配置未更改') from None
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


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
