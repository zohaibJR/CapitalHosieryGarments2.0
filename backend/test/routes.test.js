const assert = require('assert');
const { createFakeRepo } = require('./fakeRepo');
const { startTestServer } = require('./testServer');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fail++; console.error('FAIL:', name, '-', e.message); }
}
async function req(base, method, path, body, extraHeaders) {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, ok: res.ok, body: json };
}

async function run() {
  // ===================== TEST A — CREATE OPERATIONS =====================
  {
    const repo = createFakeRepo();
    const { base, close } = await startTestServer(repo);
    try {
      const city = await req(base, 'POST', '/cities', { name: 'Lahore' });
      await t('A: create city', () => assert.equal(city.status, 201));

      const prod = await req(base, 'POST', '/products', { sku: 'MT-1', name: 'Mens Trunk', category: 'Men', season: 'Summer', cost: 100, wsale: 150, retail: 200, packSize: 6, openingStock: { shop: 'Upper', qty: 120, boxesRaw: '20' } });
      await t('A: create product with opening stock (assigned server id, atomic w/ adjustment)', () => {
        assert.equal(prod.status, 201);
        assert.ok(prod.body.product.id.startsWith('P'));
        assert.equal(prod.body.adjustment.type, 'adjustment');
        assert.equal(prod.body.adjustment.qty, 120);
      });
      const pid = prod.body.product.id;

      const dup = await req(base, 'POST', '/products', { sku: 'mt-1', name: 'Dup', category: 'x', season: 'y', cost: 1, wsale: 1, retail: 1 });
      await t('A: duplicate SKU rejected case-insensitively', () => assert.equal(dup.status, 400));

      const shop = await req(base, 'POST', '/customers', { city: 'Lahore', shop: 'ABC Shop', owner: 'Zafar', opening: 50000, creditLimit: 0 });
      await t('A: create wholesale shop', () => assert.equal(shop.status, 201));
      const cid = shop.body.id;

      const vendor = await req(base, 'POST', '/vendors', { name: 'Sialkot Textiles', opening: 0 });
      await t('A: create vendor', () => assert.equal(vendor.status, 201));
      const vid = vendor.body.id;

      const sale = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_sale', customerId: cid, items: [{ productId: pid, qty: 30, price: 150 }] }] });
      await t('A: create wholesale sale (product-based)', () => { assert.equal(sale.status, 201); assert.equal(sale.body.entries[0].amount, 4500); assert.ok(sale.body.entries[0].items[0].lineId); });

      const aoSale = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_sale', customerId: cid, items: [], amountOnly: true, amount: 5000 }] });
      await t('A: create amount-only wholesale sale', () => { assert.equal(aoSale.status, 201); assert.equal(aoSale.body.entries[0].amount, 5000); assert.equal(aoSale.body.entries[0].items.length, 0); });

      const rec = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_recovery', customerId: cid, amount: 1000, method: 'Cash' }] });
      await t('A: create recovery', () => assert.equal(rec.status, 201));

      const purchase = await req(base, 'POST', '/ledger', { entries: [{ type: 'vendor_purchase', vendorId: vid, items: [{ productId: pid, qty: 100, price: 100 }], invoiceRef: 'INV-1' }] });
      await t('A: create vendor purchase', () => assert.equal(purchase.status, 201));

      const rsale = await req(base, 'POST', '/ledger', { entries: [{ type: 'retail_sale', customerName: 'Walk-in', shop: 'Lower', items: [{ productId: pid, qty: 5, price: 200 }] }] });
      await t('A: create retail sale (needs Lower stock)', () => assert.equal(rsale.status, 400)); // no Lower stock yet -> expect rejection

      const xfer = await req(base, 'POST', '/ledger', { entries: [{ type: 'stock_transfer', productId: pid, qty: 20 }] });
      await t('A: create transfer', () => assert.equal(xfer.status, 201));

      const rsale2 = await req(base, 'POST', '/ledger', { entries: [{ type: 'retail_sale', customerName: 'Walk-in', shop: 'Lower', items: [{ productId: pid, qty: 5, price: 200 }] }] });
      await t('A: create retail sale after transfer', () => assert.equal(rsale2.status, 201));

      const wret = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_return', customerId: cid, productId: pid, saleId: sale.body.entries[0].id, lineId: sale.body.entries[0].items[0].lineId, qty: 5, amount: 750 }] });
      await t('A: create wholesale return', () => assert.equal(wret.status, 201));

      const adj = await req(base, 'POST', '/ledger', { entries: [{ type: 'adjustment', productId: pid, shop: 'Upper', qty: -1, reason: 'Damaged' }] });
      await t('A: create adjustment', () => assert.equal(adj.status, 201));

      // Reload after each -> verify data actually persisted (comes back from "MongoDB")
      const state = await req(base, 'GET', '/state'.replace('/state', '')); // n/a; use readState via repo directly
      const persisted = await repo.readState();
      await t('A: reload — all created records are present in the store', () => {
        assert.ok(persisted.products.find(p => p.id === pid));
        assert.ok(persisted.customers.find(c => c.id === cid));
        assert.ok(persisted.vendors.find(v => v.id === vid));
        assert.ok(persisted.ledger.find(e => e.id === sale.body.entries[0].id));
        assert.ok(persisted.ledger.find(e => e.id === aoSale.body.entries[0].id));
      });
    } finally { await close(); }
  }

  // ===================== TEST B/C/D — EDIT + RETURNS =====================
  {
    const repo = createFakeRepo();
    const { base, close } = await startTestServer(repo);
    try {
      await req(base, 'POST', '/products', { sku: 'SKU1', name: 'P1', category: 'c', season: 's', cost: 10, wsale: 20, retail: 30, packSize: 6, openingStock: { shop: 'Upper', qty: 1000 } });
      const pid = (await repo.allProducts())[0].id;
      const shopRes = await req(base, 'POST', '/customers', { city: 'X', shop: 'S1', owner: 'O', opening: 0, creditLimit: 0 });
      const cid = shopRes.body.id;
      const vendorRes = await req(base, 'POST', '/vendors', { name: 'V1', opening: 0 });
      const vid = vendorRes.body.id;

      const saleRes = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_sale', customerId: cid, items: [{ productId: pid, qty: 100, price: 20 }] }] });
      const sale = saleRes.body.entries[0];
      const lineId = sale.items[0].lineId;

      const retRes = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_return', customerId: cid, productId: pid, saleId: sale.id, lineId, qty: 20, amount: 400 }] });
      const ret = retRes.body.entries[0];

      const rejectEdit = await req(base, 'PUT', `/ledger/${sale.id}`, { date: sale.date, items: [{ productId: pid, qty: 10, price: 20, lineId }] });
      await t('C/TEST7: sale 100->10 with 20 returned REJECTED', () => assert.equal(rejectEdit.status, 400));

      const allowEdit = await req(base, 'PUT', `/ledger/${sale.id}`, { date: sale.date, items: [{ productId: pid, qty: 80, price: 20, lineId }] });
      await t('B/TEST8: sale 100->80 ALLOWED, same lineId, same transaction ID', () => {
        assert.equal(allowEdit.status, 200);
        assert.equal(allowEdit.body.id, sale.id);
        assert.equal(allowEdit.body.items[0].lineId, lineId);
        assert.equal(allowEdit.body.amount, 1600);
      });
      await t('B: no duplicate ledger record created by edit', async () => {
        const all = await repo.allLedger();
        assert.equal(all.filter(e => e.id === sale.id).length, 1);
      });

      // add a new line -> gets a new distinct lineId, old preserved
      const addLine = await req(base, 'PUT', `/ledger/${sale.id}`, { date: sale.date, items: [{ productId: pid, qty: 80, price: 20, lineId }, { productId: pid, qty: 5, price: 20 }] });
      await t('New line gets a new lineId distinct from the preserved original', () => {
        assert.equal(addLine.body.items[0].lineId, lineId);
        assert.ok(addLine.body.items[1].lineId && addLine.body.items[1].lineId !== lineId);
      });
      // revert to single-line 80 for subsequent tests
      await req(base, 'PUT', `/ledger/${sale.id}`, { date: sale.date, items: [{ productId: pid, qty: 80, price: 20, lineId }] });

      // TEST 9 / req7: return edit excludes self
      const ret2Res = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_return', customerId: cid, productId: pid, saleId: sale.id, lineId, qty: 10, amount: 200 }] });
      const ret2 = ret2Res.body.entries[0];
      // total eligible = 80 (current qty), other returns excluding ret2's own = 20(ret) => max for ret2 = 60
      const overEdit = await req(base, 'PUT', `/ledger/${ret2.id}`, { date: ret2.date, qty: 61, amount: 1220 });
      await t('Return edit: cannot exceed original eligible qty (60 max)', () => assert.equal(overEdit.status, 400));
      const okEdit = await req(base, 'PUT', `/ledger/${ret2.id}`, { date: ret2.date, qty: 60, amount: 1200 });
      await t('Return edit: exactly at max allowed', () => assert.equal(okEdit.status, 200));
      await req(base, 'PUT', `/ledger/${ret2.id}`, { date: ret2.date, qty: 10, amount: 200 }); // restore

      // TEST D — vendor purchase + return + edit reject/allow
      const purRes = await req(base, 'POST', '/ledger', { entries: [{ type: 'vendor_purchase', vendorId: vid, items: [{ productId: pid, qty: 100, price: 10 }] }] });
      const pur = purRes.body.entries[0];
      const purLid = pur.items[0].lineId;
      const vretRes = await req(base, 'POST', '/ledger', { entries: [{ type: 'vendor_return', vendorId: vid, productId: pid, purchaseId: pur.id, lineId: purLid, qty: 20, amount: 200 }] });
      const purRejectEdit = await req(base, 'PUT', `/ledger/${pur.id}`, { date: pur.date, items: [{ productId: pid, qty: 10, price: 10, lineId: purLid }] });
      await t('D/TEST7: purchase 100->10 with 20 returned REJECTED', () => assert.equal(purRejectEdit.status, 400));
      const purAllowEdit = await req(base, 'PUT', `/ledger/${pur.id}`, { date: pur.date, items: [{ productId: pid, qty: 80, price: 10, lineId: purLid }] });
      await t('D: purchase 100->80 ALLOWED', () => assert.equal(purAllowEdit.status, 200));

      // TEST H — amount-only edit leaves inventory unchanged
      const aoRes = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_sale', customerId: cid, items: [], amountOnly: true, amount: 777 }] });
      const ao = aoRes.body.entries[0];
      const before = await repo.allLedger();
      const aoEdit = await req(base, 'PUT', `/ledger/${ao.id}`, { date: ao.date, amount: 999 });
      await t('H: amount-only edit updates amount, no items ever introduced', () => { assert.equal(aoEdit.status, 200); assert.equal(aoEdit.body.amount, 999); assert.equal(aoEdit.body.items.length, 0); });

      // TEST 10 — recovery/payment/discount ceiling, self excluded
      const recRes = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_recovery', customerId: cid, amount: 500, method: 'Cash' }] });
      const rec = recRes.body.entries[0];
      const custBalance = () => { const L = require('../ledgerLogic'); return repo.allLedger().then(l => repo.getCustomer(cid).then(c => L.customerBalance(l, c))); };
      const bal = await custBalance();
      const over = await req(base, 'PUT', `/ledger/${rec.id}`, { date: rec.date, amount: bal + rec.amount + 1 });
      await t('TEST10: recovery above outstanding REJECTED', () => assert.equal(over.status, 400));
      const atMax = await req(base, 'PUT', `/ledger/${rec.id}`, { date: rec.date, amount: bal + rec.amount });
      await t('TEST10: recovery at exact outstanding ALLOWED (self excluded, not double-counted)', () => assert.equal(atMax.status, 200));

      // Void: block sale with active return; allow after voiding return
      const blockedVoid = await req(base, 'POST', `/ledger/${sale.id}/void`, { reason: 'test' });
      await t('H: void a sale with active returns is BLOCKED', () => assert.equal(blockedVoid.status, 400));
      await req(base, 'POST', `/ledger/${ret.id}/void`, { reason: 'cleanup' });
      const okVoidRet2 = await req(base, 'POST', `/ledger/${ret2.id}/void`, { reason: 'cleanup' });
      await t('H: void a simple return works', () => assert.equal(okVoidRet2.status, 200));

      // The recovery `rec` was earlier raised to exactly match this customer's
      // outstanding balance (TEST10 above), which now includes this sale's
      // amount — so voiding the sale WHILE that recovery still stands would
      // push the customer's overall balance negative, and must be blocked.
      const saleVoidBlockedByBalance = await req(base, 'POST', `/ledger/${sale.id}/void`, { reason: 'mistake' });
      await t('H (new): void a sale that would push customer balance negative is BLOCKED', () => assert.equal(saleVoidBlockedByBalance.status, 400));
      // Void the recovery first — this makes room — then the sale void succeeds.
      const voidRecFirst = await req(base, 'POST', `/ledger/${rec.id}/void`, {});
      await t('H: void a plain recovery works', () => assert.equal(voidRecFirst.status, 200));
      const nowAllowedVoid = await req(base, 'POST', `/ledger/${sale.id}/void`, { reason: 'mistake' });
      await t('H: void a sale is ALLOWED once its returns are voided AND it would not push balance negative', () => assert.equal(nowAllowedVoid.status, 200));
      const doubleVoid = await req(base, 'POST', `/ledger/${sale.id}/void`, { reason: 'again' });
      await t('H: cannot void an already-voided transaction', () => assert.equal(doubleVoid.status, 400));
      const editVoided = await req(base, 'PUT', `/ledger/${sale.id}`, { date: sale.date, items: [{ productId: pid, qty: 1, price: 20, lineId }] });
      await t('H: cannot edit a voided transaction', () => assert.equal(editVoided.status, 400));

      // Void a fresh small recovery / adjustment / amount-only sale
      const rec2Res = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_recovery', customerId: cid, amount: 1, method: 'Cash' }] });
      const rec2 = rec2Res.body.entries[0];
      const voidRec2 = await req(base, 'POST', `/ledger/${rec2.id}/void`, {});
      await t('H: void a plain recovery works (fresh recovery, unambiguous)', () => assert.equal(voidRec2.status, 200));
      const voidAO = await req(base, 'POST', `/ledger/${ao.id}/void`, {});
      await t('H: void an amount-only sale works', () => assert.equal(voidAO.status, 200));
      const voidPurchaseBlocked = await req(base, 'POST', `/ledger/${pur.id}/void`, {});
      await t('H: void a vendor purchase with active vendor return is BLOCKED', () => assert.equal(voidPurchaseBlocked.status, 400));

      // Audit trail present
      const audit = await req(base, 'GET', `/audit/${sale.id}`);
      await t('Audit trail: create + edit + void events recorded for the sale', () => {
        const actions = audit.body.map(a => a.action);
        assert.ok(actions.includes('create') && actions.includes('edit') && actions.includes('void'));
      });
    } finally { await close(); }
  }

  // ===================== TEST F — MULTI-CLIENT / STALE STATE =====================
  {
    const repo = createFakeRepo();
    const { base, close } = await startTestServer(repo);
    try {
      await req(base, 'POST', '/customers', { city: 'X', shop: 'S1', owner: 'O', opening: 1000, creditLimit: 0 });
      const cid = (await repo.allCustomers())[0].id;
      // "Session A" loads state
      const sessionASnapshot = await repo.readState();
      // "Session B" creates a brand-new transaction (recovery)
      const created = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_recovery', customerId: cid, amount: 100, method: 'Cash' }] });
      await t('F setup: session B created a recovery', () => assert.equal(created.status, 201));
      // "Session A" then performs its own separate, unrelated valid action (e.g. edits the shop's phone)
      await req(base, 'PUT', `/customers/${cid}`, { phone: '0300-0000000' });
      // Verify session B's new transaction was NOT wiped out
      const afterState = await repo.readState();
      await t('F: Session A\'s later action did NOT erase Session B\'s new transaction (no full-state overwrite anywhere)', () => {
        assert.ok(afterState.ledger.find(e => e.id === created.body.entries[0].id));
        assert.equal(afterState.customers.find(c => c.id === cid).phone, '0300-0000000');
      });
      // Concurrency: editing with a stale expectedUpdatedAt is rejected
      const staleCustomer = sessionASnapshot.customers.find(c => c.id === cid);
      const staleEdit = await req(base, 'PUT', `/customers/${cid}`, { phone: '0311-1111111', expectedUpdatedAt: staleCustomer.updatedAt });
      await t('F: stale optimistic-lock edit on customer is REJECTED (409)', () => assert.equal(staleEdit.status, 409));
      const freshCustomer = await repo.getCustomer(cid);
      const freshEdit = await req(base, 'PUT', `/customers/${cid}`, { phone: '0311-1111111', expectedUpdatedAt: freshCustomer.updatedAt });
      await t('F: edit with current updatedAt succeeds', () => assert.equal(freshEdit.status, 200));

      // Same concurrency check on a ledger entry
      const recEntry = created.body.entries[0];
      const staleLedgerEdit = await req(base, 'PUT', `/ledger/${recEntry.id}`, { date: recEntry.date, amount: 50, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
      await t('F: stale optimistic-lock edit on a ledger entry is REJECTED (409)', () => assert.equal(staleLedgerEdit.status, 409));
    } finally { await close(); }
  }

  // ===================== TEST G — FAILURE CONSISTENCY =====================
  {
    const repo = createFakeRepo(); // transactions simulated ON (rollback on throw)
    const { base, close } = await startTestServer(repo);
    try {
      await req(base, 'POST', '/customers', { city: 'X', shop: 'S1', owner: 'O', opening: 500, creditLimit: 0 });
      const cid = (await repo.allCustomers())[0].id;
      const before = await repo.readState();
      repo._failNextInsertLedger();
      const failed = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_recovery', customerId: cid, amount: 100, method: 'Cash' }] });
      await t('G: a failed write returns an error (not a silent partial success)', () => assert.equal(failed.status, 500));
      const after = await repo.readState();
      await t('G: a failed transactional write leaves NO partial/corrupted ledger row behind', () => {
        assert.equal(after.ledger.length, before.ledger.length);
      });

      // Now the same scenario but with transactions NOT supported (documented fallback)
      const repo2 = createFakeRepo({ simulateNoTransactions: true });
      const { base: base2, close: close2 } = await startTestServer(repo2);
      try {
        await req(base2, 'POST', '/customers', { city: 'X', shop: 'S1', owner: 'O', opening: 500, creditLimit: 0 });
        const cid2 = (await repo2.allCustomers())[0].id;
        const b2 = await repo2.readState();
        repo2._failNextInsertLedger();
        const failed2 = await req(base2, 'POST', '/ledger', { entries: [{ type: 'wholesale_recovery', customerId: cid2, amount: 100, method: 'Cash' }] });
        await t('G (no-transaction fallback): a failed write still returns an error to the client', () => assert.equal(failed2.status, 500));
        const a2 = await repo2.readState();
        // Single-entry batch + failed insert -> nothing was actually written (insertLedgerMany is one call)
        await t('G (no-transaction fallback): single-entry create leaves no corrupted row either', () => assert.equal(a2.ledger.length, b2.ledger.length));
      } finally { await close2(); }
    } finally { await close(); }
  }

  // ===================== TEST I — EXCEL-RELEVANT DATA SHAPE =====================
  {
    const repo = createFakeRepo();
    const { base, close } = await startTestServer(repo);
    try {
      await req(base, 'POST', '/products', { sku: 'S1', name: 'P1', category: 'c', season: 's', cost: 1, wsale: 2, retail: 3, packSize: 6, openingStock: { shop: 'Upper', qty: 600 } });
      const pid = (await repo.allProducts())[0].id;
      const shopRes = await req(base, 'POST', '/customers', { city: 'Lahore', shop: 'S1', owner: 'O', opening: 45000, creditLimit: 0 });
      const cid = shopRes.body.id;
      await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_sale', customerId: cid, items: [{ productId: pid, qty: 110, price: 2 }] }] });
      await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_sale', customerId: cid, items: [], amountOnly: true, amount: 5000 }] });
      const state = await repo.readState();
      await t('I: opening balance present in customer record (Excel builds this row from it)', () => assert.equal(state.customers[0].opening, 45000));
      await t('I: amount-only sale has no fabricated product/qty data', () => {
        const ao = state.ledger.find(e => e.amountOnly);
        assert.equal(ao.items.length, 0);
      });
      await t('I: no duplicate ledger ids', () => {
        const ids = state.ledger.map(e => e.id);
        assert.equal(new Set(ids).size, ids.length);
      });
    } finally { await close(); }
  }

  // ===================== GAP 1 — CREATE-TIME AMOUNT CEILINGS =====================
  {
    const repo = createFakeRepo();
    const { base, close } = await startTestServer(repo);
    try {
      const shopRes = await req(base, 'POST', '/customers', { city: 'X', shop: 'S1', owner: 'O', opening: 5000, creditLimit: 0 });
      const cid = shopRes.body.id;
      const vendorRes = await req(base, 'POST', '/vendors', { name: 'V1', opening: 3000 });
      const vid = vendorRes.body.id;

      const recOver = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_recovery', customerId: cid, amount: 6000, method: 'Cash' }] });
      await t('GAP1: new recovery above outstanding (5000) REJECTED', () => assert.equal(recOver.status, 400));
      const recExact = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_recovery', customerId: cid, amount: 5000, method: 'Cash' }] });
      await t('GAP1: new recovery exactly at outstanding ALLOWED', () => assert.equal(recExact.status, 201));

      // outstanding is now 0 after the recovery above — a fresh sale restores room for discount test
      await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_sale', customerId: cid, items: [], amountOnly: true, amount: 2000 }] });
      const discOver = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_discount', customerId: cid, amount: 2500 }] });
      await t('GAP1: new wholesale discount above outstanding (2000) REJECTED', () => assert.equal(discOver.status, 400));
      const discOk = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_discount', customerId: cid, amount: 2000 }] });
      await t('GAP1: new wholesale discount exactly at outstanding ALLOWED', () => assert.equal(discOk.status, 201));

      const rsaleRes = await req(base, 'POST', '/ledger', { entries: [{ type: 'retail_sale', customerName: 'Walk-in', shop: 'Lower', items: [], amount: 1000, paidNow: 0 }] });
      // retail_sale without items is invalid per its own create rule — build one with an actual product instead
      await req(base, 'POST', '/products', { sku: 'RS1', name: 'RProd', category: 'c', season: 's', cost: 1, wsale: 1, retail: 1000, packSize: 1, openingStock: { shop: 'Lower', qty: 5 } });
      const rpid = (await repo.allProducts())[0].id;
      await (async () => {
        // move it to Lower via adjustment since openingStock above already targeted Lower directly
      })();
      const rsale2 = await req(base, 'POST', '/ledger', { entries: [{ type: 'retail_sale', customerName: 'Walk-in', shop: 'Lower', items: [{ productId: rpid, qty: 1, price: 1000 }], paidNow: 0 }] });
      await t('GAP1 setup: retail sale (due=1000) created', () => assert.equal(rsale2.status, 201));
      const rsid = rsale2.body.entries[0].id;

      const payOver = await req(base, 'POST', '/ledger', { entries: [{ type: 'retail_payment', saleId: rsid, amount: 1200 }] });
      await t('GAP1: new retail payment above remaining due (1000) REJECTED', () => assert.equal(payOver.status, 400));
      const payOk = await req(base, 'POST', '/ledger', { entries: [{ type: 'retail_payment', saleId: rsid, amount: 1000 }] });
      await t('GAP1: new retail payment exactly at due ALLOWED', () => assert.equal(payOk.status, 201));

      const rsale3 = await req(base, 'POST', '/ledger', { entries: [{ type: 'retail_sale', customerName: 'Walk-in', shop: 'Lower', items: [{ productId: rpid, qty: 1, price: 500 }], paidNow: 0 }] });
      const rsid3 = rsale3.body.entries[0].id;
      const discRetOver = await req(base, 'POST', '/ledger', { entries: [{ type: 'retail_discount', saleId: rsid3, amount: 600 }] });
      await t('GAP1: new retail discount above remaining due (500) REJECTED', () => assert.equal(discRetOver.status, 400));
      const discRetOk = await req(base, 'POST', '/ledger', { entries: [{ type: 'retail_discount', saleId: rsid3, amount: 500 }] });
      await t('GAP1: new retail discount exactly at due ALLOWED', () => assert.equal(discRetOk.status, 201));

      const vpayOver = await req(base, 'POST', '/ledger', { entries: [{ type: 'vendor_payment', vendorId: vid, amount: 3500 }] });
      await t('GAP1: new vendor payment above payable (3000) REJECTED', () => assert.equal(vpayOver.status, 400));
      const vpayOk = await req(base, 'POST', '/ledger', { entries: [{ type: 'vendor_payment', vendorId: vid, amount: 3000 }] });
      await t('GAP1: new vendor payment exactly at payable ALLOWED', () => assert.equal(vpayOk.status, 201));

      // Batch validation uses the RUNNING ledger including earlier entries in the same batch.
      const shop2Res = await req(base, 'POST', '/customers', { city: 'X', shop: 'S2', owner: 'O', opening: 0, creditLimit: 0 });
      const cid2 = shop2Res.body.id;
      const batchOver = await req(base, 'POST', '/ledger', { entries: [
        { type: 'wholesale_sale', customerId: cid2, items: [], amountOnly: true, amount: 1000 },
        { type: 'wholesale_recovery', customerId: cid2, amount: 1500, method: 'Cash' } // exceeds the 1000 just created in THIS batch
      ] });
      await t('GAP1: batch create validates against the RUNNING ledger (recovery exceeding the sale created earlier in the same batch) REJECTED', () => assert.equal(batchOver.status, 400));
      const batchOk = await req(base, 'POST', '/ledger', { entries: [
        { type: 'wholesale_sale', customerId: cid2, items: [], amountOnly: true, amount: 1000 },
        { type: 'wholesale_recovery', customerId: cid2, amount: 1000, method: 'Cash' }
      ] });
      await t('GAP1: batch create — recovery within the sale created earlier in the same batch ALLOWED', () => assert.equal(batchOk.status, 201));
      await t('GAP1: a REJECTED batch creates NOTHING (atomic — the valid sale-only half was not partially saved)', async () => {
        const all = await repo.allLedger();
        const salesForCid2 = all.filter(e => e.customerId === cid2 && e.type === 'wholesale_sale');
        // exactly one amount-only sale of 1000 for cid2 (from the successful batch), not two
        assert.equal(salesForCid2.length, 1);
      });
    } finally { await close(); }
  }

  // ===================== GAP 2 — CREATE-TIME RETURN VALIDATION =====================
  {
    const repo = createFakeRepo();
    const { base, close } = await startTestServer(repo);
    try {
      await req(base, 'POST', '/products', { sku: 'P1', name: 'Prod1', category: 'c', season: 's', cost: 10, wsale: 20, retail: 30, packSize: 1, openingStock: { shop: 'Upper', qty: 1000 } });
      await req(base, 'POST', '/products', { sku: 'P2', name: 'Prod2', category: 'c', season: 's', cost: 10, wsale: 20, retail: 30, packSize: 1 });
      const products = await repo.allProducts();
      const pid = products.find(p => p.sku === 'P1').id;
      const otherPid = products.find(p => p.sku === 'P2').id;
      const shopRes = await req(base, 'POST', '/customers', { city: 'X', shop: 'S1', owner: 'O', opening: 0, creditLimit: 0 });
      const cid = shopRes.body.id;
      const vendorRes = await req(base, 'POST', '/vendors', { name: 'V1', opening: 0 });
      const vid = vendorRes.body.id;

      const saleRes = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_sale', customerId: cid, items: [{ productId: pid, qty: 100, price: 20 }] }] });
      const sale = saleRes.body.entries[0];
      const lineId = sale.items[0].lineId;

      const missingParent = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_return', customerId: cid, productId: pid, saleId: 999999, lineId, qty: 10, amount: 200 }] });
      await t('GAP2: return with a non-existent parent sale REJECTED', () => assert.equal(missingParent.status, 400));

      const wrongLineId = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_return', customerId: cid, productId: pid, saleId: sale.id, lineId: 'L-does-not-exist', qty: 10, amount: 200 }] });
      await t('GAP2: return with a lineId that does not belong to the original sale REJECTED', () => assert.equal(wrongLineId.status, 400));

      const mismatchedProduct = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_return', customerId: cid, productId: otherPid, saleId: sale.id, lineId, qty: 10, amount: 200 }] });
      await t('GAP2: return whose product does not match the referenced line REJECTED', () => assert.equal(mismatchedProduct.status, 400));

      const wrongParentType = await req(base, 'POST', '/ledger', { entries: [{ type: 'retail_return', saleId: sale.id, productId: pid, lineId, qty: 10, amount: 200 }] });
      await t('GAP2: retail_return pointed at a wholesale_sale (wrong parent type) REJECTED', () => assert.equal(wrongParentType.status, 400));

      const firstReturn = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_return', customerId: cid, productId: pid, saleId: sale.id, lineId, qty: 80, amount: 1600 }] });
      await t('GAP2 setup: first return of 80/100 created', () => assert.equal(firstReturn.status, 201));

      const overReturn = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_return', customerId: cid, productId: pid, saleId: sale.id, lineId, qty: 30, amount: 600 }] });
      await t('GAP2: second return of 30 when only 20 remain eligible (100-80) REJECTED', () => assert.equal(overReturn.status, 400));

      const exactReturn = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_return', customerId: cid, productId: pid, saleId: sale.id, lineId, qty: 20, amount: 400 }] });
      await t('GAP2: second return of exactly the remaining eligible quantity (20) ALLOWED', () => assert.equal(exactReturn.status, 201));

      const nowFullyReturned = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_return', customerId: cid, productId: pid, saleId: sale.id, lineId, qty: 1, amount: 20 }] });
      await t('GAP2: total active returns cannot exceed the original line quantity (100) — a third return REJECTED', () => assert.equal(nowFullyReturned.status, 400));

      // Negative/zero quantity rejected
      const badQty = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_return', customerId: cid, productId: pid, saleId: sale.id, lineId, qty: 0, amount: 0 }] });
      await t('GAP2: a zero/invalid quantity return REJECTED', () => assert.equal(badQty.status, 400));

      // Ownership mismatch: wrong customerId for a real sale/line
      const otherShopRes = await req(base, 'POST', '/customers', { city: 'X', shop: 'S2', owner: 'O', opening: 0, creditLimit: 0 });
      const wrongCustomer = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_return', customerId: otherShopRes.body.id, productId: pid, saleId: sale.id, lineId, qty: 1, amount: 20 }] });
      await t('GAP2: return whose customerId does not match the original sale REJECTED', () => assert.equal(wrongCustomer.status, 400));

      // Vendor return: stock-at-return-time check still enforced
      const purRes = await req(base, 'POST', '/ledger', { entries: [{ type: 'vendor_purchase', vendorId: vid, items: [{ productId: otherPid, qty: 5, price: 10 }] }] });
      const pur = purRes.body.entries[0];
      const purLid = pur.items[0].lineId;
      // sell off the Upper stock that was just purchased so none remains to physically return
      await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_sale', customerId: cid, items: [{ productId: otherPid, qty: 5, price: 20 }] }] });
      const vReturnNoStock = await req(base, 'POST', '/ledger', { entries: [{ type: 'vendor_return', vendorId: vid, productId: otherPid, purchaseId: pur.id, lineId: purLid, qty: 5, amount: 50 }] });
      await t('GAP2: vendor return rejected when there is not enough physical Upper stock left to return', () => assert.equal(vReturnNoStock.status, 400));
    } finally { await close(); }
  }

  // ===================== GAP 3 — VOID SAFETY =====================
  {
    const repo = createFakeRepo();
    const { base, close } = await startTestServer(repo);
    try {
      await req(base, 'POST', '/products', { sku: 'P1', name: 'Prod1', category: 'c', season: 's', cost: 10, wsale: 20, retail: 30, packSize: 1 });
      const pid = (await repo.allProducts())[0].id;
      const vendorRes = await req(base, 'POST', '/vendors', { name: 'V1', opening: 0 });
      const vid = vendorRes.body.id;
      const shopRes = await req(base, 'POST', '/customers', { city: 'X', shop: 'S1', owner: 'O', opening: 0, creditLimit: 0 });
      const cid = shopRes.body.id;

      // A) purchase whose stock has been consumed — void rejected
      const purRes = await req(base, 'POST', '/ledger', { entries: [{ type: 'vendor_purchase', vendorId: vid, items: [{ productId: pid, qty: 100, price: 10 }] }] });
      const pur = purRes.body.entries[0];
      await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_sale', customerId: cid, items: [{ productId: pid, qty: 60, price: 20 }] }] });
      const voidConsumedPurchase = await req(base, 'POST', `/ledger/${pur.id}/void`, {});
      await t('GAP3-A: void a purchase whose stock has been partly sold is REJECTED (would make Upper stock negative)', () => assert.equal(voidConsumedPurchase.status, 400));
      // but voiding is fine once enough stock is back (e.g. transfer never happened / stock still covers it) — demonstrate the safe case on a fresh purchase
      const purRes2 = await req(base, 'POST', '/ledger', { entries: [{ type: 'vendor_purchase', vendorId: vid, items: [{ productId: pid, qty: 10, price: 10 }] }] });
      const pur2 = purRes2.body.entries[0];
      const voidUnconsumedPurchase = await req(base, 'POST', `/ledger/${pur2.id}/void`, {});
      await t('GAP3-A: void a purchase whose stock is untouched is ALLOWED', () => assert.equal(voidUnconsumedPurchase.status, 200));

      // B) transfer whose Lower stock has been consumed — void rejected
      const xferRes = await req(base, 'POST', '/ledger', { entries: [{ type: 'stock_transfer', productId: pid, qty: 20 }] });
      const xfer = xferRes.body.entries[0];
      await req(base, 'POST', '/products', { sku: 'DUMMY', name: 'D', category: 'c', season: 's', cost: 1, wsale: 1, retail: 1 }); // keep product list stable for later indices
      await req(base, 'POST', '/ledger', { entries: [{ type: 'retail_sale', customerName: 'Walk-in', shop: 'Lower', items: [{ productId: pid, qty: 15, price: 30 }], paidNow: 0 }] });
      const voidConsumedTransfer = await req(base, 'POST', `/ledger/${xfer.id}/void`, {});
      await t('GAP3-B: void a transfer whose Lower stock has been partly sold is REJECTED', () => assert.equal(voidConsumedTransfer.status, 400));

      // C) positive adjustment whose stock has been consumed — void rejected
      const adjRes = await req(base, 'POST', '/ledger', { entries: [{ type: 'adjustment', productId: pid, shop: 'Lower', qty: 3, reason: 'Found extra stock' }] });
      const adj = adjRes.body.entries[0];
      // sell MORE than the adjustment contributed, so removing the adjustment's
      // effect would genuinely take stock negative (not just use up other stock)
      const lowerStockAfterAdj = await (async () => { const L = require('../ledgerLogic'); const l = await repo.allLedger(); const prod = await repo.getProduct(pid); return L.productStock(l, pid, 'Lower'); })();
      await req(base, 'POST', '/ledger', { entries: [{ type: 'retail_sale', customerName: 'Walk-in', shop: 'Lower', items: [{ productId: pid, qty: lowerStockAfterAdj - 2, price: 30 }], paidNow: 0 }] });
      const voidConsumedAdj = await req(base, 'POST', `/ledger/${adj.id}/void`, {});
      await t('GAP3-C: void a positive adjustment whose stock has been partly sold is REJECTED', () => assert.equal(voidConsumedAdj.status, 400));
      // a negative (removal) adjustment can always be safely voided (it only gives stock back)
      const negAdjRes = await req(base, 'POST', '/ledger', { entries: [{ type: 'adjustment', productId: pid, shop: 'Lower', qty: -1, reason: 'Damaged' }] });
      const negAdj = negAdjRes.body.entries[0];
      const voidNegAdj = await req(base, 'POST', `/ledger/${negAdj.id}/void`, {});
      await t('GAP3-C: void a NEGATIVE adjustment (removal) is always ALLOWED (only gives stock back)', () => assert.equal(voidNegAdj.status, 200));

      // D) wholesale sale whose removal would make overall customer balance negative — void rejected
      const shop2Res = await req(base, 'POST', '/customers', { city: 'X', shop: 'S2', owner: 'O', opening: 0, creditLimit: 0 });
      const cid2 = shop2Res.body.id;
      const sale2Res = await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_sale', customerId: cid2, items: [], amountOnly: true, amount: 1000 }] });
      const sale2 = sale2Res.body.entries[0];
      await req(base, 'POST', '/ledger', { entries: [{ type: 'wholesale_recovery', customerId: cid2, amount: 1000, method: 'Cash' }] });
      const voidBalanceUnsafe = await req(base, 'POST', `/ledger/${sale2.id}/void`, {});
      await t('GAP3-D: void a wholesale sale that would push the customer balance negative is REJECTED', () => assert.equal(voidBalanceUnsafe.status, 400));
      await t('GAP3-D: voiding it is allowed once the recovery is voided first (frees up balance)', async () => {
        const recId = (await repo.allLedger()).find(e => e.type === 'wholesale_recovery' && e.customerId === cid2).id;
        const voidRecFirst = await req(base, 'POST', `/ledger/${recId}/void`, {});
        assert.equal(voidRecFirst.status, 200);
        const voidSaleNow = await req(base, 'POST', `/ledger/${sale2.id}/void`, {});
        assert.equal(voidSaleNow.status, 200);
      });

      // E) vendor purchase whose removal would make vendor payable negative — void rejected
      const vendor2Res = await req(base, 'POST', '/vendors', { name: 'V2', opening: 0 });
      const vid2 = vendor2Res.body.id;
      const pur3Res = await req(base, 'POST', '/ledger', { entries: [{ type: 'vendor_purchase', vendorId: vid2, items: [{ productId: pid, qty: 1, price: 500 }] }] });
      const pur3 = pur3Res.body.entries[0];
      await req(base, 'POST', '/ledger', { entries: [{ type: 'vendor_payment', vendorId: vid2, amount: 500 }] });
      const voidPayableUnsafe = await req(base, 'POST', `/ledger/${pur3.id}/void`, {});
      await t('GAP3-E: void a vendor purchase that would push payable negative is REJECTED', () => assert.equal(voidPayableUnsafe.status, 400));
    } finally { await close(); }
  }

  // ===================== GAP 4 — LEGACY STATE ENDPOINT =====================
  {
    const repo = createFakeRepo();
    const { base, close } = await startTestServer(repo);
    try {
      await req(base, 'POST', '/customers', { city: 'X', shop: 'S1', owner: 'O', opening: 100, creditLimit: 0 });
      const getRes = await req(base, 'GET', '/state');
      await t('GAP4: GET /api/state still works (initial hydration preserved)', () => assert.equal(getRes.status, 200) || assert.ok(Array.isArray(getRes.body.customers)));
      const putRes = await req(base, 'PUT', '/state', { products: [], cities: [], customers: [], vendors: [], ledger: [] });
      await t('GAP4: PUT /api/state is DISABLED (410 Gone)', () => assert.equal(putRes.status, 410));
      const afterPut = await req(base, 'GET', '/state');
      await t('GAP4: a PUT /api/state attempt destroys nothing — data from before the attempt is still present', () => assert.equal(afterPut.body.customers.length, 1));
    } finally { await close(); }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run();
