from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import httpx
from ark.settings import ROOT, ModelSettings, persist_model_settings
from ark.web import create_app


class PersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_save_reload_blank_key_and_persistent_demo(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as folder:
            path=Path(folder)/'.env'
            path.write_text('# keep comment\nPORT=3000\nOTHER_SETTING=keep\n',encoding='utf-8')
            app=create_app(ModelSettings(),settings_path=path)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://127.0.0.1') as client:
                payload={'baseUrl':'https://provider.example/v1','model':'test-model','apiKey':"test-$key'with-quote"}
                response=await client.post('/api/model',json=payload)
                self.assertEqual(response.status_code,200)
                self.assertNotIn(payload['apiKey'],response.text)
                restored=ModelSettings.from_environment(path)
                self.assertEqual(restored.api_key,payload['apiKey'])
                self.assertIn('OTHER_SETTING=keep',path.read_text())
                self.assertIn('# keep comment',path.read_text())
                await client.post('/api/model',json={**payload,'model':'next-model','apiKey':''})
                self.assertEqual(ModelSettings.from_environment(path).api_key,payload['apiKey'])
                self.assertEqual(create_app(settings_path=path).state.settings.model,'next-model')
                await client.post('/api/model',json={'action':'demo'})
                self.assertFalse(create_app(settings_path=path).state.settings.api_key)

    async def test_write_failure_preserves_file_and_memory(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as folder:
            path=Path(folder)/'.env';path.write_text('OTHER=original\n')
            settings=ModelSettings('https://old.example/v1','old-model','old-test-key')
            app=create_app(settings,settings_path=path)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://127.0.0.1') as client:
                with patch('ark.settings.os.replace',side_effect=OSError('test-denied')):
                    response=await client.post('/api/model',json={'baseUrl':'https://new.example/v1','model':'new','apiKey':'new-test-key'})
                self.assertEqual(response.status_code,400)
                self.assertEqual(app.state.settings,settings)
                self.assertEqual(path.read_text(),'OTHER=original\n')
                self.assertEqual(list(Path(folder).glob('.env-save-*')),[])
