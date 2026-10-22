from pathlib import Path
import tempfile
import unittest
from ark.engine import run_agent
from ark.settings import ROOT
from ark.spaces import Spaces

CONFIG={'systemPrompt':'助手','enabledTools':[]}


class DefaultPlanTests(unittest.IsolatedAsyncioTestCase):
    async def test_defaults_carry_history_and_missing_tool_call_produces_draft(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            store=Spaces(Path(directory)/'spaces'); space=store.create('运动')
            messages=[{'role':'user','content':'我要生成一个适合新手的运动计划'},{'role':'assistant','content':'请补充信息，或者使用默认方案。'},{'role':'user','content':'用默认'}]
            async def model(history, tools):
                self.assertEqual(history[-3:],messages)
                self.assertIn('不要重复收集',history[0]['content'])
                self.assertIn('propose_file',[t['function']['name'] for t in tools])
                return {'content':'# 新手运动计划\n按默认假设制定的示例计划内容。'}
            answer=await run_agent(messages=messages,config=CONFIG,model=model,demo=False,space=(store,space['id']))
            self.assertEqual(answer['trace'][0]['name'],'propose_file')
            self.assertEqual(store.files(space['id']),[])
            self.assertIn('新手运动计划',answer['trace'][0]['result']['content'])
            store.approve(space['id'],answer['trace'][0]['result']['approvalId'],True)
            self.assertEqual(len(store.files(space['id'])),1)

    async def test_no_space_never_writes_and_explains_capability(self):
        async def model(history,tools):
            self.assertIn('当前未选择主题空间',history[0]['content'])
            self.assertNotIn('propose_file',[t['function']['name'] for t in tools])
            return {'content':'请先选择主题空间。'}
        result=await run_agent(messages=[{'role':'user','content':'生成运动计划文件'}],config=CONFIG,model=model,demo=False)
        self.assertEqual(result['trace'],[])

    async def test_thanks_does_not_repeat_previous_file_request(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            store=Spaces(Path(directory)/'spaces'); space=store.create('运动')
            async def model(history,tools): return {'content':'不客气。'}
            result=await run_agent(messages=[{'role':'user','content':'生成计划文件'},{'role':'assistant','content':'已提供草稿'},{'role':'user','content':'谢谢'}],config=CONFIG,model=model,demo=False,space=(store,space['id']))
            self.assertEqual(result['trace'],[])
