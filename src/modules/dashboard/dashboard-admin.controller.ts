/**
 * DashboardAdminController — one read-only aggregate endpoint for the admin
 * overview page, so the panel renders from server-side SQL counts instead of
 * paging raw rows and counting them in the browser.
 */

import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { BEARER_AUTH_NAME } from '@/core/openapi/openapi';
import { DashboardService } from './dashboard.service';
import {
  DashboardStatsDto,
  type DashboardStats,
} from './dto/dashboard-stats.dto';

@ApiTags('Dashboard')
@Controller('admin/dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'editor')
@ApiBearerAuth(BEARER_AUTH_NAME)
export class DashboardAdminController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @ApiOperation({
    summary: 'Overview aggregates for the admin dashboard',
    description:
      'Server-side SQL counts in one round-trip: product totals (all / ' +
      'published), order totals per status plus a per-day series for the ' +
      'chart window (staff-local calendar days), and conversation totals ' +
      'per handler state plus the escalated count.',
  })
  @ApiOkResponse({ type: DashboardStatsDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  getStats(): Promise<DashboardStats> {
    return this.dashboard.getStats();
  }
}
