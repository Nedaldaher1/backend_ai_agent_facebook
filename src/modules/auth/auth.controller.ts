import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  type AuthUser,
} from '@/common/decorators/current-user.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { BEARER_AUTH_NAME } from '@/core/openapi/openapi';
import { AuthService } from './auth.service';
import { RegistrationEnabledGuard } from './registration-enabled.guard';
import {
  AuthResponseDto,
  LoginDto,
  RegisterDto,
  UserResponseDto,
  loginSchema,
  registerSchema,
  type LoginInput,
  type RegisterInput,
} from './dto/auth.dto';

/**
 * HTTP surface for admin authentication. `register` and `login` are public;
 * `me` is protected by `JwtAuthGuard`. Bodies are validated by `ZodValidationPipe`
 * against the auth zod schemas (the same schemas the `*Dto` classes document).
 */
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @HttpCode(201)
  @UseGuards(RegistrationEnabledGuard)
  @ApiOperation({
    summary: 'Create an admin account (gated)',
    description:
      'Self-registration for the admin panel, DISABLED by default. Enable it by ' +
      'setting ALLOW_REGISTRATION=true to bootstrap the first admin (there is no ' +
      'seed mechanism), then turn it back off; otherwise this returns 403. Hashes ' +
      'the password, creates the admin_users row, and returns a signed JWT plus ' +
      'the public user.',
  })
  @ApiBody({ type: RegisterDto })
  @ApiCreatedResponse({
    description: 'Account created; JWT issued.',
    type: AuthResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Registration is disabled (ALLOW_REGISTRATION is not "true").',
  })
  @ApiConflictResponse({ description: 'Email is already registered.' })
  register(@Body(new ZodValidationPipe(registerSchema)) dto: RegisterInput) {
    return this.auth.register(dto);
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Authenticate an admin and return a JWT' })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({
    description: 'Authenticated; JWT issued.',
    type: AuthResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password.' })
  login(@Body(new ZodValidationPipe(loginSchema)) dto: LoginInput) {
    return this.auth.login(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth(BEARER_AUTH_NAME)
  @ApiOperation({ summary: 'Get the currently authenticated admin' })
  @ApiOkResponse({ description: 'The current admin.', type: UserResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.sub);
  }
}
