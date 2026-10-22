import asyncio
import unittest
from unittest.mock import patch

import httpx

from ark.engine import ModelError
from ark.settings import ModelSettings
from ark.web import create_app


class WebTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.app = create_app(ModelSettings())
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://127.0.0.1:3000")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_static_config_and_python_health(self):
        for path in ("/", "/app.js", "/style.css"):
            response = await self.client.get(path)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        config = (await self.client.get("/api/config")).json()
        self.assertEqual(config["mode"], "demo")
        self.assertIn("starters", config)
        self.assertEqual((await self.client.get("/api/health")).json()["backend"], "python")

    async def test_demo_chat_preserves_frontend_contract(self):
        response = await self.client.post("/api/chat", json={"messages": [{"role": "user", "content": "答辩需要哪些材料？"}]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["mode"], "demo")
        self.assertIn("PPT", response.json()["content"])
        self.assertEqual(response.json()["trace"][0]["name"], "search_knowledge")
        self.assertEqual(self.app.state.busy, 0)

    async def test_model_save_preserve_key_and_switch_demo(self):
        payload = {"baseUrl": "https://provider.example/v1", "model": "test", "apiKey": "test-only-key"}
        response = await self.client.post("/api/model", json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["hasKey"])
        self.assertNotIn("test-only-key", response.text)
        public = await self.client.get("/api/model")
        self.assertNotIn("test-only-key", public.text)
        self.assertEqual((await self.client.get("/api/config")).json()["mode"], "live")
        await self.client.post("/api/model", json={**payload, "apiKey": "", "model": "new-model"})
        self.assertEqual(self.app.state.settings.api_key, "test-only-key")
        self.assertEqual(self.app.state.settings.model, "new-model")
        self.assertFalse((await self.client.post("/api/model", json={"action": "demo"})).json()["hasKey"])

    async def test_private_files_and_cross_site_requests_blocked(self):
        for path in ("/.env", "/ark/settings.py", "/requirements.txt", "/knowledge/competition.md", "/.git/config"):
            self.assertEqual((await self.client.get(path)).status_code, 404)
        for path in ("/api/model", "/api/chat"):
            self.assertEqual((await self.client.post(path, json={}, headers={"Origin": "https://foreign.example"})).status_code, 403)
        self.assertEqual((await self.client.get("/", headers={"Host": "foreign.example"})).status_code, 403)
        transport = httpx.ASGITransport(app=self.app, client=("192.0.2.1", 1234))
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as remote:
            self.assertEqual((await remote.post("/api/model", json={"action": "demo"})).status_code, 403)

    async def test_bad_bodies_and_content_type(self):
        self.assertEqual((await self.client.post("/api/chat", content="{}", headers={"Content-Type": "text/plain"})).status_code, 415)
        for data in ("broken", "[]", "null", '{"messages":[]}'):
            response = await self.client.post("/api/chat", content=data, headers={"Content-Type": "application/json"})
            self.assertEqual(response.status_code, 400)
            self.assertIn("error", response.json())
        response = await self.client.post("/api/chat", content="x" * 100001, headers={"Content-Type": "application/json"})
        self.assertEqual(response.status_code, 413)

        async def chunks():
            yield b"x" * 50000
            yield b"x" * 50001

        response = await self.client.post("/api/chat", content=chunks(), headers={"Content-Type": "application/json"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("过大", response.json()["error"])

    async def test_concurrent_limit_and_configuration_conflict(self):
        gate = asyncio.Event()
        started = asyncio.Event()
        count = 0

        async def blocked(**kwargs):
            nonlocal count
            count += 1
            if count == 3:
                started.set()
            await gate.wait()
            return {"content": "完成", "mode": "live", "trace": []}

        with patch("ark.web.run_agent", blocked):
            tasks = [asyncio.create_task(self.client.post("/api/chat", json={})) for _ in range(3)]
            try:
                await asyncio.wait_for(started.wait(), 5)
                self.assertEqual((await self.client.post("/api/chat", json={})).status_code, 429)
                self.assertEqual((await self.client.post("/api/model", json={"action": "demo"})).status_code, 409)
            finally:
                gate.set()
                responses = await asyncio.gather(*tasks)
            self.assertTrue(all(response.status_code == 200 for response in responses))
            self.assertEqual(self.app.state.busy, 0)

    async def test_provider_failure_and_timeout_release_slot(self):
        for error, status in [(ModelError("模型服务返回 401"), 502), (TimeoutError(), 504)]:
            async def fail(**kwargs):
                raise error

            with patch("ark.web.run_agent", fail):
                response = await self.client.post("/api/chat", json={})
            self.assertEqual(response.status_code, status)
            self.assertIn("error", response.json())
            self.assertEqual(self.app.state.busy, 0)


if __name__ == "__main__":
    unittest.main()
