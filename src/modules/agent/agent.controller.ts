// TEMPORARY: replaced by the ManyChat webhook later.
// This endpoint exists solely for smoke-testing the Mastra foundation in
// Phase 1 before the real Facebook/ManyChat integration is built.

import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { AgentService } from './agent.service';

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for the POST /agent/ping body.
 * `resource` and `thread` default to predictable test values so that a plain
 * `{ "text": "مرحبا" }` curl call works out of the box during development.
 */
const pingSchema = z.object({
  /** The customer message to send to the agent. */
  text: z.string().min(1, 'text must not be empty'),

  /** Customer PSID (Facebook Page-Scoped ID). Defaults to a test value. */
  resource: z.string().default('psid-test-1'),

  /** Conversation thread ID. Defaults to a test value. */
  thread: z.string().default('thread-A'),
});

type PingInput = z.infer<typeof pingSchema>;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Temporary smoke-test controller for the Mastra sales agent.
 * POST /agent/ping lets developers (or integration tests) send a single turn
 * to the agent and receive its text reply without needing a Facebook setup.
 *
 * Replace with the real ManyChat webhook controller in the next phase.
 */
@ApiTags('Agent')
@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Post('ping')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Smoke-test: send one message to the Masa sales agent',
    description:
      'Sends the given text to the agent under the specified resource ' +
      '(PSID) and thread scope, and returns the agent reply. ' +
      'TEMPORARY — will be replaced by the ManyChat webhook.',
  })
  async ping(
    @Body(new ZodValidationPipe(pingSchema)) dto: PingInput,
  ): Promise<{ reply: string }> {
    const reply = await this.agent.ping(dto.text, dto.resource, dto.thread);
    return { reply };
  }
}
