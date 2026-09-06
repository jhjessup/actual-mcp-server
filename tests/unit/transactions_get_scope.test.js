// tests/unit/transactions_get_scope.test.js
//
// actual_transactions_get's `accountId` has always been optional (see InputSchema in
// src/tools/transactions_get.ts), and omitting it has always returned every account's
// transactions for the date range together -- but the tool's description used to read
// "Get all transactions for a specific account within a date range", which reads as accountId
// being expected. A caller going by the description alone always supplies one, always gets a
// correctly-scoped single-account answer, and has no way to learn from this tool alone that a
// broader, all-accounts answer was ever available -- indistinguishable from "that's all there
// is". Downstream, a caller with only this tool (no sibling that browses across accounts) reads
// a single account's transactions as "the" answer to "every transaction in this range".
//
// This file pins two things:
//   1. The description text actually says what omitting accountId does, so no caller has to
//      discover the behaviour by reading the schema or the source.
//   2. The behaviour itself: omitting accountId returns transactions from every account, not a
//      silent default to one.
//
// Run: node tests/unit/transactions_get_scope.test.js

process.env.ACTUAL_SERVER_URL = process.env.ACTUAL_SERVER_URL ?? 'http://localhost:5006';
process.env.ACTUAL_BUDGET_SYNC_ID = process.env.ACTUAL_BUDGET_SYNC_ID ?? '00000000-0000-0000-0000-000000000000';
process.env.ACTUAL_PASSWORD = process.env.ACTUAL_PASSWORD ?? 'stub-password-for-unit-test';

console.log('Running transactions_get scope/description unit tests');

(async () => {
  const ACCOUNT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
  const ACCOUNT_B = 'bbbbbbbb-0000-4000-8000-000000000002';

  const apiMod = await import('@actual-app/api');
  const api = apiMod.default || apiMod;
  api.init = async () => {};
  api.shutdown = async () => {};
  api.sync = async () => {};
  api.downloadBudget = async () => {};
  api.getBudgetMonths = async () => ['2026-01'];
  api.getAccounts = async () => [
    { id: ACCOUNT_A, name: 'Checking' },
    { id: ACCOUNT_B, name: 'Savings' },
  ];
  // The real backend scopes by account when one is given, and returns every account's rows
  // together when accountId is undefined -- this stub reproduces exactly that contract so the
  // test exercises the tool's own argument-forwarding, not a fake shortcut.
  const ALL_TRANSACTIONS = [
    { id: 't1', account: ACCOUNT_A, amount: -100 },
    { id: 't2', account: ACCOUNT_B, amount: -200 },
  ];
  api.getTransactions = async (accountId, _startDate, _endDate) =>
    accountId ? ALL_TRANSACTIONS.filter((t) => t.account === accountId) : ALL_TRANSACTIONS;

  const apiState = await import('../../dist/src/lib/apiState.js');
  apiState.setApiInitialized(true);
  apiState.setLoadedBudgetSyncId(process.env.ACTUAL_BUDGET_SYNC_ID);

  const toolMod = await import('../../dist/src/tools/transactions_get.js');
  const tool = toolMod.default?.default ?? toolMod.default;

  let failures = 0;
  const fail = (msg) => { console.error('  FAIL:', msg); failures++; };
  const ok = (msg) => console.log('  ✓', msg);

  // --- 1. the description says what omitting accountId does -----------------------------
  {
    const desc = tool.description.toLowerCase();
    if (desc.includes('omit') && desc.includes('every account')) {
      ok('description explains that omitting accountId returns every account\'s transactions');
    } else {
      fail(`description does not explain the no-accountId behaviour: "${tool.description}"`);
    }
  }

  // --- 2. omitting accountId returns every account's transactions, not a silent subset -----
  {
    const { result } = await tool.call({ startDate: '2026-01-01', endDate: '2026-01-31' });
    const accounts = new Set(result.map((t) => t.account));
    if (result.length === ALL_TRANSACTIONS.length && accounts.has(ACCOUNT_A) && accounts.has(ACCOUNT_B)) {
      ok('omitting accountId returns transactions from every account');
    } else {
      fail(`expected all ${ALL_TRANSACTIONS.length} transactions across both accounts, got ${JSON.stringify(result)}`);
    }
  }

  // --- 3. a supplied accountId still scopes correctly (no regression) ---------------------
  {
    const { result } = await tool.call({ accountId: ACCOUNT_A, startDate: '2026-01-01', endDate: '2026-01-31' });
    if (result.length === 1 && result[0].account === ACCOUNT_A) {
      ok('a supplied accountId still scopes to just that account');
    } else {
      fail(`expected exactly ACCOUNT_A's transaction, got ${JSON.stringify(result)}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s) in transactions_get_scope.test.js`);
    process.exit(1);
  }
  console.log('All transactions_get scope/description tests passed.');
})();
