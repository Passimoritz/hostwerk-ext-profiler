'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseCachegrind, parseCpuProfile, phpSummary, appSummary } = require('../server/parsers');
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
