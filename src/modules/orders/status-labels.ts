import { ORDER_STATUSES } from './entities/order.entity';

/**
 * Maps an order status enum value to a customer-facing Arabic sentence.
 *
 * The backing record is keyed by the full `ORDER_STATUSES` union, so adding a
 * new status to the enum causes a compile-time error here until the label is
 * added — exhaustiveness is enforced by the type system, not by runtime code.
 */
const STATUS_LABELS_AR: Record<(typeof ORDER_STATUSES)[number], string> = {
  draft: 'طلبك مسجّل عنا وقيد المراجعة',
  confirmed: 'تم تأكيد طلبك وهو قيد التجهيز',
  fulfilled: 'تم إخراج طلبك وهو في طريقه إليك',
  canceled: 'طلبك ملغى',
};

/**
 * Returns the Arabic label for a known order status, or a safe fallback
 * message when the status string is not in the enum (e.g. data written before
 * a migration or a bug in a status column).
 */
export function orderStatusLabelAr(status: string): string {
  return (
    STATUS_LABELS_AR[status as (typeof ORDER_STATUSES)[number]] ??
    'حالة طلبك غير متوفرة حالياً'
  );
}
