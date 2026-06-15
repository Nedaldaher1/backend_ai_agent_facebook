import { Controller } from '@nestjs/common';

/**
 * Conversations are written by the agent at runtime; HTTP routes (e.g. admin
 * read-only views) will be added here as needed.
 */
@Controller('conversations')
export class ConversationsController {}
