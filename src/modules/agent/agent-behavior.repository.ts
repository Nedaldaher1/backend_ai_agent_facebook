import { Injectable } from '@nestjs/common';
import { asc, desc, eq, ne } from 'drizzle-orm';
import { TenantDb } from '@/core/tenancy/tenant-db';
import { normalizeListOptions, type ListOptions } from '@/common/types/query';
import {
  agentBehavior,
  type AgentBehavior,
  type NewAgentBehavior,
} from './entities/agent-behavior.entity';

/**
 * Sole owner of agent_behavior SQL. Query-builder only. The agent reads the
 * single active row to build its system prompt; the admin edits these.
 */
@Injectable()
export class AgentBehaviorRepository {
  constructor(private readonly tenantDb: TenantDb) {}

  async list(opts: ListOptions = {}): Promise<AgentBehavior[]> {
    const { limit, offset, orderBy } = normalizeListOptions(opts);
    const direction = orderBy === 'asc' ? asc : desc;
    return this.tenantDb.tx((db) =>
      db
        .select()
        .from(agentBehavior)
        .orderBy(direction(agentBehavior.updatedAt))
        .limit(limit)
        .offset(offset),
    );
  }

  /** Most-recently-updated active behavior, or undefined if none is active. */
  async findActive(): Promise<AgentBehavior | undefined> {
    return this.tenantDb.tx(async (db) => {
      const [row] = await db
        .select()
        .from(agentBehavior)
        .where(eq(agentBehavior.isActive, true))
        .orderBy(desc(agentBehavior.updatedAt))
        .limit(1);
      return row;
    });
  }

  async findById(id: string): Promise<AgentBehavior | undefined> {
    return this.tenantDb.tx(async (db) => {
      const [row] = await db
        .select()
        .from(agentBehavior)
        .where(eq(agentBehavior.id, id))
        .limit(1);
      return row;
    });
  }

  async insert(input: NewAgentBehavior): Promise<AgentBehavior> {
    return this.tenantDb.tx(async (db) => {
      const [row] = await db
        .insert(agentBehavior)
        .values(input)
        .returning();
      return row;
    });
  }

  async updateById(
    id: string,
    patch: Partial<NewAgentBehavior>,
  ): Promise<AgentBehavior | undefined> {
    return this.tenantDb.tx(async (db) => {
      const [row] = await db
        .update(agentBehavior)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(agentBehavior.id, id))
        .returning();
      return row;
    });
  }

  async deleteById(id: string): Promise<AgentBehavior | undefined> {
    return this.tenantDb.tx(async (db) => {
      const [row] = await db
        .delete(agentBehavior)
        .where(eq(agentBehavior.id, id))
        .returning();
      return row;
    });
  }

  /**
   * Make exactly one row active: deactivate every other row, then activate the
   * target. Wrapped in a transaction so there is never zero or two winners.
   * Returns the activated row, or undefined if the id does not exist.
   */
  async setActive(id: string): Promise<AgentBehavior | undefined> {
    return this.tenantDb.tx(async (tx) => {
      await tx
        .update(agentBehavior)
        .set({ isActive: false, updatedAt: new Date() })
        .where(ne(agentBehavior.id, id));

      const [row] = await tx
        .update(agentBehavior)
        .set({ isActive: true, updatedAt: new Date() })
        .where(eq(agentBehavior.id, id))
        .returning();
      return row;
    });
  }
}
