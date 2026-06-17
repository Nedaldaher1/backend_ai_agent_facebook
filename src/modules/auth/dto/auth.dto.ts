import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ADMIN_ROLES } from '@/modules/admin/entities/admin-user.entity';

/**
 * Auth request/response contracts for the admin panel. Zod is the single source
 * of truth: each `*Schema` validates the HTTP payload (via `ZodValidationPipe`)
 * and the matching `*Dto` (nestjs-zod `createZodDto`) documents the same shape in
 * the OpenAPI/Scalar docs. A response shape never carries the password hash.
 */

export const registerSchema = z
  .object({
    name: z.string().min(1),
    email: z.email(),
    password: z.string().min(8),
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.email(),
    password: z.string().min(1),
  })
  .strict();

/** Public view of an admin account — never includes the password hash. */
export const userResponseSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string().nullable(),
  role: z.enum(ADMIN_ROLES),
});

export const authResponseSchema = z.object({
  accessToken: z.string(),
  user: userResponseSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UserResponse = z.infer<typeof userResponseSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;

// --- OpenAPI DTOs (documentation only; validation stays with the schemas) ---
export class RegisterDto extends createZodDto(registerSchema) {}
export class LoginDto extends createZodDto(loginSchema) {}
export class UserResponseDto extends createZodDto(userResponseSchema) {}
export class AuthResponseDto extends createZodDto(authResponseSchema) {}
