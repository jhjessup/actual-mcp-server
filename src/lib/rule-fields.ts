/**
 * What a rule's condition and action FIELDS mean, in one place.
 *
 * `FIELD_OPERATORS` existed three times, character for character, in `rules_create.ts`,
 * `rules_update.ts` and `rules_create_or_update.ts`, and each of the three also open-coded the
 * "this field wants a UUID" check two or three times over. `tool_id_schema_drift`'s own header
 * says it best about the identical rule expressed twice: "The same rule written twice is how a
 * fifth tier of id validation appears." This is the shared copy, and it is where the ADAPTER
 * reads the classification from too, so the answer to "is this value an entity id?" cannot
 * differ between the layer that validates shape and the layer that validates existence.
 *
 * Deliberately PURE and free of any api import, for the reason `filter-ids.ts` gives: the
 * classification is unit-testable without a session, while fetching the listings to check the
 * ids against belongs in the adapter, where a listing read gets `retry` and the observability
 * call site.
 */

import type { FilterIdKind } from './actual-adapter/filter-ids.js';

/** Which operators each rule field accepts, and what kind of value it holds. */
export const FIELD_OPERATORS: Record<string, { type: string; operators: string[] }> = {
  'imported_payee': { type: 'string', operators: ['contains', 'matches', 'doesNotContain', 'is', 'isNot'] },
  'payee': { type: 'id', operators: ['is', 'isNot', 'oneOf', 'notOneOf'] },
  'account': { type: 'id', operators: ['is', 'isNot', 'oneOf', 'notOneOf'] },
  'category': { type: 'id', operators: ['is', 'isNot', 'oneOf', 'notOneOf'] },
  'notes': { type: 'string', operators: ['contains', 'matches', 'doesNotContain', 'is', 'isNot'] },
  'description': { type: 'string', operators: ['contains', 'matches', 'doesNotContain', 'is', 'isNot'] },
  'amount': { type: 'number', operators: ['is', 'gte', 'lte', 'gt', 'lt', 'isapprox'] },
  'date': { type: 'date', operators: ['is', 'gte', 'lte', 'gt', 'lt'] },
};

/**
 * The three id-typed rule fields, mapped to the listing that can confirm one exists.
 *
 * The field NAMES happen to equal the `FilterIdKind` values, which is convenient and not
 * something to rely on silently: this map is what makes the correspondence explicit, so adding a
 * fourth id-typed field means adding a row here rather than hoping the names keep lining up.
 */
const ID_FIELD_KINDS: Record<string, FilterIdKind> = {
  payee: 'payee',
  account: 'account',
  category: 'category',
};

/** One entity id found inside a rule, with enough context to say WHERE it was found. */
export interface RuleEntityId {
  kind: FilterIdKind;
  value: string;
  /** e.g. `conditions[1].value` — named in the refusal, because a rule can carry several ids. */
  where: string;
}

/** Every string value under `value`, flattened, so `oneOf`/`notOneOf` arrays are covered too. */
function idValues(value: unknown, where: string): Array<{ value: string; where: string }> {
  if (typeof value === 'string') return [{ value, where }];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => (typeof v === 'string' ? [{ value: v, where: `${where}[${i}]` }] : []));
  }
  return [];
}

/**
 * Collect every entity id a rule refers to, from both its conditions and its `set` actions.
 *
 * This is the list the adapter checks for EXISTENCE before writing. The tools already reject a
 * value that is not UUID-SHAPED, which is a different and weaker question: `db.updateRule` and
 * `db.insertRule` store whatever id they are handed without looking it up, so a well-formed id
 * belonging to nothing produces a rule that silently matches or assigns nothing, reported as
 * success. That is the same shape as #360's phantom row, one level of indirection down.
 *
 * `oneOf`/`notOneOf` values are arrays, and every element is collected: a five-category `oneOf`
 * with one bad id is exactly the case a per-value check catches and a per-condition one does not.
 */
export function collectRuleEntityIds(rule: unknown): RuleEntityId[] {
  if (typeof rule !== 'object' || rule === null) return [];
  const obj = rule as Record<string, unknown>;
  const found: RuleEntityId[] = [];

  const conditions = Array.isArray(obj.conditions) ? obj.conditions : [];
  conditions.forEach((raw, i) => {
    if (typeof raw !== 'object' || raw === null) return;
    const condition = raw as Record<string, unknown>;
    const field = typeof condition.field === 'string' ? condition.field : '';
    const kind = FIELD_OPERATORS[field]?.type === 'id' ? ID_FIELD_KINDS[field] : undefined;
    if (!kind) return;
    for (const v of idValues(condition.value, `conditions[${i}].value`)) {
      found.push({ kind, value: v.value, where: v.where });
    }
  });

  const actions = Array.isArray(obj.actions) ? obj.actions : [];
  actions.forEach((raw, i) => {
    if (typeof raw !== 'object' || raw === null) return;
    const action = raw as Record<string, unknown>;
    // Only `set` writes a field value. `link-schedule`, `append-notes` and `set-split-amount`
    // carry a schedule id, prose and a number respectively, none of which this map describes.
    if (action.op !== undefined && action.op !== 'set') return;
    const field = typeof action.field === 'string' ? action.field : '';
    const kind = ID_FIELD_KINDS[field];
    if (!kind) return;
    for (const v of idValues(action.value, `actions[${i}].value`)) {
      found.push({ kind, value: v.value, where: v.where });
    }
  });

  return found;
}
