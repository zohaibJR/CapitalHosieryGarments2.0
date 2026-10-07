/* =====================================================================
   fakeRepo.js — in-memory stand-in for repo.js, implementing the exact
   same async function interface. Lets routes.js (the real production
   route code) be exercised with real HTTP requests in tests, without a
   live MongoDB. transactionsSupported is simulated too, so the code
   path that runs when a deployment does NOT support transactions is
   also covered by these tests.
===================================================================== */
function clone(x) { return x === undefined ? x : JSON.parse(JSON.stringify(x)); }

function createFakeRepo({ simulateNoTransactions = false } = {}) {
  const db = { products: [], cities: [], customers: [], vendors: [], ledger: [], audit: [], counter: 2000 };
  let failNextInsertLedger = false; // used by the failure-consistency test

  const repo = {
    isFake: true,
    _db: db,
    _failNextInsertLedger() { failNextInsertLedger = true; },

    async withTransaction(fn) {
      if (simulateNoTransactions) {
        // Fallback path: no rollback on failure — matches the real repo's
        // documented behavior on a standalone (non-replica-set) MongoDB.
        const result = await fn(null);
        return { result, usedTransaction: false };
      }
      // Simulate a real transaction: snapshot state, run fn, roll back on throw.
      const snapshot = clone(db);
      try {
        const result = await fn({ fake: true });
        return { result, usedTransaction: true };
      } catch (err) {
        Object.assign(db, snapshot);
        throw err;
      }
    },

    async nextAppId(n = 1) {
      const first = db.counter + 1;
      db.counter += n;
      const ids = []; for (let i = 0; i < n; i++) ids.push(first + i);
      return n === 1 ? ids[0] : ids;
    },
    async seedCounterAtLeast(min) { db.counter = Math.max(db.counter, min); },

    async readState() {
      return { products: clone(db.products), cities: db.cities.slice(), customers: clone(db.customers), vendors: clone(db.vendors), ledger: clone(db.ledger) };
    },
    async allLedger() { return clone(db.ledger); },
    async getLedgerByAppId(id) { return clone(db.ledger.find(e => e.id === id)); },
    async insertLedgerMany(docs) {
      if (failNextInsertLedger) { failNextInsertLedger = false; throw new Error('simulated write failure'); }
      const now = new Date().toISOString();
      const withMeta = docs.map(d => ({ ...d, createdAt: now, updatedAt: now }));
      db.ledger.push(...clone(withMeta));
      return clone(withMeta);
    },
    async touchLedgerEntry(id) {
      const e = db.ledger.find(x => x.id === id);
      if (e) e.lastTouchedForReturn = new Date().toISOString();
    },
    async updateLedgerByAppId(id, patch) {
      const e = db.ledger.find(x => x.id === id);
      if (!e) return null;
      Object.assign(e, patch, { updatedAt: new Date().toISOString() });
      return clone(e);
    },

    async allCustomers() { return clone(db.customers); },
    async getCustomer(id) { return clone(db.customers.find(c => c.id === id)); },
    async insertCustomer(doc) { const now = new Date().toISOString(); const rec = { ...doc, createdAt: now, updatedAt: now }; db.customers.push(rec); return clone(rec); },
    async updateCustomer(id, patch) { const c = db.customers.find(x => x.id === id); if (!c) return null; Object.assign(c, patch, { updatedAt: new Date().toISOString() }); return clone(c); },

    async allVendors() { return clone(db.vendors); },
    async getVendor(id) { return clone(db.vendors.find(v => v.id === id)); },
    async insertVendor(doc) { const now = new Date().toISOString(); const rec = { ...doc, createdAt: now, updatedAt: now }; db.vendors.push(rec); return clone(rec); },
    async updateVendor(id, patch) { const v = db.vendors.find(x => x.id === id); if (!v) return null; Object.assign(v, patch, { updatedAt: new Date().toISOString() }); return clone(v); },

    async allProducts() { return clone(db.products); },
    async getProduct(id) { return clone(db.products.find(p => p.id === id)); },
    async findProductBySkuLower(skuLower) { return clone(db.products.find(p => p.skuLower === skuLower)); },
    async insertProduct(doc) { const now = new Date().toISOString(); const rec = { ...doc, createdAt: now, updatedAt: now }; db.products.push(rec); return clone(rec); },
    async updateProduct(id, patch) { const p = db.products.find(x => x.id === id); if (!p) return null; Object.assign(p, patch, { updatedAt: new Date().toISOString() }); return clone(p); },

    async allCities() { return db.cities.slice(); },
    async insertCity(name) { db.cities.push(name); },
    async renameCity(oldName, newName) {
      const idx = db.cities.indexOf(oldName); if (idx >= 0) db.cities[idx] = newName;
      let n = 0; db.customers.forEach(c => { if (c.city === oldName) { c.city = newName; n++; } });
      return n;
    },

    async recordAudit(entry) { db.audit.push({ ...clone(entry), createdAt: new Date().toISOString() }); },
    async auditFor(appId) { return clone(db.audit.filter(a => a.appId === appId)).reverse(); },
    async auditRecent(limit = 200) { return clone(db.audit).reverse().slice(0, limit); }
  };
  return repo;
}

module.exports = { createFakeRepo };
