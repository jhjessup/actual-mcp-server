// tests/unit/transactions_raw_synced_data.test.js
//
// actual_transactions_get and actual_transactions_filter omit each row's raw_synced_data (the
// bank feed's original record) by default, including from split children, and keep it when the
// caller passes includeRawSyncedData:true. The shared helper lives in
// src/lib/transaction-fields.ts; actual_transactions_uncategorized has its own Case 18.
//
// Run: node tests/unit/transactions_raw_synced_data.test.js

process.env.ACTUAL_SERVER_URL = process.env.ACTUAL_SERVER_URL ?? 'http://localhost:5006';
process.env.ACTUAL_BUDGET_SYNC_ID = process.env.ACTUAL_BUDGET_SYNC_ID ?? '00000000-0000-0000-0000-000000000000';
process.env.ACTUAL_PASSWORD = process.env.ACTUAL_PASSWORD ?? 'stub-password-for-unit-test';

console.log('Running raw_synced_data omission unit tests (transactions_get, transactions_filter)');

(async () => {
  const ACCOUNT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
  const RAW = '{"payee":"ACME STORE #123","transactionId":"bank-1"}';
  const CHILD_RAW = '{"transactionId":"bank-1-child"}';

  const apiMod = await import('@actual-app/api');
  const api = apiMod.default || apiMod;
  api.init = async () => {};
  api.shutdown = async () => {};
  api.sync = async () => {};
  api.downloadBudget = async () => {};
  api.getBudgetMonths = async () => ['2026-01'];
  api.getAccounts = async () => [{ id: ACCOUNT_A, name: 'Checking', offbudget: false, closed: false }];

  const rows = () => [
    { id: 't-raw', account: ACCOUNT_A, amount: -700, imported_payee: 'ACME STORE #123', raw_synced_data: RAW, subtransactions: [] },
    { id: 't-plain', account: ACCOUNT_A, amount: -100 },
    {
      id: 't-split', account: ACCOUNT_A, amount: -300, is_parent: true, raw_synced_data: RAW,
      subtransactions: [{ id: 't-child', account: ACCOUNT_A, amount: -300, parent_id: 't-split', raw_synced_data: CHILD_RAW }],
    },
  ];
  let served;
  api.getTransactions = async () => { served = rows(); return served; };

  const apiState = await import('../../dist/src/lib/apiState.js');
  apiState.setApiInitialized(true);
  apiState.setLoadedBudgetSyncId(process.env.ACTUAL_BUDGET_SYNC_ID);

  const load = async (name) => {
    const mod = await import(`../../dist/src/tools/${name}.js`);
    return mod.default?.default ?? mod.default;
  };
  const tools = {
    actual_transactions_get: await load('transactions_get'),
    actual_transactions_filter: await load('transactions_filter'),
  };

  let failures = 0;
  const fail = (msg) => { console.error('  FAIL:', msg); failures++; };
  const ok = (msg) => console.log('  ✓', msg);
  const hasRawAnywhere = (list) => JSON.stringify(list).includes('raw_synced_data');

  for (const [name, tool] of Object.entries(tools)) {
    console.log(`\n[${name}] default omits raw_synced_data`);
    try {
      const res = await tool.call({});
      const list = res?.result;
      if (!Array.isArray(list) || list.length !== 3) fail(`expected 3 rows, got ${JSON.stringify(list)}`);
      else ok('all rows returned');
      if (hasRawAnywhere(list)) fail('raw_synced_data present in default response');
      else ok('raw_synced_data absent from rows and split children');
      const raw = list?.find((t) => t.id === 't-raw');
      if (raw?.imported_payee !== 'ACME STORE #123') fail('other fields must be kept');
      else ok('other fields kept');
      const child = list?.find((t) => t.id === 't-split')?.subtransactions?.[0];
      if (child?.id !== 't-child' || child?.amount !== -300) fail('split child fields must be kept');
      else ok('split child kept without raw_synced_data');
      if (served[0].raw_synced_data !== RAW || served[2].subtransactions[0].raw_synced_data !== CHILD_RAW) fail('input rows were mutated');
      else ok('adapter rows not mutated');
      if (!tool.description.includes('includeRawSyncedData')) fail('description must mention includeRawSyncedData');
      else ok('description mentions includeRawSyncedData');
    } catch (e) {
      fail(`unexpected error: ${e && e.message}`);
    }

    console.log(`\n[${name}] includeRawSyncedData:true keeps raw_synced_data`);
    try {
      const res = await tool.call({ includeRawSyncedData: true });
      const list = res?.result;
      if (list?.find((t) => t.id === 't-raw')?.raw_synced_data !== RAW) fail('row raw_synced_data must be kept on opt-in');
      else ok('row raw_synced_data kept');
      if (list?.find((t) => t.id === 't-split')?.subtransactions?.[0]?.raw_synced_data !== CHILD_RAW) fail('child raw_synced_data must be kept on opt-in');
      else ok('child raw_synced_data kept');
    } catch (e) {
      fail(`unexpected error: ${e && e.message}`);
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(`${failures} raw_synced_data test(s) FAILED`);
    process.exit(2);
  }
  console.log('All raw_synced_data omission tests passed');
  process.exit(0);
})();
