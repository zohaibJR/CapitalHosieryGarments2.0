/* =====================================================================
   ledgerLogic.js — pure, framework-free business logic.
   ---------------------------------------------------------------------
   This is a direct, faithful port of the calculation/validation logic
   that already lives in frontend/app.js (productStock, customerBalance,
   vendorBalance, retailSaleDue, return-eligibility, amount ceilings,
   box/piece math). It is intentionally NOT a new accounting model —
   it is the SAME rules, now also enforced on the server so a client
   can never bypass them by skipping frontend validation.

   Every function here takes plain data (arrays/objects) and returns
   plain data. Nothing here touches Mongoose/Express, which is what
   makes it possible to unit-test this file directly with plain
   Node assertions, and to reuse it from both the real MongoDB-backed
   repository and a fake in-memory repository used in tests.
===================================================================== */

function activeLedger(ledger){
  return ledger.filter(e => !e.voided);
}

/* ---- stock ---- */
function productStock(ledger, pid, shop, excludeAppId){
  let stock = 0;
  activeLedger(ledger).forEach(e=>{
    if(excludeAppId!=null && e.id===excludeAppId) return;
    if(e.type==='vendor_purchase' && shop==='Upper'){ (e.items||[]).forEach(it=>{ if(it.productId===pid) stock += it.qty; }); }
    else if(e.type==='vendor_return' && shop==='Upper'){ if(e.productId===pid) stock -= e.qty; }
    else if(e.type==='wholesale_sale' && shop==='Upper'){ (e.items||[]).forEach(it=>{ if(it.productId===pid) stock -= it.qty; }); }
    else if(e.type==='wholesale_return' && shop==='Upper'){ if(e.productId===pid) stock += e.qty; }
    else if(e.type==='stock_transfer'){ if(e.productId===pid){ stock += (shop==='Lower') ? e.qty : -e.qty; } }
    else if(e.type==='retail_sale' && shop==='Lower'){ (e.items||[]).forEach(it=>{ if(it.productId===pid) stock -= it.qty; }); }
    else if(e.type==='retail_return' && shop==='Lower'){ if(e.productId===pid) stock += e.qty; }
    else if(e.type==='adjustment' && e.shop===shop){ if(e.productId===pid) stock += e.qty; }
  });
  return stock;
}

/* ---- customer / vendor balances ---- */
function customerBalance(ledger, customer){
  let bal = customer ? (customer.opening||0) : 0;
  activeLedger(ledger).forEach(e=>{
    if(!customer || e.customerId!==customer.id) return;
    if(e.type==='wholesale_sale') bal += e.amount;
    else if(e.type==='wholesale_recovery') bal -= e.amount;
    else if(e.type==='wholesale_discount') bal -= e.amount;
    else if(e.type==='wholesale_return') bal -= e.amount;
  });
  return bal;
}
function vendorBalance(ledger, vendor){
  let bal = vendor ? (vendor.opening||0) : 0;
  activeLedger(ledger).forEach(e=>{
    if(!vendor || e.vendorId!==vendor.id) return;
    if(e.type==='vendor_purchase') bal += e.amount;
    else if(e.type==='vendor_payment') bal -= e.amount;
    else if(e.type==='vendor_return') bal -= e.amount;
  });
  return bal;
}

/* ---- retail sale paid/due ---- */
function retailSalePaidTotal(ledger, saleEntry){
  if(!saleEntry) return 0;
  let paid = saleEntry.paidNow||0;
  activeLedger(ledger).forEach(e=>{ if(e.type==='retail_payment' && e.saleId===saleEntry.id) paid += e.amount; });
  return paid;
}
function retailSaleDiscounts(ledger, saleEntry){
  if(!saleEntry) return 0;
  let d = 0;
  activeLedger(ledger).forEach(e=>{ if(e.type==='retail_discount' && e.saleId===saleEntry.id) d += e.amount; });
  return d;
}
function retailSaleReturnsTotal(ledger, saleEntry){
  if(!saleEntry) return 0;
  let r = 0;
  activeLedger(ledger).forEach(e=>{ if(e.type==='retail_return' && e.saleId===saleEntry.id) r += e.amount; });
  return r;
}
function retailSaleDue(ledger, saleEntry){
  if(!saleEntry) return 0;
  const due = saleEntry.amount - retailSalePaidTotal(ledger, saleEntry) - retailSaleDiscounts(ledger, saleEntry) - retailSaleReturnsTotal(ledger, saleEntry);
  return Math.max(0, due);
}

/* ---- box/piece normalization (mirrors frontend exactly) ---- */
function boxPieceBreakdown(qty, packSize){
  if(!(packSize>1)) return null;
  const q = Math.abs(Number(qty)||0);
  const boxes = Math.floor(q/packSize);
  const remainder = q % packSize;
  return { boxes, remainder, pack: packSize };
}
function resolvePackQty(qty, boxesRaw, packSize){
  const boxes = Number(boxesRaw);
  if(boxesRaw==='' || boxesRaw==null || !(boxes>0)) return undefined;
  const pack = packSize||1;
  return (boxes*pack===Number(qty)) ? boxes : undefined;
}

/* ---- effective lineId (mirrors frontend fallback for legacy data) ---- */
function effLineId(parentAppId, item){
  return item.lineId || `${parentAppId}-${item.productId}`;
}

/* ---- returned-qty-per-line for item-based sales/purchases ---- */
const RETURN_TYPE_FOR_ITEMS_TXN = {wholesale_sale:'wholesale_return', retail_sale:'retail_return', vendor_purchase:'vendor_return'};
function returnedQtyForLine(ledger, parentEntry, lineId){
  const rtype = RETURN_TYPE_FOR_ITEMS_TXN[parentEntry.type];
  if(!rtype || !lineId) return 0;
  return activeLedger(ledger).filter(r=>{
    if(r.type!==rtype || r.lineId!==lineId) return false;
    if(parentEntry.type==='wholesale_sale') return r.customerId===parentEntry.customerId;
    if(parentEntry.type==='vendor_purchase') return r.vendorId===parentEntry.vendorId;
    if(parentEntry.type==='retail_sale') return r.saleId===parentEntry.id;
    return true;
  }).reduce((s,r)=>s+r.qty,0);
}

/* ---- return-edit eligibility (current return excluded from its own total) ---- */
function returnEligibilityInfo(ledger, returnEntry){
  let parent = null;
  if(returnEntry.type==='wholesale_return' || returnEntry.type==='retail_return') parent = ledger.find(x=>x.id===returnEntry.saleId);
  else if(returnEntry.type==='vendor_return') parent = ledger.find(x=>x.id===returnEntry.purchaseId);
  let originalQty = null;
  if(parent && parent.items){
    const line = parent.items.find(it=>effLineId(parent.id, it)===returnEntry.lineId);
    if(line) originalQty = line.qty;
  }
  if(originalQty==null) originalQty = returnEntry.qty;
  const otherReturned = activeLedger(ledger).filter(r=>{
    if(r.id===returnEntry.id || r.type!==returnEntry.type || r.lineId!==returnEntry.lineId) return false;
    if(returnEntry.type==='vendor_return') return r.vendorId===returnEntry.vendorId;
    if(returnEntry.type==='retail_return') return r.saleId===returnEntry.saleId;
    return r.customerId===returnEntry.customerId;
  }).reduce((s,r)=>s+r.qty,0);
  return { originalQty, otherReturned, maxAllowed: Math.max(0, originalQty - otherReturned) };
}

/* ---- amount-transaction ceiling (current transaction excluded) ---- */
function amountTxnMaxAllowed(ledger, entry, customer, vendor){
  if(entry.type==='wholesale_recovery' || entry.type==='wholesale_discount'){
    return customerBalance(ledger, customer) + entry.amount;
  }
  if(entry.type==='vendor_payment'){
    return vendorBalance(ledger, vendor) + entry.amount;
  }
  if(entry.type==='retail_payment' || entry.type==='retail_discount'){
    const sale = ledger.find(x=>x.id===entry.saleId);
    if(!sale) return Infinity;
    return retailSaleDue(ledger, sale) + entry.amount;
  }
  return Infinity;
}

/* ---- create-time amount ceiling (no self-exclusion needed — entry is new) ---- */
function amountTxnMaxAllowedCreate(ledger, type, customer, vendor, saleId){
  if(type==='wholesale_recovery' || type==='wholesale_discount') return customerBalance(ledger, customer);
  if(type==='vendor_payment') return vendorBalance(ledger, vendor);
  if(type==='retail_payment' || type==='retail_discount'){
    const sale = ledger.find(x=>x.id===saleId);
    if(!sale) return Infinity;
    return retailSaleDue(ledger, sale);
  }
  return Infinity;
}

/* ---- balance recomputed as if one specific entry were also removed ---- */
function customerBalanceExcluding(ledger, customer, excludeAppId){
  return customerBalance(ledger.filter(e=>e.id!==excludeAppId), customer);
}
function vendorBalanceExcluding(ledger, vendor, excludeAppId){
  return vendorBalance(ledger.filter(e=>e.id!==excludeAppId), vendor);
}

// Which (productId, shop) stock figures a given ledger entry's existence affects.
// Used both to validate voids (would removing this entry's effect make stock
// negative?) and is deliberately the SAME productStock(...,excludeId) mechanism
// already used for edit-time stock validation, just applied to every product/
// shop pair a type can touch.
function stockCheckTargets(entry){
  const out = [];
  if(entry.type==='vendor_purchase' || entry.type==='wholesale_sale'){
    (entry.items||[]).forEach(it=>out.push({productId:it.productId, shop:'Upper'}));
  } else if(entry.type==='retail_sale'){
    (entry.items||[]).forEach(it=>out.push({productId:it.productId, shop:entry.shop||'Lower'}));
  } else if(entry.type==='wholesale_return' || entry.type==='vendor_return'){
    out.push({productId:entry.productId, shop:'Upper'});
  } else if(entry.type==='retail_return'){
    out.push({productId:entry.productId, shop:'Lower'});
  } else if(entry.type==='stock_transfer'){
    out.push({productId:entry.productId, shop:'Upper'});
    out.push({productId:entry.productId, shop:'Lower'});
  } else if(entry.type==='adjustment'){
    out.push({productId:entry.productId, shop:entry.shop});
  }
  return out;
}

/* ---- validation entry points used by the API routes ---- */
class ValidationError extends Error {
  constructor(message){ super(message); this.status = 400; this.name = 'ValidationError'; }
}
class ConflictError extends Error {
  constructor(message, current){ super(message); this.status = 409; this.name = 'ConflictError'; this.current = current; }
}

function isPositiveInt(v){ return Number.isInteger(v) && v>0; }
function isAmountOnlySale(e){ return e && e.type==='wholesale_sale' && (e.amountOnly || !(e.items && e.items.length)); }

// Validates a freshly-built wholesale_sale/retail_sale/vendor_purchase item list
// against current stock, exactly mirroring the frontend's own creation checks.
function validateItemsStockForCreate(ledger, type, items, shop){
  if(type==='wholesale_sale' || type==='retail_sale'){
    const qtyByProduct = {};
    items.forEach(it=>{ qtyByProduct[it.productId] = (qtyByProduct[it.productId]||0) + it.qty; });
    for(const [pid, qty] of Object.entries(qtyByProduct)){
      if(productStock(ledger, pid, shop) < qty) throw new ValidationError(`Not enough stock in ${shop} Shop for the total quantity requested of one of the items`);
    }
  }
}

// Validates an edited items-based transaction: return-protection (req 2/3),
// lineId preservation (req 1), and stock (excluding the transaction's own old effect).
function validateItemsEdit(ledger, existingEntry, newItems, stockShop, stockDir){
  // 1) Every original line that already has returns must still be present,
  //    same product, quantity no lower than what has been returned.
  for(const orig of (existingEntry.items||[])){
    const origLid = effLineId(existingEntry.id, orig);
    const returned = returnedQtyForLine(ledger, existingEntry, origLid);
    if(returned<=0) continue;
    const match = newItems.find(r=>effLineId(existingEntry.id, {lineId:r.lineId, productId:r.productId})===origLid);
    if(!match) throw new ValidationError(`Cannot remove this line — ${returned} pieces have already been returned against it`);
    if(match.productId!==orig.productId) throw new ValidationError(`Cannot change the product on this line — ${returned} pieces have already been returned against it`);
    if(match.qty < returned) throw new ValidationError(`Cannot reduce this ${existingEntry.type==='vendor_purchase'?'purchase':'sale'} below ${returned} pieces because ${returned} pieces have already been returned against it.`);
  }
  // 2) Stock, as if this transaction's OLD effect never happened.
  const qtyByProduct = {};
  newItems.forEach(r=>{ qtyByProduct[r.productId] = (qtyByProduct[r.productId]||0) + r.qty; });
  if(stockDir < 0){
    for(const [pid, qty] of Object.entries(qtyByProduct)){
      if(productStock(ledger, pid, stockShop, existingEntry.id) < qty) throw new ValidationError('Not enough stock available for the new quantity of one of the items');
    }
  } else {
    for(const [pid, qty] of Object.entries(qtyByProduct)){
      if(productStock(ledger, pid, stockShop, existingEntry.id) + qty < 0) throw new ValidationError('Reducing this purchase would take stock below zero — some of it may have already been sold or transferred out');
    }
  }
}

function validateReturnEdit(ledger, returnEntry, newQty){
  const elig = returnEligibilityInfo(ledger, returnEntry);
  if(newQty > elig.maxAllowed) throw new ValidationError(`Cannot return more than ${elig.maxAllowed} pieces here — the original line had ${elig.originalQty}, and ${elig.otherReturned} are already returned against it elsewhere`);
  if(returnEntry.type==='vendor_return'){
    const avail = productStock(ledger, returnEntry.productId, 'Upper', returnEntry.id);
    if(avail < newQty) throw new ValidationError(`Reducing Upper Shop stock by ${newQty} would take it below zero (only ${avail} effectively available)`);
  }
  return elig;
}

function validateAmountEdit(ledger, entry, newAmount, customer, vendor){
  const maxAllowed = amountTxnMaxAllowed(ledger, entry, customer, vendor);
  if(newAmount > maxAllowed + 0.01) throw new ValidationError(`Amount cannot exceed ${maxAllowed.toFixed(2)} (the relevant outstanding/due/payable, excluding this transaction)`);
  return maxAllowed;
}

// Create-time equivalent of validateAmountEdit — no transaction exists yet to
// exclude, so the ceiling is simply the CURRENT outstanding/due/payable.
function validateAmountCreate(ledger, entry, customer, vendor){
  const maxAllowed = amountTxnMaxAllowedCreate(ledger, entry.type, customer, vendor, entry.saleId);
  if(entry.amount > maxAllowed + 0.01) throw new ValidationError(`Amount cannot exceed ${maxAllowed.toFixed(2)} (the current outstanding/due/payable)`);
  return maxAllowed;
}

// Create-time validation for a brand-new wholesale/retail/vendor return.
// Never trusts the client's productId/lineId — looks up the real parent
// transaction and its real line, and only derives eligibility from that.
function validateReturnCreate(ledger, entry){
  if(!isPositiveInt(entry.qty)) throw new ValidationError('Quantity must be a whole number greater than 0');
  const PARENT_FIELD = {wholesale_return:'saleId', retail_return:'saleId', vendor_return:'purchaseId'};
  const PARENT_TYPE  = {wholesale_return:'wholesale_sale', retail_return:'retail_sale', vendor_return:'vendor_purchase'};
  const parentId = entry[PARENT_FIELD[entry.type]];
  const parent = ledger.find(x=>x.id===parentId);
  if(!parent || parent.voided) throw new ValidationError('The original sale/purchase could not be found (it may not exist, or has been voided)');
  if(parent.type!==PARENT_TYPE[entry.type]) throw new ValidationError('The referenced transaction is not the right type for this return');
  if(entry.type==='wholesale_return' && parent.customerId!==entry.customerId) throw new ValidationError("This return does not match the original sale's customer");
  if(entry.type==='vendor_return' && parent.vendorId!==entry.vendorId) throw new ValidationError("This return does not match the original purchase's vendor");
  if(entry.type==='retail_return' && entry.saleId!==parent.id) throw new ValidationError('This return does not match the original sale');
  const line = (parent.items||[]).find(it=>effLineId(parent.id, it)===entry.lineId);
  if(!line) throw new ValidationError('The referenced line could not be found on the original transaction');
  if(line.productId!==entry.productId) throw new ValidationError('Product does not match the referenced line');
  const alreadyReturned = returnedQtyForLine(ledger, parent, entry.lineId);
  const maxAllowed = Math.max(0, line.qty - alreadyReturned);
  if(entry.qty > maxAllowed) throw new ValidationError(`Cannot return more than ${maxAllowed} pieces — the original line had ${line.qty} pieces, and ${alreadyReturned} ${alreadyReturned===1?'is':'are'} already returned against it`);
  if(entry.type==='vendor_return'){
    const avail = productStock(ledger, entry.productId, 'Upper');
    if(avail < entry.qty) throw new ValidationError(`Not enough stock in Upper Shop to return (only ${avail} available)`);
  }
  return { parent, line, alreadyReturned, maxAllowed };
}

// Void safety: a transaction can only be voided if removing its active effect
// cannot create an impossible state. Three independent checks:
//   1) Dependency check — a sale/purchase can't be voided while active child
//      records (returns, and for retail sales: payments/discounts too) still
//      reference it.
//   2) Stock check — would removing this entry's stock effect take any
//      product/shop it touches negative, given everything that happened
//      since (e.g. a vendor purchase whose stock has already been sold on)?
//   3) Balance check — for a wholesale sale or a vendor purchase specifically,
//      because recoveries/payments are tracked at the overall customer/vendor
//      level (not per-invoice — this is intentionally unchanged), would
//      removing this one sale/purchase push that overall balance negative?
function validateVoid(ledger, entry, customer, vendor){
  if(entry.voided) throw new ValidationError('This transaction is already voided');

  if(entry.type==='wholesale_sale' || entry.type==='retail_sale' || entry.type==='vendor_purchase'){
    const childTypes = entry.type==='vendor_purchase' ? ['vendor_return'] : entry.type==='retail_sale' ? ['retail_return','retail_payment','retail_discount'] : ['wholesale_return'];
    const parentKey = entry.type==='vendor_purchase' ? 'purchaseId' : 'saleId';
    const hasChildren = activeLedger(ledger).some(e=> childTypes.includes(e.type) && e[parentKey]===entry.id );
    if(hasChildren) throw new ValidationError('Cannot void this transaction — other active records (returns/payments/discounts) are linked to it. Void those first.');
  }

  for(const c of stockCheckTargets(entry)){
    if(productStock(ledger, c.productId, c.shop, entry.id) < 0){
      throw new ValidationError(`Cannot void this transaction — the stock it introduced into ${c.shop} Shop has already been used elsewhere; voiding it would make stock negative.`);
    }
  }

  if(entry.type==='wholesale_sale' && customer){
    if(customerBalanceExcluding(ledger, customer, entry.id) < 0){
      throw new ValidationError("Cannot void this sale — the customer's overall outstanding balance would go negative. Recoveries are tracked against the overall balance, not this specific sale, so removing it here isn't safe.");
    }
  }
  if(entry.type==='vendor_purchase' && vendor){
    if(vendorBalanceExcluding(ledger, vendor, entry.id) < 0){
      throw new ValidationError("Cannot void this purchase — the vendor's overall payable would go negative. Payments are tracked against the overall payable, not this specific purchase, so removing it here isn't safe.");
    }
  }
}

module.exports = {
  activeLedger, productStock, customerBalance, vendorBalance,
  retailSalePaidTotal, retailSaleDiscounts, retailSaleReturnsTotal, retailSaleDue,
  boxPieceBreakdown, resolvePackQty, effLineId, returnedQtyForLine, returnEligibilityInfo,
  amountTxnMaxAllowed, amountTxnMaxAllowedCreate, isPositiveInt, isAmountOnlySale,
  customerBalanceExcluding, vendorBalanceExcluding, stockCheckTargets,
  validateItemsStockForCreate, validateItemsEdit, validateReturnEdit, validateAmountEdit, validateVoid,
  validateAmountCreate, validateReturnCreate,
  ValidationError, ConflictError
};
