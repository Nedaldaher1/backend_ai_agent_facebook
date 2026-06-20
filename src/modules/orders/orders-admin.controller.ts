import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { BEARER_AUTH_NAME } from '@/core/openapi/openapi';
import { OrdersService } from './orders.service';
import { OrderCaptureError } from './order-capture.error';
import {
  CreateOrderDto,
  createOrderBodySchema,
  OrderDto,
  OrderWithItemsDto,
  UpdateOrderStatusDto,
  updateOrderStatusSchema,
  type CreateOrderBody,
  type UpdateOrderStatusInput,
} from './dto/order.dto';
import type { Order } from './entities/order.entity';
import type { OrderItem } from './entities/order-item.entity';

/** Pagination + ordering query for the orders list. */
const ordersListQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().optional(),
    offset: z.coerce.number().int().min(0).optional(),
    orderBy: z.enum(['asc', 'desc']).optional(),
  })
  .strict();
type OrdersListQuery = z.infer<typeof ordersListQuerySchema>;

/** An order together with its line items — the GET /admin/orders/:id shape. */
type OrderWithItems = Order & { items: OrderItem[] };

/**
 * Admin surface for `orders` — the COD drafts the agent captures.
 *
 * In production orders originate from the agent (the capture_order tool). This
 * surface lets staff review them and advance the COD lifecycle, and also exposes
 * a manual/test create route that reuses the SAME grounded capture logic (no
 * prices are accepted from the client). All routes require a valid Bearer JWT
 * with role `admin` or `editor`.
 *
 * Route layout:
 *   POST  /admin/orders            → create via the grounded capture flow (admin/test)
 *   GET   /admin/orders            → list (newest first; paginated)
 *   GET   /admin/orders/:id        → one order with its line items
 *   PATCH /admin/orders/:id/status → advance the COD lifecycle status
 */
@ApiTags('Orders')
@Controller('admin/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'editor')
@ApiBearerAuth(BEARER_AUTH_NAME)
export class OrdersAdminController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create an order (admin / test)',
    description:
      'Creates a COD order through the SAME grounded flow the agent uses ' +
      '(OrdersService.captureCodOrder): the server resolves price, colour and ' +
      'size from the catalog and derives all money — the body carries no prices. ' +
      'Intended for manual admin entry and for testing the orders flow without an ' +
      'LLM round-trip. Omit `conversationId` for a standalone order. Grounding ' +
      'failures (bad phone, unavailable product, invalid size, foreign image key) ' +
      'return 400 with an Arabic message.',
  })
  @ApiBody({ type: CreateOrderDto })
  @ApiCreatedResponse({
    description: 'The created order with its line items.',
    type: OrderWithItemsDto,
  })
  @ApiBadRequestResponse({ description: 'Validation or grounding failure.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  async create(
    @Body(new ZodValidationPipe(createOrderBodySchema)) dto: CreateOrderBody,
  ): Promise<OrderWithItems> {
    try {
      const { order, items } = await this.orders.captureCodOrder({
        conversationId: dto.conversationId ?? null,
        source: dto.source ?? 'messenger',
        phone: dto.phone,
        address: dto.address,
        unifiedSize: dto.unifiedSize,
        items: dto.items.map((i) => ({
          productId: i.productId,
          storageKey: i.storageKey,
          size: i.size,
          // qty is already defaulted to 1 by zod (createOrderBodySchema).
          qty: i.qty,
        })),
      });
      return { ...order, items };
    } catch (err) {
      // Grounding failures are user-fixable → 400 with the Arabic message,
      // wrapped as a { message } object to match the project's other 400s
      // (parseOrThrow). Anything else (DB outage, FK violation, …) propagates
      // unchanged → 500 (the global filter hides its internals).
      if (err instanceof OrderCaptureError) {
        throw new BadRequestException({ message: err.message });
      }
      throw err;
    }
  }

  @Get()
  @ApiOperation({
    summary: 'List orders (admin)',
    description:
      'Paginated list of captured COD orders, newest first by default. Pass ' +
      '`orderBy=asc` for oldest first.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiQuery({ name: 'orderBy', required: false, enum: ['asc', 'desc'] })
  @ApiOkResponse({ description: 'List of orders.', type: [OrderDto] })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  list(
    @Query(new ZodValidationPipe(ordersListQuerySchema)) query: OrdersListQuery,
  ): Promise<Order[]> {
    return this.orders.list({
      limit: query.limit,
      offset: query.offset,
      orderBy: query.orderBy,
    });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get an order with its line items',
    description:
      'Returns the order header (customer phone/address, money snapshots and ' +
      'status) together with its line items (each a chosen product image with ' +
      'its price/colour snapshots).',
  })
  @ApiOkResponse({
    description: 'The order and its line items.',
    type: OrderWithItemsDto,
  })
  @ApiNotFoundResponse({ description: 'No order exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrderWithItems> {
    const order = await this.orders.getById(id);
    const items = await this.orders.listItems(id);
    return { ...order, items };
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Update an order status',
    description:
      'Advances the COD lifecycle status. Allowed values: draft, confirmed, ' +
      'fulfilled, canceled. Any other value is rejected (400).',
  })
  @ApiBody({ type: UpdateOrderStatusDto })
  @ApiOkResponse({ description: 'Order status updated.', type: OrderDto })
  @ApiBadRequestResponse({ description: 'Invalid status value.' })
  @ApiNotFoundResponse({ description: 'No order exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateOrderStatusSchema))
    dto: UpdateOrderStatusInput,
  ): Promise<Order> {
    return this.orders.updateStatus(id, dto.status);
  }
}
