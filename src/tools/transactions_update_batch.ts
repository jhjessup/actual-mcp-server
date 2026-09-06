/**
 * actual_transactions_update_batch
 *
 * Batch-update multiple transactions in one call.
 *
 * Concept and implementation adapted from the ZanzyTHEbar fork:
 * https://github.com/ZanzyTHEbar/actual-mcp-server/blob/main/src/tools/transactions_update_batch.ts
 * Credit: ZanzyTHEbar (https://github.com/ZanzyTHEbar)
 *
 * Adapted for this project's conventions:
 * - No wrapToolCall: uses direct call() pattern
 * - Returns a plain BatchResult object (no { result } wrapper)
 */
import { z } from 'zod';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';
import { CommonSchemas } from '../lib/schemas/common.js';

// The nested `fields.*` entity ids are typed for the same reason as in transactions_update.ts
// (read the comment there): they are PAYLOAD ids on a write, and an unchecked one is stored as
// given and reported as success. This tool is the higher-risk of the two, because the mistake it
// invites is bulk: 50 transactions moved to one category id that does not exist.
const FieldsSchema = z.object({
  account: CommonSchemas.accountId.nullable().optional()
    .describe('Account ID (UUID) to move the transaction to. Must come from actual_accounts_list; never construct or guess one.'),
  date: z.string().nullable().optional().describe('Transaction date (YYYY-MM-DD)'),
  amount: z.number().nullable().optional().describe('Amount in cents (e.g., -1000 = -$10.00)'),
  // Left permissive on purpose, matching transactions_update: "id or name" is this field's
  // published contract, and the adapter resolves it rather than refusing a name.
  payee: z.string().nullable().optional()
    .describe('Payee ID (UUID, from actual_payees_get) or an exact payee name. A name that matches more than one payee is refused; pass the id in that case.'),
  payee_name: z.string().nullable().optional().describe('Payee name (alternative to payee ID)'),
  imported_payee: z.string().nullable().optional().describe('Original imported payee name'),
  category: CommonSchemas.categoryId.nullable().optional()
    .describe('Category ID (UUID). Must come from actual_categories_get; never construct or guess one. Pass null to uncategorise.'),
  notes: z.string().nullable().optional().describe('Transaction notes'),
  cleared: z.boolean().nullable().optional().describe('Whether transaction is cleared'),
});

const UpdateItemSchema = z.object({
  id: CommonSchemas.transactionId.describe('Transaction ID to update'),
  fields: FieldsSchema.describe('Fields to update for this transaction'),
});

const InputSchema = z.object({
  updates:  z.array(UpdateItemSchema)
    .min(1)
    .max(50)
    .describe('Array of {id, fields} objects. Maximum 50 per batch (higher values risk timeout).'),
});

type BatchResult = {
  succeeded: { id: string }[];
  failed: { id: string; error: string }[];
  total: number;
  successCount: number;
  failureCount: number;
};

const tool: ToolDefinition = {
  name: 'actual_transactions_update_batch',
  description: `Update multiple transactions in a single call. Accepts up to 50 {id, fields} pairs. Each update is applied independently: partial failures are reported per-item so you know exactly which succeeded and which failed. Splits are not supported here: a subtransactions field is ignored in batch. Use actual_transactions_update to edit an existing split's children.

fields.category and fields.account are UUIDs that must come from a prior actual_categories_get / actual_accounts_list call. An id you constructed, abbreviated or recalled from earlier in the conversation is refused, not silently written — which matters most here, where one wrong id is applied to every item in the batch.

Returns: { succeeded: [{id}], failed: [{id, error}], total, successCount, failureCount }

Example: { updates: [{ id: "txn-uuid-1", fields: { category: "cat-uuid" } }, { id: "txn-uuid-2", fields: { notes: "Reimbursement" } }] }`,
  inputSchema: InputSchema,
  call: async (args: unknown, _meta?: unknown) => {
    try {
      const input = InputSchema.parse(args || {});

      // Single adapter call: all updates share one init/sync/shutdown cycle (fixes issue #79).
      // Calling adapter.updateTransaction() in a loop would trigger N separate budget sessions.
      const { succeeded, failed } = await adapter.updateTransactionBatch(input.updates);

      const result: BatchResult = {
        succeeded,
        failed,
        total: input.updates.length,
        successCount: succeeded.length,
        failureCount: failed.length,
      };

      return result;
    } catch (error: any) {
      const message = error?.message || String(error);
      return {
        succeeded: [],
        failed: [{ id: 'batch', error: `update_batch failed: ${message}` }],
        total: 0,
        successCount: 0,
        failureCount: 1,
      };
    }
  },
};

export default tool;
