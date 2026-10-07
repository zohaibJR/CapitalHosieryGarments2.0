/* =====================================================================
   routes.js — granular, record-level API (replaces per-action full-state
   overwrite with Create/Update/Void operations on individual records).
   ---------------------------------------------------------------------
   Exported as a factory, createApiRouter(repo), so the exact same route
   logic can run against the real MongoDB repository (repo.js) or a fake
   in-memory one (test/fakeRepo.js) for testing. `repo` is the only way
   these routes touch data — see repo.js / test/fakeRepo.js for the two
   implementations of that shared interface.
===================================================================== */
const express = require('express');
const L = require('./ledgerLogic');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Resolves "$0"/"$1"... placeholders (used to let one entry in a create
// batch reference another entry created earlier in the SAME batch, e.g.
// a retail_discount's saleId referencing the retail_sale being created
// alongside it) against the already-created entries in this batch.
function resolvePlaceholders(entry, createdSoFar) {
  const out = { ...entry };
  ['saleId', 'purchaseId'].forEach(k => {
    if (typeof out[k] === 'string' && /^\$\d+$/.test(out[k])) {
      const idx = Number(out[k].slice(1));
      out[k] = createdSoFar[idx] ? createdSoFar[idx].id : undefined;
    }
  });
  return out;
}

function stockShopFor(type, entry) {
  if (type === 'retail_sale') return entry.shop || 'Lower';
  return 'Upper';
}

// Per-type server-side create validation, mirroring the frontend's own
// creation-time checks (never inventing stricter/newer business rules).
async function validateCreateEntry(repo, ledger, entry, customersById, vendorsById) {
  switch (entry.type) {
    case 'wholesale_sale': {
      if (!entry.customerId || !customersById[entry.customerId]) throw new L.ValidationError('Unknown wholesale shop/customer');
      const amountOnly = L.isAmountOnlySale(entry);
      if (amountOnly) {
        if (!(entry.amount > 0)) throw new L.ValidationError('Enter a valid sale amount greater than 0');
      } else {
        if (!entry.items || !entry.items.length) throw new L.ValidationError('Add at least one item, or mark this an amount-only sale');
        entry.items.forEach(it => { if (!L.isPositiveInt(it.qty)) throw new L.ValidationError('Quantity must be a whole number greater than 0'); if (!(it.price > 0)) throw new L.ValidationError('Price must be greater than 0'); });
        L.validateItemsStockForCreate(ledger, 'wholesale_sale', entry.items, 'Upper');
      }
      return;
    }
    case 'retail_sale': {
      if (!entry.items || !entry.items.length) throw new L.ValidationError('Add at least one item');
      entry.items.forEach(it => { if (!L.isPositiveInt(it.qty)) throw new L.ValidationError('Quantity must be a whole number greater than 0'); });
      L.validateItemsStockForCreate(ledger, 'retail_sale', entry.items, entry.shop || 'Lower');
      return;
    }
    case 'vendor_purchase': {
      if (!entry.vendorId || !vendorsById[entry.vendorId]) throw new L.ValidationError('Unknown vendor');
      if (!entry.items || !entry.items.length) throw new L.ValidationError('Add at least one item');
      entry.items.forEach(it => { if (!L.isPositiveInt(it.qty)) throw new L.ValidationError('Quantity must be a whole number greater than 0'); if (!(it.price > 0)) throw new L.ValidationError('Cost must be greater than 0'); });
      return;
    }
    case 'wholesale_recovery':
    case 'wholesale_discount': {
      if (!entry.customerId || !customersById[entry.customerId]) throw new L.ValidationError('Unknown wholesale shop/customer');
      if (!(entry.amount > 0)) throw new L.ValidationError('Amount must be greater than 0');
      L.validateAmountCreate(ledger, entry, customersById[entry.customerId], null);
      return;
    }
    case 'retail_payment':
    case 'retail_discount': {
      if (!(entry.amount > 0)) throw new L.ValidationError('Amount must be greater than 0');
      const sale = ledger.find(x => x.id === entry.saleId);
      if (!sale) throw new L.ValidationError('The related retail sale could not be found');
      L.validateAmountCreate(ledger, entry, null, null);
      return;
    }
    case 'vendor_payment': {
      if (!entry.vendorId || !vendorsById[entry.vendorId]) throw new L.ValidationError('Unknown vendor');
      if (!(entry.amount > 0)) throw new L.ValidationError('Amount must be greater than 0');
      L.validateAmountCreate(ledger, entry, null, vendorsById[entry.vendorId]);
      return;
    }
    case 'wholesale_return':
    case 'retail_return':
    case 'vendor_return': {
      L.validateReturnCreate(ledger, entry);
      return;
    }
    case 'stock_transfer': {
      if (!L.isPositiveInt(entry.qty)) throw new L.ValidationError('Quantity must be a whole number greater than 0');
      const avail = L.productStock(ledger, entry.productId, 'Upper');
      if (avail < entry.qty) throw new L.ValidationError(`Not enough stock in Upper Shop (only ${avail} available)`);
      return;
    }
    case 'adjustment': {
      if (!Number.isInteger(entry.qty) || entry.qty === 0) throw new L.ValidationError('Adjustment quantity must be a non-zero whole number');
      if (entry.qty < 0) {
        const avail = L.productStock(ledger, entry.productId, entry.shop);
        if (avail + entry.qty < 0) throw new L.ValidationError(`Adjustment would make stock negative (only ${avail} available)`);
      }
      return;
    }
    default:
      throw new L.ValidationError(`Unknown transaction type: ${entry.type}`);
  }
}

function createApiRouter(repo) {
  const router = express.Router();

  /* =====================================================================
     PRODUCTS
  ===================================================================== */
  router.post('/products', asyncHandler(async (req, res) => {
    const b = req.body || {};
    const sku = String(b.sku || '').trim();
    const skuLower = sku.toLowerCase();
    if (!sku) throw new L.ValidationError('SKU is required');
    if (await repo.findProductBySkuLower(skuLower)) throw new L.ValidationError('A product with this SKU already exists');
    const { result } = await repo.withTransaction(async (session) => {
      const id = 'P' + (await repo.nextAppId(1, session));
      const product = await repo.insertProduct({
        id, sku, skuLower, name: b.name, category: b.category, season: b.season,
        cost: b.cost, wsale: b.wsale, retail: b.retail, minStock: b.minStock || 0,
        unit: b.unit || 'pcs', packSize: b.packSize || 1, active: true
      }, session);
      let adjustment = null;
      if (b.openingStock && b.openingStock.qty > 0) {
        const ledger = await repo.allLedger();
        const entry = {
          id: await repo.nextAppId(1, session), type: 'adjustment', productId: id,
          shop: b.openingStock.shop, qty: b.openingStock.qty,
          packQty: L.resolvePackQty(b.openingStock.qty, b.openingStock.boxesRaw, b.packSize || 1),
          reason: 'Opening Stock', notes: 'Set when product was created', date: b.date || todayISO(), voided: false
        };
        const inserted = await repo.insertLedgerMany([entry], session);
        adjustment = inserted[0];
        await repo.recordAudit({ appId: adjustment.id, entryType: 'adjustment', action: 'create', before: null, after: adjustment, user: req.user && req.user.username }, session);
      }
      await repo.recordAudit({ appId: 0, entryType: 'product', action: 'create', before: null, after: product, user: req.user && req.user.username }, session);
      return { product, adjustment };
    });
    res.status(201).json(result);
  }));

  router.put('/products/:id', asyncHandler(async (req, res) => {
    const existing = await repo.getProduct(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    if (req.body.expectedUpdatedAt && String(existing.updatedAt) !== String(req.body.expectedUpdatedAt)) {
      throw new L.ConflictError('This product was changed elsewhere — reload and try again.', existing);
    }
    const patch = {};
    ['name', 'category', 'season', 'cost', 'wsale', 'retail', 'minStock', 'unit', 'packSize', 'active'].forEach(k => {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    });
    const updated = await repo.updateProduct(req.params.id, patch);
    await repo.recordAudit({ appId: 0, entryType: 'product', action: 'edit', before: existing, after: updated, user: req.user && req.user.username });
    res.json(updated);
  }));

  /* =====================================================================
     CITIES
  ===================================================================== */
  router.post('/cities', asyncHandler(async (req, res) => {
    const name = String((req.body || {}).name || '').trim();
    if (!name) throw new L.ValidationError('Enter a city name');
    const cities = await repo.allCities();
    if (cities.includes(name)) throw new L.ValidationError('City already exists');
    await repo.insertCity(name);
    res.status(201).json({ name });
  }));

  router.put('/cities/:name', asyncHandler(async (req, res) => {
    const oldName = req.params.name;
    const newName = String((req.body || {}).newName || '').trim();
    if (!newName) throw new L.ValidationError('Enter a new city name');
    const cities = await repo.allCities();
    if (!cities.includes(oldName)) return res.status(404).json({ error: 'City not found' });
    if (newName !== oldName && cities.includes(newName)) throw new L.ValidationError('A city with that name already exists');
    const { result } = await repo.withTransaction(async (session) => {
      const customersUpdated = await repo.renameCity(oldName, newName, session);
      return { name: newName, customersUpdated };
    });
    res.json(result);
  }));

  /* =====================================================================
     CUSTOMERS (wholesale shops)
  ===================================================================== */
  router.post('/customers', asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.shop || !b.owner) throw new L.ValidationError('Enter shop and owner name');
    if (!(b.opening >= 0)) throw new L.ValidationError('Opening Balance cannot be negative');
    if (!(b.creditLimit >= 0)) throw new L.ValidationError('Credit Limit cannot be negative');
    const id = 'C' + (await repo.nextAppId(1));
    const customer = await repo.insertCustomer({ id, city: b.city, shop: b.shop, owner: b.owner, phone: b.phone || '', address: b.address || '', opening: b.opening || 0, creditLimit: b.creditLimit || 0 });
    await repo.recordAudit({ appId: 0, entryType: 'customer', action: 'create', before: null, after: customer, user: req.user && req.user.username });
    res.status(201).json(customer);
  }));

  router.put('/customers/:id', asyncHandler(async (req, res) => {
    const existing = await repo.getCustomer(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Shop not found' });
    if (req.body.expectedUpdatedAt && String(existing.updatedAt) !== String(req.body.expectedUpdatedAt)) {
      throw new L.ConflictError('This shop was changed elsewhere — reload and try again.', existing);
    }
    const b = req.body || {};
    if (b.shop !== undefined && !String(b.shop).trim()) throw new L.ValidationError('Enter shop and owner name');
    if (b.owner !== undefined && !String(b.owner).trim()) throw new L.ValidationError('Enter shop and owner name');
    if (b.opening !== undefined && isNaN(Number(b.opening))) throw new L.ValidationError('Opening Balance must be a number');
    const patch = {};
    ['shop', 'owner', 'phone', 'address', 'creditLimit', 'opening'].forEach(k => { if (b[k] !== undefined) patch[k] = b[k]; });
    const updated = await repo.updateCustomer(req.params.id, patch);
    await repo.recordAudit({ appId: 0, entryType: 'customer', action: 'edit', before: existing, after: updated, user: req.user && req.user.username });
    res.json(updated);
  }));

  /* =====================================================================
     VENDORS
  ===================================================================== */
  router.post('/vendors', asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.name) throw new L.ValidationError('Enter vendor name');
    if (!(b.opening >= 0)) throw new L.ValidationError('Opening Payable cannot be negative');
    const id = 'V' + (await repo.nextAppId(1));
    const vendor = await repo.insertVendor({ id, name: b.name, contact: b.contact || '', phone: b.phone || '', address: b.address || '', opening: b.opening || 0 });
    await repo.recordAudit({ appId: 0, entryType: 'vendor', action: 'create', before: null, after: vendor, user: req.user && req.user.username });
    res.status(201).json(vendor);
  }));

  router.put('/vendors/:id', asyncHandler(async (req, res) => {
    const existing = await repo.getVendor(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Vendor not found' });
    if (req.body.expectedUpdatedAt && String(existing.updatedAt) !== String(req.body.expectedUpdatedAt)) {
      throw new L.ConflictError('This vendor was changed elsewhere — reload and try again.', existing);
    }
    const b = req.body || {};
    if (b.name !== undefined && !String(b.name).trim()) throw new L.ValidationError('Enter vendor name');
    if (b.opening !== undefined && isNaN(Number(b.opening))) throw new L.ValidationError('Opening Payable must be a number');
    const patch = {};
    ['name', 'contact', 'phone', 'address', 'opening'].forEach(k => { if (b[k] !== undefined) patch[k] = b[k]; });
    const updated = await repo.updateVendor(req.params.id, patch);
    await repo.recordAudit({ appId: 0, entryType: 'vendor', action: 'edit', before: existing, after: updated, user: req.user && req.user.username });
    res.json(updated);
  }));

  /* =====================================================================
     LEDGER (transactions) — create, edit, void
  ===================================================================== */
  router.post('/ledger', asyncHandler(async (req, res) => {
    const entries = (req.body || {}).entries;
    if (!Array.isArray(entries) || !entries.length) throw new L.ValidationError('No transactions to create');

    const { result } = await repo.withTransaction(async (session) => {
      const ledger = await repo.allLedger();
      const customers = await repo.allCustomers();
      const vendors = await repo.allVendors();
      const customersById = Object.fromEntries(customers.map(c => [c.id, c]));
      const vendorsById = Object.fromEntries(vendors.map(v => [v.id, v]));

      const created = [];
      const toInsert = [];
      const runningLedger = ledger.slice(); // grows as this batch's entries are conceptually applied, so a
                                             // recovery/discount created alongside a sale is validated after it
      for (let i = 0; i < entries.length; i++) {
        const raw = resolvePlaceholders(entries[i], created);
        // For a new return, establish a write-dependency on its parent sale/
        // purchase BEFORE validating — see repo.touchLedgerEntry for why.
        if (['wholesale_return', 'retail_return', 'vendor_return'].includes(raw.type)) {
          const parentId = raw.type === 'vendor_return' ? raw.purchaseId : raw.saleId;
          if (parentId != null) await repo.touchLedgerEntry(parentId, session);
        }
        await validateCreateEntry(repo, runningLedger, raw, customersById, vendorsById);
        const id = await repo.nextAppId(1, session);
        const items = [];
        for (const it of (raw.items || [])) {
          const lineId = it.lineId || ('L' + (await repo.nextAppId(1, session)));
          items.push({ ...it, lineId });
        }
        // Server is authoritative on the money amount for item-based transactions —
        // it is always recomputed from qty*price, never trusted verbatim from the client.
        if (items.length && ['wholesale_sale', 'retail_sale', 'vendor_purchase'].includes(raw.type)) {
          raw.amount = items.reduce((s, it) => s + it.qty * it.price, 0);
        }
        const doc = { ...raw, id, items, date: raw.date || todayISO(), voided: false };
        toInsert.push(doc);
        const placeholder = { ...doc };
        created.push(placeholder);
        runningLedger.push(placeholder);
      }
      const inserted = await repo.insertLedgerMany(toInsert, session);
      for (const doc of inserted) {
        await repo.recordAudit({ appId: doc.id, entryType: doc.type, action: 'create', before: null, after: doc, user: req.user && req.user.username }, session);
      }
      return inserted;
    });
    res.status(201).json({ entries: result });
  }));

  router.put('/ledger/:appId', asyncHandler(async (req, res) => {
    const appId = Number(req.params.appId);
    const existing = await repo.getLedgerByAppId(appId);
    if (!existing) return res.status(404).json({ error: 'Transaction not found' });
    if (existing.voided) throw new L.ValidationError('This transaction has been voided and can no longer be edited');
    if (req.body.expectedUpdatedAt && String(existing.updatedAt) !== String(req.body.expectedUpdatedAt)) {
      throw new L.ConflictError('This transaction was changed elsewhere — reload and try again.', existing);
    }

    const ledger = await repo.allLedger();
    const b = req.body || {};
    let patch = {};

    if (['wholesale_sale', 'retail_sale', 'vendor_purchase'].includes(existing.type) && !L.isAmountOnlySale(existing)) {
      const newItems = (b.items || []).map(it => ({ productId: it.productId, qty: it.qty, price: it.price, boxesRaw: it.boxesRaw, lineId: it.lineId || undefined }));
      if (!newItems.length) throw new L.ValidationError('Add at least one item');
      newItems.forEach(it => { if (!L.isPositiveInt(it.qty)) throw new L.ValidationError('Quantity must be a whole number greater than 0'); if (!(it.price > 0)) throw new L.ValidationError('Price must be greater than 0'); });
      const stockShop = stockShopFor(existing.type, existing);
      const stockDir = existing.type === 'vendor_purchase' ? 1 : -1;
      L.validateItemsEdit(ledger, existing, newItems, stockShop, stockDir);
      const items = [];
      let total = 0;
      for (const it of newItems) {
        const lineId = it.lineId || ('L' + (await repo.nextAppId(1)));
        items.push({ productId: it.productId, qty: it.qty, price: it.price, packQty: L.resolvePackQty(it.qty, it.boxesRaw, b.packSize), lineId });
        total += it.qty * it.price;
      }
      patch = { items, amount: total, date: b.date || existing.date };
      if (existing.type === 'wholesale_sale' || existing.type === 'vendor_purchase') patch.invoiceRef = b.invoiceRef || undefined;
    } else if (existing.type === 'wholesale_sale') { // amount-only
      if (!(b.amount > 0)) throw new L.ValidationError('Amount must be greater than 0');
      patch = { amount: b.amount, date: b.date || existing.date, invoiceRef: b.invoiceRef || undefined };
    } else if (['wholesale_return', 'retail_return', 'vendor_return'].includes(existing.type)) {
      if (!L.isPositiveInt(b.qty)) throw new L.ValidationError('Quantity must be a whole number greater than 0');
      if (!(b.amount > 0)) throw new L.ValidationError('Amount must be greater than 0');
      L.validateReturnEdit(ledger, existing, b.qty);
      const product = await repo.getProduct(existing.productId);
      patch = { qty: b.qty, amount: b.amount, date: b.date || existing.date, packQty: L.resolvePackQty(b.qty, b.boxesRaw, product ? product.packSize : 1), notes: b.notes || undefined };
    } else if (existing.type === 'stock_transfer') {
      if (!L.isPositiveInt(b.qty)) throw new L.ValidationError('Quantity must be a whole number greater than 0');
      const avail = L.productStock(ledger, existing.productId, 'Upper', existing.id);
      if (avail < b.qty) throw new L.ValidationError(`Not enough stock in Upper Shop for this transfer (only ${avail} effectively available)`);
      const product = await repo.getProduct(existing.productId);
      patch = { qty: b.qty, date: b.date || existing.date, packQty: L.resolvePackQty(b.qty, b.boxesRaw, product ? product.packSize : 1), notes: b.notes || undefined };
    } else if (existing.type === 'adjustment') {
      const mag = Number(b.qty);
      if (!L.isPositiveInt(mag)) throw new L.ValidationError('Quantity must be a whole number greater than 0');
      const qty = b.direction === 'remove' ? -mag : mag;
      if (qty < 0) {
        const avail = L.productStock(ledger, existing.productId, existing.shop, existing.id);
        if (avail < mag) throw new L.ValidationError(`Removing ${mag} would take ${existing.shop} Shop stock below zero (only ${avail} effectively available)`);
      }
      const product = await repo.getProduct(existing.productId);
      patch = { qty, date: b.date || existing.date, packQty: L.resolvePackQty(mag, b.boxesRaw, product ? product.packSize : 1), reason: b.reason || 'Adjustment', notes: b.notes || undefined };
    } else if (['wholesale_recovery', 'wholesale_discount', 'retail_payment', 'retail_discount', 'vendor_payment'].includes(existing.type)) {
      if (!(b.amount > 0)) throw new L.ValidationError('Amount must be greater than 0');
      const customer = existing.customerId ? await repo.getCustomer(existing.customerId) : null;
      const vendor = existing.vendorId ? await repo.getVendor(existing.vendorId) : null;
      L.validateAmountEdit(ledger, existing, b.amount, customer, vendor);
      patch = { amount: b.amount, date: b.date || existing.date, notes: b.notes || undefined };
      if (b.method !== undefined) patch.method = b.method;
    } else {
      throw new L.ValidationError(`Editing "${existing.type}" is not supported`);
    }

    const isReturnEdit = ['wholesale_return', 'retail_return', 'vendor_return'].includes(existing.type);
    const { result } = await repo.withTransaction(async (session) => {
      if (isReturnEdit) {
        // Re-establish the write-dependency on the parent (see repo.touchLedgerEntry)
        // and re-validate against a FRESH read taken inside this transaction,
        // so a concurrent return against the same line can't be missed.
        const parentId = existing.type === 'vendor_return' ? existing.purchaseId : existing.saleId;
        if (parentId != null) await repo.touchLedgerEntry(parentId, session);
        const freshLedger = await repo.allLedger();
        L.validateReturnEdit(freshLedger, existing, patch.qty);
      }
      const updated = await repo.updateLedgerByAppId(appId, patch, session);
      await repo.recordAudit({ appId, entryType: existing.type, action: 'edit', before: existing, after: updated, user: req.user && req.user.username }, session);
      return updated;
    });
    res.json(result);
  }));

  router.post('/ledger/:appId/void', asyncHandler(async (req, res) => {
    const appId = Number(req.params.appId);
    const existing = await repo.getLedgerByAppId(appId);
    if (!existing) return res.status(404).json({ error: 'Transaction not found' });
    const ledger = await repo.allLedger();
    const customer = existing.customerId ? await repo.getCustomer(existing.customerId) : null;
    const vendor = existing.vendorId ? await repo.getVendor(existing.vendorId) : null;
    L.validateVoid(ledger, existing, customer, vendor);
    const reason = String((req.body || {}).reason || '').trim();
    const { result } = await repo.withTransaction(async (session) => {
      // Re-validate against a fresh read inside the transaction — stock/
      // balance could have moved between the check above and this write.
      const freshLedger = await repo.allLedger();
      L.validateVoid(freshLedger, existing, customer, vendor);
      const updated = await repo.updateLedgerByAppId(appId, { voided: true, voidedAt: new Date(), voidedReason: reason || undefined, voidedBy: req.user && req.user.username }, session);
      await repo.recordAudit({ appId, entryType: existing.type, action: 'void', before: existing, after: updated, user: req.user && req.user.username }, session);
      return updated;
    });
    res.json({ ok: true, entry: result });
  }));

  /* =====================================================================
     AUDIT
  ===================================================================== */
  router.get('/audit/:appId', asyncHandler(async (req, res) => {
    res.json(await repo.auditFor(Number(req.params.appId)));
  }));
  router.get('/audit', asyncHandler(async (req, res) => {
    res.json(await repo.auditRecent());
  }));

  return router;
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

module.exports = { createApiRouter, validateCreateEntry, resolvePlaceholders };
