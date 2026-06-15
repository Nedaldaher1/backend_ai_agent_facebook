import { Module } from '@nestjs/common';
import { AdminUsersRepository } from './admin-users.repository';
import { AdminUsersService } from './admin-users.service';

/**
 * admin_users domain (control-plane accounts). No controller yet — admin auth
 * routes land later behind a guard. The service is exported so other modules
 * (e.g. created_by lookups) can read accounts through it.
 */
@Module({
  providers: [AdminUsersService, AdminUsersRepository],
  exports: [AdminUsersService],
})
export class AdminModule {}
