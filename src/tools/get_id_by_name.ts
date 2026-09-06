import { z } from 'zod';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';

const ALLOWED_TYPES = ['accounts', 'schedules', 'categories', 'payees'] as const;

const InputSchema = z.object({
  type: z
    .enum(ALLOWED_TYPES)
    .describe("Entity type to look up. One of: 'accounts', 'schedules', 'categories', 'payees'"),
  name: z
    .string()
    .min(1, 'Name cannot be empty')
    .describe('Exact name of the entity to resolve to an ID'),
});

const tool: ToolDefinition = {
  name: 'actual_get_id_by_name',
  description: `Resolve an entity name to its UUID.

Looks up the UUID for any Account, Payee, Category, or Schedule by their display name.
This is useful when you know the human-readable name but need the ID for other API calls.

Allowed types: 'accounts', 'schedules', 'categories', 'payees'

Returns the UUID string for the matching entity.

AMBIGUITY WARNING: this delegates to Actual's own server-side get-id-by-name, which returns the FIRST match and says nothing about any others. Actual permits two categories with the same name in different groups, and duplicate payee names, so a name that is not unique resolves here to one id with no signal that another exists. When the name might not be unique, and always when the answer will be used to WRITE, prefer actual_entities_search: it reports every match rather than picking one. actual_categories_get / actual_payees_get / actual_accounts_list list them in full.

Examples:
- Find the ID for an account named "Checking Account"
- Find the ID for a category named "Groceries"
- Find the ID for a payee named "Amazon"
- Find the ID for a schedule named "Rent"`,
  inputSchema: InputSchema,
  call: async (args: unknown) => {
    const input = InputSchema.parse(args);
    const id = await adapter.getIDByName(input.type, input.name);
    return { id, type: input.type, name: input.name };
  },
};

export default tool;
