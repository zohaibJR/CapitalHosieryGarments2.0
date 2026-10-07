# Full-stack test harness

This runs the real, unmodified `frontend/app.js` in a headless browser
(jsdom), driving every on-screen action (clicking buttons, filling forms,
waiting for responses) exactly as a person would — over real HTTP, against
the real backend route code (`../backend/routes.js`, `../backend/stateRoutes.js`).

It does **not** use a live MongoDB. The HTTP server underneath is backed by
`../backend/test/fakeRepo.js`, an in-memory implementation of the exact same
repository interface `../backend/repo.js` (the real MongoDB-backed
implementation) provides, so the route/validation code under test is
identical to what runs in production — only the database connection itself
is swapped out. See `../DATABASE_ARCHITECTURE.md` for the full explanation
and its honest limitations.

## Run it

```
cd testharness
npm install
npm test
```

(`npm install` only needs `jsdom`, no MongoDB, no network access, no other
part of the project needs to be running.)

Expect output like:

```
=== SUMMARY ===
59 / 59 checks passed
```

## Files

- `run.js` — starts the fake-repo-backed server, boots jsdom pointed at it, waits for the test script to finish, prints the results.
- `site/` — a copy of `frontend/` (plus a stub for the CDN-hosted Excel library, and `site/test.js`, the actual test script, appended as a script tag).
- `site/test.js` — the test script. Calls the real `app.js` functions (`saveNewProduct()`, `saveWholesaleSale()`, `openEditItemsTxn()`, `confirmVoidLedger()`, etc.) in sequence, exactly as clicking through the UI would, then asserts on the results — both the in-browser state and, via `fetch('/api/state')`, what's actually durable in the (fake) database.

If you change `frontend/app.js`, re-copy it into `site/app.js` before
re-running (`cp ../frontend/*.js ../frontend/*.css ../frontend/index.html site/` from this directory, keeping `site/config.js` and `site/test.js` as they are), since this is a snapshot taken for testing, not a symlink.
