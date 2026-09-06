import { z } from 'zod';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';
import { CommonSchemas } from '../lib/schemas/common.js';

const InputSchema = z.object({
  // #380: REQUIRED, and typed. It was `.optional()` with the describe "optional for smoke
  // tests, required for actual usage": a published contract weakened to suit a test. The
  // handler then returned `{ success: true }` for a call with no id, writing nothing, which
  // is the #350 failure this project has spent three releases removing. A model that omitted
  // the id was told its edit had succeeded.
  //
  // The smoke test does supply an id (generated_tools.smoke.test.js), so the escape hatch
  // was not even load bearing when it was removed.
  id: CommonSchemas.transactionId.describe('Transaction ID to update'),
  fields: z.object({
    // The nested `fields.*` ENTITY IDS, typed. `tool_id_schema_drift`'s exception for
    // `fields.transfer_id` said to "decide the fields.* group together, with Category B", and
    // this is that decision. Category B is the OPTIONAL FILTER ids, where a loose schema buys a
    // better message than a ZodError can give (#388); these are the opposite case. They are
    // PAYLOAD ids on a write, so a wrong one is not a narrower answer, it is a wrong row: the
    // raw API stores whatever it is handed and reports success, leaving a transaction pointing
    // at a category no listing returns. Typing them is what a model reads before it calls, which
    // is where this has to be caught; `adapter.updateTransaction` then checks that the id it was
    // given actually EXISTS, because well-formed and real are different questions.
    account: CommonSchemas.accountId.nullable().optional()
      .describe('Account ID (UUID) to move the transaction to. Must come from actual_accounts_list; never construct or guess one.'),
    date: z.string().nullable().optional().describe('Transaction date (YYYY-MM-DD)'),
    amount: z.number().nullable().optional().describe('Amount in cents (e.g., 1000 = $10.00)'),
    // NOT tightened, unlike its two neighbours, and the asymmetry is the point. This field has
    // published "Payee ID or name" for its whole life, so a name is documented input and a UUID
    // schema would reject calls this tool has always advertised as valid. The adapter resolves
    // it instead: an id must exist, a name must match exactly one payee, and a name matching
    // several is refused with all of them rather than silently taking the first.
    payee: z.string().nullable().optional()
      .describe('Payee ID (UUID, from actual_payees_get) or an exact payee name. A name that matches more than one payee is refused; pass the id in that case.'),
    payee_name: z.string().nullable().optional().describe('Payee name (alternative to payee ID)'),
    imported_payee: z.string().nullable().optional().describe('Original imported payee name'),
    category: CommonSchemas.categoryId.nullable().optional()
      .describe('Category ID (UUID). Must come from actual_categories_get; never construct or guess one. Pass null to uncategorise.'),
    notes: z.string().nullable().optional().describe('Transaction notes'),
    imported_id: z.string().nullable().optional().describe('Original imported transaction ID'),
    transfer_id: CommonSchemas.transactionId.nullable().optional().describe('Transfer transaction ID if this is a transfer'),
    cleared: z.boolean().nullable().optional().describe('Whether transaction is cleared'),
    reconciled: z.boolean().nullable().optional().describe('Whether transaction is reconciled'),
    // #305: edit the children of an EXISTING split. The child amounts must sum
    // to the parent amount; the target must already be a split. Both are
    // enforced in the adapter pre-flight (it reads is_parent + amount), because
    // the parent amount is not part of this input. Converting a plain
    // transaction into a split here is rejected (unsupported by the API).
    subtransactions: CommonSchemas.subtransactions
      .optional()
      .describe('Replace the children of an existing split; amounts must sum to the parent amount. To create a split, use actual_transactions_create.'),
  }).describe('Fields to update'),
});


const tool: ToolDefinition = {
  name: 'actual_transactions_update',
  description:
    'Update an existing transaction in Actual Budget. Provide the transaction ID and the fields you want to update. ' +
    'fields.category and fields.account are UUIDs that must come from a prior actual_categories_get / actual_accounts_list call: ' +
    'an id you constructed, abbreviated or recalled from earlier in the conversation is refused, not silently written.',
  inputSchema: InputSchema,
  call: async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});
    await adapter.updateTransaction(input.id, input.fields);
    return { success: true };
  },
};

export default tool;
