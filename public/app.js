const $ = id => document.getElementById(id);
const storeKey = 'ark.sessions.v1';
let sessions = [];
try {
  const saved = JSON.parse(localStorage.getItem(storeKey) || '[]');
  if (Array.isArray(saved)) sessions = saved.filter(s => typeof s.id === 'string' && typeof s.title === 'string' && Array.isArray(s.messages)).slice(0, 20);
} catch { /* 损坏或禁用存储时使用临时会话。 */ }
let current, config, pending = false;
let activeRunId = null, eventSource = null, runTimer = null, reconnectTimer = null;
const toolLabels = { search_knowledge: ['⌕', '资料检索', '搜索本地知识库'], create_checklist: ['☷', '任务清单', '将目标拆成行动步骤'], current_time: ['◷', '时间感知', '获取当前中国标准时间'] };

function save() {
  try { localStorage.setItem(storeKey, JSON.stringify(sessions.slice(0, 20))); }
  catch { $('status').textContent = '浏览器存储不可用，本次记录仅在页面内保留。'; }
}
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function renderHistory() {
  $('history').replaceChildren();
  for (const session of sessions) {
    const button = node('button', session.title, `history-item${session.id === current.id ? ' active' : ''}`);
    button.disabled = pending;
    button.onclick = () => { current = session; $('status').textContent = ''; render(); };
    $('history').append(button);
  }
}
function render() {
  renderHistory();
  renderRun();
  $('intro').hidden = current.messages.length > 0 || Boolean(current.lastRun);
  $('messages').replaceChildren();
  for (const message of current.messages) {
    const article = node('article', undefined, `message ${message.role}`);
    article.append(node('div', message.role === 'user' ? 'YOU / 你' : `ARK / ${message.mode === 'demo' ? '演示模式' : '智能体'}`, 'message-label'));
    article.append(node('div', message.content, 'bubble'));
    if (message.trace?.length) {
      for (const entry of message.trace) article.append(toolCard(entry));
      const details = node('details', undefined, 'trace');
      details.append(node('summary', `${message.trace.length} 次工具调用 · 原始记录`));
      for (const entry of message.trace) {
        details.append(node('strong', toolLabels[entry.name]?.[1] || entry.name));
        details.append(node('pre', JSON.stringify({ 参数: entry.args, 结果: entry.result }, null, 2)));
      }
      article.append(details);
    }
    $('messages').append(article);
  }
}
function toolCard(entry) {
  const card = node('section', undefined, `result-card${entry.result?.error ? ' result-error' : ''}`);
  const title = toolLabels[entry.name]?.[1] || entry.name;
  card.append(node('div', `${toolLabels[entry.name]?.[0] || '◇'}  ${title}`, 'result-title'));
  if (entry.result?.error) { card.append(node('p', entry.result.error)); return card; }
  if (entry.name === 'search_knowledge') {
    const matches = entry.result?.matches || [];
    card.append(node('small', `找到 ${matches.length} 条相关资料 · 关键词检索`));
    for (const match of matches) {
      const source = node('div', undefined, 'source-item');
      source.append(node('span', `${match.source} · 第 ${match.line} 行`, 'source-label'), node('p', match.text)); card.append(source);
    }
    if (!matches.length) card.append(node('p', '暂无匹配资料，可以调整检索词或补充知识库。'));
  } else if (entry.name === 'create_checklist' && entry.result?.items) {
    card.append(node('strong', entry.result.title));
    const progress = node('small', undefined, 'check-progress');
    const refresh = () => { progress.textContent = `${entry.result.items.filter(i => i.done).length} / ${entry.result.items.length} 已完成`; };
    refresh(); card.append(progress);
    for (const item of entry.result.items) {
      const label = node('label', undefined, 'task-item'); const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = item.done;
      checkbox.onchange = () => { item.done = checkbox.checked; refresh(); save(); };
      label.append(checkbox, node('span', item.text)); card.append(label);
    }
  } else if (entry.name === 'current_time') {
    card.append(node('p', entry.result.time), node('small', entry.result.timezone));
  } else card.append(node('pre', JSON.stringify(entry.result, null, 2)));
  return card;
}
const runStates = { connecting: '正在建立任务', running: '任务执行中', completed: '任务已完成', failed: '任务未完成', cancelled: '任务已停止', interrupted: '连接已中断' };
function eventLabel(event) {
  const data = event.data || {}; const name = toolLabels[data.name]?.[1] || data.name;
  return ({ started: data.mode === 'demo' ? '任务开始 · 演示模式' : '任务开始 · 模型模式', demo: '本地演示 · 不调用模型', model_start: `第 ${data.step} 次模型请求`, model_end: `第 ${data.step} 次模型响应已收到`, tool_start: `开始执行：${name}`, tool_end: `${data.result?.error ? '执行出错' : '执行完成'}：${name}`, completed: '任务完成', failed: data.message, cancelled: '任务已停止' })[event.type] || event.type;
}
function renderRun() {
  const run = current?.lastRun; $('run-console').hidden = !run; if (!run) return;
  $('run-console').dataset.state = run.status;
  $('run-state').textContent = runStates[run.status] || run.status;
  $('run-indicator').textContent = ({ connecting: '连接中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '已断开' })[run.status] || '';
  $('run-duration').textContent = (run.elapsedMs || 0) < 1 ? '<1ms' : run.elapsedMs < 1000 ? `${Math.round(run.elapsedMs)}ms` : `${(run.elapsedMs / 1000).toFixed(1)}s`;
  $('run-model-count').textContent = run.modelCalls || 0;
  $('run-tool-count').textContent = run.toolCalls || 0;
  $('timeline').replaceChildren();
  for (const event of run.events || []) {
    const item = node('li', undefined, `event-${event.type}`);
    item.append(node('span', eventLabel(event)), node('time', event.elapsedMs < 1000 ? `${event.elapsedMs}ms` : `${(event.elapsedMs / 1000).toFixed(2)}s`)); $('timeline').append(item);
  }
  $('retry-run').hidden = pending || !['failed', 'cancelled', 'interrupted'].includes(run.status);
}
function newChat() {
  if (pending) return;
  current = { id: crypto.randomUUID(), title: '新的探索', messages: [] };
  sessions.unshift(current); sessions = sessions.slice(0, 20); save(); render(); $('status').textContent = ''; $('prompt').focus();
}
async function send(event) {
  event.preventDefault();
  const content = $('prompt').value.trim();
  if (!content || pending || !config) return;
  if (current.messages.length >= 40) { $('status').textContent = '本次会话已达上限，请新建会话。'; return; }
  const requestMessages = [...current.messages.map(({ role, content }) => ({ role, content })), { role: 'user', content }];
  pending = true; $('send').disabled = true; $('new-chat').disabled = true; $('compact-new').disabled = true; $('prompt').disabled = true;
  $('model-settings').disabled = true; $('stop-run').hidden = false; $('stop-run').disabled = true;
  current.lastRun = { status: 'connecting', prompt: content, events: [], elapsedMs: 0, modelCalls: 0, toolCalls: 0 };
  const run = current.lastRun;
  const started = performance.now();
  runTimer = setInterval(() => { run.elapsedMs = performance.now() - started; renderRun(); }, 100);
  current.messages.push({ role: 'user', content });
  if (current.messages.length === 1) current.title = content.slice(0, 24);
  $('prompt').value = ''; render(); save(); $('status').textContent = config.mode === 'demo' ? '正在检索本地资料…' : '智能体正在处理，可能需要调用工具…';
  $('run-console').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const response = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: requestMessages }), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '请求失败');
    activeRunId = result.runId; run.runId = result.runId; run.status = 'running'; save(); $('stop-run').disabled = false;
    await new Promise((resolve, reject) => {
      eventSource = new EventSource(`/api/runs/${encodeURIComponent(activeRunId)}/events`);
      eventSource.onmessage = message => {
        clearTimeout(reconnectTimer);
        try {
          const event = JSON.parse(message.data);
          if (run.events.some(old => old.seq === event.seq)) return;
          run.events.push(event); run.elapsedMs = event.elapsedMs;
          if (event.type === 'model_start') run.modelCalls++;
          if (event.type === 'tool_start') run.toolCalls++;
          $('status').textContent = eventLabel(event); renderRun();
          if (['completed', 'failed', 'cancelled'].includes(event.type)) {
            eventSource.close(); clearInterval(runTimer); run.status = event.type; run.elapsedMs = event.elapsedMs;
            if (event.type === 'completed') { current.messages.push({ role: 'assistant', ...event.data }); resolve(); }
            else reject(new Error(event.data.message || '任务已停止'));
          }
        } catch (error) { eventSource.close(); reject(error); }
      };
      eventSource.onerror = () => {
        $('status').textContent = '事件连接中断，正在尝试恢复…';
        if (!reconnectTimer) reconnectTimer = setTimeout(() => {
          eventSource.close(); run.status = 'interrupted';
          fetch(`/api/runs/${encodeURIComponent(activeRunId)}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
          reject(new Error('无法恢复事件连接，请确认后端仍在运行'));
        }, 12000);
      };
      eventSource.onopen = () => { clearTimeout(reconnectTimer); reconnectTimer = null; };
    });
    save(); $('status').textContent = '任务完成，可查看执行记录和工具结果。';
  } catch (error) {
    if (['connecting', 'running'].includes(run.status)) run.status = 'failed';
    current.messages.pop(); $('prompt').value = content; save();
    $('status').textContent = `${error.message}。输入已保留，可重试。`;
  } finally {
    eventSource?.close(); eventSource = null; activeRunId = null; clearInterval(runTimer); clearTimeout(reconnectTimer); reconnectTimer = null;
    $('stop-run').hidden = true; $('model-settings').disabled = false;
    pending = false; $('send').disabled = false; $('new-chat').disabled = false; $('compact-new').disabled = false; $('prompt').disabled = false; render(); $('prompt').focus();
    $('messages').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
$('stop-run').onclick = async () => {
  if (!activeRunId) return;
  $('stop-run').disabled = true; $('status').textContent = '正在请求后端停止任务…';
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(activeRunId)}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('停止请求失败');
  } catch (error) { $('status').textContent = `${error.message}，可再次尝试停止。`; $('stop-run').disabled = false; }
};
$('retry-run').onclick = () => { if (!pending && current.lastRun) { $('prompt').value = current.lastRun.prompt; $('composer').requestSubmit(); } };
$('composer').onsubmit = send;
$('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } };
$('new-chat').onclick = newChat;
$('compact-new').onclick = newChat;
$('export').onclick = () => {
  const data = { project: config?.name, theme: config?.theme, exportedAt: new Date().toISOString(), ...current };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = node('a'); a.href = url; a.download = `ark-session-${current.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('compact-export').onclick = () => $('export').click();
function updateMode(live) {
  if (config) config.mode = live ? 'live' : 'demo';
  $('mode').textContent = live ? '● 模型已配置' : '◌ 演示模式 · 未接入模型';
  $('mode').classList.toggle('live', live);
}
$('model-settings').onclick = async () => {
  $('settings-status').textContent = '正在读取配置…';
  $('model-key').value = '';
  $('settings-dialog').showModal();
  try {
    const response = await fetch('/api/model');
    const settings = await response.json();
    if (!response.ok) throw new Error(settings.error || '配置读取失败');
    $('model-url').value = settings.baseUrl;
    $('model-name').value = settings.model;
    $('model-key').placeholder = settings.hasKey ? '已配置密钥；留空保留，填写则替换' : '输入密钥';
    $('model-key').required = !settings.hasKey;
    $('settings-status').textContent = '';
  } catch (error) { $('settings-status').textContent = error.message; }
};
$('close-settings').onclick = () => $('settings-dialog').close();
$('settings-dialog').addEventListener('close', () => { $('model-key').value = ''; });
async function saveModel(action) {
  $('save-settings').disabled = true; $('use-demo').disabled = true;
  $('settings-status').textContent = '正在保存…';
  try {
    const payload = action === 'demo' ? { action } : { baseUrl: $('model-url').value, model: $('model-name').value, apiKey: $('model-key').value };
    const response = await fetch('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '保存失败');
    updateMode(result.hasKey); $('settings-dialog').close();
    $('status').textContent = result.hasKey ? '配置已保存到服务内存，首次发送消息时验证连接。' : '已切回演示模式。';
  } catch (error) { $('settings-status').textContent = error.message; }
  finally { $('save-settings').disabled = false; $('use-demo').disabled = false; }
}
$('settings-form').onsubmit = event => { event.preventDefault(); saveModel('save'); };
$('use-demo').onclick = () => saveModel('demo');
async function init() {
  try {
    const response = await fetch('/api/config'); if (!response.ok) throw new Error('配置加载失败'); config = await response.json();
    document.title = config.name; $('agent-name').textContent = config.name; $('theme').textContent = config.theme; $('description').textContent = config.description;
    $('mode').textContent = config.mode === 'demo' ? '◌ 演示模式 · 未接入模型' : '● 模型已配置'; $('mode').classList.toggle('live', config.mode === 'live');
    for (const text of config.starters) { const button = node('button', text); button.onclick = () => { $('prompt').value = text; $('prompt').focus(); }; $('starters').append(button); }
    for (const name of config.enabledTools) {
      const [icon, title, description] = toolLabels[name] || ['◇', name, '自定义业务工具'];
      const item = node('div', undefined, 'tool'); const body = node('div'); body.append(node('strong', title), node('small', description)); item.append(node('span', icon, 'tool-icon'), body); $('tools').append(item);
    }
  } catch (error) { $('mode').textContent = '连接失败'; $('status').textContent = `${error.message}，请刷新页面重试。`; $('send').disabled = true; }
}
for (const session of sessions) if (['connecting', 'running'].includes(session.lastRun?.status)) {
  session.lastRun.status = 'interrupted';
  if (session.messages.at(-1)?.role === 'user') session.messages.pop();
  if (session.lastRun.runId) fetch(`/api/runs/${encodeURIComponent(session.lastRun.runId)}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
}
if (sessions.length) { current = sessions[0]; render(); } else newChat();
init();
