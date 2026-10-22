import { toolDefinitions, executeTool } from './tools.mjs';

export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 40) throw new Error('会话需要包含 1—40 条消息，请新建会话后继续');
  for (const message of messages) {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 8000) throw new Error('消息格式不正确或超过 8000 字');
  }
  if (messages.at(-1).role !== 'user') throw new Error('最后一条消息需要来自用户');
  return messages.map(({ role, content }) => ({ role, content }));
}

export async function callModel(messages, definitions, { signal } = {}) {
  const { MODEL_BASE_URL, MODEL_API_KEY, MODEL_NAME } = process.env;
  if (!MODEL_BASE_URL || !MODEL_NAME) throw new Error('请在 .env 中配置 MODEL_BASE_URL 和 MODEL_NAME');
  const base = new URL(MODEL_BASE_URL);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error('模型地址需要 HTTPS（本机模型允许 HTTP）');
  let response;
  try {
    response = await fetch(`${base.href.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MODEL_API_KEY}` },
      body: JSON.stringify({ model: MODEL_NAME, messages, ...(definitions.length ? { tools: definitions, tool_choice: 'auto' } : {}), temperature: 0.5, max_tokens: 1600 }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000)
    });
  } catch { throw new Error('模型连接失败或超时，请检查服务地址与网络'); }
  if (!response.ok) throw new Error(`模型服务返回 ${response.status}，请检查密钥、模型名和额度`);
  const payload = await response.json();
  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error('模型没有返回有效消息，请检查接口兼容性');
  return message;
}

export async function runAgent({ messages, config, model = callModel, demo = !process.env.MODEL_API_KEY, signal }) {
  const history = validateMessages(messages);
  const enabled = toolDefinitions.filter(t => config.enabledTools.includes(t.function.name));
  const trace = [];
  // 演示逻辑刻意与真实模型分开，不把模板输出伪装为 AI。
  if (demo) {
    const query = history.at(-1).content;
    if (config.enabledTools.includes('search_knowledge')) {
      const result = await executeTool('search_knowledge', { query });
      trace.push({ name: 'search_knowledge', args: { query }, result });
      return { mode: 'demo', trace, content: result.matches.length ? `【演示模式 · 非大模型回答】\n\n以下是知识库中与问题相关的原文：\n\n${result.matches.map(m => `• ${m.text}\n  来源：${m.source} 第 ${m.line} 行`).join('\n\n')}\n\n接入模型后，可由智能体结合这些资料组织回答并选择工具。` : '【演示模式 · 非大模型回答】\n\n知识库未找到匹配内容。你可以问“答辩需要提交哪些材料？”，或在 .env 配置模型后体验完整对话。' };
    }
    return { mode: 'demo', trace, content: '【演示模式】当前未启用知识库工具。配置模型后可开始智能对话。' };
  }
  const transcript = [{ role: 'system', content: config.systemPrompt }, ...history];
  for (let step = 0; step < 5; step++) {
    signal?.throwIfAborted();
    const reply = await model(transcript, enabled, { signal });
    if (!reply.tool_calls?.length) {
      if (typeof reply.content !== 'string' || !reply.content.trim()) throw new Error('模型返回了空回答');
      return { mode: 'live', content: reply.content, trace };
    }
    if (reply.tool_calls.length > 5) throw new Error('单轮工具调用过多，请缩小任务范围');
    transcript.push({ role: 'assistant', content: reply.content || null, tool_calls: reply.tool_calls });
    for (const call of reply.tool_calls) {
      let args, result;
      try {
        if (!enabled.some(t => t.function.name === call.function?.name)) throw new Error('工具未启用');
        args = JSON.parse(call.function.arguments);
        result = await executeTool(call.function.name, args);
      } catch (error) { result = { error: error.message }; }
      trace.push({ name: call.function?.name || 'unknown', args: args || {}, result });
      transcript.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error('达到 5 轮调用上限，请缩小任务范围后重试');
}
