import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  @Get()
  @ApiOperation({
    summary: 'Liveness + database connectivity check',
    description:
      'Runs `select 1` against PostgreSQL and reports service status.',
  })
  @ApiOkResponse({
    description: 'Service is up and the database is reachable.',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        timestamp: {
          type: 'string',
          format: 'date-time',
          example: '2026-06-15T12:00:00.000Z',
        },
      },
    },
  })
  async check() {
    await this.db.execute(sql`select 1`);
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
