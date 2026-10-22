import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const knowledgeDirectory = fileURLToPath(new URL('../knowledge/', import.meta.url));

export const toolDefinitions = [
  { type: 'function', function: { name: 'search_knowledge', description: '搜索本地知识库，返回相关原文及来源文件名。', parameters: { type: 'object', properties: { query: { type: 'string', description: '检索词或问题' } }, required: ['query'], additionalProperties: false } } },
  { type: 'function', function: { name: 'create_checklist', description: '把任务整理成可以勾选的清单。只生成清单，不执行清单中的任务。', parameters: { type: 'object', properties: { title: { type: 'string' }, items: { type: 'array', items: { type: 'string' }, maxItems: 20 } }, required: ['title', 'items'], additionalProperties: false } } },
  { type: 'function', function: { name: 'current_time', description: '获取中国标准时间。', parameters: { type: 'object', properties: {}, additionalProperties: false } } }
];

export async function searchKnowledge(query, directory = knowledgeDirectory) {
  if (typeof query !== 'string' || !query.trim() || query.length > 1000) throw new Error('检索词需要是 1—1000 字的文本');
  const normalized = query.toLowerCase();
  const tokens = [...new Set(normalized.match(/[a-z0-9]+|[\u4e00-\u9fff]{1,2}/g) || [])];
  const matches = [];
  for (const file of (await readdir(directory)).sort()) {
    if (!/\.(md|txt)$/i.test(file)) continue;
    const content = (await readFile(`${directory}/${file}`, 'utf8')).slice(0, 100000);
    for (const [index, paragraph] of content.split(/\r?\n/).entries()) {
      const lower = paragraph.toLowerCase();
      const score = tokens.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
      if (score) matches.push({ source: file, line: index + 1, text: paragraph.slice(0, 1800), score });
    }
  }
  return { matches: matches.sort((a, b) => b.score - a.score).slice(0, 5), method: '本地关键词检索（非语义检索）' };
}

export async function executeTool(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须为对象');
  switch (name) {
    case 'search_knowledge': return searchKnowledge(args.query);
    case 'current_time': return { time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }), timezone: 'Asia/Shanghai' };
    case 'create_checklist': {
      if (typeof args.title !== 'string' || args.title.length > 100 || !Array.isArray(args.items) || !args.items.length || args.items.length > 20 || args.items.some(item => typeof item !== 'string' || !item.trim() || item.length > 500)) throw new Error('清单需要标题和 1—20 条有效任务');
      return { title: args.title, items: args.items.map(text => ({ text, done: false })) };
    }
    default: throw new Error('未知工具');
  }
}
