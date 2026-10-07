const express = require('express');
const http = require('http');
const { createApiRouter } = require('../routes');
const { createStateRouter } = require('../stateRoutes');

function startTestServer(repo) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, res, next) => { req.user = { username: 'test-user' }; next(); }); // fake auth
  app.use('/api', createStateRouter(repo));
  app.use('/api', createApiRouter(repo));
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ error: error.message || 'Server error', current: error.current });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        base: `http://127.0.0.1:${port}/api`,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}
module.exports = { startTestServer };
