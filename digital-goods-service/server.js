import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {handleApi, securityHeaders} from './src/api.js';
const root = path.dirname(fileURLToPath(import.meta.url));
export function createServer(env, fetcher = fetch) {
  return http.createServer(async (req, res) => {
    try {
      const base = env.PUBLIC_ORIGIN || `http://${req.headers.host}`;
      const url = new URL(req.url, base);
      if (url.pathname.startsWith('/api/')) {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 512000) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
        const request = new Request(url, {method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks)});
        const response = await handleApi(request, env, fetcher);
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return;
      }
      const files = {'/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css']};
      const file = files[url.pathname];
      if (!file || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {...securityHeaders, 'Content-Type': `${file[1]}; charset=utf-8`});
      res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(root, 'public', file[0])));
    } catch { res.writeHead(500); res.end('Ошибка сервиса'); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
  const env = {...process.env};
  const demo = process.argv.includes('--demo');
  if (demo) env.DEMO = 'true';
  env.YANDEX_BUSINESS_ID ||= '216918278'; env.YANDEX_CAMPAIGN_ID ||= '149189839';
  if (env.NODE_ENV === 'production') env.REQUIRE_PASSWORD = 'true';
  if (demo && env.NODE_ENV === 'production') throw new Error('Демо доступно только локально.');
  const fetcher = demo ? (await import('./test/fixtures.js')).makeMarketMock().fetcher : fetch;
  const port = Number(env.PORT || 3210), host = demo ? '127.0.0.1' : env.HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost') env.REQUIRE_PASSWORD = 'true';
  const server = createServer(env, fetcher);
  server.listen(port, host, () => {
    console.log(`Сервис: http://localhost:${port}${demo ? ' — ДЕМО, данные вымышленные' : ''}`);
    if (process.argv.includes('--open') && process.platform === 'win32') {
      const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process 'http://localhost:${port}'`], {detached: true, stdio: 'ignore', windowsHide: true}); child.unref();
    }
  });
  server.on('error', () => { console.error('Не удалось запустить сервис. Возможно, порт уже занят.'); process.exitCode = 1; });
}
