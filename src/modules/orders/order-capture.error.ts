/**
 * Thrown by OrdersService.captureCodOrder for INPUT / grounding failures the
 * caller can fix: invalid phone, missing address, empty items, an unavailable or
 * unpublished product, a foreign image key, or a size not in the product's
 * sizes[]. The message is customer-facing Arabic.
 *
 * Why a dedicated class: the same capture logic is reached from two callers with
 * different error contracts. The agent's capture_order tool only reads `.message`
 * (the LLM phrases the reply), so the class is irrelevant there. The HTTP route
 * POST /admin/orders, however, must turn these into `400 Bad Request` while
 * letting unexpected faults (DB outage, FK violation, …) surface as `500`.
 * Catching this type is how the controller tells the two apart.
 */
export class OrderCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderCaptureError';
  }
}
