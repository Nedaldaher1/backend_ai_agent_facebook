import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * DI token for the Drizzle client. Inject with `@Inject(DRIZZLE)`.
 *
 * The client is created without a bundled schema so that `core/` never has to
 * import feature modules — repositories import their own tables directly and
 * keep full type-safety on `db.select().from(table)`.
 */
export const DRIZZLE = Symbol('DRIZZLE');

export type Database = NodePgDatabase;
