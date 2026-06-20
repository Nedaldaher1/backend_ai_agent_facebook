import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { addJod, milliToJod, multiplyJodByQty, sumJod } from '@/common/money.util';
import type { ListOptions } from '@/common/types/query';
import {
  createOrderItemSchema,
  createOrderSchema,
  parseOrThrow,
  type CreateOrderInput,
  type CreateOrderItemInput,
} from '@/common/validation';
import { ProductsService } from '@/modules/products/products.service';
import { OrdersRepository, type NewOrderItemInput } from './orders.repository';
import {
  ORDER_STATUSES,
  type NewOrder,
  type Order,
} from './entities/order.entity';
import type { OrderItem } from './entities/order-item.entity';
import { DELIVERY_FEE_MILLI } from './delivery-fees';
import { OrderCaptureError } from './order-capture.error';
import { normalizeJordanMobile } from './phone.util';

/** One item the customer chose: a product + the exact image (model/color) variant. */
export interface CaptureOrderItemInput {
  productId: string;
  /** A key in products.image_urls — pins the chosen model + color variant. */
  storageKey: string;
  /** Per-item size; falls back to the order-level unifiedSize when absent. */
  size?: string;
  qty: number;
}

/**
 * Fully-resolved capture input. Identity (`conversationId`) and `source` come
 * from a TRUSTED source — the request context on the agent path, or the
 * authenticated admin on POST /admin/orders — NEVER from LLM input. No prices
 * appear here: all money is derived server-side from the catalog + delivery-fee
 * config.
 */
export interface CaptureOrderInput {
  /** Conversation this order came from; null for a standalone manual admin order. */
  conversationId: string | null;
  source: 'messenger' | 'whatsapp';
  /** Raw phone; validated + normalized to +9627XXXXXXXX inside. */
  phone: string;
  /** Free-text delivery address (the whole destination as the customer gave it). */
  address: string;
  /** Order-level fallback size for items with no explicit size. */
  unifiedSize?: string;
  items: CaptureOrderItemInput[];
}

/** One persisted line, echoed back so the agent reads accurate numbers. */
export interface CaptureOrderLine {
  productId: string;
  storageKey: string;
  productName: string;
  colorName: string | null;
  size: string | null;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
}

/** Structured capture result: the rows plus a confirmation for the agent. */
export interface CaptureOrderResult {
  order: Order;
  items: OrderItem[];
  confirmation: {
    orderId: string;
    status: string;
    source: string;
    phone: string;
    address: string;
    lines: CaptureOrderLine[];
    subtotal: string;
    deliveryFee: string;
    total: string;
    currency: 'JOD';
  };
}

/**
 * COD order-draft capture and lifecycle. The agent module calls this (never the
 * repository) to create drafts, attach line items, and advance status.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly repo: OrdersRepository,
    // Cross-module via the exported service only — the capture flow reads the
    // catalog (price/availability/colors) through ProductsService.
    private readonly products: ProductsService,
  ) {}

  // --- orders ---

  list(opts?: ListOptions): Promise<Order[]> {
    return this.repo.list(opts);
  }

  async getById(id: string): Promise<Order> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException(`Order ${id} not found`);
    }
    return row;
  }

  listByConversation(conversationId: string): Promise<Order[]> {
    return this.repo.listByConversation(conversationId);
  }

  create(input: CreateOrderInput): Promise<Order> {
    const data = parseOrThrow(createOrderSchema, input);
    return this.repo.insert(data);
  }

  async updateStatus(id: string, status: string): Promise<Order> {
    this.assertValidStatus(status);
    const row = await this.repo.updateStatus(id, status);
    if (!row) {
      throw new NotFoundException(`Order ${id} not found`);
    }
    return row;
  }

  /** Guard the free-form text column against values outside the status enum. */
  private assertValidStatus(status: string): void {
    if (!z.enum(ORDER_STATUSES).safeParse(status).success) {
      throw new BadRequestException(
        `Invalid order status "${status}"; allowed: ${ORDER_STATUSES.join(', ')}`,
      );
    }
  }

  // --- order_items ---

  /** Attach line items to an existing order; each item is validated. */
  createItems(
    orderId: string,
    items: CreateOrderItemInput[],
  ): Promise<OrderItem[]> {
    const data = items.map((item) => parseOrThrow(createOrderItemSchema, item));
    return this.repo.insertItems(orderId, data);
  }

  listItems(orderId: string): Promise<OrderItem[]> {
    return this.repo.listItemsByOrder(orderId);
  }

  // --- COD capture (agent write path) ---

  /**
   * Capture a full COD order and persist it (header + line items) atomically.
   * Called by the capture_order tool (agent path) and by POST /admin/orders
   * (admin/test path); the caller supplies NO money — see the grounding rules.
   *
   * Grounding rules (CLAUDE.md §3): the LLM supplies no money. For EACH item we
   * resolve server-side from the catalog — confirm the product is published and
   * available, confirm the chosen image (storage_key) belongs to it, resolve the
   * effective size (per-item → unified → single-size token) and confirm it is in
   * the product's sizes[], snapshot the catalog unit price, and snapshot the
   * product/color names. Money is then derived: subtotal = Σ line totals,
   * delivery_fee a flat configured fee, total = subtotal + delivery_fee,
   * all in integer milli-JOD. ANY validation failure aborts the whole order by
   * throwing an OrderCaptureError with a clear Arabic message (the admin route
   * maps it to 400) — no partial orders are ever written.
   */
  async captureCodOrder(input: CaptureOrderInput): Promise<CaptureOrderResult> {
    // --- header validation ---
    const phone = normalizeJordanMobile(input.phone);
    if (!phone) {
      throw new OrderCaptureError(
        'رقم الهاتف غير صالح. أرسلي رقم موبايل أردني يبدأ بـ 07 (مثال: 0791234567).',
      );
    }
    const address = input.address?.trim();
    if (!address) {
      throw new OrderCaptureError('عنوان التوصيل مطلوب.');
    }
    if (!input.items || input.items.length === 0) {
      throw new OrderCaptureError('لا يمكن تسجيل طلب بدون منتجات.');
    }

    // --- per-item server-side resolution (reads only; nothing written yet) ---
    const lines: CaptureOrderLine[] = [];
    const itemRows: NewOrderItemInput[] = [];
    for (const item of input.items) {
      // One availability read returns the published product (price, name,
      // sizes, image keys) so it is fetched only once.
      const avail = await this.products.checkAvailability(item.productId);
      const product = avail.product;
      if (!product) {
        throw new OrderCaptureError(
          'المنتج المطلوب غير متوفر أو غير منشور. لا يمكن إتمام الطلب.',
        );
      }
      if (!avail.available) {
        throw new OrderCaptureError(
          `المنتج "${product.name}" غير متوفر حالياً. لا يمكن إتمام الطلب.`,
        );
      }
      // The chosen image must belong to this product.
      if (!(product.imageUrls ?? []).includes(item.storageKey)) {
        throw new OrderCaptureError(
          `الصورة المختارة غير موجودة للمنتج "${product.name}". اختاري صورة من صور المنتج.`,
        );
      }
      // Effective size: per-item → order-level unified → the only size token of
      // a single-size/free-size product. Then validate against the catalog.
      const sizes = product.sizes ?? [];
      let size: string | null = item.size ?? input.unifiedSize ?? null;
      if (size === null && sizes.length === 1) {
        size = sizes[0];
      }
      if (size === null) {
        if (sizes.length > 0) {
          throw new OrderCaptureError(
            `يرجى تحديد المقاس للمنتج "${product.name}". المقاسات المتوفرة: ${sizes.join('، ')}.`,
          );
        }
      } else if (!sizes.includes(size)) {
        throw new OrderCaptureError(
          `المقاس "${size}" غير متوفر للمنتج "${product.name}". المقاسات المتوفرة: ${sizes.join('، ')}.`,
        );
      }

      // Price snapshot FROM THE CATALOG (never from the LLM) + line total.
      const unitPrice = product.priceJod;
      const lineTotal = multiplyJodByQty(unitPrice, item.qty);
      const colorName = await this.products.getImageColorName(
        item.productId,
        item.storageKey,
      );

      lines.push({
        productId: item.productId,
        storageKey: item.storageKey,
        productName: product.name,
        colorName,
        size,
        quantity: item.qty,
        unitPrice,
        lineTotal,
      });
      itemRows.push({
        productId: item.productId,
        storageKey: item.storageKey,
        size,
        qty: item.qty,
        unitPrice,
        lineTotal,
        productName: product.name,
        colorName,
      });
    }

    // --- money: server-derived from catalog + flat delivery fee ---
    const subtotal = sumJod(lines.map((l) => l.lineTotal));
    const deliveryFee = milliToJod(DELIVERY_FEE_MILLI);
    const total = addJod(subtotal, deliveryFee);

    // --- persist header + items in one transaction ---
    const orderRow: NewOrder = {
      conversationId: input.conversationId,
      source: input.source,
      phone,
      address,
      unifiedSize: input.unifiedSize ?? null,
      subtotal,
      deliveryFee,
      total,
      currency: 'JOD',
      status: 'draft',
    };

    const { order, items } = await this.repo.createWithItems(orderRow, itemRows);

    return {
      order,
      items,
      confirmation: {
        orderId: order.id,
        status: order.status,
        source: order.source,
        phone,
        address,
        lines,
        subtotal,
        deliveryFee,
        total,
        currency: 'JOD',
      },
    };
  }
}
