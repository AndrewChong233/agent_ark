import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { runAgent } from './src/engine.mjs';
import { validateModelSettings, publicModelSettings } from './src/model-settings.mjs';

const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
let busy = 0;
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100000) throw new Error('请求过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求不是有效的 JSON'); }
}

export const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${req.headers.host}`).hostname)) return json(res, 403, { error: '当前开发版本只支持本机访问' });
    if (req.method === 'POST') {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: '不允许跨站请求' });
      if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '需要 application/json' });
    }
    if (pathname === '/api/model' && req.method === 'GET') return json(res, 200, publicModelSettings());
    if (pathname === '/api/model' && req.method === 'POST') {
      const peer = req.socket.remoteAddress;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) return json(res, 403, { error: '模型配置只允许本机修改' });
      if (busy) return json(res, 409, { error: '请等待当前对话完成再修改模型' });
      const input = await body(req);
      if (busy) return json(res, 409, { error: '请等待当前对话完成再修改模型' });
      if (input.action === 'demo') process.env.MODEL_API_KEY = '';
      else {
        const settings = validateModelSettings(input, process.env.MODEL_API_KEY || '');
        process.env.MODEL_BASE_URL = settings.baseUrl;
        process.env.MODEL_NAME = settings.model;
        process.env.MODEL_API_KEY = settings.apiKey;
      }
      return json(res, 200, publicModelSettings());
    }
    if (req.method === 'GET' && pathname === '/api/config') {
      const config = JSON.parse(await readFile(new URL('./agent.config.json', import.meta.url), 'utf8'));
      const { name, theme, description, welcome, starters, enabledTools } = config;
      return json(res, 200, { name, theme, description, welcome, starters, enabledTools, mode: process.env.MODEL_API_KEY ? 'live' : 'demo' });
    }
    if (req.method === 'POST' && pathname === '/api/chat') {
      if (busy >= 3) return json(res, 429, { error: '当前任务较多，请稍后再试' });
      const input = await body(req);
      const config = JSON.parse(await readFile(new URL('./agent.config.json', import.meta.url), 'utf8'));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      res.on('close', () => controller.abort());
      busy++;
      try { return json(res, 200, await runAgent({ messages: input.messages, config, signal: controller.signal })); }
      finally { busy--; clearTimeout(timer); }
    }
    if (req.method === 'GET' && assets[pathname]) {
      const [file, type] = assets[pathname];
      const data = await readFile(new URL(`./public/${file}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      return res.end(data);
    }
    json(res, 404, { error: '页面不存在' });
  } catch (error) { if (!res.destroyed) json(res, 400, { error: error.message || '请求处理失败' }); }
});

server.requestTimeout = 150000;
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log(`ARK 已启动：http://${process.env.HOST || '127.0.0.1'}:${server.address().port}`));
