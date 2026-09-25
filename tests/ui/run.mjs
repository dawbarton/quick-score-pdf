// Front-end tests: serves ui/ with the Tauri bridge replaced by stub.js, loads it in headless
// Chrome, and runs each tests/ui/cases/*.js in a freshly loaded page.
//
//   node tests/ui/run.mjs [name-substring]      (CHROME=/path/to/chrome to override)
//
// A case file is one async arrow function returning { ok, ...details }. Any console error or
// uncaught exception fails the case unless the file contains "allow-console-errors".
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePdfs } from './make-pdfs.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const uiDir = join(here, '../../ui');
const pdfDir = join(here, 'pdfs');
const chromePath = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!existsSync(chromePath)) {
  console.error(`Chrome not found at ${chromePath}; set CHROME to its path`);
  process.exit(2);
}
makePdfs(pdfDir);

// ── Static server ─────────────────────────────────────────────────────────────
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
                '.css': 'text/css', '.pdf': 'application/pdf' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '');
  let body, file;
  if (path === '' || path === 'index.html') {
    body = readFileSync(join(uiDir, 'index.html'), 'utf8')
      .replace('<script type="module" src="main.js">', '<script src="stub.js"></script>\n$&');
    file = 'index.html';
  } else {
    file = path === 'stub.js' ? join(here, 'stub.js')
         : path.startsWith('pdfs/') ? join(pdfDir, path.slice(5))
         : join(uiDir, path);
    if (path.includes('..') || !existsSync(file)) { res.writeHead(404).end(); return; }
    body = readFileSync(file);
  }
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ── Chrome over the DevTools protocol ─────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'qsp-chrome-'));
const port = 9300 + Math.floor(Math.random() * 600);
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });

let targets;
for (let i = 0; i < 100 && !targets; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(100); }
}
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);

let nextId = 0, consoleErrors = [], onLoad = null;
const pending = new Map();
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (d.id) { pending.get(d.id)?.(d); pending.delete(d.id); return; }
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error')
    consoleErrors.push(d.params.args.map(a => a.value ?? a.description).join(' '));
  if (d.method === 'Runtime.exceptionThrown')
    consoleErrors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
  if (d.method === 'Page.loadEventFired') onLoad?.();
};
const send = (method, params = {}) => new Promise(r => {
  const id = ++nextId;
  pending.set(id, r);
  ws.send(JSON.stringify({ id, method, params }));
});
await send('Runtime.enable');
await send('Page.enable');

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'evaluation failed');
  return res.result.result.value;
}

// ── Cases ─────────────────────────────────────────────────────────────────────
const filter = process.argv[2] ?? '';
const cases = readdirSync(join(here, 'cases')).filter(f => f.endsWith('.js') && f.includes(filter)).sort();
let failures = 0;
for (const name of cases) {
  const src = readFileSync(join(here, 'cases', name), 'utf8');
  consoleErrors = [];
  const loaded = new Promise(r => onLoad = r);
  await send('Page.navigate', { url: `${origin}/index.html` });
  await loaded;
  let result;
  try {
    await evaluate('t.settle()');
    result = await evaluate(`(${src.trim().replace(/;$/, '')})()`);
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  const errorsOk = consoleErrors.length === 0 || src.includes('allow-console-errors');
  const ok = result?.ok === true && errorsOk;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log('      ' + JSON.stringify(result));
    if (!errorsOk) console.log('      console errors: ' + JSON.stringify(consoleErrors.slice(0, 3)));
  }
}

ws.close();
chrome.kill();
server.close();
await sleep(200);
rmSync(profile, { recursive: true, force: true });
console.log(`${cases.length - failures}/${cases.length} passed`);
process.exit(failures ? 1 : 0);
