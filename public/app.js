const $ = id => document.getElementById(id);
const storeKey = 'ark.sessions.v1';
let sessions = [];
let spaces = [];
try {
  const saved = JSON.parse(localStorage.getItem(storeKey) || '[]');
  if (Array.isArray(saved)) sessions = saved.filter(s => typeof s.id === 'string' && typeof s.title === 'string' && Array.isArray(s.messages)).slice(0, 200);
} catch { /* 损坏或禁用存储时使用临时会话。 */ }
let current, config, pending = false;
let activeRunId = null, eventSource = null, runTimer = null, reconnectTimer = null;
let renderedRun = null, renderedEventCount = -1;
const toolLabels = { search_knowledge: ['⌕', '资料检索', '搜索本地知识库'], create_checklist: ['☷', '任务清单', '将目标拆成行动步骤'], current_time: ['◷', '时间感知', '获取当前中国标准时间'] };
Object.assign(toolLabels, {propose_file:['▤','文件草稿','批准后才会写入'],list_space_files:['▦','空间文件','仅访问选定空间'],read_space_file:['▤','读取文件','仅访问选定空间']});
async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败'); return result;
}
async function loadSpaces() {
  spaces = (await api('/api/spaces')).spaces;
  $('space-select').replaceChildren(node('option', '未归类 · 无文件权限'));
  $('space-select').firstChild.value = '';
  for (const space of spaces) { const option = node('option',space.name); option.value = space.id; $('space-select').append(option); }
  $('space-select').value = current?.spaceId || '';
}
$('space-select').onchange = () => { if (pending) return; current.spaceId = $('space-select').value; save(); renderHistory(); };
$('chat-search').oninput = renderHistory;
function drawMap() {
  $('conversation-map').replaceChildren(); $('space-suggestions').replaceChildren();
  const transcript = current.messages.map(m=>m.content).join(' ');
  for (const space of spaces.filter(s=>s.id!==current.spaceId && s.name.length>1 && transcript.includes(s.name))) {
    const suggestion=node('button',`建议归入「${space.name}」`,'map-suggestion'); suggestion.onclick=()=>{current.spaceId=space.id;save();render();drawMap();}; $('space-suggestions').append(suggestion);
  }
  for (const space of [{id:'',name:'未归类'},...spaces]) {
    const group=node('section',undefined,'map-branch'); const matches=sessions.filter(s=>(s.spaceId||'')===space.id);
    group.append(node('h3',`${space.name} · ${matches.length} 个会话`));
    if (!matches.length) group.append(node('small','尚无会话，在对话上方选择此空间即可归类。'));
    for (const session of matches) {const button=node('button',session.title,'map-leaf');button.disabled=pending;button.onclick=()=>{current=session;$('organizer-dialog').close();render();};group.append(button);}
    $('conversation-map').append(group);
  }
}
$('organize').onclick=async()=>{$('organizer-dialog').showModal();try{await loadSpaces();drawMap();}catch(error){$('organizer-status').textContent=error.message;}};
$('compact-organize').onclick=()=>$('organize').click();
$('close-organizer').onclick=()=>$('organizer-dialog').close();
$('create-space-form').onsubmit=async event=>{event.preventDefault();try{const space=await api('/api/spaces',{name:$('space-name').value});current.spaceId=space.id;save();$('space-name').value='';$('organizer-status').textContent='主题空间已创建。文件写入仍需要逐文件批准。';await loadSpaces();drawMap();render();}catch(error){$('organizer-status').textContent=error.message;}};
$('close-files').onclick=()=>$('files-dialog').close();
$('space-files').onclick=async()=>{
  const scope=current.spaceId;
  $('files-dialog').showModal();$('file-preview').textContent='';$('files-list').replaceChildren();$('folder-location').replaceChildren();$('file-actions').replaceChildren();$('markdown-preview').replaceChildren();$('selected-file').textContent='选择一个文件查看';
  if(!current.spaceId){$('files-list').textContent='请先选择或创建主题空间。';return;}
  try{const {files,directory}=await api(`/api/spaces/${scope}/files`);$('folder-location').append(node('p',`本机保存目录：${directory}`),copyButton(directory,'复制目录路径'));if(!files.length)$('files-list').textContent='这里还没有文件。生成草稿并批准后，文件会显示在这里。';
    for(const file of files){const button=node('button',`${file.name} · ${file.bytes} B`,'map-leaf');button.onclick=async()=>{try{
      const data=await api(`/api/spaces/${scope}/read`,{name:file.name});$('selected-file').textContent=data.name;$('file-preview').textContent=data.content;$('file-preview').hidden=true;$('markdown-preview').hidden=false;$('markdown-preview').replaceChildren(/\.(md|markdown)$/i.test(data.name)?formattedText(data.content):node('pre',data.content));$('file-actions').replaceChildren();
      const preview=node('button','阅读预览','copy-button');preview.onclick=()=>{$('markdown-preview').hidden=false;$('file-preview').hidden=true;};
      const source=node('button','查看源码','copy-button');source.onclick=()=>{$('markdown-preview').hidden=true;$('file-preview').hidden=false;};
      const download=node('button','下载 / 另存副本','copy-button');download.onclick=()=>{const url=URL.createObjectURL(new Blob([data.content],{type:'text/plain;charset=utf-8'}));const link=node('a');link.href=url;link.download=data.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
      $('file-actions').append(preview,source,copyButton(data.path,'复制文件路径'),download);
    }catch(error){$('markdown-preview').textContent=error.message;}};$('files-list').append(button);}
  }catch(error){$('files-list').textContent=error.message;}
};
document.querySelector('.inspector').prepend($('run-console'));
$('toggle-panel').onclick = () => { const open = document.body.classList.toggle('panel-open'); $('toggle-panel').setAttribute('aria-expanded', String(open)); };
$('show-history').onclick = () => { renderHistory(); $('history-dialog').showModal(); };
$('close-history').onclick = () => $('history-dialog').close();
function copyButton(text, label = '复制') {
  const button = node('button', label, 'copy-button'); button.type = 'button';
  button.onclick = async () => { try { await navigator.clipboard.writeText(text); button.textContent = '已复制'; } catch { button.textContent = '复制失败，请手动选择'; } };
  return button;
}
function formattedText(text) {
  const container = node('div', undefined, 'formatted-text');
  let code = null, buffer = [];
  const lines=text.split('\n');
  const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(cell=>cell.trim());
  for (let index=0;index<lines.length;index++) {
    const line=lines[index];
    if (line.trimStart().startsWith('```')) {
      if (code) { code.append(node('pre', buffer.join('\n')), copyButton(buffer.join('\n'), '复制代码')); container.append(code); code = null; buffer = []; }
      else code = node('div', undefined, 'code-block');
      continue;
    }
    if (code) { buffer.push(line); continue; }
    if(line.includes('|') && index+1<lines.length && cells(lines[index+1]).length>1 && cells(lines[index+1]).every(cell=>/^:?-{3,}:?$/.test(cell))){
      const wrap=node('div',undefined,'table-scroll'), table=node('table'),head=node('thead'),header=node('tr');
      for(const cell of cells(line))header.append(node('th',cell));head.append(header);table.append(head);const body=node('tbody');index++;
      while(index+1<lines.length && lines[index+1].includes('|') && lines[index+1].trim()) {const row=node('tr');for(const cell of cells(lines[++index]))row.append(node('td',cell));body.append(row);}
      table.append(body);wrap.append(table);container.append(wrap);continue;
    }
    if(/^\s*(---+|\*\*\*+)\s*$/.test(line)){container.append(node('hr'));continue;}
    if (!line.trim()) { container.append(node('div', undefined, 'text-gap')); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const list = line.match(/^(?:[-*•]|\d+[.)、])\s+(.+)$/);
    const block = node(heading ? `h${heading[1].length}` : 'p', undefined, list ? 'text-list-item' : line.startsWith('> ') ? 'text-quote' : '');
    const content = heading ? heading[2] : list ? list[1] : line.replace(/^> /,'');
    for (const part of content.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
      block.append(part.startsWith('**') && part.endsWith('**') ? node('strong', part.slice(2, -2)) : part.startsWith('`') && part.endsWith('`') ? node('code', part.slice(1, -1)) : document.createTextNode(part));
    }
    container.append(block);
  }
  if (code) { code.append(node('pre', buffer.join('\n'))); container.append(code); }
  return container;
}

function save() {
  try { localStorage.setItem(storeKey, JSON.stringify(sessions.slice(0, 200))); }
  catch { $('status').textContent = '浏览器存储不可用，本次记录仅在页面内保留。'; }
}
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function renderHistory() {
  $('history').replaceChildren();
  $('dialog-history').replaceChildren();
  for (const session of sessions) {
    const query = $('chat-search').value.trim().toLowerCase();
    if (query && ![session.title,...session.messages.map(m=>m.content)].join(' ').toLowerCase().includes(query)) continue;
    const button = node('button', session.title, `history-item${session.id === current.id ? ' active' : ''}`);
    button.disabled = pending;
    button.onclick = () => { current = session; $('status').textContent = ''; render(); };
    $('history').append(button);
    const mobileButton = node('button', session.title, button.className); mobileButton.disabled = pending;
    mobileButton.onclick = () => { current = session; $('history-dialog').close(); $('status').textContent = ''; render(); };
    $('dialog-history').append(mobileButton);
  }
}
function render() {
  renderHistory();
  $('space-select').value = current.spaceId || '';
  renderRun();
  $('intro').hidden = current.messages.length > 0 || Boolean(current.lastRun);
  $('messages').replaceChildren();
  for (const message of current.messages) {
    const article = node('article', undefined, `message ${message.role}`);
    article.append(node('div', message.role === 'user' ? 'YOU / 你' : `ARK / ${message.mode === 'demo' ? '演示模式' : '智能体'}`, 'message-label'));
    const bubble = node('div', undefined, 'bubble');
    bubble.append(message.role === 'assistant' ? formattedText(message.content) : document.createTextNode(message.content)); article.append(bubble);
    if (message.role === 'assistant') article.append(copyButton(message.content, '复制回答'));
    if (message.role === 'assistant' && !message.trace?.some(t=>t.name==='propose_file' && !t.result?.error)) {
      const draftButton=node('button','将回答生成文件草稿','copy-button');
      draftButton.onclick=async()=>{
        if(!current.spaceId){$('status').textContent='请先在上方选择主题空间；也可以在会话地图中创建空间。';$('space-select').focus();return;}
        draftButton.disabled=true;
        try{const result=await api(`/api/spaces/${current.spaceId}/draft`,{name:`回答-${crypto.randomUUID().slice(0,8)}.md`,content:message.content});message.trace=message.trace||[];message.trace.push({name:'propose_file',args:{},result});save();render();}
        catch(error){$('status').textContent=error.message;draftButton.disabled=false;}
      };article.append(draftButton);
    }
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
  if (entry.name === 'propose_file') {
    card.append(node('strong',entry.result.name),node('p',entry.approvalStatus || '草稿：尚未写入。请检查完整内容后批准。'));
    const preview=node('pre',entry.result.content,'draft-preview');card.append(preview);
    if(entry.approvalStatus)return card;
    const scope = entry.result.spaceId;
    for(const [allow,label] of [[true,'批准并新建文件'],[false,'拒绝写入']]){
      const button=node('button',label,'approval-button');button.onclick=async()=>{button.disabled=true;try{const result=await api(`/api/spaces/${scope}/approve`,{approvalId:entry.result.approvalId,allow});entry.approvalStatus=result.status==='saved'?'已批准并保存到当前主题空间':'已拒绝，未写入文件';save();render();}catch(error){button.disabled=false;button.textContent=error.message;}};card.append(button);
    }
    return card;
  }
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
    const bar = node('progress'); bar.max = entry.result.items.length; bar.setAttribute('aria-label', '清单完成进度');
    const refresh = () => { const done = entry.result.items.filter(i => i.done).length; progress.textContent = `${done} / ${entry.result.items.length} 已完成`; bar.value = done; };
    refresh(); card.append(progress, bar);
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
  if (renderedRun !== run || renderedEventCount !== (run.events || []).length) {
    renderedRun = run; renderedEventCount = (run.events || []).length;
    $('timeline').replaceChildren();
    for (const event of run.events || []) {
    const item = node('li', undefined, `event-${event.type}`);
    item.append(node('span', eventLabel(event)), node('time', event.elapsedMs < 1000 ? `${event.elapsedMs}ms` : `${(event.elapsedMs / 1000).toFixed(2)}s`)); $('timeline').append(item);
    }
  }
  $('retry-run').hidden = pending || !['failed', 'cancelled', 'interrupted'].includes(run.status);
}
function newChat() {
  if (pending) return;
  current = { id: crypto.randomUUID(), title: '新的探索', messages: [] };
  sessions.unshift(current); sessions = sessions.slice(0, 200); save(); render(); $('status').textContent = ''; $('prompt').focus();
}
async function send(event) {
  event.preventDefault();
  const content = $('prompt').value.trim();
  if (!content || pending || !config) return;
  if (current.messages.length >= 40) { $('status').textContent = '本次会话已达上限，请新建会话。'; return; }
  const requestMessages = [...current.messages.map(({ role, content }) => ({ role, content })), { role: 'user', content }];
  pending = true; $('send').disabled = true; $('new-chat').disabled = true; $('compact-new').disabled = true; $('prompt').disabled = true;
  $('space-select').disabled=true; $('organize').disabled=true; $('compact-organize').disabled=true;
  $('model-settings').disabled = true; $('stop-run').hidden = false; $('stop-run').disabled = true;
  current.lastRun = { status: 'connecting', prompt: content, events: [], elapsedMs: 0, modelCalls: 0, toolCalls: 0 };
  if (matchMedia('(max-width:900px)').matches) { document.body.classList.add('panel-open'); $('toggle-panel').setAttribute('aria-expanded', 'true'); }
  const run = current.lastRun;
  const started = performance.now();
  runTimer = setInterval(() => { run.elapsedMs = performance.now() - started; renderRun(); }, 100);
  current.messages.push({ role: 'user', content });
  if (current.messages.length === 1) current.title = content.slice(0, 24);
  $('prompt').value = ''; render(); save(); $('status').textContent = config.mode === 'demo' ? '正在检索本地资料…' : '智能体正在处理，可能需要调用工具…';
  $('run-console').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const response = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: requestMessages, spaceId: current.spaceId || null }), signal: AbortSignal.timeout(15000) });
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
    $('space-select').disabled=false; $('organize').disabled=false; $('compact-organize').disabled=false;
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
    $('status').textContent = result.hasKey ? '配置已保存在本机，重启自动加载。首次发送消息时验证连接。' : '已切回演示模式，并清除已保存的密钥。';
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
loadSpaces().catch(error=>{$('status').textContent=`主题空间不可用：${error.message}。请重启后端。`;});
