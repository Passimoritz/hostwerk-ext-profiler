'use strict';
/*
 * Profile formats → one shape: functions with own time (self) and total time (incl) in ms, calls and file.
 *   parseCachegrind(text)   Xdebug cachegrind output (PHP)
 *   parseCpuProfile(p)      Chrome DevTools CPU profile (Node: nodes / samples / timeDeltas)
 * Pure functions – no Hostwerk needed, fully covered by tests/parsers.test.js.
 */

/** Database calls (PHP) – their total time is the "database" share of a page. */
const DB_FN = /(mysqli(_query|_prepare|_stmt_execute|::query|::prepare|_stmt::execute)|PDO(::|->)(query|exec|prepare)|PDOStatement(::|->)execute|pg_(query|execute|prepare)|SQLite3(::|->)(query|exec)|sqlsrv_query|oci_execute|mongodb)/i;
/** Network, file and other waiting calls (PHP). */
const IO_FN = /^(curl_exec|file_get_contents|fsockopen|stream_socket_client|fopen|fread|fwrite|sleep|usleep|mail|exec|shell_exec|proc_open|system|gzcompress|json_decode|json_encode|unserialize|serialize|preg_match_all|include|require|include_once|require_once)$/i;

/** Flammendiagramm: höchstens so tief, so breit, und nur Zweige ab diesem Anteil an der Gesamtzeit. */
const TREE_DEPTH = 14;
const TREE_WIDTH = 12;
const TREE_MIN = 0.01;

function parseCachegrind(text) {
  const fl = new Map(); const fn = new Map();
  // Compressed names: "(12) name" defines id 12, "(12)" refers to it
  const names = (map, s) => { const m = s.match(/^\((\d+)\)(?: (.*))?$/); if (!m) return s; if (m[2] !== undefined) map.set(m[1], m[2]); return map.get(m[1]) || s; };
  const funcs = new Map();
  const edges = new Map(); // Aufrufer → Map(Aufgerufener → Zeit)
  let curFile = ''; let cur = null; let pendingCall = null; let total = 0; let unit = 1; let memory = 0;
  const get = (n) => { let f = funcs.get(n); if (!f) { f = { name: n, self: 0, incl: 0, calls: 0, file: curFile, callers: 0 }; funcs.set(n, f); } return f; };
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('events:')) { unit = /Time_\(10ns\)|Time \(10ns\)/i.test(l) ? 1e-5 : /µs|us\)/i.test(l) ? 1e-3 : 1e-6; continue; }
    if (l.startsWith('fl=')) { curFile = names(fl, l.slice(3)); continue; }
    if (l.startsWith('fn=')) { cur = get(names(fn, l.slice(3))); cur.calls++; if (!cur.file) cur.file = curFile; continue; }
    if (l.startsWith('cfl=')) { names(fl, l.slice(4)); continue; }
    if (l.startsWith('cfn=')) { pendingCall = get(names(fn, l.slice(4))); continue; }
    if (l.startsWith('calls=')) { const m = l.match(/^calls=(\d+)/); if (pendingCall && m) pendingCall.callers += Number(m[1]); continue; }
    if (l.startsWith('summary:')) { total = Number(l.split(/\s+/)[1]) || 0; continue; }
    if (/^\d/.test(l) && cur) {
      const [, t, mem] = l.split(/\s+/);
      const time = Number(t) || 0;
      if (pendingCall) { cur.incl += time; const e = edges.get(cur.name) || edges.set(cur.name, new Map()).get(cur.name); e.set(pendingCall.name, (e.get(pendingCall.name) || 0) + time); pendingCall = null; } else { cur.self += time; cur.incl += time; if (Number(mem) > memory) memory = Number(mem); }
    }
  }
  const ms = (v) => Math.round(v * unit * 100) / 100;
  const list = [...funcs.values()].map((f) => ({ name: f.name, file: f.file, self: ms(f.self), incl: ms(f.incl), calls: f.callers || f.calls })).filter((f) => f.name !== '{main}');
  const main = funcs.get('{main}');
  const totalMs = ms(total || (main ? main.incl : 0));
  // Aufrufbaum ab {main}: ein Aufgerufener, der von mehreren Stellen kommt, wird anteilig aufgeteilt
  const build = (name, value, depth, path) => {
    const node = { name, value: ms(value), children: [] };
    const out = edges.get(name);
    const fnInfo = funcs.get(name);
    if (!out || depth >= TREE_DEPTH || path.has(name) || !fnInfo || !fnInfo.incl) return node;
    const scale = value / fnInfo.incl;
    const next = new Set(path).add(name);
    node.children = [...out.entries()].map(([callee, v]) => [callee, v * scale]).filter(([, v]) => ms(v) >= totalMs * TREE_MIN).sort((a, b) => b[1] - a[1]).slice(0, TREE_WIDTH).map(([callee, v]) => build(callee, v, depth + 1, next));
    return node;
  };
  const tree = main ? build('{main}', main.incl, 0, new Set()) : null;
  return { totalMs, functions: list, memory, tree };
}

function parseCpuProfile(p) {
  const self = new Map(); const parent = new Map();
  for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
  for (let i = 0; i < p.samples.length; i++) { const d = (p.timeDeltas[i] || 0) / 1000; self.set(p.samples[i], (self.get(p.samples[i]) || 0) + d); }
  const incl = new Map();
  for (const [id, ms] of self) { let cur = id; const seen = new Set(); while (cur !== undefined && !seen.has(cur)) { seen.add(cur); incl.set(cur, (incl.get(cur) || 0) + ms); cur = parent.get(cur); } }
  const agg = new Map();
  for (const n of p.nodes) {
    const cf = n.callFrame; const key = `${cf.functionName || '(anonymous)'}|${cf.url}|${cf.lineNumber}`;
    const a = agg.get(key) || { name: cf.functionName || '(anonymous)', file: (cf.url || '').replace(/^file:\/\/\/?/, ''), line: (cf.lineNumber || 0) + 1, self: 0, incl: 0, calls: 0 };
    a.self += self.get(n.id) || 0; a.incl += incl.get(n.id) || 0; a.calls += n.hitCount || 0; agg.set(key, a);
  }
  const total = [...self.values()].reduce((x, y) => x + y, 0);
  // Aufrufbaum direkt aus dem Profil (Knoten mit Kindern), kleine Zweige weggelassen
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const root = p.nodes.find((n) => !parent.has(n.id));
  const build = (n, depth) => ({
    name: (n.callFrame && n.callFrame.functionName) || '(anonymous)',
    value: Math.round((incl.get(n.id) || 0) * 100) / 100,
    children: depth >= TREE_DEPTH ? [] : (n.children || []).map((c) => byId.get(c)).filter((c) => c && (incl.get(c.id) || 0) >= total * TREE_MIN && !/^\((program|idle|garbage collector)\)$/.test((c.callFrame && c.callFrame.functionName) || '')).sort((a, b) => (incl.get(b.id) || 0) - (incl.get(a.id) || 0)).slice(0, TREE_WIDTH).map((c) => build(c, depth + 1)),
  });
  const tree = root ? build(root, 0) : null;
  return { tree, totalMs: Math.round(total), functions: [...agg.values()].filter((f) => !/^\((root|program|idle|garbage collector)\)$/.test(f.name)).map((f) => ({ ...f, self: Math.round(f.self * 100) / 100, incl: Math.round(f.incl * 100) / 100 })) };
}

/**
 * Plain-language hints for a PHP profile. t(text, vars) translates.
 * Returns the summary fields stored with the result plus the hints.
 */
function phpSummary(parsed, t) {
  const fns = parsed.functions;
  const db = fns.filter((f) => DB_FN.test(f.name)).sort((a, b) => b.incl - a.incl);
  const io = fns.filter((f) => IO_FN.test(f.name)).sort((a, b) => b.incl - a.incl);
  const bySelf = [...fns].sort((a, b) => b.self - a.self).slice(0, 25);
  const byIncl = [...fns].filter((f) => !/^(php::)?(include|require)/.test(f.name)).sort((a, b) => b.incl - a.incl).slice(0, 25);
  const dbMs = db.reduce((n, f) => n + f.incl, 0); const dbCalls = db.reduce((n, f) => n + f.calls, 0);
  const hints = [];
  const pct = (x) => Math.round((x / parsed.totalMs) * 100);
  if (parsed.totalMs && dbMs / parsed.totalMs > 0.4) hints.push(t('The database takes {pct} % of the time ({calls} queries) – combine queries, check indexes, cache results.', { pct: pct(dbMs), calls: dbCalls }));
  if (dbCalls > 50) hints.push(t('{calls} database queries for one page – typical for N+1 problems (a query per loop pass). Use eager loading / JOIN.', { calls: dbCalls }));
  const slowest = bySelf[0];
  if (slowest && parsed.totalMs && slowest.self / parsed.totalMs > 0.3) hints.push(t('“{name}” alone takes {pct} % of the time (called {calls}×).', { name: slowest.name, pct: pct(slowest.self), calls: slowest.calls }));
  const hot = bySelf.find((f) => f.calls > 1000);
  if (hot) hints.push(t('“{name}” is called {calls}× – can that happen outside the loop?', { name: hot.name, calls: hot.calls }));
  if (io[0] && io[0].incl > 200) hints.push(t('External call / file access “{name}” takes {ms} ms – do it in the background or cache it.', { name: io[0].name, ms: io[0].incl }));
  if (parsed.memory > 64 * 1048576) hints.push(t('Peak memory {mb} MB.', { mb: Math.round(parsed.memory / 1048576) }));
  if (!hints.length) hints.push(parsed.totalMs < 100 ? t('The page is fast – no bottleneck in sight.') : t('No single bottleneck – the time is spread over many functions (framework bootstrap, autoloading). Opcache and caching help.'));
  return { totalMs: parsed.totalMs, memory: parsed.memory, tree: parsed.tree || null, functions: fns.length, bySelf, byIncl, db: db.slice(0, 15), io: io.slice(0, 10), dbMs, dbCalls, hints };
}

/** Same for Node/Python app profiles. */
function appSummary(result, t, basename = (f) => String(f || '').split(/[\\/]/).pop()) {
  const fns = result.functions;
  const own = (f) => !/node_modules|site-packages|<frozen|node:internal|\/lib\/python/.test(f.file || '');
  const bySelf = [...fns].sort((a, b) => b.self - a.self).slice(0, 25);
  const byIncl = [...fns].filter(own).sort((a, b) => b.incl - a.incl).slice(0, 25);
  const io = fns.filter((f) => /query|execute|fetch|request|readFile|writeFile|readdir|stat|connect|socket|sleep|await|send|recv|open|urlopen|get|post/i.test(f.name) && f.incl > 5).sort((a, b) => b.incl - a.incl).slice(0, 12);
  const db = fns.filter((f) => /query|execute|cursor|sql|prisma|sequelize|knex|mongoose|pg|mysql|sqlite|redis/i.test(`${f.name} ${f.file}`) && f.incl > 1).sort((a, b) => b.incl - a.incl).slice(0, 12);
  const hints = [];
  const avg = Math.round(result.responseMs.reduce((x, y) => x + y, 0) / Math.max(1, result.responseMs.length));
  if (avg > 1000) hints.push(t('Average response time {ms} ms – every visitor notices that.', { ms: avg }));
  const top = bySelf.find(own);
  if (top && result.totalMs && top.self / result.totalMs > 0.25) hints.push(t('“{name}” ({file}:{line}) takes {pct} % of the measured time.', { name: top.name, file: basename(top.file), line: top.line, pct: Math.round((top.self / result.totalMs) * 100) }));
  const dbMs = db.reduce((n, f) => n + f.self, 0);
  if (result.totalMs && dbMs / result.totalMs > 0.3) hints.push(t('Database access makes up {pct} % – bundle queries, check indexes, cache results.', { pct: Math.round((dbMs / result.totalMs) * 100) }));
  if (io[0] && io[0].incl > 200) hints.push(t('“{name}” waits {ms} ms (network/file) – do it in the background or cache it.', { name: io[0].name, ms: io[0].incl }));
  if (!hints.length) hints.push(avg < 100 ? t('The app answers fast – no bottleneck in sight.') : t('No single bottleneck – the time is spread (framework, serialisation). Caching helps.'));
  return { functions: fns.length, bySelf, byIncl, db, io, dbMs: Math.round(dbMs), dbCalls: db.reduce((n, f) => n + (f.calls || 0), 0), hints };
}

/**
 * Zwei Messungen vergleichen (vorher → nachher): Gesamtzeit, Datenbank und die Funktionen mit der größten Änderung
 * der eigenen Zeit. → { totalMs: { before, after, delta, pct }, dbMs, functions: [{ name, file, before, after, delta }] }
 */
function compare(before, after, limit = 20) {
  const d = (a, b) => ({ before: a, after: b, delta: Math.round((b - a) * 100) / 100, pct: a ? Math.round(((b - a) / a) * 100) : null });
  const key = (x) => `${x.name}|${x.file || ''}`;
  const map = (r) => { const m = new Map(); for (const x of [...((r && r.bySelf) || []), ...((r && r.byIncl) || [])]) if (!m.has(key(x))) m.set(key(x), x); return m; };
  const a = map(before); const b = map(after);
  const keys = new Set([...a.keys(), ...b.keys()]);
  const functions = [...keys].map((k) => { const x = a.get(k); const y = b.get(k); const base = x || y; return { name: base.name, file: base.file, before: x ? x.self : 0, after: y ? y.self : 0, delta: Math.round(((y ? y.self : 0) - (x ? x.self : 0)) * 100) / 100 }; })
    .filter((x) => x.delta !== 0).sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta)).slice(0, limit);
  return { totalMs: d(Number(before && before.totalMs) || 0, Number(after && after.totalMs) || 0), dbMs: d(Math.round(Number(before && before.dbMs) || 0), Math.round(Number(after && after.dbMs) || 0)), functions };
}

/** Kennzahlen eines Lasttests aus den Einzelzeiten: Median, 95 %, schnellste/langsamste, Anfragen je Sekunde. */
function loadStats(samples, wallMs) {
  const ok = samples.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b);
  const q = (p) => (ok.length ? ok[Math.min(ok.length - 1, Math.ceil((p / 100) * ok.length) - 1)] : null);
  const statuses = {};
  for (const x of samples) { const k = x.status ? String(x.status) : 'error'; statuses[k] = (statuses[k] || 0) + 1; }
  return { total: samples.length, ok: ok.length, failed: samples.length - ok.length, p50: q(50), p95: q(95), min: ok[0] ?? null, max: ok[ok.length - 1] ?? null, rps: wallMs > 0 ? Math.round((samples.length / wallMs) * 10000) / 10 : null, ms: wallMs, statuses };
}

/** Darf ein Lasttest diese Adresse treffen? Nur der eigene Rechner und das eigene Netz – nie fremde Server. */
function localTarget(url, extraHosts = []) {
  let u; try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.test') || h === '::1' || /^127\./.test(h)
    || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || extraHosts.map((x) => String(x).toLowerCase()).includes(h);
}

module.exports = { parseCachegrind, parseCpuProfile, phpSummary, appSummary, compare, loadStats, localTarget, DB_FN, IO_FN };
