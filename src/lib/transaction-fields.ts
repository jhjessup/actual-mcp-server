/**
 * Shared shaping for transaction rows returned by the transaction read tools.
 *
 * raw_synced_data is the bank feed's original record (SimpleFin/GoCardless), stored verbatim.
 * It is usually the largest field on a bank-synced row, and nothing that reads these rows needs
 * it: payee, imported_payee, notes, amount and date are already their own fields. So the read
 * tools omit it by default and take an `includeRawSyncedData` flag to keep it.
 */
import { z } from 'zod';

export const includeRawSyncedDataSchema = z
  .boolean()
  .optional()
  .default(false)
  .describe('When true, keep each transaction row\'s raw_synced_data (the bank feed\'s original record). Default false: the field is omitted to keep responses small.');

export const RAW_SYNCED_DATA_NOTE =
  'Transaction rows omit raw_synced_data (the bank feed\'s original record) unless includeRawSyncedData:true.';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripRow(txn: any): any {
  if (txn == null || typeof txn !== 'object') return txn;
  const hasRaw = 'raw_synced_data' in txn;
  const subs = Array.isArray(txn.subtransactions) ? txn.subtransactions : null;
  if (!hasRaw && !subs) return txn;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { raw_synced_data: _omitted, ...rest } = txn;
  const out = hasRaw ? rest : { ...txn };
  // Split children are full transaction rows too, and can carry the same field.
  if (subs) out.subtransactions = subs.map(stripRow);
  return out;
}

/**
 * Returns the rows with raw_synced_data removed (including from split children), unless
 * `include` is true, in which case the input is returned unchanged. Never mutates the input.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function shapeTransactionRows(rows: any[], include: boolean): any[] {
  return include ? rows : rows.map(stripRow);
}
