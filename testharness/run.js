const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const { createFakeRepo } = require('../backend/test/fakeRepo');
const { startFrontendTestServer } = require('../backend/test/frontendTestServer');

(async () => {
  const repo = createFakeRepo();
  const { base, close } = await startFrontendTestServer(repo, path.join(__dirname, 'site'));

  const virtualConsole = new (require('jsdom').VirtualConsole)();
  let pageErrors = [];
  virtualConsole.on('jsdomError', (e) => { if(!/Could not load/.test(e.message)) pageErrors.push('JSDOM: '+e.message); });
  virtualConsole.on('log', (...args) => console.log(...args));

  const html = fs.readFileSync(path.join(__dirname, 'site', 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: base + '/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.addEventListener('error', (e) => { console.log('WINDOW ERROR:', e.message, e.error && e.error.stack); });
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? new URL(input, base).toString() : input;
        return fetch(url, init);
      };
    }
  });

  await new Promise((resolve) => { dom.window.addEventListener('load', resolve); });
  // The test script does many real sequential HTTP round-trips (one per
  // simulated user action) — poll for completion instead of a fixed delay.
  const deadline = Date.now() + 30000;
  while (dom.window.__testResults === undefined && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }

  const results = dom.window.__testResults;
  console.log('\n=== SUMMARY ===');
  if (!results) {
    console.log('No results captured.');
    console.log('Page errors:', pageErrors);
  } else {
    const failed = results.filter(r => !r.pass);
    console.log(`${results.length - failed.length} / ${results.length} checks passed`);
    if (failed.length) { console.log('\nFAILED:'); failed.forEach(f => console.log(' -', f.label, '|', f.extra)); }
    if (pageErrors.length) console.log('\nPage errors (non-fatal warnings):', pageErrors);
  }
  await close();
  process.exit(results && results.every(r => r.pass) ? 0 : 1);
})().catch(e => { console.error('Harness crashed:', e); process.exit(2); });
