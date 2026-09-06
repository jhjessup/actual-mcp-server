// tests/unit/rules_entity_ids.test.js
//
// A rule's id-typed condition and action values must name entities that EXIST.
//
// `docs/audit/write-effect-audit.md` carried "trace for an unvalidated payee or category in
// conditions and actions" against `actual_rules_create` as an open UNKNOWN from the 2026-08-25
// pass. This is the trace and the fix. The three rule tools already rejected a value that is not
// UUID-SHAPED, which answers a weaker question: `db.insertRule`/`db.updateRule` store the id
// they are handed without looking it up, so a well-formed id belonging to nothing is accepted,
// reported as success, and produces a rule that quietly matches nothing (a condition) or assigns
// a category no listing returns (an action). Same shape as #360's phantom row, one level down.
//
// TWO LAYERS, TESTED SEPARATELY BECAUSE THEY CAN DRIFT APART:
//   1. `collectRuleEntityIds` (pure) decides WHICH values are entity ids, off the same
//      FIELD_OPERATORS map the tools use for operator validation. Its `oneOf`/`notOneOf` arrays
//      are the case a per-condition check would miss.
//   2. The adapter checks the collected ids against the real listings, in the same queued write
//      operation as the write, and refuses without writing.
//
// Exercises the REAL adapter offline, per update_tools_not_found.test.js: raw api functions are
// stubbed BEFORE the adapter imports them, and the session is disarmed.
//
// Run: node tests/unit/rules_entity_ids.test.js

process.env.ACTUAL_SERVER_URL     = process.env.ACTUAL_SERVER_URL     ?? 'http://localhost:5006';
process.env.ACTUAL_BUDGET_SYNC_ID = process.env.ACTUAL_BUDGET_SYNC_ID ?? '00000000-0000-0000-0000-000000000000';
process.env.ACTUAL_PASSWORD       = process.env.ACTUAL_PASSWORD       ?? 'stub-password-for-unit-test';

let failures = 0;
const pass = (label) => console.log(`  ✓ ${label}`);
const fail = (label, d = '') => { console.error(`  ✗ FAIL: ${label}${d ? ' (' + d + ')' : ''}`); failures++; };
const check = (cond, label, d = '') => cond ? pass(label) : fail(label, d);

const CAT       = 'bbbbbbbb-0000-4000-8000-000000000001';
const CAT_GHOST = 'bbbbbbbb-0000-4000-8000-0000000000ff';
const PAY       = 'dddddddd-0000-4000-8000-000000000001';
const PAY_GHOST = 'dddddddd-0000-4000-8000-0000000000ff';
const RULE      = 'eeeeeeee-0000-4000-8000-000000000001';

(async () => {
  const { collectRuleEntityIds, FIELD_OPERATORS } = await import('../../dist/src/lib/rule-fields.js');

  console.log('\n[rule-ids] the pure collector: which values are entity ids');
  {
    check(FIELD_OPERATORS.category?.type === 'id' && FIELD_OPERATORS.notes?.type === 'string',
      'the shared FIELD_OPERATORS map is the one classifying them');

    const found = collectRuleEntityIds({
      conditions: [
        { field: 'imported_payee', op: 'contains', value: 'Amazon' },
        { field: 'category', op: 'is', value: CAT },
      ],
      actions: [{ op: 'set', field: 'payee', value: PAY }],
    });
    check(found.length === 2, `a text condition is NOT collected (got ${found.length})`);
    check(found.some((f) => f.kind === 'category' && f.value === CAT), 'an id condition is collected as its kind');
    check(found.some((f) => f.kind === 'payee' && f.value === PAY), 'a set action is collected as its kind');
    check(found.every((f) => /^(conditions|actions)\[\d\]\.value/.test(f.where)),
      'each carries WHERE it was found, because a rule can hold several ids');

    // The case a per-condition check cannot see: five ids behind one condition.
    const many = collectRuleEntityIds({
      conditions: [{ field: 'category', op: 'oneOf', value: [CAT, CAT_GHOST] }],
      actions: [],
    });
    check(many.length === 2, 'every element of a oneOf array is collected, not just the condition');

    // `link-schedule` carries a SCHEDULE id and `append-notes` carries prose; neither is
    // described by FIELD_OPERATORS, so collecting them would refuse valid rules.
    const other = collectRuleEntityIds({
      conditions: [],
      actions: [{ op: 'append-notes', field: 'notes', value: 'reviewed' }, { op: 'link-schedule', value: 'sched-1' }],
    });
    check(other.length === 0, 'non-set actions are left alone');
  }

  const apiMod = await import('@actual-app/api');
  const api = apiMod.default || apiMod;
  api.sync = async () => {};
  api.init = async () => {};
  api.shutdown = async () => {};
  api.downloadBudget = async () => {};
  api.getBudgetMonths = async () => ['2026-01'];

  const reads = { categories: 0, payees: 0, accounts: 0 };
  let created = [];
  let updated = [];
  let existingRules = [{ id: RULE, stage: null, conditionsOp: 'and', conditions: [], actions: [] }];
  api.getCategories = async () => { reads.categories++; return [{ id: CAT, name: 'Food' }]; };
  api.getPayees = async () => { reads.payees++; return [{ id: PAY, name: 'Amazon' }]; };
  api.getAccounts = async () => { reads.accounts++; return []; };
  api.getRules = async () => existingRules;
  api.createRule = async (rule) => { created.push(rule); return 'new-rule-id'; };
  api.updateRule = async (rule) => { updated.push(rule); return rule; };

  const adapterMod = await import('../../dist/src/lib/actual-adapter.js');
  adapterMod._setSkipApiInitForTests(true);
  const adapter = adapterMod.default;
  const { isPreflightRefusal } = await import('../../dist/src/lib/errors.js');

  const reset = () => { created = []; updated = []; reads.categories = 0; reads.payees = 0; reads.accounts = 0; };
  const attempt = async (fn) => {
    try { return { ok: true, value: await fn() }; }
    catch (error) { return { ok: false, error }; }
  };

  console.log('\n[rule-ids] createRule');
  {
    reset();
    const good = await attempt(() => adapter.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'category', op: 'is', value: CAT }],
      actions: [{ op: 'set', field: 'payee', value: PAY }],
    }));
    check(good.ok, 'a rule whose ids all exist is created', good.ok ? '' : good.error.message);
    check(created.length === 1, 'and it reached the raw create');

    reset();
    const bad = await attempt(() => adapter.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'category', op: 'is', value: CAT_GHOST }],
      actions: [{ op: 'set', field: 'payee', value: PAY }],
    }));
    check(!bad.ok && isPreflightRefusal(bad.error), 'a condition naming no category is refused');
    check(!bad.ok && bad.error.message.includes('conditions[0].value'),
      'and the refusal says WHICH value, not just "Category not found"');
    check(created.length === 0, 'the raw create was NOT called');

    reset();
    const badAction = await attempt(() => adapter.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'imported_payee', op: 'contains', value: 'Amazon' }],
      actions: [{ op: 'set', field: 'payee', value: PAY_GHOST }],
    }));
    check(!badAction.ok && isPreflightRefusal(badAction.error), 'an action naming no payee is refused too');
    check(created.length === 0, 'and nothing was created');

    // One listing per KIND, not per value: a rule can hold a long oneOf.
    reset();
    const many = await attempt(() => adapter.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'category', op: 'oneOf', value: [CAT, CAT, CAT] }],
      actions: [],
    }));
    check(many.ok, 'a three-element oneOf of real categories is accepted', many.ok ? '' : many.error.message);
    check(reads.categories === 1, `and pays ONE categories listing, not three (read ${reads.categories})`);

    reset();
    const oneBad = await attempt(() => adapter.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'category', op: 'oneOf', value: [CAT, CAT_GHOST] }],
      actions: [],
    }));
    check(!oneBad.ok && isPreflightRefusal(oneBad.error), 'one bad id inside a oneOf array still refuses the rule');
  }

  console.log('\n[rule-ids] updateRule checks what the CALLER SUPPLIED, not the merged rule');
  {
    reset();
    const bad = await attempt(() => adapter.updateRule(RULE, {
      actions: [{ op: 'set', field: 'category', value: CAT_GHOST }],
    }));
    check(!bad.ok && isPreflightRefusal(bad.error), 'a supplied action naming no category is refused');
    check(updated.length === 0, 'and nothing was written');

    // The inherited half must NOT be re-validated, or the edit that FIXES a rule whose category
    // was deleted last month would be refused forever.
    reset();
    existingRules = [{
      id: RULE, stage: null, conditionsOp: 'and',
      conditions: [{ field: 'category', op: 'is', value: CAT_GHOST }],
      actions: [],
    }];
    const rescue = await attempt(() => adapter.updateRule(RULE, {
      conditions: [{ field: 'category', op: 'is', value: CAT }],
    }));
    check(rescue.ok, 'replacing a stale id is allowed even though the stored rule held a dead one',
      rescue.ok ? '' : rescue.error.message);
    check(updated.length === 1, 'and the update reached the raw call');
    existingRules = [{ id: RULE, stage: null, conditionsOp: 'and', conditions: [], actions: [] }];
  }

  console.log('\n[rule-ids] upsertRule refuses BEFORE it decides create-or-update');
  {
    reset();
    const bad = await attempt(() => adapter.upsertRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'category', op: 'is', value: CAT_GHOST }],
      actions: [],
    }, false));
    check(!bad.ok && isPreflightRefusal(bad.error), 'refused');
    check(created.length === 0 && updated.length === 0,
      'and neither branch ran: an idempotent tool must not create on the first call and refuse on the second');
  }

  console.log('');
  if (failures === 0) console.log('[rule-ids] All rule entity id tests passed ✓');
  else { console.error(`[rule-ids] ${failures} test(s) FAILED`); process.exit(2); }
})();
