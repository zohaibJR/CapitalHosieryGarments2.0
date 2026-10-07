/* =====================================================================
   models.js — Mongoose schemas.
   ---------------------------------------------------------------------
   Extracted out of server.js so both server.js (routes it already owns)
   and repo.js / migrate.js (new database-architecture code) can share
   the exact same model definitions. This is the one intentional
   structural change to how server.js is organized for this phase —
   no field, validation rule, or route behavior that already existed
   was altered here; existing schemas are carried over unchanged, with
   only the additive fields this phase requires (voided/void metadata
   on LedgerEntry, plus two brand-new collections: Counter and
   AuditLog).
===================================================================== */
const mongoose = require('mongoose');

const cleanJson = {
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret._id;
    return ret;
  }
};

const User = mongoose.model(
  'User',
  new mongoose.Schema(
    {
      username: { type: String, required: true, unique: true, trim: true, lowercase: true },
      passwordHash: { type: String, required: true },
      passwordChangedAt: { type: Date, default: Date.now }
    },
    { timestamps: true, toJSON: cleanJson }
  )
);

const Product = mongoose.model(
  'Product',
  new mongoose.Schema(
    {
      id: { type: String, required: true, unique: true, index: true },
      sku: { type: String, required: true, unique: true, trim: true },
      skuLower: { type: String, required: true, unique: true, index: true }, // case-insensitive dup guard
      name: { type: String, required: true, trim: true },
      category: { type: String, required: true, trim: true },
      season: { type: String, required: true, trim: true },
      cost: { type: Number, required: true, min: 0 },
      wsale: { type: Number, required: true, min: 0 },
      retail: { type: Number, required: true, min: 0 },
      minStock: { type: Number, default: 0, min: 0 },
      unit: { type: String, default: 'pcs', trim: true },
      packSize: { type: Number, default: 1, min: 1 },
      active: { type: Boolean, default: true }
    },
    { timestamps: true, toJSON: cleanJson }
  )
);

const City = mongoose.model(
  'City',
  new mongoose.Schema(
    { name: { type: String, required: true, unique: true, trim: true } },
    { timestamps: true, toJSON: cleanJson }
  )
);

const Customer = mongoose.model(
  'Customer',
  new mongoose.Schema(
    {
      id: { type: String, required: true, unique: true, index: true },
      city: { type: String, required: true, trim: true, index: true },
      shop: { type: String, required: true, trim: true },
      owner: { type: String, required: true, trim: true },
      phone: { type: String, default: '', trim: true },
      address: { type: String, default: '', trim: true },
      opening: { type: Number, default: 0, min: 0 },
      creditLimit: { type: Number, default: 0, min: 0 }
    },
    { timestamps: true, toJSON: cleanJson }
  )
);

const Vendor = mongoose.model(
  'Vendor',
  new mongoose.Schema(
    {
      id: { type: String, required: true, unique: true, index: true },
      name: { type: String, required: true, trim: true },
      contact: { type: String, default: '', trim: true },
      phone: { type: String, default: '', trim: true },
      address: { type: String, default: '', trim: true },
      opening: { type: Number, default: 0, min: 0 }
    },
    { timestamps: true, toJSON: cleanJson }
  )
);

const LedgerEntry = mongoose.model(
  'LedgerEntry',
  new mongoose.Schema(
    {
      id: { type: Number, required: true, unique: true, index: true },
      type: { type: String, required: true, index: true },
      date: { type: String, required: true, index: true },
      time: String,

      customerId: { type: String, index: true },
      customerName: String,
      vendorId: { type: String, index: true },
      productId: { type: String, index: true },

      saleId: { type: Number, index: true },
      purchaseId: { type: Number, index: true },

      lineId: { type: String, index: true },
      invoiceRef: String,

      method: String,
      shop: String,

      qty: Number,
      packQty: Number,

      amount: Number,
      paidNow: Number,
      price: Number,
      amountOnly: Boolean,

      reason: String,
      notes: String,

      items: [
        {
          productId: String,
          qty: Number,
          price: Number,
          packQty: Number,
          lineId: String
        }
      ],

      // --- void system (additive; existing records default to false) ---
      voided: { type: Boolean, default: false, index: true },
      voidedAt: Date,
      voidedReason: String,
      voidedBy: String
    },
    { timestamps: true, toJSON: cleanJson, strict: false }
  )
);

// Single shared, atomically-incrementing counter — preserves the original
// frontend's single global `uid` sequence, so app-level IDs (ledger id,
// 'C'/'V'/'P'-prefixed ids, lineIds) keep exactly the same shape/format
// they always had, just assigned by the server instead of the browser.
const Counter = mongoose.model(
  'Counter',
  new mongoose.Schema({ _id: { type: String, required: true }, seq: { type: Number, default: 2000 } })
);

// Lightweight audit trail: one row per create/edit/void of a ledger entry.
const AuditLog = mongoose.model(
  'AuditLog',
  new mongoose.Schema(
    {
      appId: { type: Number, required: true, index: true },
      entryType: String,
      action: { type: String, required: true }, // 'create' | 'edit' | 'void'
      before: mongoose.Schema.Types.Mixed,
      after: mongoose.Schema.Types.Mixed,
      user: String
    },
    { timestamps: true, toJSON: cleanJson }
  )
);

module.exports = { cleanJson, User, Product, City, Customer, Vendor, LedgerEntry, Counter, AuditLog };
