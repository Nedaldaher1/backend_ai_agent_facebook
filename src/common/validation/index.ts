import { z } from 'zod';
import { insertAdminUserSchema } from '@/modules/admin/entities/admin-user.entity';
import { insertAgentBehaviorSchema } from '@/modules/agent/entities/agent-behavior.entity';
import { insertConversationSchema } from '@/modules/conversations/entities/conversation.entity';
import { insertMessageSchema } from '@/modules/conversations/entities/message.entity';
import { insertKnowledgeEntrySchema } from '@/modules/knowledge/entities/knowledge-entry.entity';
import { insertOrderSchema } from '@/modules/orders/entities/order.entity';
import { insertOrderItemSchema } from '@/modules/orders/entities/order-item.entity';
import { insertColorSynonymSchema } from '@/modules/products/entities/color-synonym.entity';
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

// --- color_synonyms (control-plane) ---
export const createColorSynonymSchema = insertColorSynonymSchema
  .omit({ id: true, createdAt: true })
  .strict();
export const updateColorSynonymSchema = createColorSynonymSchema
  .partial()
  .strict();
export type CreateColorSynonymInput = z.infer<typeof createColorSynonymSchema>;
export type UpdateColorSynonymInput = z.infer<typeof updateColorSynonymSchema>;

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
  .omit({ id: true, createdAt: true })
  .strict();
export const updateConversationSchema = createConversationSchema
  .partial()
  .strict();
export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;

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
