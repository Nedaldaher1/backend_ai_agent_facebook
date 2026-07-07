/**
 * Fixed platform identifiers seeded by migration 0020.
 *
 * MASA_TENANT_ID is the tenant every pre-multi-tenant row was backfilled to —
 * the original Masa Fashion brand. It is pinned (not random) so migrations,
 * code, and the dev bootstrap all agree on the same uuid. Never reuse it for
 * another tenant.
 *
 * DEFAULT_TENANT_ID (env) falls back to this constant while the platform runs
 * in single-tenant dev mode; Phase 3 replaces the fallback with per-page
 * channel routing.
 */
export const MASA_TENANT_ID = 'aa5a0000-0000-4000-8000-000000000001';

/** The unlimited dev plan Masa is assigned to by migration 0020. */
export const DEV_PLAN_ID = 'aa5a0000-0000-4000-8000-000000000002';
