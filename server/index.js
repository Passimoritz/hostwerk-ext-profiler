'use strict';
/*
 * Native part of the profiler extension (SDK 2.7). Same API paths as when it was built in, so nothing else changes:
 *   GET/POST /api/projects/:id/profile   PHP profile of a project page (POST starts a job)
 *   GET/POST /api/apps/:id/profile       Node/Python app profile
 *   GET      /api/profiler/history       all stored results, newest first
 *   GET      /api/profiler/runs/:key     the last measurements of one project / app ("app-<id>") / request ("req-…")
 *   POST     /api/profiler/request       { url, method, headers, body, projectId } → { job } – any request, also POST
 *   GET/POST /api/profiler/load          last load test / { url, parallel, total, method } → { job } (own network only)
 * Other extensions (e.g. the API tester) use ctx.profiler.runRequest({ url, method, headers, body }) directly.
 */
const { Profiler } = require('./runners');

function activate(host) {
  const p = new Profiler(host);
  host.provide('profiler', p);
  const r = host.router;
  r.get('/projects/:id/profile', (req, res) => res.json(p.lastProject(req.params.id)));
  r.post('/projects/:id/profile', (req, res) => res.json({ job: p.runProject(req.params.id, req.body || {}).id }));
  r.get('/apps/:id/profile', (req, res) => res.json(p.lastApp(req.params.id)));
  r.post('/apps/:id/profile', (req, res) => res.json({ job: p.runApp(req.params.id, req.body || {}).id }));
  r.get('/profiler/history', (req, res) => res.json(p.history()));
  r.get('/profiler/runs/:key', (req, res) => res.json(p.runs(req.params.key)));
  r.post('/profiler/request', (req, res) => res.json({ job: p.runRequest(req.body || {}).id }));
  r.get('/profiler/load', (req, res) => res.json(p.read('load-last.json')));
  r.post('/profiler/load', (req, res) => res.json({ job: p.runLoad(req.body || {}).id }));
}

module.exports = { activate };
