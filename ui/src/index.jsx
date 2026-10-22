import { useMemo, useState } from 'react';
import { Gauge, Play, Database, Wand2, ArrowRight, Zap, FolderGit2, History, Timer, Flame, GitCompare, Send, Activity, RefreshCw, AlertTriangle } from 'lucide-react';
import { post, useApi, waitJob, fmtDate, fmtNumber } from '@hostwerk/api';
import { Btn, Seg, Empty, Loading, InfoTip, toast, TileEmpty } from '@hostwerk/ui';
import { AiHint } from '@hostwerk/kit';
import { t } from '@hostwerk/i18n';
import './style.css';

/*
 * Profiler: "Performance" tab on every project (PHP via Xdebug, Node/Python apps via inspector/cProfile) and an overview
 * page with all measurements. The tab replaces the one that used to be built into Hostwerk – same address
 * (#/projects/<id>/leistung), same stored results. New: flame graph, comparing two measurements, measuring any request
 * (also POST with a body – the API tester uses the same) and a small load test against the own network.
 */

const ms = (v) => `${fmtNumber(Math.round((Number(v) || 0) * 10) / 10)} ms`;

/** Flame graph (icicle): every bar is a function, its width the share of the time; click zooms in. */
function FlameGraph({ tree }) {
  const [root, setRoot] = useState(null);
  const top = root || tree;
  const rows = useMemo(() => {
    const out = [];
    const walk = (n, x, w, depth) => {
      if (depth >= 14 || w < 0.004) return;
      (out[depth] = out[depth] || []).push({ n, x, w });
      let cx = x;
      const sum = n.children.reduce((s, c) => s + c.value, 0) || 1;
      const scale = Math.min(1, n.value / sum);
      for (const c of n.children) { const cw = w * (c.value / sum) * scale; walk(c, cx, cw, depth + 1); cx += cw; }
    };
    walk(top, 0, 1, 0);
    return out;
  }, [top]);
  return (
    <div className="card-body stack prof-flame-wrap">
      <div className="row-tight"><span className="tiny muted grow">Width = share of the time. Click a bar to zoom in.</span>{root && <Btn className="xs" onClick={() => setRoot(null)}>Show everything</Btn>}</div>
      <div className="prof-flame" role="group" aria-label="Flame graph">
        {rows.map((row, d) => (
          <div key={d} className="prof-flame-row">
            {row.map(({ n, x, w }, i) => (
              <button type="button" key={i} className="prof-flame-bar" style={{ left: `${x * 100}%`, width: `${w * 100}%` }} title={`${n.name} – ${ms(n.value)}`} aria-label={`${n.name}: ${ms(n.value)}`} onClick={() => setRoot(n === top ? null : n)}>
                {w > 0.06 ? n.name : ''}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Before → after: total time, database and the functions that changed most. */
function Compare({ before, after }) {
  const c = useMemo(() => compareRuns(before, after), [before, after]);
  const sign = (v) => (v > 0 ? `+${ms(v)}` : `−${ms(Math.abs(v))}`);
  const cls = (v) => (v > 0 ? 'c-err' : v < 0 ? 'c-ok' : 'muted');
  return (
    <div className="card">
      <div className="card-head"><GitCompare size={16} /><h3>Before and after</h3><span className="tiny muted">{fmtDate(before.at)} → {fmtDate(after.at)}</span></div>
      <div className="card-body row prof-facts">
        <div><div className="tiny muted">Total</div><div className="bold">{ms(c.totalMs.before)} → {ms(c.totalMs.after)} <span className={cls(c.totalMs.delta)}>{sign(c.totalMs.delta)}{c.totalMs.pct != null ? ` (${c.totalMs.pct > 0 ? '+' : ''}${c.totalMs.pct} %)` : ''}</span></div></div>
        <div><div className="tiny muted">Database</div><div className="bold">{ms(c.dbMs.before)} → {ms(c.dbMs.after)} <span className={cls(c.dbMs.delta)}>{sign(c.dbMs.delta)}</span></div></div>
      </div>
      {c.functions.length === 0 ? <TileEmpty text="No function changed noticeably." /> : (
        <table className="table prof-table"><thead><tr><th>Function</th><th className="num">before</th><th className="num">after</th><th className="num">change</th></tr></thead><tbody>
          {c.functions.map((f, i) => <tr key={i}><td><div className="mono small ellipsis" title={f.name}>{f.name}</div><div className="tiny muted ellipsis">{(f.file || '').split(/[\\/]/).slice(-2).join('/')}</div></td><td className="num small">{ms(f.before)}</td><td className="num small">{ms(f.after)}</td><td className={`num small ${cls(f.delta)}`}>{sign(f.delta)}</td></tr>)}
        </tbody></table>
      )}
    </div>
  );
}
/** Same as server/parsers.js compare() – kept in the interface so comparing needs no extra request. */
function compareRuns(before, after, limit = 20) {
  const d = (a, b) => ({ before: a, after: b, delta: Math.round((b - a) * 100) / 100, pct: a ? Math.round(((b - a) / a) * 100) : null });
  const key = (x) => `${x.name}|${x.file || ''}`;
  const map = (r) => { const m = new Map(); for (const x of [...((r && r.bySelf) || []), ...((r && r.byIncl) || [])]) if (!m.has(key(x))) m.set(key(x), x); return m; };
  const a = map(before); const b = map(after);
  const functions = [...new Set([...a.keys(), ...b.keys()])].map((k) => { const x = a.get(k); const y = b.get(k); const base = x || y; return { name: base.name, file: base.file, before: x ? x.self : 0, after: y ? y.self : 0, delta: Math.round(((y ? y.self : 0) - (x ? x.self : 0)) * 100) / 100 }; }).filter((x) => x.delta !== 0).sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta)).slice(0, limit);
  return { totalMs: d(Number(before.totalMs) || 0, Number(after.totalMs) || 0), dbMs: d(Math.round(Number(before.dbMs) || 0), Math.round(Number(after.dbMs) || 0)), functions };
}

/** Result of one measurement: key figures, the slowest functions, flame graph, hints, comparison and an AI explanation. */
function Result({ r, runsKey }) {
  const [view, setView] = useState('self');
  const runs = useApi(runsKey ? `/profiler/runs/${encodeURIComponent(runsKey)}` : null, [runsKey, r.at], { live: false });
  const [cmp, setCmp] = useState('');
  const older = (runs.data || []).filter((x) => x.at !== r.at);
  const other = older.find((x) => String(x.at) === cmp);
  const list = (view === 'self' ? r.bySelf : view === 'incl' ? r.byIncl : view === 'db' ? r.db : r.io) || [];
  const max = Math.max(1, ...list.map((f) => (view === 'self' ? f.self : f.incl)));
  const facts = [
    ['Total', `${r.totalMs} ms`],
    ['Response', `${(r.responseMs || []).join(' / ')} ms`],
    ['Database', r.profiled ? t('{ms} ms · {n} queries', { ms: Math.round(r.dbMs || 0), n: r.dbCalls || 0 }) : '–'],
    ['Functions', r.profiled ? r.functions : '–'],
    ['Memory', r.memory ? `${Math.round(r.memory / 1048576)} MB` : '–'],
    ['HTTP', r.status || '–'],
  ];
  const views = [{ id: 'self', label: 'Own time' }, { id: 'incl', label: 'Total' }, { id: 'db', label: t('Database ({n})', { n: (r.db || []).length }), icon: Database }, { id: 'io', label: 'External/files' }, ...(r.tree ? [{ id: 'flame', label: 'Flame graph', icon: Flame }] : [])];
  return (
    <div className="stack">
      <div className="grid split-side">
        <div className="stack">
          <div className="card">
            <div className="card-body row prof-facts">
              {facts.map(([k, v]) => <div key={k}><div className="tiny muted">{k}</div><div className="bold">{v}</div></div>)}
              <div className="right tiny muted">{r.method && r.method !== 'GET' ? `${r.method} · ` : ''}{fmtDate(r.at)}</div>
            </div>
          </div>
          {r.profiled && (
            <div className="card">
              <div className="card-head"><Seg value={view} onChange={setView} options={views} /></div>
              {view === 'flame' ? <FlameGraph tree={r.tree} /> : list.length === 0 ? <TileEmpty text="Nothing in this view." /> : (
                <table className="table prof-table"><thead><tr><th>Function</th><th className="num">Calls</th><th className="num">{view === 'self' ? 'own ms' : 'total ms'}</th><th className="prof-bar-col" /></tr></thead><tbody>
                  {list.map((f, i) => { const v = view === 'self' ? f.self : f.incl; return <tr key={i}><td><div className="mono small ellipsis" title={f.name}>{f.name}</div><div className="tiny muted ellipsis" title={f.file}>{(f.file || '').split(/[\\/]/).slice(-2).join('/')}</div></td><td className="num small">{f.calls}</td><td className="num small">{v}</td><td><div className="bar"><div style={{ width: `${(v / max) * 100}%` }} /></div></td></tr>; })}
                </tbody></table>
              )}
            </div>
          )}
        </div>
        <div className="stack">
          <div className="card"><div className="card-head"><Wand2 size={16} /><h3>What slows it down</h3></div><div className="card-body stack prof-hints">{(r.hints || []).map((h, i) => <div key={i} className="small row-tight"><ArrowRight size={13} className="prof-noshrink" />{h}</div>)}</div></div>
          {older.length > 0 && (
            <div className="card">
              <div className="card-head"><GitCompare size={16} /><h3>Compare</h3><InfoTip title="Compare">Pick an earlier measurement – you see what got faster or slower, down to the function. The last 10 measurements are kept.</InfoTip></div>
              <div className="card-body"><select className="select" value={cmp} aria-label="Earlier measurement" onChange={(e) => setCmp(e.target.value)}><option value="">Earlier measurement …</option>{older.map((x) => <option key={x.at} value={String(x.at)}>{`${fmtDate(x.at)} · ${x.totalMs} ms`}</option>)}</select></div>
            </div>
          )}
          {r.profiled && <AiHint item="profile" title="AI explains the profile" input={`Page ${r.url}: ${r.totalMs} ms total, database ${Math.round(r.dbMs || 0)} ms in ${r.dbCalls || 0} queries, memory ${Math.round((r.memory || 0) / 1048576)} MB.\nOwn time:\n${(r.bySelf || []).slice(0, 12).map((f) => `- ${f.name} (${f.file}): ${f.self} ms own, ${f.incl} ms total, ${f.calls}x`).join('\n')}\nDatabase:\n${(r.db || []).slice(0, 8).map((f) => `- ${f.name}: ${f.incl} ms, ${f.calls}x`).join('\n')}\nHints: ${(r.hints || []).join(' ')}`} />}
        </div>
      </div>
      {other && <Compare before={other} after={r} />}
    </div>
  );
}

/** Tab on a project: take a PHP profile or an app profile. */
export function ProfileTab({ p }) {
  const last = useApi(`/projects/${p.id}/profile`, [p.id], { live: false });
  const [url, setUrl] = useState(p.urls[0] || '');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(p.id);
  const run = async () => {
    setBusy(true);
    try { const r = await post(`/projects/${p.id}/profile`, { url }); const j = await waitJob(r.job); last.setData(j.result); setKey(p.id); toast.success(j.result.profiled ? t('Profile: {ms} ms', { ms: j.result.totalMs }) : t('Response time {ms} ms (no PHP profile)', { ms: j.result.totalMs })); } catch (e) { toast.error(e); }
    setBusy(false);
  };
  const runApp = async (appId) => {
    setBusy(true);
    try { const r = await post(`/apps/${appId}/profile`, { url: url || undefined, seconds: 8, requests: 10 }); const j = await waitJob(r.job); last.setData(j.result); setKey(`app-${appId}`); toast.success(t('App profile ({kind}): {ms} ms measured', { kind: j.result.kind, ms: j.result.totalMs })); } catch (e) { toast.error(e); }
    setBusy(false);
  };
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><Gauge size={16} /><h3>Find slow pages</h3><span className="small muted">PHP profile with one click (Xdebug)</span>
          <InfoTip title="How it measures">PHP: Hostwerk turns on the Xdebug profiler just for this call and reads the cachegrind file. Node/Python apps: a copy of the app runs briefly on its own port under the inspector or cProfile and the address is called ten times – the real app stays untouched.</InfoTip>
        </div>
        <div className="card-body">
          <div className="row prof-wrap">
            <input className="input mono grow" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:8080/project/page" aria-label="Address of the page" />
            <Btn className="primary" icon={Play} busy={busy} onClick={run}>Take profile (PHP)</Btn>
            {(p.appIds || []).map((a) => <Btn key={a} icon={Play} busy={busy} onClick={() => runApp(a)}>{t('App profile “{name}” (Node/Python)', { name: a })}</Btn>)}
          </div>
        </div>
      </div>
      {last.error && !last.data ? <Empty icon={AlertTriangle} title="Could not load the last measurement" text={last.error} action={<Btn icon={RefreshCw} onClick={() => last.reload()}>Try again</Btn>} /> : last.data && <Result r={last.data} runsKey={key} />}
    </div>
  );
}

/** Any request – e.g. a POST from the API tester – with method, body and headers as JSON. */
function RequestCard() {
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState(null);
  const run = async () => {
    setBusy(true);
    try {
      const isJson = /^\s*[[{]/.test(body);
      const j = await waitJob((await post('/profiler/request', { url, method, body: body || null, headers: body ? { 'content-type': isJson ? 'application/json' : 'application/x-www-form-urlencoded' } : {} })).job);
      setR(j.result);
    } catch (e) { toast.error(e); }
    setBusy(false);
  };
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><Send size={16} /><h3>Measure a request</h3><InfoTip title="Measure a request">Any address with GET, POST, PUT … and a body. If it belongs to a PHP project, you get a full profile, otherwise the response time. The API tester sends its requests here too.</InfoTip></div>
        <form className="card-body stack prof-gap" onSubmit={(e) => { e.preventDefault(); run(); }}>
          <div className="row-tight prof-wrap">
            <select className="select" value={method} aria-label="Method" onChange={(e) => setMethod(e.target.value)}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}</select>
            <input className="input mono grow" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://shop.localhost/api/orders" aria-label="Address of the page" />
            <Btn className="primary" icon={Play} busy={busy} type="submit">Measure</Btn>
          </div>
          {method !== 'GET' && <textarea className="input mono" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder='{"id": 1}' aria-label="Body" />}
        </form>
      </div>
      {r && <Result r={r} runsKey={r.request} />}
    </div>
  );
}

/** Small load test: N calls, several at once – only against the own computer or network. */
function LoadCard() {
  const last = useApi('/profiler/load', [], { live: false });
  const [url, setUrl] = useState('');
  const [parallel, setParallel] = useState(10);
  const [total, setTotal] = useState(100);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { const j = await waitJob((await post('/profiler/load', { url, parallel, total })).job); last.setData(j.result); } catch (e) { toast.error(e); }
    setBusy(false);
  };
  const r = last.data;
  return (
    <div className="card">
      <div className="card-head"><Activity size={16} /><h3>Small load test</h3><InfoTip title="Small load test">Calls the address many times, several at once, and measures how the times grow. Only against this computer or your own network – never other people’s servers.</InfoTip></div>
      <form className="card-body stack prof-gap" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <div className="row-tight prof-wrap">
          <input className="input mono grow" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://shop.localhost/" aria-label="Address of the page" />
          <label className="tiny muted" htmlFor="prof-par">At once</label><input id="prof-par" className="input prof-num" type="number" min="1" max="50" value={parallel} onChange={(e) => setParallel(Number(e.target.value) || 1)} />
          <label className="tiny muted" htmlFor="prof-tot">Calls</label><input id="prof-tot" className="input prof-num" type="number" min="1" max="1000" value={total} onChange={(e) => setTotal(Number(e.target.value) || 1)} />
          <Btn className="primary" icon={Play} busy={busy} type="submit">Start</Btn>
        </div>
        {r && (
          <div className="row prof-facts">
            {[['Median', ms(r.p50)], ['95 %', ms(r.p95)], ['Slowest', ms(r.max)], ['Per second', fmtNumber(r.rps)], ['Failed', `${r.failed} / ${r.total}`]].map(([k, v]) => <div key={k}><div className="tiny muted">{k}</div><div className="bold">{v}</div></div>)}
            <div className="right tiny muted ellipsis">{r.url} · {fmtDate(r.at)}</div>
          </div>
        )}
      </form>
    </div>
  );
}

/** Overview page: every project with its last measurement; pick one to measure. Plus requests and the load test. */
function ProfilerPage({ path = [] }) {
  const projects = useApi('/projects', [], { live: false });
  const hist = useApi('/profiler/history', [], { live: false });
  const [tab, setTab] = useState('projects');
  const sel = path[0] || null;
  const list = projects.data || [];
  const p = sel && list.find((x) => x.id === sel);
  const last = new Map((hist.data || []).filter((h) => h.project).map((h) => [h.project, h]));
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1><Gauge /> Profiler</h1>
          <p>Find out why a page or app is slow – which functions and database queries take the time.</p>
        </div>
      </div>
      {!p && <div className="mb"><Seg value={tab} onChange={setTab} options={[{ id: 'projects', label: 'Projects', icon: FolderGit2 }, { id: 'request', label: 'Request', icon: Send }, { id: 'load', label: 'Load test', icon: Activity }]} /></div>}
      {!p && tab === 'request' ? <RequestCard /> : !p && tab === 'load' ? <LoadCard /> : projects.error && !projects.data ? <Empty icon={AlertTriangle} title="Could not load the projects" text={projects.error} action={<Btn icon={RefreshCw} onClick={() => projects.reload()}>Try again</Btn>} /> : !projects.data ? <Loading /> : list.length === 0 ? <Empty icon={FolderGit2} title="No projects yet" text="Profiles are taken per project. Create or import a project first." action={<a className="btn primary" href="#/projects">Projects</a>} /> : (
        <div className="grid split-side prof-top">
          <div className="stack">
            {p ? <><div className="row-tight"><a className="btn ghost sm" href="#/ext/profiler">All projects</a><b>{p.name}</b></div><ProfileTab p={p} /></> : (
              <div className="card">
                <div className="card-head"><FolderGit2 size={16} /><h3>Projects</h3></div>
                {list.map((x) => {
                  const h = last.get(x.id);
                  return (
                    <a key={x.id} className="list-item prof-link" href={`#/ext/profiler/${encodeURIComponent(x.id)}`}>
                      <Zap size={15} className="muted" />
                      <div className="grow prof-min"><div className="bold ellipsis">{x.name}</div><div className="tiny muted ellipsis">{h ? `${h.totalMs} ms · ${fmtDate(h.at)}` : t('Not measured yet')}</div></div>
                      <ArrowRight size={14} className="muted" />
                    </a>
                  );
                })}
              </div>
            )}
          </div>
          <div className="card">
            <div className="card-head"><History size={16} /><h3>Latest measurements</h3></div>
            {hist.error && !hist.data ? <div className="card-body small c-err">{hist.error}</div> : !hist.data ? <Loading /> : hist.data.length === 0 ? <TileEmpty text="Nothing measured yet." /> : hist.data.slice(0, 12).map((h) => (
              <div key={h.key} className="list-item">
                <Timer size={15} className="muted" />
                <div className="grow prof-min"><div className="small bold ellipsis">{h.project || h.app || h.request}</div><div className="tiny muted ellipsis">{h.hint}</div></div>
                <span className="badge">{h.totalMs} ms</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default {
  pages: { main: ProfilerPage },
  slots: {
    // Same id as the former built-in tab, so old links (#/projects/<id>/leistung) keep working
    'project.tabs': [{ id: 'leistung', title: 'Performance', icon: Zap, Component: ProfileTab, order: 70 }],
  },
  // Kein festes Kürzel – wer will, legt eins unter Einstellungen → Allgemein → Tastenkürzel fest
  shortcuts: [{ id: 'open', title: 'Open the profiler', run: () => { location.hash = '/ext/profiler'; } }],
};
