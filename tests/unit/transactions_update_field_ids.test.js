// tests/unit/transactions_update_field_ids.test.js
//
// The ids INSIDE a transaction update's `fields` are checked before the write.
//
// #212 pre-flighted the transaction's OWN id, because the raw API silently no-ops on a missing
// one. The ids the update CARRIES had no such check, and they fail worse than a no-op:
// `db.updateTransaction` stores whatever category, account or payee id it is handed without
// looking it up, so a made-up id is written, the call returns `{success: true}`, and the
// transaction ends up pointing at something no listing returns. That is #360's phantom row one
// level down, and it is the mistake a model makes most often, because an id half-remembered
// from earlier in a conversation is well-formed and wrong.
//
// WHAT EACH HALF PINS, since the three fields are deliberately NOT treated alike:
//   - `category` / `account` publish themselves as ids (typed against CommonSchemas as of this
//     change), so the only question is existence, and the answer is a typed refusal.
//   - `payee` has published "Payee ID or name" for its whole life, so a name is DOCUMENTED
//     input. Refusing it would be the breaking change; it is resolved to its id instead. An
//     AMBIGUOUS name is still refused, with every candidate named, because a name matching two
//     payees identifies neither and picking one is the silent wrong write this file exists to
//     prevent.
//   - A split's CHILD categories are checked with the parent's, or the check would be trivially
//     avoidable by writing the same wrong id through `subtransactions` instead.
//
// Exercises the REAL adapter offline, the way transactions_update_guard.test.js does: raw api
// functions are stubbed BEFORE the adapter imports them, and the session is disarmed with
// _setSkipApiInitForTests. Stubbing the adapter method instead would make every assertion here
// vacuous.
//
// Run: node tests/unit/transactions_update_field_ids.test.js

process.env.ACTUAL_SERVER_URL     = process.env.ACTUAL_SERVER_URL     ?? 'http://localhost:5006';
process.env.ACTUAL_BUDGET_SYNC_ID = process.env.ACTUAL_BUDGET_SYNC_ID ?? '00000000-0000-0000-0000-000000000000';
process.env.ACTUAL_PASSWORD       = process.env.ACTUAL_PASSWORD       ?? 'stub-password-for-unit-test';

let failures = 0;
const pass = (label) => console.log(`  ✓ ${label}`);
const fail = (label, d = '') => { console.error(`  ✗ FAIL: ${label}${d ? ' (' + d + ')' : ''}`); failures++; };
const check = (cond, label, d = '') => cond ? pass(label) : fail(label, d);

const TXN        = 'aaaaaaaa-0000-4000-8000-000000000001';
const TXN_SPLIT  = 'aaaaaaaa-0000-4000-8000-000000000002';
const CAT        = 'bbbbbbbb-0000-4000-8000-000000000001';
const CAT_GHOST  = 'bbbbbbbb-0000-4000-8000-0000000000ff';
const ACC        = 'cccccccc-0000-4000-8000-000000000001';
const ACC_GHOST  = 'cccccccc-0000-4000-8000-0000000000ff';
const PAYEE      = 'dddddddd-0000-4000-8000-000000000001';
const PAYEE_DUP1 = 'dddddddd-0000-4000-8000-000000000011';
const PAYEE_DUP2 = 'dddddddd-0000-4000-8000-000000000012';
const PAYEE_GHOST = 'dddddddd-0000-4000-8000-0000000000ff';

(async () => {
  const apiMod = await import('@actual-app/api');
  const api = apiMod.default || apiMod;
  api.sync = async () => {};

  // Mutable state rather than reassigned stubs: the adapter destructures the raw api functions
  // at module load, so a reassignment after the import is captured by nobody (the trap
  // update_tools_not_found.test.js records hitting).
  const reads = { categories: 0, accounts: 0, payees: 0 };
  // The existence query is by id, and `updateTransaction`'s split guard reads `rows[0]`, so the
  // stub answers with whatever the case under test has declared to exist rather than with every
  // fixture row at once (returning both would make the split guard read the wrong row).
  let queryRows = [{ id: TXN, is_parent: false, amount: -1000 }];
  let writes = [];
  api.runQuery = async () => ({ data: queryRows });
  api.updateTransaction = async (id, fields) => { writes.push({ id, fields }); };
  api.getCategories = async () => { reads.categories++; return [{ id: CAT, name: 'Food', group_id: 'grp-1' }]; };
  api.getAccounts = async () => { reads.accounts++; return [{ id: ACC, name: 'Checking' }]; };
  api.getPayees = async () => {
    reads.payees++;
    return [
      { id: PAYEE, name: 'Amazon' },
      { id: PAYEE_DUP1, name: 'Gifts' },
      { id: PAYEE_DUP2, name: 'gifts' },
    ];
  };

  const adapterMod = await import('../../dist/src/lib/actual-adapter.js');
  adapterMod._setSkipApiInitForTests(true);
  const adapter = adapterMod.default;
  const { isPreflightRefusal } = await import('../../dist/src/lib/errors.js');

  const reset = (rows = [{ id: TXN, is_parent: false, amount: -1000 }]) => {
    queryRows = rows;
    writes = [];
    reads.categories = 0; reads.accounts = 0; reads.payees = 0;
  };
  const SPLIT_ROW = [{ id: TXN_SPLIT, is_parent: true, amount: -1000 }];
  const attempt = async (fn) => {
    try { return { ok: true, value: await fn() }; }
    catch (error) { return { ok: false, error }; }
  };

  console.log('\n[field-ids] a category or account that EXISTS still writes');
  {
    reset();
    const r = await attempt(() => adapter.updateTransaction(TXN, { category: CAT, account: ACC }));
    check(r.ok, 'a real category + account is accepted', r.ok ? '' : r.error.message);
    check(writes.length === 1, 'and the raw write happened exactly once');
    check(writes[0]?.fields?.category === CAT, 'with the caller\'s own value, untouched');
  }

  console.log('\n[field-ids] a well-formed category id that names NOTHING is refused, unwritten');
  {
    reset();
    const r = await attempt(() => adapter.updateTransaction(TXN, { category: CAT_GHOST }));
    check(!r.ok && isPreflightRefusal(r.error), 'refused with a typed pre-flight refusal');
    check(!r.ok && r.error.message.includes('actual_categories_get'), 'and the message names the listing tool');
    check(writes.length === 0, 'the raw write was NOT called: this is what prevents the dangling category');
  }

  console.log('\n[field-ids] the same for account');
  {
    reset();
    const r = await attempt(() => adapter.updateTransaction(TXN, { account: ACC_GHOST }));
    check(!r.ok && isPreflightRefusal(r.error), 'refused');
    check(!r.ok && r.error.message.includes('actual_accounts_list'), 'and names actual_accounts_list');
    check(writes.length === 0, 'nothing written');
  }

  console.log('\n[field-ids] null CLEARS a field and must reach the write untouched');
  {
    reset();
    const r = await attempt(() => adapter.updateTransaction(TXN, { category: null, notes: 'x' }));
    check(r.ok, 'uncategorising is not mistaken for a bad id', r.ok ? '' : r.error.message);
    check(writes.length === 1 && writes[0].fields.category === null, 'and null is what reaches the API');
    check(reads.categories === 0, 'and no listing was read for it');
  }

  console.log('\n[field-ids] an update carrying NO entity id reads no listing at all');
  {
    reset();
    const r = await attempt(() => adapter.updateTransaction(TXN, { notes: 'just a note' }));
    check(r.ok, 'a notes-only update still works');
    check(reads.categories === 0 && reads.accounts === 0 && reads.payees === 0,
      `and pays for nothing (${reads.categories}/${reads.accounts}/${reads.payees} reads)`);
  }

  console.log('\n[field-ids] payee: "id or name" is the published contract, so a NAME resolves');
  {
    reset();
    const r = await attempt(() => adapter.updateTransaction(TXN, { payee: 'Amazon' }));
    check(r.ok, 'a name is accepted, not refused: refusing it would break the documented contract',
      r.ok ? '' : r.error.message);
    check(writes[0]?.fields?.payee === PAYEE, `and the ID is what reaches the API (got ${writes[0]?.fields?.payee})`);

    reset();
    const byId = await attempt(() => adapter.updateTransaction(TXN, { payee: PAYEE }));
    check(byId.ok && writes[0]?.fields?.payee === PAYEE, 'an id that exists passes through unchanged');

    reset();
    const ghost = await attempt(() => adapter.updateTransaction(TXN, { payee: PAYEE_GHOST }));
    check(!ghost.ok && isPreflightRefusal(ghost.error), 'a well-formed payee id that names nothing is refused');
    check(writes.length === 0, 'and nothing was written');
  }

  console.log('\n[field-ids] payee: an AMBIGUOUS name is refused with every candidate, never guessed');
  {
    reset();
    const r = await attempt(() => adapter.updateTransaction(TXN, { payee: 'Gifts' }));
    check(!r.ok && isPreflightRefusal(r.error), 'a name matching two payees is refused');
    check(!r.ok && r.error.message.includes(PAYEE_DUP1) && r.error.message.includes(PAYEE_DUP2),
      'and the refusal names BOTH, so the caller can pick');
    check(writes.length === 0, 'nothing was written: taking the first match here would be a wrong write');
  }

  console.log('\n[field-ids] a SPLIT child category is checked with the parent\'s');
  {
    reset(SPLIT_ROW);
    const bad = await attempt(() => adapter.updateTransaction(TXN_SPLIT, {
      subtransactions: [{ amount: -1000, category: CAT_GHOST }],
    }));
    check(!bad.ok && isPreflightRefusal(bad.error), 'a child category that names nothing is refused');
    check(writes.length === 0, 'and no child was written');

    reset(SPLIT_ROW);
    const good = await attempt(() => adapter.updateTransaction(TXN_SPLIT, {
      subtransactions: [{ amount: -1000, category: CAT }],
    }));
    check(good.ok, 'a real child category still writes', good.ok ? '' : good.error.message);
  }

  console.log('\n[field-ids] batch: a bad id fails ITS item, and the listing is read once');
  {
    reset([{ id: TXN }, { id: TXN_SPLIT }]);
    const res = await adapter.updateTransactionBatch([
      { id: TXN, fields: { category: CAT } },
      { id: TXN_SPLIT, fields: { category: CAT_GHOST } },
    ]);
    check(res.succeeded.length === 1 && res.succeeded[0].id === TXN, 'the good item succeeded');
    check(res.failed.length === 1 && res.failed[0].id === TXN_SPLIT, 'the bad item failed on its own');
    check((res.failed[0]?.error || '').includes('actual_categories_get'),
      'and its per-item error carries the refusal, not a generic message');
    check(writes.length === 1, 'only the good item reached the raw write');
    check(reads.categories === 1,
      `ONE categories listing for the whole batch, not one per item (read ${reads.categories} times)`);
  }

  console.log('');
  if (failures === 0) console.log('[field-ids] All transaction-update field id tests passed ✓');
  else { console.error(`[field-ids] ${failures} test(s) FAILED`); process.exit(2); }
})();
