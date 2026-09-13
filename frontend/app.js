/* =====================================================================
   DATA MODEL
   ---------------------------------------------------------------------
   This is an in-memory prototype, but it is structured so that:
   - Nothing is ever manually overwritten as "the balance"
   - Stock, customer balances and vendor payables are always CALCULATED
     from the transaction ledger (products/customers/vendors only hold
     opening figures — everything after that is a ledger entry).
   - Every product has a SKU + explicit category/season, never identified
     by name alone.
   This mirrors the entity list needed for a real backend: Products,
   Categories/Seasons, Inventory (derived), Cities, Customers, Vendors,
   Ledger (Sales/Purchases/Payments/Transfers all typed rows).
===================================================================== */

let uid = 2000;
const nextId = () => ++uid;
const todayISO = () => new Date().toISOString().slice(0,10);
const todayStr = () => new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
const fmt = n => 'Rs ' + Math.round(Number(n)||0).toLocaleString('en-IN');
const CATS = ['Men','Women','Kids'];
const SEASONS = ['Summer','Winter'];

function skuFor(cat, season, seq){
  return `${cat.slice(0,3).toUpperCase()}-${season.slice(0,3).toUpperCase()}-${String(seq).padStart(3,'0')}`;
}

/* ---- PRODUCTS (master catalog, one list — stock is per-shop, derived) ---- */
let products = [];
let productSeq = 0;

/* ---- CITIES & WHOLESALE CUSTOMERS ---- */
let cities = [];
let customers = [];

/* ---- VENDORS ---- */
let vendors = [];

/* ---- LEDGER: single source of truth for stock + balances ----
   type: wholesale_sale | wholesale_recovery | retail_sale | retail_payment
       | vendor_purchase | vendor_payment | stock_transfer | adjustment
   items: [{productId, qty, price}]  (price = per-unit at the price used for that txn type)
*/
let ledger = [];
let dataDirty = false;
let apiReady = false;
let syncTimer = null;
const API_BASE = (window.CHGL_CONFIG && window.CHGL_CONFIG.API_BASE) || 'http://localhost:4000/api';
const AUTH_TOKEN_KEY = 'chgAuthToken';
let authToken = localStorage.getItem(AUTH_TOKEN_KEY) || '';
let currentUser = null;

function setAuth(token, user){
  authToken = token || '';
  currentUser = user || null;
  if(authToken) localStorage.setItem(AUTH_TOKEN_KEY, authToken);
  else localStorage.removeItem(AUTH_TOKEN_KEY);
  const sessionUser = document.getElementById('sessionUser');
  if(sessionUser) sessionUser.textContent = currentUser ? `Signed in as ${currentUser.username}` : 'Signed in';
  const mobileSessionUser = document.getElementById('mobileSessionUser');
  if(mobileSessionUser) mobileSessionUser.textContent = currentUser ? currentUser.username : 'Signed in';
}
function showApp(){
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('appShell').classList.remove('locked');
}
function showLogin(message){
  document.getElementById('authScreen').classList.remove('hidden');
  document.getElementById('appShell').classList.add('locked');
  const err = document.getElementById('loginError');
  err.textContent = message || '';
  err.hidden = !message;
}
async function authFetch(url, options = {}){
  const headers = { ...(options.headers || {}) };
  if(authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(url, { ...options, headers });
  if(res.status === 401){
    setAuth('', null);
    apiReady = false;
    showLogin('Session expired. Please sign in again.');
  }
  return res;
}
async function submitLogin(event){
  event.preventDefault();
  const err = document.getElementById('loginError');
  err.hidden = true;
  const submit = event.target.querySelector('button[type="submit"]');
  submit.disabled = true;
  try{
    const res = await fetch(`${API_BASE}/auth/login`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        username: document.getElementById('loginUsername').value,
        password: document.getElementById('loginPassword').value
      })
    });
    const body = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(body.error || 'Login failed');
    setAuth(body.token, body.user);
    showApp();
    await loadState();
  }catch(error){
    err.textContent = error.message;
    err.hidden = false;
  }finally{
    submit.disabled = false;
  }
}
async function initAuth(){
  document.getElementById('loginForm').addEventListener('submit', submitLogin);
  if(!authToken){ showLogin(); return; }
  try{
    const res = await authFetch(`${API_BASE}/auth/me`);
    if(!res.ok) throw new Error('Please sign in again.');
    const body = await res.json();
    setAuth(authToken, body.user);
    showApp();
    await loadState();
  }catch(error){
    setAuth('', null);
    showLogin(error.message);
  }
}
function logout(){
  setAuth('', null);
  apiReady = false;
  showLogin('Signed out.');
}
function showResetPassword(){
  openModal(`
    <h3>Reset Password</h3><div class="sub">Use the reset token configured on the server.</div>
    <div class="field"><label>Username</label><input id="resetUser" autocomplete="username" value="${document.getElementById('loginUsername').value || 'admin'}"></div>
    <div class="field"><label>Reset token</label><input id="resetToken" type="password" autocomplete="one-time-code"></div>
    <div class="field"><label>New password</label><input id="resetNewPassword" type="password" autocomplete="new-password"></div>
    <button class="btn amber" style="width:100%;" onclick="resetPassword()">Reset and sign in</button>
  `);
}
async function resetPassword(){
  try{
    const res = await fetch(`${API_BASE}/auth/reset-password`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        username: document.getElementById('resetUser').value,
        resetToken: document.getElementById('resetToken').value,
        newPassword: document.getElementById('resetNewPassword').value
      })
    });
    const body = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(body.error || 'Reset failed');
    setAuth(body.token, body.user);
    closeModal();
    showApp();
    await loadState();
  }catch(error){ toast(error.message, true); }
}
function openChangePassword(){
  openModal(`
    <h3>Change Password</h3><div class="sub">Your next sign-in will use the new password.</div>
    <div class="field"><label>Current password</label><input id="changeCurrentPassword" type="password" autocomplete="current-password"></div>
    <div class="field"><label>New password</label><input id="changeNewPassword" type="password" autocomplete="new-password"></div>
    <button class="btn amber" style="width:100%;" onclick="changePassword()">Update password</button>
  `);
}
async function changePassword(){
  try{
    const res = await authFetch(`${API_BASE}/auth/change-password`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        currentPassword: document.getElementById('changeCurrentPassword').value,
        newPassword: document.getElementById('changeNewPassword').value
      })
    });
    const body = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(body.error || 'Password update failed');
    setAuth(body.token, body.user);
    closeModal();
    toast('Password updated');
  }catch(error){ toast(error.message, true); }
}

function markDirty(){
  dataDirty = true;
}
function pushLedger(entry){
  entry.id = nextId();
  if(!entry.date) entry.date = todayISO();
  ledger.push(entry);
  markDirty();
  return entry;
}
function normalizeLoadedState(state){
  products = state.products || [];
  cities = state.cities || [];
  customers = state.customers || [];
  vendors = state.vendors || [];
  ledger = state.ledger || [];
  uid = Math.max(2000, ...ledger.map(e=>Number(e.id)||0), ...products.map(p=>Number(String(p.id).replace(/\D/g,''))||0), ...customers.map(c=>Number(String(c.id).replace(/\D/g,''))||0), ...vendors.map(v=>Number(String(v.id).replace(/\D/g,''))||0));
  productSeq = Math.max(0, ...products.map(p=>Number(String(p.sku||'').match(/(\d+)$/)?.[1])||0), products.length);
  if(!ui.activeCity || !cities.includes(ui.activeCity)) ui.activeCity = cities[0] || '';
}
async function loadState(){
  try{
    const res = await authFetch(`${API_BASE}/state`);
    if(!res.ok) throw new Error(await res.text());
    normalizeLoadedState(await res.json());
    apiReady = true;
    dataDirty = false;
    renderAll();
    toast('MongoDB data loaded');
  }catch(err){
    console.error(err);
    apiReady = false;
    toast('Could not load MongoDB data. Start the backend on port 4000.', true);
    renderAll();
  }
}
async function persistState(){
  if(!apiReady || !dataDirty) return;
  dataDirty = false;
  try{
    const res = await authFetch(`${API_BASE}/state`, {
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({products, cities, customers, vendors, ledger})
    });
    if(!res.ok) throw new Error(await res.text());
  }catch(err){
    console.error(err);
    dataDirty = true;
    toast('MongoDB save failed. Your screen still has the latest change.', true);
  }
}
function schedulePersist(){
  if(syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(persistState, 250);
}

/* =====================================================================
   DERIVED / COMPUTED FUNCTIONS — single source of truth
===================================================================== */
function productStock(pid, shop){
  // shop = 'Upper' | 'Lower'
  let stock = 0;
  ledger.forEach(e=>{
    if(e.type==='vendor_purchase' && shop==='Upper'){ (e.items||[]).forEach(it=>{ if(it.productId===pid) stock += it.qty; }); }
    if(e.type==='stock_transfer' && e.productId===pid){ stock += (shop==='Lower') ? e.qty : -e.qty; }
    if(e.type==='wholesale_sale' && shop==='Upper'){ (e.items||[]).forEach(it=>{ if(it.productId===pid) stock -= it.qty; }); }
    if(e.type==='retail_sale' && (e.shop||'Lower')===shop){ (e.items||[]).forEach(it=>{ if(it.productId===pid) stock -= it.qty; }); }
    if(e.type==='adjustment' && e.productId===pid && e.shop===shop){ stock += e.qty; }
    if(e.type==='wholesale_return' && shop==='Upper' && e.productId===pid){ stock += e.qty; }
    if(e.type==='retail_return' && e.productId===pid){
      const saleE = ledger.find(x=>x.id===e.saleId);
      if(saleE && (saleE.shop||'Lower')===shop) stock += e.qty;
    }
    if(e.type==='vendor_return' && shop==='Upper' && e.productId===pid){ stock -= e.qty; }
  });
  return stock;
}
function customerLedgerRows(cid){
  const rows = [];
  if(customers.find(c=>c.id===cid)?.opening){
    rows.push({date:'Opening', desc:'Opening Balance', debit:customers.find(c=>c.id===cid).opening, credit:0});
  }
  ledger.filter(e=>e.customerId===cid && (e.type==='wholesale_sale'||e.type==='wholesale_recovery'||e.type==='wholesale_return'||e.type==='wholesale_discount'))
    .sort((a,b)=>a.date.localeCompare(b.date)||a.id-b.id)
    .forEach(e=>{
      if(e.type==='wholesale_sale') rows.push({date:e.date, desc:`Goods supplied${e.invoiceRef?' ('+e.invoiceRef+')':''}`, debit:e.amount, credit:0, ref:e});
      else if(e.type==='wholesale_return') rows.push({date:e.date, desc:`Return — ${itemQtyLabel(e)}${e.notes?' — '+e.notes:''}`, debit:0, credit:e.amount, ref:e});
      else if(e.type==='wholesale_discount') rows.push({date:e.date, desc:`Discount given${e.notes?' — '+e.notes:''}`, debit:0, credit:e.amount, ref:e});
      else rows.push({date:e.date, desc:`Recovery${e.method?' — '+e.method:''}${e.notes?' — '+e.notes:''}`, debit:0, credit:e.amount, ref:e});
    });
  let bal = 0;
  rows.forEach(r=>{ bal += r.debit - r.credit; r.balance = bal; });
  return rows;
}
function customerBalance(cid){
  const c = customers.find(x=>x.id===cid); if(!c) return 0;
  const rows = customerLedgerRows(cid);
  return rows.length ? rows[rows.length-1].balance : c.opening;
}
function vendorLedgerRows(vid){
  const rows = [];
  const v = vendors.find(x=>x.id===vid);
  if(v?.opening) rows.push({date:'Opening', desc:'Opening Payable', debit:v.opening, credit:0});
  ledger.filter(e=>e.vendorId===vid && (e.type==='vendor_purchase'||e.type==='vendor_payment'||e.type==='vendor_return'))
    .sort((a,b)=>a.date.localeCompare(b.date)||a.id-b.id)
    .forEach(e=>{
      if(e.type==='vendor_purchase') rows.push({date:e.date, desc:`Purchase${e.invoiceRef?' ('+e.invoiceRef+')':''}`, debit:e.amount, credit:0, ref:e});
      else if(e.type==='vendor_return') rows.push({date:e.date, desc:`Return — ${itemQtyLabel(e)}${e.notes?' — '+e.notes:''}`, debit:0, credit:e.amount, ref:e});
      else rows.push({date:e.date, desc:`Payment${e.method?' — '+e.method:''}${e.notes?' — '+e.notes:''}`, debit:0, credit:e.amount, ref:e});
    });
  let bal=0; rows.forEach(r=>{ bal += r.debit-r.credit; r.balance=bal; });
  return rows;
}
function vendorBalance(vid){
  const rows = vendorLedgerRows(vid);
  const v = vendors.find(x=>x.id===vid);
  return rows.length ? rows[rows.length-1].balance : (v?v.opening:0);
}
function retailSaleDiscounts(saleEntry){ return ledger.filter(e=>e.type==='retail_discount' && e.saleId===saleEntry.id).reduce((s,e)=>s+e.amount,0); }
function retailSaleReturnsTotal(saleEntry){ return ledger.filter(e=>e.type==='retail_return' && e.saleId===saleEntry.id).reduce((s,e)=>s+e.amount,0); }
function retailSalePaidTotal(saleEntry){
  // ACTUAL CASH ONLY — does not include returns or discounts, so this never overstates what was really received
  const payments = ledger.filter(e=>e.type==='retail_payment' && e.saleId===saleEntry.id).reduce((s,e)=>s+e.amount,0);
  return saleEntry.paidNow + payments;
}
function retailSaleDue(saleEntry){
  return Math.max(0, saleEntry.amount - retailSalePaidTotal(saleEntry) - retailSaleReturnsTotal(saleEntry) - retailSaleDiscounts(saleEntry));
}
function retailSaleReturns(saleEntry){ return ledger.filter(e=>e.type==='retail_return' && e.saleId===saleEntry.id); }
function retailSaleNetAmount(saleEntry){ return saleEntry.amount - retailSaleDiscounts(saleEntry) - retailSaleReturnsTotal(saleEntry); }
function cityStats(city){
  const shops = customers.filter(c=>c.city===city);
  let supplied=0, recovered=0, lastRecovery=null;
  shops.forEach(s=>{
    ledger.filter(e=>e.customerId===s.id).forEach(e=>{
      if(e.type==='wholesale_sale') supplied += e.amount;
      if(e.type==='wholesale_recovery'){ recovered += e.amount; if(!lastRecovery || e.date>lastRecovery) lastRecovery=e.date; }
    });
  });
  const outstanding = shops.reduce((s,c)=>s+customerBalance(c.id),0);
  return {shopCount:shops.length, supplied, recovered, outstanding, lastRecovery};
}
function productName(pid){ const p=products.find(x=>x.id===pid); return p?p.name:'(removed product)'; }
function itemQtyLabel(it){ return `${productName(it.productId)} x${it.qty}${it.packQty?' ('+it.packQty+' box'+(it.packQty>1?'es':'')+')':''}`; }
function productSku(pid){ const p=products.find(x=>x.id===pid); return p?p.sku:'—'; }

/* =====================================================================
   STATE (UI selection only — not business data)
===================================================================== */
let ui = { activeCity: cities[0], invShop:'Upper', invCat:'Men', invSeason:'Summer',
  hist:{ section:'Upper', type:'', city:'', customer:'', vendor:'', product:'', from:'', to:'', search:'' } };

/* =====================================================================
   NAV / MODAL / TOAST
===================================================================== */
function goTo(sec){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.getElementById('sec-'+sec).classList.add('active');
  document.querySelectorAll('.nav-item, .tab-item').forEach(b=>b.classList.toggle('active', b.dataset.nav===sec));
  renderAll();
}
document.querySelectorAll('[data-nav]').forEach(b=>b.addEventListener('click',()=>goTo(b.dataset.nav)));
function toast(msg, isErr){ const t=document.getElementById('toast'); t.textContent=msg; t.className='toast show'+(isErr?' err':''); setTimeout(()=>t.className='toast',2400); }
function openModal(html, wide){ document.getElementById('modalBody').className = 'modal'+(wide?' wide':''); document.getElementById('modalBody').innerHTML = html; document.getElementById('modalOverlay').classList.add('open'); }
function closeModal(){ document.getElementById('modalOverlay').classList.remove('open'); }
document.getElementById('modalOverlay').addEventListener('click',e=>{ if(e.target.id==='modalOverlay') closeModal(); });

/* =====================================================================
   DASHBOARD
===================================================================== */
function dashboardDateKey(daysAgo){
  const date = new Date();
  date.setHours(12,0,0,0);
  date.setDate(date.getDate()-daysAgo);
  return date.toISOString().slice(0,10);
}
function dashboardDateLabel(dateKey){
  return new Date(`${dateKey}T12:00:00`).toLocaleDateString('en-GB',{weekday:'short'}).slice(0,3);
}
function dashboardTrendChart(){
  const days = Array.from({length:7},(_,index)=>{
    const date = dashboardDateKey(6-index);
    const sales = ledger.filter(e=>(e.type==='retail_sale'||e.type==='wholesale_sale')&&e.date===date).reduce((sum,e)=>sum+(e.type==='retail_sale'?retailSaleNetAmount(e):e.amount),0);
    const recovery = ledger.filter(e=>e.type==='wholesale_recovery'&&e.date===date).reduce((sum,e)=>sum+e.amount,0);
    const purchase = ledger.filter(e=>e.type==='vendor_purchase'&&e.date===date).reduce((sum,e)=>sum+e.amount,0);
    return {label:dashboardDateLabel(date), sales, recovery, purchase};
  });
  const max = Math.max(...days.flatMap(day=>[day.sales,day.recovery,day.purchase]),1);
  const width = 680, height = 220, left = 42, right = 12, top = 18, bottom = 32;
  const plotWidth = width-left-right, plotHeight = height-top-bottom, groupWidth = plotWidth/days.length;
  const y = value => top+plotHeight-(value/max)*plotHeight;
  const bars = days.map((day,index)=>{
    const x = left+index*groupWidth+groupWidth*.18;
    const barWidth = Math.max(7,groupWidth*.18);
    return `<g class="chart-group"><rect x="${x}" y="${y(day.sales)}" width="${barWidth}" height="${Math.max(0,top+plotHeight-y(day.sales))}" rx="3" class="bar-sales"><title>${day.label}: ${fmt(day.sales)} sales</title></rect><rect x="${x+barWidth+3}" y="${y(day.recovery)}" width="${barWidth}" height="${Math.max(0,top+plotHeight-y(day.recovery))}" rx="3" class="bar-recovery"><title>${day.label}: ${fmt(day.recovery)} recoveries</title></rect><rect x="${x+(barWidth+3)*2}" y="${y(day.purchase)}" width="${barWidth}" height="${Math.max(0,top+plotHeight-y(day.purchase))}" rx="3" class="bar-purchase"><title>${day.label}: ${fmt(day.purchase)} purchases</title></rect><text x="${left+index*groupWidth+groupWidth/2}" y="${height-9}" text-anchor="middle">${day.label}</text></g>`;
  }).join('');
  const grid = [0,.5,1].map(step=>`<line x1="${left}" y1="${y(max*step)}" x2="${width-right}" y2="${y(max*step)}" class="chart-grid"/><text x="${left-8}" y="${y(max*step)+4}" text-anchor="end">${step===0?'0':fmt(max*step).replace('Rs ','')}</text>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Seven day business activity chart">${grid}<line x1="${left}" y1="${top+plotHeight}" x2="${width-right}" y2="${top+plotHeight}" class="chart-axis"/>${bars}</svg>`;
}
function dashboardStockHealth(){
  let healthy=0, low=0, out=0;
  products.forEach(product=>['Upper','Lower'].forEach(shop=>{
    const stock = productStock(product.id,shop);
    if(stock<=0) out++; else if(stock<product.minStock) low++; else healthy++;
  }));
  const total = healthy+low+out;
  if(!total) return '<div class="health-empty">No product data yet</div>';
  const healthyPct = Math.round(healthy/total*100);
  const lowPct = Math.round(low/total*100);
  const outPct = 100-healthyPct-lowPct;
  return `<div class="health-visual"><div class="health-ring" style="--healthy:${healthyPct}%;--low:${lowPct}%"><div><strong>${healthyPct}%</strong><span>healthy</span></div></div><div class="health-list"><div><i class="health-swatch healthy"></i><span>Healthy</span><strong>${healthy}</strong></div><div><i class="health-swatch low"></i><span>Low stock</span><strong>${low}</strong></div><div><i class="health-swatch out"></i><span>Out of stock</span><strong>${out}</strong></div></div></div><div class="health-summary">${outPct>0?`${out} product${out===1?'':'s'} need restocking now.`:'All products have stock available.'}</div>`;
}
function dashboardCityChart(){
  const cityData = cities.map(city=>({city, amount:cityStats(city).outstanding})).sort((a,b)=>b.amount-a.amount).slice(0,5);
  const max = Math.max(...cityData.map(item=>item.amount),1);
  return cityData.length ? cityData.map((item,index)=>`<div class="city-bar-row clickable" onclick="jumpToCity('${item.city.replace(/'/g,"\\'")}')"><div class="city-bar-label"><span>${index+1}</span><strong>${item.city}</strong><b>${fmt(item.amount)}</b></div><div class="city-bar-track"><div class="city-bar-fill" style="width:${Math.max(item.amount?4:0,item.amount/max*100)}%"></div></div></div>`).join('') : '<div class="empty">No city balances yet</div>';
}
function renderDashboard(){
  document.getElementById('todayDate').textContent = todayStr();
  const today = todayISO();

  const retailToday = ledger.filter(e=>e.type==='retail_sale' && e.date===today);
  document.getElementById('stRetailCount').textContent = retailToday.length;
  document.getElementById('stRetailRev').textContent = fmt(retailToday.reduce((s,e)=>s+retailSaleNetAmount(e),0));

  const wholesaleToday = ledger.filter(e=>e.type==='wholesale_sale' && e.date===today);
  const wholesaleDiscountToday = ledger.filter(e=>e.type==='wholesale_discount' && e.date===today).reduce((s,e)=>s+e.amount,0);
  document.getElementById('stWholesaleToday').textContent = fmt(wholesaleToday.reduce((s,e)=>s+e.amount,0) - wholesaleDiscountToday);

  const wholesaleOut = customers.reduce((s,c)=>s+customerBalance(c.id),0);
  document.getElementById('stWholesaleOut').textContent = fmt(wholesaleOut);

  const vendorPayable = vendors.reduce((s,v)=>s+vendorBalance(v.id),0);
  document.getElementById('stVendorPayable').textContent = fmt(vendorPayable);

  let invValue=0, lowCount=0, outCount=0, lowList=[];
  products.forEach(p=>{
    ['Upper','Lower'].forEach(shop=>{
      const st = productStock(p.id, shop);
      invValue += st * p.retail;
      if(st<=0) outCount++;
      else if(st < p.minStock) { lowCount++; lowList.push({p, shop, st}); }
      if(st < p.minStock && st>0) {} // already pushed above
    });
  });
  document.getElementById('stInvValue').textContent = fmt(invValue);
  document.getElementById('stLowStock').textContent = `${lowCount} / ${outCount}`;
  document.getElementById('stCitiesShops').textContent = `${cities.length} / ${customers.length}`;

  const recToday = ledger.filter(e=>e.type==='wholesale_recovery' && e.date===today).length;
  const purToday = ledger.filter(e=>e.type==='vendor_purchase' && e.date===today).length;
  const xferToday = ledger.filter(e=>e.type==='stock_transfer' && e.date===today).length;
  document.getElementById('stTodayRecoveries').textContent = recToday;
  document.getElementById('stTodayPurchases').textContent = purToday;
  document.getElementById('stTodayTransfers').textContent = xferToday;
  document.getElementById('dashTrendChart').innerHTML = dashboardTrendChart();
  document.getElementById('dashStockHealth').innerHTML = dashboardStockHealth();
  document.getElementById('dashCityChart').innerHTML = dashboardCityChart();

  document.getElementById('dashCityList').innerHTML = cities.map(c=>{
    const s = cityStats(c);
    return `<div class="ledger-row clickable" onclick="jumpToCity('${c.replace(/'/g,"\\'")}')"><div class="lr-main"><div class="title">${c}</div><div class="meta">${s.shopCount} shop${s.shopCount!==1?'s':''} · supplied ${fmt(s.supplied)}</div></div><div class="lr-right"><div class="amt">${fmt(s.outstanding)}</div><div class="note">outstanding</div></div></div>`;
  }).join('') || `<div class="empty">No cities yet</div>`;

  const topCust = customers.map(c=>({c, bal:customerBalance(c.id)})).sort((a,b)=>b.bal-a.bal).slice(0,5);
  document.getElementById('dashTopCustomers').innerHTML = topCust.filter(x=>x.bal>0).map(x=>
    `<div class="ledger-row clickable" onclick="openShopDetail('${x.c.id}')"><div class="lr-main"><div class="title">${x.c.shop}</div><div class="meta">${x.c.city} · ${x.c.owner}</div></div><div class="lr-right"><span class="badge due">${fmt(x.bal)}</span></div></div>`
  ).join('') || `<div class="empty">No outstanding balances</div>`;

  const recentRetail = ledger.filter(e=>e.type==='retail_sale').slice(-4).reverse();
  document.getElementById('dashRecentRetail').innerHTML = recentRetail.map(e=>{
    const due = retailSaleDue(e);
    const disc = retailSaleDiscounts(e);
    const note = due>0 ? 'Rs '+fmt(due).replace('Rs ','')+' due' : (disc>0 ? `Paid in full (incl. Rs ${disc} discount)` : 'Paid in full');
    return `<div class="ledger-row clickable" onclick="openRetailSaleDetail(${e.id})"><div class="lr-main"><div class="title">${e.customerName}</div><div class="meta">${e.items.map(it=>productName(it.productId)+' x'+it.qty).join(', ')} · ${e.time||''}</div></div><div class="lr-right"><div class="amt">${fmt(e.amount)}</div><div class="note">${note}</div></div></div>`;
  }).join('') || `<div class="empty">No retail sales yet</div>`;

  document.getElementById('dashLowStock').innerHTML = lowList.slice(0,6).map(x=>
    `<div class="ledger-row clickable" onclick="jumpToInventory('${x.shop}','${x.p.category}','${x.p.season}')"><div class="lr-main"><div class="title">${x.p.name}</div><div class="meta">${x.shop} shop · ${x.p.category}/${x.p.season} · SKU ${x.p.sku}</div></div><div class="lr-right"><span class="badge low">${x.st<=0?'OUT':x.st+' left'}</span></div></div>`
  ).join('') || `<div class="empty">All stock healthy</div>`;

  const recentXfer = ledger.filter(e=>e.type==='stock_transfer').slice(-5).reverse();
  document.getElementById('dashTransfers').innerHTML = recentXfer.map(e=>
    `<div class="ledger-row clickable" onclick="goTo('inventory')"><div class="lr-main"><div class="title">${productName(e.productId)}</div><div class="meta">${e.date}</div></div><div class="lr-right"><span class="badge xfer">Upper → Lower · ${e.qty}${e.packQty?' ('+e.packQty+' box'+(e.packQty>1?'es':'')+')':''}</span></div></div>`
  ).join('') || `<div class="empty">No transfers yet</div>`;

  const topVend = vendors.map(v=>({v, bal:vendorBalance(v.id)})).sort((a,b)=>b.bal-a.bal).filter(x=>x.bal>0);
  document.getElementById('dashTopVendors').innerHTML = topVend.map(x=>
    `<div class="ledger-row clickable" onclick="openVendorDetail('${x.v.id}')"><div class="lr-main"><div class="title">${x.v.name}</div><div class="meta">${x.v.contact}</div></div><div class="lr-right"><span class="badge due">${fmt(x.bal)}</span></div></div>`
  ).join('') || `<div class="empty">No vendor dues</div>`;
}
function jumpToCity(c){ ui.activeCity = c; goTo('upper'); }
function jumpToInventory(shop, cat, season){ ui.invShop = shop; ui.invCat = cat; ui.invSeason = season; goTo('inventory'); }

/* =====================================================================
   UPPER SHOP (WHOLESALE)
===================================================================== */
function renderUpper(){
  document.getElementById('cityTabs').innerHTML = cities.map(c=>
    `<button class="chip ${c===ui.activeCity?'active':''}" onclick="setCity('${c}')">${c}</button>`).join('');

  const s = cityStats(ui.activeCity);
  document.getElementById('cityStatGrid').innerHTML = `
    <div class="stat"><div class="label">Shops in ${ui.activeCity}</div><div class="val numeral">${s.shopCount}</div></div>
    <div class="stat amber"><div class="label">Total Goods Supplied</div><div class="val numeral">${fmt(s.supplied)}</div></div>
    <div class="stat green"><div class="label">Total Recovered</div><div class="val numeral">${fmt(s.recovered)}</div></div>
    <div class="stat brick"><div class="label">Total Outstanding</div><div class="val numeral">${fmt(s.outstanding)}</div></div>`;

  const shops = customers.filter(c=>c.city===ui.activeCity);
  document.getElementById('cityPanelTitle').firstChild.textContent = `${ui.activeCity} — Shops `;
  document.getElementById('cityShopCount').textContent = `(${shops.length})`;
  document.getElementById('shopList').innerHTML = shops.map(sh=>{
    const bal = customerBalance(sh.id);
    const rows = customerLedgerRows(sh.id);
    const supplied = rows.filter(r=>r.debit).reduce((s,r)=>s+r.debit,0);
    const recovered = rows.filter(r=>r.credit).reduce((s,r)=>s+r.credit,0);
    const last = rows.filter(r=>r.ref).slice(-1)[0];
    const overLimit = sh.creditLimit>0 && bal>sh.creditLimit;
    return `<tr class="clickable" onclick="openShopDetail('${sh.id}')">
      <td><strong>${sh.shop}</strong>${last?`<div style="font-size:11px;color:var(--muted);">Last: ${last.desc} on ${last.date}</div>`:''}</td>
      <td style="font-size:12.5px;color:var(--muted);">${sh.owner}<br>${sh.phone}</td>
      <td class="numeral">${sh.creditLimit>0?fmt(sh.creditLimit):'—'}</td>
      <td class="numeral">${fmt(supplied)}</td>
      <td class="numeral">${fmt(recovered)}</td>
      <td>${overLimit?`<span class="badge low">Over Limit<br>${fmt(bal)}</span>`:bal>0?`<span class="badge due">Due ${fmt(bal)}</span>`:`<span class="badge clear">Clear ✓</span>`}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="6" class="empty">No shops added in ${ui.activeCity} yet</td></tr>`;

  const today = todayISO();
  const upperToday = ledger.filter(e=>e.type==='retail_sale' && e.shop==='Upper' && e.date===today);
  document.getElementById('upperTodayCount').textContent = `(${upperToday.length})`;
  document.getElementById('upperTodaySales').innerHTML = upperToday.slice().reverse().map(e=>{
    const due = retailSaleDue(e);
    const disc = retailSaleDiscounts(e);
    let statusBadge = due>0 ? `<span class="badge due">Due ${fmt(due)}</span>` : `<span class="badge clear">Paid</span>`;
    if(disc>0) statusBadge += ` <span class="badge xfer">Discount ${fmt(disc)}</span>`;
    return `<div class="ledger-row clickable" onclick="openRetailSaleDetail(${e.id})">
      <div class="lr-main"><div class="title">${e.customerName}</div><div class="meta">${e.items.map(it=>productName(it.productId)+' x'+it.qty).join(', ')} · ${e.time||''}</div></div>
      <div class="lr-right"><div class="amt">${fmt(e.amount)}</div><div class="note">${statusBadge}</div></div>
    </div>`;
  }).join('') || `<div class="empty">No counter sales at Upper Shop today</div>`;
}
function setCity(c){ ui.activeCity=c; renderUpper(); }

function openAddCity(){
  openModal(`<h3>Add City</h3><div class="sub">Create a new wholesale coverage area</div>
    <div class="field"><label>City Name</label><input id="newCityName" placeholder="e.g. Sialkot"></div>
    <button class="btn amber" style="width:100%;" onclick="saveNewCity()">Save City</button>`);
}
function saveNewCity(){
  const name = document.getElementById('newCityName').value.trim();
  if(!name){ toast('Enter a city name', true); return; }
  if(cities.includes(name)){ toast('City already exists', true); return; }
  cities.push(name); ui.activeCity = name; markDirty();
  toast('City added'); closeModal(); renderAll();
}
function openEditCity(){
  openModal(`<h3>Edit City Name</h3><div class="sub">Renames the city everywhere it's used — shops keep their full history</div>
    <div class="field"><label>City to Rename</label><select id="editCityOld">${cities.map(c=>`<option ${c===ui.activeCity?'selected':''}>${c}</option>`).join('')}</select></div>
    <div class="field"><label>New Name</label><input id="editCityNew" placeholder="e.g. Sialkot"></div>
    <div id="editCityErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;" onclick="saveEditCity()">Save</button>`);
}
function saveEditCity(){
  const oldName = document.getElementById('editCityOld').value;
  const newName = document.getElementById('editCityNew').value.trim();
  if(!newName){ showErr('editCityErr','Enter a new city name'); return; }
  if(newName!==oldName && cities.includes(newName)){ showErr('editCityErr','A city with that name already exists'); return; }
  const idx = cities.indexOf(oldName);
  cities[idx] = newName;
  customers.forEach(c=>{ if(c.city===oldName) c.city = newName; });
  if(ui.activeCity===oldName) ui.activeCity = newName;
  markDirty();
  toast('City renamed'); closeModal(); renderAll();
}

function openAddShop(){
  openModal(`<h3>Add Wholesale Shop</h3><div class="sub">New customer shop for a city</div>
    <div class="field"><label>City</label><select id="newShopCity">${cities.map(c=>`<option ${c===ui.activeCity?'selected':''}>${c}</option>`).join('')}</select></div>
    <div class="field"><label>Shop Name</label><input id="newShopName" placeholder="e.g. Malik Traders"></div>
    <div class="field"><label>Shopkeeper / Owner Name</label><input id="newShopOwner" placeholder="e.g. Zafar Malik"></div>
    <div class="field-row">
      <div class="field"><label>Phone</label><input id="newShopPhone" placeholder="03XX-XXXXXXX"></div>
      <div class="field"><label>Opening Balance (Rs)</label><input type="number" id="newShopOpening" placeholder="0"></div>
    </div>
    <div class="field"><label>Credit Limit (Rs, optional — 0 for no limit)</label><input type="number" id="newShopLimit" placeholder="e.g. 50000"></div>
    <div class="field"><label>Address (optional)</label><input id="newShopAddress" placeholder="e.g. Hall Road"></div>
    <button class="btn amber" style="width:100%;" onclick="saveNewShop()">Save Shop</button>`);
}
function saveNewShop(){
  const city = document.getElementById('newShopCity').value;
  const shop = document.getElementById('newShopName').value.trim();
  const owner = document.getElementById('newShopOwner').value.trim();
  const phone = document.getElementById('newShopPhone').value.trim();
  const opening = Number(document.getElementById('newShopOpening').value);
  const creditLimit = Number(document.getElementById('newShopLimit').value);
  const address = document.getElementById('newShopAddress').value.trim();
  if(!shop || !owner){ toast('Enter shop and owner name', true); return; }
  if(!(opening>=0)){ toast('Opening Balance cannot be negative', true); return; }
  if(!(creditLimit>=0)){ toast('Credit Limit cannot be negative', true); return; }
  customers.push({id:'C'+nextId(), city, shop, owner, phone, address, opening, creditLimit});
  ui.activeCity = city;
  markDirty();
  toast('Shop added'); closeModal(); renderAll();
}

function openShopDetail(cid){
  const sh = customers.find(x=>x.id===cid); if(!sh) return;
  const rows = customerLedgerRows(cid);
  const bal = customerBalance(cid);
  const ledgerHtml = rows.length ? `<div class="tbl-wrap"><table class="ledger-table"><thead><tr><th>Date</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td>${r.date}</td><td>${r.desc}${r.ref&&r.ref.type==='wholesale_sale'?` <button class="btn sm ghost" style="padding:2px 8px;font-size:11px;" onclick="openWholesaleSaleItems(${r.ref.id})">🔍 View Items</button>`:''}</td><td class="debit numeral">${r.debit?fmt(r.debit):''}</td><td class="credit numeral">${r.credit?fmt(r.credit):''}</td><td class="bal numeral">${fmt(r.balance)}</td></tr>`).join('')}
    </tbody></table></div>` : `<div class="empty">No transactions yet</div>`;

  openModal(`
    <h3>${sh.shop} <button class="btn sm ghost" style="margin-left:6px;" onclick="openEditShopLimit('${cid}')">✎ Edit Shop</button></h3><div class="sub">${sh.owner} · ${sh.city} · ${sh.phone}</div>
    <div class="grid grid-2" style="margin-bottom:14px;">
      <div class="stat"><div class="label">Total Supplied</div><div class="val numeral">${fmt(rows.filter(r=>r.debit).reduce((s,r)=>s+r.debit,0))}</div></div>
      <div class="stat ${bal>0?'brick':'green'}"><div class="label">Current Balance</div><div class="val numeral">${fmt(bal)}</div></div>
    </div>
    <div class="stat ${sh.creditLimit>0 && bal>sh.creditLimit?'brick':''}" style="margin-bottom:14px;">
      <div class="label">Credit Limit</div>
      <div class="val numeral" style="font-size:16px;">${sh.creditLimit>0?fmt(sh.creditLimit)+(bal>sh.creditLimit?' — OVER LIMIT':''):'No limit set'}</div>
    </div>
    <div class="btnrow" style="margin-bottom:10px;display:flex;gap:8px;">
      <button class="btn amber sm" style="flex:1;" onclick="openWholesaleSale('${cid}')">+ New Wholesale Sale</button>
      <button class="btn ghost sm" style="flex:1;" onclick="openRecovery('${cid}')">+ Record Recovery</button>
    </div>
    <div class="btnrow" style="margin-bottom:16px;display:flex;gap:8px;">
      <button class="btn ghost sm" style="flex:1;" onclick="openWholesaleReturn('${cid}')">↩ Record Return</button>
      <button class="btn ghost sm" style="flex:1;" onclick="openWholesaleDiscount('${cid}')">🏷 Give Discount</button>
      <button class="btn ghost sm" style="flex:1;" onclick="printReceipt('wholesale','${cid}')">🖨 Print</button>
      <button class="btn ghost sm" style="flex:1;" onclick="exportShopData('${cid}')">⬇ Excel</button>
    </div>
    <h2 style="font-size:14px;margin-bottom:8px;">Ledger (Date · Description · Debit · Credit · Balance)</h2>
    ${ledgerHtml}
    <button class="btn ghost" style="width:100%;margin-top:16px;" onclick="closeModal()">Close</button>
  `, true);
}
function openEditShopLimit(cid){
  const sh = customers.find(x=>x.id===cid);
  openModal(`
    <h3>Edit Shop Details</h3><div class="sub">${sh.shop} · SKU-like ID: ${sh.id}</div>
    <div class="field"><label>Shop Name</label><input id="editShopName" value="${sh.shop}"></div>
    <div class="field"><label>Shopkeeper / Owner Name</label><input id="editShopOwner" value="${sh.owner}"></div>
    <div class="field-row">
      <div class="field"><label>Phone</label><input id="editShopPhone" value="${sh.phone||''}"></div>
      <div class="field"><label>Credit Limit (Rs, 0 = no limit)</label><input type="number" id="editLimitVal" value="${sh.creditLimit||0}"></div>
    </div>
    <div class="field"><label>Address (optional)</label><input id="editShopAddress" value="${sh.address||''}"></div>
    <div id="editShopErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;" onclick="saveEditShopLimit('${cid}')">Save</button>
  `);
}
function saveEditShopLimit(cid){
  const sh = customers.find(x=>x.id===cid);
  const shop = document.getElementById('editShopName').value.trim();
  const owner = document.getElementById('editShopOwner').value.trim();
  if(!shop || !owner){ showErr('editShopErr','Enter shop and owner name'); return; }
  sh.shop = shop;
  sh.owner = owner;
  sh.phone = document.getElementById('editShopPhone').value.trim();
  sh.address = document.getElementById('editShopAddress').value.trim();
  sh.creditLimit = Math.max(0, Number(document.getElementById('editLimitVal').value)||0);
  markDirty();
  toast('Shop details updated'); closeModal(); openShopDetail(cid);
}
// Backward-compatible line identifier: uses the real lineId if present,
// otherwise falls back to a stable id derived from the parent transaction + product
// (matches pre-lineId behavior for older/seed data so nothing breaks).
function effLineId(parentId, item){ return item.lineId || `${parentId}-${item.productId}`; }

let _wrItems = [];
function openWholesaleReturn(cid){
  _wrItems = ledger.filter(e=>e.type==='wholesale_sale' && e.customerId===cid).flatMap(e=>e.items.map(it=>({...it, saleId:e.id, saleRef:e.invoiceRef||e.id, effLineId:effLineId(e.id,it)})));
  // subtract quantities already returned against this EXACT original line (not just same product/sale)
  _wrItems = _wrItems.map(it=>{
    const alreadyReturned = ledger.filter(r=>r.type==='wholesale_return' && r.customerId===cid && r.lineId===it.effLineId).reduce((s,r)=>s+r.qty,0);
    return {...it, eligibleQty: it.qty - alreadyReturned};
  }).filter(it=>it.eligibleQty > 0);
  if(!_wrItems.length){ toast('No returnable items — everything sold has already been fully returned', true); return; }
  openModal(`
    <h3>Record Wholesale Return</h3><div class="sub">Increases Upper Shop stock and credits the customer</div>
    <div class="field"><label>Product Returned</label><select id="wrProduct" onchange="wrProductChanged()">${_wrItems.map((it,i)=>`<option value="${i}" data-pack="${(products.find(p=>p.id===it.productId)||{}).packSize||1}">${productName(it.productId)} — from sale ${it.saleRef} (eligible: ${it.eligibleQty} of ${it.qty})</option>`).join('')}</select></div>
    <div class="field-row">
      <div class="field"><label>Boxes (optional)</label><input type="number" id="wrBoxes" min="0" placeholder="e.g. 2" oninput="wrBoxesChanged()"></div>
      <div class="field"><label>Quantity Returned (pieces)</label><input type="number" id="wrQty" placeholder="e.g. 5"></div>
    </div>
    <div class="field"><label>Notes (optional)</label><input id="wrNotes" placeholder="e.g. damaged pieces"></div>
    <div id="wrErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;" onclick="saveWholesaleReturn('${cid}')">Save Return</button>
  `);
}
function wrProductChanged(){ document.getElementById('wrBoxes').value=''; }
function wrBoxesChanged(){
  const sel = document.getElementById('wrProduct');
  const pack = Number(sel.selectedOptions[0].dataset.pack)||1;
  const boxes = Number(document.getElementById('wrBoxes').value)||0;
  if(boxes>0) document.getElementById('wrQty').value = boxes*pack;
}
function saveWholesaleReturn(cid){
  const idx = Number(document.getElementById('wrProduct').value);
  const it = _wrItems[idx];
  const qty = Number(document.getElementById('wrQty').value);
  const boxesRaw = document.getElementById('wrBoxes').value;
  const boxes = Number(boxesRaw);
  if(!isPositiveInt(qty)){ showErr('wrErr','Quantity must be a whole number greater than 0'); return; }
  if(boxesRaw!=='' && !isPositiveInt(boxes)){ showErr('wrErr','Boxes must be a whole number greater than 0'); return; }
  if(qty > it.eligibleQty){ showErr('wrErr',`Cannot return more than eligible (${it.eligibleQty} remaining from this sale)`); return; }
  const notes = document.getElementById('wrNotes').value.trim();
  const amount = qty * it.price;
  pushLedger({type:'wholesale_return', customerId:cid, productId:it.productId, saleId:it.saleId, lineId:it.effLineId, qty, packQty:boxes>0?boxes:undefined, amount, notes:notes||undefined});
  toast('Return recorded — Upper stock increased, customer credited');
  closeModal(); renderAll();
}

/* ---- New wholesale sale (product-linked, deducts Upper stock) ---- */
function boxesDisplay(qty, product){
  // if we don't know an explicit box count, work it out from the product's pack size
  if(!product || !(product.packSize>1)) return '—';
  const full = Math.floor(qty/product.packSize);
  const rem = qty % product.packSize;
  return rem===0 ? String(full) : `${full} +${rem}pc`;
}
function openWholesaleSaleItems(saleId){
  const e = ledger.find(x=>x.id===saleId && x.type==='wholesale_sale'); if(!e) return;
  const c = customers.find(x=>x.id===e.customerId);
  openModal(`
    <h3>Items Supplied</h3><div class="sub">${c?c.shop:''} · ${e.date}${e.invoiceRef?' · '+e.invoiceRef:''}</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Product</th><th>SKU</th><th>Boxes</th><th>Pieces</th><th>Price/pc</th><th>Line Total</th></tr></thead>
      <tbody>
        ${e.items.map(it=>{
          const p = products.find(x=>x.id===it.productId);
          const boxes = it.packQty!=null ? it.packQty : boxesDisplay(it.qty, p);
          return `<tr><td>${p?p.name:'—'}</td><td class="numeral" style="color:var(--muted);font-size:12px;">${p?p.sku:''}</td><td class="numeral">${boxes}</td><td class="numeral">${it.qty}</td><td class="numeral">${fmt(it.price)}</td><td class="numeral">${fmt(it.price*it.qty)}</td></tr>`;
        }).join('')}
      </tbody>
    </table></div>
    <div class="totalbar"><span>Total</span><span class="numeral">${fmt(e.amount)}</span></div>
    <button class="btn ghost" style="width:100%;margin-top:14px;" onclick="closeModal()">Close</button>
  `);
}
function openWholesaleSale(cid){
  openModal(`
    <h3>New Wholesale Sale</h3><div class="sub">From Upper Shop stock — prices default to wholesale rate</div>
    <div class="field"><label>Invoice Reference (optional)</label><input id="wsRef" placeholder="e.g. WS-2050"></div>
    <div id="wsLines"></div>
    <button class="btn ghost sm" onclick="addWsLine('${cid}')" style="margin-bottom:12px;">+ Add Item</button>
    <div class="totalbar"><span>Total</span><span class="numeral" id="wsTotal">Rs 0</span></div>
    <div class="field-row" style="margin-top:12px;">
      <div class="field"><label>Amount Paid Now (Rs, optional)</label><input type="number" id="wsPaid" placeholder="0" oninput="updateWsTotals()"></div>
      <div class="field"><label>Discount (Rs, optional)</label><input type="number" id="wsDiscount" placeholder="0" oninput="updateWsTotals()"></div>
    </div>
    <div class="totalbar" style="border-top:none;padding-top:0;"><span>Balance Due</span><span class="numeral" id="wsDue">Rs 0</span></div>
    <div id="wsErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;margin-top:6px;" onclick="saveWholesaleSale('${cid}')">Save Sale</button>
  `, true);
  addWsLine(cid);
}
function addWsLine(cid){
  const wrap = document.getElementById('wsLines');
  const div = document.createElement('div'); div.className='line-row';
  const opts = products.filter(p=>p.active!==false);
  div.innerHTML = `
    <select onchange="wsLineProductChanged(this)">${opts.map(p=>`<option value="${p.id}" data-pack="${p.packSize||1}">${p.name} — ${p.sku}${p.packSize>1?' ('+p.packSize+'/box)':''} (${productStock(p.id,'Upper')} in stock)</option>`).join('')}</select>
    <input type="number" class="wsBoxes" min="0" placeholder="Boxes" oninput="wsLineBoxesChanged(this)" title="Number of boxes (optional)">
    <input type="number" class="wsQty" value="1" min="1" oninput="updateWsTotals()" title="Total pieces — auto-fills from Boxes, or enter directly">
    <div class="lineTotal numeral">Rs 0</div>
    <button class="rmBtn" onclick="this.parentElement.remove();updateWsTotals();">✕</button>`;
  wrap.appendChild(div); updateWsTotals();
}
function wsLineProductChanged(sel){
  const line = sel.closest('.line-row');
  line.querySelector('.wsBoxes').value = '';
  updateWsTotals();
}
function wsLineBoxesChanged(input){
  const line = input.closest('.line-row');
  const pack = Number(line.querySelector('select').selectedOptions[0].dataset.pack)||1;
  const boxes = Number(input.value)||0;
  if(boxes>0) line.querySelector('.wsQty').value = boxes*pack;
  updateWsTotals();
}
function updateWsTotals(){
  let total=0;
  document.querySelectorAll('#wsLines .line-row').forEach(line=>{
    const pid = line.querySelector('select').value;
    const qty = Number(line.querySelector('.wsQty').value)||0;
    const p = products.find(x=>x.id===pid);
    const lt = p ? p.wsale*qty : 0;
    line.querySelector('.lineTotal').textContent = fmt(lt);
    total += lt;
  });
  document.getElementById('wsTotal').textContent = fmt(total);
  const paid = Number(document.getElementById('wsPaid')?.value)||0;
  const discount = Number(document.getElementById('wsDiscount')?.value)||0;
  document.getElementById('wsDue').textContent = fmt(Math.max(0,total-paid-discount));
}
function saveWholesaleSale(cid){
  const lines = document.querySelectorAll('#wsLines .line-row');
  if(!lines.length){ showErr('wsErr','Add at least one item'); return; }
  let rawLines=[], hasInvalidQty=false;
  lines.forEach(line=>{
    const pid = line.querySelector('select').value;
    const qtyRaw = Number(line.querySelector('.wsQty').value);
    const boxesRaw = line.querySelector('.wsBoxes').value;
    const boxes = Number(boxesRaw);
    if(!isPositiveInt(qtyRaw)){ hasInvalidQty = true; return; }
    if(boxesRaw!=='' && !isPositiveInt(boxes)){ hasInvalidQty = true; return; }
    rawLines.push({productId:pid, qty:qtyRaw, packQty:boxes>0?boxes:undefined});
  });
  if(hasInvalidQty){ showErr('wsErr','Quantity must be a whole number greater than 0 (no zero, negative, or decimal values), and Boxes (if used) too'); return; }
  if(!rawLines.length){ showErr('wsErr','Add at least one valid item'); return; }
  // stock is validated on the TOTAL quantity requested per product, even if it's split across multiple lines
  const qtyByProduct = {};
  rawLines.forEach(r=>{ qtyByProduct[r.productId] = (qtyByProduct[r.productId]||0) + r.qty; });
  let ok = true;
  Object.entries(qtyByProduct).forEach(([pid,qty])=>{ if(productStock(pid,'Upper') < qty) ok=false; });
  if(!ok){ showErr('wsErr','Not enough stock in Upper Shop for the total quantity requested of one of the items'); return; }
  let items=[], total=0;
  rawLines.forEach(r=>{
    const p = products.find(x=>x.id===r.productId);
    items.push({productId:r.productId, qty:r.qty, price:p.wsale, packQty:r.packQty, lineId:'L'+nextId()});
    total += p.wsale*r.qty;
  });
  const paid = Number(document.getElementById('wsPaid').value)||0;
  const discount = Number(document.getElementById('wsDiscount').value)||0;
  if(paid+discount > total){ showErr('wsErr','Paid + Discount cannot exceed the sale total'); return; }
  const ref = document.getElementById('wsRef').value.trim();
  const bal = customerBalance(cid);
  const sh = customers.find(x=>x.id===cid);
  const wouldBe = bal + total - paid - discount;
  if(sh.creditLimit>0 && wouldBe>sh.creditLimit){
    if(!confirm(`This sale will take ${sh.shop}'s balance to ${fmt(wouldBe)}, which is over their credit limit of ${fmt(sh.creditLimit)}. Save anyway?`)) return;
  }
  pushLedger({type:'wholesale_sale', customerId:cid, items, amount:total, invoiceRef:ref||undefined});
  if(paid>0) pushLedger({type:'wholesale_recovery', customerId:cid, amount:paid, method:'Cash', notes:'Paid at time of sale'});
  if(discount>0) pushLedger({type:'wholesale_discount', customerId:cid, amount:discount, notes:'Given at time of sale'});
  toast('Wholesale sale recorded — Upper Shop stock updated');
  closeModal(); renderAll();
}
function openRecovery(cid){
  const bal = customerBalance(cid);
  openModal(`
    <h3>Record Recovery</h3><div class="sub">Current outstanding: ${fmt(bal)}</div>
    <div class="field-row">
      <div class="field"><label>Amount (Rs)</label><input type="number" id="recAmt" placeholder="e.g. 10000"></div>
      <div class="field"><label>Date</label><input type="date" id="recDate" value="${todayISO()}"></div>
    </div>
    <div class="field"><label>Payment Method (optional)</label><select id="recMethod"><option>Cash</option><option>Bank Transfer</option><option>Cheque</option></select></div>
    <div class="field"><label>Notes / Reference (optional)</label><input id="recNotes" placeholder="e.g. via Easypaisa"></div>
    <div id="recErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;" onclick="saveRecovery('${cid}')">Save Recovery</button>
  `);
}
function saveRecovery(cid){
  const amt = Number(document.getElementById('recAmt').value);
  const bal = customerBalance(cid);
  if(!amt || amt<=0){ showErr('recErr','Enter a valid amount'); return; }
  if(amt > bal){ showErr('recErr',`Amount cannot exceed outstanding balance (${fmt(bal)})`); return; }
  const date = document.getElementById('recDate').value || todayISO();
  const method = document.getElementById('recMethod').value;
  const notes = document.getElementById('recNotes').value.trim();
  pushLedger({type:'wholesale_recovery', customerId:cid, date, amount:amt, method, notes:notes||undefined});
  toast('Recovery recorded'); closeModal(); renderAll();
}
function openWholesaleDiscount(cid){
  const bal = customerBalance(cid);
  if(bal<=0){ toast('This shop has no outstanding balance to discount', true); return; }
  openModal(`
    <h3>Give Discount</h3><div class="sub">Sale stays recorded at full price — this only writes off part of the balance. Current outstanding: ${fmt(bal)}</div>
    <div class="field"><label>Discount Amount (Rs)</label><input type="number" id="wdAmt" placeholder="e.g. 200"></div>
    <div class="field"><label>Reason / Notes (optional)</label><input id="wdNotes" placeholder="e.g. bargained rate, bulk order"></div>
    <div id="wdErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;" onclick="saveWholesaleDiscount('${cid}')">Save Discount</button>
  `);
}
function saveWholesaleDiscount(cid){
  const bal = customerBalance(cid);
  const amt = Number(document.getElementById('wdAmt').value);
  if(!amt || amt<=0){ showErr('wdErr','Enter a valid amount'); return; }
  if(amt > bal){ showErr('wdErr',`Discount cannot exceed outstanding balance (${fmt(bal)})`); return; }
  const notes = document.getElementById('wdNotes').value.trim();
  pushLedger({type:'wholesale_discount', customerId:cid, amount:amt, notes:notes||undefined});
  toast('Discount recorded — balance reduced'); closeModal(); renderAll();
}
function showErr(id,msg){ const e=document.getElementById(id); e.textContent=msg; e.style.display='block'; }
function isPositiveInt(v){ return Number.isInteger(v) && v>0; }

/* =====================================================================
   LOWER SHOP (RETAIL)
===================================================================== */
function renderLower(){
  document.getElementById('lowerDate').textContent = "Today, " + todayStr();
  const today = todayISO();
  const sales = ledger.filter(e=>e.type==='retail_sale' && e.date===today && (e.shop||'Lower')==='Lower');
  document.getElementById('lowerTodayCount').textContent = sales.length;
  document.getElementById('lowerTodayRev').textContent = fmt(sales.reduce((s,e)=>s+retailSaleNetAmount(e),0));
  document.getElementById('lowerTodayDue').textContent = fmt(sales.reduce((s,e)=>s+retailSaleDue(e),0));

  const qtyByProduct = {};
  sales.forEach(e=>e.items.forEach(it=>{ qtyByProduct[it.productId]=(qtyByProduct[it.productId]||0)+it.qty; }));
  const top = Object.entries(qtyByProduct).sort((a,b)=>b[1]-a[1])[0];
  document.getElementById('lowerTopProduct').textContent = top ? productName(top[0]) : '—';

  document.getElementById('lowerListCount').textContent = `(${sales.length})`;
  document.getElementById('lowerSaleList').innerHTML = sales.slice().reverse().map(e=>{
    const due = retailSaleDue(e);
    const disc = retailSaleDiscounts(e);
    let statusBadge = due>0 ? `<span class="badge due">Due ${fmt(due)}</span>` : `<span class="badge clear">Paid</span>`;
    if(disc>0) statusBadge += ` <span class="badge xfer">Discount ${fmt(disc)}</span>`;
    return `<div class="ledger-row clickable" onclick="openRetailSaleDetail(${e.id})">
      <div class="lr-main"><div class="title">${e.customerName}</div><div class="meta">${e.items.map(it=>productName(it.productId)+' x'+it.qty).join(', ')} · ${e.time||''}</div></div>
      <div class="lr-right"><div class="amt">${fmt(e.amount)}</div><div class="note">${statusBadge}</div></div>
    </div>`;
  }).join('') || `<div class="empty">No sales recorded today</div>`;

  // Retail customers: group all named (non walk-in) sales by customer name,
  // same list+click-to-open-ledger pattern as Upper Shop wholesale shops.
  const namedSales = ledger.filter(e=>e.type==='retail_sale' && e.customerName!=='Walk-in');
  const names = [...new Set(namedSales.map(e=>e.customerName))];
  const custSummaries = names.map(name=>{
    const rows = retailCustomerLedgerRows(name);
    const balance = rows.length ? rows[rows.length-1].balance : 0;
    const purchased = rows.filter(r=>r.debit).reduce((s,r)=>s+r.debit,0);
    const lastRow = rows[rows.length-1];
    return {name, balance, purchased, lastRow};
  }).sort((a,b)=>b.balance-a.balance);
  document.getElementById('retailDueList').innerHTML = custSummaries.map(c=>
    `<tr class="clickable" onclick="openRetailCustomerProfile('${c.name.replace(/'/g,"\\'")}')">
      <td><strong>${c.name}</strong>${c.lastRow?`<div style="font-size:11px;color:var(--muted);">Last: ${c.lastRow.desc} on ${c.lastRow.date}</div>`:''}</td>
      <td class="numeral">${fmt(c.purchased)}</td>
      <td>${c.balance>0?`<span class="badge due">Due ${fmt(c.balance)}</span>`:`<span class="badge clear">Clear ✓</span>`}</td>
    </tr>`
  ).join('') || `<tr><td colspan="3" class="empty">No named retail customers yet</td></tr>`;
}
function retailCustomerLedgerRows(name){
  const saleIds = ledger.filter(e=>e.type==='retail_sale' && e.customerName===name).map(e=>e.id);
  let rows=[];
  ledger.forEach(e=>{
    if(e.type==='retail_sale' && e.customerName===name){
      rows.push({date:e.date, id:e.id, desc:`Retail sale — ${e.items.map(it=>productName(it.productId)+' x'+it.qty).join(', ')}`, debit:e.amount, credit:0, saleId:e.id});
    } else if(e.type==='retail_payment' && saleIds.includes(e.saleId)){
      rows.push({date:e.date, id:e.id, desc:`Payment${e.method?' — '+e.method:''}`, debit:0, credit:e.amount, saleId:e.saleId});
    } else if(e.type==='retail_return' && saleIds.includes(e.saleId)){
      rows.push({date:e.date, id:e.id, desc:`Return — ${productName(e.productId)} x${e.qty}`, debit:0, credit:e.amount, saleId:e.saleId});
    } else if(e.type==='retail_discount' && saleIds.includes(e.saleId)){
      rows.push({date:e.date, id:e.id, desc:`Discount given${e.notes?' — '+e.notes:''}`, debit:0, credit:e.amount, saleId:e.saleId});
    }
  });
  rows.sort((a,b)=>a.date.localeCompare(b.date)||a.id-b.id);
  let bal=0; rows.forEach(r=>{ bal += r.debit-r.credit; r.balance=bal; });
  return rows;
}
function openRetailCustomerProfile(name){
  const rows = retailCustomerLedgerRows(name);
  const balance = rows.length ? rows[rows.length-1].balance : 0;
  const totalPurchased = rows.filter(r=>r.debit).reduce((s,r)=>s+r.debit,0);
  const openSales = ledger.filter(e=>e.type==='retail_sale' && e.customerName===name && retailSaleDue(e)>0);
  const ledgerHtml = rows.length ? `<div class="tbl-wrap"><table class="ledger-table"><thead><tr><th>Date</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td>${r.date}</td><td>${r.desc}</td><td class="debit numeral">${r.debit?fmt(r.debit):''}</td><td class="credit numeral">${r.credit?fmt(r.credit):''}</td><td class="bal numeral">${fmt(r.balance)}</td></tr>`).join('')}
    </tbody></table></div>` : `<div class="empty">No transactions yet</div>`;
  openModal(`
    <h3>${name}</h3><div class="sub">Retail credit customer</div>
    <div class="grid grid-2" style="margin-bottom:14px;">
      <div class="stat"><div class="label">Total Purchased</div><div class="val numeral">${fmt(totalPurchased)}</div></div>
      <div class="stat ${balance>0?'brick':'green'}"><div class="label">Current Balance</div><div class="val numeral">${fmt(balance)}</div></div>
    </div>
    ${openSales.length?`<h2 style="font-size:14px;margin-bottom:8px;">Sales With Balance Due — tap to pay or return</h2>
    ${openSales.map(e=>`<div class="ledger-row clickable" onclick="closeModal();openRetailSaleDetail(${e.id})"><div class="lr-main"><div class="title">${e.date} ${e.time||''}</div><div class="meta">${e.items.map(it=>productName(it.productId)+' x'+it.qty).join(', ')}</div></div><div class="lr-right"><span class="badge due">${fmt(retailSaleDue(e))}</span></div></div>`).join('')}`:''}
    <h2 style="font-size:14px;margin:14px 0 8px;">Full Ledger</h2>
    ${ledgerHtml}
    <button class="btn ghost" style="width:100%;margin-top:16px;" onclick="closeModal()">Close</button>
  `, true);
}
let _saleShop = 'Lower';
function openNewRetailSale(shop){
  _saleShop = shop || 'Lower';
  openModal(`
    <h3>New ${_saleShop} Shop Sale</h3><div class="sub">From ${_saleShop} Shop stock — updates automatically</div>
    <div class="field"><label>Customer Name (optional)</label><input id="saleCustomer" placeholder="Walk-in"></div>
    <div id="saleLines"></div>
    <button class="btn ghost sm" onclick="addSaleLine()" style="margin-bottom:12px;">+ Add Item</button>
    <div class="totalbar"><span>Total</span><span class="numeral" id="saleTotal">Rs 0</span></div>
    <div class="field-row" style="margin-top:12px;">
      <div class="field"><label>Amount Paid Now (Rs)</label><input type="number" id="salePaid" placeholder="0" oninput="updateSaleTotals()"></div>
      <div class="field"><label>Discount (Rs, optional)</label><input type="number" id="saleDiscount" placeholder="0" oninput="updateSaleTotals()"></div>
    </div>
    <div class="totalbar" style="border-top:none;padding-top:0;"><span>Balance Due</span><span class="numeral" id="saleDue">Rs 0</span></div>
    <div id="saleErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;margin-top:6px;" onclick="saveRetailSale()">Save Sale</button>
  `, true);
  addSaleLine();
}
function addSaleLine(){
  const wrap = document.getElementById('saleLines');
  const div = document.createElement('div'); div.className='line-row';
  div.innerHTML = `
    <select onchange="updateSaleTotals()">${products.filter(p=>p.active!==false).map(p=>`<option value="${p.id}">${p.name} — ${p.sku} (${productStock(p.id,_saleShop)} in stock)</option>`).join('')}</select>
    <input type="number" value="1" min="1" oninput="updateSaleTotals()">
    <div class="lineTotal numeral">Rs 0</div>
    <button class="rmBtn" onclick="this.parentElement.remove();updateSaleTotals();">✕</button>`;
  wrap.appendChild(div); updateSaleTotals();
}
function updateSaleTotals(){
  let total = 0;
  document.querySelectorAll('#saleLines .line-row').forEach(line=>{
    const pid = line.querySelector('select').value;
    const qty = Number(line.querySelector('input').value)||0;
    const p = products.find(x=>x.id===pid);
    const lt = p ? p.retail*qty : 0;
    line.querySelector('.lineTotal').textContent = fmt(lt);
    total += lt;
  });
  document.getElementById('saleTotal').textContent = fmt(total);
  const paid = Number(document.getElementById('salePaid')?.value)||0;
  const discount = Number(document.getElementById('saleDiscount')?.value)||0;
  document.getElementById('saleDue').textContent = fmt(Math.max(0,total-paid-discount));
}
function saveRetailSale(){
  const lines = document.querySelectorAll('#saleLines .line-row');
  if(!lines.length){ showErr('saleErr','Add at least one item'); return; }
  let rawLines=[], hasInvalidQty=false;
  lines.forEach(line=>{
    const pid = line.querySelector('select').value;
    const qtyRaw = Number(line.querySelector('input').value);
    if(!isPositiveInt(qtyRaw)){ hasInvalidQty = true; return; }
    rawLines.push({productId:pid, qty:qtyRaw});
  });
  if(hasInvalidQty){ showErr('saleErr','Quantity must be a whole number greater than 0 (no zero, negative, or decimal values)'); return; }
  if(!rawLines.length){ showErr('saleErr','Add at least one valid item'); return; }
  // aggregate duplicate product selections so stock is checked against the TOTAL quantity requested
  const totalsByProduct = {};
  rawLines.forEach(r=>{ totalsByProduct[r.productId] = (totalsByProduct[r.productId]||0) + r.qty; });
  let ok = true;
  Object.entries(totalsByProduct).forEach(([pid,qty])=>{ if(productStock(pid,_saleShop) < qty) ok=false; });
  if(!ok){ showErr('saleErr',`Not enough stock in ${_saleShop} Shop for the total quantity requested of one of the items`); return; }
  let items=[], total=0;
  Object.entries(totalsByProduct).forEach(([pid,qty])=>{
    const p = products.find(x=>x.id===pid);
    items.push({productId:pid, qty, price:p.retail, lineId:'L'+nextId()});
    total += p.retail*qty;
  });
  const paid = Number(document.getElementById('salePaid').value)||0;
  const discount = Number(document.getElementById('saleDiscount').value)||0;
  if(paid+discount > total){ showErr('saleErr','Paid + Discount cannot exceed the sale total'); return; }
  const customerName = document.getElementById('saleCustomer').value.trim() || 'Walk-in';
  const time = new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
  const sale = pushLedger({type:'retail_sale', time, customerName, items, amount:total, paidNow:paid, shop:_saleShop});
  if(discount>0) pushLedger({type:'retail_discount', saleId:sale.id, amount:discount, notes:'Given at time of sale'});
  toast(`Sale saved — ${_saleShop} Shop inventory updated`);
  closeModal(); renderAll();
}
function openRetailSaleDetail(id){
  const e = ledger.find(x=>x.id===id); if(!e) return;
  const due = retailSaleDue(e);
  const paidTotal = retailSalePaidTotal(e);
  const discountTotal = retailSaleDiscounts(e);
  const returnTotal = retailSaleReturnsTotal(e);
  const payments = ledger.filter(x=>x.type==='retail_payment' && x.saleId===id);
  openModal(`
    <h3>${e.customerName} — Retail Sale</h3><div class="sub">${e.date} ${e.time||''}</div>
    <div class="tbl-wrap" style="margin-bottom:12px;"><table><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Line Total</th></tr></thead><tbody>
      ${e.items.map(it=>`<tr><td>${productName(it.productId)}</td><td>${it.qty}</td><td class="numeral">${fmt(it.price)}</td><td class="numeral">${fmt(it.price*it.qty)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="grid-auto" style="margin-bottom:14px;">
      <div class="stat"><div class="label">Total</div><div class="val numeral">${fmt(e.amount)}</div></div>
      <div class="stat green"><div class="label">Paid (Cash)</div><div class="val numeral">${fmt(paidTotal)}</div></div>
      ${discountTotal>0?`<div class="stat violet"><div class="label">Discount Given</div><div class="val numeral">${fmt(discountTotal)}</div></div>`:''}
      ${returnTotal>0?`<div class="stat violet"><div class="label">Returned</div><div class="val numeral">${fmt(returnTotal)}</div></div>`:''}
      <div class="stat ${due>0?'brick':'green'}"><div class="label">Due</div><div class="val numeral">${fmt(due)}</div></div>
    </div>
    ${due>0?`<div class="field-row"><div class="field"><label>Record Payment (Rs)</label><input type="number" id="rpAmt" placeholder="e.g. ${due}"></div><div class="field"><label>Method</label><select id="rpMethod"><option>Cash</option><option>Bank</option><option>Cheque</option><option>Other</option></select></div></div>
    <div id="rpErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;margin-bottom:10px;" onclick="addRetailPayment(${id})">+ Add Payment</button>`:''}
    <div class="btnrow" style="margin-bottom:14px;display:flex;gap:8px;">
      <button class="btn ghost sm" style="flex:1;" onclick="openRetailReturn(${id})">↩ Return</button>
      ${due>0?`<button class="btn ghost sm" style="flex:1;" onclick="openRetailDiscount(${id})">🏷 Discount</button>`:''}
      <button class="btn ghost sm" style="flex:1;" onclick="printReceipt('retail',${id})">🖨 Print</button>
    </div>
    ${payments.length?`<h2 style="font-size:13.5px;margin-bottom:6px;">Payment History</h2>${payments.map(p=>`<div class="ledger-row"><div class="lr-main"><div class="title numeral">${fmt(p.amount)}</div><div class="meta">${p.method||''}</div></div><div class="lr-right"><div class="note">${p.date}</div></div></div>`).join('')}`:''}
    ${retailSaleReturns(e).length?`<h2 style="font-size:13.5px;margin:10px 0 6px;">Return History</h2>${retailSaleReturns(e).map(r=>`<div class="ledger-row"><div class="lr-main"><div class="title">${productName(r.productId)} x${r.qty}</div></div><div class="lr-right"><div class="amt numeral">${fmt(r.amount)}</div><div class="note">${r.date}</div></div></div>`).join('')}`:''}
    ${retailSaleDiscounts(e)>0?`<h2 style="font-size:13.5px;margin:10px 0 6px;">Discounts Given</h2>${ledger.filter(x=>x.type==='retail_discount'&&x.saleId===id).map(d=>`<div class="ledger-row"><div class="lr-main"><div class="title numeral">${fmt(d.amount)}</div><div class="meta">${d.notes||''}</div></div><div class="lr-right"><div class="note">${d.date}</div></div></div>`).join('')}`:''}
    <button class="btn ghost" style="width:100%;margin-top:12px;" onclick="closeModal()">Close</button>
  `);
}
function openRetailDiscount(saleId){
  const e = ledger.find(x=>x.id===saleId);
  const due = retailSaleDue(e);
  openModal(`
    <h3>Give Discount</h3><div class="sub">Sale stays recorded at full price — this only writes off part of the due. Current due: ${fmt(due)}</div>
    <div class="field"><label>Discount Amount (Rs)</label><input type="number" id="rdAmt" placeholder="e.g. 50"></div>
    <div class="field"><label>Reason / Notes (optional)</label><input id="rdNotes" placeholder="e.g. bargained rate"></div>
    <div id="rdErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;" onclick="saveRetailDiscount(${saleId})">Save Discount</button>
  `);
}
function saveRetailDiscount(saleId){
  const e = ledger.find(x=>x.id===saleId);
  const due = retailSaleDue(e);
  const amt = Number(document.getElementById('rdAmt').value);
  if(!amt || amt<=0){ showErr('rdErr','Enter a valid amount'); return; }
  if(amt > due){ showErr('rdErr',`Discount cannot exceed due (${fmt(due)})`); return; }
  const notes = document.getElementById('rdNotes').value.trim();
  pushLedger({type:'retail_discount', saleId, amount:amt, notes:notes||undefined});
  toast('Discount recorded — due reduced'); closeModal(); renderAll();
}
function addRetailPayment(saleId){
  const e = ledger.find(x=>x.id===saleId);
  const due = retailSaleDue(e);
  const amt = Number(document.getElementById('rpAmt').value);
  if(!amt || amt<=0){ showErr('rpErr','Enter a valid amount'); return; }
  if(amt > due){ showErr('rpErr',`Amount cannot exceed due (${fmt(due)})`); return; }
  const method = document.getElementById('rpMethod').value;
  pushLedger({type:'retail_payment', saleId, amount:amt, method});
  toast('Payment recorded'); closeModal(); renderAll();
}
function openRetailReturn(saleId){
  const e = ledger.find(x=>x.id===saleId);
  const eligible = e.items.map((it,i)=>{
    const lid = effLineId(saleId, it);
    const alreadyReturned = ledger.filter(r=>r.type==='retail_return' && r.saleId===saleId && r.lineId===lid).reduce((s,r)=>s+r.qty,0);
    return {...it, idx:i, lineId:lid, eligibleQty: it.qty - alreadyReturned};
  }).filter(it=>it.eligibleQty > 0);
  if(!eligible.length){ toast('No returnable items — everything in this sale has already been returned', true); return; }
  openModal(`
    <h3>Record Retail Return</h3><div class="sub">Increases Lower Shop stock and reduces amount due</div>
    <div class="field"><label>Product Returned</label><select id="rrProduct">${eligible.map(it=>`<option value="${it.idx}">${productName(it.productId)} (eligible: ${it.eligibleQty} of ${it.qty})</option>`).join('')}</select></div>
    <div class="field"><label>Quantity Returned</label><input type="number" id="rrQty" placeholder="e.g. 1"></div>
    <div id="rrErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;" onclick="saveRetailReturn(${saleId})">Save Return</button>
  `);
}
function saveRetailReturn(saleId){
  const e = ledger.find(x=>x.id===saleId);
  const idx = Number(document.getElementById('rrProduct').value);
  const it = e.items[idx];
  const lid = effLineId(saleId, it);
  const alreadyReturned = ledger.filter(r=>r.type==='retail_return' && r.saleId===saleId && r.lineId===lid).reduce((s,r)=>s+r.qty,0);
  const eligibleQty = it.qty - alreadyReturned;
  const qty = Number(document.getElementById('rrQty').value);
  if(!isPositiveInt(qty)){ showErr('rrErr','Quantity must be a whole number greater than 0'); return; }
  if(qty > eligibleQty){ showErr('rrErr',`Cannot return more than eligible (${eligibleQty} remaining)`); return; }
  const amount = qty * it.price;
  pushLedger({type:'retail_return', saleId, productId:it.productId, lineId:lid, qty, amount});
  toast('Return recorded — Lower stock increased, due reduced');
  closeModal(); renderAll();
}

/* =====================================================================
   INVENTORY
===================================================================== */
function renderInventory(){
  document.getElementById('invShopTabs').innerHTML = ['Upper','Lower'].map(s=>
    `<button class="chip ${s===ui.invShop?'active':''}" onclick="setInvShop('${s}')">${s==='Upper'?'🏙 Upper Shop':'🏪 Lower Shop'}</button>`).join('');
  document.getElementById('invCatTabs').innerHTML = CATS.map(c=>
    `<button class="chip sm ${c===ui.invCat?'active':''}" onclick="setInvCat('${c}')">${c}</button>`).join('');
  document.getElementById('invSeasonTabs').innerHTML = SEASONS.map(se=>
    `<button class="chip sm violet ${se===ui.invSeason?'active':''}" onclick="setInvSeason('${se}')">${se==='Summer'?'☀ Summer':'❄ Winter'}</button>`).join('');

  const search = (document.getElementById('invSearch')?.value||'').toLowerCase();
  let rows = products.filter(p=>p.category===ui.invCat && p.season===ui.invSeason);
  if(search) rows = rows.filter(p=>p.name.toLowerCase().includes(search) || p.sku.toLowerCase().includes(search));

  document.getElementById('invTableBody').innerHTML = rows.map(p=>{
    const stock = productStock(p.id, ui.invShop);
    const low = stock < p.minStock;
    return `<tr style="${p.active===false?'opacity:.5;':''}">
      <td class="numeral" style="color:var(--muted);font-size:12px;">${p.sku}</td>
      <td><strong>${p.name}</strong>${p.active===false?' <span class="badge grey">Inactive</span>':''}</td>
      <td class="numeral">${fmt(p.cost)}</td>
      <td class="numeral">${fmt(p.wsale)}</td>
      <td class="numeral">${fmt(p.retail)}</td>
      <td class="numeral" style="${low?'color:var(--brick);font-weight:700;':'font-weight:600;'}">${stock<=0?'OUT':stock+' '+p.unit} ${low?'⚠':''}</td>
      <td class="numeral">${p.packSize>1 ? (stock<=0?'—':boxesDisplay(stock,p)) : '—'}</td>
      <td><div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn sm ghost" onclick="openAdjustStock('${p.id}')">Adjust</button>
        <button class="btn sm ghost" onclick="openEditProduct('${p.id}')">Edit</button>
        <button class="btn sm ghost" onclick="toggleProductActive('${p.id}')">${p.active===false?'Activate':'Deactivate'}</button>
      </div></td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" class="empty">No products found</td></tr>`;

  document.getElementById('xferCount').textContent = `(${ledger.filter(e=>e.type==='stock_transfer').length})`;
  document.getElementById('xferList').innerHTML = ledger.filter(e=>e.type==='stock_transfer').slice().reverse().map(t=>{
    const p = products.find(x=>x.id===t.productId);
    const boxes = t.packQty!=null ? t.packQty : boxesDisplay(t.qty, p);
    return `<tr><td>${t.date}</td><td>${p?p.name:t.productId}</td><td class="numeral" style="color:var(--muted);font-size:12px;">${p?p.sku:''}</td><td class="numeral">${boxes}</td><td class="numeral">${t.qty}</td><td>${t.notes||''}</td></tr>`;
  }).join('') || `<tr><td colspan="6" class="empty">No transfers yet</td></tr>`;
}
function setInvShop(s){ ui.invShop=s; renderInventory(); }
function setInvCat(c){ ui.invCat=c; renderInventory(); }
function setInvSeason(se){ ui.invSeason=se; renderInventory(); }

function openAdjustStock(pid){
  const p = products.find(x=>x.id===pid);
  const current = productStock(pid, ui.invShop);
  openModal(`
    <h3>Stock Adjustment</h3><div class="sub">${p.name} — ${ui.invShop} Shop · Current: ${current} ${p.unit}</div>
    <div class="field"><label>Direction</label><select id="adjDirection"><option value="add">➕ Add Stock</option><option value="remove">➖ Remove Stock</option></select></div>
    <div class="field-row">
      <div class="field"><label>Boxes (optional)</label><input type="number" id="adjBoxes" min="0" placeholder="e.g. 5" oninput="adjBoxesChanged('${pid}')"></div>
      <div class="field"><label>Pieces</label><input type="number" id="adjPieces" min="0" placeholder="e.g. 30"></div>
    </div>
    <div id="adjHint" style="font-size:11.5px;color:var(--muted);margin-top:-4px;">${p.packSize>1?`e.g. 5 boxes × ${p.packSize}/box = ${5*p.packSize} pieces, calculated for you.`:'This product has no box size set — enter pieces directly.'}</div>
    <div class="field" style="margin-top:11px;"><label>Reason</label><select id="adjReason">
      <option>Opening Stock</option><option>Damaged</option><option>Lost</option><option>Found</option>
      <option>Correction</option><option>Physical Stock Count</option><option>Other</option>
    </select></div>
    <div class="field"><label>Date</label><input type="date" id="adjDate" value="${todayISO()}"></div>
    <div class="field"><label>Note / Reference (optional)</label><input id="adjNotes"></div>
    <div id="adjErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;" onclick="saveAdjustStock('${pid}')">Save Adjustment</button>
  `);
}
function adjBoxesChanged(pid){
  const p = products.find(x=>x.id===pid);
  const pack = p.packSize||1;
  const boxes = Number(document.getElementById('adjBoxes').value)||0;
  if(boxes>0) document.getElementById('adjPieces').value = boxes*pack;
}
function saveAdjustStock(pid){
  const direction = document.getElementById('adjDirection').value;
  const piecesRaw = Number(document.getElementById('adjPieces').value);
  const boxesRaw = document.getElementById('adjBoxes').value;
  const boxes = Number(boxesRaw);
  if(!isPositiveInt(piecesRaw)){ showErr('adjErr','Pieces must be a whole number greater than 0'); return; }
  if(boxesRaw!=='' && !isPositiveInt(boxes)){ showErr('adjErr','Boxes must be a whole number greater than 0'); return; }
  const val = direction==='remove' ? -piecesRaw : piecesRaw;
  const current = productStock(pid, ui.invShop);
  if(current+val < 0){ showErr('adjErr','Adjustment would make stock negative'); return; }
  const reason = document.getElementById('adjReason').value;
  const date = document.getElementById('adjDate').value || todayISO();
  const notes = document.getElementById('adjNotes').value.trim();
  pushLedger({type:'adjustment', productId:pid, shop:ui.invShop, qty:val, packQty:boxes>0?boxes:undefined, reason, date, notes:notes||undefined});
  toast('Stock adjustment recorded'); closeModal(); renderAll();
}
function toggleProductActive(pid){
  const p = products.find(x=>x.id===pid);
  const hasHistory = ledger.some(e=>e.productId===pid || (e.items||[]).some(it=>it.productId===pid));
  if(p.active!==false && hasHistory && !confirm(`"${p.name}" has transaction history. Deactivate instead of deleting — it will be hidden from new sales/purchases but its history stays intact. Continue?`)) return;
  p.active = p.active===false ? true : false;
  markDirty();
  toast(p.active===false ? 'Product deactivated' : 'Product activated');
  renderAll();
}
function openEditProduct(pid){
  const p = products.find(x=>x.id===pid);
  openModal(`
    <h3>Edit Product</h3><div class="sub">SKU: ${p.sku} (category/season fixed after creation)</div>
    <div class="field"><label>Product Name</label><input id="epName" value="${p.name}"></div>
    <div class="field-row">
      <div class="field"><label>Cost Price</label><input type="number" id="epCost" value="${p.cost}"></div>
      <div class="field"><label>Wholesale Price</label><input type="number" id="epWsale" value="${p.wsale}"></div>
      <div class="field"><label>Retail Price</label><input type="number" id="epRetail" value="${p.retail}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Minimum Stock</label><input type="number" id="epMin" value="${p.minStock}"></div>
      <div class="field"><label>Unit</label><input id="epUnit" value="${p.unit}"></div>
    </div>
    <div class="field"><label>Pack / Box Size (units per box — 1 if sold loose only)</label><input type="number" id="epPack" value="${p.packSize||1}" min="1"></div>
    <div id="epErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;" onclick="saveEditProduct('${pid}')">Save Changes</button>
  `);
}
function saveEditProduct(pid){
  const p = products.find(x=>x.id===pid);
  const name = document.getElementById('epName').value.trim();
  const cost = Number(document.getElementById('epCost').value);
  const wsale = Number(document.getElementById('epWsale').value);
  const retail = Number(document.getElementById('epRetail').value);
  const minStock = Number(document.getElementById('epMin').value);
  const packSizeRaw = Number(document.getElementById('epPack').value);
  if(!name){ showErr('epErr','Enter a product name'); return; }
  if(!(cost>0)){ showErr('epErr','Cost Price must be greater than 0'); return; }
  if(!(wsale>0)){ showErr('epErr','Wholesale Price must be greater than 0'); return; }
  if(!(retail>0)){ showErr('epErr','Retail Price must be greater than 0'); return; }
  if(!(minStock>=0)){ showErr('epErr','Minimum Stock must be 0 or greater'); return; }
  if(!(Number.isInteger(packSizeRaw) && packSizeRaw>=1)){ showErr('epErr','Pack Size must be a positive whole number (1 or more)'); return; }
  p.name = name;
  p.cost = cost;
  p.wsale = wsale;
  p.retail = retail;
  p.minStock = minStock;
  p.unit = document.getElementById('epUnit').value.trim()||'pcs';
  p.packSize = packSizeRaw;
  markDirty();
  toast('Product updated'); closeModal(); renderAll();
}
function openAddProduct(){
  _npSkuManual = false;
  _npOpenPiecesManual = false;
  openModal(`
    <h3>Add Product</h3><div class="sub">Fill in the basics, then tell us how much stock you have</div>
    <div class="field"><label>Product Name</label><input id="npName" placeholder="e.g. Men's Trunk" autofocus></div>
    <div class="field-row">
      <div class="field"><label>Category</label><select id="npCat" onchange="updateNpSkuPreview()">${CATS.map(c=>`<option>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Season</label><select id="npSeason" onchange="updateNpSkuPreview()">${SEASONS.map(s=>`<option>${s}</option>`).join('')}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Cost Price</label><input type="number" id="npCost"></div>
      <div class="field"><label>Wholesale Price</label><input type="number" id="npWsale"></div>
      <div class="field"><label>Retail Price</label><input type="number" id="npRetail"></div>
    </div>

    <div style="border-top:1px dashed var(--border);margin:14px 0 12px;padding-top:12px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:8px;">📦 Stock</div>
      <div class="field-row">
        <div class="field"><label>Pieces per Box</label><input type="number" id="npPack" value="1" min="1" oninput="updateNpOpeningPreview()"></div>
        <div class="field"><label>How Many Boxes?</label><input type="number" id="npOpenBoxes" min="0" placeholder="e.g. 20" oninput="updateNpOpeningPreview()"></div>
        <div class="field"><label>Which Shop?</label><select id="npOpenShop"><option value="Upper">Upper Shop</option><option value="Lower">Lower Shop</option></select></div>
      </div>
      <div class="field"><label>Total Pieces</label><input type="number" id="npOpenPieces" min="0" placeholder="calculated automatically, or type it directly" oninput="_npOpenPiecesManual=true"></div>
      <div id="npOpenHint" style="font-size:11.5px;color:var(--muted);margin-top:-4px;">e.g. 20 boxes × 6 pieces/box = 120 pieces, calculated for you. If you don't have any stock yet, leave Boxes and Total Pieces empty.</div>
    </div>

    <div style="border-top:1px dashed var(--border);margin:14px 0 12px;padding-top:12px;">
      <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:8px;">More options (optional)</div>
      <div class="field-row">
        <div class="field"><label>Minimum Stock Level</label><input type="number" id="npMin" value="20"></div>
        <div class="field"><label>Unit</label><input id="npUnit" value="pcs"></div>
      </div>
      <div class="field"><label>SKU (auto-generated — edit only if you need a custom one)</label><input id="npSkuPreview" value="${skuFor('Men','Summer',productSeq+1)}" oninput="_npSkuManual=true" style="font-size:12.5px;"></div>
    </div>

    <div id="npErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;" onclick="saveNewProduct()">Save Product</button>
  `);
}
let _npOpenPiecesManual = false;
function updateNpOpeningPreview(){
  if(_npOpenPiecesManual) return;
  const pack = Number(document.getElementById('npPack').value)||1;
  const boxes = Number(document.getElementById('npOpenBoxes').value)||0;
  if(boxes>0) document.getElementById('npOpenPieces').value = boxes*pack;
}
let _npSkuManual = false;
function updateNpSkuPreview(){
  if(_npSkuManual) return;
  const cat = document.getElementById('npCat').value;
  const season = document.getElementById('npSeason').value;
  document.getElementById('npSkuPreview').value = skuFor(cat, season, productSeq+1);
}
function saveNewProduct(){
  const category = document.getElementById('npCat').value;
  const season = document.getElementById('npSeason').value;
  const name = document.getElementById('npName').value.trim();
  const cost = Number(document.getElementById('npCost').value);
  const wsale = Number(document.getElementById('npWsale').value);
  const retail = Number(document.getElementById('npRetail').value);
  const minStock = Number(document.getElementById('npMin').value);
  const unit = document.getElementById('npUnit').value.trim()||'pcs';
  const packSizeRaw = Number(document.getElementById('npPack').value);
  let sku = document.getElementById('npSkuPreview').value.trim();
  if(!name){ showErr('npErr','Enter a product name'); return; }
  if(!sku){ showErr('npErr','SKU cannot be empty'); return; }
  if(products.some(p=>p.sku.toLowerCase()===sku.toLowerCase())){ showErr('npErr',`SKU "${sku}" already exists — choose a different one`); return; }
  if(!(cost>0)){ showErr('npErr','Cost Price must be greater than 0'); return; }
  if(!(wsale>0)){ showErr('npErr','Wholesale Price must be greater than 0'); return; }
  if(!(retail>0)){ showErr('npErr','Retail Price must be greater than 0'); return; }
  if(!(minStock>=0)){ showErr('npErr','Minimum Stock must be 0 or greater'); return; }
  if(!(Number.isInteger(packSizeRaw) && packSizeRaw>=1)){ showErr('npErr','Pack Size must be a positive whole number (1 or more)'); return; }
  const packSize = packSizeRaw;
  productSeq++;
  const id = 'P'+nextId();

  const openShop = document.getElementById('npOpenShop').value;
  const openBoxesRaw = document.getElementById('npOpenBoxes').value;
  const openPiecesRaw = document.getElementById('npOpenPieces').value;
  const openBoxes = Number(openBoxesRaw);
  const openPieces = Number(openPiecesRaw);
  if(openBoxesRaw!=='' && !(Number.isInteger(openBoxes) && openBoxes>=0)){ showErr('npErr','Opening Stock Boxes must be a whole number 0 or greater'); return; }
  if(openPiecesRaw!=='' && !(Number.isInteger(openPieces) && openPieces>=0)){ showErr('npErr','Opening Stock Pieces must be a whole number 0 or greater'); return; }

  products.push({id, sku, name, category, season, cost, wsale, retail, minStock, unit, packSize, active:true});
  markDirty();
  if(openPieces>0){
    pushLedger({type:'adjustment', productId:id, shop:openShop, qty:openPieces, packQty:openBoxes>0?openBoxes:undefined, reason:'Opening Stock', notes:'Set when product was created'});
  }
  ui.invCat = category; ui.invSeason = season; ui.invShop = openShop;
  toast('Product added to catalog'); closeModal(); renderAll();
}

/* ---- Transfer Upper -> Lower ---- */
function openTransfer(){
  openModal(`
    <h3>Transfer Stock</h3><div class="sub">Upper Shop → Lower Shop</div>
    <div class="field"><label>Item (from Upper Shop)</label><select id="xferItem" onchange="xferItemChanged()">${products.filter(p=>p.active!==false).map(p=>`<option value="${p.id}" data-pack="${p.packSize||1}">${p.name} — ${p.sku}${p.packSize>1?' ('+p.packSize+'/box)':''} (${productStock(p.id,'Upper')} available)</option>`).join('')}</select></div>
    <div class="field-row">
      <div class="field"><label>Boxes (optional)</label><input type="number" id="xferBoxes" min="0" placeholder="e.g. 3" oninput="xferBoxesChanged()"></div>
      <div class="field"><label>Pieces (total)</label><input type="number" id="xferQty" placeholder="e.g. 36"></div>
    </div>
    <div class="field"><label>Notes / Reference (optional)</label><input id="xferNotes" placeholder="e.g. counter restock"></div>
    <div id="xferErr" class="err" style="display:none;"></div>
    <button class="btn violet" style="width:100%;" onclick="doTransfer()">⇄ Transfer &amp; Update Stock</button>
  `);
}
function xferItemChanged(){
  document.getElementById('xferBoxes').value = '';
}
function xferBoxesChanged(){
  const sel = document.getElementById('xferItem');
  const pack = Number(sel.selectedOptions[0].dataset.pack)||1;
  const boxes = Number(document.getElementById('xferBoxes').value)||0;
  if(boxes>0) document.getElementById('xferQty').value = boxes*pack;
}
function doTransfer(){
  const pid = document.getElementById('xferItem').value;
  const qty = Number(document.getElementById('xferQty').value);
  const boxesRaw = document.getElementById('xferBoxes').value;
  const boxes = Number(boxesRaw);
  const notes = document.getElementById('xferNotes').value.trim();
  if(!isPositiveInt(qty)){ showErr('xferErr','Quantity (pieces) must be a whole number greater than 0'); return; }
  if(boxesRaw!=='' && !isPositiveInt(boxes)){ showErr('xferErr','Boxes must be a whole number greater than 0'); return; }
  const avail = productStock(pid,'Upper');
  if(avail < qty){ showErr('xferErr',`Not enough stock in Upper Shop (only ${avail} available)`); return; }
  pushLedger({type:'stock_transfer', productId:pid, qty, packQty:boxes>0?boxes:undefined, notes:notes||undefined});
  toast('Stock transferred to Lower Shop'); closeModal(); renderAll();
}

/* =====================================================================
   VENDORS / PURCHASES
===================================================================== */
function renderVendors(){
  const totalPayable = vendors.reduce((s,v)=>s+vendorBalance(v.id),0);
  document.getElementById('vendPayableTotal').textContent = fmt(totalPayable);
  document.getElementById('vendCount').textContent = vendors.length;
  document.getElementById('vendClearedCount').textContent = vendors.filter(v=>vendorBalance(v.id)===0).length;
  document.getElementById('vendListCount').textContent = `(${vendors.length})`;

  document.getElementById('vendorList').innerHTML = vendors.map(v=>{
    const bal = vendorBalance(v.id);
    const rows = vendorLedgerRows(v.id);
    const purchased = rows.filter(r=>r.debit).reduce((s,r)=>s+r.debit,0);
    const paid = rows.filter(r=>r.credit).reduce((s,r)=>s+r.credit,0);
    const last = rows.filter(r=>r.ref).slice(-1)[0];
    return `<tr class="clickable" onclick="openVendorDetail('${v.id}')">
      <td><strong>${v.name}</strong>${last?`<div style="font-size:11px;color:var(--muted);">Last: ${last.desc} on ${last.date}</div>`:''}</td>
      <td style="font-size:12.5px;color:var(--muted);">${v.contact}<br>${v.phone}</td>
      <td class="numeral">${fmt(purchased)}</td>
      <td class="numeral">${fmt(paid)}</td>
      <td>${bal>0?`<span class="badge due">Owe ${fmt(bal)}</span>`:`<span class="badge clear">Clear ✓</span>`}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="5" class="empty">No vendors added yet</td></tr>`;
}
function openAddVendor(){
  openModal(`
    <h3>Add Vendor</h3><div class="sub">Someone we buy stock from</div>
    <div class="field"><label>Vendor Name</label><input id="nvName" placeholder="e.g. Sialkot Textiles"></div>
    <div class="field-row">
      <div class="field"><label>Contact Person</label><input id="nvContact" placeholder="e.g. Waseem Iqbal"></div>
      <div class="field"><label>Phone</label><input id="nvPhone" placeholder="03XX-XXXXXXX"></div>
    </div>
    <div class="field"><label>Address (optional)</label><input id="nvAddress"></div>
    <div class="field"><label>Opening Payable Balance (Rs, optional)</label><input type="number" id="nvOpening" placeholder="0"></div>
    <div id="nvErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;" onclick="saveNewVendor()">Save Vendor</button>
  `);
}
function saveNewVendor(){
  const name = document.getElementById('nvName').value.trim();
  const contact = document.getElementById('nvContact').value.trim();
  const phone = document.getElementById('nvPhone').value.trim();
  const address = document.getElementById('nvAddress').value.trim();
  const opening = Number(document.getElementById('nvOpening').value);
  if(!name){ showErr('nvErr','Enter vendor name'); return; }
  if(!(opening>=0)){ showErr('nvErr','Opening Payable cannot be negative'); return; }
  vendors.push({id:'V'+nextId(), name, contact, phone, address, opening});
  markDirty();
  toast('Vendor added'); closeModal(); renderAll();
}
function openEditVendor(vid){
  const v = vendors.find(x=>x.id===vid);
  openModal(`
    <h3>Edit Vendor</h3>
    <div class="field"><label>Vendor Name</label><input id="evName" value="${v.name}"></div>
    <div class="field-row">
      <div class="field"><label>Contact Person</label><input id="evContact" value="${v.contact||''}"></div>
      <div class="field"><label>Phone</label><input id="evPhone" value="${v.phone||''}"></div>
    </div>
    <div class="field"><label>Address (optional)</label><input id="evAddress" value="${v.address||''}"></div>
    <div id="evErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;" onclick="saveEditVendor('${vid}')">Save</button>
  `);
}
function saveEditVendor(vid){
  const v = vendors.find(x=>x.id===vid);
  const name = document.getElementById('evName').value.trim();
  if(!name){ showErr('evErr','Enter vendor name'); return; }
  v.name = name;
  v.contact = document.getElementById('evContact').value.trim();
  v.phone = document.getElementById('evPhone').value.trim();
  v.address = document.getElementById('evAddress').value.trim();
  markDirty();
  toast('Vendor updated'); closeModal(); openVendorDetail(vid);
}
function openVendorDetail(vid){
  const v = vendors.find(x=>x.id===vid); if(!v) return;
  const rows = vendorLedgerRows(vid);
  const bal = vendorBalance(vid);
  const ledgerHtml = rows.length ? `<div class="tbl-wrap"><table class="ledger-table"><thead><tr><th>Date</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td>${r.date}</td><td>${r.desc}${r.ref&&r.ref.type==='vendor_purchase'?` <button class="btn sm ghost" style="padding:2px 8px;font-size:11px;" onclick="openVendorPurchaseItems(${r.ref.id})">🔍 View Items</button> <button class="btn sm ghost" style="padding:2px 8px;font-size:11px;" onclick="printPurchaseInvoice(${r.ref.id})">🖨 Invoice</button>`:''}</td><td class="debit numeral">${r.debit?fmt(r.debit):''}</td><td class="credit numeral">${r.credit?fmt(r.credit):''}</td><td class="bal numeral">${fmt(r.balance)}</td></tr>`).join('')}
    </tbody></table></div>` : `<div class="empty">No transactions yet</div>`;
  openModal(`
    <h3>${v.name} <button class="btn sm ghost" style="margin-left:6px;" onclick="openEditVendor('${vid}')">✎ Edit Vendor</button></h3><div class="sub">${v.contact} · ${v.phone}</div>
    <div class="stat ${bal>0?'brick':'green'}" style="margin-bottom:14px;"><div class="label">Balance Payable</div><div class="val numeral">${fmt(bal)}</div></div>
    <div class="btnrow" style="margin-bottom:10px;display:flex;gap:8px;">
      <button class="btn amber sm" style="flex:1;" onclick="closeModal();openNewPurchase('${vid}')">+ New Purchase</button>
      <button class="btn ghost sm" style="flex:1;" onclick="openVendorPay('${vid}')">+ Pay Vendor</button>
    </div>
    <div class="btnrow" style="margin-bottom:16px;display:flex;gap:8px;">
      <button class="btn ghost sm" style="flex:1;" onclick="openVendorReturn('${vid}')">↩ Return to Vendor</button>
      <button class="btn ghost sm" style="flex:1;" onclick="printReceipt('vendor','${vid}')">🖨 Print</button>
      <button class="btn ghost sm" style="flex:1;" onclick="exportVendorData('${vid}')">⬇ Excel</button>
    </div>
    <h2 style="font-size:14px;margin-bottom:8px;">Ledger</h2>
    ${ledgerHtml}
    <button class="btn ghost" style="width:100%;margin-top:16px;" onclick="closeModal()">Close</button>
  `, true);
}
function openVendorPay(vid){
  const bal = vendorBalance(vid);
  openModal(`
    <h3>Pay Vendor</h3><div class="sub">Current payable: ${fmt(bal)}</div>
    <div class="field-row"><div class="field"><label>Amount (Rs)</label><input type="number" id="vpAmt" placeholder="e.g. 20000"></div>
    <div class="field"><label>Method</label><select id="vpMethod"><option>Cash</option><option>Bank</option><option>Cheque</option><option>Other</option></select></div></div>
    <div class="field"><label>Notes (optional)</label><input id="vpNotes"></div>
    <div id="vpErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;" onclick="saveVendorPay('${vid}')">Record Payment</button>
  `);
}
function saveVendorPay(vid){
  const bal = vendorBalance(vid);
  const amt = Number(document.getElementById('vpAmt').value);
  if(!amt||amt<=0){ showErr('vpErr','Enter a valid amount'); return; }
  if(amt>bal){ showErr('vpErr',`Amount cannot exceed payable (${fmt(bal)})`); return; }
  const method = document.getElementById('vpMethod').value;
  const notes = document.getElementById('vpNotes').value.trim();
  pushLedger({type:'vendor_payment', vendorId:vid, amount:amt, method, notes:notes||undefined});
  toast('Payment recorded'); closeModal(); renderAll();
}

let _vrItems = [];
function openVendorReturn(vid){
  _vrItems = ledger.filter(e=>e.type==='vendor_purchase' && e.vendorId===vid).flatMap(e=>e.items.map(it=>({...it, purchaseId:e.id, purchaseRef:e.invoiceRef||e.id, effLineId:effLineId(e.id,it)})));
  _vrItems = _vrItems.map(it=>{
    const alreadyReturned = ledger.filter(r=>r.type==='vendor_return' && r.vendorId===vid && r.lineId===it.effLineId).reduce((s,r)=>s+r.qty,0);
    return {...it, eligibleQty: it.qty - alreadyReturned};
  }).filter(it=>it.eligibleQty > 0);
  if(!_vrItems.length){ toast('No returnable items — everything purchased has already been fully returned', true); return; }
  openModal(`
    <h3>Return Stock to Vendor</h3><div class="sub">Decreases Upper Shop stock and reduces vendor payable</div>
    <div class="field"><label>Product Returned</label><select id="vrProduct" onchange="vrProductChanged()">${_vrItems.map((it,i)=>`<option value="${i}" data-pack="${(products.find(p=>p.id===it.productId)||{}).packSize||1}">${productName(it.productId)} — from ${it.purchaseRef} (eligible: ${it.eligibleQty} of ${it.qty})</option>`).join('')}</select></div>
    <div class="field-row">
      <div class="field"><label>Boxes (optional)</label><input type="number" id="vrBoxes" min="0" placeholder="e.g. 2" oninput="vrBoxesChanged()"></div>
      <div class="field"><label>Quantity Returned (pieces)</label><input type="number" id="vrQty" placeholder="e.g. 10"></div>
    </div>
    <div class="field"><label>Notes (optional)</label><input id="vrNotes" placeholder="e.g. wrong size sent"></div>
    <div id="vrErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;" onclick="saveVendorReturn('${vid}')">Save Return</button>
  `);
}
function vrProductChanged(){ document.getElementById('vrBoxes').value=''; }
function vrBoxesChanged(){
  const sel = document.getElementById('vrProduct');
  const pack = Number(sel.selectedOptions[0].dataset.pack)||1;
  const boxes = Number(document.getElementById('vrBoxes').value)||0;
  if(boxes>0) document.getElementById('vrQty').value = boxes*pack;
}
function saveVendorReturn(vid){
  const idx = Number(document.getElementById('vrProduct').value);
  const it = _vrItems[idx];
  const qty = Number(document.getElementById('vrQty').value);
  const boxesRaw = document.getElementById('vrBoxes').value;
  const boxes = Number(boxesRaw);
  if(!isPositiveInt(qty)){ showErr('vrErr','Quantity must be a whole number greater than 0'); return; }
  if(boxesRaw!=='' && !isPositiveInt(boxes)){ showErr('vrErr','Boxes must be a whole number greater than 0'); return; }
  if(qty > it.eligibleQty){ showErr('vrErr',`Cannot return more than eligible (${it.eligibleQty} remaining from this purchase)`); return; }
  const avail = productStock(it.productId,'Upper');
  if(avail < qty){ showErr('vrErr',`Not enough stock in Upper Shop to return (only ${avail} available)`); return; }
  const notes = document.getElementById('vrNotes').value.trim();
  const amount = qty * it.price;
  pushLedger({type:'vendor_return', vendorId:vid, productId:it.productId, purchaseId:it.purchaseId, lineId:it.effLineId, qty, packQty:boxes>0?boxes:undefined, amount, notes:notes||undefined});
  toast('Return to vendor recorded — stock and payable reduced');
  closeModal(); renderAll();
}

/* ---- New Purchase (product-linked, increases Upper stock) ---- */
function openNewPurchase(preselectVendor){
  openModal(`
    <h3>New Purchase from Vendor</h3><div class="sub">Increases Upper Shop inventory automatically</div>
    <div class="field"><label>Vendor</label><select id="poVendor">${vendors.map(v=>`<option value="${v.id}" ${v.id===preselectVendor?'selected':''}>${v.name}</option>`).join('')}</select></div>
    <div class="field-row">
      <div class="field"><label>Date</label><input type="date" id="poDate" value="${todayISO()}"></div>
      <div class="field"><label>Invoice / Ref # (optional)</label><input id="poRef" placeholder="e.g. INV-1102"></div>
    </div>
    <div id="poLines"></div>
    <button class="btn ghost sm" onclick="addPoLine()" style="margin-bottom:12px;">+ Add Product</button>
    <div class="totalbar"><span>Total</span><span class="numeral" id="poTotal">Rs 0</span></div>
    <div class="field" style="margin-top:12px;"><label>Amount Paid Now (Rs, optional)</label><input type="number" id="poPaid" placeholder="0" oninput="updatePoTotals()"></div>
    <div class="field"><label>Notes (optional)</label><input id="poNotes"></div>
    <div id="poErr" class="err" style="display:none;"></div>
    <button class="btn amber" style="width:100%;" onclick="savePurchase()">Save Purchase</button>
  `, true);
  addPoLine();
}
function addPoLine(){
  const wrap = document.getElementById('poLines');
  const div = document.createElement('div'); div.className='line-row';
  const opts = products.filter(p=>p.active!==false);
  div.innerHTML = `
    <select onchange="poLineProductChanged(this)">${opts.map(p=>`<option value="${p.id}" data-cost="${p.cost}" data-pack="${p.packSize||1}">${p.name} — ${p.sku}${p.packSize>1?' ('+p.packSize+'/box)':''}</option>`).join('')}</select>
    <input type="number" class="poBoxes" min="0" placeholder="Boxes" oninput="poLineBoxesChanged(this)" title="Number of boxes/packs (optional)">
    <input type="number" class="poQty" value="1" min="1" oninput="updatePoTotals()" placeholder="Pieces" title="Total pieces — auto-fills from Boxes, or enter directly">
    <input type="number" oninput="updatePoTotals()" placeholder="Cost/unit" class="poCost">
    <div class="lineTotal numeral">Rs 0</div>
    <button class="rmBtn" onclick="this.parentElement.remove();updatePoTotals();">✕</button>`;
  wrap.appendChild(div);
  const sel = div.querySelector('select');
  div.querySelector('.poCost').value = sel.selectedOptions[0].dataset.cost;
  updatePoTotals();
}
function poLineProductChanged(sel){
  const line = sel.closest('.line-row');
  line.querySelector('.poCost').value = sel.selectedOptions[0].dataset.cost;
  line.querySelector('.poBoxes').value = '';
  updatePoTotals();
}
function poLineBoxesChanged(input){
  const line = input.closest('.line-row');
  const pack = Number(line.querySelector('select').selectedOptions[0].dataset.pack)||1;
  const boxes = Number(input.value)||0;
  if(boxes>0) line.querySelector('.poQty').value = boxes*pack;
  updatePoTotals();
}
function updatePoTotals(){
  let total=0;
  document.querySelectorAll('#poLines .line-row').forEach(line=>{
    const qty = Number(line.querySelector('.poQty').value)||0;
    const cost = Number(line.querySelector('.poCost').value)||0;
    const lt = qty*cost;
    line.querySelector('.lineTotal').textContent = fmt(lt);
    total += lt;
  });
  document.getElementById('poTotal').textContent = fmt(total);
}
function savePurchase(){
  const vendorId = document.getElementById('poVendor').value;
  const date = document.getElementById('poDate').value || todayISO();
  const ref = document.getElementById('poRef').value.trim();
  const lines = document.querySelectorAll('#poLines .line-row');
  if(!lines.length){ showErr('poErr','Add at least one product'); return; }
  let items=[], total=0, hasInvalidLine=false;
  lines.forEach(line=>{
    const pid = line.querySelector('select').value;
    const qty = Number(line.querySelector('.poQty').value);
    const cost = Number(line.querySelector('.poCost').value);
    const boxesRaw = line.querySelector('.poBoxes').value;
    const boxes = Number(boxesRaw);
    if(!isPositiveInt(qty) || !(cost>0)){ hasInvalidLine=true; return; }
    if(boxesRaw!=='' && !isPositiveInt(boxes)){ hasInvalidLine=true; return; }
    items.push({productId:pid, qty, price:cost, packQty:boxes>0?boxes:undefined, lineId:'L'+nextId()});
    total += qty*cost;
  });
  if(hasInvalidLine){ showErr('poErr','Every product line needs a whole-number quantity (pieces) greater than 0, a cost price greater than 0, and (if used) a whole-number box count greater than 0. Fix or remove the invalid line before saving.'); return; }
  if(!items.length){ showErr('poErr','Add at least one product line'); return; }
  const paid = Number(document.getElementById('poPaid').value)||0;
  if(paid>total){ showErr('poErr','Amount paid cannot exceed purchase total'); return; }
  const notes = document.getElementById('poNotes').value.trim();
  pushLedger({type:'vendor_purchase', vendorId, date, items, amount:total, invoiceRef:ref||undefined, notes:notes||undefined});
  if(paid>0) pushLedger({type:'vendor_payment', vendorId, date, amount:paid, notes:'Paid at time of purchase'});
  toast('Purchase recorded — Upper Shop inventory increased');
  closeModal(); renderAll();
}

/* =====================================================================
   TRANSACTION HISTORY (unified, filterable)
===================================================================== */
const TYPE_LABEL = {
  wholesale_sale:'Wholesale Sale', wholesale_recovery:'Wholesale Recovery', wholesale_return:'Wholesale Return', wholesale_discount:'Wholesale Discount',
  retail_sale:'Retail Sale', retail_payment:'Retail Payment', retail_return:'Retail Return', retail_discount:'Retail Discount',
  vendor_purchase:'Vendor Purchase', vendor_payment:'Vendor Payment', vendor_return:'Vendor Return',
  stock_transfer:'Stock Transfer', adjustment:'Stock Adjustment'
};
const TYPE_BADGE = {
  wholesale_sale:'cat', wholesale_recovery:'clear', wholesale_return:'due', wholesale_discount:'xfer',
  retail_sale:'cat', retail_payment:'clear', retail_return:'due', retail_discount:'xfer',
  vendor_purchase:'xfer', vendor_payment:'grey', vendor_return:'due',
  stock_transfer:'xfer', adjustment:'grey'
};
function historyRecords(){
  return ledger.map(e=>{
    let who='—', desc='', amt=e.amount, city='', productId='';
    if(e.type==='wholesale_sale'||e.type==='wholesale_recovery'){ const c=customers.find(x=>x.id===e.customerId); who=c?c.shop:'—'; city=c?c.city:''; desc = e.type==='wholesale_sale' ? (e.items||[]).map(it=>itemQtyLabel(it)).join(', ') : (e.notes||e.method||'Recovery payment'); if(e.items) productId=e.items.map(it=>it.productId).join(','); }
    else if(e.type==='wholesale_discount'){ const c=customers.find(x=>x.id===e.customerId); who=c?c.shop:'—'; city=c?c.city:''; desc=`Discount given${e.notes?' — '+e.notes:''}`; }
    else if(e.type==='retail_discount'){ const s=ledger.find(x=>x.id===e.saleId); who = s?s.customerName:'—'; desc=`Discount given${e.notes?' — '+e.notes:''}`; }
    else if(e.type==='wholesale_return'){ const c=customers.find(x=>x.id===e.customerId); who=c?c.shop:'—'; city=c?c.city:''; desc=`${itemQtyLabel(e)}${e.notes?' — '+e.notes:''}`; productId=e.productId; }
    else if(e.type==='retail_sale'){ who=e.customerName; desc=`[${e.shop||'Lower'} Shop] `+(e.items||[]).map(it=>productName(it.productId)+' x'+it.qty).join(', '); if(e.items) productId=e.items.map(it=>it.productId).join(','); }
    else if(e.type==='retail_payment'){ const s=ledger.find(x=>x.id===e.saleId); who = s?s.customerName:'—'; desc='Retail payment received'+(e.method?' — '+e.method:''); }
    else if(e.type==='retail_return'){ const s=ledger.find(x=>x.id===e.saleId); who = s?s.customerName:'—'; desc=`${productName(e.productId)} x${e.qty}`; productId=e.productId; }
    else if(e.type==='vendor_purchase'||e.type==='vendor_payment'){ const v=vendors.find(x=>x.id===e.vendorId); who=v?v.name:'—'; desc = e.type==='vendor_purchase' ? (e.items||[]).map(it=>itemQtyLabel(it)).join(', ') : (e.notes||e.method||'Payment made'); if(e.items) productId=e.items.map(it=>it.productId).join(','); }
    else if(e.type==='vendor_return'){ const v=vendors.find(x=>x.id===e.vendorId); who=v?v.name:'—'; desc=`${itemQtyLabel(e)}${e.notes?' — '+e.notes:''}`; productId=e.productId; }
    else if(e.type==='stock_transfer'){ who='Upper → Lower'; desc=`${productName(e.productId)} x${e.qty}${e.packQty?' ('+e.packQty+' box'+(e.packQty>1?'es':'')+')':''}${e.notes?' — '+e.notes:''}`; amt=e.qty; productId=e.productId; }
    else if(e.type==='adjustment'){ who=e.shop+' Shop'; desc=`${productName(e.productId)}${e.packQty?' x'+e.qty+' ('+e.packQty+' box'+(e.packQty>1?'es':'')+')':''} — ${e.reason||'adjustment'}${e.notes?' — '+e.notes:''}`; amt=e.qty; productId=e.productId; }
    return {...e, who, desc, amtDisplay:amt, city, productId};
  }).sort((a,b)=> b.date.localeCompare(a.date) || b.id-a.id);
}
const UPPER_HIST_TYPES = ['wholesale_sale','wholesale_recovery','wholesale_return','wholesale_discount','vendor_purchase','vendor_payment','vendor_return'];
const LOWER_HIST_TYPES = [];
const RETAIL_LINKED_TYPES = ['retail_sale','retail_payment','retail_return','retail_discount'];
function retailRecordShop(r){
  if(r.type==='retail_sale') return r.shop||'Lower';
  const sale = ledger.find(x=>x.id===r.saleId);
  return sale ? (sale.shop||'Lower') : 'Lower';
}
let _histFilterBarSection = null;
function inHistSection(r, section){
  if(RETAIL_LINKED_TYPES.includes(r.type)) return retailRecordShop(r)===section;
  if(section==='Upper'){
    if(UPPER_HIST_TYPES.includes(r.type)) return true;
    if(r.type==='stock_transfer') return true; // affects Upper stock too
    if(r.type==='adjustment' && r.shop==='Upper') return true;
    return false;
  } else {
    if(LOWER_HIST_TYPES.includes(r.type)) return true;
    if(r.type==='stock_transfer') return true; // affects Lower stock too
    if(r.type==='adjustment' && r.shop==='Lower') return true;
    return false;
  }
}
function setHistSection(s){
  ui.hist.section = s;
  ui.hist.type=''; ui.hist.city=''; ui.hist.customer=''; ui.hist.vendor=''; ui.hist.product=''; ui.hist.from=''; ui.hist.to=''; ui.hist.search='';
  renderHistory();
}
function renderHistory(){
  document.getElementById('histSectionTabs').innerHTML = ['Upper','Lower'].map(s=>
    `<button class="chip ${s===ui.hist.section?'active':''}" onclick="setHistSection('${s}')">${s==='Upper'?'🏙 Upper Shop (Wholesale + Vendors)':'🏪 Lower Shop (Retail)'}</button>`
  ).join('');

  if(_histFilterBarSection !== ui.hist.section){
    _histFilterBarSection = ui.hist.section;
    const typeOptions = ui.hist.section==='Upper'
      ? [['','All Types'],['wholesale_sale','Wholesale Sale'],['wholesale_recovery','Wholesale Recovery'],['wholesale_return','Wholesale Return'],['wholesale_discount','Wholesale Discount'],['vendor_purchase','Vendor Purchase'],['vendor_payment','Vendor Payment'],['vendor_return','Vendor Return'],['retail_sale','Counter Sale'],['retail_payment','Counter Payment'],['retail_return','Counter Return'],['retail_discount','Counter Discount'],['stock_transfer','Stock Transfer'],['adjustment','Stock Adjustment']]
      : [['','All Types'],['retail_sale','Retail Sale'],['retail_payment','Retail Payment'],['retail_return','Retail Return'],['retail_discount','Retail Discount'],['stock_transfer','Stock Transfer'],['adjustment','Stock Adjustment']];

    let extraFilters = '';
    if(ui.hist.section==='Upper'){
      extraFilters = `
        <select id="histCity" onchange="ui.hist.city=this.value;renderHistoryList()"><option value="">All Cities</option>${cities.map(c=>`<option>${c}</option>`).join('')}</select>
        <select id="histCustomer" onchange="ui.hist.customer=this.value;renderHistoryList()"><option value="">All Wholesale Shops</option>${customers.map(c=>`<option value="${c.id}">${c.shop}</option>`).join('')}</select>
        <select id="histVendor" onchange="ui.hist.vendor=this.value;renderHistoryList()"><option value="">All Vendors</option>${vendors.map(v=>`<option value="${v.id}">${v.name}</option>`).join('')}</select>`;
    }

    document.getElementById('histFilterBar').innerHTML = `
      <select id="histType" onchange="ui.hist.type=this.value;renderHistoryList()">${typeOptions.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select>
      ${extraFilters}
      <select id="histProduct" onchange="ui.hist.product=this.value;renderHistoryList()"><option value="">All Products</option>${products.map(p=>`<option value="${p.id}">${p.name} (${p.sku})</option>`).join('')}</select>
      <input type="date" id="histFrom" onchange="ui.hist.from=this.value;renderHistoryList()">
      <input type="date" id="histTo" onchange="ui.hist.to=this.value;renderHistoryList()">
      <input type="text" id="histSearch" placeholder="Search..." oninput="ui.hist.search=this.value;renderHistoryList()" style="flex:1;min-width:140px;">
    `;
  }
  renderHistoryList();
}
function renderHistoryList(){
  let records = historyRecords().filter(r=>inHistSection(r, ui.hist.section));
  if(ui.hist.type) records = records.filter(r=>r.type===ui.hist.type);
  if(ui.hist.city) records = records.filter(r=>r.city===ui.hist.city);
  if(ui.hist.customer) records = records.filter(r=>r.customerId===ui.hist.customer);
  if(ui.hist.vendor) records = records.filter(r=>r.vendorId===ui.hist.vendor);
  if(ui.hist.product) records = records.filter(r=>(r.productId||'').split(',').includes(ui.hist.product));
  if(ui.hist.from) records = records.filter(r=>r.date>=ui.hist.from);
  if(ui.hist.to) records = records.filter(r=>r.date<=ui.hist.to);
  if(ui.hist.search){ const q=ui.hist.search.toLowerCase(); records = records.filter(r=>(r.who+' '+r.desc).toLowerCase().includes(q)); }

  document.getElementById('histCount').textContent = `(${records.length})`;
  document.getElementById('histList').innerHTML = records.map(r=>{
    let onclick = '';
    if(r.saleId) onclick = `openRetailSaleDetail(${r.saleId})`;
    else if(r.type==='retail_sale') onclick = `openRetailSaleDetail(${r.id})`;
    else if(r.customerId) onclick = `openShopDetail('${r.customerId}')`;
    else if(r.vendorId) onclick = `openVendorDetail('${r.vendorId}')`;
    const clickable = onclick ? 'clickable' : '';
    return `
    <div class="ledger-row ${clickable}" ${onclick?`onclick="${onclick}"`:''}>
      <div class="lr-main"><div class="title">${r.who} <span class="badge ${TYPE_BADGE[r.type]}" style="margin-left:6px;">${TYPE_LABEL[r.type]}</span></div><div class="meta">${r.desc} · ${r.date}${r.time?' '+r.time:''}${r.invoiceRef?' · '+r.invoiceRef:''}</div></div>
      <div class="lr-right"><div class="amt">${(r.type==='stock_transfer'||r.type==='adjustment') ? r.amtDisplay+' '+(products.find(p=>p.id===r.productId)?.unit||'units') : fmt(r.amtDisplay)}</div></div>
    </div>`;
  }).join('') || `<div class="empty">No records match these filters</div>`;
}

/* =====================================================================
   REPORTS / EXPORT
===================================================================== */
function inRange(dateStr, from, to){
  if(from && dateStr<from) return false;
  if(to && dateStr>to) return false;
  return true;
}
function setRepRange(kind){
  const now = new Date();
  let from, to = todayISO();
  if(kind==='today'){ from = todayISO(); }
  else if(kind==='week'){ const d = new Date(now); d.setDate(d.getDate()-d.getDay()); from = d.toISOString().slice(0,10); }
  else if(kind==='month'){ from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10); }
  document.getElementById('repFrom').value = from;
  document.getElementById('repTo').value = to;
  renderReportSummary();
}
function renderReportSummary(){
  const from = document.getElementById('repFrom').value;
  const to = document.getElementById('repTo').value;
  const inR = e => inRange(e.date, from, to);
  const totalSales = ledger.filter(e=>(e.type==='retail_sale'||e.type==='wholesale_sale') && inR(e)).reduce((s,e)=>s+e.amount,0);
  const totalRecoveries = ledger.filter(e=>e.type==='wholesale_recovery' && inR(e)).reduce((s,e)=>s+e.amount,0);
  const totalPurchases = ledger.filter(e=>e.type==='vendor_purchase' && inR(e)).reduce((s,e)=>s+e.amount,0);
  const totalVendorPayments = ledger.filter(e=>e.type==='vendor_payment' && inR(e)).reduce((s,e)=>s+e.amount,0);
  const totalOutstanding = customers.reduce((s,c)=>s+customerBalance(c.id),0);
  const totalPayable = vendors.reduce((s,v)=>s+vendorBalance(v.id),0);
  let currentStock = 0; products.forEach(p=>['Upper','Lower'].forEach(sh=>currentStock+=productStock(p.id,sh)));
  document.getElementById('repSummaryGrid').innerHTML = `
    <div class="stat green"><div class="label">Total Sales${from||to?' (range)':''}</div><div class="val numeral">${fmt(totalSales)}</div></div>
    <div class="stat amber"><div class="label">Total Recoveries${from||to?' (range)':''}</div><div class="val numeral">${fmt(totalRecoveries)}</div></div>
    <div class="stat violet"><div class="label">Total Purchases${from||to?' (range)':''}</div><div class="val numeral">${fmt(totalPurchases)}</div></div>
    <div class="stat"><div class="label">Total Vendor Payments${from||to?' (range)':''}</div><div class="val numeral">${fmt(totalVendorPayments)}</div></div>
    <div class="stat brick"><div class="label">Wholesale Outstanding (now)</div><div class="val numeral">${fmt(totalOutstanding)}</div></div>
    <div class="stat brick"><div class="label">Vendor Payable (now)</div><div class="val numeral">${fmt(totalPayable)}</div></div>
    <div class="stat"><div class="label">Current Stock Units (now)</div><div class="val numeral">${currentStock}</div></div>`;
}
function downloadCSV(filename, rows){
  // kept for compatibility — now redirects to a proper single-sheet Excel file
  downloadXLSX(filename.replace(/\.csv$/,'.xlsx'), [{name:'Sheet1', rows}]);
}
function autoColWidths(rows){
  const widths = [];
  rows.forEach(row=>{
    row.forEach((cell,i)=>{
      const len = String(cell==null?'':cell).length;
      widths[i] = Math.max(widths[i]||8, Math.min(len+2, 42));
    });
  });
  return widths.map(w=>({wch:w}));
}
function downloadXLSX(filename, sheets){
  const wb = XLSX.utils.book_new();
  sheets.forEach(sheet=>{
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    ws['!cols'] = sheet.colWidths || autoColWidths(sheet.rows);
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0,31));
  });
  XLSX.writeFile(wb, filename);
}
function exportShopData(cid){
  const sh = customers.find(x=>x.id===cid); if(!sh) return;
  const rows = customerLedgerRows(cid);
  const bal = customerBalance(cid);

  const infoRows = [
    ['Shop Name', sh.shop], ['Owner Name', sh.owner], ['Phone', sh.phone], ['Address', sh.address||''],
    ['City', sh.city], ['Credit Limit', sh.creditLimit||0],
    ['Total Supplied', rows.filter(r=>r.debit).reduce((s,r)=>s+r.debit,0)],
    ['Total Recovered/Credited', rows.filter(r=>r.credit).reduce((s,r)=>s+r.credit,0)],
    ['Current Outstanding Balance', bal]
  ];

  const ledgerRows = [['Date','Description','Debit','Credit','Balance']];
  rows.forEach(r=>ledgerRows.push([r.date, r.desc.replace(/<[^>]*>/g,''), r.debit||'', r.credit||'', r.balance]));

  const itemRows = [['Date','Invoice/Reference','Product','SKU','Boxes','Quantity (Pieces)','Price','Amount']];
  ledger.filter(e=>e.type==='wholesale_sale' && e.customerId===cid).sort((a,b)=>a.date.localeCompare(b.date)||a.id-b.id).forEach(e=>{
    e.items.forEach(it=>{
      const p = products.find(x=>x.id===it.productId);
      const boxes = it.packQty!=null ? it.packQty : boxesDisplay(it.qty,p);
      itemRows.push([e.date, e.invoiceRef||'', p?p.name:'', p?p.sku:'', boxes, it.qty, it.price, it.qty*it.price]);
    });
  });

  downloadXLSX(`capital-hg-${sh.shop.replace(/[^a-z0-9]+/gi,'-')}-${todayISO()}.xlsx`, [
    {name:'Shop Info', rows:infoRows},
    {name:'Ledger', rows:ledgerRows},
    {name:'Items Purchased', rows:itemRows}
  ]);
  toast(`${sh.shop} data exported`);
}
function exportVendorData(vid){
  const v = vendors.find(x=>x.id===vid); if(!v) return;
  const rows = vendorLedgerRows(vid);
  const bal = vendorBalance(vid);

  const infoRows = [
    ['Vendor Name', v.name], ['Contact Person', v.contact||''], ['Phone', v.phone||''], ['Address', v.address||''],
    ['Total Purchased', rows.filter(r=>r.debit).reduce((s,r)=>s+r.debit,0)],
    ['Total Paid', rows.filter(r=>r.credit).reduce((s,r)=>s+r.credit,0)],
    ['Current Payable Balance', bal]
  ];

  const ledgerRows = [['Date','Description','Debit','Credit','Balance']];
  rows.forEach(r=>ledgerRows.push([r.date, r.desc.replace(/<[^>]*>/g,''), r.debit||'', r.credit||'', r.balance]));

  const itemRows = [['Date','Invoice/Reference','Product','SKU','Boxes','Quantity (Pieces)','Cost/pc','Amount']];
  ledger.filter(e=>e.type==='vendor_purchase' && e.vendorId===vid).sort((a,b)=>a.date.localeCompare(b.date)||a.id-b.id).forEach(e=>{
    e.items.forEach(it=>{
      const p = products.find(x=>x.id===it.productId);
      const boxes = it.packQty!=null ? it.packQty : boxesDisplay(it.qty,p);
      itemRows.push([e.date, e.invoiceRef||'', p?p.name:'', p?p.sku:'', boxes, it.qty, it.price, it.qty*it.price]);
    });
  });

  downloadXLSX(`capital-hg-${v.name.replace(/[^a-z0-9]+/gi,'-')}-${todayISO()}.xlsx`, [
    {name:'Vendor Info', rows:infoRows},
    {name:'Ledger', rows:ledgerRows},
    {name:'Items Purchased', rows:itemRows}
  ]);
  toast(`${v.name} data exported`);
}
function exportCityData(){
  const city = ui.activeCity;
  const shopsInCity = customers.filter(c=>c.city===city);

  const summaryRows = [['Shop Name','Owner Name','Phone','Address','City','Credit Limit','Total Supplied','Total Recovered','Outstanding Balance']];
  shopsInCity.forEach(c=>{
    const rws = customerLedgerRows(c.id);
    summaryRows.push([c.shop, c.owner, c.phone, c.address||'', c.city, c.creditLimit||0, rws.reduce((s,r)=>s+r.debit,0), rws.reduce((s,r)=>s+r.credit,0), customerBalance(c.id)]);
  });

  const txnRows = [['Date','Invoice/Reference','City','Shop','Product','SKU','Boxes','Quantity (Pieces)','Price','Amount','Transaction Type']];
  const shopIds = shopsInCity.map(c=>c.id);
  ledger.filter(e=>['wholesale_sale','wholesale_recovery','wholesale_return','wholesale_discount'].includes(e.type) && shopIds.includes(e.customerId))
    .sort((a,b)=>a.date.localeCompare(b.date)||a.id-b.id)
    .forEach(e=>{
      const c = customers.find(x=>x.id===e.customerId);
      if(e.type==='wholesale_sale'){
        e.items.forEach(it=>{
          const p = products.find(x=>x.id===it.productId);
          txnRows.push([e.date, e.invoiceRef||'', city, c.shop, p?p.name:'', p?p.sku:'', it.packQty!=null?it.packQty:boxesDisplay(it.qty,p), it.qty, it.price, it.qty*it.price, 'Wholesale Sale']);
        });
      } else if(e.type==='wholesale_return'){
        const p = products.find(x=>x.id===e.productId);
        const price = e.qty ? (e.amount/e.qty) : '';
        txnRows.push([e.date, '', city, c.shop, p?p.name:'', p?p.sku:'', e.packQty!=null?e.packQty:boxesDisplay(e.qty,p), e.qty, price, e.amount, 'Wholesale Return']);
      } else if(e.type==='wholesale_recovery'){
        txnRows.push([e.date, '', city, c.shop, '', '', '', '', '', e.amount, 'Wholesale Recovery']);
      } else if(e.type==='wholesale_discount'){
        txnRows.push([e.date, '', city, c.shop, '', '', '', '', '', e.amount, 'Wholesale Discount']);
      }
    });

  downloadXLSX(`capital-hg-${city}-${todayISO()}.xlsx`, [
    {name:'Shop Summary', rows:summaryRows},
    {name:'Transactions', rows:txnRows}
  ]);
  toast(`${city} data exported`);
}
function exportReport(kind){
  const from = document.getElementById('repFrom').value;
  const to = document.getElementById('repTo').value;
  let rows = [];
  if(kind==='retail'){
    rows = [['Date','Time','Customer','Items','Amount','Paid (Cash)','Discount','Returned','Due']];
    ledger.filter(e=>e.type==='retail_sale' && inRange(e.date,from,to)).forEach(e=>{
      rows.push([e.date, e.time||'', e.customerName, e.items.map(it=>productName(it.productId)+' x'+it.qty).join('; '), e.amount, retailSalePaidTotal(e), retailSaleDiscounts(e), retailSaleReturnsTotal(e), retailSaleDue(e)]);
    });
  } else if(kind==='wholesale'){
    rows = [['Date','City','Shop','Owner','Invoice Ref','Product','SKU','Boxes','Quantity (Pieces)','Price/pc','Line Amount']];
    ledger.filter(e=>e.type==='wholesale_sale' && inRange(e.date,from,to)).forEach(e=>{
      const c = customers.find(x=>x.id===e.customerId);
      e.items.forEach(it=>{
        const p = products.find(x=>x.id===it.productId);
        const boxes = it.packQty!=null ? it.packQty : boxesDisplay(it.qty,p);
        rows.push([e.date, c?c.city:'', c?c.shop:'', c?c.owner:'', e.invoiceRef||'', p?p.name:'', p?p.sku:'', boxes, it.qty, it.price, it.qty*it.price]);
      });
    });
  } else if(kind==='recovery'){
    rows = [['Date','City','Shop','Amount','Method','Notes']];
    ledger.filter(e=>e.type==='wholesale_recovery' && inRange(e.date,from,to)).forEach(e=>{
      const c = customers.find(x=>x.id===e.customerId);
      rows.push([e.date, c?c.city:'', c?c.shop:'', e.amount, e.method||'', e.notes||'']);
    });
  } else if(kind==='customerOutstanding'){
    rows = [['City','Shop','Owner','Phone','Total Supplied','Total Recovered','Outstanding Balance']];
    customers.forEach(c=>{
      const rws = customerLedgerRows(c.id);
      rows.push([c.city, c.shop, c.owner, c.phone, rws.reduce((s,r)=>s+r.debit,0), rws.reduce((s,r)=>s+r.credit,0), customerBalance(c.id)]);
    });
  } else if(kind==='vendorPurchase'){
    rows = [['Date','Vendor','Invoice Ref','Product','SKU','Boxes','Quantity (Pieces)','Cost/pc','Line Amount']];
    ledger.filter(e=>e.type==='vendor_purchase' && inRange(e.date,from,to)).forEach(e=>{
      const v = vendors.find(x=>x.id===e.vendorId);
      e.items.forEach(it=>{
        const p = products.find(x=>x.id===it.productId);
        const boxes = it.packQty!=null ? it.packQty : boxesDisplay(it.qty,p);
        rows.push([e.date, v?v.name:'', e.invoiceRef||'', p?p.name:'', p?p.sku:'', boxes, it.qty, it.price, it.qty*it.price]);
      });
    });
  } else if(kind==='vendorPayable'){
    rows = [['Vendor','Contact','Phone','Total Purchased','Total Paid','Payable Balance']];
    vendors.forEach(v=>{
      const rws = vendorLedgerRows(v.id);
      rows.push([v.name, v.contact, v.phone, rws.reduce((s,r)=>s+r.debit,0), rws.reduce((s,r)=>s+r.credit,0), vendorBalance(v.id)]);
    });
  } else if(kind==='inventory'){
    rows = [['SKU','Product','Category','Season','Shop','Cost','Wholesale','Retail','Pack Size','Current Stock (Pieces)','Boxes (approx)','Min Stock']];
    products.forEach(p=>{ ['Upper','Lower'].forEach(shop=>{
      const stock = productStock(p.id,shop);
      rows.push([p.sku, p.name, p.category, p.season, shop, p.cost, p.wsale, p.retail, p.packSize||1, stock, boxesDisplay(stock,p), p.minStock]);
    }); });
  } else if(kind==='stockMovement'){
    rows = [['Date','Product','SKU','Category','Season','Quantity (Pieces)','Boxes','From','To','Notes']];
    ledger.filter(e=>e.type==='stock_transfer' && inRange(e.date,from,to)).forEach(e=>{
      const p = products.find(x=>x.id===e.productId);
      rows.push([e.date, p?p.name:'', p?p.sku:'', p?p.category:'', p?p.season:'', e.qty, e.packQty||'', 'Upper Shop', 'Lower Shop', e.notes||'']);
    });
  } else if(kind==='productSales'){
    rows = [['SKU','Product','Category','Season','Qty Sold (Retail)','Revenue (Retail)','Qty Sold (Wholesale)','Revenue (Wholesale)']];
    products.forEach(p=>{
      let rQty=0, rRev=0, wQty=0, wRev=0;
      ledger.filter(e=>e.type==='retail_sale' && inRange(e.date,from,to)).forEach(e=>e.items.forEach(it=>{ if(it.productId===p.id){ rQty+=it.qty; rRev+=it.qty*it.price; } }));
      ledger.filter(e=>e.type==='wholesale_sale' && inRange(e.date,from,to)).forEach(e=>e.items.forEach(it=>{ if(it.productId===p.id){ wQty+=it.qty; wRev+=it.qty*it.price; } }));
      if(rQty||wQty) rows.push([p.sku, p.name, p.category, p.season, rQty, rRev, wQty, wRev]);
    });
  } else if(kind==='profitMargin'){
    rows = [['SKU','Product','Category','Season','Cost/pc','Retail Price','Wholesale Price','Retail Qty Sold (net of returns)','Retail Profit','Wholesale Qty Sold (net of returns)','Wholesale Profit','Total Profit']];
    let grandTotal = 0;
    products.forEach(p=>{
      let rQty=0, rRev=0, wQty=0, wRev=0;
      ledger.filter(e=>e.type==='retail_sale' && inRange(e.date,from,to)).forEach(e=>e.items.forEach(it=>{ if(it.productId===p.id){ rQty+=it.qty; rRev+=it.qty*it.price; } }));
      ledger.filter(e=>e.type==='retail_return' && inRange(e.date,from,to) && e.productId===p.id).forEach(e=>{ rQty-=e.qty; rRev-=e.amount; });
      ledger.filter(e=>e.type==='wholesale_sale' && inRange(e.date,from,to)).forEach(e=>e.items.forEach(it=>{ if(it.productId===p.id){ wQty+=it.qty; wRev+=it.qty*it.price; } }));
      ledger.filter(e=>e.type==='wholesale_return' && inRange(e.date,from,to) && e.productId===p.id).forEach(e=>{ wQty-=e.qty; wRev-=e.amount; });
      if(rQty||wQty){
        const rProfit = rRev - rQty*p.cost;
        const wProfit = wRev - wQty*p.cost;
        grandTotal += rProfit + wProfit;
        rows.push([p.sku, p.name, p.category, p.season, p.cost, p.retail, p.wsale, rQty, rProfit, wQty, wProfit, rProfit+wProfit]);
      }
    });
    const discToday = ledger.filter(e=>(e.type==='retail_discount'||e.type==='wholesale_discount') && inRange(e.date,from,to)).reduce((s,e)=>s+e.amount,0);
    rows.push([]);
    rows.push(['TOTAL PROFIT (before discounts given)', '', '', '', '', '', '', '', '', '', '', grandTotal]);
    rows.push(['Less: Total Discounts Given (not attributed per-product above)', '', '', '', '', '', '', '', '', '', '', -discToday]);
    rows.push(['NET PROFIT (after discounts)', '', '', '', '', '', '', '', '', '', '', grandTotal-discToday]);
  } else if(kind==='all'){
    rows = [['Date','Type','City','Who','Description','Amount (Rs)','Quantity (units)','Reference']];
    const QTY_TYPES = ['stock_transfer','adjustment'];
    historyRecords().filter(r=>inRange(r.date,from,to)).forEach(r=>{
      const isQty = QTY_TYPES.includes(r.type);
      rows.push([r.date, TYPE_LABEL[r.type], r.city||'', r.who, r.desc, isQty?'':r.amtDisplay, isQty?r.amtDisplay:'', r.invoiceRef||'']);
    });
  }
  const REPORT_SHEET_NAMES = {
    retail:'Retail Sales', wholesale:'Wholesale Sales', recovery:'Recoveries', customerOutstanding:'Customer Outstanding',
    vendorPurchase:'Vendor Purchases', vendorPayable:'Vendor Payable', inventory:'Inventory', stockMovement:'Stock Movement',
    productSales:'Product Sales', profitMargin:'Profit and Margin', all:'Full Transaction Log'
  };
  downloadXLSX(`capital-hg-${kind}-${todayISO()}.xlsx`, [{name: REPORT_SHEET_NAMES[kind]||'Report', rows}]);
  toast('Report exported — check your downloads');
}

/* =====================================================================
   PRINTABLE RECEIPTS / STATEMENTS
===================================================================== */
function printWindow(title, bodyHtml){
  const w = window.open('', '_blank', 'width=650,height=800');
  w.document.write(`<!DOCTYPE html><html><head><title>${title}</title><style>
    body{font-family:Arial,sans-serif;padding:28px;color:#222;}
    h1{font-size:19px;margin-bottom:2px;} .sub{color:#666;font-size:12.5px;margin-bottom:18px;}
    table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13px;}
    th,td{border-bottom:1px solid #ddd;padding:7px 8px;text-align:left;}
    th{background:#f5f5f0;font-size:11px;text-transform:uppercase;color:#666;}
    .tot{font-weight:700;font-size:15px;margin-top:6px;text-align:right;}
    .brand{font-weight:700;font-size:16px;margin-bottom:14px;}
  </style></head><body>${bodyHtml}
  <script>window.onload=()=>window.print();<\/script></body></html>`);
  w.document.close();
}
function printReceipt(kind, id){
  if(kind==='retail'){
    const e = ledger.find(x=>x.id===id);
    const due = retailSaleDue(e), paid = retailSalePaidTotal(e), disc = retailSaleDiscounts(e), ret = retailSaleReturnsTotal(e);
    printWindow('Retail Receipt', `
      <div class="brand">Capital Hosiery & Garments — Lower Shop (Retail)</div>
      <h1>Receipt</h1><div class="sub">${e.customerName} · ${e.date} ${e.time||''}</div>
      <table><thead><tr><th>Product</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>
      ${e.items.map(it=>`<tr><td>${productName(it.productId)}</td><td>${it.qty}</td><td>${fmt(it.price)}</td><td>${fmt(it.price*it.qty)}</td></tr>`).join('')}
      </tbody></table>
      <div class="tot">Total: ${fmt(e.amount)}<br>Paid: ${fmt(paid)}${disc>0?'<br>Discount: '+fmt(disc):''}${ret>0?'<br>Returned: '+fmt(ret):''}<br>Due: ${fmt(due)}</div>`);
  } else if(kind==='wholesale'){
    const c = customers.find(x=>x.id===id);
    const rows = customerLedgerRows(id);
    printWindow('Wholesale Statement', `
      <div class="brand">Capital Hosiery & Garments — Upper Shop (Wholesale)</div>
      <h1>Account Statement — ${c.shop}</h1><div class="sub">${c.owner} · ${c.city} · ${c.phone}</div>
      <table><thead><tr><th>Date</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody>
      ${rows.map(r=>`<tr><td>${r.date}</td><td>${r.desc}${r.ref&&r.ref.type==='wholesale_sale'?'<br><span style="font-size:11px;color:#777;">'+r.ref.items.map(it=>itemQtyLabel(it)).join(', ')+'</span>':''}</td><td>${r.debit?fmt(r.debit):''}</td><td>${r.credit?fmt(r.credit):''}</td><td>${fmt(r.balance)}</td></tr>`).join('')}
      </tbody></table>
      <div class="tot">Current Balance: ${fmt(customerBalance(id))}</div>`);
  } else if(kind==='vendor'){
    const v = vendors.find(x=>x.id===id);
    const rows = vendorLedgerRows(id);
    printWindow('Vendor Statement', `
      <div class="brand">Capital Hosiery & Garments — Vendor Account</div>
      <h1>Account Statement — ${v.name}</h1><div class="sub">${v.contact} · ${v.phone}</div>
      <table><thead><tr><th>Date</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody>
      ${rows.map(r=>`<tr><td>${r.date}</td><td>${r.desc}${r.ref&&r.ref.type==='vendor_purchase'?'<br><span style="font-size:11px;color:#777;">'+r.ref.items.map(it=>itemQtyLabel(it)).join(', ')+'</span>':''}</td><td>${r.debit?fmt(r.debit):''}</td><td>${r.credit?fmt(r.credit):''}</td><td>${fmt(r.balance)}</td></tr>`).join('')}
      </tbody></table>
      <div class="tot">Current Payable: ${fmt(vendorBalance(id))}</div>`);
  }
}
function openVendorPurchaseItems(purchaseId){
  const e = ledger.find(x=>x.id===purchaseId && x.type==='vendor_purchase'); if(!e) return;
  const v = vendors.find(x=>x.id===e.vendorId);
  openModal(`
    <h3>Items Purchased</h3><div class="sub">${v?v.name:''} · ${e.date}${e.invoiceRef?' · '+e.invoiceRef:''}</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Product</th><th>SKU</th><th>Boxes</th><th>Pieces</th><th>Cost/pc</th><th>Line Total</th></tr></thead>
      <tbody>
        ${e.items.map(it=>{
          const p = products.find(x=>x.id===it.productId);
          const boxes = it.packQty!=null ? it.packQty : boxesDisplay(it.qty, p);
          return `<tr><td>${p?p.name:'—'}</td><td class="numeral" style="color:var(--muted);font-size:12px;">${p?p.sku:''}</td><td class="numeral">${boxes}</td><td class="numeral">${it.qty}</td><td class="numeral">${fmt(it.price)}</td><td class="numeral">${fmt(it.price*it.qty)}</td></tr>`;
        }).join('')}
      </tbody>
    </table></div>
    <div class="totalbar"><span>Total</span><span class="numeral">${fmt(e.amount)}</span></div>
    <button class="btn ghost" style="width:100%;margin-top:14px;" onclick="closeModal()">Close</button>
  `);
}
function printPurchaseInvoice(purchaseId){
  const e = ledger.find(x=>x.id===purchaseId && x.type==='vendor_purchase'); if(!e) return;
  const v = vendors.find(x=>x.id===e.vendorId);
  printWindow('Purchase Invoice', `
    <div class="brand">Capital Hosiery & Garments — Purchase Invoice</div>
    <h1>${e.invoiceRef || 'Purchase #'+e.id}</h1><div class="sub">Vendor: ${v?v.name:'—'} · ${e.date}</div>
    <table><thead><tr><th>Product</th><th>Boxes</th><th>Pieces</th><th>Cost/Unit</th><th>Line Total</th></tr></thead><tbody>
    ${e.items.map(it=>{
      const p = products.find(x=>x.id===it.productId);
      const boxes = it.packQty!=null ? it.packQty : boxesDisplay(it.qty,p);
      return `<tr><td>${productName(it.productId)}</td><td>${boxes}</td><td>${it.qty}</td><td>${fmt(it.price)}</td><td>${fmt(it.price*it.qty)}</td></tr>`;
    }).join('')}
    </tbody></table>
    <div class="tot">Purchase Total: ${fmt(e.amount)}</div>
    ${e.notes?`<div class="sub" style="margin-top:8px;">Notes: ${e.notes}</div>`:''}`);
}

/* =====================================================================
   RENDER ALL
===================================================================== */
function renderAll(){
  renderDashboard(); renderUpper(); renderLower(); renderInventory(); renderVendors(); renderHistory();
  if(document.getElementById('repSummaryGrid')) renderReportSummary();
  if(dataDirty) schedulePersist();
}
document.addEventListener('DOMContentLoaded', initAuth);
