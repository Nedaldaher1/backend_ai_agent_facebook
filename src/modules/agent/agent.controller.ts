// TEMPORARY: This endpoint mirrors the ManyChat External Request body exactly.
// It is the dev/integration entry point for the Masa sales agent until the real
// ManyChat webhook + Dynamic Block formatting is built (AIA-32, Phase 4).

import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { AgentService, type IncomingMessage, type AgentReply } from './agent.service';

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for POST /agent/message.
 *
 * Fields mirror the ManyChat External Request payload exactly — no defaults,
 * so integration tests and the eventual ManyChat block must supply all
 * required fields explicitly.
 *
 *  contactId    — ManyChat contact_id (stable subscriber id, stored as `psid`).
 *  text         — Customer message text (required, non-empty).
 *  lastImageUrl — Customer-sent image URL (optional; vision processing deferred).
 *  adRef        — Self-controlled ref slug from ManyChat (optional).
 *  name         — Facebook profile name from ManyChat (optional best-effort).
 */
const incomingMessageSchema = z.object({
  contactId: z.string().min(1),
  text: z.string().min(1),
  lastImageUrl: z.string().url().optional(),
  adRef: z.string().optional(),
  name: z.string().optional(),
  // Inbound channel → order `source` (server-side). Defaults to messenger.
  channel: z.enum(['messenger', 'whatsapp']).optional(),
});

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Agent message controller — TEMPORARY dev surface.
 *
 * POST /agent/message accepts a payload that mirrors what ManyChat's External
 * Request will send.  The response shape (`reply` + optional `products` array)
 * is what Phase 4 (AIA-32) will format into a ManyChat Dynamic Block.
 *
 * Replace/extend with the real ManyChat webhook controller in Phase 4.
 */
@ApiTags('Agent')
@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Post('message')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send a customer message to the Masa sales agent',
    description:
      'Accepts a ManyChat-compatible payload (contactId, text, optional image URL, ' +
      'ad ref, and profile name) and returns the agent reply plus any product cards ' +
      'extracted from search_products tool results. ' +
      'TEMPORARY — the real ManyChat webhook + Dynamic Block formatting is AIA-32 (Phase 4).',
  })
  message(
    @Body(new ZodValidationPipe(incomingMessageSchema)) dto: IncomingMessage,
  ): Promise<AgentReply> {
    return this.agent.handleMessage(dto);
  }
}
