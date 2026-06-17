import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * Global storage module. Exposes StorageService — the sole flydrive consumer —
 * everywhere, so any module can persist/serve files without importing the
 * storage driver. Global mirrors DatabaseModule's pattern.
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
