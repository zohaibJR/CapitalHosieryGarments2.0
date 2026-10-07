const results = [];
function check(label, cond, extra){ results.push({label, pass: !!cond, extra: extra===undefined?'':String(extra)}); }
function val(id,v){ document.getElementById(id).value = v; }
async function reload(){ return await (await fetch('/api/state')).json(); }

window.confirm = () => true;
window.prompt = () => 'test reason';

(async () => {
try {
  // ============================================================
  // TEST A — CREATE OPERATIONS (+ reload-and-verify after each)
  // ============================================================
  openAddCity(); val('newCityName','Lahore'); await saveNewCity();
  let st = await reload();
  check('A: city persisted and comes back from the store on reload', st.cities.includes('Lahore'));

  openAddProduct();
  val('npName','Mens Trunk'); document.getElementById('npCat').value='Men'; document.getElementById('npSeason').value='Summer';
  val('npCost','100'); val('npWsale','150'); val('npRetail','200'); val('npPack','6'); val('npOpenBoxes','20'); updateNpOpeningPreview(); val('npOpenShop','Upper');
  await saveNewProduct();
  const product = products.find(p=>p.name==='Mens Trunk');
  check('A: product created with a server-assigned id', !!product && /^P/.test(product.id), product&&product.id);
  st = await reload();
  const persistedProduct = st.products.find(p=>p.id===product.id);
  check('A: product persisted (reload) with correct fields', persistedProduct && persistedProduct.sku===product.sku && persistedProduct.packSize===6);
  check('A: opening stock adjustment created atomically alongside the product', st.ledger.some(e=>e.type==='adjustment' && e.productId===product.id && e.qty===120));
  check('A: box/piece math — 120 pcs @ pack 6', productStock(product.id,'Upper')===120, productStock(product.id,'Upper'));

  openAddShop();
  val('newShopCity','Lahore'); val('newShopName','ABC Shop'); val('newShopOwner','Zafar');
  val('newShopPhone','0300-1111111'); val('newShopOpening','50000'); val('newShopLimit','0');
  await saveNewShop();
  const shop = customers.find(c=>c.shop==='ABC Shop');
  check('A: shop created with server-assigned id and correct opening balance', !!shop && shop.opening===50000);
  st = await reload();
  check('A: shop persisted (reload)', st.customers.some(c=>c.id===shop.id && c.opening===50000));

  openAddVendor();
  val('nvName','Sialkot Textiles'); val('nvContact','Waseem'); val('nvPhone','0300-2222222'); val('nvOpening','0');
  await saveNewVendor();
  const vendor = vendors.find(v=>v.name==='Sialkot Textiles');
  check('A: vendor created', !!vendor);

  const stockBefore = productStock(product.id,'Upper');
  openWholesaleSale(shop.id);
  document.querySelectorAll('#wsLines .line-row select')[0].value = product.id;
  document.querySelectorAll('#wsLines .line-row .wsQty')[0].value = '30';
  updateWsTotals();
  await saveWholesaleSale(shop.id);
  const sale = ledger.filter(e=>e.type==='wholesale_sale' && e.items.length).pop();
  check('A: wholesale sale (product-based) created, amount recomputed server-side', sale && sale.amount===4500, sale&&sale.amount);
  check('A: inventory decreased correctly', productStock(product.id,'Upper')===stockBefore-30);
  st = await reload();
  check('A: sale persisted (reload) with same id and items', st.ledger.some(e=>e.id===sale.id && e.items[0].qty===30));

  openWholesaleSale(shop.id);
  document.getElementById('wsAmountOnly').checked = true; toggleWsAmountOnly();
  val('wsAmountOnlyAmt','5000'); updateWsTotals();
  const stockBeforeAO = productStock(product.id,'Upper');
  await saveWholesaleSale(shop.id);
  const aoSale = ledger.filter(e=>e.type==='wholesale_sale' && (!e.items||!e.items.length)).pop();
  check('TEST5/A: amount-only wholesale sale created', aoSale && aoSale.amount===5000 && aoSale.items.length===0);
  check('TEST5: inventory unaffected by amount-only sale', productStock(product.id,'Upper')===stockBeforeAO);
  check('TEST5: customer balance updated by amount-only sale', customerBalance(shop.id)===50000+4500+5000, customerBalance(shop.id));
  st = await reload();
  check('TEST5: amount-only sale persisted with no fabricated product data', st.ledger.some(e=>e.id===aoSale.id && e.items.length===0 && e.amount===5000));

  openRecovery(shop.id); val('recAmt','1000'); await saveRecovery(shop.id);
  check('A: recovery created', ledger.some(e=>e.type==='wholesale_recovery' && e.amount===1000));

  // GAP1 (new): recovery above outstanding is rejected at CREATE time too
  const balNow = customerBalance(shop.id);
  openRecovery(shop.id); val('recAmt', String(balNow+1));
  const recErrBefore = document.getElementById('recErr').textContent;
  await saveRecovery(shop.id);
  check('GAP1: creating a recovery above outstanding is REJECTED (server-side, not just client-side)', document.getElementById('recErr').style.display!=='none' && customerBalance(shop.id)===balNow, customerBalance(shop.id));
  closeModal();

  openTransfer(); document.getElementById('xferItem').value=product.id; val('xferQty','40'); await doTransfer();
  check('A: transfer created, Lower stock increased', productStock(product.id,'Lower')===40);

  openNewRetailSale('Lower');
  document.querySelectorAll('#saleLines .line-row select')[0].value = product.id;
  document.querySelectorAll('#saleLines .line-row .saleQty')[0].value = '10';
  updateSaleTotals(); val('salePaid','1000');
  await saveRetailSale();
  const retailSale = ledger.filter(e=>e.type==='retail_sale').pop();
  check('A: retail sale created', !!retailSale && retailSale.amount===2000);
  check('A: retail-shop inventory decreased', productStock(product.id,'Lower')===30);

  openNewPurchase(vendor.id);
  document.querySelectorAll('#poLines .line-row select')[0].value = product.id;
  document.querySelectorAll('#poLines .line-row .poQty')[0].value = '100';
  document.querySelectorAll('#poLines .line-row .poCost')[0].value = '100';
  updatePoTotals(); val('poRef','INV-1');
  const upperStockBeforePurchase = productStock(product.id,'Upper');
  await savePurchase();
  const purchase = ledger.filter(e=>e.type==='vendor_purchase').pop();
  check('A: vendor purchase created, stock increased', !!purchase && productStock(product.id,'Upper')===upperStockBeforePurchase+100, productStock(product.id,'Upper'));

  ui.invShop='Upper';
  openAdjustStock(product.id); document.getElementById('adjDirection').value='remove'; val('adjPieces','5'); document.getElementById('adjReason').value='Damaged'; await saveAdjustStock(product.id);
  check('A: adjustment created', ledger.some(e=>e.type==='adjustment' && e.qty===-5));

  openWholesaleReturn(shop.id);
  let idx = _wrItems.findIndex(x=>x.saleId===sale.id);
  document.getElementById('wrProduct').value = String(idx);
  val('wrQty','5'); await saveWholesaleReturn(shop.id);
  const wret = ledger.find(e=>e.type==='wholesale_return');
  check('A: wholesale return created', !!wret);

  st = await reload();
  check('A: EVERY created record is present after a full reload from the store', ['customers','vendors','products'].every(k=>st[k].length>0) && st.ledger.length===ledger.length, st.ledger.length+' vs '+ledger.length);

  // ============================================================
  // TEST B/C — EDIT (no duplicate, same id, lineId preserved) + returns protection
  // ============================================================
  const lineId = sale.items[0].lineId;
  check('Setup: sale line has a stable lineId', !!lineId);
  const ledgerLenBefore = ledger.length;

  openEditItemsTxn(sale.id);
  document.querySelector('#editItemLines .eiQty').value = '3'; // below the 5 already returned -> must reject
  await saveEditItemsTxn(sale.id);
  check('C/TEST7: editing sale down to 3 pieces when 5 are already returned is REJECTED', sale.items[0].qty===30, sale.items[0].qty);
  closeModal();

  openEditItemsTxn(sale.id);
  document.querySelector('#editItemLines .eiQty').value = '25'; // >= the 5 already returned -> must allow
  await saveEditItemsTxn(sale.id);
  check('C/TEST8: editing sale 30->25 (>=5 returned) is ALLOWED, same id', sale.id && sale.items[0].qty===25, sale.items[0].qty);
  check('TEST8: original lineId unchanged after edit', sale.items[0].lineId===lineId, sale.items[0].lineId);
  check('B: no duplicate record created by the edit', ledger.filter(e=>e.id===sale.id).length===1 && ledger.length===ledgerLenBefore);
  st = await reload();
  const persistedSale = st.ledger.find(e=>e.id===sale.id);
  check('B: edit persisted after reload (same id, same lineId, new qty)', persistedSale.items[0].qty===25 && persistedSale.items[0].lineId===lineId);

  // TEST 9 / req7 — editing the return itself, excluding self from eligibility
  openEditReturnTxn(wret.id);
  document.getElementById('editQty').value = '25';
  await saveEditReturnTxn(wret.id);
  check('TEST9: return edit allowed up to the full remaining eligible quantity', wret.qty===25, wret.qty);
  openEditReturnTxn(wret.id);
  document.getElementById('editQty').value = '26';
  await saveEditReturnTxn(wret.id);
  check('TEST9: return edit beyond eligible quantity REJECTED (still 25)', wret.qty===25, wret.qty);
  closeModal();
  openEditReturnTxn(wret.id); document.getElementById('editQty').value='5'; await saveEditReturnTxn(wret.id);
  openEditItemsTxn(sale.id); document.querySelector('#editItemLines .eiQty').value='30'; await saveEditItemsTxn(sale.id);

  // ============================================================
  // TEST 10 — payment/recovery/discount edit ceiling, self excluded
  // ============================================================
  const recEntry = ledger.find(e=>e.type==='wholesale_recovery');
  const bal = customerBalance(shop.id);
  openEditAmountTxn(recEntry.id);
  document.getElementById('editAmt').value = String(bal + recEntry.amount + 1);
  await saveEditAmountTxn(recEntry.id);
  check('TEST10: recovery edit above outstanding REJECTED', recEntry.amount===1000, recEntry.amount);
  openEditAmountTxn(recEntry.id);
  document.getElementById('editAmt').value = String(bal + recEntry.amount);
  await saveEditAmountTxn(recEntry.id);
  check('TEST10: recovery edit to exact outstanding ALLOWED (self excluded)', recEntry.amount===bal+1000, recEntry.amount);
  openEditAmountTxn(recEntry.id); document.getElementById('editAmt').value='1000'; await saveEditAmountTxn(recEntry.id);
  closeModal();

  // ============================================================
  // TEST H — VOID / DELETE (incl. new stock/balance safety)
  // ============================================================
  const purchaseForVoid = ledger.filter(e=>e.type==='vendor_purchase').pop();
  openVendorReturn(vendor.id);
  const vidx = _vrItems.findIndex(x=>x.purchaseId===purchaseForVoid.id);
  document.getElementById('vrProduct').value = String(vidx);
  val('vrQty','10'); await saveVendorReturn(vendor.id);
  const vret = ledger.find(e=>e.type==='vendor_return');
  await confirmVoidLedger(purchaseForVoid.id);
  check('H: void a purchase WITH an active vendor return is BLOCKED', !ledger.find(e=>e.id===purchaseForVoid.id).voided);
  await confirmVoidLedger(vret.id);
  check('H: void a plain vendor return works', ledger.find(e=>e.id===vret.id).voided===true);
  await confirmVoidLedger(purchaseForVoid.id);
  check('H: void the purchase now ALLOWED once its return is voided', ledger.find(e=>e.id===purchaseForVoid.id).voided===true);
  st = await reload();
  check('H: void persisted after reload', st.ledger.find(e=>e.id===purchaseForVoid.id).voided===true);

  // void-safety (GAP3-D), isolated scenario: a sale + a recovery that exactly
  // covers it. Voiding the sale while that recovery stands must be blocked;
  // voiding the recovery first, then the sale, must be allowed.
  openAddShop(); val('newShopCity','Lahore'); val('newShopName','DEF Shop'); val('newShopOwner','Bilal'); val('newShopOpening','0'); val('newShopLimit','0'); await saveNewShop();
  const shopD = customers.find(c=>c.shop==='DEF Shop');
  openWholesaleSale(shopD.id); document.getElementById('wsAmountOnly').checked=true; toggleWsAmountOnly(); val('wsAmountOnlyAmt','1000'); updateWsTotals(); await saveWholesaleSale(shopD.id);
  const saleD = ledger.filter(e=>e.type==='wholesale_sale' && e.customerId===shopD.id).pop();
  openRecovery(shopD.id); val('recAmt','1000'); await saveRecovery(shopD.id);
  const recD = ledger.find(e=>e.type==='wholesale_recovery' && e.customerId===shopD.id);
  await confirmVoidLedger(saleD.id);
  check('GAP3-D: void a wholesale sale that would push customer balance negative is BLOCKED', !ledger.find(e=>e.id===saleD.id).voided);
  await confirmVoidLedger(recD.id);
  check('GAP3-D: void the covering recovery first succeeds', ledger.find(e=>e.id===recD.id).voided===true);
  await confirmVoidLedger(saleD.id);
  check('GAP3-D: void the sale is now ALLOWED once the covering recovery is voided (balance has room again)', ledger.find(e=>e.id===saleD.id).voided===true);

  const recForVoid = ledger.find(e=>e.type==='wholesale_recovery' && e.customerId===shop.id);
  const custBalBeforeVoid = customerBalance(shop.id);
  await confirmVoidLedger(recForVoid.id);
  check('H: void a simple recovery works and balance recalculates (goes back up)', customerBalance(shop.id)===custBalBeforeVoid+recForVoid.amount, customerBalance(shop.id));
  const auditRows = await (await fetch(`/api/audit/${recForVoid.id}`)).json();
  check('Audit trail recorded create+void for the voided recovery', auditRows.some(a=>a.action==='create') && auditRows.some(a=>a.action==='void'));

  // ============================================================
  // TEST 2/3 — box/piece normalization + manual entry (unaffected by DB phase)
  // ============================================================
  check('TEST2: 120pcs@6 = 20 Boxes', boxesDisplay(120,product)==='20');
  check('TEST2: 110pcs@6 = 18 +2pc', boxesDisplay(110,product)==='18 +2pc');
  check('TEST2: 125pcs@6 = 20 +5pc', boxesDisplay(125,product)==='20 +5pc');
  ui.invShop='Upper';
  openAdjustStock(product.id); document.getElementById('adjDirection').value='add'; val('adjPieces','200'); document.getElementById('adjReason').value='Physical Stock Count'; await saveAdjustStock(product.id);
  const stockForManual = productStock(product.id,'Upper');
  openWholesaleSale(shop.id);
  document.querySelectorAll('#wsLines .line-row select')[0].value = product.id;
  document.querySelectorAll('#wsLines .line-row .wsQty')[0].value = '110';
  updateWsTotals();
  await saveWholesaleSale(shop.id);
  const manualSale = ledger.filter(e=>e.type==='wholesale_sale' && e.items.length && e.items[0].qty===110).pop();
  check('TEST3: manual entry of 110 pieces accepted, not forced to 120', !!manualSale, manualSale);
  check('TEST3: stock reduced by exactly 110', productStock(product.id,'Upper')===stockForManual-110);
  openWholesaleSaleItems(manualSale.id);
  check('TEST 11/I: View Items shows normalized 18 Boxes + 2 Pieces (not 20 boxes)', document.getElementById('modalBody').textContent.includes('18 Boxes + 2 Pieces'));
  closeModal();

  // ============================================================
  // TEST F — MULTI-CLIENT / STALE STATE
  // ============================================================
  const snapshotBeforeF = await reload();
  const bRes = await fetch('/api/ledger', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({entries:[{type:'wholesale_recovery', customerId:shop.id, amount:1, method:'Cash'}]})});
  const bCreated = (await bRes.json()).entries[0];
  openEditVendor(vendor.id); val('evPhone','0333-9999999'); await saveEditVendor(vendor.id);
  const afterF = await reload();
  check('F: Session A\'s action did NOT erase Session B\'s new transaction (no full-state overwrite)', afterF.ledger.some(e=>e.id===bCreated.id));
  check('F: Session A\'s own change was saved too', afterF.vendors.find(v=>v.id===vendor.id).phone==='0333-9999999');
  const staleShop = snapshotBeforeF.customers.find(c=>c.id===shop.id);
  await fetch(`/api/customers/${shop.id}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({phone:'0111-1111111'})});
  const staleRes = await fetch(`/api/customers/${shop.id}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({phone:'0000', expectedUpdatedAt: staleShop.updatedAt})});
  check('F: stale concurrent edit (based on a since-superseded updatedAt) is REJECTED with 409', staleRes.status===409, staleRes.status);
  const freshShop = (await reload()).customers.find(c=>c.id===shop.id);
  const freshRes = await fetch(`/api/customers/${shop.id}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({phone:'0300-1111111', expectedUpdatedAt: freshShop.updatedAt})});
  check('F: edit with the CURRENT updatedAt succeeds', freshRes.status===200, freshRes.status);

  // ============================================================
  // GAP4 — legacy PUT /api/state is disabled; GET still works
  // ============================================================
  const legacyPut = await fetch('/api/state', {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({products:[],cities:[],customers:[],vendors:[],ledger:[]})});
  check('GAP4: PUT /api/state is disabled (410)', legacyPut.status===410, legacyPut.status);
  const afterLegacyPut = await reload();
  check('GAP4: data untouched by the disabled PUT attempt', afterLegacyPut.customers.length===snapshotBeforeF.customers.length, afterLegacyPut.customers.length);
  check('GAP4: GET /api/state still works for hydration', Array.isArray(afterLegacyPut.ledger) && afterLegacyPut.ledger.length>0);

  // ============================================================
  // View Items / Vendor Invoice / Retail Sale Detail spot checks
  // ============================================================
  openVendorPurchaseItems(purchase.id);
  const vpText = document.getElementById('modalBody').textContent;
  check('TEST12: vendor View Items shows product/sku and Invoice button still present', vpText.includes('Mens Trunk') && document.getElementById('modalBody').innerHTML.includes('printPurchaseInvoice'));
  closeModal();
  openRetailSaleDetail(retailSale.id);
  const rsText = document.getElementById('modalBody').textContent;
  check('TEST13: retail sale detail shows item, paid, due', rsText.includes('Mens Trunk') && rsText.includes('Paid'));
  closeModal();

  // ============================================================
  // Full Transaction Excel still works end-to-end
  // ============================================================
  if(!document.getElementById('repFrom')){ const f=document.createElement('input'); f.id='repFrom'; document.body.appendChild(f); const t=document.createElement('input'); t.id='repTo'; document.body.appendChild(t); }
  exportReport('all');
  const rows = window.__lastWorkbook.wb.sheets.find(s=>s.name==='Full Transaction Log').ws.__rows;
  check('TEST16: Full Transaction export has rows, includes opening balance and amount-only sale, no duplicates', rows.length>1 && rows.some(r=>r[0]==='(Opening)') && rows.some(r=>r[1]==='Wholesale Sale (Amount Only)'));
  const dup = rows.length - new Set(rows.map(r=>JSON.stringify(r))).size;
  check('TEST16: no duplicate rows in Excel', dup===0, dup);

  const finalState = await reload();
  check('J: full application state is durable across a reload (server is source of truth)', finalState.ledger.length>0 && finalState.customers.length>0 && finalState.products.length>0);

} catch (err) {
  results.push({label:'FATAL ERROR', pass:false, extra:(err&&err.stack)||String(err)});
}
window.__testResults = results;
})();
