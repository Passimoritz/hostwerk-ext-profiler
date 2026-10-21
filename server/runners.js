'use strict';
/*
 * Taking profiles:
 *   PHP   For the project's PHP version Hostwerk turns on Xdebug's profiler (mode "profile", only on a trigger), calls the
 *         page with the trigger, reads the cachegrind file and turns it into a readable summary. Pages without PHP only
 *         get their response time measured. The previous Xdebug settings are restored afterwards.
 *   Apps  A copy of the Node/Python app runs briefly on its own port – Node under the inspector (DevTools protocol over
 *         WebSocket), Python through a small cProfile wrapper – while the address is called N times. The real app is untouched.
 * Results live where they always did: <data>/profile/<project>.json and app-<id>.json.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { parseCachegrind, parseCpuProfile, phpSummary, appSummary, loadStats, localTarget } = require('./parsers');

/** So viele Messungen je Projekt/App/Anfrage bleiben zum Vergleichen. */
const RUNS_KEPT = 10;
/** Schlüssel einer Anfrage (Methode + Adresse) für Datei und Verlauf. */
const requestKey = (method, url) => `req-${crypto.createHash('sha1').update(`${String(method).toUpperCase()} ${url}`).digest('hex').slice(0, 12)}`;

const PY_WRAPPER = `import cProfile, pstats, io, json, os, runpy, sys, threading, time
entry = sys.argv[1]; seconds = float(sys.argv[2]); out = sys.argv[3]
profs = []
main = cProfile.Profile(); profs.append(main)
def thread_prof(*a):
    p = cProfile.Profile(); profs.append(p); p.enable(); sys.setprofile(None)
threading.setprofile(thread_prof)
def dump():
    time.sleep(seconds)
    rows = []
    for p in profs:
        try: p.disable()
        except Exception: pass
        st = pstats.Stats(p)
        for (f, ln, fn), (cc, nc, tt, ct, callers) in st.stats.items():
            rows.append({"file": f, "line": ln, "name": fn, "calls": nc, "self": tt * 1000, "incl": ct * 1000})
    with open(out, "w", encoding="utf-8") as fh: json.dump(rows, fh)
    os._exit(0)
threading.Thread(target=dump, daemon=True).start()
sys.argv = [entry]
main.enable()
try: runpy.run_path(entry, run_name="__main__")
finally: main.disable()
time.sleep(seconds + 1)
`;

class Profiler {
  /** host: the extension host (ctx, t, core(), lib()) */
  constructor(host) {
    this.host = host;
    this.ctx = host.ctx;
    this.t = host.t;
    this.dir = path.join(this.ctx.paths.data, 'profile');
    fs.mkdirSync(this.dir, { recursive: true });
    this.runJob = host.core('jobs').runJob;
    this.writeFileSafe = host.core('safewrite').writeFileSafe;
    this.settle = 800; // Xdebug schreibt die Datei kurz nach der Antwort
  }

  read(file) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')); } catch { return null; } }
  lastProject(id) { return this.read(`${path.basename(id)}.json`); }
  lastApp(id) { return this.read(`app-${path.basename(id)}.json`); }

  /** Every stored result, newest first – for the overview page. */
  history() {
    let files = []; try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json') && f !== 'load-last.json'); } catch { /* none */ }
    return files.map((f) => { const r = this.read(f); return r ? { key: f.replace(/\.json$/, ''), app: r.app || null, project: /^(app|req)-/.test(f) ? null : f.replace(/\.json$/, ''), request: f.startsWith('req-') ? `${r.method || 'GET'} ${r.url}` : null, at: r.at, url: r.url, totalMs: r.totalMs, kind: r.kind || (r.php ? 'php' : 'http'), profiled: !!r.profiled, hint: (r.hints || [])[0] || '' } : null; }).filter(Boolean).sort((a, b) => b.at - a.at);
  }

  /** Speichern: letzte Messung (wie bisher) und die letzten RUNS_KEPT im Verlauf – zum Vergleichen vorher/nachher. */
  save(key, result) {
    const k = path.basename(key);
    this.writeFileSafe(path.join(this.dir, `${k}.json`), JSON.stringify(result));
    const runs = this.runs(k);
    fs.mkdirSync(path.join(this.dir, 'runs'), { recursive: true });
    this.writeFileSafe(path.join(this.dir, 'runs', `${k}.json`), JSON.stringify([result, ...runs].slice(0, RUNS_KEPT)));
    return result;
  }
  /** Alle aufgehobenen Messungen eines Projekts/einer App/einer Anfrage, neueste zuerst. */
  runs(key) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'runs', `${path.basename(key)}.json`), 'utf8')); } catch { return []; } }

  /** PHP-Version zu einer Adresse: über das Projekt (falls angegeben oder an der Adresse erkennbar). */
  phpFor(p) {
    if (!p) return null;
    const isPhp = !!(p.composer || p.kind === 'php' || /php|laravel|symfony/i.test(p.framework || '') || fs.existsSync(path.join(p.path, 'index.php')) || fs.existsSync(path.join(p.path, 'public', 'index.php')));
    return isPhp ? this.ctx.devtools.phpForDir(p.path) : null;
  }
  /** Projekt, dessen Adresse zu url passt (gleicher Ursprung) – für Anfragen aus dem API-Tester. */
  projectFor(url) {
    let origin; try { origin = new URL(url).origin; } catch { return null; }
    const list = this.ctx.devtools && this.ctx.devtools.list ? this.ctx.devtools.list() : [];
    return list.find((p) => (p.urls || []).some((u) => { try { return new URL(u).origin === origin; } catch { return false; } })) || null;
  }

  /**
   * Eine Adresse messen – mit Xdebug-Profil, wenn version gesetzt ist (Xdebug wird dafür eingeschaltet und danach
   * zurückgestellt, auch bei Fehlern). request = { method, headers, body } (z. B. POST aus dem API-Tester).
   */
  async measure(job, url, version, { runs = 1, method = 'GET', headers = {}, body = null } = {}) {
    const { t } = this;
    const dev = this.ctx.devtools;
    let restored = null;
    const outDir = path.join(this.ctx.paths.logs, 'xdebug');
    if (version) {
      let xdebug = dev.xdebugStatus(version);
      if (!xdebug.installed) { job.progress(5, t('Installing Xdebug for PHP {v} …', { v: version })); await dev.installXdebug(version).promise; xdebug = dev.xdebugStatus(version); }
      const want = [...new Set([...(xdebug.mode || 'develop').split(',').map((x) => x.trim()).filter((x) => x && x !== 'off'), 'profile'])].join(',');
      if (!xdebug.enabled || !/profile/.test(xdebug.mode) || xdebug.start !== 'trigger') { restored = { enabled: xdebug.enabled, mode: xdebug.mode, start: xdebug.start }; job.progress(15, t('Turning the profiler on …')); await dev.setXdebug(version, { enabled: true, mode: want, start: 'trigger' }); }
      fs.mkdirSync(outDir, { recursive: true });
    }
    try {
      const before = new Set(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []);
      const times = [];
      let status = 0; let bytes = 0;
      const m = String(method || 'GET').toUpperCase();
      for (let i = 0; i < Math.max(1, Math.min(5, runs)); i++) {
        job.progress(30 + i * 10, t('Calling the page ({n}) …', { n: i + 1 }));
        const t0 = Date.now();
        const u = new URL(url); if (version) u.searchParams.set('XDEBUG_TRIGGER', '1');
        const h = { ...headers, 'user-agent': 'Hostwerk-Profiler' };
        if (version) { h.cookie = [headers.cookie, 'XDEBUG_TRIGGER=1'].filter(Boolean).join('; '); h.XDEBUG_TRIGGER = '1'; }
        const r = await fetch(u, { method: m, headers: h, body: ['GET', 'HEAD'].includes(m) || body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), redirect: 'follow', signal: AbortSignal.timeout(120000) });
        const buf = await r.arrayBuffer();
        times.push(Date.now() - t0); status = r.status; bytes = buf.byteLength;
      }
      await new Promise((r) => setTimeout(r, this.settle));
      const fresh = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => !before.has(f) && /^cachegrind\.out/.test(f)).map((f) => path.join(outDir, f)) : [];
      const result = { at: Date.now(), url, method: m, status, bytes, responseMs: times, php: version, profiled: fresh.length > 0, hints: [], kind: version ? 'php' : 'http' };
      if (fresh.length) {
        job.progress(80, t('Reading the profile …'));
        const file = fresh.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        let text = fs.readFileSync(file);
        if (/\.gz$/.test(file) || (text[0] === 0x1f && text[1] === 0x8b)) text = zlib.gunzipSync(text);
        Object.assign(result, phpSummary(parseCachegrind(text.toString('utf8')), t), { file: path.basename(file) });
        if (fresh.length > 3) for (const f of fresh.slice(3)) fs.rmSync(f, { force: true });
      } else {
        const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
        result.totalMs = avg;
        result.hints.push(version ? t('No profile file was written – does the page run on this PHP version and is Xdebug loaded (phpinfo)? Also check xdebug.output_dir.') : t('Not a PHP page – only the response time was measured ({ms} ms). For Node/Python apps use the app profile.', { ms: avg }));
        if (avg > 1500) result.hints.push(t('Over 1.5 s response time – every visitor notices that.'));
      }
      return result;
    } finally {
      if (restored) { job.progress(95, t('Turning the profiler off again …')); await dev.setXdebug(version, { enabled: restored.enabled, mode: restored.mode, start: restored.start }).catch(() => {}); }
    }
  }

  runProject(projectId, { url = null, runs = 1 } = {}) {
    const { t } = this;
    const p = this.ctx.devtools.get(projectId);
    url = String(url || p.urls[0] || '').trim();
    if (!/^https?:\/\//.test(url)) throw this.host.error(400, 'Please enter the address of the page (http://…).');
    return this.runJob(t('Profile: {name}', { name: p.name }), async (job) => this.save(p.id, await this.measure(job, url, this.phpFor(p), { runs })), { key: `profile-${p.id}` });
  }

  /**
   * Eine beliebige Anfrage messen (z. B. aus dem API-Tester, auch POST mit Body). Gehört die Adresse zu einem
   * PHP-Projekt, gibt es ein Xdebug-Profil, sonst die Antwortzeit. Gespeichert unter „req-…“ je Methode und Adresse.
   */
  runRequest({ url, method = 'GET', headers = {}, body = null, projectId = null, runs = 1 } = {}) {
    const { t } = this;
    url = String(url || '').trim();
    if (!/^https?:\/\//.test(url)) throw this.host.error(400, 'Please enter the address of the page (http://…).');
    const m = String(method || 'GET').toUpperCase();
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(m)) throw this.host.error(400, 'Unknown method');
    const p = projectId ? this.ctx.devtools.get(projectId) : this.projectFor(url);
    const key = requestKey(m, url);
    const clean = Object.fromEntries(Object.entries(headers || {}).filter(([k, v]) => /^[\w-]{1,60}$/.test(k) && typeof v === 'string').slice(0, 40));
    return this.runJob(t('Profile: {name}', { name: `${m} ${url}` }), async (job) => this.save(key, { ...(await this.measure(job, url, this.phpFor(p), { runs, method: m, headers: clean, body })), request: key, project: p ? p.id : null }), { key: `profile-${key}` });
  }

  /**
   * Kleiner Lasttest: total Aufrufe, davon parallel gleichzeitig – nur gegen den eigenen Rechner/das eigene Netz.
   * → loadStats(): Median, 95 %, Fehler, Anfragen je Sekunde
   */
  runLoad({ url, parallel = 10, total = 100, method = 'GET', body = null } = {}) {
    const { t } = this;
    url = String(url || '').trim();
    const vhosts = (this.ctx.web && this.ctx.web.list ? this.ctx.web.list() : []).flatMap((w) => (w.vhosts || []).map((v) => v.domain));
    if (!localTarget(url, vhosts)) throw this.host.error(400, 'Load tests only run against this computer or your own network (localhost, *.localhost, *.test, private addresses).');
    parallel = Math.max(1, Math.min(50, Number(parallel) || 10));
    total = Math.max(parallel, Math.min(1000, Number(total) || 100));
    const m = String(method || 'GET').toUpperCase();
    return this.runJob(t('Load test: {url}', { url }), async (job) => {
      const samples = [];
      let next = 0;
      const t0 = Date.now();
      const worker = async () => {
        while (next < total) {
          next++;
          const s0 = Date.now();
          try {
            const r = await fetch(url, { method: m, body: ['GET', 'HEAD'].includes(m) || body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), headers: { 'user-agent': 'Hostwerk-Profiler (load test)' }, signal: AbortSignal.timeout(30000) });
            await r.arrayBuffer();
            samples.push({ ms: Date.now() - s0, status: r.status, ok: r.status < 400 });
          } catch { samples.push({ ms: Date.now() - s0, status: null, ok: false }); }
          if (samples.length % Math.max(1, Math.round(total / 20)) === 0) job.progress(Math.round((samples.length / total) * 95), t('Call {i}/{n}', { i: samples.length, n: total }));
        }
      };
      await Promise.all(Array.from({ length: parallel }, worker));
      const result = { at: Date.now(), url, method: m, parallel, ...loadStats(samples, Date.now() - t0) };
      this.writeFileSafe(path.join(this.dir, 'load-last.json'), JSON.stringify(result));
      return result;
    }, { key: `profile-load-${url}` });
  }

  runApp(appId, { url = null, seconds = 8, requests = 10 } = {}) {
    const { t } = this;
    const apps = this.ctx.apps;
    const a = apps.get(appId);
    if (!['node', 'python'].includes(a.kind)) throw this.host.error(400, 'App profiles exist for Node and Python apps (PHP through the project).');
    const { findFreePort } = this.host.core('ports');
    const { killTree } = this.host.core('proc');
    return this.runJob(t('Profile: {name}', { name: a.name }), async (job) => {
      const port = await findFreePort(3900);
      const l = await apps.launch(a);
      const env = { ...l.env, PORT: String(port), HOSTWERK_PROFILE: '1' };
      const target = String(url || `http://127.0.0.1:${port}${a.port ? a.webPath || '/' : '/'}`).replace(`localhost:${a.port}`, `127.0.0.1:${port}`).replace(`:${a.port}`, `:${port}`);
      let child; let result;
      const out = path.join(this.ctx.paths.cache, `profile-app-${a.id}.json`);
      fs.rmSync(out, { force: true });
      try {
        if (a.kind === 'node') {
          job.progress(10, t('Starting the app with the inspector …'));
          child = spawn(l.cmd, ['--inspect=127.0.0.1:0', ...l.args], { cwd: l.cwd, env, windowsHide: true });
          const wsUrl = await new Promise((resolve, reject) => {
            let buf = '';
            const timer = setTimeout(() => reject(new Error(t('Inspector address not found (does the app start?)'))), 20000);
            child.stderr.on('data', (d) => { buf += d; const m = buf.match(/ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/); if (m) { clearTimeout(timer); resolve(m[0]); } });
            child.on('exit', (c) => { clearTimeout(timer); reject(new Error(t('The app ended (code {code}) – {log}', { code: c, log: buf.slice(-300) }))); });
          });
          const WebSocket = this.host.lib('ws');
          const ws = new WebSocket(wsUrl);
          await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
          let id = 0; const pending = new Map();
          ws.on('message', (m) => { const j = JSON.parse(m); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
          const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
          await send('Runtime.runIfWaitingForDebugger'); await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 500 });
          job.progress(25, t('Waiting until the app answers …'));
          await waitHttp(target, 30000, t);
          await send('Profiler.start');
          const times = await hit(target, requests, job, t);
          const r = await send('Profiler.stop');
          ws.close();
          result = { kind: 'node', ...parseCpuProfile(r.result.profile), responseMs: times };
        } else {
          job.progress(10, t('Starting the app under cProfile …'));
          const wrapper = path.join(this.ctx.paths.cache, 'hostwerk_profile.py');
          fs.writeFileSync(wrapper, PY_WRAPPER);
          const entry = l.args.find((x) => /\.py$/i.test(x)) || l.args[l.args.length - 1];
          const rest = l.args.filter((x) => x !== entry && x !== '-u');
          child = spawn(l.cmd, ['-u', ...rest, wrapper, path.isAbsolute(entry) ? entry : path.join(l.cwd, entry), String(seconds + 5), out], { cwd: l.cwd, env, windowsHide: true });
          let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
          job.progress(25, t('Waiting until the app answers …'));
          await waitHttp(target, 30000, t).catch(() => { throw new Error(t('The app does not answer at {url} – {log}', { url: target, log: log.slice(-300) })); });
          const times = await hit(target, requests, job, t);
          job.progress(70, t('Waiting for the profile …'));
          for (let i = 0; i < 40 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 500));
          if (!fs.existsSync(out)) throw new Error(t('No profile was written – {log}', { log: log.slice(-300) }));
          const rows = JSON.parse(fs.readFileSync(out, 'utf8'));
          result = { kind: 'python', totalMs: Math.round(rows.filter((x) => x.name === '<module>' || x.name === 'run_path').reduce((n, x) => Math.max(n, x.incl), 0)), functions: rows.map((x) => ({ name: x.name, file: x.file, line: x.line, self: Math.round(x.self * 100) / 100, incl: Math.round(x.incl * 100) / 100, calls: x.calls })).filter((x) => !/hostwerk_profile\.py|cProfile|threading\.py|runpy\.py/.test(x.file)), responseMs: times };
        }
      } finally { if (child) { try { killTree(child.pid); } catch { /* already gone */ } } }
      const final = { at: Date.now(), url: target, kind: result.kind, totalMs: result.totalMs, responseMs: result.responseMs, ...appSummary(result, t, (f) => path.basename(f || '')), tree: result.tree || null, profiled: true, app: a.id };
      return this.save(`app-${a.id}`, final);
    }, { key: `profile-app-${a.id}` });
  }
}

async function waitHttp(url, ms, t) { const t0 = Date.now(); for (;;) { try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (r.status) return; } catch { /* not yet */ } if (Date.now() - t0 > ms) throw new Error(t('The app does not answer')); await new Promise((r) => setTimeout(r, 500)); } }
async function hit(url, n, job, t) { const times = []; for (let i = 0; i < n; i++) { const t0 = Date.now(); try { const r = await fetch(url, { signal: AbortSignal.timeout(30000) }); await r.arrayBuffer(); } catch { /* counts anyway */ } times.push(Date.now() - t0); job.progress(30 + (i / n) * 35, t('Call {i}/{n}', { i: i + 1, n })); } return times; }

module.exports = { Profiler, PY_WRAPPER, requestKey, RUNS_KEPT };
