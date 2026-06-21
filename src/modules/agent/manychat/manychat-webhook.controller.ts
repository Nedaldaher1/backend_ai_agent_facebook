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
import { AgentService, type IncomingMessage } from '../agent.service';
import { DebounceService } from '../debounce/debounce.service';
import { mergeTurns } from '../debounce/merge-turns';
import { toDynamicBlock, type CardProduct } from './manychat.formatter';
import { ManyChatSenderService } from './manychat-sender.service';
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
    private readonly debounce: DebounceService,
    private readonly sender: ManyChatSenderService,
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
    const reply = await this.agent.handleMessage(this.toIncoming(dto));
    const products = await this.enrichWithImages(reply.products);
    return toDynamicBlock({ reply: reply.reply, products });
  }

  /**
   * Async variant (AIA-30): ACK 202 immediately, debounce the customer's rapid
   * messages into one turn, then deliver the reply via the ManyChat Send API.
   * Use this when the ManyChat flow sends the reply out-of-band rather than
   * rendering the HTTP response as a Dynamic Block.
   */
  @Post('manychat/async')
  @HttpCode(202)
  @ApiOperation({
    summary: 'ManyChat External Request (async) → 202, reply via Send API',
    description:
      'Buffers rapid messages per subscriber (debounce), runs the agent once on ' +
      'the merged turn, and pushes the Dynamic Block via the ManyChat Send API. ' +
      'Returns 202 immediately. messageId is the idempotency key.',
  })
  handleAsync(
    @Body(new ZodValidationPipe(webhookSchema)) dto: WebhookBody,
  ): { status: 'accepted' } {
    this.debounce.enqueue(dto.contactId, this.toIncoming(dto), (items) =>
      this.processBatch(dto.contactId, items),
    );
    return { status: 'accepted' };
  }

  /** Map a validated ManyChat body to the agent's IncomingMessage. */
  private toIncoming(dto: WebhookBody): IncomingMessage {
    return {
      contactId: dto.contactId,
      text: dto.text,
      lastImageUrl: dto.lastImageUrl,
      adRef: dto.adRef,
      name: dto.name,
      channel: dto.channel,
      externalMessageId: dto.messageId,
    };
  }

  /** Run the agent on a merged batch and deliver the reply via the Send API. */
  private async processBatch(
    contactId: string,
    items: IncomingMessage[],
  ): Promise<void> {
    const reply = await this.agent.handleMessage(mergeTurns(items));
    const products = await this.enrichWithImages(reply.products);
    const block = toDynamicBlock({ reply: reply.reply, products });
    await this.sender.sendReply(contactId, block);
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
