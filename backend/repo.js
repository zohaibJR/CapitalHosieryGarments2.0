/* =====================================================================
   repo.js — MongoDB-backed repository.
   ---------------------------------------------------------------------
   Every database access the new /api/ledger, /api/products, /api/cities,
   /api/customers, /api/vendors and /api/audit routes need goes through
   this one module. Routes never call Mongoose models directly — this
   indirection is what lets the exact same route code (routes.js) run
   against this real Mongo repository in production AND against a fake
   in-memory repository in tests (test/fakeRepo.js), so the HTTP/
   validation contract can be verified without a live database.
===================================================================== */
const mongoose = require('mongoose');
const { Product, City, Customer, Vendor, LedgerEntry, Counter, AuditLog } = require('./models');

function stripMongo(row) {
  if (!row) return row;
  const copy = { ...row };
  delete copy._id;
  delete copy.__v;
  return copy;
}

// Detected once at startup / on first use: does this MongoDB deployment
// support multi-document transactions? (Standalone servers do not;
// replica sets and Atlas clusters — including the free M0 tier — do.)
let transactionsSupported = null;

async function withTransaction(fn) {
  if (transactionsSupported === false) {
    // Already known not to work on this deployment — skip straight to the
    // documented fallback rather than paying for a failed attempt every time.
    return { result: await fn(null), usedTransaction: false };
  }
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    transactionsSupported = true;
    return { result, usedTransaction: true };
  } catch (error) {
    const msg = String(error && error.message || '');
    const looksUnsupported =
      /Transaction numbers are only allowed|IllegalOperation|not supported|replica set/i.test(msg);
    if (looksUnsupported) {
      transactionsSupported = false;
      // Fall back to a plain sequential (non-transactional) run. This is the
      // "safest practical consistency strategy" the standalone-DB case gets:
      // writes still happen in the same order, but a failure partway through
      // will not be automatically rolled back. This limitation is called out
      // explicitly in the project report.
      const result = await fn(null);
      return { result, usedTransaction: false };
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

async function nextSeq(n = 1, session) {
  const doc = await Counter.findOneAndUpdate(
    { _id: 'app' },
    { $inc: { seq: n } },
    { upsert: true, new: true, session }
  );
  const last = doc.seq;
  const first = last - n + 1;
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(first + i);
  return n === 1 ? ids[0] : ids;
}

const repo = {
  isFake: false,
  withTransaction,

  /* ---- read-only full snapshot (unchanged legacy shape, used for GET /api/state) ---- */
  async readState() {
    const [products, cityDocs, customers, vendors, ledger] = await Promise.all([
      Product.find().sort({ id: 1 }).lean(),
      City.find().sort({ name: 1 }).lean(),
      Customer.find().sort({ city: 1, shop: 1 }).lean(),
      Vendor.find().sort({ name: 1 }).lean(),
      LedgerEntry.find().sort({ id: 1 }).lean()
    ]);
    return {
      products: products.map(stripMongo),
      cities: cityDocs.map(c => c.name),
      customers: customers.map(stripMongo),
      vendors: vendors.map(stripMongo),
      ledger: ledger.map(stripMongo)
    };
  },

  async allLedger() {
    return (await LedgerEntry.find().lean()).map(stripMongo);
  },
  async getLedgerByAppId(id) {
    return stripMongo(await LedgerEntry.findOne({ id }).lean());
  },
  async insertLedgerMany(docs, session) {
    const inserted = await LedgerEntry.insertMany(docs, { session, ordered: true });
    return inserted.map(d => stripMongo(d.toObject()));
  },
  // Creates a real write-dependency on the parent document for the duration
  // of the surrounding transaction. Used when creating/editing a return: two
  // concurrent transactions that both touch the SAME parent sale/purchase
  // will conflict at commit time, and MongoDB's session.withTransaction()
  // automatically retries the one that loses that race — which forces it to
  // re-read eligibility fresh instead of acting on a stale snapshot. This is
  // what keeps "two clients returning against the same line at once" safe
  // without needing a bespoke per-line counter field.
  async touchLedgerEntry(id, session) {
    await LedgerEntry.updateOne({ id }, { $set: { lastTouchedForReturn: new Date() } }, { session });
  },
  async updateLedgerByAppId(id, patch, session) {
    const updated = await LedgerEntry.findOneAndUpdate(
      { id },
      { $set: patch },
      { new: true, session }
    ).lean();
    return stripMongo(updated);
  },

  async allCustomers() { return (await Customer.find().lean()).map(stripMongo); },
  async getCustomer(id) { return stripMongo(await Customer.findOne({ id }).lean()); },
  async insertCustomer(doc, session) { return stripMongo((await Customer.create([doc], { session }))[0].toObject()); },
  async updateCustomer(id, patch, session) {
    return stripMongo(await Customer.findOneAndUpdate({ id }, { $set: patch }, { new: true, session }).lean());
  },

  async allVendors() { return (await Vendor.find().lean()).map(stripMongo); },
  async getVendor(id) { return stripMongo(await Vendor.findOne({ id }).lean()); },
  async insertVendor(doc, session) { return stripMongo((await Vendor.create([doc], { session }))[0].toObject()); },
  async updateVendor(id, patch, session) {
    return stripMongo(await Vendor.findOneAndUpdate({ id }, { $set: patch }, { new: true, session }).lean());
  },

  async allProducts() { return (await Product.find().lean()).map(stripMongo); },
  async getProduct(id) { return stripMongo(await Product.findOne({ id }).lean()); },
  async findProductBySkuLower(skuLower) { return stripMongo(await Product.findOne({ skuLower }).lean()); },
  async insertProduct(doc, session) { return stripMongo((await Product.create([doc], { session }))[0].toObject()); },
  async updateProduct(id, patch, session) {
    return stripMongo(await Product.findOneAndUpdate({ id }, { $set: patch }, { new: true, session }).lean());
  },

  async allCities() { return (await City.find().sort({ name: 1 }).lean()).map(c => c.name); },
  async insertCity(name, session) { await City.create([{ name }], { session }); },
  async renameCity(oldName, newName, session) {
    await City.updateOne({ name: oldName }, { $set: { name: newName } }, { session });
    const r = await Customer.updateMany({ city: oldName }, { $set: { city: newName } }, { session });
    return r.modifiedCount || 0;
  },

  async nextAppId(n = 1, session) { return nextSeq(n, session); },
  async seedCounterAtLeast(min) {
    await Counter.findOneAndUpdate({ _id: 'app' }, { $max: { seq: min } }, { upsert: true });
  },

  async recordAudit({ appId, entryType, action, before, after, user }, session) {
    await AuditLog.create([{ appId, entryType, action, before, after, user }], { session });
  },
  async auditFor(appId) {
    return (await AuditLog.find({ appId }).sort({ createdAt: -1 }).lean()).map(stripMongo);
  },
  async auditRecent(limit = 200) {
    return (await AuditLog.find().sort({ createdAt: -1 }).limit(limit).lean()).map(stripMongo);
  }
};

module.exports = repo;
