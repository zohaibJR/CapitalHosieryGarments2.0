/* =====================================================================
   stateRoutes.js — the two /api/state routes, factored out (same
   repo-driven pattern as routes.js) so they can be exercised with real
   HTTP requests in tests, not just read by eye.
   ---------------------------------------------------------------------
   GET  /api/state  — unchanged: full read-only snapshot, used once per
                       page load to hydrate the app.
   PUT  /api/state  — DISABLED. It used to overwrite entire collections
                       with whatever the calling browser held in memory.
                       It now always responds 410 Gone and writes nothing,
                       so there is no destructive full-state write path
                       left anywhere in this API.
===================================================================== */
const express = require('express');

function createStateRouter(repo) {
  const router = express.Router();

  router.get('/state', async (_req, res, next) => {
    try { res.json(await repo.readState()); }
    catch (error) { next(error); }
  });

  router.put('/state', (_req, res) => {
    res.status(410).json({
      error: 'PUT /api/state has been disabled. Every write now goes through the record-level endpoints under /api/ (see DATABASE_ARCHITECTURE.md).'
    });
  });

  return router;
}

module.exports = { createStateRouter };
