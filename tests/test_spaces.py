import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import httpx
from ark.settings import ROOT, ModelSettings
from ark.spaces import Spaces
from ark.web import create_app


class SpaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.store = Spaces(Path(self.temp.name) / 'spaces')
        self.id = self.store.create('学习')['id']

    def tearDown(self):
        self.temp.cleanup()

    def test_only_approval_writes_and_no_overwrite_or_replay(self):
        draft = self.store.propose(self.id, '笔记.md', '内容')
        self.assertEqual(self.store.files(self.id), [])
        self.store.approve(self.id, draft['approvalId'], True)
        self.assertEqual(self.store.read(self.id, '笔记.md')['content'], '内容')
        with self.assertRaises(ValueError): self.store.approve(self.id, draft['approvalId'], True)
        draft = self.store.propose(self.id, '笔记.md', '覆盖')
        with self.assertRaisesRegex(ValueError, '不会覆盖'): self.store.approve(self.id, draft['approvalId'], True)
        self.assertEqual(self.store.read(self.id, '笔记.md')['content'], '内容')

    def test_paths_types_size_rejection_and_cross_space(self):
        for name in ['../secret.txt', '/etc/file.txt', 'C:\\secret.txt', '.env', 'x.py', 'x.exe', 'x.cmd', 'a/b.md', 'x.txt:stream', 'CON.txt', 'LPT1.md', 'a..b.md']:
            with self.subTest(name=name), self.assertRaises(ValueError): self.store.propose(self.id, name, 'bad')
        with self.assertRaises(ValueError): self.store.propose(self.id, 'large.txt', '中' * 10000)
        draft = self.store.propose(self.id, 'good.md', 'okay')
        other = self.store.create('其他')['id']
        with self.assertRaises(ValueError): self.store.approve(other, draft['approvalId'], True)
        self.store.approve(self.id, draft['approvalId'], False)
        self.assertEqual(self.store.files(self.id), [])
        draft = self.store.propose(self.id, 'old.md', 'expired')
        self.store.drafts[draft['approvalId']]['expires'] = 0
        with self.assertRaises(ValueError): self.store.approve(self.id, draft['approvalId'], True)

    def test_symbolic_link_is_denied(self):
        target = Path(self.temp.name) / 'outside.md'; target.write_text('secret')
        link = self.store.directory(self.id) / 'linked.md'
        try: link.symlink_to(target)
        except OSError: self.skipTest('System does not permit symlinks')
        with self.assertRaisesRegex(ValueError, '链接'): self.store.read(self.id, 'linked.md')
        self.assertEqual(self.store.files(self.id), [])


class SpaceAPI(unittest.IsolatedAsyncioTestCase):
    async def test_model_creates_draft_and_ui_approval_creates_file(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as folder:
            app = create_app(ModelSettings('https://test.example/v1', 'test', 'test-only'))
            app.state.spaces = Spaces(Path(folder) / 'spaces')
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://127.0.0.1') as client:
                space = (await client.post('/api/spaces',json={'name':'生活'})).json()
                calls = 0
                async def model(messages, definitions, settings):
                    nonlocal calls
                    calls += 1
                    self.assertIn('propose_file', [d['function']['name'] for d in definitions])
                    if calls == 1: return {'tool_calls':[{'id':'draft','function':{'name':'propose_file','arguments':json.dumps({'name':'计划.md','content':'测试计划'})}}]}
                    return {'content':'草稿待你批准。'}
                with patch('ark.engine.call_model', model):
                    run_id = (await client.post('/api/runs',json={'spaceId':space['id'],'messages':[{'role':'user','content':'生成计划'}]})).json()['runId']
                    await app.state.runs.runs[run_id].task
                last = app.state.runs.runs[run_id].events[-1]['data']
                draft = last['trace'][0]['result']
                self.assertEqual((await client.get(f"/api/spaces/{space['id']}/files")).json()['files'],[])
                url = f"/api/spaces/{space['id']}/approve"
                self.assertEqual((await client.post(url,json={'approvalId':draft['approvalId'],'allow':True},headers={'Origin':'https://foreign.example'})).status_code,403)
                self.assertEqual((await client.post(url,json={'approvalId':draft['approvalId'],'allow':True})).json()['status'],'saved')
                self.assertEqual((await client.post(f"/api/spaces/{space['id']}/read",json={'name':'计划.md'})).json()['content'],'测试计划')
