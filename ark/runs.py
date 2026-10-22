"""有界的本机任务记录与真实事件流。任务在显式取消时终止。"""

import asyncio
from dataclasses import dataclass, field
import time
import uuid

from .engine import ModelError, run_agent

TERMINAL = {"completed", "failed", "cancelled"}


@dataclass
class Run:
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    status: str = "running"
    started: float = field(default_factory=time.monotonic)
    events: list = field(default_factory=list)
    changed: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    model_calls: int = 0
    tool_calls: int = 0

    async def emit(self, kind, data):
        if kind == "model_start":
            self.model_calls += 1
        elif kind == "tool_start":
            self.tool_calls += 1
        self.events.append({"seq": len(self.events), "type": kind, "elapsedMs": round((time.monotonic() - self.started) * 1000), "data": data})
        self.changed.set()


class RunManager:
    def __init__(self, state):
        self.state = state
        self.runs = {}

    def start(self, *, messages, config, settings):
        if self.state.busy >= 3:
            raise ValueError("当前任务较多，请稍后再试")
        # 只保留最近 30 个任务，正在执行的任务不会被清理。
        for run_id, old in list(self.runs.items()):
            if len(self.runs) < 30:
                break
            if old.status in TERMINAL:
                del self.runs[run_id]
        run = Run()
        self.runs[run.id] = run
        self.state.busy += 1

        async def execute():
            try:
                await run.emit("started", {"mode": "live" if settings.api_key else "demo"})
                async with asyncio.timeout(120):
                    result = await run_agent(messages=messages, config=config, settings=settings, on_event=run.emit)
                run.status = "completed"
                await run.emit("completed", {**result, "modelCalls": run.model_calls, "toolCalls": run.tool_calls})
            except asyncio.CancelledError:
                run.status = "cancelled"
                await run.emit("cancelled", {"message": "任务已停止"})
            except (ValueError, ModelError) as error:
                run.status = "failed"
                await run.emit("failed", {"message": str(error)})
            except TimeoutError:
                run.status = "failed"
                await run.emit("failed", {"message": "任务超过两分钟，请缩小范围后重试"})
            except Exception:
                run.status = "failed"
                await run.emit("failed", {"message": "任务处理失败，请检查配置或服务端状态"})
            finally:
                self.state.busy -= 1
                run.changed.set()

        run.task = asyncio.create_task(execute())
        return run

    async def cancel(self, run):
        if run.status not in TERMINAL:
            # 让刚创建的任务进入 try/finally，避免启动前取消导致计数泄漏。
            await asyncio.sleep(0)
            if not run.task.done():
                run.task.cancel()
            await run.task

    async def close(self):
        for run in list(self.runs.values()):
            await self.cancel(run)
