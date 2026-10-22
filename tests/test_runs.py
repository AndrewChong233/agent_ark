import asyncio
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx

from ark.engine import run_agent
from ark.runs import RunManager
from ark.settings import ModelSettings
from ark.web import create_app

CONFIG = {"systemPrompt": "测试助手", "enabledTools": ["search_knowledge", "current_time"]}
MESSAGES = [{"role": "user", "content": "答辩材料"}]


class RunTests(unittest.IsolatedAsyncioTestCase):
    async def test_engine_emits_real_model_and_tool_sequence(self):
        events = []
        calls = 0

        async def model(history, definitions):
            nonlocal calls
            calls += 1
            if calls == 1:
                return {"tool_calls": [{"id": "time-1", "function": {"name": "current_time", "arguments": "{}"}}]}
            return {"content": "完成"}

        async def emit(kind, data):
            events.append((kind, data))

        await run_agent(messages=MESSAGES, config=CONFIG, demo=False, model=model, on_event=emit)
        self.assertEqual([kind for kind, _ in events], ["model_start", "model_end", "tool_start", "tool_end", "model_start", "model_end"])
        self.assertEqual(events[3][1]["result"]["timezone"], "Asia/Shanghai")

    async def test_cancel_reaches_model_and_releases_slot(self):
        state = SimpleNamespace(busy=0)
        manager = RunManager(state)
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def model(*args, **kwargs):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        with patch("ark.engine.call_model", model):
            run = manager.start(messages=MESSAGES, config=CONFIG, settings=ModelSettings(api_key="test-only"))
            await asyncio.wait_for(started.wait(), 2)
            await manager.cancel(run)
        self.assertTrue(cancelled.is_set())
        self.assertEqual(run.status, "cancelled")
        self.assertEqual(state.busy, 0)
        self.assertEqual(run.events[-1]["type"], "cancelled")
        self.assertNotIn("completed", [e["type"] for e in run.events])
        await manager.cancel(run)
        self.assertEqual(state.busy, 0)

    async def test_immediate_cancel_and_bounded_history(self):
        state = SimpleNamespace(busy=0)
        manager = RunManager(state)
        run = manager.start(messages=MESSAGES, config=CONFIG, settings=ModelSettings())
        await manager.cancel(run)
        self.assertEqual(state.busy, 0)
        for _ in range(32):
            run = manager.start(messages=MESSAGES, config=CONFIG, settings=ModelSettings())
            await run.task
        self.assertLessEqual(len(manager.runs), 30)
        self.assertEqual(run.model_calls, 0)
        self.assertEqual(run.tool_calls, 1)
        self.assertEqual(run.events[-1]["type"], "completed")


class RunAPITests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.app = create_app(ModelSettings())
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://127.0.0.1:3000")

    async def asyncTearDown(self):
        await self.app.state.runs.close()
        await self.client.aclose()

    async def test_demo_stream_and_replay(self):
        response = await self.client.post("/api/runs", json={"messages": MESSAGES})
        self.assertEqual(response.status_code, 200)
        run_id = response.json()["runId"]
        response = await self.client.get(f"/api/runs/{run_id}/events")
        self.assertIn("text/event-stream", response.headers["content-type"])
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        self.assertEqual([e["type"] for e in events], ["started", "demo", "tool_start", "tool_end", "completed"])
        self.assertEqual(events[-1]["data"]["modelCalls"], 0)
        self.assertEqual(events[-1]["data"]["toolCalls"], 1)
        self.assertIn("PPT", events[-1]["data"]["content"])
        self.assertEqual([e["elapsedMs"] for e in events], sorted(e["elapsedMs"] for e in events))
        replay = await self.client.get(f"/api/runs/{run_id}/events", headers={"Last-Event-ID": "3"})
        self.assertEqual(replay.text.count("data: "), 1)
        self.assertIn('"completed"', replay.text)
        self.assertEqual((await self.client.post(f"/api/runs/{run_id}/cancel", json={})).json()["status"], "completed")

    async def test_cancel_api_stops_task_and_event_stream(self):
        started = asyncio.Event()

        async def slow(**kwargs):
            started.set()
            await asyncio.Event().wait()

        with patch("ark.runs.run_agent", slow):
            response = await self.client.post("/api/runs", json={"messages": MESSAGES})
            run_id = response.json()["runId"]
            await asyncio.wait_for(started.wait(), 2)
            cancel = await self.client.post(f"/api/runs/{run_id}/cancel", json={})
        self.assertEqual(cancel.json()["status"], "cancelled")
        stream = await self.client.get(f"/api/runs/{run_id}/events")
        self.assertIn('"cancelled"', stream.text)
        self.assertEqual(self.app.state.busy, 0)

    async def test_failed_run_has_terminal_event_and_releases_slot(self):
        async def fail(**kwargs):
            raise ValueError("测试失败")

        with patch("ark.runs.run_agent", fail):
            run_id = (await self.client.post("/api/runs", json={"messages": MESSAGES})).json()["runId"]
            response = await self.client.get(f"/api/runs/{run_id}/events")
        self.assertIn('"failed"', response.text)
        self.assertIn("测试失败", response.text)
        self.assertEqual(self.app.state.busy, 0)

    async def test_validation_and_concurrency_shared_with_chat(self):
        self.assertEqual((await self.client.post("/api/runs", json={})).status_code, 400)
        self.app.state.busy = 3
        self.assertEqual((await self.client.post("/api/runs", json={"messages": MESSAGES})).status_code, 429)
        self.app.state.busy = 0
        self.assertEqual((await self.client.get("/api/runs/missing/events")).status_code, 404)
        self.assertEqual((await self.client.post("/api/runs/missing/cancel", json={})).status_code, 404)
