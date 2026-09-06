import { z } from 'zod';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';

const InputSchema = z.object({
  payeeName: z.string().optional().describe('Name of the payee/vendor to search for, or its UUID. A name that matches more than one payee is refused with the candidate ids (optional for smoke tests)'),
  startDate: z.string().optional().describe('Optional: Start date in YYYY-MM-DD format'),
  endDate: z.string().optional().describe('Optional: End date in YYYY-MM-DD format'),
  accountId: z.string().optional().describe('Optional: Filter by specific account ID'),
  categoryName: z.string().optional().describe('Optional: Filter by category name, or its UUID. A name that matches more than one category is refused with the candidate ids'),
  minAmount: z.number().optional().describe('Optional: Minimum amount in cents'),
  maxAmount: z.number().optional().describe('Optional: Maximum amount in cents'),
  limit: z.number().optional().default(100).describe('Optional: Maximum number of transactions to return (default: 100)'),
});

const tool: ToolDefinition = {
  name: 'actual_transactions_search_by_payee',
  description: 'Search transactions by payee name. Returns all transactions for a specific payee with optional date range, category, and amount filters. Useful for analyzing spending patterns with specific vendors or service providers.',
  inputSchema: InputSchema,
  call: async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});
    
    // #388: ONE answer to a name passed where an id belongs, shared by every Category B field.
    // This block used to return an empty result set with the error tucked inside it, which reads
    // to a model as "no transactions match". `verifyExists: true` keeps the existence check this
    // tool already paid for.
    if (input.accountId) {
      await adapter.resolveFilterId('account', input.accountId, { verifyExists: true });
    }

    // Step 1: Find payee ID by name.
    //
    // The same hand-rolled `.find()` `transactions_search_by_category` carried, with the same two
    // failures: an unknown name answered with `{transactions: [], count: 0, error}` (which a
    // model reads as "no transactions for that payee", not as an error), and a duplicate name
    // silently took the first match. Routed through the shared resolver so this tool answers a
    // name the same way its own `accountId` two lines above already does. `acceptsName`, because
    // `payeeName` IS a name by contract; only the failure paths change.
    let payeeId: string | undefined;
    if (input.payeeName) {
      payeeId = await adapter.resolveFilterId('payee', input.payeeName, { acceptsName: true });
    }

    // Step 2: Get base transactions (filtered by account and date range if provided)
    // getTransactions() requires an accountId — when none is provided, fetch from all accounts
    let allTransactions: any[];
    if (input.accountId) {
      allTransactions = await adapter.getTransactions(input.accountId, input.startDate, input.endDate);
    } else {
      const allAccounts = await adapter.getAccounts();
      const perAccount = await Promise.all(
        allAccounts.map((acc: any) =>
          adapter.getTransactions(acc.id, input.startDate, input.endDate).catch(() => [])
        )
      );
      // Deduplicate by id (split transactions appear in both parent and child accounts)
      const seen = new Set<string>();
      allTransactions = perAccount.flat().filter((t: any) => {
        if (!t.id || seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });
    }

    if (!Array.isArray(allTransactions)) {
      return {
        transactions: [],
        count: 0,
        totalAmount: 0,
        payeeName: input.payeeName,
      };
    }
    
    // Step 3: Apply JavaScript filters
    let filtered = allTransactions;
    
    // Filter by payee ID
    if (payeeId) {
      filtered = filtered.filter((t: any) => t.payee === payeeId);
    }
    
    // Filter by category name (need to lookup category ID). Third copy of the same hand-rolled
    // lookup, same two failures, same shared resolver.
    if (input.categoryName) {
      const categoryId = await adapter.resolveFilterId('category', input.categoryName, { acceptsName: true });
      filtered = filtered.filter((t: any) => t.category === categoryId);
    }
    
    // Filter by amount range
    if (input.minAmount !== undefined) {
      filtered = filtered.filter((t: any) => (t.amount || 0) >= input.minAmount!);
    }
    if (input.maxAmount !== undefined) {
      filtered = filtered.filter((t: any) => (t.amount || 0) <= input.maxAmount!);
    }
    
    // Sort by date descending and apply limit
    filtered.sort((a: any, b: any) => {
      const dateA = a.date || '';
      const dateB = b.date || '';
      return dateB.localeCompare(dateA);
    });
    
    const limited = filtered.slice(0, input.limit || 100);
    
    // Enrich transactions with account names
    const accounts = await adapter.getAccounts();
    const accountMap = new Map(accounts.map((acc: any) => [acc.id, acc.name]));
    
    const enrichedTransactions = limited.map((t: any) => ({
      ...t,
      accountName: accountMap.get(t.account) || t.account,
    }));
    
    // Calculate summary stats
    const totalAmount = limited.reduce((sum: number, t: any) => sum + (t.amount || 0), 0);
    
    return {
      transactions: enrichedTransactions,
      count: enrichedTransactions.length,
      totalAmount,
      payeeName: input.payeeName,
    };
  },
};

export default tool;
