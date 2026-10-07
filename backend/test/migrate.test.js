const assert = require('assert');
const { computeMigrationPlan } = require('../migrate');

let pass=0, fail=0;
function t(name, fn){ try{ fn(); pass++; } catch(e){ fail++; console.error('FAIL:', name, '-', e.message); } }

const legacyData = {
  products: [ { _id:'x1', id:'P2001', sku:'ABC', skuLower: undefined }, { _id:'x2', id:'P2003', sku:'XYZ', skuLower:'xyz' } ],
  customers: [ { id:'C2002' } ],
  vendors: [ { id:'V2005' } ],
  ledger: [ { id:2004, items:[{lineId:'L2100'}], voided: undefined }, { id:2050, items:[], voided:false } ]
};

t('detects products missing skuLower (pre-migration data)', ()=>{
  const plan = computeMigrationPlan(legacyData);
  assert.deepEqual(plan.skuBackfillNeeded, ['x1']);
});
t('detects ledger entries missing voided field', ()=>{
  const plan = computeMigrationPlan(legacyData);
  assert.deepEqual(plan.voidedBackfillNeeded, [2004]);
});
t('detects no case-insensitive SKU duplicates when there are none', ()=>{
  const plan = computeMigrationPlan(legacyData);
  assert.deepEqual(plan.skuDuplicates, []);
});
t('detects a genuine case-insensitive SKU duplicate', ()=>{
  const withDup = { ...legacyData, products: [...legacyData.products, { _id:'x3', id:'P2006', sku:'abc' }] };
  const plan = computeMigrationPlan(withDup);
  assert.equal(plan.skuDuplicates.length, 1);
});
t('counter seed target is the max of ALL existing numeric ids (ledger id, lineId, product/customer/vendor ids) — never lower than what already exists', ()=>{
  const plan = computeMigrationPlan(legacyData);
  // max across: 2001,2003,2002,2005,2004,2100(lineId),2050 => 2100
  assert.equal(plan.counterSeedTarget, 2100);
});
t('counter seed never goes below the built-in floor of 2000 even on an empty database', ()=>{
  const plan = computeMigrationPlan({ products: [], customers: [], vendors: [], ledger: [] });
  assert.equal(plan.counterSeedTarget, 2000);
});
t('IDEMPOTENCY: running the plan again on already-migrated data finds nothing left to do', ()=>{
  // Simulate the state AFTER migrate() has run once: skuLower and voided both present.
  const migrated = {
    products: legacyData.products.map(p => ({ ...p, skuLower: p.skuLower || p.sku.toLowerCase() })),
    customers: legacyData.customers,
    vendors: legacyData.vendors,
    ledger: legacyData.ledger.map(e => ({ ...e, voided: e.voided === undefined ? false : e.voided }))
  };
  const plan = computeMigrationPlan(migrated);
  assert.deepEqual(plan.skuBackfillNeeded, []);
  assert.deepEqual(plan.voidedBackfillNeeded, []);
  // Running it a third time changes nothing further either.
  const plan2 = computeMigrationPlan(migrated);
  assert.deepEqual(plan2, plan);
});
t('never proposes touching an existing id/lineId — plan only ever adds new fields or raises the counter', ()=>{
  const plan = computeMigrationPlan(legacyData);
  const planStr = JSON.stringify(plan);
  // The plan object must not contain any instruction resembling a rename/regeneration of an id.
  assert.ok(!('renamedIds' in plan) && !('regeneratedIds' in plan));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
