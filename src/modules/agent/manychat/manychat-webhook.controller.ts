/**
 * ManyChat integration surface (AIA-32): receives a ManyChat External Request and
 * returns a Dynamic Block (v2) with the reply text + a product-card gallery.
 *
 * Two routes:
 *  POST /webhook/manychat        — SYNC: runs the agent and returns a Dynamic Block
 *                                   in the HTTP body (≤10 s; ManyChat hard timeout).
 *  POST /webhook/manychat/async  — ASYNC: ACKs 202 immediately, debounces rapid
 *                                   messages, then delivers via the Send API.
 *
 * CRITICAL (WS4): the sync handler NEVER returns 5xx. Any internal failure is
 * caught and a valid v2 Dynamic Block with a graceful Arabic fallback message is
 * returned as HTTP 200 so ManyChat's automation is never halted by our errors.
 *
 * SECURITY (WS4b): both routes are guarded by ManyChatSecretGuard, which checks
 * the x-manychat-secret header against WEBHOOK_SHARED_SECRET. When the env var
 * is unset (local dev) the guard logs one warning and allows the request.
 */

import { Body, Controller, HttpCode, Logger, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { ProductsService } from '@/modules/products/products.service';
import { AgentService, type IncomingMessage } from '../agent.service';
import { DebounceService } from '../debounce/debounce.service';
import { mergeTurns } from '../debounce/merge-turns';
import { toDynamicBlock, type CardProduct } from './manychat.formatter';
import { ManyChatSenderService } from './manychat-sender.service';
import { ManyChatSecretGuard } from './manychat-secret.guard';
import {
  manyChatWebhookSchema,
  type ManyChatWebhookDto,
} from './manychat-webhook.dto';
import type { ManyChatDynamicBlock } from './manychat.types';

/** Graceful Arabic fallback message when the agent fails (WS4: never-5xx). */
const FALLBACK_ARABIC =
  'لحظة من فضلك 🌸 عم نجهّزلك الرد، جرّبي تبعتي رسالتك بعد شوي.';

@ApiTags('ManyChat')
@UseGuards(ManyChatSecretGuard)
@Controller('webhook')
export class ManyChatWebhookController {
  private readonly logger = new Logger(ManyChatWebhookController.name);

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
      'URLs). messageId is used as the idempotency key. ' +
      'NEVER returns 5xx — any internal failure returns a graceful Arabic fallback.',
  })
  async handle(
    @Body(new ZodValidationPipe(manyChatWebhookSchema)) dto: ManyChatWebhookDto,
  ): Promise<ManyChatDynamicBlock> {
    try {
      const reply = await this.agent.handleMessage(this.toIncoming(dto));
      const products = await this.enrichWithImages(reply.products);
      return toDynamicBlock({ reply: reply.reply, products });
    } catch (err) {
      // Log the failure but ALWAYS return a valid v2 block so ManyChat never
      // halts the automation due to a 5xx or malformed response from our side.
      this.logger.error(
        `Sync webhook failed for contact ${dto.contactId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
      return toDynamicBlock({ reply: FALLBACK_ARABIC });
    }
  }

  /**
   * Async variant (AIA-30): ACK 202 immediately, debounce the customer's rapid
   * messages into one turn, then deliver the reply via the ManyChat Send API.
   * Use this when the ManyChat flow sends the reply out-of-band rather than
   * rendering the HTTP response as a Dynamic Block. Recommended for image/slow
   * turns given the 10 s ManyChat timeout.
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
    @Body(new ZodValidationPipe(manyChatWebhookSchema)) dto: ManyChatWebhookDto,
  ): { status: 'accepted' } {
    this.debounce.enqueue(dto.contactId, this.toIncoming(dto), (items) =>
      this.processBatch(dto.contactId, items),
    );
    return { status: 'accepted' };
  }

  /** Map a validated ManyChat body to the agent's IncomingMessage. */
  private toIncoming(dto: ManyChatWebhookDto): IncomingMessage {
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
