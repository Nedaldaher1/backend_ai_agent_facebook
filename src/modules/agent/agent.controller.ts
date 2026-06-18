// TEMPORARY: This endpoint mirrors the ManyChat External Request body exactly.
// It is the dev/integration entry point for the Masa sales agent until the real
// ManyChat webhook + Dynamic Block formatting is built (AIA-32, Phase 4).

import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import {
  AgentReplyDto,
  IncomingMessageDto,
  incomingMessageSchema,
} from './dto/agent-message.dto';
import {
  AgentService,
  type AgentReply,
  type IncomingMessage,
} from './agent.service';

/**
 * Agent message controller — TEMPORARY dev surface.
 *
 * POST /agent/message accepts a payload that mirrors what ManyChat's External
 * Request will send.  The response shape (`reply` + optional `products` array)
 * is what Phase 4 (AIA-32) will format into a ManyChat Dynamic Block.
 *
 * The request/response shapes are documented by the DTOs in
 * `./dto/agent-message.dto`, where `incomingMessageSchema` is also the single
 * source of truth the `ZodValidationPipe` validates against.
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
  @ApiBody({ type: IncomingMessageDto })
  @ApiOkResponse({
    description: 'The agent reply plus any product cards to surface.',
    type: AgentReplyDto,
  })
  message(
    @Body(new ZodValidationPipe(incomingMessageSchema)) dto: IncomingMessage,
  ): Promise<AgentReply> {
    return this.agent.handleMessage(dto);
  }
}
