const assert = require('assert');
const L = require('../ledgerLogic');

let pass=0, fail=0;
function t(name, fn){
  try { fn(); pass++; }
  catch(e){ fail++; console.error('FAIL:', name, '-', e.message); }
}

// ---- box/piece ----
t('120 pcs @6 = 20 boxes, 0 remainder', ()=>{
  const b = L.boxPieceBreakdown(120,6); assert.equal(b.boxes,20); assert.equal(b.remainder,0);
});
t('110 pcs @6 = 18 boxes + 2', ()=>{
  const b = L.boxPieceBreakdown(110,6); assert.equal(b.boxes,18); assert.equal(b.remainder,2);
});
t('125 pcs @6 = 20 boxes + 5', ()=>{
  const b = L.boxPieceBreakdown(125,6); assert.equal(b.boxes,20); assert.equal(b.remainder,5);
});
t('resolvePackQty: exact match kept, mismatch discarded', ()=>{
  assert.equal(L.resolvePackQty(120,'20',6), 20);
  assert.equal(L.resolvePackQty(110,'20',6), undefined);
  assert.equal(L.resolvePackQty(110,'',6), undefined);
});

// ---- stock ----
function mkLedger(){
  return [
    {id:1, type:'vendor_purchase', vendorId:'V1', items:[{productId:'P1', qty:100}]},
    {id:2, type:'wholesale_sale', customerId:'C1', items:[{productId:'P1', qty:30}]},
    {id:3, type:'stock_transfer', productId:'P1', qty:10},
    {id:4, type:'adjustment', productId:'P1', shop:'Lower', qty:-2},
  ];
}
t('productStock Upper = 100 - 30 - 10(transferred out) = 60', ()=>{
  assert.equal(L.productStock(mkLedger(),'P1','Upper'), 60);
});
t('productStock Lower = 10(transferred in) - 2(adjustment) = 8', ()=>{
  assert.equal(L.productStock(mkLedger(),'P1','Lower'), 8);
});
t('productStock excludeAppId removes that entry\'s effect', ()=>{
  assert.equal(L.productStock(mkLedger(),'P1','Upper', 2), 90); // sale (id 2) excluded -> 100-10
});
t('voided entries are excluded from stock', ()=>{
  const l = mkLedger(); l[1].voided = true; // void the sale
  assert.equal(L.productStock(l,'P1','Upper'), 90);
});

// ---- customer/vendor balance ----
t('customerBalance: opening + sales - recoveries - discounts - returns', ()=>{
  const l = [
    {id:1, type:'wholesale_sale', customerId:'C1', amount:1000},
    {id:2, type:'wholesale_recovery', customerId:'C1', amount:300},
    {id:3, type:'wholesale_discount', customerId:'C1', amount:50},
    {id:4, type:'wholesale_return', customerId:'C1', amount:100},
  ];
  assert.equal(L.customerBalance(l, {id:'C1', opening:500}), 500+1000-300-50-100);
});
t('vendorBalance: opening + purchases - payments - returns', ()=>{
  const l = [
    {id:1, type:'vendor_purchase', vendorId:'V1', amount:2000},
    {id:2, type:'vendor_payment', vendorId:'V1', amount:800},
    {id:3, type:'vendor_return', vendorId:'V1', amount:200},
  ];
  assert.equal(L.vendorBalance(l, {id:'V1', opening:0}), 2000-800-200);
});

// ---- retail sale due ----
t('retailSaleDue = amount - paidNow - payments - discounts - returns, floored at 0', ()=>{
  const sale = {id:10, type:'retail_sale', amount:1000, paidNow:200};
  const l = [sale,
    {id:11, type:'retail_payment', saleId:10, amount:300},
    {id:12, type:'retail_discount', saleId:10, amount:100},
    {id:13, type:'retail_return', saleId:10, amount:150},
  ];
  assert.equal(L.retailSaleDue(l, sale), 1000-200-300-100-150);
});
t('retailSaleDue never goes negative', ()=>{
  const sale = {id:10, type:'retail_sale', amount:100, paidNow:100};
  const l = [sale, {id:11, type:'retail_payment', saleId:10, amount:50}];
  assert.equal(L.retailSaleDue(l, sale), 0);
});

// ---- return eligibility (exclude self) ----
t('returnEligibilityInfo excludes the return being edited from otherReturned', ()=>{
  const sale = {id:1, type:'wholesale_sale', customerId:'C1', items:[{productId:'P1', qty:100, lineId:'L1'}]};
  const r1 = {id:2, type:'wholesale_return', customerId:'C1', saleId:1, lineId:'L1', qty:20};
  const r2 = {id:3, type:'wholesale_return', customerId:'C1', saleId:1, lineId:'L1', qty:15};
  const l = [sale, r1, r2];
  const elig = L.returnEligibilityInfo(l, r2);
  assert.equal(elig.originalQty, 100);
  assert.equal(elig.otherReturned, 20); // only r1, r2 excluded from its own total
  assert.equal(elig.maxAllowed, 80);
});
t('validateReturnEdit throws ValidationError when exceeding max', ()=>{
  const sale = {id:1, type:'wholesale_sale', customerId:'C1', items:[{productId:'P1', qty:20, lineId:'L1'}]};
  const r1 = {id:2, type:'wholesale_return', customerId:'C1', saleId:1, lineId:'L1', productId:'P1', qty:5};
  assert.throws(()=>L.validateReturnEdit([sale,r1], r1, 21), L.ValidationError);
  assert.doesNotThrow(()=>L.validateReturnEdit([sale,r1], r1, 20));
});

// ---- items edit: lineId preservation / return protection ----
t('validateItemsEdit rejects reducing below returned qty', ()=>{
  const purchase = {id:0, type:'vendor_purchase', vendorId:'V1', items:[{productId:'P1', qty:100}]};
  const sale = {id:1, type:'wholesale_sale', customerId:'C1', items:[{productId:'P1', qty:100, lineId:'L1'}]};
  const ret = {id:2, type:'wholesale_return', customerId:'C1', saleId:1, lineId:'L1', qty:20};
  const l = [purchase, sale, ret];
  assert.throws(()=>L.validateItemsEdit(l, sale, [{productId:'P1', qty:10, lineId:'L1'}], 'Upper', -1), /below 20/);
  assert.doesNotThrow(()=>L.validateItemsEdit(l, sale, [{productId:'P1', qty:80, lineId:'L1'}], 'Upper', -1));
});
t('validateItemsEdit rejects removing a returned line', ()=>{
  const sale = {id:1, type:'wholesale_sale', customerId:'C1', items:[{productId:'P1', qty:100, lineId:'L1'}]};
  const ret = {id:2, type:'wholesale_return', customerId:'C1', saleId:1, lineId:'L1', qty:20};
  assert.throws(()=>L.validateItemsEdit([sale,ret], sale, [], 'Upper', -1), /Cannot remove/);
});
t('validateItemsEdit rejects changing product on a returned line', ()=>{
  const sale = {id:1, type:'wholesale_sale', customerId:'C1', items:[{productId:'P1', qty:100, lineId:'L1'}]};
  const ret = {id:2, type:'wholesale_return', customerId:'C1', saleId:1, lineId:'L1', qty:20};
  assert.throws(()=>L.validateItemsEdit([sale,ret], sale, [{productId:'P2', qty:100, lineId:'L1'}], 'Upper', -1), /change the product/);
});
t('validateItemsEdit rejects new qty exceeding available stock (exclude self)', ()=>{
  const sale = {id:1, type:'wholesale_sale', customerId:'C1', items:[{productId:'P1', qty:30, lineId:'L1'}]};
  const purchase = {id:0, type:'vendor_purchase', vendorId:'V1', items:[{productId:'P1', qty:50}]};
  const l = [purchase, sale];
  // stock excluding sale#1 = 50; requesting 60 should fail, 50 should pass
  assert.throws(()=>L.validateItemsEdit(l, sale, [{productId:'P1', qty:60, lineId:'L1'}], 'Upper', -1), /Not enough stock/);
  assert.doesNotThrow(()=>L.validateItemsEdit(l, sale, [{productId:'P1', qty:50, lineId:'L1'}], 'Upper', -1));
});
t('validateItemsEdit (purchase, positive dir) rejects reduction that would make stock negative', ()=>{
  const purchase = {id:1, type:'vendor_purchase', vendorId:'V1', items:[{productId:'P1', qty:100, lineId:'L1'}]};
  const sale = {id:2, type:'wholesale_sale', customerId:'C1', items:[{productId:'P1', qty:90}]};
  const l = [purchase, sale];
  // current stock = 100-90=10; reducing purchase to 80 -> effective stock excl. purchase = 10-100=-90, +80=-10 -> reject
  assert.throws(()=>L.validateItemsEdit(l, purchase, [{productId:'P1', qty:80}], 'Upper', 1), /below zero/);
  assert.doesNotThrow(()=>L.validateItemsEdit(l, purchase, [{productId:'P1', qty:95}], 'Upper', 1));
});

// ---- amount ceiling exclude-self ----
t('validateAmountEdit: recovery exceeding balance rejected; exact limit allowed', ()=>{
  const l = [{id:1, type:'wholesale_sale', customerId:'C1', amount:1000}];
  const rec = {id:2, type:'wholesale_recovery', customerId:'C1', amount:400};
  l.push(rec);
  // current balance = 1000-400=600; max allowed for editing rec = 600+400=1000
  assert.throws(()=>L.validateAmountEdit(l, rec, 1001, {id:'C1',opening:0}), L.ValidationError);
  assert.doesNotThrow(()=>L.validateAmountEdit(l, rec, 1000, {id:'C1',opening:0}));
});
t('validateAmountEdit: does not double-count the transaction being edited (re-saving unchanged passes)', ()=>{
  const l = [{id:1, type:'wholesale_sale', customerId:'C1', amount:500}];
  const rec = {id:2, type:'wholesale_recovery', customerId:'C1', amount:500};
  l.push(rec);
  assert.doesNotThrow(()=>L.validateAmountEdit(l, rec, 500, {id:'C1',opening:0}));
});
t('validateAmountEdit: retail payment exceeding remaining due rejected', ()=>{
  const sale = {id:1, type:'retail_sale', amount:1000, paidNow:0};
  const pay = {id:2, type:'retail_payment', saleId:1, amount:600};
  const l = [sale, pay];
  assert.throws(()=>L.validateAmountEdit(l, pay, 1001, null, null), L.ValidationError);
  assert.doesNotThrow(()=>L.validateAmountEdit(l, pay, 1000, null, null));
});

// ---- void dependency protection ----
t('validateVoid blocks voiding a sale with an active return', ()=>{
  const sale = {id:1, type:'wholesale_sale', customerId:'C1'};
  const ret = {id:2, type:'wholesale_return', saleId:1};
  assert.throws(()=>L.validateVoid([sale,ret], sale), /other active records/);
});
t('validateVoid allows voiding a sale once its return is already voided', ()=>{
  const sale = {id:1, type:'wholesale_sale', customerId:'C1'};
  const ret = {id:2, type:'wholesale_return', saleId:1, voided:true};
  assert.doesNotThrow(()=>L.validateVoid([sale,ret], sale));
});
t('validateVoid blocks voiding a retail sale with active payment/discount/return', ()=>{
  const sale = {id:1, type:'retail_sale'};
  assert.throws(()=>L.validateVoid([sale,{id:2,type:'retail_payment',saleId:1}], sale));
  assert.throws(()=>L.validateVoid([sale,{id:2,type:'retail_discount',saleId:1}], sale));
  assert.throws(()=>L.validateVoid([sale,{id:2,type:'retail_return',saleId:1}], sale));
});
t('validateVoid blocks double-void', ()=>{
  assert.throws(()=>L.validateVoid([], {id:1, type:'adjustment', voided:true}), /already voided/);
});
t('validateVoid allows a plain recovery/payment/adjustment/transfer', ()=>{
  assert.doesNotThrow(()=>L.validateVoid([], {id:1, type:'wholesale_recovery'}));
  assert.doesNotThrow(()=>L.validateVoid([], {id:1, type:'adjustment'}));
  assert.doesNotThrow(()=>L.validateVoid([], {id:1, type:'stock_transfer'}));
});

// ---- amount-only sale ----
t('isAmountOnlySale detects both explicit flag and empty items', ()=>{
  assert.equal(L.isAmountOnlySale({type:'wholesale_sale', amountOnly:true, items:[]}), true);
  assert.equal(L.isAmountOnlySale({type:'wholesale_sale', items:[]}), true);
  assert.equal(L.isAmountOnlySale({type:'wholesale_sale', items:[{productId:'P1',qty:1}]}), false);
});
t('validateItemsStockForCreate: amount-only sale (no items) never touches stock validation', ()=>{
  assert.doesNotThrow(()=>L.validateItemsStockForCreate([], 'wholesale_sale', [], 'Upper'));
});
t('validateItemsStockForCreate rejects insufficient stock', ()=>{
  const l = [{id:1, type:'vendor_purchase', vendorId:'V1', items:[{productId:'P1', qty:10}]}];
  assert.throws(()=>L.validateItemsStockForCreate(l, 'wholesale_sale', [{productId:'P1', qty:11}], 'Upper'), /Not enough stock/);
  assert.doesNotThrow(()=>L.validateItemsStockForCreate(l, 'wholesale_sale', [{productId:'P1', qty:10}], 'Upper'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
