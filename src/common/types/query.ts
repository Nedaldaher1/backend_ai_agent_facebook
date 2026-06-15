/**
 * Shared shapes for list/pagination across every data-access layer. Repositories
 * accept `ListOptions` and return rows; services that paginate return
 * `PaginatedResult`. Keeping these in one place keeps the reusable API (admin UI
 * + agent tools) consistent.
 */

/** Default page size when a caller does not specify `limit`. */
export const DEFAULT_LIST_LIMIT = 50;
/** Hard cap so a caller can never request an unbounded page. */
export const MAX_LIST_LIMIT = 200;

export type SortDirection = 'asc' | 'desc';

/** Pagination + ordering options shared by every `list` method. */
export interface ListOptions {
  limit?: number;
  offset?: number;
  orderBy?: SortDirection;
}

/** A page of rows plus the total count for the same filter (no pagination). */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Clamp raw list options to safe values: a positive limit no larger than
 * MAX_LIST_LIMIT, a non-negative offset, and a known sort direction. Repositories
 * call this so no query can be issued with an unbounded or negative page.
 */
export function normalizeListOptions(opts: ListOptions = {}): {
  limit: number;
  offset: number;
  orderBy: SortDirection;
} {
  const rawLimit = opts.limit ?? DEFAULT_LIST_LIMIT;
  const limit = Math.min(Math.max(1, Math.trunc(rawLimit)), MAX_LIST_LIMIT);
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  const orderBy: SortDirection = opts.orderBy === 'asc' ? 'asc' : 'desc';
  return { limit, offset, orderBy };
}
