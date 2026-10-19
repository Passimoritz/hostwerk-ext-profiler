import { useState } from 'react';
import { Gauge, Play, Database, Wand2, ArrowRight, Zap, FolderGit2, History, Timer } from 'lucide-react';
import { post, useApi, waitJob, fmtDate } from '@hostwerk/api';
import { Btn, Seg, Empty, Loading, InfoTip, toast } from '@hostwerk/ui';
import { AiHint } from '@hostwerk/kit';
import { t } from '@hostwerk/i18n';

/*
 * Profiler: "Performance" tab on every project (PHP via Xdebug, Node/Python apps via inspector/cProfile) and an overview
 * page with all measurements. The tab replaces the one that used to be built into Hostwerk – same address
 * (#/projects/<id>/leistung), same stored results.
 */

/** Result of one measurement: key figures, the slowest functions, hints and an AI explanation. */
function Result({ r }) {
  const [view, setView] = useState('self');
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
  return (
    <div className="grid split-side">
      <div className="stack">
        <div className="card">
          <div className="card-body row" style={{ gap: 18, flexWrap: 'wrap' }}>
            {facts.map(([k, v]) => <div key={k}><div className="tiny muted">{k}</div><div className="bold">{v}</div></div>)}
            <div className="right tiny muted">{fmtDate(r.at)}</div>
          </div>
        </div>
        {r.profiled && (
          <div className="card">
            <div className="card-head"><Seg value={view} onChange={setView} options={[{ id: 'self', label: 'Own time' }, { id: 'incl', label: 'Total' }, { id: 'db', label: t('Database ({n})', { n: (r.db || []).length }), icon: Database }, { id: 'io', label: 'External/files' }]} /></div>
            {list.length === 0 ? <div className="card-body small muted">Nothing in this view.</div> : (
              <table className="table prof-table"><thead><tr><th>Function</th><th className="num">Calls</th><th className="num">{view === 'self' ? 'own ms' : 'total ms'}</th><th style={{ width: 160 }} /></tr></thead><tbody>
                {list.map((f, i) => { const ms = view === 'self' ? f.self : f.incl; return <tr key={i}><td><div className="mono small ellipsis" title={f.name}>{f.name}</div><div className="tiny muted ellipsis" title={f.file}>{(f.file || '').split(/[\\/]/).slice(-2).join('/')}</div></td><td className="num small">{f.calls}</td><td className="num small">{ms}</td><td><div className="bar"><div style={{ width: `${(ms / max) * 100}%` }} /></div></td></tr>; })}
              </tbody></table>
            )}
          </div>
        )}
      </div>
      <div className="stack">
        <div className="card"><div className="card-head"><Wand2 size={16} /><h3>What slows it down</h3></div><div className="card-body stack" style={{ gap: 6 }}>{(r.hints || []).map((h, i) => <div key={i} className="small row-tight"><ArrowRight size={13} style={{ flexShrink: 0 }} />{h}</div>)}</div></div>
        {r.profiled && <AiHint item="profile" title="AI explains the profile" input={`Page ${r.url}: ${r.totalMs} ms total, database ${Math.round(r.dbMs || 0)} ms in ${r.dbCalls || 0} queries, memory ${Math.round((r.memory || 0) / 1048576)} MB.\nOwn time:\n${(r.bySelf || []).slice(0, 12).map((f) => `- ${f.name} (${f.file}): ${f.self} ms own, ${f.incl} ms total, ${f.calls}x`).join('\n')}\nDatabase:\n${(r.db || []).slice(0, 8).map((f) => `- ${f.name}: ${f.incl} ms, ${f.calls}x`).join('\n')}\nHints: ${(r.hints || []).join(' ')}`} />}
      </div>
    </div>
  );
}

/** Tab on a project: take a PHP profile or an app profile. */
export function ProfileTab({ p }) {
  const last = useApi(`/projects/${p.id}/profile`, [p.id], { live: false });
  const [url, setUrl] = useState(p.urls[0] || '');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { const r = await post(`/projects/${p.id}/profile`, { url }); const j = await waitJob(r.job); last.setData(j.result); toast.success(j.result.profiled ? t('Profile: {ms} ms', { ms: j.result.totalMs }) : t('Response time {ms} ms (no PHP profile)', { ms: j.result.totalMs })); } catch (e) { toast.error(e); }
    setBusy(false);
  };
  const runApp = async (appId) => {
    setBusy(true);
    try { const r = await post(`/apps/${appId}/profile`, { url: url || undefined, seconds: 8, requests: 10 }); const j = await waitJob(r.job); last.setData(j.result); toast.success(t('App profile ({kind}): {ms} ms measured', { kind: j.result.kind, ms: j.result.totalMs })); } catch (e) { toast.error(e); }
    setBusy(false);
  };
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><Gauge size={16} /><h3>Find slow pages</h3><span className="small muted">PHP profile with one click (Xdebug)</span>
          <InfoTip title="How it measures">PHP: Hostwerk turns on the Xdebug profiler just for this call and reads the cachegrind file. Node/Python apps: a copy of the app runs briefly on its own port under the inspector or cProfile and the address is called ten times – the real app stays untouched.</InfoTip>
        </div>
        <div className="card-body">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <input className="input mono grow" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:8080/project/page" aria-label="Address of the page" />
            <Btn className="primary" icon={Play} busy={busy} onClick={run}>Take profile (PHP)</Btn>
            {(p.appIds || []).map((a) => <Btn key={a} icon={Play} busy={busy} onClick={() => runApp(a)}>{t('App profile “{name}” (Node/Python)', { name: a })}</Btn>)}
          </div>
        </div>
      </div>
      {last.data && <Result r={last.data} />}
    </div>
  );
}

/** Overview page: every project with its last measurement; pick one to measure. */
function ProfilerPage({ path = [] }) {
  const projects = useApi('/projects', [], { live: false });
  const hist = useApi('/profiler/history', [], { live: false });
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
      {!projects.data ? <Loading /> : list.length === 0 ? <Empty icon={FolderGit2} title="No projects yet" text="Profiles are taken per project. Create or import a project first." action={<a className="btn primary" href="#/projects">Projects</a>} /> : (
        <div className="grid split-side" style={{ alignItems: 'start' }}>
          <div className="stack">
            {p ? <><div className="row-tight"><a className="btn ghost sm" href="#/ext/profiler">All projects</a><b>{p.name}</b></div><ProfileTab p={p} /></> : (
              <div className="card">
                <div className="card-head"><FolderGit2 size={16} /><h3>Projects</h3></div>
                {list.map((x) => {
                  const h = last.get(x.id);
                  return (
                    <a key={x.id} className="list-item" href={`#/ext/profiler/${encodeURIComponent(x.id)}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                      <Zap size={15} className="muted" />
                      <div className="grow" style={{ minWidth: 0 }}><div className="bold ellipsis">{x.name}</div><div className="tiny muted ellipsis">{h ? `${h.totalMs} ms · ${fmtDate(h.at)}` : t('Not measured yet')}</div></div>
                      <ArrowRight size={14} className="muted" />
                    </a>
                  );
                })}
              </div>
            )}
          </div>
          <div className="card">
            <div className="card-head"><History size={16} /><h3>Latest measurements</h3></div>
            {!hist.data ? <Loading /> : hist.data.length === 0 ? <div className="card-body small muted">Nothing measured yet.</div> : hist.data.slice(0, 12).map((h) => (
              <div key={h.key} className="list-item">
                <Timer size={15} className="muted" />
                <div className="grow" style={{ minWidth: 0 }}><div className="small bold ellipsis">{h.project || h.app}</div><div className="tiny muted ellipsis">{h.hint}</div></div>
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
};
