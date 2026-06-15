import { Injectable } from '@nestjs/common';

/**
 * Brand knowledge / FAQ retrieval for the agent. Exposed to the agent module.
 * TODO: inject KnowledgeRepository and implement once the knowledge_entries
 * schema lands.
 */
@Injectable()
export class KnowledgeService {}
