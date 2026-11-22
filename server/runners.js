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
/** Ist das eine aufrufbare http(s)-Adresse? (Sonst gäbe es erst im Auftrag ein unübersetztes „Invalid URL“.) */
const httpUrl = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
/** Schlüssel einer Anfrage (Methode + Adresse) für Datei und Verlauf. */
const requestKey = (method, url) => `req-${crypto.createHash('sha1').update(`${String(method).toUpperCase()} ${url}`).digest('hex').slice(0, 12)}`;

/** Eingebaute Python-Funktionen, in denen ein Server nur auf Arbeit wartet. */
const PY_IDLE = /^<(built-in method (select\.\w+|time\.sleep|_socket\.socket\.accept)|method '(acquire|poll|select|accept|_accept|wait|control)' of )/;

const PY_WRAPPER = `import cProfile, pstats, io, json, os, runpy, sys, threading, time
entry = sys.argv[1]; seconds = float(sys.argv[2]); out = sys.argv[3]
profs = []
main = cProfile.Profile(); profs.append(main)
def thread_prof(*a):
    p = cProfile.Profile(); profs.append(p); p.enable(); sys.setprofile(None)
# Ab Python 3.12 läuft cProfile über sys.monitoring: ein Profil erfasst alle Threads, ein zweites wäre ein Fehler
if sys.version_info < (3, 12): threading.setprofile(thread_prof)
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
    // Eigener Datenordner data/profiler (Name = Kennung: „Restlos entfernen“ bietet ihn so an). Früher data/profile
    // (aus der Zeit, als der Profiler zu Hostwerk gehörte) – einmal umziehen; klappt das nicht (gesperrt), dort weiter.
    const old = path.join(this.ctx.paths.data, 'profile');
    this.dir = path.join(this.ctx.paths.data, 'profiler');
    if (!fs.existsSync(this.dir) && fs.existsSync(old)) { try { fs.renameSync(old, this.dir); } catch { this.dir = old; } }
    fs.mkdirSync(this.dir, { recursive: true });
    this.runJob = host.core('jobs').runJob;
    this.writeFileSafe = host.core('safewrite').writeFileSafe;
    this.settle = 800; // Xdebug schreibt die Datei kurz nach der Antwort
  }

  read(file) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')); } catch { return null; } }
  /**
   * Hinweise werden als Schlüssel + Werte gespeichert ({ k, v }) und erst beim Abruf übersetzt – nach einem Wechsel der
   * Sprache stehen sie so in der neuen Sprache da. Ältere Messungen haben fertige Sätze (bleiben, wie sie sind).
   */
  hintText(h) { return h && typeof h === 'object' && h.k ? this.t(h.k, h.v || undefined) : String(h || ''); }
  out(r) { return r && Array.isArray(r.hints) ? { ...r, hints: r.hints.map((h) => this.hintText(h)) } : r; }
  lastProject(id) { return this.out(this.read(`${path.basename(id)}.json`)); }
  lastApp(id) { return this.out(this.read(`app-${path.basename(id)}.json`)); }
  /** Name einer App (für den Verlauf statt ihrer Id) – null, wenn es sie nicht mehr gibt. */
  appName(id) { try { const a = this.ctx.apps && this.ctx.apps.get(id); return (a && a.name) || null; } catch { return null; } }

  /** Every stored result, newest first – for the overview page. */
  history() {
    let files = []; try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json') && f !== 'load-last.json'); } catch { /* none */ }
    return files.map((f) => { const r = this.read(f); return r ? { key: f.replace(/\.json$/, ''), app: r.app || null, appName: r.app ? this.appName(r.app) : null, project: /^(app|req)-/.test(f) ? null : f.replace(/\.json$/, ''), request: f.startsWith('req-') ? `${r.method || 'GET'} ${r.url}` : null, at: r.at, url: r.url, totalMs: r.totalMs, kind: r.kind || (r.php ? 'php' : 'http'), profiled: !!r.profiled, hint: this.hintText((r.hints || [])[0]) } : null; }).filter(Boolean).sort((a, b) => b.at - a.at);
  }
  /** Verlauf leeren: eine Messung (key) samt ihren aufgehobenen Läufen – oder alle (key = null). */
  forget(key = null) {
    const keys = key ? [path.basename(String(key))] : (() => { try { return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json') && f !== 'load-last.json').map((f) => f.replace(/\.json$/, '')); } catch { return []; } })();
    if (key && !fs.existsSync(path.join(this.dir, `${keys[0]}.json`))) throw this.host.error(404, 'Measurement not found');
    for (const k of keys) { fs.rmSync(path.join(this.dir, `${k}.json`), { force: true }); fs.rmSync(path.join(this.dir, 'runs', `${k}.json`), { force: true }); }
    return this.history();
  }

  /** Speichern: letzte Messung (wie bisher) und die letzten RUNS_KEPT im Verlauf – zum Vergleichen vorher/nachher. */
  save(key, result) {
    const k = path.basename(key);
    this.writeFileSafe(path.join(this.dir, `${k}.json`), JSON.stringify(result));
    fs.mkdirSync(path.join(this.dir, 'runs'), { recursive: true });
    this.writeFileSafe(path.join(this.dir, 'runs', `${k}.json`), JSON.stringify([result, ...this.rawRuns(k)].slice(0, RUNS_KEPT)));
    return this.out(result);
  }
  rawRuns(key) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'runs', `${path.basename(key)}.json`), 'utf8')); } catch { return []; } }
  /** Alle aufgehobenen Messungen eines Projekts/einer App/einer Anfrage, neueste zuerst. */
  runs(key) { return this.rawRuns(key).map((r) => this.out(r)); }

  /** PHP-Version zu einer Adresse: über das Projekt (falls angegeben oder an der Adresse erkennbar). */
  isPhp(p) {
    return !!p && !!(p.composer || p.kind === 'php' || /php|laravel|symfony/i.test(p.framework || '') || fs.existsSync(path.join(p.path, 'index.php')) || fs.existsSync(path.join(p.path, 'public', 'index.php')));
  }
  phpFor(p) {
    return this.isPhp(p) ? this.ctx.devtools.phpForDir(p.path) : null;
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
  async measure(job, url, version, { runs = 1, method = 'GET', headers = {}, body = null, phpProject = false } = {}) {
    const { t } = this;
    const H = hintKey; // Hinweise ohne fertigen Satz speichern (Übersetzung beim Abruf)
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
      for (let i = 0, n = Math.max(1, Math.min(5, Math.round(Number(runs)) || 1)); i < n; i++) {
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
        Object.assign(result, phpSummary(parseCachegrind(text.toString('utf8')), H), { file: path.basename(file) });
        if (fresh.length > 3) for (const f of fresh.slice(3)) fs.rmSync(f, { force: true });
      } else {
        const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
        result.totalMs = avg;
        result.hints.push(version ? H('No profile file was written – does the page run on this PHP version and is Xdebug loaded (phpinfo)? Also check xdebug.output_dir.') : phpProject ? H('This looks like a PHP project, but no PHP version of Hostwerk serves it – only the response time was measured ({ms} ms). A profile needs PHP installed through Hostwerk.', { ms: avg }) : H('Not a PHP page – only the response time was measured ({ms} ms). For Node/Python apps use the app profile.', { ms: avg }));
        if (avg > 1500) result.hints.push(H('Over 1.5 s response time – every visitor notices that.'));
      }
      // Fehlerseite gemessen? Dann gilt die Zeit nur für die Fehlerseite – zuerst sagen
      if (status >= 400) result.hints.unshift(H('The page answered with HTTP {status} – the times are those of the error page, not of the real page.', { status }));
      return result;
    } finally {
      if (restored) { job.progress(95, t('Turning the profiler off again …')); await dev.setXdebug(version, { enabled: restored.enabled, mode: restored.mode, start: restored.start }).catch(() => {}); }
    }
  }

  runProject(projectId, { url = null, runs = 1 } = {}) {
    const { t } = this;
    const p = this.ctx.devtools.get(projectId);
    url = String(url || (p.urls || [])[0] || '').trim();
    if (!httpUrl(url)) throw this.host.error(400, 'Please enter the address of the page (http://…).');
    return this.runJob(t('Profile: {name}', { name: p.name }), async (job) => this.save(p.id, await this.measure(job, url, this.phpFor(p), { runs, phpProject: this.isPhp(p) })), { key: `profile-${p.id}` });
  }

  /**
   * Eine beliebige Anfrage messen (z. B. aus dem API-Tester, auch POST mit Body). Gehört die Adresse zu einem
   * PHP-Projekt, gibt es ein Xdebug-Profil, sonst die Antwortzeit. Gespeichert unter „req-…“ je Methode und Adresse.
   */
  runRequest({ url, method = 'GET', headers = {}, body = null, projectId = null, runs = 1 } = {}) {
    const { t } = this;
    url = String(url || '').trim();
    if (!httpUrl(url)) throw this.host.error(400, 'Please enter the address of the page (http://…).');
    const m = String(method || 'GET').toUpperCase();
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(m)) throw this.host.error(400, 'Unknown method');
    const p = projectId ? this.ctx.devtools.get(projectId) : this.projectFor(url);
    const key = requestKey(m, url);
    const clean = Object.fromEntries(Object.entries(headers || {}).filter(([k, v]) => /^[\w-]{1,60}$/.test(k) && typeof v === 'string').slice(0, 40));
    return this.runJob(t('Profile: {name}', { name: `${m} ${url}` }), async (job) => this.save(key, { ...(await this.measure(job, url, this.phpFor(p), { runs, method: m, headers: clean, body, phpProject: this.isPhp(p) })), request: key, project: p ? p.id : null }), { key: `profile-${key}` });
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
    // Nie mehr Aufrufe als verlangt: „50 gleichzeitig, 3 Aufrufe“ → 3 gleichzeitig, 3 Aufrufe
    total = Math.max(1, Math.min(1000, Math.round(Number(total)) || 100));
    parallel = Math.max(1, Math.min(50, total, Math.round(Number(parallel)) || 10));
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
    if (url != null && String(url).trim() && !httpUrl(String(url).trim())) throw this.host.error(400, 'Please enter the address of the page (http://…).');
    url = url != null && String(url).trim() ? String(url).trim() : null;
    seconds = Math.max(2, Math.min(60, Number(seconds) || 8));
    requests = Math.max(1, Math.min(100, Math.round(Number(requests)) || 10));
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
          let stdout = ''; child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-2000); }); // lesen, sonst kann eine gesprächige App an der vollen Leitung hängen bleiben
          let buf = '';
          const wsUrl = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(t('Inspector address not found (does the app start?)'))), 20000);
            child.stderr.on('data', (d) => { buf += d; const m = buf.match(/ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/); if (m) { clearTimeout(timer); resolve(m[0]); } });
            child.on('exit', (c) => { clearTimeout(timer); reject(new Error(t('The app ended (code {code}) – {log}', { code: c, log: (buf + stdout).slice(-300) }))); });
          });
          const WebSocket = this.host.lib('ws');
          const ws = new WebSocket(wsUrl);
          await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
          let id = 0; const pending = new Map();
          ws.on('message', (m) => { const j = JSON.parse(m); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
          // Endet die App mitten in der Messung, schließt der Inspektor – offene Befehle scheitern, statt ewig zu warten
          ws.on('close', () => { for (const r of pending.values()) r({ closed: true }); pending.clear(); });
          const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (j) => (j.closed || j.error ? rej(new Error(j.closed ? t('The app ended (code {code}) – {log}', { code: child.exitCode, log: (stdout || buf).slice(-300) }) : j.error.message)) : res(j))); ws.send(JSON.stringify({ id: i, method, params })); });
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
          const all = JSON.parse(fs.readFileSync(out, 'utf8'));
          // Warten auf die nächste Anfrage (select, sleep, Lock) ist Leerlauf, keine Bremse – sonst hieße es „select.select braucht 95 %“
          const idle = all.filter((x) => x.file === '~' && PY_IDLE.test(x.name));
          // Gesamtzeit = Summe der eigenen Zeiten ohne Leerlauf (über alle Threads; das Warten des Mess-Threads zählt nicht mit)
          const rows = all.filter((x) => !idle.includes(x));
          result = { kind: 'python', totalMs: Math.round(rows.reduce((n, x) => n + (x.self || 0), 0)), functions: rows.map((x) => ({ name: x.name, file: x.file, line: x.line, self: Math.round(x.self * 100) / 100, incl: Math.round(x.incl * 100) / 100, calls: x.calls })).filter((x) => !/hostwerk_profile\.py|cProfile|threading\.py|runpy\.py/.test(x.file)), responseMs: times };
        }
      } finally { if (child) { try { killTree(child.pid); } catch { /* already gone */ } } }
      const final = { at: Date.now(), url: target, kind: result.kind, totalMs: result.totalMs, responseMs: result.responseMs, ...appSummary(result, hintKey, (f) => path.basename(f || '')), tree: result.tree || null, profiled: true, app: a.id };
      return this.save(`app-${a.id}`, final);
    }, { key: `profile-app-${a.id}` });
  }
}

/** Hinweis als Schlüssel + Werte statt fertigem Satz (wird beim Abruf in der aktuellen Sprache übersetzt). */
const hintKey = (k, v) => (v ? { k, v } : { k });

async function waitHttp(url, ms, t) { const t0 = Date.now(); for (;;) { try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (r.status) return; } catch { /* not yet */ } if (Date.now() - t0 > ms) throw new Error(t('The app does not answer')); await new Promise((r) => setTimeout(r, 500)); } }
async function hit(url, n, job, t) { const times = []; for (let i = 0; i < n; i++) { const t0 = Date.now(); try { const r = await fetch(url, { signal: AbortSignal.timeout(30000) }); await r.arrayBuffer(); } catch { /* counts anyway */ } times.push(Date.now() - t0); job.progress(30 + (i / n) * 35, t('Call {i}/{n}', { i: i + 1, n })); } return times; }

module.exports = { Profiler, PY_WRAPPER, requestKey, RUNS_KEPT, hintKey };
