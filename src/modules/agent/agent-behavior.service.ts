import { Injectable, NotFoundException } from '@nestjs/common';
import type { ListOptions } from '@/common/types/query';
import { AgentBehaviorRepository } from './agent-behavior.repository';
import type {
  AgentBehavior,
  NewAgentBehavior,
} from './entities/agent-behavior.entity';

/**
 * Agent-persona logic. The agent reads the active behavior to assemble its
 * system prompt; the admin manages the set. Exported for the agent runtime.
 */
@Injectable()
export class AgentBehaviorService {
  constructor(private readonly repo: AgentBehaviorRepository) {}

  list(opts?: ListOptions): Promise<AgentBehavior[]> {
    return this.repo.list(opts);
  }

  /** The behavior the agent should use right now, or undefined if none is set. */
  getActive(): Promise<AgentBehavior | undefined> {
    return this.repo.findActive();
  }

  async getById(id: string): Promise<AgentBehavior> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException(`Agent behavior ${id} not found`);
    }
    return row;
  }

  create(input: NewAgentBehavior): Promise<AgentBehavior> {
    // New personas start inactive; activation is exclusively via setActive,
    // which preserves the single-active-row invariant.
    return this.repo.insert({ ...input, isActive: false });
  }

  async update(
    id: string,
    patch: Partial<NewAgentBehavior>,
  ): Promise<AgentBehavior> {
    const row = await this.repo.updateById(id, patch);
    if (!row) {
      throw new NotFoundException(`Agent behavior ${id} not found`);
    }
    return row;
  }

  /** Promote one behavior to the single active row (deactivates the rest). */
  async setActive(id: string): Promise<AgentBehavior> {
    const row = await this.repo.setActive(id);
    if (!row) {
      throw new NotFoundException(`Agent behavior ${id} not found`);
    }
    return row;
  }

  async delete(id: string): Promise<AgentBehavior> {
    const row = await this.repo.deleteById(id);
    if (!row) {
      throw new NotFoundException(`Agent behavior ${id} not found`);
    }
    return row;
  }
}
