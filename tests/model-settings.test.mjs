import test from 'node:test';
import assert from 'node:assert/strict';
import { validateModelSettings, publicModelSettings } from '../src/model-settings.mjs';
test('模型配置验证 URL、模型和密钥；空密钥保留原配置', () => {
  const settings = validateModelSettings({ baseUrl: ' https://example.com/v1/ ', model: ' test-model ', apiKey: '' }, 'test-only-key');
  assert.equal(settings.baseUrl, 'https://example.com/v1');
  assert.equal(settings.model, 'test-model');
  assert.equal(settings.apiKey, 'test-only-key');
  assert.throws(() => validateModelSettings({ baseUrl: 'http://example.com/v1', model: 'x', apiKey: 'test' }), /HTTPS/);
  assert.throws(() => validateModelSettings({ baseUrl: 'https://example.com/v1?key=hidden', model: 'x', apiKey: 'test' }), /查询参数/);
  assert.throws(() => validateModelSettings({ baseUrl: 'https://example.com/v1/chat/completions', model: 'x', apiKey: 'test' }), /不要包含/);
  assert.throws(() => validateModelSettings({ baseUrl: 'https://example.com/v1', model: 'x', apiKey: '' }), /密钥/);
  assert.doesNotThrow(() => validateModelSettings({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'local', apiKey: 'local' }));
});
test('公开配置不包含 API 密钥', () => {
  assert.deepEqual(Object.keys(publicModelSettings()).sort(), ['baseUrl', 'hasKey', 'model']);
});
