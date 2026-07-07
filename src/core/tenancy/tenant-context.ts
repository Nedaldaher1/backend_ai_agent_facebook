import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Ambient tenant identity, carried on AsyncLocalStorage so repositories can
 * resolve "whose data?" without threading a parameter through every call
 * (explicit per-method tenant parameters arrive with Phase 2; this is the
 * transport underneath them).
 *
 * Resolution order:
 *   1. an explicit runWith(tenantId, fn) scope (tests, scripts, future
 *      webhook-routing / JWT-claim binding), else
 *   2. DEFAULT_TENANT_ID (single-tenant dev mode — the Masa tenant).
 *
 * The env fallback is a Phase-1 bridge: it keeps every existing path (admin
 * HTTP, webhook agent turns, scripts) working with exactly one tenant in the
 * database. Phase 2 removes it for admin routes (tenant comes from the JWT)
 * and Phase 3 removes it for the agent path (tenant comes from the page id).
 * Even while it exists, escaped queries are fail-closed at the DB: a query
 * outside TenantDb has no app.tenant_id GUC and RLS yields zero rows.
 */
@Injectable()
export class TenantContext {
  private readonly als = new AsyncLocalStorage<{ tenantId: string }>();
  private readonly defaultTenantId: string;

  constructor(config: ConfigService) {
    this.defaultTenantId = config.getOrThrow<string>('DEFAULT_TENANT_ID');
  }

  /** Run fn with tenantId bound; nested scopes shadow outer ones. */
  runWith<T>(tenantId: string, fn: () => T): T {
    return this.als.run({ tenantId }, fn);
  }

  /** The bound tenant, or the dev-mode default when nothing is bound. */
  get tenantId(): string {
    return this.als.getStore()?.tenantId ?? this.defaultTenantId;
  }

  /** True only when a tenant was bound explicitly (no default involved). */
  get isExplicitlyBound(): boolean {
    return this.als.getStore() !== undefined;
  }
}
