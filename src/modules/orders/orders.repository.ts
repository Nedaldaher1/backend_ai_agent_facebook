import { Injectable } from '@nestjs/common';

/**
 * Runtime table owner (orders, order_items) — written by the agent on COD
 * order capture. TODO: inject DRIZZLE; totals use numeric(10,3) JOD, no floats.
 */
@Injectable()
export class OrdersRepository {}
