import { Injectable } from '@nestjs/common';

/**
 * Runtime table owner (conversations, messages) — written by the agent.
 * TODO: inject DRIZZLE and implement persistence + conversation state.
 */
@Injectable()
export class ConversationsRepository {}
