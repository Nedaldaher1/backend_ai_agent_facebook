/**
 * ManyChat integration surface (AIA-32): receives a ManyChat External Request and
 * returns a Dynamic Block (v2) with the reply text + a product-card gallery.
 *
 * The body mirrors the temp /agent/message contract plus `messageId` (the
 * idempotency key). VERIFY the External Request body field names and the Dynamic
 * Block response shape against the connected ManyChat account before going live;
 * the live round-trip cannot be exercised here.
 */

import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { ProductsService } from '@/modules/products/products.service';
import { AgentService } from '../agent.service';
import { toDynamicBlock, type CardProduct } from './manychat.formatter';
import type { ManyChatDynamicBlock } from './manychat.types';

const webhookSchema = z.object({
  contactId: z.string().min(1),
  text: z.string().min(1),
  lastImageUrl: z.string().url().optional(),
  adRef: z.string().optional(),
  name: z.string().optional(),
  channel: z.enum(['messenger', 'whatsapp']).optional(),
  // ManyChat/Facebook message id — the idempotency key for this turn.
  messageId: z.string().optional(),
});
type WebhookBody = z.infer<typeof webhookSchema>;

@ApiTags('ManyChat')
@Controller('webhook')
export class ManyChatWebhookController {
  constructor(
    private readonly agent: AgentService,
    private readonly products: ProductsService,
  ) {}

  @Post('manychat')
  @HttpCode(200)
  @ApiOperation({
    summary: 'ManyChat External Request → Dynamic Block (v2)',
    description:
      'Runs the sales agent on the inbound turn and returns a ManyChat Dynamic ' +
      'Block (v2): reply text plus a product-card gallery (with resolved image ' +
      'URLs). messageId is used as the idempotency key.',
  })
  async handle(
    @Body(new ZodValidationPipe(webhookSchema)) dto: WebhookBody,
  ): Promise<ManyChatDynamicBlock> {
    const reply = await this.agent.handleMessage({
      contactId: dto.contactId,
      text: dto.text,
      lastImageUrl: dto.lastImageUrl,
      adRef: dto.adRef,
      name: dto.name,
      channel: dto.channel,
      externalMessageId: dto.messageId,
    });

    const products = await this.enrichWithImages(reply.products);
    return toDynamicBlock({ reply: reply.reply, products });
  }

  /**
   * Resolve the primary image URL for each card. Best-effort and per-product:
   * a media lookup failure leaves that card image-less rather than failing the
   * whole reply.
   */
  private async enrichWithImages(
    products: Array<{ id: string; name: string; price: string }> | undefined,
  ): Promise<CardProduct[] | undefined> {
    if (!products || products.length === 0) return undefined;
    return Promise.all(
      products.map(async (p) => {
        let imageUrl: string | undefined;
        try {
          const media = await this.products.getMedia(p.id);
          imageUrl = media[0]?.url;
        } catch {
          imageUrl = undefined;
        }
        return { id: p.id, name: p.name, price: p.price, imageUrl };
      }),
    );
  }
}
