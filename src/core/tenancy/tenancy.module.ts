import { Global, Module } from '@nestjs/common';
import { TenantContext } from './tenant-context';
import { TenantDb } from './tenant-db';

/**
 * Global tenancy primitives: the ambient TenantContext (AsyncLocalStorage) and
 * the TenantDb transaction wrapper every domain repository goes through.
 * Global so repositories in every feature module can inject them without
 * import ceremony — mirroring DatabaseModule.
 */
@Global()
@Module({
  providers: [TenantContext, TenantDb],
  exports: [TenantContext, TenantDb],
})
export class TenancyModule {}
