import { z } from 'zod';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';

const InputSchema = z.object({ accountId: z.string().optional(), startDate: z.string().optional(), endDate: z.string().optional() });

const tool: ToolDefinition = {
  name: 'actual_transactions_get',
  // accountId is optional (see InputSchema above) and has been since this tool's introduction --
  // omit it and every account's transactions in the date range come back together. The
  // description used to read "Get all transactions for a specific account", which does not say
  // that: it reads as accountId being expected, if not required, and nothing in the schema
  // corrects that impression (Zod's `.optional()` doesn't surface as prose to a model deciding
  // which arguments to supply). A caller who takes the description at face value always supplies
  // an accountId, gets a correctly-scoped single-account answer, and has no way to know from this
  // tool alone that a broader one was ever on the table -- indistinguishable from "that's all
  // there is" unless they already know to omit the field. Spelled out explicitly below instead.
  description: "Get transactions within a date range. Pass accountId to scope to one account, or omit it to get every account's transactions in the range together. Returns transaction details including date, amount (cents), payee, category, notes, and cleared status. Dates in YYYY-MM-DD format. Perfect for account reconciliation and spending analysis.",
  inputSchema: InputSchema,
  call: async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});
    // Pre-flight: verify the account exists when accountId is provided (BUG-7, then #388).
    // This tool already refused a well-formed id that names nothing, and `verifyExists: true`
    // keeps exactly that. What it gains is the third case: a NAME passed where an id belongs
    // now comes back with the id it resolves to, instead of a refusal that only says not found.
    // It also stops returning `{ error }` and THROWS, per #377: does-not-exist throws.
    if (input.accountId) {
      await adapter.resolveFilterId('account', input.accountId, { verifyExists: true });
    }
    const result = await adapter.getTransactions(input.accountId, input.startDate, input.endDate);
    return { result };
  },
};

export default tool;
