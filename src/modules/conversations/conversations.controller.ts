import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

/**
 * Conversations are written by the agent at runtime; HTTP routes (e.g. admin
 * read-only views) will be added here as needed.
 */
@ApiTags('Conversations')
@Controller('conversations')
export class ConversationsController {}
