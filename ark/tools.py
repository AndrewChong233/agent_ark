"""业务工具注册与执行。新增工具后，在 agent.config.json 中启用。"""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import re

from .settings import ROOT

TOOL_DEFINITIONS = [
    {"type": "function", "function": {
        "name": "search_knowledge", "description": "搜索本地知识库，返回相关原文及来源文件名。",
        "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "检索词或问题"}}, "required": ["query"], "additionalProperties": False},
    }},
    {"type": "function", "function": {
        "name": "create_checklist", "description": "把任务整理成可以勾选的清单。只生成清单，不执行清单中的任务。",
        "parameters": {"type": "object", "properties": {"title": {"type": "string"}, "items": {"type": "array", "items": {"type": "string"}, "maxItems": 20}}, "required": ["title", "items"], "additionalProperties": False},
    }},
    {"type": "function", "function": {
        "name": "current_time", "description": "获取中国标准时间。",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
    }},
]


def search_knowledge(query, directory: Path = ROOT / "knowledge"):
    if not isinstance(query, str) or not query.strip() or len(query) > 1000:
        raise ValueError("检索词需要是 1—1000 字的文本")
    tokens = set(re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]{1,2}", query.lower()))
    matches = []
    for path in sorted(directory.iterdir()):
        if path.suffix.lower() not in {".md", ".txt"} or not path.is_file() or path.is_symlink():
            continue
        # 不递归，不跟随符号链接，限制单文件读取长度。
        with path.open(encoding="utf-8-sig") as stream:
            content = stream.read(100000)
        for line, paragraph in enumerate(content.splitlines(), 1):
            lower = paragraph.lower()
            score = sum(token in lower for token in tokens)
            if score:
                matches.append({"source": path.name, "line": line, "text": paragraph[:1800], "score": score})
    matches.sort(key=lambda item: item["score"], reverse=True)
    return {"matches": matches[:5], "method": "本地关键词检索（非语义检索）"}


def execute_tool(name, args):
    if not isinstance(args, dict):
        raise ValueError("工具参数必须为对象")
    expected = {"search_knowledge": {"query"}, "create_checklist": {"title", "items"}, "current_time": set()}
    if name not in expected:
        raise ValueError("未知工具")
    if set(args) != expected[name]:
        raise ValueError("工具参数缺失或包含未声明字段")
    if name == "search_knowledge":
        return search_knowledge(args["query"])
    if name == "current_time":
        return {"time": datetime.now(timezone(timedelta(hours=8))).strftime("%Y/%m/%d %H:%M:%S"), "timezone": "Asia/Shanghai"}
    title, items = args["title"], args["items"]
    if (
        not isinstance(title, str) or not title.strip() or len(title) > 100
        or not isinstance(items, list) or not 1 <= len(items) <= 20
        or any(not isinstance(item, str) or not item.strip() or len(item) > 500 for item in items)
    ):
        raise ValueError("清单需要标题和 1—20 条有效任务")
    return {"title": title, "items": [{"text": text, "done": False} for text in items]}
