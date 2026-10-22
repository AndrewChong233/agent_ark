export function validateModelSettings(input, existingKey = '') {
  if (!input || typeof input !== 'object') throw new Error('配置格式不正确');
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim().replace(/\/+$/, '') : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() || existingKey : existingKey;
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('请输入有效的模型服务地址'); }
  if (url.username || url.password || url.search || url.hash || baseUrl.length > 2000) throw new Error('服务地址不能包含账号、密码、查询参数或锚点');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('使用 HTTPS 地址，本机模型可使用 HTTP');
  if (/\/chat\/completions\/?$/.test(url.pathname)) throw new Error('地址不要包含 /chat/completions，通常填写到 /v1');
  if (!model || model.length > 200) throw new Error('请填写有效的模型名称');
  if (!apiKey || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new Error('请填写有效的 API 密钥');
  return { baseUrl, model, apiKey };
}

export function publicModelSettings() {
  return { baseUrl: process.env.MODEL_BASE_URL || '', model: process.env.MODEL_NAME || '', hasKey: Boolean(process.env.MODEL_API_KEY) };
}
