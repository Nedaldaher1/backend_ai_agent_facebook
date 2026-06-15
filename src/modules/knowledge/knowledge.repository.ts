import { Injectable } from '@nestjs/common';

/**
 * Control-plane table owner (knowledge_entries) — written by the admin side,
 * read by the agent. Reads must honor the is_published gate.
 * TODO: inject DRIZZLE and implement.
 */
@Injectable()
export class KnowledgeRepository {}
