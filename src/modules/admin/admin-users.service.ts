import { Injectable, NotFoundException } from '@nestjs/common';
import type { ListOptions } from '@/common/types/query';
import {
  createAdminUserSchema,
  parseOrThrow,
  updateAdminUserSchema,
  type CreateAdminUserInput,
  type UpdateAdminUserInput,
} from '@/common/validation';
import { AdminUsersRepository } from './admin-users.repository';
import type { AdminUser } from './entities/admin-user.entity';

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

  create(input: CreateAdminUserInput): Promise<AdminUser> {
    const data = parseOrThrow(createAdminUserSchema, input);
    return this.repo.insert(data);
  }

  async update(id: string, patch: UpdateAdminUserInput): Promise<AdminUser> {
    const data = parseOrThrow(updateAdminUserSchema, patch);
    const row = await this.repo.updateById(id, data);
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
