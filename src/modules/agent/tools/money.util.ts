/**
 * money.util.ts — JOD arithmetic for the agent tools.
 *
 * The implementation now lives in `@/common/money.util` (shared with the orders
 * service so totals are computed the same way everywhere). This barrel re-exports
 * the helper the tools historically imported from here, so existing imports and
 * tests keep working.
 */
export { sumJodLineTotals } from '@/common/money.util';
