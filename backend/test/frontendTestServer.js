/* Combined static-file + API server used for full frontend<->backend
   integration testing: serves the real frontend files AND the real
   routes.js API (backed by the fake in-memory repo), all on one port,
   so app.js's own fetch calls exercise the exact same route code the
   production server uses — just without a live MongoDB underneath. */
const express = require('express');
const path = require('path');
const { createApiRouter } = require('../routes');
const { createStateRouter } = require('../stateRoutes');

function startFrontendTestServer(repo, frontendDir) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, res, next) => { req.user = { username: 'test-user' }; next(); });
  // Test-only hook: lets the browser-side test script simulate a write failure
  // to exercise the failure-consistency path (TEST G) over real HTTP, without
  // the test script needing direct access to the Node-side repo object.
  app.post('/api/__debug/failNextInsert', (req, res) => { repo._failNextInsertLedger(); res.json({ ok: true }); });
  app.use('/api', createStateRouter(repo));
  app.use('/api', createApiRouter(repo));
  app.use(express.static(frontendDir));
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ error: error.message || 'Server error', current: error.current });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, base: `http://127.0.0.1:${port}`, close: () => new Promise(r => server.close(r)) });
    });
  });
}
module.exports = { startFrontendTestServer };
