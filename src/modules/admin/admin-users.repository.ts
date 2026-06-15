import { Inject, Injectable } from '@nestjs/common';
import { asc, desc, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { normalizeListOptions, type ListOptions } from '@/common/types/query';
import {
  adminUsers,
  type AdminUser,
  type NewAdminUser,
} from './entities/admin-user.entity';

/**
 * Sole owner of admin_users SQL. Query-builder only. password_hash is stored as
 * received — hashing belongs to the auth layer, not this repository.
 */
@Injectable()
export class AdminUsersRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async list(opts: ListOptions = {}): Promise<AdminUser[]> {
    const { limit, offset, orderBy } = normalizeListOptions(opts);
    const direction = orderBy === 'asc' ? asc : desc;
    return this.db
      .select()
      .from(adminUsers)
      .orderBy(direction(adminUsers.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async findById(id: string): Promise<AdminUser | undefined> {
    const [row] = await this.db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.id, id))
      .limit(1);
    return row;
  }

  async findByEmail(email: string): Promise<AdminUser | undefined> {
    const [row] = await this.db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.email, email))
      .limit(1);
    return row;
  }

  async insert(input: NewAdminUser): Promise<AdminUser> {
    const [row] = await this.db.insert(adminUsers).values(input).returning();
    return row;
  }

  async updateById(
    id: string,
    patch: Partial<NewAdminUser>,
  ): Promise<AdminUser | undefined> {
    const [row] = await this.db
      .update(adminUsers)
      .set(patch)
      .where(eq(adminUsers.id, id))
      .returning();
    return row;
  }

  async deleteById(id: string): Promise<AdminUser | undefined> {
    const [row] = await this.db
      .delete(adminUsers)
      .where(eq(adminUsers.id, id))
      .returning();
    return row;
  }
}
