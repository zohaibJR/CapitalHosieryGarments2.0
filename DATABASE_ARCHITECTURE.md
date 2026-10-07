# Database Architecture — Phase 2 (record-level API)

This document describes the persistence architecture introduced in this
phase, including the correctness/safety fixes made after an independent
audit of the first version of this phase (see "Audit fixes" throughout).

## Before

- `GET /api/state` returned the whole app state in one document.
- Every create/edit anywhere in the UI mutated an in-memory JS object on the
  frontend, then `PUT /api/state` overwrote the **entire** corresponding
  MongoDB collections with whatever the browser currently held in memory.
- Risk: a second browser tab/device, or a page left open from earlier, could
  silently overwrite newer data saved from elsewhere.

## After

- `GET /api/state` still exists, unchanged, and is still how the app hydrates
  once per page load.
- `PUT /api/state` is **disabled**. It always responds `410 Gone` and writes
  nothing. The route is kept (rather than deleted outright) only so a stray
  client still pointed at it gets a clear, explicit error instead of a
  generic 404; there is no code path left that can reactivate it short of
  editing `stateRoutes.js`. The frontend's old `persistState()`/
  `schedulePersist()` functions, and the `dataDirty`/`syncTimer` variables
  that drove them, have been removed from `frontend/app.js` entirely — not
  just left unused.
- Every business action calls a dedicated endpoint for exactly the one
  record it is creating, editing, or voiding — see `backend/routes.js` and
  `backend/stateRoutes.js`.
- MongoDB is the authoritative source of truth for every write. The server
  assigns every id, recomputes every item-based transaction's amount from
  qty×price, and re-validates every business rule on **both** create and
  edit — it never trusts a client-supplied total or a client-only
  validation pass.

## Where the code lives

| File | Purpose |
|---|---|
| `backend/models.js` | All Mongoose schemas. Only additive fields: `voided/voidedAt/voidedReason/voidedBy` + `lastTouchedForReturn` on ledger entries, `skuLower` on products, plus `Counter` and `AuditLog`. |
| `backend/ledgerLogic.js` | Pure, framework-free business rules — stock, balances, return eligibility (create **and** edit), amount ceilings (create **and** edit), void safety, box/piece math. |
| `backend/repo.js` | The only code that talks to MongoDB for the new API. Provides `withTransaction` (with a documented fallback) and `touchLedgerEntry` (return-creation concurrency safety — see below). |
| `backend/routes.js` | Ledger/products/cities/customers/vendors/audit routes, written against the `repo` interface, not Mongoose directly. |
| `backend/stateRoutes.js` | `GET /api/state` (unchanged) and `PUT /api/state` (disabled), factored out the same way so both are covered by real HTTP tests. |
| `backend/migrate.js` | One-time, additive, idempotent prep script for an **existing** database. Run once: `node backend/migrate.js`. Also runs automatically (and harmlessly) on every server boot. |
| `backend/server.js` | Unchanged auth/User routes; now requires the files above instead of declaring schemas/state-routes inline. The old `replaceCollection()` helper and the old inline `readState()`/`stripMongo()` were removed as dead code once their only caller (the destructive PUT route) was removed. |
| `testharness/` | Full-stack, real-browser-engine, real-HTTP test suite — **included in this delivery**. |

## Preserving existing IDs

- The frontend's original single global counter is now a MongoDB `Counter`
  document, incremented atomically, seeded (by `migrate.js`, and again on
  every boot) to the highest numeric id already present anywhere.
- Editing an item-based transaction preserves every existing line's
  `lineId` exactly. Only a genuinely new line gets a new id. A
  transaction's own id never changes when it is edited.

## Server-side validation

Every rule that previously existed only in `frontend/app.js` — and, after
this round of fixes, every rule that was previously enforced only on
**edit** — is now enforced on **both create and edit**:

**Amounts** (`validateAmountCreate` / `validateAmountEdit`):
- `wholesale_recovery` ≤ current customer/shop outstanding
- `wholesale_discount` ≤ current customer/shop outstanding
- `retail_payment` ≤ remaining due of its related retail sale
- `retail_discount` ≤ remaining due of its related retail sale
- `vendor_payment` ≤ current vendor payable
- On edit, the transaction's own current amount is excluded from the
  ceiling (never double-counted against itself). On create, there's no
  transaction yet to exclude — the ceiling is simply the current
  outstanding/due/payable.
- A `POST /api/ledger` batch (e.g. a sale plus its paid-at-time-of-sale
  recovery) validates each entry against a **running** ledger including the
  earlier entries already validated in that same batch.
- **The wholesale recovery model is unchanged**: overall customer/shop
  balance only, never invoice-level allocation.

**Returns** (`validateReturnCreate` / `validateReturnEdit`):
- The original sale/purchase must exist and not be voided; must be the
  correct parent type; the referenced `lineId` must actually belong to it;
  the return's `productId` must match that line's product; for wholesale/
  vendor returns, customerId/vendorId must match the parent's.
- Quantity must be a positive whole number.
- Total **active** returns against a line can never exceed its original
  quantity. On edit, the return being edited is excluded from that total
  first.
- A vendor return still can't remove more physical Upper stock than
  available.
- None of this trusts the client's `productId`/`lineId` — always looked up
  against the real parent document.

**Concurrency for returns specifically**: two people creating returns
against the same line near-simultaneously is the one scenario snapshot-read
validation inside a transaction doesn't automatically catch (two
transactions can both read "20 remaining" before either commits). Creating
or editing a return now also calls `repo.touchLedgerEntry()` on the parent
sale/purchase **inside the same transaction**, before validating — a real
write to that document. Two concurrent transactions touching the *same*
parent will conflict at commit time, and MongoDB's
`session.withTransaction()` automatically retries the loser, forcing a
fresh re-read instead of acting on stale data. Covered by the fake-repo
transaction simulation in `routes.test.js` — see "Real MongoDB limitation"
for what this doesn't prove.

## Void / safe delete

`POST /api/ledger/:appId/void` marks a transaction `voided: true` after
three checks in `validateVoid`:

1. **Dependency check**: a sale/purchase can't be voided while an active
   return — or, for retail sales, payment/discount — still references it.
2. **Stock check** (new): for every product/shop the transaction affects,
   would removing its effect take that stock negative given everything
   since? Reuses the same `productStock(..., excludeId)` edit-time
   validation already used, so it automatically covers every type: a
   vendor purchase whose stock was since sold/transferred — blocked; a
   transfer whose Lower stock was since sold — blocked; a positive
   adjustment whose stock was since consumed — blocked (a *negative*
   adjustment can always be voided — undoing a removal only gives stock
   back); anywhere voiding mathematically can't go negative (e.g. voiding a
   sale only ever gives stock back), the check is a no-op by construction.
3. **Balance check** (new, for wholesale sales and vendor purchases
   specifically): because recoveries/payments are overall-balance-level,
   not per-invoice (**unchanged — no invoice-level allocation added**),
   voiding a sale/purchase could leave the customer's balance or vendor's
   payable negative if a recovery/payment already "used up" that amount.
   Both are now checked and blocked if unsafe.

A voided transaction is excluded from History, Excel, and every
stock/balance calculation, but stays visible in that transaction's Change
History (the audit-trail button next to Edit/Void). Opening Balance has no
separate transaction record (it's a Customer/Vendor field), so there's no
separate void for it — correcting/zeroing it is still via Edit Shop/Vendor.

## Concurrency / stale-state protection

- Every edit endpoint accepts an optional `expectedUpdatedAt`; a real
  conflict gets `409` and is not applied.
- **Fixed in this round**: `GET /api/state` previously stripped
  `updatedAt`/`createdAt` from every record (leftover pre-phase-2 code),
  meaning a record loaded via page reload had no `updatedAt` to send back,
  silently skipping its concurrency check. `GET /api/state` now goes
  through the same `repo.readState()` the rest of the API uses, which
  includes `updatedAt` — so concurrency protection now actually works after
  a reload, not just within the session that created a record.

## Transactions (atomicity)

`repo.withTransaction()` uses a real MongoDB session transaction for every
multi-document write (requires a replica set — every Atlas cluster
qualifies, a bare standalone `mongod` does not). If unsupported, `repo.js`
detects it and falls back to sequential writes without a session — a
failure partway through such a write will not auto-rollback on a standalone
deployment. Covered by `routes.test.js`'s "G (no-transaction fallback)".

## Testing

**This sandbox has no access to a real MongoDB server** or the binaries
`mongodb-memory-server` needs (both attempted, both blocked by network
restrictions). Four layers of tests are included in this delivery, all run
from a fresh extraction of this ZIP before packaging:

| Suite | Location | Checks | Proves |
|---|---|---|---|
| Pure business logic | `backend/test/ledgerLogic.test.js` | 30 | Every validation/calculation rule, plain `assert`, no server/DB. |
| HTTP route integration | `backend/test/routes.test.js` | 85 | Real `routes.js`/`stateRoutes.js`, real HTTP, backed by `backend/test/fakeRepo.js` (interface-identical to the real `repo.js`). Covers create/edit/void for every type, every gap fixed this round, 409 concurrency, failure-consistency, and the disabled PUT. |
| Migration planning | `backend/test/migrate.test.js` | 8 | Idempotency; proof it only adds fields or raises the id counter, never renames/regenerates an id. |
| Full-stack end-to-end | `testharness/` (**included** — `cd testharness && npm install && npm test`) | 61 | The real, unmodified `frontend/app.js` in a real browser engine (jsdom), driving every action as a person would, over real HTTP, against the real backend route code, backed by the same fake repository. |

**Total: 184 checks, all reproducible from this ZIP:**
```
cd backend && npm install && npm test        # 30 + 85 + 8 = 123 checks
cd ../testharness && npm install && npm test # 61 checks
```

### Real MongoDB limitation (stated plainly)

None of the above proves Mongoose's actual wire behavior against a real
MongoDB Atlas cluster, or that a real replica set's transaction
retry-on-conflict behavior matches what `repo.js` assumes — only that the
same route/validation code behaves correctly against an interface-identical
in-memory stand-in. Before relying on this in production:

1. Run `node backend/migrate.js` once against the real database (additive
   only — does not delete anything).
2. Manually exercise TEST A–J from the project's checklist against a real
   staging database, particularly the two-concurrent-returns scenario and
   the no-transaction fallback if the target deployment is standalone.

No destructive migration or cleanup was run against any production data —
none exists in this sandbox to run it against.
