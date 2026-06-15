import { Injectable, NotFoundException } from '@nestjs/common';
import type { ListOptions } from '@/common/types/query';
import { AdminUsersRepository } from './admin-users.repository';
import type { AdminUser, NewAdminUser } from './entities/admin-user.entity';

/**
 * Admin-account logic. CRUD over admin_users; the agent never touches this.
 * password_hash is passed through unchanged — hashing and auth live elsewhere.
 */
@Injectable()
export class AdminUsersService {
  constructor(private readonly repo: AdminUsersRepository) {}

  list(opts?: ListOptions): Promise<AdminUser[]> {
    return this.repo.list(opts);
  }

  async getById(id: string): Promise<AdminUser> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException(`Admin user ${id} not found`);
    }
    return row;
  }

  getByEmail(email: string): Promise<AdminUser | undefined> {
    return this.repo.findByEmail(email);
  }

  create(input: NewAdminUser): Promise<AdminUser> {
    return this.repo.insert(input);
  }

  async update(id: string, patch: Partial<NewAdminUser>): Promise<AdminUser> {
    const row = await this.repo.updateById(id, patch);
    if (!row) {
      throw new NotFoundException(`Admin user ${id} not found`);
    }
    return row;
  }

  async delete(id: string): Promise<AdminUser> {
    const row = await this.repo.deleteById(id);
    if (!row) {
      throw new NotFoundException(`Admin user ${id} not found`);
    }
    return row;
  }
}
