#!/usr/bin/env node
/* =====================================================================
   migrate.js — one-time, idempotent preparation of an EXISTING database
   for the new record-level API. Run this ONCE, before deploying the new
   server.js, against the SAME MongoDB the app already uses.

   This script is purely ADDITIVE:
     - it never deletes a collection or document
     - it never regenerates an existing app-level id or lineId
     - it only backfills fields that did not exist before this phase
       (voided:false on ledger entries) and seeds the new Counter
       collection so future server-assigned ids never collide with
       ids that already exist in your data
     - it is safe to run more than once — a second run makes no
       further changes (that's what "idempotent" means here), which
       is verified by test/migrate.test.js

   Usage:
     MONGODB_URI="mongodb+srv://..." node backend/migrate.js
   (or just `node backend/migrate.js` if MONGODB_URI is already in your
   environment / .env, the same variable server.js itself uses)
===================================================================== */
require('dotenv').config();
const mongoose = require('mongoose');
const { Product, City, Customer, Vendor, LedgerEntry, Counter } = require('./models');

function computeMigrationPlan({ ledger, products, customers, vendors }) {
  const summary = { skuDuplicates: [], skuBackfillNeeded: [], voidedBackfillNeeded: [] };
  const seenSku = new Map();
  for (const p of products) {
    const skuLower = String(p.sku || '').toLowerCase();
    if (seenSku.has(skuLower)) summary.skuDuplicates.push([seenSku.get(skuLower), p.sku]);
    else seenSku.set(skuLower, p.sku);
    if (!p.skuLower) summary.skuBackfillNeeded.push(p._id || p.id);
  }
  ledger.forEach(e => { if (e.voided === undefined) summary.voidedBackfillNeeded.push(e._id || e.id); });

  const numericPart = (s) => Number(String(s || '').replace(/\D/g, '')) || 0;
  let maxSeen = 2000;
  ledger.forEach(e => { maxSeen = Math.max(maxSeen, Number(e.id) || 0); (e.items || []).forEach(it => { maxSeen = Math.max(maxSeen, numericPart(it.lineId)); }); });
  products.forEach(p => { maxSeen = Math.max(maxSeen, numericPart(p.id)); });
  customers.forEach(c => { maxSeen = Math.max(maxSeen, numericPart(c.id)); });
  vendors.forEach(v => { maxSeen = Math.max(maxSeen, numericPart(v.id)); });
  summary.counterSeedTarget = maxSeen;
  return summary;
}

async function migrate({ log = console.log } = {}) {
  const summary = { ledgerBackfilled: 0, counterSeededTo: null, productsChecked: 0, customersChecked: 0, vendorsChecked: 0, ledgerChecked: 0, skuDuplicates: [] };

  const [products, customers, vendors, ledger] = await Promise.all([
    Product.find().lean(), Customer.find().lean(), Vendor.find().lean(), LedgerEntry.find().lean()
  ]);
  summary.productsChecked = products.length;
  summary.customersChecked = customers.length;
  summary.vendorsChecked = vendors.length;
  summary.ledgerChecked = ledger.length;

  const plan = computeMigrationPlan({ ledger, products, customers, vendors });
  summary.skuDuplicates = plan.skuDuplicates;

  // 1) Backfill `voided: false` on any ledger entries saved before this field existed.
  if (plan.voidedBackfillNeeded.length) {
    const r = await LedgerEntry.updateMany({ voided: { $exists: false } }, { $set: { voided: false } });
    summary.ledgerBackfilled = r.modifiedCount || 0;
  }

  // 2) Seed skuLower for any Product saved before the case-insensitive-duplicate guard existed.
  for (const p of products) {
    if (!p.skuLower) await Product.updateOne({ _id: p._id }, { $set: { skuLower: String(p.sku || '').toLowerCase() } });
  }

  // 3) Seed the shared Counter forward so newly server-assigned ids never collide with
  //    anything that already exists — existing ids/lineIds are never touched or renumbered.
  await Counter.findOneAndUpdate({ _id: 'app' }, { $max: { seq: plan.counterSeedTarget } }, { upsert: true });
  const counterDoc = await Counter.findById('app').lean();
  summary.counterSeededTo = counterDoc.seq;

  log('Migration summary:', JSON.stringify(summary, null, 2));
  if (summary.skuDuplicates.length) {
    log('WARNING: pre-existing case-insensitive duplicate SKUs found (not modified, please review):', summary.skuDuplicates);
  }
  return summary;
}

if (require.main === module) {
  (async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) { console.error('Missing MONGODB_URI'); process.exit(1); }
    await mongoose.connect(uri);
    try {
      await migrate();
      console.log('Migration complete.');
    } finally {
      await mongoose.disconnect();
    }
  })().catch(err => { console.error('Migration failed:', err); process.exit(1); });
}

module.exports = { migrate, computeMigrationPlan };
