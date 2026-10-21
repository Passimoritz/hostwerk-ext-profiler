'use strict';
/*
 * Messläufe ohne Hostwerk: Xdebug ein- und wieder ausschalten (auch bei Fehlern), Anfragen mit Methode und Body,
 * Verlauf zum Vergleichen, Lasttest nur im eigenen Netz und die App-Kopie unter dem Node-Inspektor.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { Profiler, requestKey } = require('../server/runners');

const CG = ['events: Time_(10ns) Memory_(bytes)', 'fl=(1) /x/db.php', 'fn=(1) mysqli_query', '5 200000 100', 'fl=(2) /x/index.php', 'fn=(2) render', '10 50000 10', 'cfl=(1)', 'cfn=(1)', 'calls=3 0 0', '12 600000 0', 'fl=(2)', 'fn=(3) {main}', '1 10000 0', 'cfl=(2)', 'cfn=(2)', 'calls=1 0 0', '2 650000 0', 'summary: 660000 100'].join('\n');

/** Hostwerk-Double: Projekte, PHP/Xdebug, Jobs (laufen sofort), Ports, Prozesse, ws-Bibliothek. */
function setup({ xdebug = { installed: true, enabled: false, mode: 'develop', start: 'yes' }, failFetch = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
  const proj = path.join(root, 'shop'); fs.mkdirSync(proj); fs.writeFileSync(path.join(proj, 'index.php'), '<?php echo 1;');
  const calls = { setXdebug: [], fetch: [] };
  const project = { id: 'shop', name: 'Shop', path: proj, urls: ['http://shop.localhost/'] };
  const ctx = {
    paths: { data: path.join(root, 'data'), logs: path.join(root, 'logs'), cache: path.join(root, 'cache') },
    devtools: {
      get: (id) => { if (id !== 'shop') throw new Error('unknown'); return project; }, list: () => [project],
      phpForDir: () => '8.3', xdebugStatus: () => ({ ...xdebug }),
      setXdebug: async (v, o) => { calls.setXdebug.push(o); }, installXdebug: () => ({ promise: Promise.resolve() }),
    },
    web: { list: () => [{ vhosts: [{ domain: 'shop.example' }] }] },
  };
  fs.mkdirSync(ctx.paths.cache, { recursive: true });
  const host = {
    ctx, t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : s),
    error: (status, text) => Object.assign(new Error(text), { status }),
    core: (n) => ({
      jobs: { runJob: (title, fn) => ({ id: 'j', title, promise: fn({ progress: () => {} }) }) },
      safewrite: { writeFileSafe: (f, d) => fs.writeFileSync(f, d) },
      ports: { findFreePort: (from) => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }) },
      proc: { killTree: (pid) => { try { process.kill(pid); } catch { /* weg */ } } },
    }[n]),
    lib: (n) => require(require.resolve(n, { paths: [path.join(__dirname, '..', '..', '..', 'hostwerk')] })),
  };
  const realFetch = global.fetch;
  // Seite „antwortet“ und Xdebug schreibt dabei eine cachegrind-Datei
  global.fetch = async (u, o = {}) => {
    calls.fetch.push({ url: String(u), method: o.method || 'GET', body: o.body, headers: o.headers });
    if (failFetch) throw new Error('fetch failed');
    const out = path.join(ctx.paths.logs, 'xdebug');
    if (fs.existsSync(out) && /XDEBUG_TRIGGER/.test(String(u))) fs.writeFileSync(path.join(out, `cachegrind.out.${Date.now()}${Math.random()}`), CG);
    return { status: 200, arrayBuffer: async () => new ArrayBuffer(10) };
  };
  const p = new Profiler(host);
  p.settle = 0;
  return { p, calls, ctx, done: () => { global.fetch = realFetch; fs.rmSync(root, { recursive: true, force: true }); } };
}

test('PHP: Xdebug on for the call, profile read, settings restored afterwards', async () => {
  const s = setup();
  try {
    const r = await s.p.runProject('shop').promise;
    assert.strictEqual(r.profiled, true);
    assert.strictEqual(r.kind, 'php');
    assert.ok(r.tree && r.tree.name === '{main}' && r.tree.children[0].name === 'render', 'call tree for the flame graph');
    assert.deepStrictEqual(s.calls.setXdebug, [{ enabled: true, mode: 'develop,profile', start: 'trigger' }, { enabled: false, mode: 'develop', start: 'yes' }]);
    assert.match(s.calls.fetch[0].url, /XDEBUG_TRIGGER=1/);
    assert.strictEqual(s.p.lastProject('shop').totalMs, r.totalMs);
  } finally { s.done(); }
});

test('PHP: Xdebug is restored even when the page fails', async () => {
  const s = setup({ failFetch: true });
  try {
    await assert.rejects(s.p.runProject('shop').promise, /fetch failed/);
    assert.strictEqual(s.calls.setXdebug.length, 2, 'switched on and back off');
    assert.strictEqual(s.calls.setXdebug[1].enabled, false);
  } finally { s.done(); }
});

test('PHP: already set up for profiling → settings untouched', async () => {
  const s = setup({ xdebug: { installed: true, enabled: true, mode: 'debug,profile', start: 'trigger' } });
  try { await s.p.runProject('shop').promise; assert.deepStrictEqual(s.calls.setXdebug, []); } finally { s.done(); }
});

test('history keeps the last measurements for comparing', async () => {
  const s = setup();
  try {
    for (let i = 0; i < 12; i++) await s.p.runProject('shop').promise;
    const runs = s.p.runs('shop');
    assert.strictEqual(runs.length, 10);
    assert.ok(runs[0].at >= runs[9].at, 'newest first');
    assert.ok(!s.p.history().some((h) => h.key === 'runs'), 'history folder is not a project');
  } finally { s.done(); }
});

test('request from the API tester: POST with body, PHP project found by its address', async () => {
  const s = setup();
  try {
    const r = await s.p.runRequest({ url: 'http://shop.localhost/api/order', method: 'post', headers: { 'content-type': 'application/json', 'bad header': 'x' }, body: { id: 1 } }).promise;
    const f = s.calls.fetch[0];
    assert.strictEqual(f.method, 'POST'); assert.strictEqual(f.body, '{"id":1}');
    assert.ok(!('bad header' in f.headers) && f.headers['content-type'] === 'application/json');
    assert.strictEqual(r.profiled, true); assert.strictEqual(r.project, 'shop');
    assert.strictEqual(s.p.runs(requestKey('POST', 'http://shop.localhost/api/order')).length, 1);
    assert.ok(s.p.history().some((h) => h.request === 'POST http://shop.localhost/api/order'));
    assert.throws(() => s.p.runRequest({ url: 'ftp://x' }), /address/);
    assert.throws(() => s.p.runRequest({ url: 'http://x/', method: 'TRACE' }), /Unknown method/);
  } finally { s.done(); }
});

test('load test: own network only, numbers add up', async () => {
  const s = setup();
  try {
    assert.throws(() => s.p.runLoad({ url: 'https://example.org/' }), /own network/);
    const r = await s.p.runLoad({ url: 'http://shop.localhost/', parallel: 5, total: 23 }).promise;
    assert.strictEqual(r.total, 23); assert.strictEqual(r.ok, 23); assert.strictEqual(r.statuses['200'], 23);
    assert.strictEqual(s.calls.fetch.length, 23);
    assert.strictEqual((await s.p.runLoad({ url: 'http://shop.example/', parallel: 1, total: 1 }).promise).total, 1, 'own virtual hosts are fine');
    assert.strictEqual(s.p.read('load-last.json').total >= 1, true);
  } finally { s.done(); }
});

test('app copy: Node app runs on its own port under the inspector and is stopped afterwards', async (t) => {
  let ws; try { ws = require.resolve('ws', { paths: [path.join(__dirname, '..', '..', '..', 'hostwerk')] }); } catch { ws = null; }
  if (!ws) { t.skip('ws library not found (needs Hostwerk next to this repository)'); return; }
  const realFetch = global.fetch;
  const s = setup();
  global.fetch = realFetch; // echte Aufrufe an die App-Kopie
  const dir = path.join(s.ctx.paths.data, 'app'); fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'server.js');
  fs.writeFileSync(script, "require('http').createServer((q, r) => { let x = 0; for (let i = 0; i < 2e5; i++) x += i; r.end(String(x)); }).listen(Number(process.env.PORT), '127.0.0.1');");
  // die „echte“ App läuft auf ihrem Port weiter und wird nicht angefasst
  const real = http.createServer((q, r) => r.end('real')); await new Promise((r) => real.listen(0, '127.0.0.1', r));
  const app = { id: 'api', name: 'API', kind: 'node', port: real.address().port };
  s.ctx.apps = { get: () => app, launch: async () => ({ cmd: process.execPath, args: [script], cwd: dir, env: { ...process.env } }) };
  try {
    const r = await s.p.runApp('api', { requests: 3, seconds: 1 }).promise;
    assert.strictEqual(r.kind, 'node'); assert.strictEqual(r.profiled, true); assert.strictEqual(r.responseMs.length, 3);
    assert.ok(!r.url.includes(`:${app.port}`), 'measured on its own port, not the real app');
    assert.strictEqual(s.p.lastApp('api').app, 'api');
    assert.strictEqual(await (await fetch(`http://127.0.0.1:${app.port}/`)).text(), 'real', 'the real app is untouched');
    await new Promise((res) => setTimeout(res, 500));
    await assert.rejects(fetch(r.url, { signal: AbortSignal.timeout(2000) }), 'the copy is stopped again');
  } finally { real.close(); s.done(); }
});
