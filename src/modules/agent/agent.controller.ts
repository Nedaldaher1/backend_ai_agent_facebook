// TEMPORARY: This endpoint mirrors the ManyChat External Request body exactly.
// It is the dev/integration entry point for the Masa sales agent until the real
// ManyChat webhook + Dynamic Block formatting is the primary path.
//
// The inbound schema is shared with ManyChatWebhookController (manychat-webhook.dto.ts)
// so field definitions live in exactly one place. The only adaptation here is
// mapping `messageId` (the DTO field) to `externalMessageId` (the IncomingMessage
// field expected by AgentService).

import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { AgentService, type AgentReply } from './agent.service';
import { ManyChatSecretGuard } from './manychat/manychat-secret.guard';
import {
  manyChatWebhookSchema,
  type ManyChatWebhookDto,
} from './manychat/manychat-webhook.dto';

/**
 * Agent message controller — TEMPORARY dev surface.
 *
 * POST /agent/message accepts the shared ManyChat-compatible payload
 * (manyChatWebhookSchema). The response shape (`reply` + optional `products` array)
 * is what the ManyChat webhook controller formats into a Dynamic Block.
 *
 * Guarded by ManyChatSecretGuard exactly like the real webhook: this is a full,
 * unformatted entry point into the agent pipeline (Claude calls, write tools,
 * per-contact history), so it must not be reachable without the shared secret.
 * In dev (no WEBHOOK_SHARED_SECRET) the guard allows with a warning; in
 * production it fails closed.
 */
@ApiTags('Agent')
@UseGuards(ManyChatSecretGuard)
@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Post('message')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send a customer message to the Masa sales agent',
    description:
      'Accepts a ManyChat-compatible payload (contactId, text, optional image URL, ' +
      'ad ref, profile name, and optional messageId for idempotency) and returns the ' +
      'agent reply plus any product cards extracted from search_products tool results. ' +
      'TEMPORARY dev surface — the real entry point is /webhook/manychat.',
  })
  message(
    @Body(new ZodValidationPipe(manyChatWebhookSchema)) dto: ManyChatWebhookDto,
  ): Promise<AgentReply> {
    return this.agent.handleMessage({
      contactId: dto.contactId,
      text: dto.text,
      lastImageUrl: dto.lastImageUrl,
      adRef: dto.adRef,
      name: dto.name,
      channel: dto.channel,
      // Map shared DTO's `messageId` → IncomingMessage's `externalMessageId`
      externalMessageId: dto.messageId,
    });
  }
}
