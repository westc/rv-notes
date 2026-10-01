// Serves the app on http://localhost:8787 and answers /exec with the real
// Code.gs running on fake Sheets, for trying the app without deploying.
//
//   npm run serve           then open the connect link it prints
//   POST /__offline?on=1    makes every request fail, like losing internet
//   POST /__offline?on=0    goes back online
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackend, post } from './fake-apps-script.js';

const PORT = Number(process.env.PORT || 8787);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'a'.repeat(32) + 'b'.repeat(32);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

// /exec is one spreadsheet. /s/<name>/exec are others, for trying more than
// one connection.
const backends = new Map();
function backendFor(name) {
  if (!backends.has(name)) backends.set(name, loadBackend({ apiKey: KEY }));
  return backends.get(name);
}
let offline = false;

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/__offline' && req.method === 'POST') {
    offline = url.searchParams.get('on') === '1';
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }).end(offline ? 'offline' : 'online');
    return;
  }
  if (offline) {
    req.socket.destroy();
    return;
  }

  const execMatch = /^(?:\/s\/([\w-]+))?\/exec$/.exec(url.pathname);
  if (execMatch && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const result = post(backendFor(execMatch[1] || ''), body);
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    }, Number(process.env.DELAY || 300));
    return;
  }

  const path = normalize(join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
  if (!path.startsWith(ROOT) || /node_modules|\.git/.test(path)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (err) {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => {
  const payload = Buffer.from(JSON.stringify({ u: `http://localhost:${PORT}/exec`, k: KEY, n: 'Test RVs' })).toString('base64url');
  console.log(`RV Notes: http://localhost:${PORT}/`);
  console.log(`Connect link: http://localhost:${PORT}/#connect=${payload}`);
  const second = Buffer.from(JSON.stringify({ u: `http://localhost:${PORT}/s/second/exec`, k: KEY, n: 'Second RVs' })).toString('base64url');
  console.log(`Second spreadsheet: http://localhost:${PORT}/#connect=${second}`);
});
