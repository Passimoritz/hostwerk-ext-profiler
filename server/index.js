'use strict';
/*
 * Native part of the profiler extension (SDK 2.7). Same API paths as when it was built in, so nothing else changes:
 *   GET/POST /api/projects/:id/profile   PHP profile of a project page (POST starts a job)
 *   GET/POST /api/apps/:id/profile       Node/Python app profile
 *   GET      /api/profiler/history       all stored results, newest first
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
}

module.exports = { activate };
