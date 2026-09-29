// 星谱识音 - 本地静态服务器（绿色版）
// 只依赖 Node 内置模块，不需要 npm install。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', 'dist');
const startPort = Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error('未找到 dist/index.html，请先运行「构建-绿色版.bat」。');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(root, urlPath));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(root, 'index.html'), (e2, d2) => {
        if (e2) {
          res.writeHead(404);
          res.end('Not Found');
        } else {
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(d2);
        }
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

function openBrowser(url) {
  if (process.env.NO_OPEN) return; // 测试时可跳过
  try {
    const platform = process.platform;
    if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 忽略：用户可手动打开 */
  }
}

function listen(port, tries = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 20) {
      listen(port + 1, tries + 1);
    } else {
      console.error(e);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + port + '/';
    // 控制台按 CP936 显示，用 ASCII 避免乱码
    console.log('');
    console.log('  [StarScore] Service started');
    console.log('  URL: ' + url);
    console.log('  Press Ctrl+C to exit');
    console.log('');
    openBrowser(url);
  });
}

listen(startPort);
