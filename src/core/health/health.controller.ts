import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';

@Controller('health')
export class HealthController {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  @Get()
  async check() {
    await this.db.execute(sql`select 1`);
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
