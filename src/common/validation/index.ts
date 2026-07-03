import { z } from 'zod';
import { insertAdminUserSchema } from '@/modules/admin/entities/admin-user.entity';
import { insertAgentBehaviorSchema } from '@/modules/agent/entities/agent-behavior.entity';
import { insertConversationEventSchema } from '@/modules/conversations/entities/conversation-event.entity';
import { insertConversationSchema } from '@/modules/conversations/entities/conversation.entity';
import { insertMessageSchema } from '@/modules/conversations/entities/message.entity';
import { insertKnowledgeEntrySchema } from '@/modules/knowledge/entities/knowledge-entry.entity';
import { insertOrderSchema } from '@/modules/orders/entities/order.entity';
import { insertOrderItemSchema } from '@/modules/orders/entities/order-item.entity';
import { insertAdProductLinkSchema } from '@/modules/products/entities/ad-product-link.entity';
import { insertColorSchema } from '@/modules/products/entities/color.entity';
import { insertColorSynonymSchema } from '@/modules/products/entities/color-synonym.entity';
import { insertProductCategorySchema } from '@/modules/products/entities/product-category.entity';
import { insertProductSchema } from '@/modules/products/entities/product.entity';

export * from './parse';

/**
 * Shared write-validation schemas — one create + one update per entity, the
 * single source of truth for what a valid write payload looks like. Services
 * validate every insert/update through these, and the Mastra agent tools will
 * reuse them as their tool input schemas, so validation is defined once here.
 *
 * Each pair is derived from the canonical drizzle-zod `insert*Schema` (which
 * already carries the field refinements — enums, email, the JOD price shape) and
 * then:
 *   - `.omit(...)` the server-managed columns (`id` + the `createdAt`/`updatedAt`
 *     timestamps, plus order_items' `orderId`, which the repository fills in) so
 *     a caller — admin UI or agent — can never set them;
 *   - `.strict()` so an unknown / mistyped / hallucinated key is rejected rather
 *     than silently dropped.
 * The `update*Schema` is the create schema made `.partial()` for PATCH-style
 * writes (every field optional, unknown keys still rejected).
 *
 * A useful side effect: the omitted columns are exactly the `Date`-typed ones,
 * so these schemas are JSON-Schema-serializable and can be handed straight to
 * the agent's tools (`z.date()` is not representable in JSON Schema).
 */

// --- products (control-plane: written by admin, read by the agent) ---
export const createProductSchema = insertProductSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .strict();
export const updateProductSchema = createProductSchema.partial().strict();
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

// --- product_categories (control-plane: clothing categories + attribute schema) ---
export const createProductCategorySchema = insertProductCategorySchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .strict();
export const updateProductCategorySchema = createProductCategorySchema
  .partial()
  .strict();
export type CreateProductCategoryInput = z.infer<
  typeof createProductCategorySchema
>;
export type UpdateProductCategoryInput = z.infer<
  typeof updateProductCategorySchema
>;

// --- ad_product_links (control-plane: maps ad refs to products) ---
export const createAdProductLinkSchema = insertAdProductLinkSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .strict();
export const updateAdProductLinkSchema = createAdProductLinkSchema
  .partial()
  .strict();
export type CreateAdProductLinkInput = z.infer<
  typeof createAdProductLinkSchema
>;
export type UpdateAdProductLinkInput = z.infer<
  typeof updateAdProductLinkSchema
>;

// --- colors (control-plane: the canonical color entity) ---
// is_system is reserved for the seeded system colors (e.g. "__unassigned__") and
// must never be settable through the admin API, or an admin could mint or toggle
// non-deletable system rows. Omit it from both create and update.
export const createColorSchema = insertColorSchema
  .omit({ id: true, createdAt: true, updatedAt: true, isSystem: true })
  .strict();
export const updateColorSchema = createColorSchema.partial().strict();
export type CreateColorInput = z.infer<typeof createColorSchema>;
export type UpdateColorInput = z.infer<typeof updateColorSchema>;

// --- color_synonyms (control-plane) ---
// color_id is a uuid FK to colors; refine it to z.uuid() so a malformed id is
// rejected at the validation boundary (400) instead of reaching SQL as an
// invalid uuid. Existence is then checked in the service for a clean 404.
export const createColorSynonymSchema = insertColorSynonymSchema
  .omit({ id: true, createdAt: true })
  .extend({ colorId: z.uuid() })
  .strict();
export const updateColorSynonymSchema = createColorSynonymSchema
  .partial()
  .strict();
export type CreateColorSynonymInput = z.infer<typeof createColorSynonymSchema>;
export type UpdateColorSynonymInput = z.infer<typeof updateColorSynonymSchema>;

// --- product_image_colors (write payload: set the colors of one product image) ---
// Replaces an image's whole color set; at least one managed color id is required.
export const setImageColorsSchema = z
  .object({ colorIds: z.array(z.uuid()).min(1) })
  .strict();
export type SetImageColorsInput = z.infer<typeof setImageColorsSchema>;

// --- product_image_descriptions (write payload: set one image's description) ---
// The admin-authored text is embedded together with the image (one multimodal
// vector via gemini-embedding-2), so it is trimmed, non-empty, and length-capped
// to keep the embedding input bounded.
export const setImageDescriptionSchema = z
  .object({ description: z.string().trim().min(1).max(1000) })
  .strict();
export type SetImageDescriptionInput = z.infer<
  typeof setImageDescriptionSchema
>;

// --- knowledge_entries (control-plane) ---
export const createKnowledgeEntrySchema = insertKnowledgeEntrySchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .strict();
export const updateKnowledgeEntrySchema = createKnowledgeEntrySchema
  .partial()
  .strict();
export type CreateKnowledgeEntryInput = z.infer<
  typeof createKnowledgeEntrySchema
>;
export type UpdateKnowledgeEntryInput = z.infer<
  typeof updateKnowledgeEntrySchema
>;

// --- admin_users (control-plane) ---
export const createAdminUserSchema = insertAdminUserSchema
  .omit({ id: true, createdAt: true })
  .strict();
export const updateAdminUserSchema = createAdminUserSchema.partial().strict();
export type CreateAdminUserInput = z.infer<typeof createAdminUserSchema>;
export type UpdateAdminUserInput = z.infer<typeof updateAdminUserSchema>;

// --- agent_behavior (control-plane) ---
export const createAgentBehaviorSchema = insertAgentBehaviorSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .strict();
export const updateAgentBehaviorSchema = createAgentBehaviorSchema
  .partial()
  .strict();
export type CreateAgentBehaviorInput = z.infer<
  typeof createAgentBehaviorSchema
>;
export type UpdateAgentBehaviorInput = z.infer<
  typeof updateAgentBehaviorSchema
>;

// --- conversations (runtime: written by the agent) ---
export const createConversationSchema = insertConversationSchema
  .omit({ id: true, createdAt: true, aiStateUpdatedAt: true })
  .strict();
export const updateConversationSchema = createConversationSchema
  .partial()
  .strict();
export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;

// --- conversation_events (runtime: audit trail) ---
export const createConversationEventSchema = insertConversationEventSchema
  .omit({ id: true, createdAt: true })
  .strict();
export type CreateConversationEventInput = z.infer<
  typeof createConversationEventSchema
>;

// --- messages (runtime) ---
export const createMessageSchema = insertMessageSchema
  .omit({ id: true, createdAt: true })
  .strict();
export const updateMessageSchema = createMessageSchema.partial().strict();
export type CreateMessageInput = z.infer<typeof createMessageSchema>;
export type UpdateMessageInput = z.infer<typeof updateMessageSchema>;

// --- orders (runtime) ---
export const createOrderSchema = insertOrderSchema
  .omit({ id: true, createdAt: true })
  .strict();
export const updateOrderSchema = createOrderSchema.partial().strict();
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;

// --- order_items (runtime; `orderId` is supplied by the repository) ---
export const createOrderItemSchema = insertOrderItemSchema
  .omit({ id: true, orderId: true })
  .strict();
export const updateOrderItemSchema = createOrderItemSchema.partial().strict();
export type CreateOrderItemInput = z.infer<typeof createOrderItemSchema>;
export type UpdateOrderItemInput = z.infer<typeof updateOrderItemSchema>;
