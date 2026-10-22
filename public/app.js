const $ = id => document.getElementById(id);
const storeKey = 'ark.sessions.v1';
let sessions = [];
try {
  const saved = JSON.parse(localStorage.getItem(storeKey) || '[]');
  if (Array.isArray(saved)) sessions = saved.filter(s => typeof s.id === 'string' && typeof s.title === 'string' && Array.isArray(s.messages)).slice(0, 20);
} catch { /* 损坏或禁用存储时使用临时会话。 */ }
let current, config, pending = false;
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
  $('intro').hidden = current.messages.length > 0;
  $('messages').replaceChildren();
  for (const message of current.messages) {
    const article = node('article', undefined, `message ${message.role}`);
    article.append(node('div', message.role === 'user' ? 'YOU / 你' : `ARK / ${message.mode === 'demo' ? '演示模式' : '智能体'}`, 'message-label'));
    article.append(node('div', message.content, 'bubble'));
    if (message.trace?.length) {
      const details = node('details', undefined, 'trace');
      details.append(node('summary', `${message.trace.length} 次工具调用 · 查看依据`));
      for (const entry of message.trace) {
        details.append(node('strong', toolLabels[entry.name]?.[1] || entry.name));
        details.append(node('pre', JSON.stringify({ 参数: entry.args, 结果: entry.result }, null, 2)));
        if (entry.name === 'create_checklist' && entry.result?.items) {
          const checklist = node('div', undefined, 'checklist');
          checklist.append(node('strong', entry.result.title));
          for (const item of entry.result.items) {
            const label = node('label'); const check = node('input'); check.type = 'checkbox'; check.checked = item.done;
            check.onchange = () => { item.done = check.checked; save(); };
            label.append(check, node('span', item.text)); checklist.append(label);
          }
          article.append(checklist);
        }
      }
      article.append(details);
    }
    $('messages').append(article);
  }
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
  current.messages.push({ role: 'user', content });
  if (current.messages.length === 1) current.title = content.slice(0, 24);
  $('prompt').value = ''; render(); save(); $('status').textContent = config.mode === 'demo' ? '正在检索本地资料…' : '智能体正在处理，可能需要调用工具…';
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: requestMessages }), signal: AbortSignal.timeout(130000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '请求失败');
    current.messages.push({ role: 'assistant', ...result }); save(); $('status').textContent = '';
  } catch (error) {
    current.messages.pop(); $('prompt').value = content; save();
    $('status').textContent = `未完成：${error.message}。输入已保留，可重试。`;
  } finally {
    pending = false; $('send').disabled = false; $('new-chat').disabled = false; $('compact-new').disabled = false; $('prompt').disabled = false; render(); $('prompt').focus();
    $('composer').scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
}
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
if (sessions.length) { current = sessions[0]; render(); } else newChat();
init();
