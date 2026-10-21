'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseCachegrind, parseCpuProfile, phpSummary, appSummary, compare, loadStats, localTarget } = require('../server/parsers');
const de = require('../locales/de.json');

const fill = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : s);
const tDe = (s, v) => { assert.ok(de[s], `German missing for: ${s}`); return fill(de[s], v); };
const tEn = (s, v) => fill(s, v);

const CG = ['version: 1', 'creator: xdebug 3.3.0', 'cmd: /x/index.php', 'part: 1', 'positions: line', '', 'events: Time_(10ns) Memory_(bytes)', '',
  'fl=(1) /x/db.php', 'fn=(1) mysqli_query', '5 200000 100', '', 'fl=(2) /x/index.php', 'fn=(2) render', '10 50000 10', 'cfl=(1)', 'cfn=(1)', 'calls=3 0 0', '12 600000 0', '', 'fl=(2)', 'fn=(3) {main}', '1 10000 0', 'cfl=(2)', 'cfn=(2)', 'calls=1 0 0', '2 650000 0', '', 'summary: 660000 100'].join('\n');

test('cachegrind: time, calls, database', () => {
  const r = parseCachegrind(CG);
  assert.strictEqual(r.totalMs, 6.6);
  const render = r.functions.find((f) => f.name === 'render');
  assert.ok(render.self === 0.5 && render.incl === 6.5, JSON.stringify(render));
  const db = r.functions.find((f) => f.name === 'mysqli_query');
  assert.ok(db.calls === 3 && db.self === 2, JSON.stringify(db));
  assert.ok(!r.functions.some((f) => f.name === '{main}'));
});

test('PHP summary: database share and hints in German and English', () => {
  const s = phpSummary(parseCachegrind(CG), tDe);
  assert.strictEqual(s.dbCalls, 3);
  assert.ok(s.hints.some((h) => /Die Datenbank braucht 30 % der Zeit/.test(h)) || s.hints.some((h) => /allein braucht/.test(h)), s.hints.join(' | '));
  const en = phpSummary(parseCachegrind(CG), tEn);
  assert.ok(en.hints.every((h) => !/[äöüß]/.test(h)), en.hints.join(' | '));
});

test('CPU profile (Node format)', () => {
  const prof = { nodes: [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0 }, children: [2] }, { id: 2, callFrame: { functionName: 'handler', url: 'file:///x/app.js', lineNumber: 9 }, children: [3], hitCount: 1 }, { id: 3, callFrame: { functionName: 'query', url: 'file:///x/db.js', lineNumber: 4 }, hitCount: 4 }], samples: [3, 3, 3, 3, 2], timeDeltas: [1000, 1000, 1000, 1000, 500] };
  const r = parseCpuProfile(prof);
  const q = r.functions.find((f) => f.name === 'query'); const h = r.functions.find((f) => f.name === 'handler');
  assert.ok(q.self === 4 && q.incl === 4 && q.line === 5, JSON.stringify(q));
  assert.ok(h.self === 0.5 && h.incl === 4.5, JSON.stringify(h));
  assert.strictEqual(r.totalMs, 5);
  const s = appSummary({ ...r, responseMs: [1200, 1300] }, tDe);
  assert.ok(s.hints.some((h2) => /Durchschnittliche Antwortzeit 1250 ms/.test(h2)), s.hints.join(' | '));
  assert.ok(s.db.some((f) => f.name === 'query'));
});

test('every German text has a value', () => {
  for (const [k, v] of Object.entries(de)) if (k !== '$patterns') assert.ok(typeof v === 'string' && v.trim(), k);
});

test('call trees for the flame graph (PHP and Node)', () => {
  const t = parseCachegrind(CG).tree;
  assert.strictEqual(t.name, '{main}'); assert.strictEqual(t.value, 6.6);
  assert.deepStrictEqual(t.children.map((c) => [c.name, c.value]), [['render', 6.5]]);
  assert.deepStrictEqual(t.children[0].children.map((c) => [c.name, c.value]), [['mysqli_query', 6]]);
  const prof = { nodes: [{ id: 1, callFrame: { functionName: '(root)', url: '' }, children: [2, 4] }, { id: 2, callFrame: { functionName: 'handler', url: 'a.js' }, children: [3] }, { id: 3, callFrame: { functionName: 'query', url: 'db.js' } }, { id: 4, callFrame: { functionName: '(idle)', url: '' } }], samples: [3, 3, 2, 4], timeDeltas: [1000, 1000, 1000, 1000] };
  const n = parseCpuProfile(prof).tree;
  assert.strictEqual(n.name, '(root)');
  assert.deepStrictEqual(n.children.map((c) => c.name), ['handler'], 'idle is left out');
  assert.strictEqual(n.children[0].children[0].value, 2);
});

test('compare two measurements: totals and the biggest changes', () => {
  const a = { totalMs: 200, dbMs: 120, bySelf: [{ name: 'q', file: 'db.php', self: 100 }, { name: 'render', file: 'v.php', self: 50 }] };
  const b = { totalMs: 120, dbMs: 30, bySelf: [{ name: 'q', file: 'db.php', self: 20 }, { name: 'render', file: 'v.php', self: 55 }, { name: 'cache', file: 'c.php', self: 3 }] };
  const c = compare(a, b);
  assert.deepStrictEqual(c.totalMs, { before: 200, after: 120, delta: -80, pct: -40 });
  assert.strictEqual(c.dbMs.delta, -90);
  assert.deepStrictEqual(c.functions.map((f) => [f.name, f.delta]), [['q', -80], ['render', 5], ['cache', 3]]);
  assert.strictEqual(compare(null, b).totalMs.pct, null);
});

test('load test numbers', () => {
  const s = loadStats([...Array.from({ length: 19 }, (_, i) => ({ ms: i + 1, status: 200, ok: true })), { ms: 500, status: 500, ok: false }], 1000);
  assert.deepStrictEqual([s.total, s.ok, s.failed, s.p50, s.p95, s.min, s.max, s.rps], [20, 19, 1, 10, 19, 1, 19, 20]);
  assert.deepStrictEqual(s.statuses, { 200: 19, 500: 1 });
  assert.strictEqual(loadStats([], 0).p50, null);
});

test('load tests only against the own computer or network', () => {
  for (const u of ['http://localhost:8080/', 'http://shop.localhost/', 'http://x.test/', 'http://127.0.0.1/', 'http://192.168.0.5/', 'http://[::1]:3000/']) assert.ok(localTarget(u), u);
  for (const u of ['https://example.org/', 'ftp://localhost/', 'http://172.40.0.1/', 'nonsense']) assert.ok(!localTarget(u), u);
  assert.ok(localTarget('http://shop.example/', ['shop.example']), 'own virtual hosts');
});
