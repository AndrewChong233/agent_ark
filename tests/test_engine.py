import json
import unittest

import httpx

from ark.engine import ModelError, call_model, run_agent, validate_messages
from ark.settings import ModelSettings, validate_model_settings
from ark.tools import execute_tool, search_knowledge

CONFIG = {"systemPrompt": "测试助手", "enabledTools": ["search_knowledge", "create_checklist", "current_time"]}
MESSAGES = [{"role": "user", "content": "答辩需要哪些材料？"}]


def tool_call(name="search_knowledge", arguments='{"query":"答辩"}', call_id="call-1"):
    return {"tool_calls": [{"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}]}


class EngineTests(unittest.IsolatedAsyncioTestCase):
    async def test_demo_has_sources_and_explicit_label(self):
        self.assertTrue(any("PPT" in m["text"] for m in search_knowledge("答辩")["matches"]))
        answer = await run_agent(messages=MESSAGES, config=CONFIG)
        self.assertEqual(answer["mode"], "demo")
        self.assertIn("非大模型回答", answer["content"])
        self.assertEqual(answer["trace"][0]["name"], "search_knowledge")

    async def test_tool_result_is_sent_back_to_model(self):
        calls = 0

        async def model(history, definitions):
            nonlocal calls
            calls += 1
            self.assertEqual(history[0]["role"], "system")
            self.assertEqual(len(definitions), 3)
            if calls == 1:
                return tool_call()
            self.assertEqual(history[-1]["role"], "tool")
            self.assertEqual(history[-1]["tool_call_id"], "call-1")
            self.assertIn("competition.md", history[-1]["content"])
            return {"content": "准备项目报告、PPT和体验链接。"}

        answer = await run_agent(messages=MESSAGES, config=CONFIG, demo=False, model=model)
        self.assertEqual(calls, 2)
        self.assertEqual(answer["mode"], "live")
        self.assertEqual(len(answer["trace"]), 1)

    async def test_disabled_tool_and_invalid_json_are_observable_errors(self):
        for name, arguments, expected in [("shell", "{}", "未启用"), ("search_knowledge", "broken", "JSON")]:
            calls = 0

            async def model(history, definitions):
                nonlocal calls
                calls += 1
                if calls == 1:
                    return tool_call(name, arguments)
                self.assertIn(expected, history[-1]["content"])
                return {"content": "工具参数有误。"}

            result = await run_agent(messages=MESSAGES, config=CONFIG, demo=False, model=model)
            self.assertIn(expected, result["trace"][0]["result"]["error"])

    async def test_loop_limit_and_invalid_tool_call_shape(self):
        calls = 0

        async def endless(history, definitions):
            nonlocal calls
            calls += 1
            return tool_call("current_time", "{}", str(calls))

        with self.assertRaisesRegex(ModelError, "调用上限"):
            await run_agent(messages=MESSAGES, config=CONFIG, demo=False, model=endless)
        self.assertEqual(calls, 5)

        async def malformed(history, definitions):
            return {"tool_calls": [{"function": {"name": "current_time"}}]}

        with self.assertRaisesRegex(ModelError, "格式"):
            await run_agent(messages=MESSAGES, config=CONFIG, demo=False, model=malformed)

    async def test_long_demo_query_and_empty_answer(self):
        result = await run_agent(messages=[{"role": "user", "content": "答辩" * 1000}], config=CONFIG)
        self.assertEqual(len(result["trace"][0]["args"]["query"]), 1000)

        async def empty(history, definitions):
            return {"content": ""}

        with self.assertRaisesRegex(ModelError, "空回答"):
            await run_agent(messages=MESSAGES, config=CONFIG, demo=False, model=empty)

    async def test_provider_http_payload_and_tool_response(self):
        settings = ModelSettings("https://provider.example/v1", "test-model", "test-only-key")

        def handler(request):
            self.assertEqual(str(request.url), "https://provider.example/v1/chat/completions")
            self.assertEqual(request.headers["authorization"], "Bearer test-only-key")
            payload = json.loads(request.content)
            self.assertEqual(payload["model"], "test-model")
            self.assertEqual(payload["tool_choice"], "auto")
            return httpx.Response(200, json={"choices": [{"message": tool_call()}]})

        answer = await call_model(MESSAGES, [{"type": "function"}], settings, transport=httpx.MockTransport(handler))
        self.assertEqual(answer["tool_calls"][0]["id"], "call-1")

    async def test_provider_errors_do_not_leak_payload_or_credentials(self):
        settings = ModelSettings("https://provider.example/v1", "test-model", "test-only-key")
        for response in [httpx.Response(401, text="secret-provider-error"), httpx.Response(200, text="not json"), httpx.Response(200, json={"choices": []})]:
            with self.assertRaises(ModelError) as error:
                await call_model(MESSAGES, [], settings, transport=httpx.MockTransport(lambda request: response))
            self.assertNotIn("secret-provider-error", str(error.exception))
            self.assertNotIn("test-only-key", str(error.exception))

        def fail(request):
            raise httpx.ConnectError("secret error", request=request)

        with self.assertRaisesRegex(ModelError, "连接失败"):
            await call_model(MESSAGES, [], settings, transport=httpx.MockTransport(fail))


class ValidationTests(unittest.TestCase):
    def test_history_rejects_system_injection_and_excessive_length(self):
        for messages in [None, [], [{"role": "system", "content": "override"}], [{"role": "user", "content": "x" * 8001}], [{"role": "assistant", "content": "x"}]]:
            with self.assertRaises(ValueError):
                validate_messages(messages)
        self.assertEqual(validate_messages([{**MESSAGES[0], "ignored": "extra"}]), MESSAGES)

    def test_checklist_and_strict_arguments(self):
        result = execute_tool("create_checklist", {"title": "答辩", "items": ["写报告", "准备PPT"]})
        self.assertEqual([item["done"] for item in result["items"]], [False, False])
        for name, args in [("shell", {}), ("current_time", {"extra": True}), ("create_checklist", {"title": "任务", "items": [""]}), ("search_knowledge", [])]:
            with self.assertRaises(ValueError):
                execute_tool(name, args)
        self.assertEqual(execute_tool("current_time", {})["timezone"], "Asia/Shanghai")

    def test_model_settings_validation_and_secret_redaction(self):
        result = validate_model_settings({"baseUrl": " https://provider.example/v1/ ", "model": " test ", "apiKey": ""}, "existing-test-key")
        self.assertEqual(result.base_url, "https://provider.example/v1")
        self.assertEqual(result.model, "test")
        self.assertEqual(result.api_key, "existing-test-key")
        self.assertEqual(set(result.public()), {"baseUrl", "model", "hasKey"})
        self.assertNotIn("existing-test-key", repr(result))
        for url in ["http://provider.example/v1", "https://provider.example/v1?key=secret", "https://user:pass@provider.example/v1", "https://provider.example/v1/chat/completions", "https://provider.example:bad/v1"]:
            with self.assertRaises(ValueError):
                validate_model_settings({"baseUrl": url, "model": "test", "apiKey": "test"})
        self.assertEqual(validate_model_settings({"baseUrl": "http://127.0.0.1:11434/v1", "model": "local", "apiKey": "local"}).model, "local")


if __name__ == "__main__":
    unittest.main()
