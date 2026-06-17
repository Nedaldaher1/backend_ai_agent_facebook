import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { AdminUsersService } from '@/modules/admin/admin-users.service';
import {
  ADMIN_ROLES,
  type AdminUser,
} from '@/modules/admin/entities/admin-user.entity';
import type {
  AuthResponse,
  LoginInput,
  RegisterInput,
  UserResponse,
} from './dto/auth.dto';

const BCRYPT_ROUNDS = 10;

/**
 * Admin authentication: open self-registration, password login, and
 * current-user lookup. Password hashing lives here (bcrypt); all account
 * persistence is delegated to `AdminUsersService`, which stays the single owner
 * of admin_users SQL.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly adminUsers: AdminUsersService,
    private readonly jwt: JwtService,
  ) {}

  async register(input: RegisterInput): Promise<AuthResponse> {
    const existing = await this.adminUsers.getByEmail(input.email);
    if (existing) {
      throw new ConflictException('Email is already registered');
    }
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const user = await this.adminUsers.create({
      email: input.email,
      name: input.name,
      passwordHash,
    });
    return this.issueToken(user);
  }

  async login(input: LoginInput): Promise<AuthResponse> {
    const user = await this.adminUsers.getByEmail(input.email);
    // A generic 401 for both "no such email" and "wrong password" avoids leaking
    // which emails are registered.
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return this.issueToken(user);
  }

  async me(userId: string): Promise<UserResponse> {
    return this.toPublic(await this.adminUsers.getById(userId));
  }

  private async issueToken(user: AdminUser): Promise<AuthResponse> {
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
    return { accessToken, user: this.toPublic(user) };
  }

  private toPublic(user: AdminUser): UserResponse {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: this.normalizeRole(user.role),
    };
  }

  /** The role column is free-form text; collapse anything unexpected to 'admin'. */
  private normalizeRole(role: string): UserResponse['role'] {
    return (ADMIN_ROLES as readonly string[]).includes(role)
      ? (role as UserResponse['role'])
      : 'admin';
  }
}
